"""Financial acceptance and additive rollout tests. Never uses the configured Supabase."""
import os
os.environ['DATABASE_URL'] = 'sqlite:///:memory:'
import json
import unittest
from datetime import datetime, timezone, timedelta
from decimal import Decimal
from unittest.mock import patch
from uuid import UUID, uuid4
from pathlib import Path
from sqlalchemy import select, func, MetaData, Table, inspect
from sqlalchemy.orm import Session
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from main import app
from shared.security import actor
from modules.core_banking.router import get_db
from modules.core_banking.models import LedgerJournal, LedgerEntry
from modules.payment_processing.models import Transaction, PaymentRequestHistory, ExceptionBatch, ExceptionBatchItem
from modules.intelliops.models import ExceptionCase
import test_accounts
import test_payments


class DuplicateScenarioTests(unittest.TestCase):
    setUp = test_payments.PaymentTests.setUp
    tearDown = test_payments.PaymentTests.tearDown
    setUpDatabase = test_payments.PaymentTests.setUpDatabase
    tearDownDatabase = test_payments.PaymentTests.tearDownDatabase
    request = test_payments.PaymentTests.request
    balance = test_payments.PaymentTests.balance

    def generate(self, variant='CUSTOMER_DOUBLE_CLICK', **changes):
        payload = self.request(scenario_code='DUPLICATE', duplicate_scenario=variant, run_key='scenario-run-0001', amount='123.45')
        payload.update(changes)
        return self.client.post('/api/demo/payments/scenario', json=payload)

    def test_all_scenarios_counts_balances_evidence_replay_and_detection(self):
        for index, variant in enumerate(['CUSTOMER_DOUBLE_CLICK', 'AUTOMATIC_RETRY_FAILURE', 'LEGITIMATE_REPEATED_PAYMENTS']):
            with self.subTest(variant=variant), patch.dict(os.environ, {
                'INTELLIOPS_ENVIRONMENT': 'test', 'INTELLIOPS_ENABLE_RETRY_FAULT': 'true',
                'INTELLIOPS_SYNTHETIC_ACCOUNT_REFS': 'ACC-100003,ACC-100001'}):
                sender, receiver = self.balance('ACC-100003'), self.balance()
                response = self.generate(variant, run_key=f'scenario-run-{index:04d}')
                self.assertEqual(response.status_code, 201, response.text)
                result = response.json()
                count = 1 if index == 0 else 2
                self.assertEqual(result['postingCount'], count)
                self.assertEqual(result['attemptCount'], 2)
                self.assertEqual([p['status'] for p in result['payments']], ['Completed', 'Held' if index == 0 else 'Completed'])
                self.assertEqual(len(set(result['requestIds'])), 2)
                self.assertEqual(len(result['instructionReferences']), 2 if index == 2 else 1)
                self.assertEqual(self.balance('ACC-100003'), sender - Decimal('123.45') * count)
                self.assertEqual(self.balance(), receiver + Decimal('123.45') * count)
                with Session(self.engine) as db:
                    receipts = db.scalars(select(PaymentRequestHistory).where(PaymentRequestHistory.request_id.in_([UUID(v) for v in result['requestIds']]))).all()
                    self.assertEqual(sum(r.origin == 'SYSTEM' for r in receipts), int(index == 1))
                    self.assertEqual(sum(r.retry_of_request_id is not None for r in receipts), int(index == 1))
                    self.assertEqual(sum(r.authorization_id is not None for r in receipts), 2 if index == 2 else 0)
                    for journal in db.scalars(select(LedgerJournal).where(LedgerJournal.journal_ref.in_(result['journalReferences']))):
                        self.assertIsNotNone(journal.normal_transaction_id)
                        entries = db.scalars(select(LedgerEntry).where(LedgerEntry.journal_id == journal.journal_id)).all()
                        self.assertEqual(len(entries), 2)
                        self.assertEqual(sum(e.amount if e.side == 'Credit' else -e.amount for e in entries), 0)
                    self.assertEqual(db.scalar(select(func.count()).select_from(ExceptionBatchItem).where(ExceptionBatchItem.batch_id == UUID(result['runId']))), 2)
                replay = self.generate(variant, run_key=f'scenario-run-{index:04d}').json()
                self.assertEqual(replay['requestIds'], result['requestIds'])
                self.assertEqual(self.balance(), receiver + Decimal('123.45') * count)
                self.client.post('/api/detection/run')
                pair = set(result['paymentReferences'])
                cases = [c for c in self.client.get('/api/exceptions').json() if {c['transactionId'], c['relatedTransactionId']} == pair]
                self.assertEqual(len(cases), 1)
                self.assertEqual(cases[0]['evidence']['classification'], 'SUSPECTED_DUPLICATE')
                self.assertEqual(cases[0]['evidence']['rootCause'], 'NOT_ESTABLISHED')
                for ref in pair:
                    self.assertIn(cases[0]['id'], [c['id'] for c in self.client.get(f'/api/payments/{ref}/related').json()['exceptions']])
                self.assertEqual(self.client.post('/api/detection/run').json()['created'], 0)
                snapshot = json.dumps(self.client.get('/api/banking-snapshot').json())
                for forbidden in [variant, 'scenarioCode', 'expected_root_cause', 'INSTRUCTION_REPLAY_LOOKUP_FAILURE']:
                    self.assertNotIn(forbidden, snapshot)
                events = [e for p in result['payments'] for e in self.client.get(f"/api/payments/{p['id']}/events").json()]
                events.sort(key=lambda e: (datetime.fromisoformat(e['occurredAt'].replace('Z', '+00:00')), int(e['id'])))
                kinds = [e['eventType'] for e in events]
                self.assertEqual(kinds.count('CLIENT_SUBMISSION'), 1 if index == 1 else 2)
                self.assertTrue(all(e['requestId'] for e in events))
                if index == 1:
                    self.assertLess(kinds.index('ACK_TIMEOUT'), kinds.index('RETRY_SUBMITTED'))
                    self.assertLess(kinds.index('RETRY_SUBMITTED'), kinds.index('IDEMPOTENCY_CHECK_FAILED'))

    def test_guards_invalid_inputs_conflicting_run_and_second_posting_rollback(self):
        self.assertEqual(self.generate('AUTOMATIC_RETRY_FAILURE').status_code, 403)
        for changes in [dict(sender_account_ref='NONE'), dict(receiver_account_ref='ACC-100005'), dict(receiver_account_ref='ACC-100004'),
                        dict(amount='999999999.00'), dict(duplicate_scenario='INVALID'), dict(scenario_code='MISSING_LEDGER')]:
            self.assertEqual(self.generate(**changes).status_code, 422)
        enabled = {'INTELLIOPS_ENVIRONMENT': 'test', 'INTELLIOPS_ENABLE_RETRY_FAULT': 'true', 'INTELLIOPS_SYNTHETIC_ACCOUNT_REFS': 'ACC-100003,ACC-100001'}
        for override in [{'INTELLIOPS_ENVIRONMENT': 'production'}, {'INTELLIOPS_ENABLE_RETRY_FAULT': 'false'}, {'INTELLIOPS_SYNTHETIC_ACCOUNT_REFS': 'ACC-100003'}]:
            with patch.dict(os.environ, {**enabled, **override}):
                self.assertEqual(self.generate('AUTOMATIC_RETRY_FAILURE').status_code, 403)
        from modules.payment_processing.service import post_normal_journal
        calls = []
        def reject_second(*args):
            calls.append(True)
            if len(calls) == 2: raise ValueError('Second journal rejected')
            return post_normal_journal(*args)
        before = self.balance()
        with patch.dict(os.environ, enabled), patch('modules.payment_processing.service.post_normal_journal', side_effect=reject_second):
            self.assertEqual(self.generate('AUTOMATIC_RETRY_FAILURE').status_code, 422)
        self.assertEqual(self.balance(), before)
        with Session(self.engine) as db:
            self.assertEqual(db.scalar(select(func.count()).select_from(PaymentRequestHistory)), 0)
            self.assertEqual(db.scalar(select(func.count()).select_from(ExceptionBatch)), 0)
        self.assertEqual(self.generate().status_code, 201)
        self.assertEqual(self.generate(amount='124.00').status_code, 409)
        app.dependency_overrides[actor] = lambda: 'ANALYST'
        self.assertEqual(self.generate(run_key='analyst-run-0001').status_code, 403)

    def test_held_only_needs_one_transfer_and_validator_refuses_posting(self):
        from modules.core_banking.service import post_normal_journal
        response = self.generate(amount=str(self.balance('ACC-100003')))
        self.assertEqual(response.status_code, 201, response.text)
        self.assertEqual(self.balance('ACC-100003'), 0)
        with Session(self.engine) as db:
            held = db.scalar(select(Transaction).where(Transaction.status == 'HELD'))
            with self.assertRaisesRegex(ValueError, 'Held'):
                post_normal_journal(db, None, held, None, None, datetime.now())

    def test_pair_boundaries_and_recovery(self):
        from modules.intelliops.detection import detect
        from modules.payment_processing.service import create_payment
        from modules.payment_processing.schemas import PaymentRequest
        now = datetime(2026, 11, 3, 3, tzinfo=timezone.utc)
        with Session(self.engine) as db, db.begin():
            for index, seconds in enumerate([0, 120, 121]):
                create_payment(db, PaymentRequest(**self.request(idempotency_key=f'boundary-{index:04d}')), 'ADMIN', now=now + timedelta(seconds=seconds))
            db.flush()
            self.assertEqual(len(detect(db, 'ADMIN', now + timedelta(seconds=200))), 2)
            self.assertEqual(detect(db, 'ADMIN', now + timedelta(seconds=201)), [])
            case = db.scalar(select(ExceptionCase).where(ExceptionCase.exception_type == 'Duplicate Transaction'))
            case.status = 'CLOSED'
            original = db.get(Transaction, case.related_transaction_id)
            old_time = original.created_at
            original.created_at = now - timedelta(seconds=1000)
            db.flush(); detect(db, 'ADMIN', now + timedelta(seconds=202))
            original.created_at = old_time
            db.flush()
            self.assertEqual(len(detect(db, 'ADMIN', now + timedelta(seconds=203))), 1)

    def test_request_uniqueness_normal_replay_and_no_self_pair(self):
        from sqlalchemy.exc import IntegrityError
        payload = self.request()
        first = self.client.post('/api/payments', json=payload).json()
        second = self.client.post('/api/payments', json=payload).json()
        self.assertEqual(first['id'], second['id'])
        self.assertEqual(len(second['requests']), 2)
        with Session(self.engine) as db, db.begin():
            receipt = db.scalar(select(PaymentRequestHistory))
            with self.assertRaises(IntegrityError), db.begin_nested():
                db.execute(PaymentRequestHistory.__table__.insert().values(request_id=receipt.request_id,
                    business_instruction_id=receipt.business_instruction_id, payment_id=receipt.payment_id,
                    origin='CUSTOMER', submitted_idempotency_key='duplicate-request', received_at=datetime.now()))
            tx = db.scalar(select(Transaction).where(Transaction.reference == first['id']))
            with self.assertRaises(IntegrityError), db.begin_nested():
                db.add(ExceptionCase(transaction_id=tx.id, related_transaction_id=tx.id, exception_type='Duplicate Transaction', severity='HIGH', status='OPEN'))
                db.flush()

    def test_separate_authorizations_fit_a_short_configured_window(self):
        from modules.intelliops.models import DetectionRule
        self.client.post('/api/detection/run')
        with Session(self.engine) as db, db.begin():
            rule = db.scalar(select(DetectionRule).where(DetectionRule.code == 'DUPLICATE_TRANSACTION'))
            rule.configuration = {'similarity_window_seconds': 1}
        result = self.generate('LEGITIMATE_REPEATED_PAYMENTS')
        self.assertEqual(result.status_code, 201, result.text)
        self.assertEqual(self.client.post('/api/detection/run').json()['created'], 1)


