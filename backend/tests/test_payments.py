import os
import unittest
from unittest.mock import patch
from decimal import Decimal
from sqlalchemy import select, func
from sqlalchemy.orm import Session
from main import app
from shared.security import actor
from modules.payment_processing.models import Transaction, ProcessingEvent, PaymentInstruction
from modules.core_banking.models import LedgerEntry, LedgerJournal
from modules.core_banking.seed import demo_id
from modules.intelliops.models import ExceptionCase, AuditEvent, DetectionRule
import test_accounts


class PaymentTests(unittest.TestCase):
    setUpDatabase = test_accounts.AccountTests.setUp
    tearDownDatabase = test_accounts.AccountTests.tearDown

    def setUp(self):
        self.setUpDatabase()
        self.clock = patch.dict(os.environ, {"INTELLIOPS_SIMULATION_TIME": "2026-11-03T03:00:00+00:00"})
        self.clock.start()

    def tearDown(self):
        self.clock.stop()
        self.tearDownDatabase()

    def request(self, **overrides):
        return {"sender_account_ref": "ACC-100003", "receiver_account_ref": "ACC-100001", "amount": "100.00", "idempotency_key": "test-payment-0001", **overrides}

    def post(self, scenario="NORMAL", **overrides):
        payload = self.request(**overrides)
        if scenario != "NORMAL":
            payload["scenario_code"] = scenario
        response = self.client.post("/api/payments" if scenario == "NORMAL" else "/api/demo/payments/scenario", json=payload)
        self.assertEqual(response.status_code, 201, response.text)
        return response.json()

    def balance(self, ref="ACC-100001"):
        return Decimal(self.client.get(f"/api/accounts/{demo_id(ref)}").json()["balance"]["current_balance"])

    def test_valid_creation_events_posting_and_idempotency(self):
        payment = self.post()
        replay = self.post(amount="100.0")
        self.assertEqual(payment["id"], replay["id"])
        self.assertEqual(payment["status"], "Completed")
        self.assertIsNotNone(payment["completedAt"])
        self.assertEqual(self.balance(), Decimal("44100"))
        history = self.client.get(f"/api/payments/{payment['paymentId']}/events").json()
        self.assertEqual([e["eventType"] for e in history], ["PAYMENT_CREATED", "VALIDATION_STARTED", "VALIDATION_PASSED", "PROCESSING_STARTED", "LEDGER_POSTED", "PROCESSING_COMPLETED"])
        self.assertEqual([e["status"] for e in history], ["PENDING", "PROCESSING", "PROCESSING", "PROCESSING", "PROCESSING", "COMPLETED"])
        related = self.client.get(f"/api/payments/{payment['id']}/related").json()
        self.assertEqual(Decimal(related["journals"][0]["debitTotal"]), Decimal("100"))
        self.assertEqual(related["journals"][0]["debitTotal"], related["journals"][0]["creditTotal"])
        self.assertEqual(related["exceptions"], [])
        conflict = self.client.post("/api/payments", json=self.request(amount="101.00"))
        self.assertEqual(conflict.status_code, 409)
        with Session(self.engine) as db:
            self.assertEqual(db.scalar(select(func.count()).select_from(Transaction)), 3)
            self.assertEqual(db.scalar(select(func.count()).select_from(AuditEvent).where(AuditEvent.action == "PAYMENT_CREATED")), 1)

    def test_invalid_inputs_do_not_partially_create_records(self):
        for changes in [dict(sender_account_ref="NONE"), dict(receiver_account_ref="ACC-100003"),
                        dict(receiver_account_ref="ACC-100005"), dict(receiver_account_ref="ACC-100007"),
                        dict(receiver_account_ref="ACC-100004"), dict(amount="999999999.99"),
                        dict(amount="0"), dict(amount="-1"), dict(amount="1.001"), dict(amount="NaN"),
                        dict(currency="USD")]:
            response = self.client.post("/api/payments", json=self.request(**changes))
            self.assertEqual(response.status_code, 422, response.text)
        with Session(self.engine) as db:
            self.assertEqual(db.scalar(select(func.count()).select_from(Transaction)), 2)
            self.assertEqual(db.scalar(select(func.count()).select_from(LedgerJournal)), 2)

    def test_read_search_filters_pagination_dates_and_details(self):
        payment = self.post()
        for query in [payment["id"], "Northstar", "ACC-100003", "Alex"]:
            data = self.client.get("/api/payments", params={"search": query, "status": "COMPLETED", "currency": "SGD"}).json()
            self.assertGreaterEqual(data["total"], 1)
        data = self.client.get("/api/payments", params={"date_from": "2026-11-03T00:00:00+08:00", "date_to": "2026-11-03T23:59:59+08:00"}).json()
        self.assertEqual(data["total"], 1)
        self.assertEqual(data["items"][0]["id"], payment["id"])
        first = self.client.get("/api/payments", params={"sort": "amount-high", "page_size": 1}).json()
        second = self.client.get("/api/payments", params={"sort": "amount-high", "page_size": 1, "page": 2}).json()
        self.assertNotEqual(first["items"][0]["id"], second["items"][0]["id"])
        detail = self.client.get(f"/api/payments/{payment['id']}").json()
        self.assertEqual(detail["sender"]["customerType"], "BUSINESS")
        self.assertEqual(self.client.get("/api/payments/missing").status_code, 404)
        self.assertEqual(self.client.get("/api/payments", params={"page": 0}).status_code, 422)

    def test_all_scenarios_detection_cutoff_and_no_duplicate_active_cases(self):
        results = {}
        for code in ["DUPLICATE", "PROCESSING_FAILURE", "MISSING_LEDGER", "AMOUNT_MISMATCH", "UNMATCHED"]:
            results[code] = self.post(code, idempotency_key=f"scenario-{code}")
        self.assertEqual(results["DUPLICATE"]["status"], "Pending")
        self.assertIsNotNone(results["DUPLICATE"]["originalPaymentId"])
        failure = results["PROCESSING_FAILURE"]
        self.assertEqual(failure["status"], "Failed")
        self.assertEqual(self.client.get(f"/api/payments/{failure['id']}/related").json()["journals"], [])
        events = self.client.get(f"/api/payments/{failure['id']}/events").json()
        self.assertEqual(events[-1]["errorCode"], "SIM_PROCESSING_ERROR")
        self.assertNotIn("PROCESSING_COMPLETED", [e["eventType"] for e in events])
        self.assertEqual(self.client.get("/api/exceptions").json(), [])
        self.assertEqual(self.client.post("/api/detection/run").json()["created"], 2)
        with patch.dict(os.environ, {"INTELLIOPS_SIMULATION_TIME": "2026-11-03T03:01:01+00:00"}):
            self.assertEqual(self.client.post("/api/detection/run").json()["created"], 3)
            self.assertEqual(self.client.post("/api/detection/run").json()["created"], 0)
        cases = self.client.get("/api/exceptions").json()
        self.assertEqual({c["exceptionType"] for c in cases}, {"Duplicate Transaction", "Payment Processing Failure", "Missing Ledger Posting", "Amount Mismatch", "Unmatched Transaction"})
        self.assertTrue(all(c["status"] == "OPEN" and c["evidence"]["observedAt"] for c in cases))
        self.assertEqual(self.balance(), Decimal("44299.99"))
        # Duplicate posts only the original; failure/missing never post; mismatch posts 99.99.
        with Session(self.engine) as db:
            self.assertEqual(db.scalar(select(func.count()).select_from(LedgerJournal)), 5)
        missing = self.client.get(f"/api/payments/{results['MISSING_LEDGER']['id']}/related").json()
        self.assertEqual(missing["journals"], [])
        self.assertEqual(len(missing["exceptions"]), 1)

    def test_authentication_and_admin_injection_policy(self):
        app.dependency_overrides.pop(actor)
        with patch.dict(os.environ, {"INTELLIOPS_ADMIN_TOKEN": "test-admin-secret", "INTELLIOPS_ANALYST_TOKEN": "test-analyst-secret"}):
            self.assertEqual(self.client.get("/api/payments").status_code, 401)
            analyst = {"Authorization": "Bearer test-analyst-secret"}
            admin = {"Authorization": "Bearer test-admin-secret"}
            self.assertEqual(self.client.get("/api/payments", headers=analyst).status_code, 200)
            self.assertEqual(self.client.post("/api/payments", headers=analyst, json=self.request()).status_code, 201)
            payload = {**self.request(idempotency_key="admin-fault-test"), "scenario_code": "MISSING_LEDGER"}
            self.assertEqual(self.client.post("/api/demo/payments/scenario", headers=analyst, json=payload).status_code, 403)
            self.assertEqual(self.client.post("/api/demo/payments/scenario", headers=admin, json=payload).status_code, 201)
            self.assertEqual(self.client.get("/api/banking-snapshot").status_code, 401)

    def test_disabled_existing_detection_rule_is_respected(self):
        self.post("PROCESSING_FAILURE")
        with Session(self.engine) as db, db.begin():
            db.add(DetectionRule(name="processor-failure", exception_type="Payment Processing Failure", enabled=False))
        self.assertEqual(self.client.post("/api/detection/run").json()["created"], 0)
        with Session(self.engine) as db, db.begin():
            db.scalar(select(DetectionRule)).enabled = True
        self.assertEqual(self.client.post("/api/detection/run").json()["created"], 1)
        with Session(self.engine) as db:
            self.assertIsNotNone(db.scalar(select(ExceptionCase)).rule_id)


if __name__ == "__main__":
    unittest.main()
