"""Re-evaluate stored cases without running detection or replaying executions."""
from sqlalchemy import select

from modules.payment_processing.service import aware

from .detection import evaluate_severity_sources, pair_finding, read_detection_sources
from .models import AuditEvent, ExceptionCase, ExceptionCaseAction
from .rules import RULES, load_rules
from .severity import assess_severity


def plan_severity_backfill(db, now):
    policies = load_rules(db, now, read_only=True)
    rows, data = read_detection_sources(db)
    evaluations, systemic = evaluate_severity_sources(rows, data, policies, now)
    codes = {spec.exception_type: spec.code for spec in RULES}
    by_reference = {tx.reference: tx for tx, _ in rows}
    assessments, blocked = [], []
    for case in db.scalars(select(ExceptionCase).order_by(ExceptionCase.id)):
        tx = data["transactions"].get(case.transaction_id)
        code = codes.get(case.exception_type)
        if tx is None or code is None:
            blocked.append({"caseId": case.id, "reason": "Missing transaction" if tx is None else "Unsupported exception type"})
            continue
        evidence = evaluations[tx.id].get(code)
        if code == "DUPLICATE_TRANSACTION":
            related = (data["transactions"].get(case.related_transaction_id) if case.related_transaction_id is not None
                       else by_reference.get((case.evidence or {}).get("originalReference")))
            if related is not None and related.id != tx.id:
                evidence = pair_finding(related, data["instructions"][related.id], tx,
                                        data["instructions"][tx.id], data, policies[code][1])
        assessment = assess_severity(code, evidence or {}, systemic.get((code, tx.id)))
        if evidence is None:
            assessment = {**assessment, "reasonCode": "CURRENT_EVIDENCE_INCONCLUSIVE",
                          "reason": "Current source records do not substantiate the original finding or establish safe containment."}
        assessment["assessmentStage"] = "REASSESSMENT"
        assessments.append((case, assessment))
    return assessments, blocked


def apply_severity_backfill(db, assessments, now, actor):
    """Only update the existing severity column and append change audit records."""
    changed = 0
    for case, assessment in assessments:
        if case.severity == assessment["severity"]:
            continue
        details = {"previousSeverity": case.severity, "severityAssessment": assessment}
        case.severity = assessment["severity"]
        db.add(ExceptionCaseAction(exception_id=case.id, action_type="SEVERITY_RECALCULATED",
                                   actor=actor, details=details, created_at=aware(now)))
        db.add(AuditEvent(action="SEVERITY_RECALCULATED", actor=actor,
                          reference=f"CASE-{case.id:06d}", details=details, created_at=aware(now)))
        changed += 1
    db.flush()
    return changed
