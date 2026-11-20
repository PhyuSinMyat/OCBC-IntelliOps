"""Persistent resolution planning, customer communication and deterministic policy."""
import json
import re
from copy import deepcopy
from datetime import timedelta, timezone
from decimal import Decimal, InvalidOperation
from sqlalchemy import func, or_, select

from modules.core_banking.models import Account, Customer
from modules.payment_processing.models import PaymentInstruction, Transaction
from .investigation_router import collect
from .investigation_storage import InvestigationRecord, material_fingerprint, report_evidence
from .investigation_validation import monetary_assertions
from .models import AuditEvent
from .email_delivery import EmailConfigurationError, EmailSendError
from .inbound_email import InboundEmailSyncError
from .resolution_models import CustomerCommunication, EmailDelivery, InboundEmailReceipt, PolicyAssessment, ResolutionPlan
from .service import CaseError, get_case, parse_case_id
from shared.timestamps import utc_now


POLICY_VERSION = "RESOLUTION_POLICY_V1"
_completed_financial_claim = re.compile(
    r"\b(?:refund|reversal|reimbursement|correction|funds?)\b.{0,40}\b(?:completed|executed|returned|restored|sent|posted)\b|"
    r"\b(?:completed|executed|returned|restored|sent|posted)\b.{0,40}\b(?:refund|reversal|reimbursement|correction|funds?)\b", re.I)

ACTION_RULES = {
    "ESCALATE_DUPLICATE_FINANCIAL_EXECUTION": dict(label="Financial Correction Review", exception="DUPLICATE_TRANSACTION", diagnosis="CONFIRMED_DUPLICATE_REQUEST", classification="DOUBLE_POSTING_CONFIRMED", journals=2, financial=True),
    "CLOSE_HELD_DUPLICATE": dict(label="Held-Duplicate Closure Review", exception="DUPLICATE_TRANSACTION", diagnosis="CONFIRMED_DUPLICATE_REQUEST", classification="SINGLE_POSTING_CONFIRMED", journals=1, financial=False),
    "REVIEW_FALSE_POSITIVE_CLOSURE": [
        dict(label="False-Positive Closure Review", exception="DUPLICATE_TRANSACTION", diagnosis="LEGITIMATE_SEPARATE_INSTRUCTIONS", classification="DOUBLE_POSTING_CONFIRMED", journals=2, financial=False),
        dict(label="Amount Alert Closure Review", exception="AMOUNT_MISMATCH", diagnosis="NO_AMOUNT_MISMATCH", classification="AMOUNT_MATCH_CONFIRMED", journals=None, financial=False),
        dict(label="Late Posting Alert Closure Review", exception="MISSING_LEDGER_POSTING", diagnosis="POSTING_RECORD_PRESENT", classification="POSTING_RECORD_PRESENT", journals=None, financial=False),
    ],
    "ESCALATE_FOR_PAYMENT_VERIFICATION": dict(label="Payment Verification Review", exception="DUPLICATE_TRANSACTION", diagnosis=None, classification=None, journals=None, financial=False),
    "REVIEW_SHORTFALL_ADJUSTMENT": dict(label="Posting Shortfall Adjustment Review", exception="AMOUNT_MISMATCH", diagnosis="CONFIRMED_AMOUNT_MISMATCH", classification="UNDERPOSTING_CONFIRMED", journals=1, financial=True),
    "REVIEW_OVERPOSTING_CORRECTION": dict(label="Amount Overposting Correction Review", exception="AMOUNT_MISMATCH", diagnosis="CONFIRMED_AMOUNT_MISMATCH", classification="OVERPOSTING_CONFIRMED", journals=1, financial=True),
    "ESCALATE_FOR_AMOUNT_VERIFICATION": dict(label="Amount Verification Review", exception="AMOUNT_MISMATCH", diagnosis="INSUFFICIENT_EVIDENCE", classification="EXECUTION_OUTCOME_UNKNOWN", journals=None, financial=False),
    "REVIEW_MISSING_POSTING_REMEDIATION": dict(label="Missing Ledger Posting Remediation Review", exception="MISSING_LEDGER_POSTING", diagnosis="CONFIRMED_MISSING_POSTING", classification="NO_POSTING_RECORD_CONFIRMED", journals=0, financial=True),
    "ESCALATE_FOR_LEDGER_VERIFICATION": dict(label="Ledger Verification Review", exception="MISSING_LEDGER_POSTING", diagnosis="INSUFFICIENT_EVIDENCE", classification="EXECUTION_OUTCOME_UNKNOWN", journals=None, financial=False),
    "REVIEW_PROCESSING_FAILURE_RECOVERY": dict(label="Payment Processing Recovery Review", exception="PAYMENT_PROCESSING_FAILURE", diagnosis="CONFIRMED_PROCESSING_FAILURE", classification=None, journals=None, financial=False),
    "REVIEW_UNMATCHED_TRANSACTION_RECONCILIATION": dict(label="Unmatched Transaction Reconciliation Review", exception="UNMATCHED_TRANSACTION", diagnosis="CONFIRMED_UNMATCHED_TRANSACTION", classification=None, journals=None, financial=False),
    "REVIEW_INVALID_LEDGER_REMEDIATION": dict(label="Invalid Ledger Posting Remediation Review", exception="INVALID_LEDGER_POSTING", diagnosis="CONFIRMED_INVALID_LEDGER_POSTING", classification=None, journals=None, financial=True),
    "REVIEW_ACCOUNT_MISMATCH_REMEDIATION": dict(label="Ledger Account Mismatch Remediation Review", exception="LEDGER_ACCOUNT_MISMATCH", diagnosis="CONFIRMED_LEDGER_ACCOUNT_MISMATCH", classification=None, journals=None, financial=True),
    "REVIEW_CURRENCY_MISMATCH_REMEDIATION": dict(label="Ledger Currency Mismatch Remediation Review", exception="LEDGER_CURRENCY_MISMATCH", diagnosis="CONFIRMED_LEDGER_CURRENCY_MISMATCH", classification=None, journals=None, financial=True),
    "REVIEW_PROCESSING_TIMEOUT_RECOVERY": dict(label="Processing Timeout Recovery Review", exception="PROCESSING_TIMEOUT", diagnosis="CONFIRMED_PROCESSING_TIMEOUT", classification=None, journals=None, financial=False),
}


