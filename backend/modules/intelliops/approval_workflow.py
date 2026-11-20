"""Persistent approval queue with deterministic freshness checks."""
from decimal import Decimal, InvalidOperation

from sqlalchemy import select

from shared.timestamps import utc_now
from .investigation_router import collect
from .investigation_storage import InvestigationRecord, material_fingerprint, report_evidence
from .models import AuditEvent, ExceptionCase
from .resolution_models import ApprovalRequest, CustomerCommunication, EmailDelivery, PolicyAssessment, ResolutionPlan
from .resolution_workflow import ACTION_RULES, POLICY_VERSION, serialize_assessment, serialize_plan
from .service import CaseError, get_case


def _case_ref(case_id):
    return f"CASE-{case_id:06d}"


def _readiness(db, assessment):
    case = get_case(db, _case_ref(assessment.case_id))
    plan = db.get(ResolutionPlan, assessment.plan_id)
    if not plan or plan.case_id != case.id:
        raise CaseError("The linked resolution plan is unavailable.", 409)
    latest_plan = db.scalar(select(ResolutionPlan).where(
        ResolutionPlan.case_id == case.id).order_by(ResolutionPlan.version.desc()).limit(1))
    latest_assessment = db.scalar(select(PolicyAssessment).where(
        PolicyAssessment.case_id == case.id).order_by(
            PolicyAssessment.assessed_at.desc(), PolicyAssessment.id.desc()).limit(1))
    accepted = db.scalar(select(InvestigationRecord).where(
        InvestigationRecord.case_id == case.id,
        InvestigationRecord.investigation_id == assessment.investigation_id,
        InvestigationRecord.status == "ACCEPTED"))
    if assessment.policy_version != POLICY_VERSION or assessment.outcome != "APPROVAL_REQUIRED":
        raise CaseError("Re-evaluate the current policy before requesting Administrator approval.", 409)
    if latest_assessment is None or latest_assessment.id != assessment.id:
        raise CaseError("A newer policy assessment exists. Submit that current assessment instead.", 409)
    if latest_plan is None or latest_plan.id != plan.id or plan.version != assessment.plan_version:
        raise CaseError("The resolution plan is no longer current. Reassess the latest plan.", 409)
    if case.status in {"CLOSED", "RESOLVED"}:
        raise CaseError("This case is already closed or resolved.", 409)
    if not accepted or not accepted.report:
        raise CaseError("The accepted investigation is unavailable.", 409)
    controls = assessment.check_results or []
    approval = next((item for item in controls if item.get("id") == "approval"), None)
    others = [item for item in controls if item.get("id") != "approval"]
    if not approval or approval.get("status") != "APPROVAL_REQUIRED" or not others or any(
            item.get("status") not in {"PASS", "NOT_REQUIRED"} for item in others):
        raise CaseError("All policy prerequisites must pass before requesting approval.", 409)
    try:
        current_fingerprint = material_fingerprint(collect(db, _case_ref(case.id)))
    except Exception as error:
        raise CaseError("Current source evidence could not be revalidated. Retry before requesting approval.", 409) from error
    accepted_fingerprint = material_fingerprint(report_evidence(accepted.report))
    if not (assessment.verification or {}).get("state") == "CURRENT" or not (
            current_fingerprint == accepted_fingerprint == assessment.evidence_fingerprint == plan.evidence_fingerprint):
        raise CaseError("Current source evidence changed. Reinvestigate and reassess before requesting approval.", 409)
    from .resolution_workflow import _context_revision
    revision = _context_revision(db, case, plan.investigation_id)
    if revision != assessment.context_revision or revision != plan.customer_context_revision:
        raise CaseError("Newer customer context exists. Generate a current plan and re-evaluate policy.", 409)
    return case, plan


def _money(currency, value):
    try:
        return f"{currency} {Decimal(str(value)):,.2f}" if currency else None
    except (InvalidOperation, ValueError):
        return None


