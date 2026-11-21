"""Persistent resolution workflow tests use isolated SQLite and mocked investigation AI."""
import os
os.environ["DATABASE_URL"] = "sqlite:///:memory:"

import unittest
import json
import httpx
from datetime import datetime, timezone
from types import SimpleNamespace
from uuid import uuid4
from unittest.mock import patch
from sqlalchemy import select
from sqlalchemy.orm import Session
from fastapi.testclient import TestClient

import test_investigation as investigation
from main import app
from modules.intelliops.models import AuditEvent, ExceptionCase
from modules.intelliops.email_delivery import EmailSendError, get_mailer
from modules.intelliops.inbound_email import InboundMessage, get_inbound_mailbox
from modules.intelliops.resolution_models import ApprovalRequest, CustomerCommunication, EmailDelivery, InboundEmailReceipt, PolicyAssessment, ResolutionPlan
from modules.intelliops.resolution_llm import ResolutionProvider, get_resolution_provider
from modules.intelliops.resolution_workflow import _communication_control, _matching_rule
from shared.security import actor


class ResolutionWorkflowTests(unittest.TestCase):
    fixture = investigation.InvestigationTests.fixture
    provider = investigation.InvestigationTests.provider

    def setUp(self):
        investigation.InvestigationTests.setUp(self)
        app.dependency_overrides[actor] = lambda: "ANALYST"
        self.environment = patch.dict(os.environ, {
            "INTELLIOPS_INVESTIGATION_PERSISTENCE": "true",
            "OPENAI_API_KEY": "offline-key",
            "OPENAI_MODEL": "offline-model",
            "INTELLIOPS_LLM_DIAGNOSTICS_DIR": "",
        })
        self.environment.start()
        def resolution_handler(request):
            body = json.loads(request.content)
            context = json.loads(body['input'])
            refs = context['evidenceReferences']
            proposal = {
                'recommendedActionCode': context['requiredActionCode'],
                'resolutionTitle': 'Review evidence-grounded duplicate correction',
                'summary': 'Prepare the accepted finding for controlled human review after revalidating current records.',
                'steps': [{'id': 'verify', 'title': 'Revalidate current evidence',
                           'description': 'Compare the accepted finding with current payment and ledger records.',
                           'evidenceReferences': refs[:2], 'requiresHumanReview': True}],
                'customerCommunication': {'recommended': True,
                    'reason': 'Customer impact should be reviewed before forwarding the proposal.',
                    'suggestedMessageType': 'Incident notification'},
                'financialConsiderations': ['Confirm current balances and any later corrective activity.'],
                'risksAndSafeguards': ['No operational or financial action is performed by this proposal.'],
                'approvalRecommendation': {'required': True, 'suggestedRole': 'Administrator',
                    'reason': 'An authorised reviewer must decide any next step.'},
                'uncertainty': ['The source snapshot may have changed and must be revalidated.'],
            }
            return httpx.Response(200, json={'status': 'completed', 'model': 'offline-resolution-model',
                'output': [{'type': 'message', 'content': [{'type': 'output_text', 'text': json.dumps(proposal)}]}],
                'usage': {'input_tokens': 10, 'output_tokens': 10, 'total_tokens': 20}})
        app.dependency_overrides[get_resolution_provider] = lambda: ResolutionProvider(httpx.MockTransport(resolution_handler))
        self.fixture("B")
        self.provider(output={
            "diagnosis_classification": "CONFIRMED_DUPLICATE_REQUEST",
            "root_cause_code": "IDEMPOTENCY_CONTROL_FAILURE",
            "recommended_action_code": "ESCALATE_DUPLICATE_FINANCIAL_EXECUTION",
        })
        response = self.client.post("/api/exceptions/CASE-000004/investigations",
            headers={"X-Investigation-Request-ID": str(uuid4())})
        self.assertEqual(response.status_code, 200, response.text)
        self.report = response.json()

    def tearDown(self):
        self.environment.stop()
        app.dependency_overrides.pop(get_resolution_provider, None)
        investigation.InvestigationTests.tearDown(self)

    def customer_context(self):
        snapshot = self.client.get("/api/banking-snapshot").json()
        case = next(item for item in snapshot["exception_cases"] if item["id"] == "CASE-000004")
        payment = next(item for item in snapshot["payment_transactions"] if item["id"] == case["transactionId"])
        account = next(item for item in snapshot["accounts"] if item["id"] == payment["senderId"])
        return case, payment, account

    def test_plan_communication_reassessment_and_policy_are_durable(self):
        investigation_id = self.report["investigation_id"]
        created = self.client.post("/api/exceptions/CASE-000004/resolution-plans", json={
            "investigation_id": investigation_id, "expected_version": 0,
        })
        self.assertEqual(created.status_code, 200, created.text)
        v1 = created.json()["plans"][0]
        self.assertEqual(v1["version"], 1)
        self.assertFalse(v1["simulated"])
        self.assertEqual(v1["generationSource"], "OPENAI_STRUCTURED")

        case, payment, account = self.customer_context()
        class Mailer:
            def validate_recipient(self, value): return value.strip().lower()
            def message_id(self, token): return f'<{token}@example.test>'
            def send(self, recipient, subject, body, message_id): pass
        app.dependency_overrides[get_mailer] = Mailer
        message = self.client.post("/api/exceptions/CASE-000004/communications", json={
            "investigation_id": investigation_id,
            "customer_id": account["customerRef"],
            "related_transaction_id": payment["id"],
            "direction": "OUTGOING",
            "communication_type": "INCIDENT_NOTIFICATION",
            "subject": "Payment review update",
            "body": "Our operations team is reviewing a processing issue. No further payment action is required from you.",
            "recipient_email": "customer@example.com",
            "delivery_mode": "EMAIL",
        })
        self.assertEqual(message.status_code, 200, message.text)
        self.assertEqual(message.json()["contextRevision"], 1)
        self.assertEqual(message.json()["recipient"]["customerId"], account["customerRef"])
        self.assertEqual(message.json()["recipient"]["transactionId"], payment["id"])

        app.dependency_overrides[actor] = lambda: "ADMIN"
        denied_email = self.client.post("/api/exceptions/CASE-000004/communications", json={
            "investigation_id": investigation_id,
            "customer_id": account["customerRef"],
            "related_transaction_id": payment["id"],
            "direction": "OUTGOING",
            "communication_type": "INCIDENT_NOTIFICATION",
            "subject": "Administrator must not send this message",
            "body": "Operational communication remains an Analyst responsibility.",
            "recipient_email": "customer@example.com",
            "delivery_mode": "EMAIL",
        })
        self.assertEqual(denied_email.status_code, 403, denied_email.text)
        app.dependency_overrides[actor] = lambda: "ANALYST"

        reassessed = self.client.post("/api/exceptions/CASE-000004/resolution-plans", json={
            "investigation_id": investigation_id, "expected_version": 1,
        })
        self.assertEqual(reassessed.status_code, 200, reassessed.text)
        plans = reassessed.json()["plans"]
        self.assertEqual([plan["version"] for plan in plans], [1, 2])
        self.assertEqual(plans[1]["previousPlanId"], plans[0]["planId"])
        self.assertEqual(plans[1]["customerSnapshot"]["revision"], 1)

        policy = self.client.post("/api/exceptions/CASE-000004/policy-assessments", json={
            "plan_id": plans[1]["planId"],
        })
        self.assertEqual(policy.status_code, 200, policy.text)
        self.assertEqual(policy.json()["status"], "APPROVAL_REQUIRED")
        self.assertEqual(len(policy.json()["controls"]), 6)

        self.client.close()
        self.client = TestClient(app)
        self.assertEqual(len(self.client.get("/api/exceptions/CASE-000004/resolution-plans").json()["plans"]), 2)
        self.assertEqual(len(self.client.get("/api/exceptions/CASE-000004/communications").json()["communications"]), 1)
        self.assertEqual(len(self.client.get("/api/exceptions/CASE-000004/policy-assessments").json()["assessments"]), 1)

        with Session(self.engine) as db:
            self.assertEqual(len(db.scalars(select(ResolutionPlan)).all()), 2)
            self.assertEqual(len(db.scalars(select(CustomerCommunication)).all()), 1)
            self.assertEqual(len(db.scalars(select(PolicyAssessment)).all()), 1)
            actions = set(db.scalars(select(AuditEvent.action)).all())
            self.assertTrue({"RESOLUTION_PLAN_CREATED", "RESOLUTION_PLAN_REASSESSED",
                             "CUSTOMER_NOTIFICATION_RECORDED", "POLICY_ASSESSMENT_COMPLETED"}.issubset(actions))

    def test_approval_request_and_admin_decision_are_persistent_and_idempotent(self):
        investigation_id = self.report["investigation_id"]
        first = self.client.post("/api/exceptions/CASE-000004/resolution-plans", json={
            "investigation_id": investigation_id, "expected_version": 0})
        self.assertEqual(first.status_code, 200, first.text)
        _, payment, account = self.customer_context()

        class Mailer:
            def validate_recipient(self, value): return value.strip().lower()
            def message_id(self, token): return f'<{token}@example.test>'
            def send(self, recipient, subject, body, message_id): pass

        app.dependency_overrides[get_mailer] = Mailer
        sent = self.client.post("/api/exceptions/CASE-000004/communications", json={
            "investigation_id": investigation_id, "customer_id": account["customerRef"],
            "related_transaction_id": payment["id"], "direction": "OUTGOING",
            "communication_type": "INCIDENT_NOTIFICATION", "subject": "Payment review update",
            "body": "Our operations team is reviewing this payment processing issue.",
            "recipient_email": "customer@example.com", "delivery_mode": "EMAIL"})
        self.assertEqual(sent.status_code, 200, sent.text)
        plans = self.client.post("/api/exceptions/CASE-000004/resolution-plans", json={
            "investigation_id": investigation_id, "expected_version": 1}).json()["plans"]
        policy = self.client.post("/api/exceptions/CASE-000004/policy-assessments", json={
            "plan_id": plans[-1]["planId"]})
        self.assertEqual(policy.status_code, 200, policy.text)

        submitted = self.client.post("/api/approval-requests", json={
            "assessment_id": policy.json()["assessmentId"]})
        self.assertEqual(submitted.status_code, 200, submitted.text)
        self.assertEqual(submitted.json()["status"], "PENDING_APPROVAL")
        self.assertEqual(submitted.json()["proposedActionLabel"], "Financial Correction Review")
        self.assertEqual([item["label"] for item in submitted.json()["financialMetrics"]],
                         ["Intended transfer", "Posted transfer movement", "Apparent duplicate excess"])
        self.assertEqual(submitted.json()["customerContext"]["notificationCount"], 1)
        self.assertEqual(submitted.json()["customerContext"]["responseCount"], 0)
        replay = self.client.post("/api/approval-requests", json={
            "assessment_id": policy.json()["assessmentId"]})
        self.assertEqual(replay.status_code, 200, replay.text)
        self.assertEqual(replay.json()["requestId"], submitted.json()["requestId"])

        app.dependency_overrides[actor] = lambda: "ANALYST"
        denied = self.client.post(f'/api/approval-requests/{submitted.json()["requestId"]}/decision', json={
            "decision": "APPROVED", "reason": "Evidence and controls support proceeding."})
        self.assertEqual(denied.status_code, 403, denied.text)
        app.dependency_overrides[actor] = lambda: "ADMIN"
        approved = self.client.post(f'/api/approval-requests/{submitted.json()["requestId"]}/decision', json={
            "decision": "APPROVED", "reason": "Evidence and controls support proceeding."})
        self.assertEqual(approved.status_code, 200, approved.text)
        self.assertEqual(approved.json()["status"], "APPROVED")
        repeated = self.client.post(f'/api/approval-requests/{submitted.json()["requestId"]}/decision', json={
            "decision": "REJECTED", "reason": "This should not overwrite a final decision."})
        self.assertEqual(repeated.status_code, 409, repeated.text)

        self.client.close()
        self.client = TestClient(app)
        queue = self.client.get('/api/approval-requests')
        self.assertEqual(queue.status_code, 200, queue.text)
        self.assertEqual([item["requestId"] for item in queue.json()["requests"]], [submitted.json()["requestId"]])
        persisted = self.client.get(f'/api/approval-requests/{submitted.json()["requestId"]}')
        self.assertEqual(persisted.status_code, 200, persisted.text)
        self.assertEqual(persisted.json()["status"], "APPROVED")
        with Session(self.engine) as db:
            self.assertEqual(len(db.scalars(select(ApprovalRequest)).all()), 1)
            actions = set(db.scalars(select(AuditEvent.action)).all())
            self.assertIn("APPROVAL_REQUEST_SUBMITTED", actions)
            self.assertIn("APPROVAL_REQUEST_APPROVED", actions)

    def test_stale_version_and_unsafe_message_are_rejected(self):
        investigation_id = self.report["investigation_id"]
        first = self.client.post("/api/exceptions/CASE-000004/resolution-plans", json={
            "investigation_id": investigation_id, "expected_version": 0,
        })
        self.assertEqual(first.status_code, 200, first.text)
        conflict = self.client.post("/api/exceptions/CASE-000004/resolution-plans", json={
            "investigation_id": investigation_id, "expected_version": 0,
        })
        self.assertEqual(conflict.status_code, 409)
        _, payment, account = self.customer_context()
        unsafe = self.client.post("/api/exceptions/CASE-000004/communications", json={
            "investigation_id": investigation_id, "customer_id": account["customerRef"],
            "related_transaction_id": payment["id"], "direction": "OUTGOING",
            "communication_type": "INCIDENT_NOTIFICATION", "subject": "Refund completed",
            "body": "Your funds were returned.",
        })
        self.assertEqual(unsafe.status_code, 422)

    def test_workflow_status_change_does_not_invalidate_financial_evidence(self):
        with Session(self.engine) as db, db.begin():
            db.get(ExceptionCase, 4).status = 'IN_PROGRESS'
        created = self.client.post('/api/exceptions/CASE-000004/resolution-plans', json={
            'investigation_id': self.report['investigation_id'], 'expected_version': 0,
        })
        self.assertEqual(created.status_code, 200, created.text)
        plan = created.json()['plans'][0]
        policy = self.client.post('/api/exceptions/CASE-000004/policy-assessments', json={
            'plan_id': plan['planId'],
        })
        self.assertEqual(policy.status_code, 200, policy.text)
        financial = next(control for control in policy.json()['controls'] if control['id'] == 'financial')
        self.assertEqual(financial['status'], 'PASS')

    def test_real_email_is_persisted_delivered_and_failed_delivery_can_retry(self):
        class Mailer:
            def __init__(self, fail=False): self.fail, self.sent = fail, []
            def validate_recipient(self, value): return value.strip().lower()
            def message_id(self, token): return f'<{token}@example.test>'
            def send(self, recipient, subject, body, message_id):
                if self.fail: raise EmailSendError('SMTP_DELIVERY_FAILED')
                self.sent.append((recipient, subject, body, message_id))

        _, payment, account = self.customer_context()
        failing = Mailer(fail=True)
        app.dependency_overrides[get_mailer] = lambda: failing
        response = self.client.post('/api/exceptions/CASE-000004/communications', json={
            'investigation_id': self.report['investigation_id'],
            'customer_id': account['customerRef'], 'related_transaction_id': payment['id'],
            'direction': 'OUTGOING', 'communication_type': 'INCIDENT_NOTIFICATION',
            'subject': 'Payment review update',
            'body': 'Our operations team is reviewing a processing issue.',
            'recipient_email': 'Customer@Example.com', 'delivery_mode': 'EMAIL',
        })
        self.assertEqual(response.status_code, 200, response.text)
        message = response.json()['communications'][-1]
        self.assertFalse(message['simulated'])
        self.assertEqual(message['status'], 'FAILED')
        self.assertEqual(message['delivery']['errorCode'], 'SMTP_DELIVERY_FAILED')

        working = Mailer()
        app.dependency_overrides[get_mailer] = lambda: working
        retried = self.client.post(
            f"/api/exceptions/CASE-000004/communications/{message['id']}/retry-email")
        self.assertEqual(retried.status_code, 200, retried.text)
        delivered = retried.json()['communications'][-1]
        self.assertEqual(delivered['status'], 'SENT')
        self.assertEqual(delivered['delivery']['attemptCount'], 2)
        self.assertEqual(len(working.sent), 1)
        with Session(self.engine) as db:
            row = db.scalar(select(EmailDelivery))
            self.assertEqual(row.status, 'SENT')
            self.assertEqual(row.recipient_email, 'customer@example.com')

    def test_gmail_reply_is_imported_once_and_manual_response_is_rejected(self):
        class Mailer:
            def validate_recipient(self, value): return value.strip().lower()
            def message_id(self, token): return f'<{token}@example.test>'
            def send(self, recipient, subject, body, message_id): pass

        _, payment, account = self.customer_context()
        app.dependency_overrides[get_mailer] = Mailer
        sent = self.client.post('/api/exceptions/CASE-000004/communications', json={
            'investigation_id': self.report['investigation_id'],
            'customer_id': account['customerRef'], 'related_transaction_id': payment['id'],
            'direction': 'OUTGOING', 'communication_type': 'INCIDENT_NOTIFICATION',
            'subject': 'Payment review update', 'body': 'We are reviewing your payment.',
            'recipient_email': 'customer@example.com', 'delivery_mode': 'EMAIL',
        })
        self.assertEqual(sent.status_code, 200, sent.text)
        outgoing = sent.json()['communications'][0]
        with Session(self.engine) as db:
            delivery = db.scalar(select(EmailDelivery).where(EmailDelivery.communication_id == outgoing['id']))
            reply_to = delivery.message_id

        class Mailbox:
            settings = SimpleNamespace(mailbox='INBOX', lookback_days=30)
            def scan(self, since, reply_to_ids=()):
                self.reply_to_ids = reply_to_ids
                return [InboundMessage('<gmail-reply@example.com>', '42', 'customer@example.com',
                    'Re: Payment review update', 'Please explain the next steps.', reply_to,
                    (reply_to,), datetime.now(timezone.utc))]
        mailbox = Mailbox()
        app.dependency_overrides[get_inbound_mailbox] = lambda: mailbox
        path = f"/api/exceptions/CASE-000004/communications/sync-inbox?investigation_id={self.report['investigation_id']}"
        imported = self.client.post(path)
        self.assertEqual(imported.status_code, 200, imported.text)
        self.assertEqual(mailbox.reply_to_ids, (reply_to,))
        self.assertEqual(imported.json()['importedCount'], 1)
        self.assertEqual(imported.json()['contextRevision'], 2)
        incoming = imported.json()['communications'][-1]
        self.assertEqual(incoming['direction'], 'INCOMING')
        self.assertEqual(incoming['communicationType'], 'CUSTOM_RESPONSE')
        self.assertEqual(incoming['relatedCommunicationId'], outgoing['id'])
        self.assertFalse(incoming['simulated'])
        replay = self.client.post(path)
        self.assertEqual(replay.status_code, 200, replay.text)
        self.assertEqual(replay.json()['importedCount'], 0)
        with Session(self.engine) as db:
            self.assertEqual(len(db.scalars(select(InboundEmailReceipt)).all()), 1)
            self.assertIn('CUSTOMER_EMAIL_REPLY_IMPORTED', set(db.scalars(select(AuditEvent.action)).all()))

        manual = self.client.post('/api/exceptions/CASE-000004/communications', json={
            'investigation_id': self.report['investigation_id'],
            'customer_id': account['customerRef'], 'related_transaction_id': payment['id'],
            'direction': 'INCOMING', 'communication_type': 'CUSTOM_RESPONSE',
            'body': 'Manually fabricated response', 'related_communication_id': outgoing['id'],
        })
        self.assertEqual(manual.status_code, 422)


