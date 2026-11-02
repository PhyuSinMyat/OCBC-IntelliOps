import os
os.environ["DATABASE_URL"] = "sqlite:///:memory:"

import unittest
from decimal import Decimal
from uuid import uuid4
from pathlib import Path
from sqlalchemy import create_engine, event, select, func
from sqlalchemy.pool import StaticPool
from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError
from fastapi.testclient import TestClient
from alembic import command
from alembic.config import Config
from shared.database import Base
from main import app
from shared.security import actor
from modules.core_banking.router import get_db
from modules.core_banking.models import Customer, Account, LedgerJournal, LedgerEntry
from modules.core_banking.seed import seed_demo, demo_id
from modules.core_banking.service import validate_ownership
from modules.payment_processing.models import Transaction


def database():
    engine = create_engine("sqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False})
    @event.listens_for(engine, "connect")
    def foreign_keys(connection, _):
        connection.execute("PRAGMA foreign_keys=ON")
    return engine


class AccountTests(unittest.TestCase):
    def setUp(self):
        self.engine = database()
        Base.metadata.create_all(self.engine)
        with Session(self.engine) as db, db.begin():
            seed_demo(db)
        def override():
            with Session(self.engine) as db:
                yield db
        app.dependency_overrides[get_db] = override
        app.dependency_overrides[actor] = lambda: "ADMIN"
        self.client = TestClient(app)

    def tearDown(self):
        app.dependency_overrides.clear()
        self.client.close()
        self.engine.dispose()

    def detail(self, reference="ACC-100001"):
        response = self.client.get(f"/api/accounts/{demo_id(reference)}")
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def test_customer_info_and_balance(self):
        data = self.detail()
        self.assertEqual(data["customer"]["customer_type"], "INDIVIDUAL")
        self.assertEqual(data["customer"]["customer_name"], "Alex Tan")
        self.assertEqual(data["account_type"], "SAVINGS")
        self.assertEqual({k: Decimal(v) for k, v in data["balance"].items()}, dict(
            opening_balance=Decimal("42500"), posted_credits=Decimal("5000"),
            posted_debits=Decimal("3500"), net_change=Decimal("1500"), current_balance=Decimal("44000")))
        self.assertEqual(len(self.client.get("/api/customers").json()), 8)

    def test_search_combined_filters_sort_and_pagination(self):
        for search in ["northstar", " CUS-003 ", "ACC-100003"]:
            data = self.client.get("/api/accounts", params={"search": search}).json()
            self.assertEqual(data["total"], 1)
            self.assertEqual(data["items"][0]["account_ref"], "ACC-100003")
        data = self.client.get("/api/accounts", params=dict(customer_type="BUSINESS", account_type="CURRENT", status="Active", currency="SGD")).json()
        self.assertEqual(data["total"], 2)
        self.assertEqual(self.client.get("/api/accounts", params={"search": "%"}).json()["total"], 0)
        self.assertEqual(self.client.get("/api/accounts", params={"customer_type": "BUSINESS", "account_type": "SAVINGS"}).json()["total"], 0)
        first = self.client.get("/api/accounts", params={"sort": "balance-desc", "page_size": 2}).json()
        second = self.client.get("/api/accounts", params={"sort": "balance-desc", "page_size": 2, "page": 2}).json()
        self.assertEqual(first["items"][0]["account_ref"], "ACC-100003")
        self.assertTrue({a["account_id"] for a in first["items"]}.isdisjoint({a["account_id"] for a in second["items"]}))
        self.assertEqual(first["total"], 8)
        for sort, expected in [("customer-asc", "ACC-100001"), ("customer-desc", "ACC-100005"), ("created-desc", "ACC-100008"), ("balance-asc", "ACC-100007")]:
            self.assertEqual(self.client.get("/api/accounts", params={"sort": sort}).json()["items"][0]["account_ref"], expected)
        self.assertEqual(self.client.get("/api/accounts", params={"page": 0}).status_code, 422)
        self.assertEqual(self.client.get("/api/accounts", params={"account_type": "CORPORATE"}).status_code, 422)
        self.assertEqual(self.client.get(f"/api/accounts/{uuid4()}").status_code, 404)

    def test_posted_history_and_unavailable_payment(self):
        url = f"/api/accounts/{demo_id('ACC-100001')}/ledger-entries"
        history = self.client.get(url).json()
        self.assertEqual(len(history), 2)
        self.assertEqual(history[0]["journal_reference"], "JRN-1002")
        self.assertEqual(Decimal(history[0]["signed_amount"]), Decimal("-3500"))
        self.assertTrue(history[0]["payment_available"])
        with Session(self.engine) as db, db.begin():
            db.get(LedgerJournal, demo_id("JRN-1002")).payment_reference = "UNMATCHED"
        self.assertFalse(self.client.get(url).json()[0]["payment_available"])
        self.assertEqual(Decimal(self.detail()["balance"]["current_balance"]), Decimal("44000"))

    def test_unposted_reversed_invalid_and_currency_mismatch_excluded(self):
        for status in ["Draft", "Pending", "Failed", "Reversed"]:
            with Session(self.engine) as db, db.begin():
                db.get(LedgerJournal, demo_id("JRN-1001")).status = status
            self.assertEqual(Decimal(self.detail()["balance"]["current_balance"]), Decimal("39000"))
        with Session(self.engine) as db, db.begin():
            db.get(LedgerJournal, demo_id("JRN-1001")).status = "Posted"
            db.get(LedgerEntry, demo_id("JRN-1001-D")).posted = False
        self.assertEqual(Decimal(self.detail()["balance"]["posted_credits"]), 0)
        with Session(self.engine) as db, db.begin():
            entry = db.get(LedgerEntry, demo_id("JRN-1001-D"))
            entry.posted = True
            entry.currency = "USD"
        self.assertEqual(Decimal(self.detail()["balance"]["posted_credits"]), 0)
        with Session(self.engine) as db, db.begin():
            entry = db.get(LedgerEntry, demo_id("JRN-1001-D"))
            entry.currency = "SGD"
            entry.amount += 1
        self.assertEqual(Decimal(self.detail()["balance"]["posted_credits"]), 0)

    def test_missing_posting_and_balanced_reconciliation_mismatch_not_repaired(self):
        with Session(self.engine) as db, db.begin():
            db.add(Transaction(reference="TXN-MISSING", payment_reference="PAY-MISSING", amount=100, currency="SGD", status="COMPLETED"))
            db.scalar(select(Transaction).where(Transaction.reference == "TXN-1001")).amount += 1
        self.assertEqual(Decimal(self.detail()["balance"]["current_balance"]), Decimal("44000"))
        with Session(self.engine) as db:
            self.assertEqual(db.scalar(select(func.count()).select_from(LedgerJournal)), 2)
            self.assertEqual(db.scalar(select(Transaction).where(Transaction.reference == "TXN-1001")).amount, Decimal("5001"))

    def test_database_constraints_and_service_ownership(self):
        with Session(self.engine) as db:
            self.assertEqual(validate_ownership(db, demo_id("CUS-001"), "CURRENT").customer_type, "INDIVIDUAL")
            for customer, product in [("CUS-003", "SAVINGS"), ("CUS-001", "CORPORATE")]:
                with self.assertRaises(ValueError):
                    validate_ownership(db, demo_id(customer), product)
            with self.assertRaises(ValueError):
                validate_ownership(db, uuid4(), "CURRENT")
        for field, value in [("account_type", "CORPORATE"), ("account_type", "SAVINGS"), ("customer_type", "INDIVIDUAL")]:
            with self.assertRaises(IntegrityError), Session(self.engine) as db, db.begin():
                setattr(db.get(Account, demo_id("ACC-100003")), field, value)
        with self.assertRaises(IntegrityError), Session(self.engine) as db, db.begin():
            db.get(Customer, demo_id("CUS-001")).customer_type = "CORPORATE"

    def test_seed_idempotence_and_existing_relationships(self):
        with Session(self.engine) as db, db.begin():
            report = seed_demo(db)
            self.assertEqual(report["created"], 0)
            self.assertEqual(report["manual_classification"], [])
            self.assertEqual(db.get(LedgerEntry, demo_id("JRN-1001-C")).account_id, demo_id("ACC-100001"))
        self.assertEqual(Decimal(self.detail()["balance"]["current_balance"]), Decimal("44000"))

    def test_cross_portal_snapshot_uses_same_ids_and_server_balances(self):
        response = self.client.get("/api/banking-snapshot")
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        alex = next(a for a in data["accounts"] if a["id"] == "ACC-100001")
        self.assertEqual(alex["authoritativeBalance"]["current"], 4400000)
        self.assertEqual(data["ledger_journals"][0]["paymentId"], data["payment_transactions"][0]["id"])
        self.assertEqual(data["payment_transactions"][0]["senderId"], "ACC-100003")


class MigrationTests(unittest.TestCase):
    def test_upgrade_preserves_legacy_rows_and_allows_idempotent_seed(self):
        engine = database()
        Base.metadata.tables["transactions"].create(engine)
        with Session(engine) as db, db.begin():
            db.add(Transaction(reference="LEGACY", payment_reference="LEGACY-PAY", amount=7, currency="SGD", status="PENDING"))
        cfg = Config(str(Path(__file__).resolve().parents[1] / "alembic.ini"))
        with engine.begin() as connection:
            cfg.attributes["connection"] = connection
            command.upgrade(cfg, "head")
        with Session(engine) as db, db.begin():
            self.assertEqual(db.scalar(select(Transaction).where(Transaction.reference == "LEGACY")).amount, Decimal("7"))
            seed_demo(db)
            self.assertEqual(seed_demo(db)["created"], 0)
        engine.dispose()


if __name__ == "__main__":
    unittest.main()
