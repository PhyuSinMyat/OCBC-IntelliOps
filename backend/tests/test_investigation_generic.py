"""Operational exception investigations use dynamic evidence and a mocked AI provider."""
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
from modules.intelliops.models import ExceptionCase
from modules.intelliops.resolution_llm import ResolutionProvider, get_resolution_provider
from shared.security import actor
import test_payments


CASES = [
    ('PROCESSING_FAILURE', 'PROCESSOR_UNAVAILABLE', 'Payment Processing Failure',
     'CONFIRMED_PROCESSING_FAILURE', 'REVIEW_PROCESSING_FAILURE_RECOVERY'),
    ('PROCESSING_FAILURE', 'CLEARING_REJECTION', 'Payment Processing Failure',
     'CONFIRMED_PROCESSING_FAILURE', 'REVIEW_PROCESSING_FAILURE_RECOVERY'),
    ('PROCESSING_FAILURE', 'ACCOUNT_RESTRICTED_DURING_PROCESSING', 'Payment Processing Failure',
     'CONFIRMED_PROCESSING_FAILURE', 'REVIEW_PROCESSING_FAILURE_RECOVERY'),
    ('UNMATCHED', 'REFERENCE_TYPO', 'Unmatched Transaction',
     'CONFIRMED_UNMATCHED_TRANSACTION', 'REVIEW_UNMATCHED_TRANSACTION_RECONCILIATION'),
    ('UNMATCHED', 'BATCH_CORRELATION_SHIFT', 'Unmatched Transaction',
     'CONFIRMED_UNMATCHED_TRANSACTION', 'REVIEW_UNMATCHED_TRANSACTION_RECONCILIATION'),
    ('UNMATCHED', 'MANUAL_JOURNAL_MISLINK', 'Unmatched Transaction',
     'CONFIRMED_UNMATCHED_TRANSACTION', 'REVIEW_UNMATCHED_TRANSACTION_RECONCILIATION'),
]


