"""All mutations below use the existing isolated SQLite fixtures, never DATABASE_URL."""
import os
os.environ["DATABASE_URL"] = "sqlite:///:memory:"

import unittest
from unittest.mock import patch
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from types import SimpleNamespace
from sqlalchemy import select, func, text, inspect
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from alembic import command
from alembic.config import Config
from pathlib import Path
import test_accounts
import test_payments
from modules.core_banking.models import Account, LedgerJournal, LedgerEntry, LedgerRecord
from modules.core_banking.service import assess_journal
from modules.core_banking.seed import demo_id
from modules.payment_processing.models import Transaction, PaymentInstruction, ProcessingEvent
from modules.intelliops.models import DetectionRule, ExceptionCase, AuditEvent
from modules.intelliops.detection import detect, insert_case
from modules.intelliops.automatic_detection import run_after_commit
from modules.intelliops.overdue_detection import scan_overdue
from modules.intelliops.models import ExceptionCaseAction
from modules.intelliops.severity_backfill import apply_severity_backfill, plan_severity_backfill

NOW = datetime(2026, 11, 3, 3, tzinfo=timezone.utc)


class DetectionTests(unittest.TestCase):
    setUpDatabase = test_accounts.AccountTests.setUp
    tearDownDatabase = test_accounts.AccountTests.tearDown
    setUp = test_payments.PaymentTests.setUp
    tearDown = test_payments.PaymentTests.tearDown
    request = test_payments.PaymentTests.request
    post = test_payments.PaymentTests.post

    def scan(self, seconds=61):
        with Session(self.engine) as db, db.begin():
            return detect(db, "ADMIN", NOW + timedelta(seconds=seconds))

    def tx(self, db, payment):
        return db.scalar(select(Transaction).where(Transaction.reference == payment["id"]))

    def cases(self, payment):
        return [c for c in self.client.get("/api/exceptions").json() if c["transactionId"] == payment["id"]]

    def rule(self, code, **values):
        with Session(self.engine) as db, db.begin():
            rule = db.scalar(select(DetectionRule).where(DetectionRule.code == code))
            for name, value in values.items():
                setattr(rule, name, value)

    def test_automatic_duplicate_case_survives_manual_scan_and_replay(self):
        with patch.dict(os.environ, {"INTELLIOPS_AUTOMATIC_DETECTION": "true"}):
            payment = self.post("DUPLICATE")
            case = self.cases(payment)[0]
            self.assertEqual(case["severity"], "LOW")
            self.assertEqual(case["status"], "OPEN")
            self.assertEqual(datetime.fromisoformat(case["createdAt"]), NOW)
            self.assertEqual(self.post("DUPLICATE")["id"], payment["id"])
            run_after_commit(self.engine, [payment["id"]])
            self.assertEqual(self.scan(), [])
            self.assertEqual(self.cases(payment), [case])
            status = self.client.get("/api/detection/status").json()
            self.assertEqual(status["state"], "ENABLED")
            self.assertIsNotNone(status["lastSuccessfulScan"])
        with Session(self.engine) as db:
            events = db.scalars(select(AuditEvent).where(AuditEvent.action == "EXCEPTION_DETECTED")).all()
            self.assertEqual(len(events), 1)
            self.assertEqual(db.scalar(select(func.count()).select_from(AuditEvent)
                                       .where(AuditEvent.action == "AUTOMATIC_DETECTION_SUCCEEDED")), 1)

    def test_post_commit_failure_does_not_undo_financial_records(self):
        with patch.dict(os.environ, {"INTELLIOPS_AUTOMATIC_DETECTION": "true"}):
            with patch("modules.intelliops.automatic_detection.detect", side_effect=RuntimeError):
                payment = self.post("DUPLICATE")
            self.assertEqual(self.client.get("/api/detection/status").json()["state"], "DEGRADED")
        self.assertEqual(self.cases(payment), [])
        with Session(self.engine) as db:
            self.assertIsNotNone(self.tx(db, payment))
            self.assertIsNotNone(db.scalar(select(AuditEvent).where(AuditEvent.action == "AUTOMATIC_DETECTION_FAILED")))
            journals_before = db.scalar(select(func.count()).select_from(LedgerJournal))
        self.assertEqual(len(self.scan()), 1)
        with Session(self.engine) as db:
            self.assertEqual(db.scalar(select(func.count()).select_from(LedgerJournal)), journals_before)

    def test_post_commit_scan_respects_missing_ledger_cutoff(self):
        with patch.dict(os.environ, {"INTELLIOPS_AUTOMATIC_DETECTION": "true"}):
            payment = self.post("MISSING_LEDGER")
            self.assertEqual(self.cases(payment), [])
            self.assertEqual(scan_overdue(self.engine, NOW + timedelta(seconds=59)), [])
            self.assertEqual(len(scan_overdue(self.engine, NOW + timedelta(seconds=61))), 1)
            self.assertEqual(scan_overdue(self.engine, NOW + timedelta(seconds=62)), [])
        self.assertEqual(datetime.fromisoformat(self.cases(payment)[0]["createdAt"]), NOW + timedelta(seconds=61))

    def test_default_rule_identity_all_five_and_read_api_contract(self):
        payments = {s: self.post(s, amount=str(100 + index), idempotency_key=f"detection-{s}") for index, s in enumerate(
                    ["DUPLICATE", "PROCESSING_FAILURE", "MISSING_LEDGER", "AMOUNT_MISMATCH", "UNMATCHED"])}
        self.assertEqual(len(self.scan()), 5)
        for p in payments.values():
            c = self.cases(p)[0]
            self.assertIn("ruleCode", c["evidence"])
            self.assertEqual(c["evidence"]["ruleVersion"], 1)
        with Session(self.engine) as db:
            self.assertEqual(db.scalar(select(func.count()).select_from(DetectionRule)), 9)
            self.assertTrue(all(c.rule_id for c in db.scalars(select(ExceptionCase))))
        snapshot = self.client.get("/api/banking-snapshot")
        self.assertEqual(snapshot.status_code, 200)
        self.assertEqual(len(snapshot.json()["exception_cases"]), 5)

    def test_severity_backfill_preserves_case_and_financial_sources(self):
        payment = self.post("PROCESSING_FAILURE")
        case_id = self.scan()[0]
        now = NOW + timedelta(seconds=61)
        with Session(self.engine) as db, db.begin():
            db.get(ExceptionCase, case_id).severity = "HIGH"
        with Session(self.engine) as db, db.begin():
            case = db.get(ExceptionCase, case_id)
            original = (case.id, case.status, case.updated_at, case.evidence)
            tx = self.tx(db, payment)
            payment_state = (tx.id, tx.status, tx.amount)
            assessments, blocked = plan_severity_backfill(db, now)
            self.assertEqual(blocked, [])
            self.assertEqual(case.severity, "HIGH")
            self.assertFalse(db.new or db.dirty)
            self.assertEqual(apply_severity_backfill(db, assessments, now, "TEST"), 1)
            self.assertEqual(case.severity, "LOW")
            self.assertEqual((case.id, case.status, case.updated_at, case.evidence), original)
            self.assertEqual((tx.id, tx.status, tx.amount), payment_state)
            event = db.scalar(select(ExceptionCaseAction).where(ExceptionCaseAction.action_type == "SEVERITY_RECALCULATED"))
            self.assertEqual(event.details["severityAssessment"]["reasonCode"], "FAILURE_SAFELY_CONTAINED")
            self.assertEqual(apply_severity_backfill(db, assessments, now, "TEST"), 0)
        self.assertEqual(self.cases(payment)[0]["severity"], "LOW")

    def test_invalid_draft_reversed_unbalanced_missing_entries_and_timestamp(self):
        for number, fault in enumerate(["Draft", "Reversed", "unbalanced", "missing", "timestamp", "unposted"], 1):
            with self.subTest(fault=fault):
                p = self.post(amount=str(100 + number), idempotency_key=f"invalid-journal-{number}")
                with Session(self.engine) as db, db.begin():
                    tx = self.tx(db, p)
                    j = db.scalar(select(LedgerJournal).where(LedgerJournal.source_transaction_id == tx.id))
                    entries = db.scalars(select(LedgerEntry).where(LedgerEntry.journal_id == j.journal_id)).all()
                    if fault in ("Draft", "Reversed"):
                        j.status = fault
                    elif fault == "unbalanced":
                        entries[0].amount += 1
                    elif fault == "missing":
                        db.delete(entries[0])
                    elif fault == "timestamp":
                        j.posted_at = None
                    else:
                        entries[0].posted = False
                self.scan()
                cases = self.cases(p)
                self.assertEqual([c["exceptionType"] for c in cases], ["Invalid Ledger Posting"])
                self.assertEqual(cases[0]["evidence"]["classification"], "INVALID_OR_INCOMPLETE_POSTING")

    def test_wrong_payment_currency_and_account_relationships(self):
        p = self.post()
        with Session(self.engine) as db, db.begin():
            self.tx(db, p).currency = "USD"
        self.scan()
        self.assertEqual([c["exceptionType"] for c in self.cases(p)], ["Ledger Currency Mismatch"])
        p2 = self.post(idempotency_key="wrong-account-0001")
        with Session(self.engine) as db, db.begin():
            tx = self.tx(db, p2)
            j = db.scalar(select(LedgerJournal).where(LedgerJournal.source_transaction_id == tx.id))
            e = db.scalar(select(LedgerEntry).where(LedgerEntry.journal_id == j.journal_id, LedgerEntry.side == "Credit"))
            e.account_id = demo_id("ACC-100002")
        self.scan()
        self.assertEqual([c["exceptionType"] for c in self.cases(p2)], ["Ledger Account Mismatch"])

    def test_internal_entry_currency_conflict_is_explicit(self):
        p = self.post()
        with Session(self.engine) as db, db.begin():
            tx = self.tx(db, p)
            j = db.scalar(select(LedgerJournal).where(LedgerJournal.source_transaction_id == tx.id))
            db.scalar(select(LedgerEntry).where(LedgerEntry.journal_id == j.journal_id)).currency = "USD"
        self.scan()
        self.assertEqual({c["exceptionType"] for c in self.cases(p)}, {"Invalid Ledger Posting", "Ledger Currency Mismatch"})

    def test_invalid_sides_and_negative_amounts_without_bypassing_database_constraints(self):
        account = SimpleNamespace(currency="SGD")
        j = SimpleNamespace(status="Posted", posted_at=NOW, currency="SGD")
        entries = [SimpleNamespace(side="Other", posted=True, amount=Decimal(1), account_id=1, currency="SGD"),
                   SimpleNamespace(side="Credit", posted=True, amount=Decimal(-1), account_id=1, currency="SGD")]
        assessment = assess_journal(j, entries, {1: account})
        self.assertFalse(assessment["valid"])
        self.assertIn("INVALID_ENTRY", assessment["reasons"])

    def test_cutoff_equality_and_missing_posting(self):
        p = self.post("MISSING_LEDGER")
        self.assertEqual(self.scan(59), [])
        self.assertEqual(len(self.scan(60)), 1)
        self.assertEqual(self.cases(p)[0]["exceptionType"], "Missing Ledger Posting")

    def test_configured_cutoff_and_tolerance_thresholds(self):
        self.scan(0)
        self.rule("MISSING_LEDGER_POSTING", threshold=120)
        p = self.post("MISSING_LEDGER")
        self.assertEqual(self.scan(119), [])
        self.assertEqual(len(self.scan(120)), 1)
        self.assertEqual(self.cases(p)[0]["evidence"]["ruleConfiguration"]["reconciliation_seconds"], 120)
        self.rule("AMOUNT_MISMATCH", threshold=1)
        mismatch = self.post("AMOUNT_MISMATCH", amount="101", idempotency_key="tolerance-check-0001")
        self.scan()
        self.assertEqual(self.cases(mismatch), [])
        self.rule("AMOUNT_MISMATCH", threshold=0)
        self.scan()
        self.assertEqual(self.cases(mismatch)[0]["exceptionType"], "Amount Mismatch")

    def test_disabled_rule_legacy_severity_and_invalid_configuration(self):
        self.scan(0)
        self.rule("PAYMENT_PROCESSING_FAILURE", enabled=False)
        p = self.post("PROCESSING_FAILURE")
        self.assertEqual(self.scan(), [])
        self.rule("PAYMENT_PROCESSING_FAILURE", enabled=True, severity="CRITICAL", version=2)
        self.scan()
        case = self.cases(p)[0]
        self.assertEqual(case["severity"], "LOW")
        self.assertEqual(case["evidence"]["severityAssessment"]["reasonCode"], "FAILURE_SAFELY_CONTAINED")
        self.rule("PROCESSING_TIMEOUT", configuration={"inactivity_seconds": -1})
        response = self.client.post("/api/detection/run")
        self.assertEqual(response.status_code, 422)

    def test_conflicting_configuration_rejected_by_constraints(self):
        self.scan(0)
        with self.assertRaises(IntegrityError), Session(self.engine) as db, db.begin():
            db.add(DetectionRule(name="other-name", exception_type="Amount Mismatch", enabled=False))
        with self.assertRaises(IntegrityError), Session(self.engine) as db, db.begin():
            db.add(DetectionRule(name="other-name", exception_type="Other", code="AMOUNT_MISMATCH"))
        self.rule("AMOUNT_MISMATCH", threshold=1, configuration={"amount_tolerance_cents": 2})
        self.assertEqual(self.client.post("/api/detection/run").status_code, 422)

    def test_duplicate_held_one_posting_and_no_timeout(self):
        p = self.post("DUPLICATE")
        self.scan(3600)
        cases = self.cases(p)
        self.assertEqual(len(cases), 1)
        e = cases[0]["evidence"]
        self.assertEqual(e["classification"], "SUSPECTED_DUPLICATE")
        self.assertEqual(e["financialAssessment"], "SINGLE_POSTING_CONFIRMED_DUPLICATE_HELD")
        self.assertEqual(e["rootCause"], "NOT_ESTABLISHED")

    def add_posting(self, db, tx, reference="JRN-RECOVERY"):
        i = db.scalar(select(PaymentInstruction).where(PaymentInstruction.transaction_id == tx.id))
        j = LedgerJournal(journal_ref=reference, source_transaction_id=tx.id, payment_reference=tx.reference,
                          currency=tx.currency, status="Posted", posted_at=NOW)
        db.add(j)
        db.flush()
        for side, account in [("Debit", i.sender_account_id), ("Credit", i.receiver_account_id)]:
            db.add(LedgerEntry(entry_ref=reference + side, journal_id=j.journal_id, account_id=account,
                              side=side, amount=tx.amount, currency=tx.currency, description="Isolated test posting", posted=True))

    def test_duplicate_two_postings_and_containment_is_blocked(self):
        p = self.post("DUPLICATE")
        with Session(self.engine) as db, db.begin():
            tx = self.tx(db, p)
            tx.status = "COMPLETED"
            self.add_posting(db, tx)
        self.scan()
        case = self.cases(p)[0]
        self.assertEqual(case["evidence"]["financialAssessment"], "TWO_POSTINGS_CONFIRMED")
        response = self.client.post(f"/api/exceptions/{case['id']}/remediate", json={"idempotency_key": "unsafe-duplicate-0001"})
        self.assertEqual(response.status_code, 409)

    def test_legitimate_repeats_and_uncertain_reference_collision(self):
        p = self.post()
        other = self.post(idempotency_key="legitimate-repeat-0001")
        self.assertEqual(len(self.scan()), 1)
        with Session(self.engine) as db, db.begin():
            self.tx(db, other).payment_reference = self.tx(db, p).payment_reference
        self.scan()
        evidence = self.cases(other)[0]["evidence"]
        self.assertEqual(evidence["classification"], "SUSPECTED_DUPLICATE")
        self.assertEqual(evidence["rootCause"], "NOT_ESTABLISHED")

    def test_explicit_original_link_with_different_business_reference(self):
        p = self.post("DUPLICATE")
        with Session(self.engine) as db, db.begin():
            self.tx(db, p).payment_reference = "CHANGED-REFERENCE"
        self.scan()
        self.assertEqual(self.cases(p)[0]["evidence"]["classification"], "SUSPECTED_DUPLICATE")

    def test_failed_original_cannot_confirm_duplicate_intent(self):
        p = self.post("DUPLICATE")
        with Session(self.engine) as db, db.begin():
            i = db.scalar(select(PaymentInstruction).where(PaymentInstruction.transaction_id == self.tx(db, p).id))
            original = db.get(PaymentInstruction, i.original_payment_id)
            db.get(Transaction, original.transaction_id).status = "FAILED"
        self.scan()
        self.assertEqual(self.cases(p)[0]["evidence"]["classification"], "SUSPECTED_DUPLICATE")

    def pending(self, status="PENDING"):
        p = self.post("PROCESSING_FAILURE")
        with Session(self.engine) as db, db.begin():
            self.tx(db, p).status = status
        return p

    def test_pending_and_processing_timeout_boundaries(self):
        for status in ["PENDING", "PROCESSING"]:
            with self.subTest(status=status):
                # Separate payment keys; no financial source record is recreated.
                p = self.post("PROCESSING_FAILURE", idempotency_key=f"timeout-{status}")
                with Session(self.engine) as db, db.begin(): self.tx(db, p).status = status
                self.scan(299)
                self.assertEqual(self.cases(p), [])
                self.scan(300)
                self.assertEqual(self.cases(p)[0]["exceptionType"], "Processing Timeout")

    def test_last_activity_retry_and_waiting_policy(self):
        p = self.pending()
        with Session(self.engine) as db, db.begin():
            db.add(ProcessingEvent(transaction_id=self.tx(db, p).id, event_type="RETRY_SUBMITTED", status="PENDING",
                                   details="Observed retry", created_at=NOW + timedelta(seconds=200)))
        self.assertEqual(self.scan(300), [])
        self.scan(500)
        self.assertEqual(self.cases(p)[0]["evidence"]["retryAttemptsObserved"], 1)

    def test_external_wait_has_bounded_maximum_age(self):
        p = self.pending()
        with Session(self.engine) as db, db.begin():
            db.add(ProcessingEvent(transaction_id=self.tx(db, p).id, event_type="WAITING_FOR_EXTERNAL_SYSTEM",
                                   status="PENDING", details="Explicit source wait", created_at=NOW))
        self.assertEqual(self.scan(300), [])
        self.assertEqual(len(self.scan(1800)), 1)

    def test_timeout_threshold_override(self):
        self.scan(0)
        self.rule("PROCESSING_TIMEOUT", threshold=20)
        p = self.pending()
        self.assertEqual(self.scan(19), [])
        self.scan(20)
        self.assertEqual(self.cases(p)[0]["exceptionType"], "Processing Timeout")

    def test_repeated_scan_preserves_evidence_and_source_records(self):
        p = self.post("MISSING_LEDGER")
        self.scan()
        before = self.client.get(f"/api/exceptions/{self.cases(p)[0]['id']}").json()
        with Session(self.engine) as db:
            financial = (db.scalar(select(func.count()).select_from(LedgerJournal)), db.scalar(select(func.count()).select_from(LedgerEntry)))
        self.assertEqual(self.scan(90), [])
        after = self.client.get(f"/api/exceptions/{before['id']}").json()
        self.assertEqual(before, after)
        with Session(self.engine) as db:
            self.assertEqual(financial, (db.scalar(select(func.count()).select_from(LedgerJournal)), db.scalar(select(func.count()).select_from(LedgerEntry))))
            self.assertEqual(db.scalar(select(func.count()).select_from(AuditEvent).where(AuditEvent.action == "DETECTION_RUN")), 2)

    def test_recurrence_requires_observed_recovery_not_unchanged_or_changed_bad_evidence(self):
        p = self.post("MISSING_LEDGER")
        self.scan()
        first = self.cases(p)[0]
        with Session(self.engine) as db, db.begin():
            c = db.get(ExceptionCase, int(first["id"].split('-')[1]))
            c.status, c.resolved_at = "CLOSED", NOW + timedelta(seconds=61)
        self.assertEqual(self.scan(62), [])
        with Session(self.engine) as db, db.begin(): self.add_posting(db, self.tx(db, p))
        self.assertEqual(self.scan(70), [])
        with Session(self.engine) as db, db.begin():
            j = db.scalar(select(LedgerJournal).where(LedgerJournal.journal_ref == "JRN-RECOVERY"))
            for e in db.scalars(select(LedgerEntry).where(LedgerEntry.journal_id == j.journal_id)): db.delete(e)
            db.flush()
            db.delete(j)
        self.assertEqual(len(self.scan(80)), 1)
        cases = self.cases(p)
        self.assertEqual(cases[0]["evidence"]["recurrenceOf"], first["id"])
        self.assertEqual(cases[1]["evidence"], first["evidence"])
        self.assertEqual(self.scan(90), [])

    def test_historical_case_null_rule_and_key_remains_readable(self):
        p = self.post("DUPLICATE")
        with Session(self.engine) as db, db.begin():
            tx = self.tx(db, p)
            db.add(ExceptionCase(id=4, transaction_id=tx.id, exception_type="Duplicate Transaction", severity="HIGH",
                                 status="OPEN", evidence={"originalReference": "historical-preserved"}, created_at=NOW))
        self.scan()
        response = self.client.get("/api/exceptions/CASE-000004")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["evidence"], {"originalReference": "historical-preserved"})
        self.assertEqual(len(self.cases(p)), 1)

    def test_legacy_ledger_and_mixed_representation(self):
        with Session(self.engine) as db, db.begin():
            tx = Transaction(reference="LEGACY-DETECTION", payment_reference="LEGACY-BUSINESS", amount=100,
                             currency="SGD", status="COMPLETED", created_at=NOW)
            db.add(tx); db.flush()
            db.add(LedgerRecord(transaction_id=tx.id, amount=99, currency="SGD", entry_type="CREDIT", created_at=NOW))
        self.scan()
        case = self.client.get("/api/exceptions").json()[0]
        self.assertEqual(case["exceptionType"], "Amount Mismatch")
        self.assertEqual(case["evidence"]["representation"], "LEGACY")
        p = self.post()
        with Session(self.engine) as db, db.begin():
            db.add(LedgerRecord(transaction_id=self.tx(db, p).id, amount=100, currency="SGD", entry_type="CREDIT", created_at=NOW))
        self.scan()
        self.assertEqual(self.cases(p)[0]["exceptionType"], "Invalid Ledger Posting")

    def test_unique_conflict_savepoint_preserves_outer_transaction(self):
        p = self.post("MISSING_LEDGER")
        self.scan()
        with Session(self.engine) as db, db.begin():
            old = db.scalar(select(ExceptionCase))
            duplicate = ExceptionCase(transaction_id=old.transaction_id, rule_id=old.rule_id,
                exception_type=old.exception_type, severity="HIGH", status="OPEN", detection_key=old.detection_key,
                evidence={}, created_at=NOW, updated_at=NOW)
            self.assertFalse(insert_case(db, duplicate))
            db.add(AuditEvent(action="TEST_SAVEPOINT_SURVIVED", actor="TEST", reference=p['id'], details={}))
        with Session(self.engine) as db:
            self.assertEqual(db.scalar(select(func.count()).select_from(ExceptionCase)), 1)
            self.assertIsNotNone(db.scalar(select(AuditEvent).where(AuditEvent.action == "TEST_SAVEPOINT_SURVIVED")))

    def test_config_changes_and_clock_rewind_do_not_prove_recurrence(self):
        p = self.post("AMOUNT_MISMATCH")
        self.scan()
        with Session(self.engine) as db, db.begin():
            case = db.scalar(select(ExceptionCase))
            case.status = "CLOSED"
        self.rule("AMOUNT_MISMATCH", threshold=1)
        self.scan(70)  # Tolerance changed, source did not recover.
        self.rule("AMOUNT_MISMATCH", threshold=0)
        self.assertEqual(self.scan(80), [])
        self.scan(0)  # Rewinding the clock must not establish recovery either.
        self.assertEqual(self.scan(90), [])
        with Session(self.engine) as db, db.begin(): self.tx(db, p).status = "PROCESSING"
        self.scan(91)  # Ineligibility does not establish a healthy ledger.
        with Session(self.engine) as db, db.begin(): self.tx(db, p).status = "COMPLETED"
        self.assertEqual(self.scan(92), [])
        self.assertEqual(len(self.cases(p)), 1)

    def test_correctly_linked_journal_with_conflicting_source_id(self):
        p = self.post()
        with Session(self.engine) as db, db.begin():
            tx = self.tx(db, p)
            j = db.scalar(select(LedgerJournal).where(LedgerJournal.source_transaction_id == tx.id))
            j.source_transaction_id = db.scalar(select(Transaction.id).where(Transaction.reference == "TXN-1001"))
        self.scan()
        self.assertIn("Unmatched Transaction", {c["exceptionType"] for c in self.cases(p)})

    def test_wrong_journal_currency_is_explicit_even_when_internally_balanced(self):
        p = self.post()
        with Session(self.engine) as db, db.begin():
            tx = self.tx(db, p)
            j = db.scalar(select(LedgerJournal).where(LedgerJournal.source_transaction_id == tx.id))
            j.currency = "USD"
            for entry in db.scalars(select(LedgerEntry).where(LedgerEntry.journal_id == j.journal_id)):
                entry.currency = "USD"
                entry.account_id = demo_id("ACC-100004" if entry.side == "Debit" else "ACC-100007")
        self.scan()
        self.assertEqual({c["exceptionType"] for c in self.cases(p)}, {"Ledger Currency Mismatch", "Ledger Account Mismatch"})

    def test_stale_amount_case_cannot_adjust_wrong_accounts(self):
        p = self.post("AMOUNT_MISMATCH")
        self.scan()
        case = self.cases(p)[0]
        with Session(self.engine) as db, db.begin():
            tx = self.tx(db, p)
            j = db.scalar(select(LedgerJournal).where(LedgerJournal.source_transaction_id == tx.id))
            e = db.scalar(select(LedgerEntry).where(LedgerEntry.journal_id == j.journal_id, LedgerEntry.side == "Credit"))
            e.account_id = demo_id("ACC-100002")
        response = self.client.post(f"/api/exceptions/{case['id']}/remediate", json={"idempotency_key": "wrong-party-stop-0001"})
        self.assertEqual(response.status_code, 409)

    def test_legacy_terminal_without_cursor_and_changed_bad_evidence_stays_closed(self):
        p = self.post("MISSING_LEDGER")
        with Session(self.engine) as db, db.begin():
            tx = self.tx(db, p)
            db.add(ExceptionCase(transaction_id=tx.id, exception_type="Missing Ledger Posting", severity="HIGH",
                                 status="CLOSED", detection_key=f"{tx.id}:Missing Ledger Posting", evidence={"old": True}, created_at=NOW))
        self.assertEqual(self.scan(), [])
        with Session(self.engine) as db, db.begin(): self.tx(db, p).amount += 10
        self.assertEqual(self.scan(100), [])
        self.assertEqual(self.cases(p)[0]["evidence"], {"old": True})

    def test_disabled_scan_is_not_a_recovery_observation(self):
        p = self.post("MISSING_LEDGER")
        self.scan()
        with Session(self.engine) as db, db.begin(): db.scalar(select(ExceptionCase)).status = "CLOSED"
        self.rule("MISSING_LEDGER_POSTING", enabled=False)
        self.scan(70)
        self.rule("MISSING_LEDGER_POSTING", enabled=True)
        self.assertEqual(self.scan(80), [])
        self.assertEqual(len(self.cases(p)), 1)