class InvestigationImportRecoveryTests(unittest.TestCase):
    fixture = investigation.InvestigationTests.fixture
    provider = investigation.InvestigationTests.provider

    def setUp(self):
        investigation.InvestigationTests.setUp(self)
        app.dependency_overrides[actor] = lambda: "ANALYST"
        self.fixture('B')

    def tearDown(self):
        investigation.InvestigationTests.tearDown(self)

    def test_browser_session_report_is_revalidated_and_imported_without_provider_retry(self):
        self.provider(output={
            'diagnosis_classification': 'CONFIRMED_DUPLICATE_REQUEST',
            'root_cause_code': 'IDEMPOTENCY_CONTROL_FAILURE',
            'recommended_action_code': 'ESCALATE_DUPLICATE_FINANCIAL_EXECUTION',
        })
        with patch.dict(os.environ, {'INTELLIOPS_INVESTIGATION_PERSISTENCE': 'false',
                                     'OPENAI_API_KEY': 'offline-key', 'OPENAI_MODEL': 'offline-model'}):
            created = self.client.post('/api/exceptions/CASE-000004/investigations')
        self.assertEqual(created.status_code, 200, created.text)
        self.assertEqual(created.json()['persistence'], 'BROWSER_SESSION_ONLY')
        from modules.intelliops.investigation_llm import InvestigationProvider, get_investigation_provider
        import httpx
        app.dependency_overrides[get_investigation_provider] = lambda: InvestigationProvider(httpx.MockTransport(
            lambda request: (_ for _ in ()).throw(AssertionError('Import must not call the provider'))))
        with patch.dict(os.environ, {'INTELLIOPS_INVESTIGATION_PERSISTENCE': 'true'}):
            imported = self.client.post('/api/exceptions/CASE-000004/investigations/import', json={'report': created.json()})
        self.assertEqual(imported.status_code, 200, imported.text)
        self.assertEqual(imported.json()['persistence'], 'BACKEND_DATABASE')
        self.assertEqual(imported.json()['investigation_id'], created.json()['investigation_id'])


