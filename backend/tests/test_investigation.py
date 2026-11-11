"""Isolated source fixtures and mocked provider HTTP; never connects to Supabase."""
import os
os.environ["DATABASE_URL"] = "sqlite:///:memory:"
import json
import unittest
from datetime import datetime, timezone, timedelta
from unittest.mock import patch
import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session
import test_accounts
import test_payments
import test_detection
from main import app
from shared.database import Base
from modules.payment_processing.models import Transaction, PaymentInstruction, ProcessingEvent
from modules.intelliops.models import ExceptionCase
from modules.intelliops.investigation_llm import InvestigationProvider, get_investigation_provider


class InvestigationTests(unittest.TestCase):
    setUpDatabase = test_accounts.AccountTests.setUp
    tearDownDatabase = test_accounts.AccountTests.tearDown
    setUp = test_payments.PaymentTests.setUp
    tearDown = test_payments.PaymentTests.tearDown
    request = test_payments.PaymentTests.request
    post = test_payments.PaymentTests.post
    add_posting = test_detection.DetectionTests.add_posting

    def fixture(self, scenario="historical"):
        duplicate = self.post("NORMAL" if scenario == "C" else "DUPLICATE")
        with Session(self.engine, expire_on_commit=False) as db, db.begin():
            b = db.scalar(select(Transaction).where(Transaction.reference == duplicate["id"]))
            bi = db.scalar(select(PaymentInstruction).where(PaymentInstruction.transaction_id == b.id))
            if scenario == "C":
                a = None
            else:
                ai = db.get(PaymentInstruction, bi.original_payment_id)
                a = db.get(Transaction, ai.transaction_id)
        if scenario == "C":
            original = self.post(idempotency_key="separate-authorized-0002")
            with Session(self.engine) as db:
                a = db.scalar(select(Transaction).where(Transaction.reference == original["id"]))
        with Session(self.engine) as db, db.begin():
            a, b = db.get(Transaction, a.id), db.get(Transaction, b.id)
            db.add(ExceptionCase(id=4, transaction_id=b.id, exception_type="Duplicate Transaction",
                                 severity="HIGH", status="OPEN", evidence={"originalReference": a.reference}))
            now = datetime(2026, 11, 3, 3, tzinfo=timezone.utc)
            def event(tx, kind, payload, seconds=0):
                db.add(ProcessingEvent(transaction_id=tx.id, event_type=kind, status="COMPLETED",
                    details=json.dumps(payload), created_at=now + timedelta(seconds=seconds)))
            if scenario == "A":
                for n, tx in enumerate((a, b)):
                    event(tx, "CLIENT_SUBMISSION", dict(origin="CUSTOMER", trigger="USER_SUBMIT",
                        intent_id="same-intent", submission_id=f"submission-{n}"), n)
            if scenario == "B":
                b.status = "COMPLETED"
                self.add_posting(db, b, "JRN-ISOLATED-RETRY")
                event(a, "ACK_TIMEOUT", dict(origin="SYSTEM", correlation_id="retry-1"))
                payload = dict(origin="SYSTEM", correlation_id="retry-1", original_payment_ref=a.reference)
                event(b, "RETRY_SUBMITTED", dict(**payload, trigger="AUTOMATIC_RETRY"), 1)
                event(b, "IDEMPOTENCY_CHECK_FAILED", payload, 2)
                event(b, "PROCESSING_STARTED", {}, 3)
                event(b, "PROCESSING_COMPLETED", {}, 4)
            if scenario == "C":
                for n, tx in enumerate((a, b)):
                    event(tx, "PAYMENT_AUTHORIZED", dict(authorized=True, authorization_id=f"auth-{n}", intent_id=f"intent-{n}"))
        return duplicate

    def fingerprint(self):
        with self.engine.connect() as connection:
            return {table.name: sorted(repr(tuple(row)) for row in connection.execute(select(table)))
                    for table in Base.metadata.sorted_tables}

    def provider(self, mutate=None, status=200, error=None):
        def handler(request):
            if error:
                raise error
            body = json.loads(request.content)
            self.assertEqual(str(request.url), "https://api.openai.com/v1/responses")
            self.assertFalse(body["store"])
            self.assertTrue(body["text"]["format"]["strict"])
            evidence = json.loads(body["input"])
            bounds = evidence["verified_assessment"]
            result = {k: bounds[k] for k in ("diagnosis_classification", "root_cause_code", "financial_classification", "recommended_action_code")}
            result.update(facts=[dict(statement="Source records support the bounded assessment.",
                evidence_refs=bounds["required_cause_references"] or evidence["evidence_references"][:1])],
                hypotheses=[], uncertainty=["Further evidence may change the assessment."],
                recommendation_reason="Human review of the cited source records is required.")
            if mutate:
                mutate(result)
            return httpx.Response(status, json=dict(status="completed", output=[dict(type="message",
                content=[dict(type="output_text", text=json.dumps(result))])]))
        app.dependency_overrides[get_investigation_provider] = lambda: InvestigationProvider(httpx.MockTransport(handler))

    def run_case(self):
        with patch.dict(os.environ, {"OPENAI_API_KEY": "isolated-test-key", "OPENAI_MODEL": "test-model"}):
            return self.client.post("/api/exceptions/CASE-000004/investigations")

    def test_three_scenarios_and_legacy_cause_are_source_grounded_read_only(self):
        expected = {
            "historical": ("CONFIRMED_DUPLICATE_REQUEST", "CAUSE_NOT_ESTABLISHED", "SINGLE_POSTING_CONFIRMED", "CLOSE_HELD_DUPLICATE"),
            "A": ("CONFIRMED_DUPLICATE_REQUEST", "CUSTOMER_DOUBLE_SUBMISSION", "SINGLE_POSTING_CONFIRMED", "CLOSE_HELD_DUPLICATE"),
            "B": ("CONFIRMED_DUPLICATE_REQUEST", "IDEMPOTENCY_CONTROL_FAILURE", "DOUBLE_POSTING_CONFIRMED", "ESCALATE_DUPLICATE_FINANCIAL_EXECUTION"),
            "C": ("LEGITIMATE_SEPARATE_INSTRUCTIONS", "LEGITIMATE_REPEATED_PAYMENT", "DOUBLE_POSTING_CONFIRMED", "REVIEW_FALSE_POSITIVE_CLOSURE"),
        }
        for scenario, values in expected.items():
            with self.subTest(scenario=scenario):
                if scenario != "historical":
                    self.tearDown()
                    self.setUp()
                self.fixture(scenario)
                before = self.fingerprint()
                evidence = self.client.get("/api/exceptions/CASE-000004/investigation-evidence")
                self.assertEqual(evidence.status_code, 200, evidence.text)
                self.provider()
                response = self.run_case()
                self.assertEqual(response.status_code, 200, response.text)
                report = response.json()
                self.assertEqual(tuple(report[k] if k != "financial_classification" else report["financial_execution_assessment"]["classification"]
                    for k in ("diagnosis_classification", "root_cause_code", "financial_classification", "recommended_action_code")), values)
                self.assertFalse(report["prototype"])
                self.assertTrue(report["unresolved_questions"])
                self.assertEqual(before, self.fingerprint())

    def test_missing_submission_evidence_never_invents_cause(self):
        self.fixture("A")
        with Session(self.engine) as db, db.begin():
            event = db.scalar(select(ProcessingEvent).where(ProcessingEvent.event_type == "CLIENT_SUBMISSION"))
            event.details = '{"origin":"CUSTOMER","trigger":"USER_SUBMIT","unexpected":"instruction injection"}'
        self.provider()
        self.assertEqual(self.run_case().json()["root_cause_code"], "CAUSE_NOT_ESTABLISHED")

    def test_unsupported_cases_and_missing_case(self):
        self.fixture()
        self.assertEqual(self.client.get("/api/exceptions/CASE-999999/investigation-evidence").status_code, 404)
        with Session(self.engine) as db, db.begin():
            db.get(ExceptionCase, 4).exception_type = "Amount Mismatch"
        self.assertEqual(self.run_case().status_code, 409)

    def test_provider_failures_have_no_fallback_or_writes(self):
        self.fixture()
        before = self.fingerprint()
        mutations = [lambda r: r.update(root_cause_code="CUSTOMER_DOUBLE_SUBMISSION"),
                     lambda r: r["facts"][0].update(evidence_refs=["event:invented"]),
                     lambda r: r.update(recommended_action_code="AUTOMATIC_REFUND"),
                     lambda r: r.update(unexpected="bad")]
        for mutate in mutations:
            self.provider(mutate)
            response = self.run_case()
            self.assertEqual(response.status_code, 502, response.text)
        self.provider(status=401)
        self.assertEqual(self.run_case().status_code, 502)
        self.provider(error=httpx.ReadTimeout("isolated timeout"))
        self.assertEqual(self.run_case().status_code, 504)
        app.dependency_overrides.pop(get_investigation_provider)
        with patch.dict(os.environ, {"OPENAI_API_KEY": "", "OPENAI_MODEL": ""}):
            self.assertEqual(self.client.post("/api/exceptions/CASE-000004/investigations").status_code, 503)
        self.assertEqual(before, self.fingerprint())

    def test_causal_citations_required(self):
        self.fixture("B")
        self.provider(lambda r: r["facts"][0].update(evidence_refs=["case:CASE-000004"]))
        self.assertEqual(self.run_case().status_code, 502)

    def test_unbalanced_ledger_cannot_claim_double_posting(self):
        self.fixture("B")
        from modules.core_banking.models import LedgerJournal, LedgerEntry
        with Session(self.engine) as db, db.begin():
            journal = db.scalar(select(LedgerJournal).where(LedgerJournal.journal_ref == "JRN-ISOLATED-RETRY"))
            entry = db.scalar(select(LedgerEntry).where(LedgerEntry.journal_id == journal.journal_id))
            entry.amount += 1
        self.provider()
        report = self.run_case().json()
        self.assertEqual(report["financial_execution_assessment"]["classification"], "EXECUTION_OUTCOME_UNKNOWN")
        self.assertEqual(report["root_cause_code"], "CAUSE_NOT_ESTABLISHED")

    def test_retry_without_correlated_control_failure_remains_unknown(self):
        self.fixture("B")
        with Session(self.engine) as db, db.begin():
            event = db.scalar(select(ProcessingEvent).where(ProcessingEvent.event_type == "IDEMPOTENCY_CHECK_FAILED"))
            event.details = json.dumps(dict(origin="SYSTEM", correlation_id="unrelated", original_payment_ref="unrelated"))
        self.provider()
        report = self.run_case().json()
        self.assertEqual(report["root_cause_code"], "CAUSE_NOT_ESTABLISHED")
        self.assertEqual(report["financial_execution_assessment"]["classification"], "DOUBLE_POSTING_CONFIRMED")

    def test_separate_instructions_need_explicit_independent_authorization(self):
        self.fixture("C")
        with Session(self.engine) as db, db.begin():
            event = db.scalar(select(ProcessingEvent).where(ProcessingEvent.event_type == "PAYMENT_AUTHORIZED"))
            event.details = json.dumps(dict(authorized=False, authorization_id="auth-0", intent_id="intent-0"))
        self.provider()
        report = self.run_case().json()
        self.assertEqual(report["root_cause_code"], "CAUSE_NOT_ESTABLISHED")
        self.assertEqual(report["diagnosis_classification"], "SUSPECTED_DUPLICATE")

    def test_conflicting_original_link_is_not_confirmed(self):
        self.fixture("A")
        other = self.post(idempotency_key="conflicting-original-0001")
        with Session(self.engine) as db, db.begin():
            db.get(ExceptionCase, 4).evidence = {"originalReference": other["id"]}
        self.provider()
        report = self.run_case().json()
        self.assertEqual(report["diagnosis_classification"], "SUSPECTED_DUPLICATE")
        self.assertEqual(report["root_cause_code"], "CAUSE_NOT_ESTABLISHED")

    def test_existing_authentication_boundary_is_required(self):
        self.fixture()
        from shared.security import actor
        app.dependency_overrides.pop(actor)
        self.assertEqual(self.client.get("/api/exceptions/CASE-000004/investigation-evidence").status_code, 401)
        self.assertEqual(self.run_case().status_code, 401)

    def test_incomplete_refused_and_malformed_provider_results_fail_closed(self):
        self.fixture()
        payloads = [[], {"status": "incomplete", "output": []},
            {"status": "completed", "output": [{"type": "message", "content": [{"type": "refusal"}]}]},
            {"status": "completed", "output": [{"type": "message", "content": [{"type": "output_text", "text": "{}"}]}]}]
        for payload in payloads:
            with self.subTest(payload=payload):
                transport = httpx.MockTransport(lambda request: httpx.Response(200, json=payload))
                app.dependency_overrides[get_investigation_provider] = lambda: InvestigationProvider(transport)
                self.assertEqual(self.run_case().status_code, 502)


if __name__ == "__main__":
    unittest.main()