def _financial_metrics(report):
    impact = report.get("financial_impact") or {}
    evidence = report.get("supporting_evidence") or {}
    original = evidence.get("original") or {}
    currency = original.get("currency")
    metrics = []
    if report.get("exception_type") == "AMOUNT_MISMATCH":
        for label, key, source in (
            ("Instructed amount", "expectedAmount", "Source payment instruction"),
            ("Posted amount", "postedAmount", "Aligned verified ledger journal"),
            ("Posting discrepancy", "absoluteDifference", "Difference from the instructed amount")):
            value = _money(currency, impact.get(key))
            if value:
                metrics.append(dict(label=label, value=value, source=source,
                                    warning=key == "absoluteDifference" and Decimal(str(impact[key])) != 0))
        return metrics
    if report.get("exception_type") == "MISSING_LEDGER_POSTING":
        value = _money(currency, impact.get("expectedAmount"))
        if value:
            metrics.append(dict(label="Expected payment", value=value, source="Source payment instruction", warning=False))
        metrics.append(dict(label="Linked journals", value=str(impact.get("linkedJournalCount", 0)),
                            source="Verified ledger records", warning=impact.get("linkedJournalCount", 0) == 0))
        return metrics
    try:
        intended = Decimal(original["amountCents"]) / 100
        posted = Decimal(str((impact.get("validDebitTotals") or {})[currency]))
    except (KeyError, TypeError, InvalidOperation):
        intended = posted = None
    if intended is not None and posted is not None:
        return [
            dict(label="Intended transfer", value=_money(currency, intended), source="Verified source figure", warning=False),
            dict(label="Posted transfer movement", value=_money(currency, posted), source="Verified source figure", warning=False),
            dict(label="Apparent duplicate excess", value=_money(currency, posted - intended), source="Apparent impact only", warning=posted > intended),
        ]
    totals = impact.get("validDebitTotals") or {}
    return [dict(label="Verified debit total", value=_money(code, value), source="Verified source figure", warning=False)
            for code, value in sorted(totals.items()) if _money(code, value)]


def _detail_context(db, row):
    accepted = db.scalar(select(InvestigationRecord).where(
        InvestigationRecord.case_id == row.case_id,
        InvestigationRecord.investigation_id == row.investigation_id,
        InvestigationRecord.status == "ACCEPTED"))
    communications = db.scalars(select(CustomerCommunication).where(
        CustomerCommunication.case_id == row.case_id,
        CustomerCommunication.investigation_id == row.investigation_id,
        CustomerCommunication.simulated.is_(False)).order_by(
            CustomerCommunication.created_at, CustomerCommunication.id)).all()
    delivered_ids = set(db.scalars(select(EmailDelivery.communication_id).where(
        EmailDelivery.communication_id.in_([item.id for item in communications]),
        EmailDelivery.status == "SENT")).all()) if communications else set()
    responses_in_plan = (db.get(ResolutionPlan, row.plan_id).customer_snapshot or {}).get("responses", [])
    response_ids = {item.get("id") for item in responses_in_plan if isinstance(item, dict)}
    responses = [dict(id=item.id, communicationType=item.communication_type,
                      subject=item.subject, body=item.body, receivedAt=item.created_at.isoformat(),
                      includedInPlan=item.id in response_ids)
                 for item in communications if item.direction == "INCOMING"]
    notifications = [item for item in communications
                     if item.direction == "OUTGOING" and item.communication_type == "INCIDENT_NOTIFICATION"
                     and item.id in delivered_ids]
    return dict(
        financialMetrics=_financial_metrics(accepted.report) if accepted and accepted.report else [],
        customerContext=dict(notificationCount=len(notifications), responseCount=len(responses), responses=responses))


def serialize_request(row, assessment=None, plan=None, case=None, detail=None):
    assessment = assessment or row.__dict__.get("_assessment")
    plan = plan or row.__dict__.get("_plan")
    decision = None if row.status == "PENDING_APPROVAL" else dict(
        actingRole=row.decided_by, decidedAt=row.decided_at.isoformat(), reason=row.decision_reason)
    return dict(
        requestId=row.id, caseId=_case_ref(row.case_id), assessmentId=row.assessment_id,
        planId=row.plan_id, investigationId=row.investigation_id, planVersion=row.plan_version,
        proposedAction=row.proposed_action,
        proposedActionLabel=(ACTION_RULES.get(row.proposed_action) or {}).get("label")
            if isinstance(ACTION_RULES.get(row.proposed_action), dict) else None,
        customerSnapshotReference=row.customer_snapshot_reference,
        requiredApproverRole=row.required_approver_role, status=row.status,
        submittedBy=row.requested_by, submittedAt=row.requested_at.isoformat(), decision=decision,
        exceptionType=case.exception_type if case else None, caseStatus=case.status if case else None,
        plan=serialize_plan(plan) if plan else None,
        assessment=serialize_assessment(assessment) if assessment else None,
        financialMetrics=(detail or {}).get("financialMetrics", []),
        customerContext=(detail or {}).get("customerContext"),
        isSimulated=False, persistence="BACKEND_DATABASE")