class ResolutionEligibilityMatrixTests(unittest.TestCase):
    def test_communication_control_distinguishes_delivery_from_not_required(self):
        self.assertEqual(_communication_control(None, 0, 0)[0], 'BLOCKED')
        self.assertEqual(_communication_control({'financial': False}, 0, 0)[0], 'NOT_REQUIRED')
        self.assertEqual(_communication_control({'financial': True}, 0, 0)[0], 'REVIEW_REQUIRED')
        status, reason = _communication_control({'financial': True}, 1, 0)
        self.assertEqual(status, 'PASS')
        self.assertIn('reply is not required', reason)
        self.assertEqual(_communication_control({'financial': True}, 1, 1)[0], 'PASS')

    def test_every_investigation_review_path_has_a_deterministic_guard(self):
        rows = [
            ('DUPLICATE_TRANSACTION', 'CONFIRMED_DUPLICATE_REQUEST', 'DOUBLE_POSTING_CONFIRMED', 2, 'ESCALATE_DUPLICATE_FINANCIAL_EXECUTION'),
            ('DUPLICATE_TRANSACTION', 'CONFIRMED_DUPLICATE_REQUEST', 'SINGLE_POSTING_CONFIRMED', 1, 'CLOSE_HELD_DUPLICATE'),
            ('DUPLICATE_TRANSACTION', 'LEGITIMATE_SEPARATE_INSTRUCTIONS', 'DOUBLE_POSTING_CONFIRMED', 2, 'REVIEW_FALSE_POSITIVE_CLOSURE'),
            ('DUPLICATE_TRANSACTION', 'INSUFFICIENT_EVIDENCE', 'EXECUTION_OUTCOME_UNKNOWN', 0, 'ESCALATE_FOR_PAYMENT_VERIFICATION'),
            ('AMOUNT_MISMATCH', 'CONFIRMED_AMOUNT_MISMATCH', 'UNDERPOSTING_CONFIRMED', 1, 'REVIEW_SHORTFALL_ADJUSTMENT'),
            ('AMOUNT_MISMATCH', 'CONFIRMED_AMOUNT_MISMATCH', 'OVERPOSTING_CONFIRMED', 1, 'REVIEW_OVERPOSTING_CORRECTION'),
            ('AMOUNT_MISMATCH', 'NO_AMOUNT_MISMATCH', 'AMOUNT_MATCH_CONFIRMED', 1, 'REVIEW_FALSE_POSITIVE_CLOSURE'),
            ('AMOUNT_MISMATCH', 'INSUFFICIENT_EVIDENCE', 'EXECUTION_OUTCOME_UNKNOWN', 0, 'ESCALATE_FOR_AMOUNT_VERIFICATION'),
            ('MISSING_LEDGER_POSTING', 'CONFIRMED_MISSING_POSTING', 'NO_POSTING_RECORD_CONFIRMED', 0, 'REVIEW_MISSING_POSTING_REMEDIATION'),
            ('MISSING_LEDGER_POSTING', 'POSTING_RECORD_PRESENT', 'POSTING_RECORD_PRESENT', 1, 'REVIEW_FALSE_POSITIVE_CLOSURE'),
            ('MISSING_LEDGER_POSTING', 'INSUFFICIENT_EVIDENCE', 'EXECUTION_OUTCOME_UNKNOWN', 0, 'ESCALATE_FOR_LEDGER_VERIFICATION'),
        ]
        for exception, diagnosis, classification, journals, action in rows:
            report = {'exception_type': exception, 'diagnosis_classification': diagnosis,
                'financial_execution_assessment': {'classification': classification},
                'financial_impact': {'confirmedPostedJournalCount': journals}}
            with self.subTest(action=action):
                self.assertIsNotNone(_matching_rule(report, action))


if __name__ == "__main__":
    unittest.main()
