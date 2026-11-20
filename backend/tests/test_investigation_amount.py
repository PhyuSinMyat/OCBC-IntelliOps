"""Amount Mismatch AI investigations use isolated SQLite and mocked provider HTTP."""
import json
import os
import unittest
from unittest.mock import patch
from uuid import uuid4

import httpx
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

os.environ['DATABASE_URL'] = 'sqlite:///:memory:'

from main import app
from modules.core_banking.router import get_db
from modules.intelliops.investigation_llm import InvestigationProvider, get_investigation_provider
from shared.security import actor
import test_payments


class AmountInvestigationTests(unittest.TestCase):
    setUpDatabase = test_payments.PaymentTests.setUpDatabase
    tearDownDatabase = test_payments.PaymentTests.tearDownDatabase

    def setUp(self):
        self.setUpDatabase()
        self.clock = patch.dict(os.environ, {'INTELLIOPS_SIMULATION_TIME': '2026-11-03T03:00:00+00:00',
                                             'INTELLIOPS_INVESTIGATION_PERSISTENCE': 'false'})
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
            'amount': '100.00', 'idempotency_key': f'amount-investigation-input-{index}',
            'run_key': f'amount-investigation-run-{index}', 'scenario_code': 'AMOUNT_MISMATCH',
            'scenario_variant': variant})
        self.assertEqual(response.status_code, 201, response.text)
        with patch.dict(os.environ, {'INTELLIOPS_SIMULATION_TIME': '2026-11-03T03:01:01+00:00'}):
            detected = self.client.post('/api/detection/run')
        self.assertEqual(detected.status_code, 200, detected.text)
        cases = [case for case in self.client.get('/api/exceptions').json()
                 if case['exceptionType'] == 'Amount Mismatch' and case['transactionId'] == response.json()['id']]
        self.assertEqual(len(cases), 1)
        return cases[0]['id']

    def provider(self, cause, action='REVIEW_SHORTFALL_ADJUSTMENT', diagnosis='CONFIRMED_AMOUNT_MISMATCH',
                 financial=None):
        def handler(request):
            body = json.loads(request.content)
            evidence = json.loads(body['input'])
            self.assertEqual(body['text']['format']['name'], 'amount_mismatch_investigation')
            self.assertNotIn('verified_assessment', evidence)
            event_ref = next(ref for ref in evidence['evidence_references'] if ref.startswith('event:'))
            result = dict(diagnosis_classification=diagnosis, root_cause_code=cause,
                root_cause_title='Evidence-backed amount transformation',
                root_cause_explanation='A cited operational event records the transformation applied before posting.',
                root_cause_evidence_refs=[event_ref],
                financial_classification=financial or evidence['financial_verification']['classification'],
                facts=[dict(statement='The aligned journal amount differs from the payment instruction.',
                            evidence_refs=[event_ref])], hypotheses=[],
                uncertainty=['Current evidence must be revalidated before remediation.'],
                recommended_action_code=action,
                recommendation_reason='Review the verified shortfall and cited operational event before any adjustment.')
            return httpx.Response(200, json={'status': 'completed', 'model': 'test-model', 'output': [
                {'type': 'message', 'content': [{'type': 'output_text', 'text': json.dumps(result)}]}]})
        app.dependency_overrides[get_investigation_provider] = lambda: InvestigationProvider(httpx.MockTransport(handler))

    def run_case(self, case_id):
        with patch.dict(os.environ, {'OPENAI_API_KEY': 'isolated-key', 'OPENAI_MODEL': 'test-model'}):
            return self.client.post(f'/api/exceptions/{case_id}/investigations')

    def test_three_amount_scenarios_are_reconciled_and_source_grounded(self):
        variants = [('FEE_INCORRECTLY_NETTED', 'FEE_APPLIED_TO_PRINCIPAL', '99.99', 'FEE_NETTING'),
                    ('PARTIAL_SETTLEMENT', 'PARTIAL_SETTLEMENT_APPLIED', '50.00', 'PARTIAL_SETTLEMENT'),
                    ('DECIMAL_SCALING_ERROR', 'AMOUNT_SCALE_TRANSFORMED', '1.00', 'DECIMAL_SCALING_ERROR')]
        for index, (variant, event, posted, cause) in enumerate(variants):
            with self.subTest(variant=variant):
                if index:
                    self.tearDown(); self.setUp()
                case_id = self.create_case(variant, index)
                evidence = self.client.get(f'/api/exceptions/{case_id}/investigation-evidence')
                self.assertEqual(evidence.status_code, 200, evidence.text)
                data = evidence.json()
                self.assertEqual(data['financial_verification']['classification'], 'UNDERPOSTING_CONFIRMED')
                self.assertEqual(data['financial_verification']['expectedAmount'], '100.00')
                self.assertEqual(data['financial_verification']['postedAmount'], posted)
                self.assertIn(event, [row['eventType'] for row in data['snapshot']['events']])
                self.provider(cause)
                response = self.run_case(case_id)
                self.assertEqual(response.status_code, 200, response.text)
                report = response.json()
                self.assertEqual(report['exception_type'], 'AMOUNT_MISMATCH')
                self.assertEqual(report['diagnosis_classification'], 'CONFIRMED_AMOUNT_MISMATCH')
                self.assertEqual(report['recommended_action_code'], 'REVIEW_SHORTFALL_ADJUSTMENT')
                self.assertEqual(report['financial_impact']['postedAmount'], posted)

    def test_model_cannot_override_amounts_classification_or_action(self):
        case_id = self.create_case('PARTIAL_SETTLEMENT', 9)
        for changes in [dict(financial='OVERPOSTING_CONFIRMED'),
                        dict(action='REVIEW_OVERPOSTING_CORRECTION'),
                        dict(diagnosis='NO_AMOUNT_MISMATCH')]:
            with self.subTest(changes=changes):
                self.provider('PARTIAL_SETTLEMENT', **changes)
                self.assertEqual(self.run_case(case_id).status_code, 502)

    def test_accepted_amount_report_uses_durable_history_and_request_deduplication(self):
        case_id = self.create_case('FEE_INCORRECTLY_NETTED', 12)
        self.provider('FEE_NETTING')
        request_id = str(uuid4())
        headers = {'X-Investigation-Request-ID': request_id}
        with patch.dict(os.environ, {'OPENAI_API_KEY': 'isolated-key', 'OPENAI_MODEL': 'test-model',
                                     'INTELLIOPS_INVESTIGATION_PERSISTENCE': 'true'}):
            first = self.client.post(f'/api/exceptions/{case_id}/investigations', headers=headers)
            replay = self.client.post(f'/api/exceptions/{case_id}/investigations', headers=headers)
            history = self.client.get(f'/api/exceptions/{case_id}/investigations')
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(replay.json()['investigation_id'], first.json()['investigation_id'])
        self.assertEqual(first.json()['persistence'], 'BACKEND_DATABASE')
        self.assertEqual(history.status_code, 200, history.text)
        self.assertEqual(history.json()['investigations'][0]['report']['exception_type'], 'AMOUNT_MISMATCH')


if __name__ == '__main__':
    unittest.main()
