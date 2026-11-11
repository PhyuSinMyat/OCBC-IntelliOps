from uuid import uuid4
from sqlalchemy import or_, select
from modules.core_banking.models import Account, LedgerEntry, LedgerJournal, LedgerRecord
from modules.payment_processing.models import PaymentInstruction, ProcessingEvent, Transaction
from modules.payment_processing.service import aware, simulation_now
from .models import AuditEvent, ExceptionCase, ExceptionCaseAction, ExceptionResolution, LedgerPostingRemediation


class CaseError(ValueError):
    def __init__(self, message, status=422):
        super().__init__(message)
        self.status = status


def parse_case_id(case_id):
    value = case_id.upper().removeprefix("CASE-")
    if not value.isdigit():
        raise CaseError("Exception case not found.", 404)
    return int(value)


def get_case(db, case_id, lock=False):
    from sqlalchemy.orm import defer
    from shared.schema import capabilities
    query = select(ExceptionCase).where(ExceptionCase.id == parse_case_id(case_id))
    if not capabilities(db)['cases']:
        query = query.options(defer(ExceptionCase.related_transaction_id))
    case = db.scalar(query.with_for_update() if lock else query)
    if case is None:
        raise CaseError("Exception case not found.", 404)
    return case


def case_detail(db, case):
    tx = db.get(Transaction, case.transaction_id)
    resolution = db.scalar(select(ExceptionResolution).where(ExceptionResolution.exception_id == case.id))
    legacy = db.scalar(select(LedgerPostingRemediation).where(LedgerPostingRemediation.exception_id == case.id))
    record = resolution or legacy
    journal = db.get(LedgerJournal, record.journal_id) if record and record.journal_id else None
    actions = db.scalars(select(ExceptionCaseAction).where(ExceptionCaseAction.exception_id == case.id)
                         .order_by(ExceptionCaseAction.created_at, ExceptionCaseAction.id)).all()
    from shared.schema import capabilities
    related_id = case.related_transaction_id if capabilities(db)['cases'] else None
    related = db.get(Transaction, related_id) if related_id else None
    return dict(id=f"CASE-{case.id:06d}", transactionId=tx.reference,
                relatedTransactionId=related.reference if related else (case.evidence or {}).get('originalReference'), exceptionType=case.exception_type,
                severity=case.severity, status=case.status, evidence=case.evidence or {},
                createdAt=aware(case.created_at), updatedAt=aware(case.updated_at),
                resolvedAt=aware(case.resolved_at), resolutionSummary=case.resolution_summary,
                remediation=(dict(id=record.id,
                                  type=resolution.resolution_type if resolution else "MISSING_LEDGER_POSTED",
                                  status=record.status, journalReference=journal.journal_ref if journal else None,
                                  details=resolution.details if resolution else {}, createdBy=record.created_by,
                                  createdAt=aware(record.created_at)) if record else None),
                timeline=[dict(id=a.id, actionType=a.action_type, actor=a.actor,
                               details=a.details, createdAt=aware(a.created_at)) for a in actions])


def add_note(db, case_id, note, role, now=None):
    now = now or simulation_now()
    case = get_case(db, case_id, lock=True)
    if case.status in ("RESOLVED", "CLOSED"):
        raise CaseError("Notes cannot be added after a case is resolved or closed.", 409)
    case.status = "IN_REVIEW"
    case.updated_at = now
    db.add(ExceptionCaseAction(exception_id=case.id, action_type="NOTE_ADDED", actor=role,
                               details={"note": note.strip()}, created_at=now))
    db.add(AuditEvent(action="EXCEPTION_NOTE_ADDED", actor=role, reference=f"CASE-{case.id:06d}",
                      details={"note": note.strip()}, created_at=now))
    db.flush()
    return case


