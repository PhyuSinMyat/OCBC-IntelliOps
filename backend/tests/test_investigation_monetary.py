"""Offline monetary-format regressions and unchanged real-candidate replay."""
import json
import hashlib
import unittest
from copy import deepcopy
from pathlib import Path
from modules.intelliops.investigation_schemas import ModelInvestigation
from modules.intelliops.investigation_validation import validate_monetary_claims
from modules.intelliops.service import CaseError


class MonetaryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.saved = json.loads((Path(__file__).parent / 'fixtures/investigation_live_monetary_replay.json').read_text())

    def check(self, statement, data=None, field='root_cause_explanation'):
        saved = self.saved['CASE-000011']
        result = ModelInvestigation.model_validate(saved['analysis']).model_copy(deep=True)
        # Format tests are independent of the replay: replace its erroneous claims.
        for claim in result.facts: claim.statement = 'Source records are available.'
        if field in ('facts', 'hypotheses'):
            result.facts[0].statement = statement
            if field == 'hypotheses':
                result.hypotheses = [result.facts.pop(0)]
        elif field == 'uncertainty': result.uncertainty = [statement]
        else: setattr(result, field, statement)
        validate_monetary_claims(result, data or saved['model_input'])

    def test_correct_prefix_suffix_symbols_and_totals(self):
        for amount in ('SGD 10', '10 SGD', 'S$10', '$10', 'SGD 10.00', '10.00 SGD',
                       'sgd 10.00', '10.00 sgd', 'SGD 20.00', '20 SGD', 'SGD 0.00'):
            with self.subTest(amount=amount): self.check(f'The verified amount is ({amount}).')

    def test_unsupported_minor_units_and_double_counted_total_are_rejected(self):
        for amount in ('SGD 1000', '1000 SGD', 'S$1000', '1000.00 SGD',
                       'SGD 1,000', '1,000 SGD', 'S$1,000.00', 'SGD 40', '40.00 SGD', 'USD 10'):
            with self.subTest(amount=amount), self.assertRaises(CaseError) as error:
                self.check(f'The amount moved is {amount}.')
            self.assertEqual(error.exception.status, 502)

    def test_grouped_thousands_are_valid_when_actually_supported(self):
        data = deepcopy(self.saved['CASE-000011']['model_input'])
        data['snapshot']['original']['amountCents'] = 100000
        for amount in ('SGD 1,000', '1,000 SGD', 'S$1,000.00', '1,000.00 SGD'):
            with self.subTest(amount=amount): self.check(f'Payment amount: {amount}.', data)

    def test_every_model_prose_field_is_checked_and_not_rewritten(self):
        for field in ('facts', 'hypotheses', 'root_cause_title', 'root_cause_explanation', 'recommendation_reason', 'uncertainty'):
            with self.subTest(field=field), self.assertRaises(CaseError):
                self.check('A payment of 1000 SGD was recorded.', field=field)
        saved = deepcopy(self.saved['CASE-000011'])
        result = ModelInvestigation.model_validate(saved['analysis'])
        before = result.model_dump()
        with self.assertRaises(CaseError): validate_monetary_claims(result, saved['model_input'])
        self.assertEqual(result.model_dump(), before)

    def test_correct_total_does_not_excuse_an_incorrect_individual_amount(self):
        with self.assertRaises(CaseError):
            self.check('Total SGD 20.00; each posting was 1000 SGD.')

    def test_identifiers_timestamps_and_unrelated_numbers_are_not_currency_claims(self):
        self.check('TXN-1000 event:116 JRN-SGD1000 2026-11-11T15:40:45.269373+00:00; '
                   'amountCents=1000; 2 payments, 5 seconds; id TXN-1000 SGD is the currency.')

    def test_replay_actual_b_is_now_rejected_without_modifying_candidate(self):
        saved = self.saved['CASE-000011']
        self.assertEqual(hashlib.sha256(json.dumps(saved['analysis'], sort_keys=True).encode()).hexdigest(), saved['analysisSha256'])
        self.assertIn('1000 SGD', saved['analysis']['facts'][3]['statement'])
        result = ModelInvestigation.model_validate(saved['analysis'])
        with self.assertRaisesRegex(CaseError, 'SGD 1000') as error:
            validate_monetary_claims(result, saved['model_input'])
        self.assertEqual(error.exception.status, 502)

    def test_replay_actual_a_still_passes(self):
        saved = self.saved['CASE-000010']
        validate_monetary_claims(ModelInvestigation.model_validate(saved['analysis']), saved['model_input'])


if __name__ == '__main__': unittest.main()
