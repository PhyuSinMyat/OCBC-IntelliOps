"""Offline durable-history contract tests. No Supabase writes or paid calls."""
import os
os.environ['DATABASE_URL'] = 'sqlite:///:memory:'
import unittest
import tempfile
import sqlite3
from pathlib import Path
from copy import deepcopy
from uuid import uuid4
from unittest.mock import patch
from sqlalchemy import select, create_engine
from sqlalchemy.orm import Session
import httpx
import test_investigation as original
from main import app
from shared.security import actor
from shared.database import Base
from modules.intelliops.investigation_llm import InvestigationProvider, get_investigation_provider
from modules.intelliops.investigation_storage import InvestigationRecord, fingerprint, import_accepted_report
from modules.intelliops.models import ExceptionCase
from modules.intelliops.investigation_projection import model_evidence


class PersistenceTests(unittest.TestCase):
    fixture = original.InvestigationTests.fixture
    provider = original.InvestigationTests.provider
    def setUp(self):
        original.InvestigationTests.setUp(self)
        self.guard = patch.dict(os.environ, {'INTELLIOPS_INVESTIGATION_PERSISTENCE': 'true',
            'OPENAI_API_KEY': 'offline-key', 'OPENAI_MODEL': 'offline-model', 'INTELLIOPS_LLM_DIAGNOSTICS_DIR': ''})
        self.guard.start()
        self.fixture('C')
    def tearDown(self):
        self.guard.stop()
        original.InvestigationTests.tearDown(self)
    def start(self, request_id=None):
        return self.client.post('/api/exceptions/CASE-000004/investigations',
            headers={'X-Investigation-Request-ID': request_id or str(uuid4())})
    def financial_fingerprint(self):
        with self.engine.connect() as conn:
            return {t.name: sorted(repr(tuple(r)) for r in conn.execute(select(t)))
                for t in Base.metadata.sorted_tables if t.name != 'investigation_records'}

    def test_persist_read_restart_retry_and_staleness_without_provider_calls(self):
        self.provider(); before = self.financial_fingerprint(); request_id = str(uuid4())
        result = self.start(request_id)
        self.assertEqual(result.status_code, 200, result.text)
        report = result.json(); self.assertEqual(report['persistence'], 'BACKEND_DATABASE')
        self.assertNotIn('evidence', report['supporting_evidence']['caseRecord'])
        self.assertEqual(len(report['evidence_fingerprint']), 64)
        # All future reads/replays must work even with provider HTTP disabled.
        app.dependency_overrides[get_investigation_provider] = lambda: InvestigationProvider(httpx.MockTransport(
            lambda request: (_ for _ in ()).throw(AssertionError('No provider call allowed'))))
        from modules.intelliops.investigation_runs import _runs
        _runs.clear()
        replay = self.start(request_id)
        self.assertEqual(replay.status_code, 200, replay.text)
        self.assertEqual(replay.json(), report)
        listing = self.client.get('/api/exceptions/CASE-000004/investigations')
        self.assertEqual(listing.status_code, 200, listing.text)
        item = listing.json()['investigations'][0]
        self.assertFalse(item['stale']); self.assertEqual(item['report'], report)
        path = '/api/exceptions/CASE-000004/investigations/' + report['investigation_id']
        self.assertEqual(self.client.get(path).json()['investigations'][0]['report'], report)
        self.assertEqual(before, self.financial_fingerprint())
        with Session(self.engine) as db, db.begin():
            db.get(ExceptionCase, 4).severity = 'LOW'  # Local fixture only, to prove stale history.
        stale = self.client.get(path).json()['investigations'][0]
        self.assertTrue(stale['stale']); self.assertEqual(stale['report'], report)

    def test_rejected_and_failed_requests_are_not_saved_as_accepted_reports_or_retried(self):
        for rejection in (True, False):
            with self.subTest(rejection=rejection):
                self.provider(mutate=(lambda o: o.update(recommended_action_code='AUTOMATIC_REFUND')) if rejection else None,
                              status=200 if rejection else 429)
                request_id = str(uuid4()); before = self.financial_fingerprint()
                result = self.start(request_id)
                self.assertEqual(result.status_code, 502, result.text)
                app.dependency_overrides[get_investigation_provider] = lambda: InvestigationProvider(httpx.MockTransport(
                    lambda request: (_ for _ in ()).throw(AssertionError('Failure must not retry'))))
                self.assertEqual(self.start(request_id).json(), result.json())
                with Session(self.engine) as db:
                    row = db.get(InvestigationRecord, request_id)
                    self.assertIsNone(row.report)
                    self.assertIn(row.status, ('FAILED', 'REJECTED'))
                self.assertEqual(before, self.financial_fingerprint())

    def test_missing_id_and_inflight_reservation_block_spending(self):
        self.provider()
        self.assertEqual(self.client.post('/api/exceptions/CASE-000004/investigations').status_code, 422)
        request_id = str(uuid4())
        with Session(self.engine) as db, db.begin():
            db.add(InvestigationRecord(request_id=request_id, case_id=4, created_by='ADMIN', status='RUNNING', evidence_fingerprint='0'*64))
        self.assertEqual(self.start(request_id).status_code, 409)
        self.assertEqual(self.start().status_code, 409)

    def test_auth_case_scope_roles_and_immutability(self):
        self.provider(); report = self.start().json()
        path = '/api/exceptions/CASE-000004/investigations/' + report['investigation_id']
        app.dependency_overrides[actor] = lambda: 'ANALYST'
        self.assertEqual(self.client.get(path).status_code, 200)
        self.assertEqual(self.client.get(path.replace('CASE-000004', 'CASE-999999')).status_code, 404)
        app.dependency_overrides.pop(actor)
        self.assertEqual(self.client.get(path).status_code, 401)
        with Session(self.engine) as db:
            row = db.scalar(select(InvestigationRecord).where(InvestigationRecord.investigation_id == report['investigation_id']))
            row.model = 'overwrite'
            with self.assertRaisesRegex(ValueError, 'immutable'): db.commit()
            db.rollback()
            db.delete(db.get(InvestigationRecord, row.request_id))
            with self.assertRaisesRegex(ValueError, 'cannot be deleted'): db.commit()

    def test_fingerprint_ignores_retrieval_clock_and_collection_order(self):
        evidence = self.client.get('/api/exceptions/CASE-000004/investigation-evidence').json()
        expected = fingerprint(evidence); changed = deepcopy(evidence)
        changed['retrieved_at'] = '2099-01-01T00:00:00Z'; changed['snapshot']['events'].reverse()
        self.assertEqual(expected, fingerprint(changed))
        changed['snapshot']['requests'][0]['authorizationId'] = 'changed'
        self.assertNotEqual(expected, fingerprint(changed))

    def test_saved_report_survives_unavailable_current_source_comparison(self):
        from modules.intelliops.service import CaseError
        self.provider(); report = self.start().json()
        with patch('modules.intelliops.investigation_router.collect', side_effect=CaseError('Current source unavailable', 503)):
            result = self.client.get('/api/exceptions/CASE-000004/investigations/' + report['investigation_id'])
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(result.json()['current_evidence_availability'], 'UNAVAILABLE')
        self.assertIsNone(result.json()['investigations'][0]['stale'])
        self.assertEqual(result.json()['investigations'][0]['report'], report)

    def test_file_database_reopens_without_process_cache(self):
        self.provider(); report = self.start().json()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'history.sqlite'
            # Copy this isolated fixture into a file, then use independent engines.
            source = self.engine.raw_connection()
            target = sqlite3.connect(path)
            source.driver_connection.backup(target)
            target.close(); source.close()
            for _ in range(2):
                restarted = create_engine('sqlite:///' + path.as_posix())
                with Session(restarted) as db:
                    record = db.scalar(select(InvestigationRecord).where(InvestigationRecord.investigation_id == report['investigation_id']))
                    self.assertEqual(record.report, report)
                restarted.dispose()

    def test_disabled_or_missing_storage_never_calls_provider(self):
        app.dependency_overrides[get_investigation_provider] = lambda: InvestigationProvider(httpx.MockTransport(
            lambda request: (_ for _ in ()).throw(AssertionError('Provider must not run'))))
        with patch.dict(os.environ, {'INTELLIOPS_INVESTIGATION_PERSISTENCE': 'false'}):
            self.assertEqual(self.client.get('/api/exceptions/CASE-000004/investigations').status_code, 503)
        InvestigationRecord.__table__.drop(self.engine)  # Disposable local fixture only.
        response = self.start()
        self.assertEqual(response.status_code, 503)
        self.assertIn('no provider call', response.json()['detail'])

    def test_explicit_import_reuses_saved_analysis_without_provider_or_financial_changes(self):
        self.provider(); report = self.start().json(); before = self.financial_fingerprint()
        with Session(self.engine) as db:
            # Reimporting an existing ID is read-only and idempotent.
            status, existing = import_accepted_report(db, report)
            self.assertEqual(status, 200); self.assertEqual(existing, report)
        saved = deepcopy(report); saved['investigation_id'] = 'INV-' + str(uuid4())
        saved['provider_metadata']['raw_secret_header'] = 'must-not-persist'
        with patch('httpx.Client', side_effect=AssertionError('Import cannot call any provider')), Session(self.engine) as db:
            status, imported = import_accepted_report(db, saved)
            self.assertEqual(status, 200)
            self.assertEqual(imported['llm_analysis'], saved['llm_analysis'])
            self.assertNotIn('must-not-persist', str(imported))
        self.assertEqual(before, self.financial_fingerprint())


if __name__ == '__main__': unittest.main()
