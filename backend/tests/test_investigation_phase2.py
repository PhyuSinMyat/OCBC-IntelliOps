"""Routine Phase 2 tests are offline. No paid calls or shared source mutations."""
import os
os.environ['DATABASE_URL'] = 'sqlite:///:memory:'
import json
import tempfile
import unittest
from copy import deepcopy
from pathlib import Path
from unittest.mock import patch
import httpx
import test_investigation_evidence_phase1 as fixtures
from test_investigation_independence import neutral_output
from modules.payment_processing.scenarios import A, B, C
from modules.intelliops.investigation_llm import InvestigationProvider
from modules.intelliops.investigation_projection import model_evidence
from modules.intelliops.investigation_service import investigate
from modules.intelliops.service import CaseError


class Phase2Tests(unittest.TestCase):
    setUp = fixtures.EvidencePhase1Tests.setUp
    tearDown = fixtures.EvidencePhase1Tests.tearDown
    generate = fixtures.EvidencePhase1Tests.generate
    evidence = fixtures.EvidencePhase1Tests.evidence

    def provider(self, status=200, mutate=None, captured=None):
        def handler(request):
            body = json.loads(request.content)
            if captured is not None: captured.update(body)
            output = neutral_output(json.loads(body['input']))
            if mutate: mutate(output)
            return httpx.Response(status, json={'model': 'offline-resolved', 'status': 'completed', 'usage': {
                'input_tokens': 1000, 'output_tokens': 200, 'total_tokens': 1200,
                'input_tokens_details': {'cached_tokens': 100}, 'output_tokens_details': {'reasoning_tokens': 20}},
                'output': [{'type': 'message', 'content': [{'type': 'output_text', 'text': json.dumps(output)}]}]})
        return InvestigationProvider(httpx.MockTransport(handler))

    def run_offline(self, evidence, provider):
        with patch.dict(os.environ, {'OPENAI_API_KEY': 'offline-key', 'OPENAI_MODEL': 'offline-model', 'INTELLIOPS_LLM_DIAGNOSTICS_DIR': ''}):
            return investigate(evidence, provider)

    def test_configured_limits_and_usage_are_exposed_without_secrets(self):
        case, _ = self.generate(A); captured = {}; provider = self.provider(captured=captured)
        with patch.dict(os.environ, {'INTELLIOPS_LLM_MAX_OUTPUT_TOKENS': '3000', 'INTELLIOPS_LLM_TIMEOUT_SECONDS': '30'}):
            report = self.run_offline(self.evidence(case), provider)
        self.assertEqual(captured['max_output_tokens'], 3000)
        self.assertEqual(report['provider_metadata']['usage']['input_tokens'], 1000)
        self.assertEqual(report['provider_metadata']['usage']['cached_tokens'], 100)
        self.assertEqual(report['provider_metadata']['response_model'], 'offline-resolved')
        self.assertGreaterEqual(report['provider_metadata']['latency_seconds'], 0)
        self.assertNotIn('offline-key', json.dumps(report))

    def test_actual_request_schema_limits_citations_but_not_new_causes(self):
        case, _ = self.generate(A); captured = {}
        self.run_offline(self.evidence(case), self.provider(captured=captured))
        payload = json.loads(captured['input'])
        schema = captured['text']['format']['schema']
        expected = list(dict.fromkeys(payload['evidence_references']))
        self.assertEqual(schema['properties']['root_cause_evidence_refs']['items']['enum'], expected)
        self.assertEqual(schema['$defs']['EvidenceClaim']['properties']['evidence_refs']['items']['enum'], expected)
        self.assertNotIn('financial_verification', expected)
        self.assertNotIn('enum', schema['properties']['root_cause_code'])

    def test_actual_wire_has_exact_derived_major_units_and_general_mechanism_guidance(self):
        case, _ = self.generate(B, amount='10.00'); captured = {}
        evidence = self.evidence(case)
        before = deepcopy(evidence)
        self.run_offline(evidence, self.provider(captured=captured))
        data = json.loads(captured['input']); s = data['snapshot']
        for row in [s['original'], s['duplicate'], *s['entries']]:
            self.assertEqual(row['amountCents'], 1000)
            self.assertEqual(row['amountMajor'], '10.00')
        self.assertEqual(data['financial_verification']['validDebitTotals']['SGD'], '20.00')
        self.assertEqual(evidence, before)
        self.assertIn('repeat trigger, request origin, duplicate-control behavior and observed financial effect', captured['instructions'])
        self.assertIn('do not assume every repeat involves control failure', captured['instructions'])
        self.assertIn('never label raw cents as major currency units', captured['instructions'])
        self.assertIn('do not add them to report a transfer amount', captured['instructions'])
        self.assertNotIn('lookup_result=MISS', captured['instructions'])
        self.assertNotIn('CASE-000011', captured['instructions'])

    def test_request_receipt_interval_is_derived_and_wrong_claim_rejected(self):
        case, _ = self.generate(A); evidence = self.evidence(case)
        requests = evidence['snapshot']['requests']
        requests[0]['receivedAt'] = '2026-11-12T00:00:00+00:00'
        requests[1]['receivedAt'] = '2026-11-12T00:00:05+00:00'
        payload = model_evidence(evidence)
        self.assertEqual(payload['snapshot']['requestChronology'][0]['receivedIntervalSeconds'], '5.000000')
        with self.assertRaisesRegex(CaseError, 'chronology'):
            self.run_offline(evidence, self.provider(mutate=lambda o: o.update(root_cause_explanation='Requests were received 4 seconds apart.')))
        self.run_offline(evidence, self.provider(mutate=lambda o: o.update(root_cause_explanation='Requests were received 5 seconds apart.')))

    def test_retry_id_reuses_success_and_failure_without_execution(self):
        from modules.intelliops.investigation_runs import once
        from uuid import uuid4
        for status in (200, 502):
            key = ('offline', str(uuid4())); calls = []
            def execute():
                calls.append(True)
                return status, {'detail': 'offline'}
            self.assertEqual(once(key, execute), once(key, execute))
            self.assertEqual(len(calls), 1)

    def test_held_duplicate_cannot_use_false_positive_closure(self):
        case, _ = self.generate(A); captured = {}
        def wrong_action(output):
            output.update(diagnosis_classification='CONFIRMED_DUPLICATE_REQUEST',
                          recommended_action_code='REVIEW_FALSE_POSITIVE_CLOSURE')
        with self.assertRaisesRegex(CaseError, 'recommendation'):
            self.run_offline(self.evidence(case), self.provider(mutate=wrong_action, captured=captured))
        self.assertIn('A genuine duplicate request successfully held is not a false positive', captured['instructions'])
        self.run_offline(self.evidence(case), self.provider(mutate=lambda o: o.update(
            diagnosis_classification='CONFIRMED_DUPLICATE_REQUEST', recommended_action_code='CLOSE_HELD_DUPLICATE')))

    def test_action_semantics_match_actual_request_schema_and_prompt(self):
        from modules.intelliops.investigation_schemas import ACTION_MEANINGS
        case, _ = self.generate(A); captured = {}
        self.run_offline(self.evidence(case), self.provider(captured=captured))
        field = captured['text']['format']['schema']['properties']['recommended_action_code']
        self.assertEqual(set(field['enum']), set(ACTION_MEANINGS))
        for code, meaning in ACTION_MEANINGS.items():
            self.assertIn(f'{code}: {meaning}', captured['instructions'])
            self.assertIn(f'{code}: {meaning}', field['description'])

    def test_action_matrix_uses_intent_and_diagnosis_not_posting_count_alone(self):
        matrix = [
            (A, 'CONFIRMED_DUPLICATE_REQUEST', 'CLOSE_HELD_DUPLICATE'),
            (B, 'CONFIRMED_DUPLICATE_REQUEST', 'ESCALATE_DUPLICATE_FINANCIAL_EXECUTION'),
            (C, 'LEGITIMATE_SEPARATE_INSTRUCTIONS', 'REVIEW_FALSE_POSITIVE_CLOSURE'),
        ]
        actions = [row[2] for row in matrix] + ['ESCALATE_FOR_PAYMENT_VERIFICATION']
        for index, (scenario, diagnosis, expected) in enumerate(matrix):
            case, _ = self.generate(scenario, key=f'action-audit-{index}')
            evidence = self.evidence(case)
            before = fixtures.EvidencePhase1Tests.fingerprint(self)
            for action in actions:
                with self.subTest(scenario=scenario, action=action):
                    provider = self.provider(mutate=lambda o: o.update(
                        diagnosis_classification=diagnosis, recommended_action_code=action))
                    if action in (expected, 'ESCALATE_FOR_PAYMENT_VERIFICATION'):
                        self.run_offline(evidence, provider)
                    else:
                        with self.assertRaisesRegex(CaseError, 'recommendation'):
                            self.run_offline(evidence, provider)
            self.assertEqual(before, fixtures.EvidencePhase1Tests.fingerprint(self))

    def test_uncertain_diagnoses_can_escalate_but_cannot_propose_closure(self):
        case, _ = self.generate(A); evidence = self.evidence(case)
        for diagnosis in ('SUSPECTED_DUPLICATE', 'INSUFFICIENT_EVIDENCE'):
            self.run_offline(evidence, self.provider(mutate=lambda o: o.update(
                diagnosis_classification=diagnosis, recommended_action_code='ESCALATE_FOR_PAYMENT_VERIFICATION')))
            with self.assertRaisesRegex(CaseError, 'recommendation'):
                self.run_offline(evidence, self.provider(mutate=lambda o: o.update(
                    diagnosis_classification=diagnosis, recommended_action_code='CLOSE_HELD_DUPLICATE')))

    def test_bad_limits_fail_before_http(self):
        case, _ = self.generate(A); evidence = model_evidence(self.evidence(case))
        for values in [{'INTELLIOPS_LLM_MAX_OUTPUT_TOKENS': '1'}, {'INTELLIOPS_LLM_TIMEOUT_SECONDS': 'nan'}, {'INTELLIOPS_LLM_MAX_INPUT_CHARS': 'bad'}]:
            with patch.dict(os.environ, {**values, 'OPENAI_API_KEY': 'offline-key', 'OPENAI_MODEL': 'offline-model'}):
                with self.assertRaises(CaseError) as error: self.provider().analyze(evidence)
                self.assertEqual(error.exception.status, 503)

    def test_input_limit_fails_without_a_call(self):
        case, _ = self.generate(A)
        with patch.dict(os.environ, {'INTELLIOPS_LLM_MAX_INPUT_CHARS': '1000', 'OPENAI_API_KEY': 'offline-key', 'OPENAI_MODEL': 'offline-model'}):
            with self.assertRaises(CaseError) as error: self.provider().analyze(model_evidence(self.evidence(case)))
            self.assertEqual(error.exception.status, 422)

    def test_rate_limit_is_explicit_and_never_retried(self):
        case, _ = self.generate(A); captured = {}
        with self.assertRaises(CaseError) as error: self.run_offline(self.evidence(case), self.provider(status=429, captured=captured))
        self.assertEqual(error.exception.status, 502)
        self.assertIn('input', captured)

    def test_unsupported_monetary_assertion_is_rejected(self):
        case, _ = self.generate(A)
        with self.assertRaises(CaseError) as error:
            self.run_offline(self.evidence(case), self.provider(mutate=lambda output: output.update(root_cause_explanation='SGD 999.99 moved.')))
        self.assertIn('999.99', str(error.exception))

    def test_supported_money_and_local_diagnostics(self):
        case, _ = self.generate(A); provider = self.provider(mutate=lambda output: output.update(root_cause_explanation='SGD 1.11 is the verified posting amount.'))
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {'OPENAI_API_KEY': 'offline-key', 'OPENAI_MODEL': 'offline-model', 'INTELLIOPS_LLM_DIAGNOSTICS_DIR': directory}):
            investigate(self.evidence(case), provider)
            artifact = json.loads(next(Path(directory).glob('*.json')).read_text())
            self.assertEqual(artifact['status'], 'ACCEPTED')
            self.assertNotIn('offline-key', json.dumps(artifact))

    def test_isolated_missing_history_retains_financial_facts_without_forcing_cause(self):
        case, _ = self.generate(B); evidence = deepcopy(self.evidence(case))
        evidence['snapshot']['requests'] = []
        evidence['financial_impact']['requestHistoryComplete'] = False
        report = self.run_offline(evidence, self.provider())
        self.assertEqual(report['root_cause_code'], 'CAUSE_NOT_ESTABLISHED')
        self.assertFalse(report['financial_impact']['requestHistoryComplete'])
        self.assertEqual(report['financial_impact']['confirmedPostedJournalCount'], 2)

    def test_isolated_two_postings_with_redacted_intent_remain_uncertain(self):
        case, _ = self.generate(B); evidence = deepcopy(self.evidence(case))
        s = evidence['snapshot']; s['requests'] = []
        for payment in (s['original'], s['duplicate']):
            payment['originalPaymentId'] = None; payment['businessReference'] = None
        for event in s['events']:
            event['sourceData'] = {}; event['sourceValidation']['status'] = 'ABSENT'; event['relationshipValid'] = False
        report = self.run_offline(evidence, self.provider())
        self.assertEqual(report['diagnosis_classification'], 'SUSPECTED_DUPLICATE')
        self.assertEqual(report['financial_execution_assessment']['classification'], 'DOUBLE_POSTING_CONFIRMED')
        self.assertEqual(report['recommended_action_code'], 'ESCALATE_FOR_PAYMENT_VERIFICATION')

    def test_unseen_operational_failure_survives_actual_mocked_wire(self):
        case, _ = self.generate(A); evidence = deepcopy(self.evidence(case)); captured = {}
        event = evidence['snapshot']['events'][0]
        event['eventType'] = 'UPSTREAM_LEASE_EXPIRED'
        event['sourceData'] = {}; event['sourceValidation']['status'] = 'UNSTRUCTURED'
        report = self.run_offline(evidence, self.provider(captured=captured))
        source = next(e for e in json.loads(captured['input'])['snapshot']['events'] if e['id'] == event['id'])
        self.assertEqual(source['eventType'], 'UPSTREAM_LEASE_EXPIRED')
        self.assertEqual(source['sourceData'], {})
        self.assertEqual(report['root_cause_code'], 'CAUSE_NOT_ESTABLISHED')


if __name__ == '__main__': unittest.main()
