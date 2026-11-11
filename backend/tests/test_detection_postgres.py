"""Opt-in PostgreSQL verification; never falls back to application DATABASE_URL.

Requires INTELLIOPS_TEST_POSTGRES_URL with loopback host and database ending _test.
Every test uses its own disposable schema. Supabase/remote URLs are rejected.
"""
import os
os.environ["DATABASE_URL"] = "sqlite:///:memory:"

import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from threading import Barrier
from uuid import uuid4
from sqlalchemy import create_engine, select, func, text, inspect, event
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session
from alembic import command
from alembic.config import Config
from shared.database import Base
import models
from modules.core_banking.seed import seed_demo
from modules.payment_processing.schemas import PaymentRequest
from modules.payment_processing.service import create_payment
from modules.intelliops.detection import detect
from modules.intelliops.models import ExceptionCase, DetectionRule
from modules.intelliops.rules import RULES, validate_configuration
from modules.core_banking.service import account_query


@unittest.skipUnless(os.getenv("INTELLIOPS_TEST_POSTGRES_URL"), "No explicit disposable local PostgreSQL URL configured")
class PostgreSQLDetectionTests(unittest.TestCase):
    def setUp(self):
        url = make_url(os.environ["INTELLIOPS_TEST_POSTGRES_URL"])
        if (url.get_backend_name() != "postgresql" or url.host not in ("localhost", "127.0.0.1", "::1")
                or not (url.database or "").endswith("_test") or set(url.query) - {"sslmode"}):
            raise RuntimeError("Only an explicit loopback PostgreSQL *_test database is allowed.")
        self.schema = "intelliops_test_" + uuid4().hex
        self.control = create_engine(url)
        with self.control.begin() as conn:
            conn.execute(text(f'CREATE SCHEMA "{self.schema}"'))
        self.engine = create_engine(url, connect_args={"options": f"-csearch_path={self.schema},pg_catalog", "connect_timeout": 5})
        self.addCleanup(self.cleanup_database)

    def cleanup_database(self):
        self.engine.dispose()
        with self.control.begin() as conn:
            conn.execute(text(f'DROP SCHEMA "{self.schema}" CASCADE'))
        self.control.dispose()

    def upgrade(self, target="head"):
        cfg = Config(str(Path(__file__).resolve().parents[1] / "alembic.ini"))
        with self.engine.begin() as conn:
            cfg.attributes["connection"] = conn
            command.upgrade(cfg, target)

    def sequence_state(self):
        with self.engine.connect() as conn:
            return tuple(conn.execute(text("SELECT last_value,is_called FROM detection_rules_id_seq")).one())

    def source_snapshot(self):
        with self.engine.connect() as conn:
            snapshot = {}
            for name in inspect(conn).get_table_names(schema=self.schema):
                if name not in {"alembic_version", "detection_rules", "detection_observations"}:
                    # PostgreSQL normalizes JSON representation and exact numeric values.
                    snapshot[name] = sorted(conn.execute(text(f'SELECT row_to_json(t)::text FROM "{name}" t')).scalars())
            return snapshot

    def balances(self):
        with Session(self.engine) as db:
            return sorted((str(row[0].account_id), row[0].opening_balance, row[-1])
                          for row in db.execute(account_query()[0]))

    def assert_rules(self, legacy=False):
        with Session(self.engine) as db:
            rows = db.scalars(select(DetectionRule)).all()
            self.assertEqual(len(rows), 10 if legacy else 9)
            by_code = {row.code: row for row in rows}
            self.assertEqual(set(by_code), {spec.code for spec in RULES} | ({"LEGACY_42"} if legacy else set()))
            for spec in RULES:
                row = by_code[spec.code]
                self.assertEqual(row.exception_type, spec.exception_type)
                self.assertEqual(row.severity, spec.severity)
                self.assertEqual(row.configuration, {})
                self.assertEqual(row.version, 1)
                self.assertIsNone(row.threshold)
                self.assertIsNotNone(row.updated_at)
                self.assertTrue(row.description)
                self.assertEqual(validate_configuration(spec, row), spec.defaults)
                self.assertEqual(row.enabled, not (legacy and spec.code == "PAYMENT_PROCESSING_FAILURE"))

    def populated_legacy(self, called=False, ahead=None):
        self.upgrade("20261103_06")
        now = datetime(2026, 11, 3, 3, tzinfo=timezone.utc)
        with Session(self.engine) as db, db.begin():
            seed_demo(db)
            create_payment(db, PaymentRequest(sender_account_ref="ACC-100003", receiver_account_ref="ACC-100001",
                           amount="123.45", idempotency_key="migration-existing-payment"), "ADMIN", "NORMAL", now)
        with self.engine.begin() as conn:
            conn.execute(text("""INSERT INTO detection_rules (id,name,exception_type,enabled,threshold) VALUES
                (1,'My disabled failure rule','Payment Processing Failure',false,NULL),
                (42,'Preserved legacy rule','Unregistered Legacy Type',true,7)"""))
            conn.execute(text("""INSERT INTO exceptions
                (id,transaction_id,rule_id,exception_type,severity,status,evidence,detection_key,created_at,updated_at)
                SELECT 4,id,1,'Payment Processing Failure','HIGH','OPEN',CAST(:evidence AS JSON),
                       'historical-key-keep',:now,:now FROM transactions WHERE id=(SELECT MIN(id) FROM transactions)"""),
                         {"now": now, "evidence": '{"historical":true}'})
            conn.execute(text("""INSERT INTO exceptions
                (id,transaction_id,rule_id,exception_type,severity,status,evidence,detection_key,created_at,updated_at)
                SELECT 73,transaction_id,NULL,'Duplicate Transaction','HIGH','CLOSED',CAST(:evidence AS JSON),
                       NULL,:now,:now FROM exceptions WHERE id=4"""),
                         {"now": now, "evidence": '{"originalReference":"OLD"}'})
            if ahead is not None or called:
                conn.execute(text("SELECT setval('detection_rules_id_seq',:value,:called)"),
                             {"value": ahead or 1, "called": called})

    def check_populated_upgrade(self, called=False, ahead=None):
        self.populated_legacy(called, ahead)
        self.assertEqual(self.sequence_state(), (ahead or 1, called))
        before, balances = self.source_snapshot(), self.balances()
        self.upgrade()
        self.assertEqual(before, self.source_snapshot())
        self.assertEqual(balances, self.balances())
        self.assert_rules(legacy=True)
        with self.engine.connect() as conn:
            original = conn.execute(text("SELECT id,name,enabled,threshold,code FROM detection_rules WHERE id IN (1,42) ORDER BY id")).all()
            self.assertEqual([tuple(r) for r in original], [
                (1, "My disabled failure rule", False, None, "PAYMENT_PROCESSING_FAILURE"),
                (42, "Preserved legacy rule", True, 7, "LEGACY_42")])
            generated = conn.execute(text("SELECT MIN(id) FROM detection_rules WHERE id NOT IN (1,42)")).scalar_one()
            self.assertEqual(generated, max(43, (ahead or 1) + int(called)))
            self.assertEqual(conn.execute(text("SELECT count(*) FROM detection_observations")).scalar_one(), 0)
            self.assertEqual(conn.execute(text("SELECT version_num FROM alembic_version")).scalar_one(), "20261110_07")
        # Repeat upgrade is a no-op, including allocation and records.
        state = self.sequence_state()
        self.upgrade()
        self.assertEqual(state, self.sequence_state())
        self.assertEqual(before, self.source_snapshot())

    def test_populated_upgrade_reconciles_never_called_sequence(self):
        self.check_populated_upgrade()

    def test_populated_upgrade_reconciles_called_lagging_sequence(self):
        self.check_populated_upgrade(called=True)

    def test_populated_upgrade_preserves_ahead_called_sequence(self):
        self.check_populated_upgrade(called=True, ahead=500)

    def test_populated_upgrade_preserves_ahead_uncalled_sequence(self):
        self.check_populated_upgrade(called=False, ahead=500)

    def test_reconciled_sequence_and_schema_rollback_on_later_failure(self):
        self.populated_legacy()
        before, state = self.source_snapshot(), self.sequence_state()
        def fail_create(conn, cursor, statement, parameters, context, executemany):
            if statement.lstrip().startswith("CREATE TABLE detection_observations"):
                raise RuntimeError("isolated injected failure")
        event.listen(self.engine, "before_cursor_execute", fail_create)
        try:
            with self.assertRaisesRegex(RuntimeError, "injected failure"):
                self.upgrade()
        finally:
            event.remove(self.engine, "before_cursor_execute", fail_create)
        self.assertEqual(state, self.sequence_state())
        self.assertEqual(before, self.source_snapshot())
        with self.engine.connect() as conn:
            self.assertEqual(conn.execute(text("SELECT version_num FROM alembic_version")).scalar_one(), "20261103_06")
            self.assertNotIn("code", {c["name"] for c in inspect(conn).get_columns("detection_rules")})
        self.upgrade()
        self.assert_rules(legacy=True)

    def test_sequence_capacity_preflight_preserves_legacy_schema(self):
        self.populated_legacy(called=True, ahead=2147483646)
        before, state = self.source_snapshot(), self.sequence_state()
        with self.assertRaisesRegex(RuntimeError, "insufficient capacity"):
            self.upgrade()
        self.assertEqual(state, self.sequence_state())
        self.assertEqual(before, self.source_snapshot())
        with self.engine.connect() as conn:
            self.assertEqual(conn.execute(text("SELECT version_num FROM alembic_version")).scalar_one(), "20261103_06")
            self.assertNotIn("code", {c["name"] for c in inspect(conn).get_columns("detection_rules")})

    def test_concurrent_scans_create_one_active_case(self):
        Base.metadata.create_all(self.engine)
        now = datetime(2026, 11, 3, 3, tzinfo=timezone.utc)
        with Session(self.engine) as db, db.begin():
            seed_demo(db)
            create_payment(db, PaymentRequest(sender_account_ref="ACC-100003", receiver_account_ref="ACC-100001",
                           amount="100.00", idempotency_key="postgres-race-0001"), "ADMIN", "MISSING_LEDGER", now)
        gate = Barrier(4)
        def scan(_):
            with Session(self.engine) as db, db.begin():
                gate.wait(timeout=10)
                return detect(db, "ADMIN", now + timedelta(seconds=61))
        with ThreadPoolExecutor(max_workers=4) as pool:
            outcomes = list(pool.map(scan, range(4)))
        self.assertEqual(sum(map(len, outcomes)), 1)
        with Session(self.engine) as db:
            self.assertEqual(db.scalar(select(func.count()).select_from(ExceptionCase)), 1)
            self.assertEqual(db.scalar(select(func.count()).select_from(DetectionRule)), 9)

    def test_fresh_postgresql_migration_chain(self):
        cfg = Config(str(Path(__file__).resolve().parents[1] / "alembic.ini"))
        with self.engine.begin() as conn:
            cfg.attributes["connection"] = conn
            command.upgrade(cfg, "head")
            self.assertEqual(conn.execute(text("SELECT version_num FROM alembic_version")).scalar_one(), "20261110_07")
            self.assertEqual(len([name for name in inspect(conn).get_table_names(schema=self.schema)
                                  if name != "alembic_version"]), 17)
        self.assert_rules()