class GenericInvestigationTests(unittest.TestCase):
    setUpDatabase = test_payments.PaymentTests.setUpDatabase
    tearDownDatabase = test_payments.PaymentTests.tearDownDatabase

    def setUp(self):
        self.setUpDatabase()
        self.clock = patch.dict(os.environ, {
            'INTELLIOPS_SIMULATION_TIME': '2026-11-03T03:00:00+00:00',
            'INTELLIOPS_INVESTIGATION_PERSISTENCE': 'true',
            'OPENAI_API_KEY': 'isolated-key', 'OPENAI_MODEL': 'test-model',
        })
        self.clock.start()
        def get_test_db():
            with Session(self.engine) as db:
                yield db
        app.dependency_overrides[get_db] = get_test_db
        app.dependency_overrides[actor] = lambda: 'ADMIN'
        self.client = TestClient(app)
        def resolution_handler(request):
            body = json.loads(request.content)
            context = json.loads(body['input'])
            refs = context['evidenceReferences']
            proposal = dict(recommendedActionCode=context['requiredActionCode'],
                resolutionTitle='Evidence-grounded operational review',
                summary='Prepare the accepted investigation for controlled human review.',
                steps=[dict(id='verify', title='Revalidate current source evidence',
                    description='Compare the accepted finding with current payment, event and ledger records.',
                    evidenceReferences=refs[:2], requiresHumanReview=True)],
                customerCommunication=dict(recommended=False,
                    reason='Review customer impact before deciding whether an update is needed.',
                    suggestedMessageType='Status clarification if required'),
                financialConsiderations=['Check current ledger state and any later operational activity.'],
                risksAndSafeguards=['The proposal performs no operational or financial action.'],
                approvalRecommendation=dict(required=False, suggestedRole='Authorised case reviewer',
                    reason='An authorised human must decide the next step.'),
                uncertainty=['The saved source snapshot may have changed.'])
            return httpx.Response(200, json={'status': 'completed', 'model': 'test-resolution-model',
                'output': [{'type': 'message', 'content': [{'type': 'output_text', 'text': json.dumps(proposal)}]}]})
        app.dependency_overrides[get_resolution_provider] = lambda: ResolutionProvider(httpx.MockTransport(resolution_handler))

    def tearDown(self):
        self.client.close()
        app.dependency_overrides.clear()
        self.clock.stop()
        self.tearDownDatabase()

    def create_case(self, code, variant, index, exception_type):
        response = self.client.post('/api/demo/payments/scenario', json={
            'sender_account_ref': 'ACC-100003', 'receiver_account_ref': 'ACC-100001',
            'amount': '100.00', 'idempotency_key': f'generic-input-{index}',
            'run_key': f'generic-run-{index}', 'scenario_code': code, 'scenario_variant': variant})
        self.assertEqual(response.status_code, 201, response.text)
        with patch.dict(os.environ, {'INTELLIOPS_SIMULATION_TIME': '2026-11-03T03:01:01+00:00'}):
            self.assertEqual(self.client.post('/api/detection/run').status_code, 200)
        rows = [case for case in self.client.get('/api/exceptions').json()
                if case['exceptionType'] == exception_type and case['transactionId'] == response.json()['id']]
        self.assertEqual(len(rows), 1)
        return rows[0]['id']

    def provider(self, diagnosis, action):
        def handler(request):
            body = json.loads(request.content)
            evidence = json.loads(body['input'])
            self.assertEqual(body['text']['format']['name'], 'generic_exception_investigation')
            serialized = json.dumps(evidence)
            self.assertNotIn('scenario_variant', serialized)
            event_ref = next(ref for ref in evidence['evidence_references'] if ref.startswith('event:'))
            result = dict(diagnosis_classification=diagnosis, root_cause_code='EVIDENCE_BACKED_OPERATIONAL_CAUSE',
                root_cause_title='Evidence-backed operational exception',
                root_cause_explanation='A cited source event records the operational condition under review.',
                root_cause_evidence_refs=[event_ref],
                financial_classification=evidence['financial_verification']['classification'],
                facts=[dict(statement='The current source event supports the detected exception.', evidence_refs=[event_ref])],
                hypotheses=[], uncertainty=['Current state must be revalidated before any action.'],
                recommended_action_code=action,
                recommendation_reason='Route the cited finding for guarded human review.')
            return httpx.Response(200, json={'status': 'completed', 'model': 'test-model',
                'output': [{'type': 'message', 'content': [{'type': 'output_text', 'text': json.dumps(result)}]}]})
        app.dependency_overrides[get_investigation_provider] = lambda: InvestigationProvider(httpx.MockTransport(handler))

    def assert_complete_workflow(self, case_id, diagnosis, action):
        self.provider(diagnosis, action)
        response = self.client.post(f'/api/exceptions/{case_id}/investigations',
            headers={'X-Investigation-Request-ID': str(uuid4())})
        self.assertEqual(response.status_code, 200, response.text)
        report = response.json()
        self.assertEqual(report['diagnosis_classification'], diagnosis)
        self.assertEqual(report['recommended_action_code'], action)
        created = self.client.post(f'/api/exceptions/{case_id}/resolution-plans', json={
            'investigation_id': report['investigation_id'], 'expected_version': 0})
        self.assertEqual(created.status_code, 200, created.text)
        context = self.client.get(f'/api/exceptions/{case_id}/communications', params={
            'investigation_id': report['investigation_id']}).json()
        recipient = context['recipient']
        communication = self.client.post(f'/api/exceptions/{case_id}/communications', json={
            'investigation_id': report['investigation_id'], 'customer_id': recipient['customerId'],
            'related_transaction_id': recipient['transactionId'], 'direction': 'OUTGOING',
            'communication_type': 'RESOLUTION_STATUS_UPDATE', 'subject': 'Payment review update',
            'body': 'Our operations team is reviewing the payment. No further action is required from you now.'})
        self.assertEqual(communication.status_code, 200, communication.text)
        reassessed = self.client.post(f'/api/exceptions/{case_id}/resolution-plans', json={
            'investigation_id': report['investigation_id'], 'expected_version': 1})
        self.assertEqual(reassessed.status_code, 200, reassessed.text)
        plan = reassessed.json()['plans'][-1]
        policy = self.client.post(f'/api/exceptions/{case_id}/policy-assessments', json={'plan_id': plan['planId']})
        self.assertEqual(policy.status_code, 200, policy.text)
        self.assertNotEqual(policy.json()['status'], 'BLOCKED', policy.text)
        return report

    def test_processing_and_unmatched_variants_are_dynamically_investigated(self):
        for index, (code, variant, exception_type, diagnosis, action) in enumerate(CASES):
            with self.subTest(variant=variant):
                if index:
                    self.tearDown(); self.setUp()
                case_id = self.create_case(code, variant, index, exception_type)
                evidence = self.client.get(f'/api/exceptions/{case_id}/investigation-evidence')
                self.assertEqual(evidence.status_code, 200, evidence.text)
                self.provider(diagnosis, action)
                response = self.client.post(f'/api/exceptions/{case_id}/investigations',
                    headers={'X-Investigation-Request-ID': str(uuid4())})
                self.assertEqual(response.status_code, 200, response.text)
                report = response.json()
                self.assertEqual(report['diagnosis_classification'], diagnosis)
                self.assertEqual(report['recommended_action_code'], action)
                self.assertEqual(report['provider'], 'openai')
                self.assertEqual(report['persistence'], 'BACKEND_DATABASE')
                plan_response = self.client.post(f'/api/exceptions/{case_id}/resolution-plans', json={
                    'investigation_id': report['investigation_id'], 'expected_version': 0})
                self.assertEqual(plan_response.status_code, 200, plan_response.text)
                plan = plan_response.json()['plans'][0]
                self.assertEqual(plan['generationSource'], 'OPENAI_STRUCTURED')
                context = self.client.get(f'/api/exceptions/{case_id}/communications', params={
                    'investigation_id': report['investigation_id']}).json()
                recipient = context['recipient']
                self.assertIsNotNone(recipient)
                communication = self.client.post(f'/api/exceptions/{case_id}/communications', json={
                    'investigation_id': report['investigation_id'], 'customer_id': recipient['customerId'],
                    'related_transaction_id': recipient['transactionId'], 'direction': 'OUTGOING',
                    'communication_type': 'RESOLUTION_STATUS_UPDATE', 'subject': 'Payment review update',
                    'body': 'Our operations team is reviewing the payment. No further action is required from you now.'})
                self.assertEqual(communication.status_code, 200, communication.text)
                reassessed = self.client.post(f'/api/exceptions/{case_id}/resolution-plans', json={
                    'investigation_id': report['investigation_id'], 'expected_version': 1})
                self.assertEqual(reassessed.status_code, 200, reassessed.text)
                current_plan = reassessed.json()['plans'][-1]
                policy = self.client.post(f'/api/exceptions/{case_id}/policy-assessments', json={'plan_id': current_plan['planId']})
                self.assertEqual(policy.status_code, 200, policy.text)
                self.assertIn(policy.json()['status'], {'ELIGIBLE', 'APPROVAL_REQUIRED', 'REVIEW_REQUIRED'})

    def test_remaining_detected_exception_types_have_complete_guarded_workflows(self):
        matrix = [
            ('Invalid Ledger Posting', 'CONFIRMED_INVALID_LEDGER_POSTING', 'REVIEW_INVALID_LEDGER_REMEDIATION'),
            ('Ledger Account Mismatch', 'CONFIRMED_LEDGER_ACCOUNT_MISMATCH', 'REVIEW_ACCOUNT_MISMATCH_REMEDIATION'),
            ('Ledger Currency Mismatch', 'CONFIRMED_LEDGER_CURRENCY_MISMATCH', 'REVIEW_CURRENCY_MISMATCH_REMEDIATION'),
            ('Processing Timeout', 'CONFIRMED_PROCESSING_TIMEOUT', 'REVIEW_PROCESSING_TIMEOUT_RECOVERY'),
        ]
        for index, (exception_type, diagnosis, action) in enumerate(matrix):
            with self.subTest(exception_type=exception_type):
                if index:
                    self.tearDown(); self.setUp()
                case_id = self.create_case('PROCESSING_FAILURE', 'PROCESSOR_UNAVAILABLE', 100 + index,
                                           'Payment Processing Failure')
                numeric_id = int(case_id.split('-')[-1])
                with Session(self.engine) as db, db.begin():
                    db.get(ExceptionCase, numeric_id).exception_type = exception_type
                evidence = self.client.get(f'/api/exceptions/{case_id}/investigation-evidence')
                self.assertEqual(evidence.status_code, 200, evidence.text)
                self.assert_complete_workflow(case_id, diagnosis, action)


if __name__ == '__main__':
    unittest.main()
