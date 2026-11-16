"""Missing Ledger Posting AI investigations use isolated SQLite and mocked provider HTTP."""
import json
import os
import unittest
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

os.environ['DATABASE_URL'] = 'sqlite:///:memory:'

from main import app
from modules.core_banking.router import get_db
from modules.intelliops.investigation_llm import InvestigationProvider, get_investigation_provider
from shared.security import actor
import test_payments


class MissingLedgerInvestigationTests(unittest.TestCase):
    setUpDatabase = test_payments.PaymentTests.setUpDatabase
    tearDownDatabase = test_payments.PaymentTests.tearDownDatabase

    def setUp(self):
        self.setUpDatabase()
        self.clock = patch.dict(os.environ, {'INTELLIOPS_SIMULATION_TIME': '2026-11-03T03:00:00+00:00'})
        self.clock.start()
        def get_test_db():
            with Session(self.engine) as db:
                yield db
        app.dependency_overrides[get_db] = get_test_db
        app.dependency_overrides[actor] = lambda: 'ADMIN'
        self.client = TestClient(app)

    def tearDown(self):
        self.client.close()
        app.dependency_overrides.clear()
        self.clock.stop()
        self.tearDownDatabase()

    def create_case(self, variant, index):
        response = self.client.post('/api/demo/payments/scenario', json={
            'sender_account_ref': 'ACC-100003', 'receiver_account_ref': 'ACC-100001',
            'amount': '100.00', 'idempotency_key': f'missing-investigation-input-{index}',
            'run_key': f'missing-investigation-run-{index}', 'scenario_code': 'MISSING_LEDGER',
            'scenario_variant': variant})
        self.assertEqual(response.status_code, 201, response.text)
        with patch.dict(os.environ, {'INTELLIOPS_SIMULATION_TIME': '2026-11-03T03:01:01+00:00'}):
            detected = self.client.post('/api/detection/run')
        self.assertEqual(detected.status_code, 200, detected.text)
        cases = [case for case in self.client.get('/api/exceptions').json()
                 if case['exceptionType'] == 'Missing Ledger Posting' and case['transactionId'] == response.json()['id']]
        self.assertEqual(len(cases), 1)
        return cases[0]['id']

    def provider(self, cause, event_type, action='REVIEW_MISSING_POSTING_REMEDIATION',
                 diagnosis='CONFIRMED_MISSING_POSTING', financial=None):
        def handler(request):
            body = json.loads(request.content)
            evidence = json.loads(body['input'])
            self.assertEqual(body['text']['format']['name'], 'missing_ledger_investigation')
            self.assertNotIn('verified_assessment', evidence)
            event = next(row for row in evidence['snapshot']['events'] if row['eventType'] == event_type)
            event_ref = f"event:{event['id']}"
            result = dict(diagnosis_classification=diagnosis, root_cause_code=cause,
                root_cause_title='Evidence-backed ledger delivery failure',
                root_cause_explanation='A cited operational event records the ledger delivery mechanism.',
                root_cause_evidence_refs=[event_ref],
                financial_classification=financial or evidence['financial_verification']['classification'],
                facts=[dict(statement='The completed payment has no posting record in the bounded snapshot.',
                            evidence_refs=[event_ref])], hypotheses=[],
                uncertainty=['Current and legacy ledgers must be rechecked before remediation.'],
                recommended_action_code=action,
                recommendation_reason='Review current ledger state and the cited operational event before any posting.')
            return httpx.Response(200, json={'status': 'completed', 'model': 'test-model', 'output': [
                {'type': 'message', 'content': [{'type': 'output_text', 'text': json.dumps(result)}]}]})
        app.dependency_overrides[get_investigation_provider] = lambda: InvestigationProvider(httpx.MockTransport(handler))

    def run_case(self, case_id):
        with patch.dict(os.environ, {'OPENAI_API_KEY': 'isolated-key', 'OPENAI_MODEL': 'test-model'}):
            return self.client.post(f'/api/exceptions/{case_id}/investigations')

    def test_three_missing_ledger_scenarios_are_source_grounded(self):
        variants = [('POSTING_EVENT_LOST', 'LEDGER_EVENT_PUBLICATION_FAILED', 'EVENT_PUBLICATION_FAILURE'),
                    ('LEDGER_TRANSACTION_ROLLBACK', 'LEDGER_TRANSACTION_ROLLED_BACK', 'LEDGER_TRANSACTION_ROLLBACK'),
                    ('LEDGER_CONSUMER_DEAD_LETTER', 'LEDGER_MESSAGE_DEAD_LETTERED', 'LEDGER_CONSUMER_DEAD_LETTER')]
        for index, (variant, event_type, cause) in enumerate(variants):
            with self.subTest(variant=variant):
                if index:
                    self.tearDown(); self.setUp()
                case_id = self.create_case(variant, index)
                evidence = self.client.get(f'/api/exceptions/{case_id}/investigation-evidence')
                self.assertEqual(evidence.status_code, 200, evidence.text)
                data = evidence.json()
                self.assertEqual(data['financial_verification']['classification'], 'NO_POSTING_RECORD_CONFIRMED')
                self.assertTrue(data['financial_verification']['postingRecordAbsent'])
                self.assertEqual(data['financial_verification']['linkedJournalCount'], 0)
                self.assertIn(event_type, [row['eventType'] for row in data['snapshot']['events']])
                self.provider(cause, event_type)
                response = self.run_case(case_id)
                self.assertEqual(response.status_code, 200, response.text)
                report = response.json()
                self.assertEqual(report['exception_type'], 'MISSING_LEDGER_POSTING')
                self.assertEqual(report['diagnosis_classification'], 'CONFIRMED_MISSING_POSTING')
                self.assertEqual(report['recommended_action_code'], 'REVIEW_MISSING_POSTING_REMEDIATION')

    def test_model_cannot_override_ledger_classification_or_action(self):
        case_id = self.create_case('LEDGER_TRANSACTION_ROLLBACK', 9)
        for changes in [dict(financial='POSTING_RECORD_PRESENT'),
                        dict(action='REVIEW_FALSE_POSITIVE_CLOSURE'),
                        dict(diagnosis='POSTING_RECORD_PRESENT')]:
            with self.subTest(changes=changes):
                self.provider('LEDGER_TRANSACTION_ROLLBACK', 'LEDGER_TRANSACTION_ROLLED_BACK', **changes)
                self.assertEqual(self.run_case(case_id).status_code, 502)

    def test_late_valid_posting_changes_the_review_path(self):
        case_id = self.create_case('POSTING_EVENT_LOST', 12)
        remediation = self.client.post(f'/api/exceptions/{case_id}/remediate', json={
            'idempotency_key': 'late-posting-investigation-0001', 'note': 'Controlled test posting.'})
        self.assertEqual(remediation.status_code, 200, remediation.text)
        evidence = self.client.get(f'/api/exceptions/{case_id}/investigation-evidence')
        self.assertEqual(evidence.json()['financial_verification']['classification'], 'POSTING_RECORD_PRESENT')
        self.provider('REMEDIATION_POSTING_PRESENT', 'LEDGER_REMEDIATED',
                      action='REVIEW_FALSE_POSITIVE_CLOSURE', diagnosis='POSTING_RECORD_PRESENT')
        response = self.run_case(case_id)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()['recommended_action_code'], 'REVIEW_FALSE_POSITIVE_CLOSURE')


if __name__ == '__main__':
    unittest.main()