def _case_ref(case_id):
    return f"CASE-{case_id:06d}"


def _accepted(db, case_id, investigation_id):
    row = db.scalar(select(InvestigationRecord).where(
        InvestigationRecord.case_id == parse_case_id(case_id),
        InvestigationRecord.investigation_id == investigation_id,
        InvestigationRecord.status == "ACCEPTED"))
    if not row or not row.report:
        raise CaseError("Saved accepted investigation not found for this case.", 404)
    return row


def _context_revision(db, case, investigation_id):
    return db.scalar(select(func.count()).select_from(CustomerCommunication).where(
        CustomerCommunication.case_id == case.id,
        CustomerCommunication.investigation_id == investigation_id)) or 0


def _responses(db, case, investigation_id):
    rows = db.scalars(select(CustomerCommunication).where(
        CustomerCommunication.case_id == case.id,
        CustomerCommunication.investigation_id == investigation_id,
        CustomerCommunication.direction == "INCOMING").order_by(CustomerCommunication.created_at, CustomerCommunication.id)).all()
    return [dict(id=row.id, createdAt=row.created_at.isoformat(), communicationType=row.communication_type, body=row.body) for row in rows]


def _rule_matches(report, rule):
    return bool(rule and report.get("exception_type") == rule["exception"] and
        (rule["diagnosis"] is None or report.get("diagnosis_classification") == rule["diagnosis"]) and
        (rule["classification"] is None or report.get("financial_execution_assessment", {}).get("classification") == rule["classification"]) and
        (rule["journals"] is None or report.get("financial_impact", {}).get("confirmedPostedJournalCount") == rule["journals"]))


def _matching_rule(report, action):
    configured = ACTION_RULES.get(action)
    rules = configured if isinstance(configured, list) else [configured]
    return next((rule for rule in rules if _rule_matches(report, rule)), None)


