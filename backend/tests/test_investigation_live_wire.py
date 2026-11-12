"""Opt-in GET-only live evidence + local FastAPI POST with a mocked OpenAI transport.

Never posts to the running application, generates scenarios, or opens a source DB.
Enable INTELLIOPS_VERIFY_EXISTING_CASES=1 and supply the existing demo token.
"""
import json
import os
import unittest
import urllib.request
from copy import deepcopy
from decimal import Decimal
from hashlib import sha256
from pathlib import Path
from unittest.mock import patch
import httpx
from fastapi.testclient import TestClient
from main import app
from shared.security import actor
from modules.core_banking.router import get_db
from modules.intelliops.investigation_llm import InvestigationProvider, get_investigation_provider

CASES = {'CASE-000010': (1, 2), 'CASE-000011': (2, 4), 'CASE-000009': (2, 4)}
FORBIDDEN = {'verified_assessment', 'root_cause_code', 'diagnosis_classification', 'recommended_action_code',
    'required_cause_references', 'private_metadata', 'expected_root_cause', 'scenario_code', 'scenario',
    'expectedMovementForOneTransfer', 'excessPostingAmount', 'audit_metadata', 'audit_events', 'hidden_answers'}
LABELS = ['CUSTOMER_DOUBLE_CLICK', 'AUTOMATIC_RETRY_FAILURE', 'LEGITIMATE_REPEATED_PAYMENTS',
    'CUSTOMER_DOUBLE_SUBMISSION', 'IDEMPOTENCY_CONTROL_FAILURE', 'LEGITIMATE_REPEATED_PAYMENT', 'WIRE_LEAK_SENTINEL']


def all_keys(value):
    if isinstance(value, dict):
        return set(value).union(*(all_keys(v) for v in value.values()))
    if isinstance(value, list):
        return set().union(*(all_keys(v) for v in value))
    return set()


