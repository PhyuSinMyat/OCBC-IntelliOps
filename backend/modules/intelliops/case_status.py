"""Authoritative case progress from durable, authenticated workflow actions."""
from sqlalchemy import select

from .models import AuditEvent, ExceptionCase, ExceptionCaseAction

WORKABLE = {"OPEN", "IN_REVIEW", "IN_PROGRESS"}
TERMINAL = {"RESOLVED", "CLOSED"}


def _record_transition(db, case, status, role, now, source, reference):
    details = {"previousStatus": case.status, "status": status, "source": source, "reference": str(reference)}
    case.status = status
    case.updated_at = now
    db.add(ExceptionCaseAction(exception_id=case.id, action_type="CASE_STATUS_CHANGED",
                               actor=role, details=details, created_at=now))
    db.add(AuditEvent(action="CASE_STATUS_CHANGED", actor=role, reference=f"CASE-{case.id:06d}",
                      details=details, created_at=now))
    return case


def record_case_work(db, case, role, event, now):
    from .investigation_storage import InvestigationRecord
    from .service import CaseError

    if role not in {"ADMIN", "ANALYST"}:
        raise CaseError("Case work requires an authenticated analyst or administrator.", 403)
    if isinstance(event, InvestigationRecord) and event.case_id == case.id and event.status == "RUNNING" and event.created_by == role:
        source, reference = "INVESTIGATION_STARTED", event.request_id
    elif isinstance(event, ExceptionCaseAction) and event.exception_id == case.id and event.action_type == "NOTE_ADDED" and event.actor == role:
        source, reference = "REVIEW_NOTE_ADDED", event.id
    else:
        raise CaseError("A matching case work event is required.", 409)
    if case.status in {"OPEN", "IN_REVIEW"}:
        return _record_transition(db, case, "IN_PROGRESS", role, now, source, reference)
    return case


def plan_case_status_reconciliation(db):
    from .investigation_storage import InvestigationRecord

    investigations = {}
    for row in db.scalars(select(InvestigationRecord).order_by(InvestigationRecord.created_at, InvestigationRecord.request_id)):
        investigations[row.case_id] = row.request_id
    notes = {}
    for row in db.scalars(select(ExceptionCaseAction).where(ExceptionCaseAction.action_type == "NOTE_ADDED")
                           .order_by(ExceptionCaseAction.created_at, ExceptionCaseAction.id)):
        notes[row.exception_id] = row.id
    plan = []
    for case in db.scalars(select(ExceptionCase).order_by(ExceptionCase.id)):
        target, source, reference = case.status, None, None
        if case.status in WORKABLE:
            if case.id in investigations:
                target, source, reference = "IN_PROGRESS", "DURABLE_INVESTIGATION", investigations[case.id]
            elif case.id in notes:
                target, source, reference = "IN_PROGRESS", "REVIEW_NOTE_ADDED", notes[case.id]
        ambiguous = case.status not in {"OPEN", *TERMINAL} and source is None
        plan.append((case, target, source, reference, ambiguous))
    return plan


def reconcile_case_statuses(db, plan, now):
    changed = 0
    for case, target, source, reference, ambiguous in plan:
        if not ambiguous and case.status != target:
            _record_transition(db, case, target, "CASE_STATUS_RECONCILIATION", now, source, reference)
            changed += 1
    db.flush()
    return changed