def _validate_plan_amounts(candidate, report):
    """Reject explicit currency amounts that are absent from verified source facts."""
    allowed = {}
    def add(currency, value):
        if currency and value is not None:
            try:
                allowed.setdefault(currency, {Decimal(0)}).add(abs(Decimal(str(value))))
            except InvalidOperation:
                pass
    evidence = report.get("supporting_evidence") or {}
    for record in [evidence.get("original"), evidence.get("duplicate")]:
        if record and record.get("amountCents") is not None:
            add(record.get("currency"), Decimal(record["amountCents"]) / 100)
    for entry in evidence.get("entries") or []:
        if entry.get("amountCents") is not None:
            add(entry.get("currency"), Decimal(entry["amountCents"]) / 100)
    impact = report.get("financial_impact") or {}
    for key in ("validDebitTotals", "validCreditTotals"):
        for currency, value in (impact.get(key) or {}).items():
            add(currency, value)
    for movement in impact.get("accountMovements") or []:
        for key in ("debit", "credit", "net"):
            add(movement.get("currency"), movement.get(key))
    currencies = {record.get("currency") for record in [evidence.get("original"), evidence.get("duplicate")] if record and record.get("currency")}
    if len(currencies) == 1:
        currency = next(iter(currencies))
        for key in ("expectedAmount", "postedAmount", "difference", "absoluteDifference", "tolerance"):
            add(currency, impact.get(key))
    known_codes = sorted(set(allowed) | {"SGD", "USD", "EUR", "GBP", "AUD", "JPY", "CNY", "HKD"})
    for statement in _text_values(candidate):
        for currency, raw in monetary_assertions(statement, known_codes):
            currency = "SGD" if currency == "S$" else next(iter(allowed), None) if currency == "$" and len(allowed) == 1 else currency
            if currency not in allowed or abs(Decimal(raw.replace(",", ""))) not in allowed[currency]:
                raise CaseError("AI resolution proposal contains an unverified monetary amount; no plan was saved.", 502)