class DetectionMigrationTests(unittest.TestCase):
    def upgrade(self, engine, target):
        cfg = Config(str(Path(__file__).resolve().parents[1] / "alembic.ini"))
        with engine.begin() as connection:
            cfg.attributes["connection"] = connection
            command.upgrade(cfg, target)

    def test_additive_migration_preserves_legacy_configuration_and_cases(self):
        engine = test_accounts.database()
        try:
            self.upgrade(engine, "20261103_06")
            with engine.begin() as conn:
                conn.execute(text("INSERT INTO detection_rules (id,name,exception_type,enabled) VALUES (42,'existing-name','Payment Processing Failure',false)"))
                conn.execute(text("INSERT INTO transactions (id,reference,payment_reference,amount,currency,status,created_at) VALUES (1,'OLD','OLD',1,'SGD','FAILED',CURRENT_TIMESTAMP)"))
                conn.execute(text("INSERT INTO exceptions (id,transaction_id,exception_type,severity,status,created_at,updated_at,evidence) VALUES (4,1,'Payment Processing Failure','HIGH','OPEN',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,'{}')"))
            self.upgrade(engine, "head")
            with engine.connect() as conn:
                row = conn.execute(text("SELECT id,name,enabled,code FROM detection_rules WHERE id=42")).one()
                self.assertEqual(tuple(row), (42, "existing-name", 0, "PAYMENT_PROCESSING_FAILURE"))
                self.assertEqual(conn.execute(text("SELECT rule_id FROM exceptions WHERE id=4")).scalar(), None)
                self.assertEqual(conn.execute(text("SELECT COUNT(*) FROM detection_rules")).scalar(), 9)
                self.assertIn("detection_observations", inspect(conn).get_table_names())
        finally: engine.dispose()

    def test_migration_rejects_ambiguous_legacy_threshold_before_schema_change(self):
        engine = test_accounts.database()
        try:
            self.upgrade(engine, "20261103_06")
            with engine.begin() as conn:
                conn.execute(text("INSERT INTO detection_rules (name,exception_type,threshold,enabled) VALUES ('old','Amount Mismatch',9,true)"))
            with self.assertRaisesRegex(RuntimeError, "previously ignored"):
                self.upgrade(engine, "head")
            self.assertNotIn("code", {c['name'] for c in inspect(engine).get_columns("detection_rules")})
        finally: engine.dispose()

    def test_migration_rejects_duplicate_legacy_types_before_schema_change(self):
        engine = test_accounts.database()
        try:
            self.upgrade(engine, "20261103_06")
            with engine.begin() as conn:
                conn.execute(text("INSERT INTO detection_rules (name,exception_type,enabled) VALUES ('first','Amount Mismatch',true),('second','Amount Mismatch',false)"))
            with self.assertRaisesRegex(RuntimeError, "Duplicate"):
                self.upgrade(engine, "head")
            self.assertNotIn("code", {c['name'] for c in inspect(engine).get_columns("detection_rules")})
        finally: engine.dispose()


if __name__ == "__main__":
    unittest.main()