class MigrationCompatibilityTests(unittest.TestCase):
    def test_old_schema_remains_readable_and_upgrade_preserves_case_history(self):
        engine = test_accounts.database()
        self.addCleanup(engine.dispose)
        self.addCleanup(app.dependency_overrides.clear)
        cfg = Config(str(Path(__file__).resolve().parents[1] / 'alembic.ini'))
        with engine.begin() as conn:
            cfg.attributes['connection'] = conn
            command.upgrade(cfg, '20261110_07')
            meta = MetaData()
            tables = {name: Table(name, meta, autoload_with=conn) for name in ['customers', 'accounts', 'transactions', 'processing_events', 'exceptions', 'exception_case_actions']}
            now = datetime.now()
            owner, account = uuid4().hex, uuid4().hex
            conn.execute(tables['customers'].insert().values(customer_id=owner, customer_ref='OLD-CUSTOMER', customer_name='Existing Customer', customer_type='INDIVIDUAL', status='Active', created_at=now))
            conn.execute(tables['accounts'].insert().values(account_id=account, account_ref='OLD-ACCOUNT', customer_id=owner, customer_type='INDIVIDUAL', account_type='SAVINGS', currency='SGD', opening_balance=500, status='Active', created_at=now))
            conn.execute(tables['transactions'].insert().values(id=1, reference='OLD-TXN', payment_reference='OLD-PAY', amount=10, currency='SGD', status='COMPLETED', created_at=now))
            conn.execute(tables['processing_events'].insert().values(transaction_id=1, event_type='SOURCE_IMPORTED', details='Existing event', created_at=now))
            conn.execute(tables['exceptions'].insert().values(id=1, transaction_id=1, exception_type='Missing Ledger Posting', severity='HIGH', status='OPEN', created_at=now, updated_at=now))
            conn.execute(tables['exception_case_actions'].insert().values(exception_id=1, action_type='NOTE_ADDED', actor='ADMIN', details={'note': 'preserve'}, created_at=now))
        def database():
            with Session(engine) as db: yield db
        app.dependency_overrides[get_db] = database
        app.dependency_overrides[actor] = lambda: 'ADMIN'
        with TestClient(app) as client:
            response = client.get('/api/banking-snapshot')
            self.assertEqual(response.status_code, 200, response.text)
            self.assertFalse(response.json()['schemaReady'])
            self.assertEqual(response.json()['accounts'][0]['reference'], 'OLD-ACCOUNT')
            self.assertEqual(response.json()['payment_transactions'][0]['id'], 'OLD-TXN')
            self.assertEqual(len(response.json()['processing_events']), 1)
            self.assertEqual(client.get('/api/exceptions/CASE-000001').status_code, 200)
            self.assertEqual(client.post('/api/detection/run').status_code, 503)
        with engine.begin() as conn:
            cfg.attributes['connection'] = conn
            command.upgrade(cfg, 'head')
            self.assertIn('payment_requests', inspect(conn).get_table_names())
            self.assertEqual(conn.execute(select(tables['transactions'].c.reference)).scalar_one(), 'OLD-TXN')
            self.assertEqual(conn.execute(select(tables['exception_case_actions'].c.details)).scalar_one(), {'note': 'preserve'})
            self.assertEqual(conn.exec_driver_sql('PRAGMA foreign_key_check').all(), [])
