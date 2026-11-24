"""Evidence-rich non-duplicate scenario tests against isolated SQLite only."""
import os
os.environ['DATABASE_URL'] = 'sqlite:///:memory:'

import json
import unittest
from decimal import Decimal
from unittest.mock import patch
from sqlalchemy import select, func
from sqlalchemy.orm import Session
from shared.security import actor
from main import app
from modules.payment_processing.models import ExceptionBatch, PaymentRequestHistory
import test_payments


VARIANTS = [
    ('PROCESSING_FAILURE', 'PROCESSOR_UNAVAILABLE', 'Payment Processing Failure', 'PROCESSOR_CONNECTION_FAILED', 0),
    ('PROCESSING_FAILURE', 'CLEARING_REJECTION', 'Payment Processing Failure', 'CLEARING_REJECTED', 0),
    ('PROCESSING_FAILURE', 'ACCOUNT_RESTRICTED_DURING_PROCESSING', 'Payment Processing Failure', 'ACCOUNT_STATUS_CHANGED', 0),
    ('MISSING_LEDGER', 'POSTING_EVENT_LOST', 'Missing Ledger Posting', 'LEDGER_EVENT_PUBLICATION_FAILED', 0),
    ('MISSING_LEDGER', 'LEDGER_TRANSACTION_ROLLBACK', 'Missing Ledger Posting', 'LEDGER_TRANSACTION_ROLLED_BACK', 0),
    ('MISSING_LEDGER', 'LEDGER_CONSUMER_DEAD_LETTER', 'Missing Ledger Posting', 'LEDGER_MESSAGE_DEAD_LETTERED', 0),
    ('AMOUNT_MISMATCH', 'FEE_INCORRECTLY_NETTED', 'Amount Mismatch', 'FEE_APPLIED_TO_PRINCIPAL', 1),
    ('AMOUNT_MISMATCH', 'PARTIAL_SETTLEMENT', 'Amount Mismatch', 'PARTIAL_SETTLEMENT_APPLIED', 1),
    ('AMOUNT_MISMATCH', 'DECIMAL_SCALING_ERROR', 'Amount Mismatch', 'AMOUNT_SCALE_TRANSFORMED', 1),
    ('UNMATCHED', 'REFERENCE_TYPO', 'Unmatched Transaction', 'REFERENCE_MAPPING_APPLIED', 1),
    ('UNMATCHED', 'BATCH_CORRELATION_SHIFT', 'Unmatched Transaction', 'SETTLEMENT_BATCH_CORRELATED', 1),
    ('UNMATCHED', 'MANUAL_JOURNAL_MISLINK', 'Unmatched Transaction', 'MANUAL_JOURNAL_SUBMITTED', 1),
]


class ExceptionScenarioTests(unittest.TestCase):
    setUp = test_payments.PaymentTests.setUp
    tearDown = test_payments.PaymentTests.tearDown
    setUpDatabase = test_payments.PaymentTests.setUpDatabase
    tearDownDatabase = test_payments.PaymentTests.tearDownDatabase
    request = test_payments.PaymentTests.request
    balance = test_payments.PaymentTests.balance

    def generate(self, code, variant, number=0, **changes):
        payload = self.request(scenario_code=code, scenario_variant=variant,
            run_key=f'exception-run-{number:04d}', idempotency_key=f'exception-input-{number:04d}',
            amount=f'{100 + number}.00')
        payload.update(changes)
        return self.client.post('/api/demo/payments/scenario', json=payload)

    def test_all_variants_create_operational_evidence_and_expected_cases(self):
        results = []
        sender_before, receiver_before = self.balance('ACC-100003'), self.balance()
        expected_debit = Decimal(0)
        for index, (code, variant, exception_type, event_type, postings) in enumerate(VARIANTS):
            with self.subTest(variant=variant):
                response = self.generate(code, variant, index)
                self.assertEqual(response.status_code, 201, response.text)
                result = response.json()
                self.assertEqual(result['attemptCount'], 1)
                self.assertEqual(result['postingCount'], postings)
                self.assertEqual(result['payments'][0]['status'], 'Failed' if code == 'PROCESSING_FAILURE' else 'Completed')
                events = self.client.get(f"/api/payments/{result['id']}/events").json()
                self.assertIn(event_type, [event['eventType'] for event in events])
                self.assertTrue(all(event['requestId'] for event in events))
                replay = self.generate(code, variant, index).json()
                self.assertEqual(replay['runId'], result['runId'])
                self.assertEqual(replay['paymentReferences'], result['paymentReferences'])
                snapshot = json.dumps(self.client.get('/api/banking-snapshot').json())
                self.assertNotIn('scenario_variant', snapshot)
                results.append((result, exception_type))
                if code == 'AMOUNT_MISMATCH':
                    expected_debit += {'FEE_INCORRECTLY_NETTED': Decimal(100 + index) - Decimal('.01'),
                        'PARTIAL_SETTLEMENT': Decimal(100 + index) / 2,
                        'DECIMAL_SCALING_ERROR': (Decimal(100 + index) / 100).quantize(Decimal('.01'))}[variant]
                elif code == 'UNMATCHED':
                    expected_debit += Decimal(100 + index)

        self.assertEqual(self.balance('ACC-100003'), sender_before - expected_debit)
        self.assertEqual(self.balance(), receiver_before + expected_debit)
        with patch.dict(os.environ, {'INTELLIOPS_SIMULATION_TIME': '2026-11-03T03:01:01+00:00'}):
            detected = self.client.post('/api/detection/run')
        self.assertEqual(detected.status_code, 200, detected.text)
        cases = self.client.get('/api/exceptions').json()
        for result, exception_type in results:
            with self.subTest(payment=result['id']):
                self.assertIn(exception_type, {case['exceptionType'] for case in cases if case['transactionId'] == result['id']})

    def test_validation_authorization_conflict_and_atomic_rollback(self):
        self.assertEqual(self.generate('PROCESSING_FAILURE', 'POSTING_EVENT_LOST').status_code, 422)
        self.assertEqual(self.generate('PROCESSING_FAILURE', 'PROCESSOR_UNAVAILABLE').status_code, 201)
        self.assertEqual(self.generate('PROCESSING_FAILURE', 'PROCESSOR_UNAVAILABLE', amount='101.00').status_code, 409)
        app.dependency_overrides[actor] = lambda: 'ADMIN'
        self.assertEqual(self.generate('MISSING_LEDGER', 'POSTING_EVENT_LOST', 1).status_code, 403)
        app.dependency_overrides[actor] = lambda: 'ANALYST'
        before = self.balance()
        with Session(self.engine) as db:
            requests_before = db.scalar(select(func.count()).select_from(PaymentRequestHistory))
        with patch('modules.payment_processing.scenarios.create_payment', side_effect=ValueError('synthetic failure')):
            response = self.generate('AMOUNT_MISMATCH', 'PARTIAL_SETTLEMENT', 2)
        self.assertEqual(response.status_code, 422)
        self.assertEqual(self.balance(), before)
        with Session(self.engine) as db:
            self.assertEqual(db.scalar(select(func.count()).select_from(ExceptionBatch).where(
                ExceptionBatch.run_key == 'exception-run-0002')), 0)
            self.assertEqual(db.scalar(select(func.count()).select_from(PaymentRequestHistory)), requests_before)


if __name__ == '__main__':
    unittest.main()