def _hydrate(db, row):
    return serialize_request(row, db.get(PolicyAssessment, row.assessment_id),
                             db.get(ResolutionPlan, row.plan_id), get_case(db, _case_ref(row.case_id)),
                             _detail_context(db, row))


def list_requests(db, status=None):
    query = select(ApprovalRequest, PolicyAssessment, ResolutionPlan, ExceptionCase).join(
        PolicyAssessment, PolicyAssessment.id == ApprovalRequest.assessment_id).join(
        ResolutionPlan, ResolutionPlan.id == ApprovalRequest.plan_id).join(
        ExceptionCase, ExceptionCase.id == ApprovalRequest.case_id)
    if status:
        query = query.where(ApprovalRequest.status == status)
    rows = db.execute(query.order_by(
        ApprovalRequest.requested_at.desc(), ApprovalRequest.id.desc())).all()
    return [serialize_request(request, assessment, plan, case)
            for request, assessment, plan, case in rows]


def get_request(db, request_id):
    row = db.get(ApprovalRequest, request_id)
    if not row:
        raise CaseError("Approval request not found.", 404)
    return _hydrate(db, row)


def create_request(db, assessment_id, role):
    existing = db.scalar(select(ApprovalRequest).where(ApprovalRequest.assessment_id == assessment_id))
    if existing:
        return _hydrate(db, existing)
    assessment = db.get(PolicyAssessment, assessment_id)
    if not assessment:
        raise CaseError("Policy assessment not found.", 404)
    case, plan = _readiness(db, assessment)
    now = utc_now()
    row = ApprovalRequest(
        case_id=case.id, assessment_id=assessment.id, plan_id=plan.id,
        investigation_id=assessment.investigation_id, plan_version=plan.version,
        proposed_action=plan.action_code,
        customer_snapshot_reference=plan.customer_snapshot["reference"],
        required_approver_role="Administrator", status="PENDING_APPROVAL",
        requested_by=role, requested_at=now)
    db.add(row); db.flush()
    db.add(AuditEvent(action="APPROVAL_REQUEST_SUBMITTED", actor=role,
        reference=_case_ref(case.id), created_at=now, details={
            "requestId": row.id, "assessmentId": assessment.id, "planId": plan.id,
            "planVersion": plan.version, "recordOrigin": "BACKEND_PERSISTED"}))
    db.commit(); db.refresh(row)
    return serialize_request(row, assessment, plan, case, _detail_context(db, row))


def decide_request(db, request_id, decision, reason, role):
    if role != "ADMIN":
        raise CaseError("Only ADMIN may decide approval requests.", 403)
    row = db.scalar(select(ApprovalRequest).where(
        ApprovalRequest.id == request_id).with_for_update())
    if not row:
        raise CaseError("Approval request not found.", 404)
    if row.status != "PENDING_APPROVAL":
        raise CaseError("This approval request already has a final decision.", 409)
    assessment = db.get(PolicyAssessment, row.assessment_id)
    case, plan = _readiness(db, assessment)
    now = utc_now()
    row.status = decision
    row.decided_by = role
    row.decided_at = now
    row.decision_reason = reason.strip()
    db.add(AuditEvent(action=f"APPROVAL_REQUEST_{decision}", actor=role,
        reference=_case_ref(case.id), created_at=now, details={
            "requestId": row.id, "assessmentId": row.assessment_id, "planId": row.plan_id,
            "planVersion": row.plan_version, "decisionReason": row.decision_reason,
            "financialActionExecuted": False, "recordOrigin": "BACKEND_PERSISTED"}))
    db.commit(); db.refresh(row)
    return serialize_request(row, assessment, plan, case, _detail_context(db, row))
