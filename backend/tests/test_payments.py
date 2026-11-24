import os
import unittest
from unittest.mock import patch
from decimal import Decimal
from sqlalchemy import select, func
from sqlalchemy.orm import Session
from main import app
from shared.security import actor
from modules.payment_processing.models import Transaction, ProcessingEvent, PaymentInstruction, ExceptionBatch, ExceptionBatchItem
from modules.core_banking.models import LedgerEntry, LedgerJournal
from modules.core_banking.seed import demo_id
from modules.intelliops.models import ExceptionCase, ExceptionCaseAction, ExceptionResolution, LedgerPostingRemediation, AuditEvent, DetectionRule
import test_accounts


class PaymentTests(unittest.TestCase):
    setUpDatabase = test_accounts.AccountTests.setUp
    tearDownDatabase = test_accounts.AccountTests.tearDown

    def setUp(self):
        self.setUpDatabase()
        app.dependency_overrides[actor] = lambda: "ANALYST"
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

    def test_normal_transfer_balances_history_and_journal_api(self):
        sender = "ACC-100003"
        receiver = "ACC-100002"
        before_sender, before_receiver = self.balance(sender), self.balance(receiver)
        openings = {ref: self.client.get(f"/api/accounts/{demo_id(ref)}").json()["balance"]["opening_balance"]
                    for ref in [sender, receiver]}
        payment = self.post(receiver_account_ref=receiver, amount="5000.00")
        self.assertEqual(self.balance(sender), before_sender - Decimal("5000"))
        self.assertEqual(self.balance(receiver), before_receiver + Decimal("5000"))
        related = self.client.get(f"/api/payments/{payment['id']}/related").json()["journals"]
        self.assertEqual(len(related), 1)
        response = self.client.get(f"/api/ledger/journals/{related[0]['id']}")
        self.assertEqual(response.status_code, 200, response.text)
        journal = response.json()
        self.assertEqual(journal["payment_reference"], payment["id"])
        self.assertTrue(journal["payment_available"])
        self.assertEqual(journal["status"], "Posted")
        self.assertEqual(len(journal["entries"]), 2)
        self.assertEqual(Decimal(journal["total_debit"]), Decimal("5000"))
        self.assertEqual(journal["total_debit"], journal["total_credit"])
        self.assertEqual(self.client.get(f"/api/ledger/journals/{journal['journal_id']}").json(), journal)
        for ref, side in [(sender, "Debit"), (receiver, "Credit")]:
            detail = self.client.get(f"/api/accounts/{demo_id(ref)}").json()
            self.assertEqual(detail["balance"]["opening_balance"], openings[ref])
            entries = self.client.get(f"/api/accounts/{demo_id(ref)}/ledger-entries").json()
            matching = [e for e in entries if e["payment_reference"] == payment["id"]]
            self.assertEqual(len(matching), 1)
            self.assertEqual(matching[0]["side"], side)
        self.assertEqual(self.client.get("/api/ledger/journals/missing").status_code, 404)

    def test_posting_validation_failure_rolls_back_all_financial_changes(self):
        before = self.balance()
        with Session(self.engine) as db:
            instruction_count = db.scalar(select(func.count()).select_from(PaymentInstruction))
        with patch("modules.payment_processing.service.post_normal_journal", side_effect=ValueError("Unbalanced journal")):
            response = self.client.post("/api/payments", json=self.request())
        self.assertEqual(response.status_code, 422, response.text)
        self.assertEqual(self.balance(), before)
        with Session(self.engine) as db:
            self.assertEqual(db.scalar(select(func.count()).select_from(Transaction)), 2)
            self.assertEqual(db.scalar(select(func.count()).select_from(LedgerJournal)), 2)
            self.assertEqual(db.scalar(select(func.count()).select_from(PaymentInstruction)), instruction_count)
            outcome = db.scalar(select(AuditEvent).where(AuditEvent.action == "PAYMENT_POSTING_FAILED"))
            self.assertTrue(outcome.details["financialChangesRolledBack"])

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
        for index, code in enumerate(["DUPLICATE", "PROCESSING_FAILURE", "MISSING_LEDGER", "AMOUNT_MISMATCH", "UNMATCHED"]):
            results[code] = self.post(code, amount=str(100 + index), idempotency_key=f"scenario-{code}")
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
        self.assertEqual(self.balance(), Decimal("44306.99"))
        # Duplicate posts only the original; failure/missing never post; mismatch posts 99.99.
        with Session(self.engine) as db:
            self.assertEqual(db.scalar(select(func.count()).select_from(LedgerJournal)), 5)
        missing = self.client.get(f"/api/payments/{results['MISSING_LEDGER']['id']}/related").json()
        self.assertEqual(missing["journals"], [])
        self.assertEqual(len(missing["exceptions"]), 1)

    def test_authentication_and_analyst_injection_policy(self):
        app.dependency_overrides.pop(actor)
        with patch.dict(os.environ, {"INTELLIOPS_ADMIN_TOKEN": "test-admin-secret", "INTELLIOPS_ANALYST_TOKEN": "test-analyst-secret"}):
            self.assertEqual(self.client.get("/api/payments").status_code, 401)
            analyst = {"Authorization": "Bearer test-analyst-secret"}
            admin = {"Authorization": "Bearer test-admin-secret"}
            self.assertEqual(self.client.get("/api/payments", headers=analyst).status_code, 200)
            self.assertEqual(self.client.post("/api/payments", headers=analyst, json=self.request()).status_code, 201)
            payload = {**self.request(idempotency_key="analyst-fault-test"), "scenario_code": "MISSING_LEDGER"}
            self.assertEqual(self.client.post("/api/demo/payments/scenario", headers=analyst, json=payload).status_code, 201)
            self.assertEqual(self.client.post("/api/demo/payments/scenario", headers=admin,
                json={**payload, "idempotency_key": "admin-fault-test"}).status_code, 403)
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

    def test_missing_ledger_case_review_remediation_and_close_flow(self):
        payment = self.post("MISSING_LEDGER")
        with patch.dict(os.environ, {"INTELLIOPS_SIMULATION_TIME": "2026-11-03T03:01:01+00:00"}):
            detected = self.client.post("/api/detection/run").json()
            self.assertEqual(detected["created"], 1)
            case_id = detected["caseIds"][0]
            detail = self.client.get(f"/api/exceptions/{case_id}")
            self.assertEqual(detail.status_code, 200, detail.text)
            self.assertEqual(detail.json()["timeline"][0]["actionType"], "DETECTED")
            reviewed = self.client.post(f"/api/exceptions/{case_id}/notes", json={"note": "Payment source evidence verified."})
            self.assertEqual(reviewed.status_code, 200, reviewed.text)
            self.assertEqual(reviewed.json()["status"], "IN_PROGRESS")
            payload = {"idempotency_key": "missing-ledger-fix-0001", "note": "Approved against source instruction."}
            repaired = self.client.post(f"/api/exceptions/{case_id}/remediate", json=payload)
            self.assertEqual(repaired.status_code, 200, repaired.text)
            self.assertEqual(repaired.json()["status"], "RESOLVED")
            self.assertTrue(repaired.json()["remediation"]["journalReference"].startswith("JRN-REM-"))
            self.assertEqual([a["actionType"] for a in repaired.json()["timeline"]],
                             ["DETECTED", "NOTE_ADDED", "CASE_STATUS_CHANGED", "REMEDIATION_POSTED", "RESOLVED"])
            replay = self.client.post(f"/api/exceptions/{case_id}/remediate", json=payload)
            self.assertEqual(replay.status_code, 200, replay.text)
            self.assertEqual(replay.json()["remediation"]["journalReference"], repaired.json()["remediation"]["journalReference"])
            self.assertEqual(self.client.post(f"/api/exceptions/{case_id}/notes", json={"note": "too late"}).status_code, 409)
            closed = self.client.post(f"/api/exceptions/{case_id}/close", json={"note": "Control checks complete."})
            self.assertEqual(closed.status_code, 200, closed.text)
            self.assertEqual(closed.json()["status"], "CLOSED")
            self.assertEqual(self.client.post("/api/detection/run").json()["created"], 0)
        related = self.client.get(f"/api/payments/{payment['id']}/related").json()
        self.assertEqual(len(related["journals"]), 1)
        self.assertEqual(related["journals"][0]["debitTotal"], "100.00")
        self.assertEqual(related["journals"][0]["creditTotal"], "100.00")
        self.assertEqual(self.balance(), Decimal("44100"))
        events = self.client.get(f"/api/payments/{payment['id']}/events").json()
        self.assertEqual(events[-1]["eventType"], "LEDGER_REMEDIATED")
        with Session(self.engine) as db:
            self.assertEqual(db.scalar(select(func.count()).select_from(LedgerPostingRemediation)), 1)
            self.assertEqual(db.scalar(select(func.count()).select_from(ExceptionCaseAction)), 6)

    def test_missing_ledger_remediation_stops_when_a_late_journal_exists(self):
        payment = self.post("MISSING_LEDGER")
        with patch.dict(os.environ, {"INTELLIOPS_SIMULATION_TIME": "2026-11-03T03:01:01+00:00"}):
            case_id = self.client.post("/api/detection/run").json()["caseIds"][0]
            with Session(self.engine) as db, db.begin():
                tx = db.scalar(select(Transaction).where(Transaction.reference == payment["id"]))
                db.add(LedgerJournal(journal_ref="JRN-LATE", source_transaction_id=tx.id,
                                     payment_reference=tx.reference, currency=tx.currency,
                                     status="Draft", posted_at=None))
            response = self.client.post(f"/api/exceptions/{case_id}/remediate",
                                        json={"idempotency_key": "late-arrival-check-0001"})
            self.assertEqual(response.status_code, 409, response.text)
            with Session(self.engine) as db:
                self.assertEqual(db.scalar(select(func.count()).select_from(LedgerPostingRemediation)), 0)
                self.assertEqual(db.get(ExceptionCase, int(case_id.removeprefix("CASE-"))).status, "OPEN")

    def test_duplicate_mismatch_and_processing_failure_resolution_policies(self):
        payments = {code: self.post(code, amount=str(100 + index), idempotency_key=f"resolve-{code}")
                    for index, code in enumerate(["DUPLICATE", "PROCESSING_FAILURE", "AMOUNT_MISMATCH"])}
        self.assertEqual(self.client.post("/api/detection/run").json()["created"], 2)
        with patch.dict(os.environ, {"INTELLIOPS_SIMULATION_TIME": "2026-11-03T03:01:01+00:00"}):
            self.assertEqual(self.client.post("/api/detection/run").json()["created"], 1)
            cases = {case["exceptionType"]: case for case in self.client.get("/api/exceptions").json()}
            for number, kind in enumerate(["Duplicate Transaction", "Payment Processing Failure", "Amount Mismatch"], 1):
                response = self.client.post(f"/api/exceptions/{cases[kind]['id']}/remediate", json={
                    "idempotency_key": f"resolution-policy-{number:04d}", "note": "Approved test resolution."})
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(response.json()["status"], "RESOLVED")
                self.assertIsNotNone(response.json()["remediation"]["type"])
            self.assertEqual(self.client.post("/api/detection/run").json()["created"], 0)
        duplicate = self.client.get(f"/api/payments/{payments['DUPLICATE']['id']}").json()
        self.assertEqual(duplicate["status"], "Rejected")
        self.assertEqual(duplicate["failureCode"], "DUPLICATE_REJECTED")
        failure = self.client.get(f"/api/payments/{payments['PROCESSING_FAILURE']['id']}").json()
        self.assertEqual(failure["status"], "Completed")
        self.assertIsNone(failure["failureCode"])
        mismatch = self.client.get(f"/api/payments/{payments['AMOUNT_MISMATCH']['id']}/related").json()
        self.assertEqual(sum(Decimal(j["debitTotal"]) for j in mismatch["journals"]), Decimal("102.00"))
        self.assertEqual(sum(Decimal(j["creditTotal"]) for j in mismatch["journals"]), Decimal("102.00"))
        self.assertEqual(self.balance(), Decimal("44303.00"))
        with Session(self.engine) as db:
            self.assertEqual(db.scalar(select(func.count()).select_from(ExceptionResolution)), 3)

    def test_analyst_can_generate_selected_exception_batch_with_automatic_inputs(self):
        response = self.client.post("/api/demo/exception-batches", json={
            "exception_types": ["MISSING_LEDGER", "DUPLICATE", "PROCESSING_FAILURE"],
            "count_per_type": 2,
        })
        self.assertEqual(response.status_code, 201, response.text)
        data = response.json()
        self.assertEqual(data["created"], 8)
        self.assertEqual(len(data["transactionReferences"]), 8)
        self.assertEqual(set(data["exceptionTypes"]), {"MISSING_LEDGER", "DUPLICATE", "PROCESSING_FAILURE"})
        with Session(self.engine) as db:
            self.assertEqual(db.scalar(select(func.count()).select_from(ExceptionBatch)), 1)
            self.assertEqual(db.scalar(select(func.count()).select_from(ExceptionBatchItem)), 8)
            instructions = db.scalars(select(PaymentInstruction).where(
                PaymentInstruction.scenario_code.in_(["MISSING_LEDGER", "DUPLICATE", "PROCESSING_FAILURE"]))).all()
            self.assertEqual(sum(i.scenario_code == "MISSING_LEDGER" for i in instructions), 2)
            self.assertEqual(sum(i.scenario_code == "DUPLICATE" for i in instructions), 2)
            self.assertEqual(sum(i.scenario_code == "PROCESSING_FAILURE" for i in instructions), 2)
            self.assertTrue(all(i.idempotency_key.startswith("batch-") for i in instructions if i.scenario_code != "NORMAL"))
        duplicate = self.client.post("/api/demo/exception-batches", json={
            "exception_types": ["MISSING_LEDGER", "MISSING_LEDGER"], "count_per_type": 1})
        self.assertEqual(duplicate.status_code, 422)


if __name__ == "__main__":
    unittest.main()