def remediate_missing_posting(db, case_id, request, role, now=None):
    now = now or simulation_now()
    case = get_case(db, case_id, lock=True)
    prior_key = db.scalar(select(LedgerPostingRemediation).where(
        LedgerPostingRemediation.idempotency_key == request.idempotency_key))
    if prior_key and prior_key.exception_id != case.id:
        raise CaseError("Idempotency key is already used by another remediation.", 409)
    prior_case = db.scalar(select(LedgerPostingRemediation).where(
        LedgerPostingRemediation.exception_id == case.id))
    if prior_case:
        if prior_case.idempotency_key != request.idempotency_key:
            raise CaseError("This case already has a remediation under a different idempotency key.", 409)
        return case
    if case.exception_type != "Missing Ledger Posting":
        raise CaseError("Only a Missing Ledger Posting case can use this remediation.", 409)
    if case.status not in ("OPEN", "IN_REVIEW"):
        raise CaseError("Only an open or in-review case can be remediated.", 409)
    tx = db.get(Transaction, case.transaction_id)
    instruction = db.scalar(select(PaymentInstruction).where(PaymentInstruction.transaction_id == tx.id))
    if instruction is None:
        raise CaseError("Payment ownership data is unavailable; automatic remediation is unsafe.", 409)
    existing = db.scalar(select(LedgerJournal).where(or_(LedgerJournal.source_transaction_id == tx.id,
                                                         LedgerJournal.payment_reference == tx.reference)))
    legacy = db.scalar(select(LedgerRecord).where(LedgerRecord.transaction_id == tx.id))
    if existing or legacy:
        raise CaseError("A ledger posting arrived after detection; remediation was stopped to prevent a duplicate.", 409)
    sender = db.get(Account, instruction.sender_account_id)
    receiver = db.get(Account, instruction.receiver_account_id)
    if not sender or not receiver or sender.currency != tx.currency or receiver.currency != tx.currency:
        raise CaseError("Payment account or currency evidence is inconsistent; automatic remediation is unsafe.", 409)
    suffix = uuid4().hex[:16].upper()
    journal = LedgerJournal(journal_ref=f"JRN-REM-{suffix}", source_transaction_id=tx.id,
                            payment_reference=tx.reference, currency=tx.currency,
                            status="Posted", posted_at=now)
    db.add(journal)
    db.flush()
    for account, side in ((sender, "Debit"), (receiver, "Credit")):
        db.add(LedgerEntry(entry_ref=f"{journal.journal_ref}-{side[0]}", journal_id=journal.journal_id,
                           account_id=account.account_id, side=side, amount=tx.amount, currency=tx.currency,
                           description="Missing posting remediation - outgoing transfer" if side == "Debit"
                           else "Missing posting remediation - incoming transfer", posted=True))
    remediation = LedgerPostingRemediation(exception_id=case.id, journal_id=journal.journal_id,
        idempotency_key=request.idempotency_key, status="POSTED", created_by=role, created_at=now)
    db.add(remediation)
    summary = f"Balanced corrective journal {journal.journal_ref} posted from verified payment evidence."
    case.status, case.updated_at, case.resolved_at, case.resolution_summary = "RESOLVED", now, now, summary
    details = {"journalReference": journal.journal_ref, "amount": str(tx.amount), "currency": tx.currency,
               "note": request.note}
    db.add(ExceptionCaseAction(exception_id=case.id, action_type="REMEDIATION_POSTED", actor=role,
                               details=details, created_at=now))
    db.add(ExceptionCaseAction(exception_id=case.id, action_type="RESOLVED", actor=role,
                               details={"summary": summary}, created_at=now))
    db.add(ProcessingEvent(transaction_id=tx.id, event_type="LEDGER_REMEDIATED", status="COMPLETED",
                           details=summary, created_at=now))
    db.add(AuditEvent(action="MISSING_LEDGER_REMEDIATED", actor=role, reference=f"CASE-{case.id:06d}",
                      details=details, created_at=now))
    db.flush()
    return case


def close_case(db, case_id, note, role, now=None):
    now = now or simulation_now()
    case = get_case(db, case_id, lock=True)
    if case.status == "CLOSED":
        return case
    if case.status != "RESOLVED":
        raise CaseError("A case must be resolved before it can be closed.", 409)
    case.status, case.updated_at = "CLOSED", now
    details = {"note": note} if note else {}
    db.add(ExceptionCaseAction(exception_id=case.id, action_type="CLOSED", actor=role,
                               details=details, created_at=now))
    db.add(AuditEvent(action="EXCEPTION_CLOSED", actor=role, reference=f"CASE-{case.id:06d}",
                      details=details, created_at=now))
    db.flush()
    return case