def _text_values(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for item in value.values():
            yield from _text_values(item)
    elif isinstance(value, list):
        for item in value:
            yield from _text_values(item)


def _plan_candidate(report, responses, provider):
    action = report.get("recommended_action_code")
    configured = ACTION_RULES.get(action)
    if not configured or report.get("prototype") is not False or report.get("run_status") != "COMPLETED":
        raise CaseError("The accepted investigation does not have a supported resolution action.", 422)
    rule = _matching_rule(report, action)
    if not rule:
        raise CaseError("The investigation action is inconsistent with its verified financial assessment.", 422)
    refs = list(dict.fromkeys(report.get("evidence_references") or []))
    analysis = report.get("llm_analysis") or {}
    context = dict(requiredActionCode=action, exceptionType=report.get("exception_type"),
        diagnosis=report.get("diagnosis_classification"), rootCause=dict(code=report.get("root_cause_code"),
        title=report.get("root_cause_title"), explanation=report.get("root_cause_explanation"),
        evidenceReferences=report.get("root_cause_evidence_refs") or []),
        verifiedFinancialAssessment=report.get("financial_execution_assessment"),
        verifiedFinancialImpact=report.get("financial_impact"), facts=analysis.get("facts") or [],
        hypotheses=analysis.get("hypotheses") or [], uncertainty=report.get("unresolved_questions") or [],
        evidenceReferences=refs, customerResponses=responses)
    candidate, model = provider.propose(context)
    value = candidate.model_dump()
    if value["recommendedActionCode"] != action:
        raise CaseError("AI resolution proposal changed the deterministically eligible action; no plan was saved.", 502)
    if any(not set(step["evidenceReferences"]) <= set(refs) for step in value["steps"]):
        raise CaseError("AI resolution proposal cited unavailable evidence; no plan was saved.", 502)
    rendered = json.dumps(value)
    if _completed_financial_claim.search(rendered):
        raise CaseError("AI resolution proposal claimed an unverified completed financial action; no plan was saved.", 502)
    _validate_plan_amounts(value, report)
    value["customerCommunication"]["recommended"] = rule["financial"]
    value["approvalRecommendation"]["required"] = rule["financial"]
    value["approvalRecommendation"]["suggestedRole"] = "Administrator" if rule["financial"] else "Authorised case reviewer"
    value.update(supportingEvidence=refs[:20], consideredCustomerResponseIds=[response["id"] for response in responses],
                 _providerModel=model)
    return value


def serialize_plan(row):
    value = deepcopy(row.plan_json)
    value.update(planId=row.id, version=row.version, investigationId=row.investigation_id,
                 previousPlanId=row.previous_plan_id, generatedAt=row.created_at.isoformat(), simulated=False,
                 generationSource=row.model_metadata.get("source", "BACKEND_DETERMINISTIC"),
                 customerSnapshot=deepcopy(row.customer_snapshot), evidenceFingerprint=row.evidence_fingerprint)
    return value


def list_plans(db, case_id, investigation_id=None):
    case = get_case(db, case_id)
    query = select(ResolutionPlan).where(ResolutionPlan.case_id == case.id)
    if investigation_id:
        query = query.where(ResolutionPlan.investigation_id == investigation_id)
    return [serialize_plan(row) for row in db.scalars(query.order_by(ResolutionPlan.version)).all()]


def generate_plan(db, case_id, investigation_id, expected_version, role, provider):
    case = get_case(db, case_id)
    accepted = _accepted(db, case_id, investigation_id)
    current_evidence = collect(db, case_id)
    current_fp = material_fingerprint(current_evidence)
    accepted_fp = material_fingerprint(report_evidence(accepted.report))
    if current_fp != accepted_fp:
        raise CaseError("Current source evidence differs from the accepted investigation. Reinvestigate before generating a plan.", 409)
    latest = db.scalar(select(ResolutionPlan).where(ResolutionPlan.case_id == case.id).order_by(ResolutionPlan.version.desc()).limit(1))
    if (latest.version if latest else 0) != expected_version:
        raise CaseError("The current resolution plan version changed. Reload before generating another version.", 409)
    if latest and latest.investigation_id != investigation_id:
        raise CaseError("A newer investigation must start a separately reviewed resolution sequence.", 409)
    revision = _context_revision(db, case, investigation_id)
    responses = _responses(db, case, investigation_id)
    candidate = _plan_candidate(accepted.report, responses, provider)
    provider_model = candidate.pop("_providerModel")
    if material_fingerprint(collect(db, case_id)) != current_fp or _context_revision(db, case, investigation_id) != revision:
        raise CaseError("Evidence or customer context changed while the AI proposal was generated. Reassess from the latest context.", 409)
    now = utc_now()
    version = expected_version + 1
    snapshot = dict(reference=f"CTX:{_case_ref(case.id)}:{investigation_id}:R{revision}", revision=revision, responses=responses)
    row = ResolutionPlan(case_id=case.id, version=version, previous_plan_id=latest.id if latest else None,
        investigation_id=investigation_id, evidence_fingerprint=current_fp, customer_context_revision=revision,
        customer_snapshot=snapshot, action_code=candidate["recommendedActionCode"], plan_json=candidate,
        model_metadata={"source": "OPENAI_STRUCTURED", "model": provider_model,
                        "provider": deepcopy(getattr(provider, "last_metadata", {})),
                        "guardPolicy": "deterministic-action-eligibility-v2"},
        created_by=role, created_at=now)
    db.add(row); db.flush()
    event = "RESOLUTION_PLAN_REASSESSED" if latest else "RESOLUTION_PLAN_CREATED"
    db.add(AuditEvent(action=event, actor=role, reference=_case_ref(case.id), created_at=now,
                      details={"planId": row.id, "version": version, "investigationId": investigation_id,
                               "previousPlanId": row.previous_plan_id, "recordOrigin": "BACKEND_PERSISTED"}))
    db.commit(); db.refresh(row)
    return list_plans(db, case_id, investigation_id)


def _communication_context(db, case):
    tx = db.get(Transaction, case.transaction_id)
    instruction = db.scalar(select(PaymentInstruction).where(PaymentInstruction.transaction_id == case.transaction_id))
    account = db.get(Account, instruction.sender_account_id) if instruction else None
    customer = db.get(Customer, account.customer_id) if account else None
    return tx, customer, account


def communication_recipient(db, case_id):
    case = get_case(db, case_id)
    tx, customer, account = _communication_context(db, case)
    if not tx or not customer or not account:
        return None
    return dict(customerId=customer.customer_ref, customerName=customer.customer_name,
                accountId=account.account_ref, transactionId=tx.reference)


def serialize_communication(row, delivery=None):
    status = delivery.status if delivery else row.status
    return dict(id=row.id, caseId=_case_ref(row.case_id), investigationId=row.investigation_id,
                customerId=row.customer_id, relatedTransactionId=row.related_transaction_id,
                direction=row.direction, communicationType=row.communication_type, subject=row.subject,
                body=row.body, recipientEmail=row.recipient_email, status=status,
                relatedCommunicationId=row.related_communication_id, recordedBy=row.recorded_by,
                simulated=row.simulated, delivery=(dict(id=delivery.id, provider=delivery.provider,
                    status=delivery.status, attemptCount=delivery.attempt_count,
                    errorCode=delivery.last_error_code, queuedAt=delivery.queued_at.isoformat(),
                    attemptedAt=delivery.attempted_at.isoformat() if delivery.attempted_at else None,
                    sentAt=delivery.sent_at.isoformat() if delivery.sent_at else None) if delivery else None),
                createdAt=row.created_at.isoformat())


def list_communications(db, case_id, investigation_id=None):
    case = get_case(db, case_id)
    query = select(CustomerCommunication).where(CustomerCommunication.case_id == case.id)
    if investigation_id:
        query = query.where(CustomerCommunication.investigation_id == investigation_id)
    rows = db.scalars(query.order_by(CustomerCommunication.created_at, CustomerCommunication.id)).all()
    ids = [row.id for row in rows]
    deliveries = {row.communication_id: row for row in db.scalars(
        select(EmailDelivery).where(EmailDelivery.communication_id.in_(ids))).all()} if ids else {}
    return [serialize_communication(row, deliveries.get(row.id)) for row in rows], len(rows)


def sync_inbound_email(db, case_id, investigation_id, mailbox, role):
    case = get_case(db, case_id)
    if role != "ADMIN":
        raise CaseError("Only ADMIN may synchronize the customer reply mailbox.", 403)
    if mailbox is None:
        raise CaseError("Inbound Gmail synchronization is not configured.", 503)
    _accepted(db, case_id, investigation_id)
    rows = db.execute(select(CustomerCommunication, EmailDelivery).join(
        EmailDelivery, EmailDelivery.communication_id == CustomerCommunication.id).where(
        CustomerCommunication.case_id == case.id,
        CustomerCommunication.investigation_id == investigation_id,
        CustomerCommunication.direction == "OUTGOING")).all()
    if not rows:
        raise CaseError("Send a customer email before checking Gmail for replies.", 409)
    by_message_id = {delivery.message_id: (communication, delivery) for communication, delivery in rows}
    lookback = getattr(getattr(mailbox, "settings", None), "lookback_days", 30)
    since = utc_now() - timedelta(days=lookback)
    try:
        messages = mailbox.scan(since)
    except InboundEmailSyncError as error:
        raise CaseError(str(error), 502) from error
    imported = 0
    for message in messages:
        matched_id = next((reference for reference in message.references if reference in by_message_id), None)
        if not matched_id:
            continue
        outgoing, delivery = by_message_id[matched_id]
        if message.sender_email.lower() != delivery.recipient_email.lower():
            continue
        received_at = message.received_at
        if received_at.tzinfo is None:
            received_at = received_at.replace(tzinfo=timezone.utc)
        queued_at = delivery.queued_at
        if queued_at.tzinfo is None:
            queued_at = queued_at.replace(tzinfo=timezone.utc)
        now = utc_now()
        if received_at < queued_at or received_at > now + timedelta(minutes=5):
            continue
        duplicate = db.scalar(select(InboundEmailReceipt.id).where(or_(
            InboundEmailReceipt.provider_message_id == message.provider_message_id,
            (InboundEmailReceipt.mailbox == getattr(getattr(mailbox, "settings", None), "mailbox", "INBOX")) &
            (InboundEmailReceipt.mailbox_uid == message.mailbox_uid))))
        if duplicate:
            continue
        communication = CustomerCommunication(case_id=case.id, investigation_id=investigation_id,
            customer_id=outgoing.customer_id, related_transaction_id=outgoing.related_transaction_id,
            direction="INCOMING", communication_type="CUSTOM_RESPONSE", subject=message.subject,
            body=message.body, recipient_email=message.sender_email, status="RECEIVED_EMAIL",
            related_communication_id=outgoing.id, recorded_by="GMAIL_IMAP",
            simulated=False, created_at=received_at)
        db.add(communication); db.flush()
        receipt = InboundEmailReceipt(communication_id=communication.id,
            provider_message_id=message.provider_message_id,
            mailbox=getattr(getattr(mailbox, "settings", None), "mailbox", "INBOX"),
            mailbox_uid=message.mailbox_uid, sender_email=message.sender_email,
            in_reply_to=matched_id, received_at=received_at, imported_at=now)
        db.add(receipt)
        db.add(AuditEvent(action="CUSTOMER_EMAIL_REPLY_IMPORTED", actor="GMAIL_IMAP",
            reference=_case_ref(case.id), created_at=now, details={
                "communicationId": communication.id, "relatedCommunicationId": outgoing.id,
                "investigationId": investigation_id, "recordOrigin": "BACKEND_PERSISTED",
                "simulated": False, "provider": "GMAIL_IMAP"}))
        imported += 1
    db.commit()
    communications, revision = list_communications(db, case_id, investigation_id)
    return communications, revision, imported, len(messages)


_unsafe_claim = re.compile(r"\b(refund(?:ed)?|revers(?:ed|al)|reimburs(?:ed|ement)|correction (?:completed|executed)|funds (?:returned|restored))\b", re.I)


def _deliver_email(db, case_id, communication_id, mailer, role, retry=False):
    case = get_case(db, case_id)
    communication = db.scalar(select(CustomerCommunication).where(
        CustomerCommunication.id == communication_id,
        CustomerCommunication.case_id == case.id).with_for_update())
    delivery = db.scalar(select(EmailDelivery).where(
        EmailDelivery.communication_id == communication_id).with_for_update()) if communication else None
    if not communication or not delivery:
        raise CaseError("Email delivery record was not found for this case.", 404)
    if role != "ADMIN":
        raise CaseError("Only ADMIN may send customer email.", 403)
    allowed = {"FAILED"} if retry else {"PENDING"}
    if delivery.status not in allowed:
        if delivery.status == "SENT":
            return list_communications(db, case_id, communication.investigation_id)
        raise CaseError("Email delivery cannot be retried because its outcome is pending or uncertain.", 409)
    delivery.status = "SENDING"
    delivery.attempt_count += 1
    delivery.attempted_at = utc_now()
    delivery.last_error_code = None
    db.commit()
    try:
        mailer.send(delivery.recipient_email, communication.subject, communication.body, delivery.message_id)
    except EmailSendError as error:
        delivery = db.get(EmailDelivery, delivery.id)
        delivery.status = "FAILED"
        delivery.last_error_code = error.code
        db.add(AuditEvent(action="CUSTOMER_EMAIL_DELIVERY_FAILED", actor=role,
            reference=_case_ref(case.id), created_at=utc_now(), details={
                "communicationId": communication.id, "deliveryId": delivery.id,
                "errorCode": error.code, "recordOrigin": "BACKEND_PERSISTED"}))
        db.commit()
        return list_communications(db, case_id, communication.investigation_id)
    except Exception:
        db.rollback()
        delivery = db.get(EmailDelivery, delivery.id)
        delivery.status = "UNKNOWN"
        delivery.last_error_code = "DELIVERY_OUTCOME_UNKNOWN"
        db.add(AuditEvent(action="CUSTOMER_EMAIL_DELIVERY_UNKNOWN", actor=role,
            reference=_case_ref(case.id), created_at=utc_now(), details={
                "communicationId": communication.id, "deliveryId": delivery.id,
                "recordOrigin": "BACKEND_PERSISTED"}))
        db.commit()
        return list_communications(db, case_id, communication.investigation_id)
    delivery = db.get(EmailDelivery, delivery.id)
    delivery.status = "SENT"
    delivery.sent_at = utc_now()
    db.add(AuditEvent(action="CUSTOMER_EMAIL_SENT", actor=role, reference=_case_ref(case.id),
        created_at=delivery.sent_at, details={"communicationId": communication.id,
            "deliveryId": delivery.id, "provider": delivery.provider,
            "recordOrigin": "BACKEND_PERSISTED"}))
    db.commit()
    return list_communications(db, case_id, communication.investigation_id)


def retry_email(db, case_id, communication_id, mailer, role):
    if mailer is None:
        raise CaseError("Outbound customer email is not configured.", 503)
    return _deliver_email(db, case_id, communication_id, mailer, role, retry=True)


def create_communication(db, case_id, request, role, mailer=None):
    case = get_case(db, case_id)
    _accepted(db, case_id, request.investigation_id)
    tx, customer, _ = _communication_context(db, case)
    if not customer or request.customer_id != customer.customer_ref:
        raise CaseError("The communication recipient does not match the case debit-account customer.", 422)
    if request.related_transaction_id and request.related_transaction_id != tx.reference:
        raise CaseError("The related transaction does not belong to this case.", 422)
    if request.direction != "OUTGOING":
        raise CaseError("Incoming customer responses are imported from the configured Gmail mailbox.", 422)
    if request.communication_type not in {"INCIDENT_NOTIFICATION", "RESOLUTION_STATUS_UPDATE"}:
        raise CaseError("Select a supported outgoing communication type.", 422)
    if request.direction == "OUTGOING" and (not request.subject or _unsafe_claim.search(request.subject + " " + request.body)):
        raise CaseError("Use review-in-progress wording without claims of a completed refund, reversal or correction.", 422)
    email_delivery = request.delivery_mode == "EMAIL"
    if email_delivery:
        if request.direction != "OUTGOING":
            raise CaseError("Only outgoing communications can be delivered by email.", 422)
        if role != "ADMIN":
            raise CaseError("Only ADMIN may send customer email.", 403)
        if mailer is None:
            raise CaseError("Outbound customer email is not configured.", 503)
        if not request.recipient_email:
            raise CaseError("Recipient email is required for email delivery.", 422)
        try:
            recipient_email = mailer.validate_recipient(request.recipient_email)
        except EmailConfigurationError as error:
            raise CaseError(str(error), 422) from error
    else:
        recipient_email = request.recipient_email
    related = None
    latest = db.scalar(select(CustomerCommunication).where(CustomerCommunication.case_id == case.id).order_by(CustomerCommunication.created_at.desc(), CustomerCommunication.id.desc()).limit(1))
    signature = (request.direction, request.communication_type, request.subject, request.body,
                 request.related_communication_id, recipient_email, not email_delivery)
    if latest and signature == (latest.direction, latest.communication_type, latest.subject, latest.body,
                                latest.related_communication_id, latest.recipient_email, latest.simulated):
        raise CaseError("This communication is already the latest item in the timeline.", 409)
    status = "EMAIL_QUEUED" if email_delivery else "SENT_SIMULATED"
    now = utc_now()
    row = CustomerCommunication(case_id=case.id, investigation_id=request.investigation_id,
        customer_id=customer.customer_ref, related_transaction_id=tx.reference, direction=request.direction,
        communication_type=request.communication_type, subject=request.subject.strip() if request.subject else None,
        body=request.body.strip(), recipient_email=recipient_email, status=status,
        related_communication_id=related.id if related else None, recorded_by=role,
        simulated=not email_delivery, created_at=now)
    db.add(row); db.flush()
    delivery = None
    if email_delivery:
        delivery = EmailDelivery(communication_id=row.id, recipient_email=recipient_email,
            message_id=mailer.message_id(row.id), provider="SMTP", status="PENDING",
            attempt_count=0, queued_at=now)
        db.add(delivery); db.flush()
    db.add(AuditEvent(action="CUSTOMER_NOTIFICATION_RECORDED", actor=role, reference=_case_ref(case.id), created_at=now,
                      details={"communicationId": row.id, "investigationId": request.investigation_id,
                               "direction": request.direction, "type": request.communication_type,
                               "recordOrigin": "BACKEND_PERSISTED", "simulated": not email_delivery,
                               "deliveryId": delivery.id if delivery else None}))
    db.commit()
    return (_deliver_email(db, case_id, row.id, mailer, role)
            if email_delivery else list_communications(db, case_id, request.investigation_id))


def serialize_assessment(row):
    return dict(assessmentId=row.id, caseId=_case_ref(row.case_id), investigationId=row.investigation_id,
                planId=row.plan_id, planVersion=row.plan_version, evaluatedAt=row.assessed_at.isoformat(),
                status=row.outcome, controls=deepcopy(row.check_results), policyVersion=row.policy_version,
                requiredApproverRole="Administrator" if row.outcome == "APPROVAL_REQUIRED" else None,
                customerSnapshotReference=row.verification.get("customerSnapshotReference"),
                evidenceSnapshotReference=row.verification.get("evidenceSnapshotReference"),
                verification=deepcopy(row.verification), isSimulated=False)


def list_assessments(db, case_id):
    case = get_case(db, case_id)
    rows = db.scalars(select(PolicyAssessment).where(PolicyAssessment.case_id == case.id)
                      .order_by(PolicyAssessment.assessed_at, PolicyAssessment.id)).all()
    return [serialize_assessment(row) for row in rows]


def assess_policy(db, case_id, plan_id, role):
    case = get_case(db, case_id)
    plan = db.get(ResolutionPlan, plan_id)
    if not plan or plan.case_id != case.id:
        raise CaseError("Resolution plan not found for this case.", 404)
    latest = db.scalar(select(ResolutionPlan).where(ResolutionPlan.case_id == case.id).order_by(ResolutionPlan.version.desc()).limit(1))
    accepted = _accepted(db, case_id, plan.investigation_id)
    try:
        current_fp = material_fingerprint(collect(db, case_id))
        accepted_fp = material_fingerprint(report_evidence(accepted.report))
        evidence_state = "CURRENT" if current_fp == accepted_fp else "INCONSISTENT"
    except Exception:
        db.rollback(); current_fp = accepted.evidence_fingerprint; evidence_state = "UNAVAILABLE"
    revision = _context_revision(db, case, plan.investigation_id)
    report = accepted.report
    rule = _matching_rule(report, plan.action_code)
    current = latest and latest.id == plan.id and revision == plan.customer_context_revision
    consistent = bool(rule and report.get("recommended_action_code") == plan.action_code)
    notice = db.scalar(select(func.count()).select_from(CustomerCommunication).outerjoin(
        EmailDelivery, EmailDelivery.communication_id == CustomerCommunication.id).where(
        CustomerCommunication.case_id == case.id, CustomerCommunication.investigation_id == plan.investigation_id,
        CustomerCommunication.direction == "OUTGOING", CustomerCommunication.communication_type == "INCIDENT_NOTIFICATION",
        or_(CustomerCommunication.simulated.is_(True), EmailDelivery.status == "SENT"))) or 0
    checks = [
        ("currency", "Resolution Plan Currency", "PASS" if current else "BLOCKED", "The plan is current and includes the latest customer context." if current else "The plan is superseded or omits newer customer context."),
        ("evidence", "Investigation Evidence", "PASS" if accepted else "BLOCKED", "An accepted investigation is linked to this plan."),
        ("financial", "Current Financial Verification", "PASS" if evidence_state == "CURRENT" and consistent else "BLOCKED" if evidence_state == "INCONSISTENT" else "REVIEW_REQUIRED", "Current source evidence matches the accepted financial assessment." if evidence_state == "CURRENT" and consistent else "Current evidence is unavailable or differs from the accepted snapshot."),
        ("action", "Action Eligibility", "PASS" if rule and consistent and case.status not in {"CLOSED", "RESOLVED"} else "BLOCKED", "The proposed review action matches the accepted findings." if rule and consistent else "The proposed action is unsupported or contradicts the accepted findings."),
        ("approval", "Approval Requirement", "APPROVAL_REQUIRED" if rule and rule["financial"] else "PASS" if rule else "BLOCKED", "Administrator review is required; no financial action is executed." if rule and rule["financial"] else "Authorised human review is required."),
        ("communication", "Customer Communication", "PASS" if not rule or not rule["financial"] or notice else "REVIEW_REQUIRED", "An incident notification is recorded with an accepted delivery state." if notice else "Send or record the required incident notification before forwarding this financial proposal."),
    ]
    controls = [dict(id=key, name=name, status=status, reason=reason) for key, name, status, reason in checks]
    outcome = next((candidate for candidate in ("BLOCKED", "REVIEW_REQUIRED", "APPROVAL_REQUIRED") if any(c["status"] == candidate for c in controls)), "ELIGIBLE")
    now = utc_now()
    verification = dict(state=evidence_state, checkedAt=now.isoformat() if evidence_state == "CURRENT" else None,
                        customerSnapshotReference=plan.customer_snapshot["reference"], evidenceSnapshotReference=report.get("evidence_snapshot_at"))
    row = PolicyAssessment(case_id=case.id, plan_id=plan.id, investigation_id=plan.investigation_id,
        plan_version=plan.version, policy_version=POLICY_VERSION, outcome=outcome, check_results=controls,
        evidence_fingerprint=current_fp, context_revision=revision, verification=verification,
        assessed_by=role, assessed_at=now)
    db.add(row); db.flush()
    db.add(AuditEvent(action="POLICY_ASSESSMENT_COMPLETED", actor=role, reference=_case_ref(case.id), created_at=now,
                      details={"assessmentId": row.id, "planId": plan.id, "planVersion": plan.version,
                               "outcome": outcome, "policyVersion": POLICY_VERSION, "recordOrigin": "BACKEND_PERSISTED"}))
    db.commit(); db.refresh(row)
    return serialize_assessment(row)