@unittest.skipUnless(os.getenv('INTELLIOPS_VERIFY_EXISTING_CASES') == '1', 'Opt-in existing development case verification')
class ExistingCaseWireTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.evidence = {}
        token = os.environ['INTELLIOPS_ADMIN_TOKEN']
        base = os.getenv('INTELLIOPS_EVIDENCE_API_URL', 'http://127.0.0.1:8000').rstrip('/')
        for case_id in CASES:
            request = urllib.request.Request(base + '/api/exceptions/' + case_id + '/investigation-evidence',
                headers={'Authorization': 'Bearer ' + token}, method='GET')
            with urllib.request.urlopen(request, timeout=90) as response:
                cls.evidence[case_id] = json.load(response)
        cls.capture_dir = Path(__file__).resolve().parents[2] / 'logs' / 'phase1-final-llm-input'
        cls.capture_dir.mkdir(parents=True, exist_ok=True)

    def capture(self, case_id, evidence, tag):
        captured = []
        def handler(request):
            self.assertEqual(str(request.url), 'https://api.openai.com/v1/responses')
            body = json.loads(request.content)
            captured.append(body)  # Headers/credentials are never captured or saved.
            data = json.loads(body['input']); refs = data['evidence_references']
            citations = [next(r for r in refs if r.startswith(prefix)) for prefix in ('event:', 'payment:', 'request:', 'journal:')]
            result = dict(diagnosis_classification='SUSPECTED_DUPLICATE', root_cause_code='CAUSE_NOT_ESTABLISHED',
                root_cause_title='Cause remains under review', root_cause_explanation='This mock does not establish a causal finding.',
                root_cause_evidence_refs=[], financial_classification=data['financial_verification']['classification'],
                facts=[dict(statement='The cited operational and accounting records are available.', evidence_refs=citations)],
                hypotheses=[], uncertainty=['An analyst must assess the source evidence.'],
                recommended_action_code='ESCALATE_FOR_PAYMENT_VERIFICATION', recommendation_reason='Review the cited records.')
            if case_id == 'CASE-000009':
                # A scripted response tests that two postings need not be an erroneous duplicate.
                # This output is never included in the input sent to the mock transport.
                result.update(diagnosis_classification='LEGITIMATE_SEPARATE_INSTRUCTIONS',
                    root_cause_code='INDEPENDENT_AUTHORIZATIONS', root_cause_title='Separate authorizations recorded',
                    root_cause_explanation='Two request records have separately bound authorizations.',
                    root_cause_evidence_refs=[next(r for r in refs if r.startswith('request:'))],
                    recommended_action_code='REVIEW_FALSE_POSITIVE_CLOSURE')
            return httpx.Response(200, json={'status': 'completed', 'output': [{'type': 'message', 'content': [{'type': 'output_text', 'text': json.dumps(result)}]}]})
        provider = InvestigationProvider(httpx.MockTransport(handler))
        def no_source_database():
            yield None
        app.dependency_overrides[get_db] = no_source_database
        app.dependency_overrides[actor] = lambda: 'ADMIN'
        app.dependency_overrides[get_investigation_provider] = lambda: provider
        try:
            with patch('modules.intelliops.investigation_router.collect', return_value=deepcopy(evidence)), \
                 patch.dict(os.environ, {'OPENAI_API_KEY': 'offline-mock-only', 'OPENAI_MODEL': 'offline-wire-test'}), TestClient(app) as client:
                # This POST is in-process TestClient, not a request to the live server.
                response = client.post(f'/api/exceptions/{case_id}/investigations')
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(len(captured), 1)
            self.capture_dir.joinpath(f'{case_id}-{tag}-request.json').write_text(json.dumps(captured[0], indent=2) + '\n', encoding='utf-8')
            return captured[0], response.json()
        finally:
            app.dependency_overrides.clear()

    def verify_case(self, case_id):
        evidence = self.evidence[case_id]; s = evidence['snapshot']
        body, report = self.capture(case_id, evidence, 'clean')
        data = json.loads(body['input']); encoded = body['input']
        self.assertEqual(set(data), {'snapshot', 'financial_verification', 'evidence_references', 'retrieved_at'})
        self.assertFalse(all_keys(data) & FORBIDDEN)
        for label in LABELS:
            self.assertNotIn(label, encoded)
        self.assertNotIn('return its exact diagnosis', body['instructions'])
        self.assertNotIn('enum', body['text']['format']['schema']['properties']['root_cause_code'])
        self.assertTrue(body['text']['format']['strict']); self.assertFalse(body['store'])
        self.assertNotIn('tools', body)
        sent = data['snapshot']; finance = data['financial_verification']
        journal_count, entry_count = CASES[case_id]
        self.assertEqual(len(sent['journals']), journal_count); self.assertEqual(len(sent['entries']), entry_count)
        self.assertEqual(finance['confirmedPostedJournalCount'], journal_count)
        self.assertEqual(finance['completedPaymentCount'], 1 if case_id == 'CASE-000010' else 2)
        self.assertEqual(finance['classification'], 'SINGLE_POSTING_CONFIRMED' if journal_count == 1 else 'DOUBLE_POSTING_CONFIRMED')
        payment_refs = {sent['original']['id'], sent['duplicate']['id']}
        request_refs = {r['id'] for r in sent['requests']}; journal_refs = {j['id'] for j in sent['journals']}
        self.assertEqual(len(sent['requests']), 2)
        for event in sent['events']:
            self.assertIn(event['paymentId'], payment_refs)
            if event['requestId']:
                self.assertIn(event['requestId'], request_refs)
            if event['sourceValidation']['status'] == 'UNSTRUCTURED':
                self.assertEqual(event['sourceData'], {})
        for request in sent['requests']:
            self.assertIn(request['paymentReference'], payment_refs)
            self.assertTrue(request['integrityValid'])
            self.assertIsNone(request['outcome']); self.assertEqual(request['outcomeAvailability'], 'NOT_RECORDED')
        if case_id == 'CASE-000011':
            self.assertEqual([r['origin'] for r in sent['requests']], ['CUSTOMER', 'SYSTEM'])
            self.assertTrue(sent['requests'][1]['retryValid'])
        if case_id == 'CASE-000009':
            self.assertTrue(all(r['authorizationValid'] for r in sent['requests']))
            self.assertEqual(report['diagnosis_classification'], 'LEGITIMATE_SEPARATE_INSTRUCTIONS')
            self.assertEqual(report['financial_execution_assessment']['classification'], 'DOUBLE_POSTING_CONFIRMED')
            self.assertEqual(report['recommended_action_code'], 'REVIEW_FALSE_POSITIVE_CLOSURE')
            self.assertNotIn('duplicate execution', report['financial_execution_assessment']['explanation'].lower())
        totals = {'Debit': {}, 'Credit': {}}
        for entry in sent['entries']:
            self.assertIn(entry['journalId'], journal_refs)
            target = totals[entry['side']]
            target[entry['currency']] = target.get(entry['currency'], Decimal(0)) + Decimal(entry['amountCents']) / 100
        for side, field in [('Debit', 'validDebitTotals'), ('Credit', 'validCreditTotals')]:
            self.assertEqual(finance[field], {currency: format(amount, '.2f') for currency, amount in totals[side].items()})
        refs = data['evidence_references']
        self.assertEqual(set(refs), set(evidence['evidence_references']))
        for collection, prefix in [('events', 'event:'), ('requests', 'request:'), ('journals', 'journal:')]:
            self.assertTrue(all(prefix + r['id'] in refs for r in sent[collection]))
        self.assertTrue(all('payment:' + ref in refs for ref in payment_refs))
        # Inject nested source/audit metadata and legacy answers; inspect a second real wire request.
        poisoned = deepcopy(evidence)
        poisoned['verified_assessment'].update(root_cause_code='WIRE_LEAK_SENTINEL', diagnosis_classification='WIRE_LEAK_SENTINEL',
            recommended_action_code='WIRE_LEAK_SENTINEL', required_cause_references=['WIRE_LEAK_SENTINEL'])
        poisoned['snapshot']['caseRecord']['evidence'] = {'private_metadata': {'expected_root_cause': 'WIRE_LEAK_SENTINEL'}}
        poisoned['snapshot']['audit_events'] = [{'expected_diagnosis': 'WIRE_LEAK_SENTINEL'}]
        poisoned['audit_metadata'] = {'scenario': 'WIRE_LEAK_SENTINEL'}
        poisoned['snapshot']['events'][0]['description'] = 'WIRE_LEAK_SENTINEL'
        poisoned['snapshot']['events'][0]['sourceData']['hidden_answers'] = 'WIRE_LEAK_SENTINEL'
        poisoned['snapshot']['events'][0]['sourceValidation']['private_metadata'] = 'WIRE_LEAK_SENTINEL'
        poisoned['snapshot']['requests'][0]['audit_metadata'] = 'WIRE_LEAK_SENTINEL'
        poisoned['financial_impact']['journalValidation'][0]['expected_root_cause'] = 'WIRE_LEAK_SENTINEL'
        poisoned_body, _ = self.capture(case_id, poisoned, 'nested-poison')
        self.assertEqual(poisoned_body['input'], body['input'])
        summary = dict(caseId=case_id, passed=True, mockedWireRequests=2, inputKeys=list(data),
            excludedFields=sorted(FORBIDDEN), nestedPoisonInputIdentical=True, journals=journal_count, entries=entry_count,
            financialVerification=finance, citationCounts={prefix: sum(r.startswith(prefix + ':') for r in refs) for prefix in ['event', 'payment', 'request', 'journal']},
            requestOrigins=[r['origin'] for r in sent['requests']], requestOutcomes='NOT_RECORDED',
            inputSha256=sha256(encoded.encode()).hexdigest(), mockReportClassification=report['diagnosis_classification'])
        self.capture_dir.joinpath(f'{case_id}-summary.json').write_text(json.dumps(summary, indent=2) + '\n', encoding='utf-8')

    def test_case_000010_actual_wire(self):
        self.verify_case('CASE-000010')

    def test_case_000011_actual_wire(self):
        self.verify_case('CASE-000011')

    def test_case_000009_actual_wire(self):
        self.verify_case('CASE-000009')


if __name__ == '__main__':
    unittest.main()
