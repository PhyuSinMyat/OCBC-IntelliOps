"""Isolated source fixtures and mocked provider HTTP; never connects to Supabase."""
import os
os.environ["DATABASE_URL"] = "sqlite:///:memory:"
import json
import unittest
from unittest.mock import patch
import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session
import test_investigation_evidence_phase1 as evidence_tests
from fastapi.testclient import TestClient
from main import app
from shared.database import Base
from shared.security import actor
from modules.core_banking.router import get_db
from modules.payment_processing.scenarios import A, B, C
from modules.payment_processing.models import Transaction, PaymentInstruction, ProcessingEvent
from modules.intelliops.models import ExceptionCase
from modules.intelliops.investigation_llm import InvestigationProvider, get_investigation_provider


class InvestigationTests(unittest.TestCase):
    def setUp(self):
        evidence_tests.EvidencePhase1Tests.setUp(self)
        def get_test_db():
            with Session(self.engine) as db:
                yield db
        app.dependency_overrides[get_db] = get_test_db
        app.dependency_overrides[actor] = lambda: 'ADMIN'
        self.client = TestClient(app)

    def tearDown(self):
        self.client.close()
        evidence_tests.EvidencePhase1Tests.tearDown(self)

    def post(self, **overrides):
        body = dict(sender_account_ref='ACC-100003', receiver_account_ref='ACC-100001', amount='100.00',
            idempotency_key='isolated-investigation-payment')
        body.update(overrides)
        response = self.client.post('/api/payments', json=body)
        self.assertEqual(response.status_code, 201, response.text)
        return response.json()

    def fixture(self, scenario="historical"):
        # Exercise the production generator's complete request/event shapes. No
        # migration helpers, live databases or hand-invented authorization records.
        case_id, ids = evidence_tests.EvidencePhase1Tests.generate(self, {'historical': A, 'A': A, 'B': B, 'C': C}[scenario])
        with Session(self.engine) as db, db.begin():
            db.get(ExceptionCase, int(case_id.split('-')[1])).id = 4
            if scenario == 'historical':
                for source in db.scalars(select(ProcessingEvent).where(ProcessingEvent.transaction_id.in_(ids), ProcessingEvent.event_type == 'CLIENT_SUBMISSION')):
                    db.delete(source)

    def fingerprint(self):
        with self.engine.connect() as connection:
            return {table.name: sorted(repr(tuple(row)) for row in connection.execute(select(table)))
                    for table in Base.metadata.sorted_tables}

    def provider(self, mutate=None, status=200, error=None, output=None):
        def handler(request):
            if error:
                raise error
            body = json.loads(request.content)
            self.assertEqual(str(request.url), "https://api.openai.com/v1/responses")
            self.assertFalse(body["store"])
            self.assertTrue(body["text"]["format"]["strict"])
            evidence = json.loads(body["input"])
            self.assertNotIn('verified_assessment', evidence)
            result = dict(diagnosis_classification='SUSPECTED_DUPLICATE', root_cause_code='CAUSE_NOT_ESTABLISHED',
                financial_classification=evidence['financial_verification']['classification'],
                recommended_action_code='ESCALATE_FOR_PAYMENT_VERIFICATION', root_cause_title='Cause not established',
                root_cause_explanation='Operational evidence needs further review.', root_cause_evidence_refs=[])
            result.update(facts=[dict(statement="Source records require review.",
                evidence_refs=evidence['evidence_references'][:1])],
                hypotheses=[], uncertainty=["Further evidence may change the assessment."],
                recommendation_reason="Human review of the cited source records is required.")
            if output:
                result.update(output)
                if result['root_cause_code'] != 'CAUSE_NOT_ESTABLISHED':
                    result['root_cause_evidence_refs'] = [r for r in evidence['evidence_references'] if r.startswith(('event:', 'request:'))][:1]
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
                self.provider(output=dict(diagnosis_classification=values[0], root_cause_code=values[1], recommended_action_code=values[3]))
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
        self.provider(lambda r: r.update(root_cause_evidence_refs=["case:CASE-000004"]), output=dict(root_cause_code='RETRY_CONTROL_HYPOTHESIS'))
        self.assertEqual(self.run_case().status_code, 502)

    def test_unbalanced_ledger_cannot_claim_double_posting(self):
        self.fixture("B")
        from modules.core_banking.models import LedgerJournal, LedgerEntry
        with Session(self.engine) as db, db.begin():
            journal = db.scalar(select(LedgerJournal).where(LedgerJournal.source_transaction_id == db.get(ExceptionCase, 4).transaction_id))
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
