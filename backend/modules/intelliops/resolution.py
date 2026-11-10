from decimal import Decimal
from uuid import uuid4
from sqlalchemy import or_, select
from modules.core_banking.models import Account, LedgerEntry, LedgerJournal, LedgerRecord
from modules.core_banking.service import account_query, valid_journals
from modules.payment_processing.models import PaymentInstruction, ProcessingEvent, Transaction
from modules.payment_processing.service import simulation_now
from .models import (AuditEvent, ExceptionCaseAction, ExceptionResolution,
                     LedgerPostingRemediation)
from .service import CaseError, get_case


def context(db, case):
    tx = db.get(Transaction, case.transaction_id)
    instruction = db.scalar(select(PaymentInstruction).where(PaymentInstruction.transaction_id == tx.id))
    if instruction is None:
        raise CaseError("Payment ownership data is unavailable; automatic resolution is unsafe.", 409)
    sender, receiver = db.get(Account, instruction.sender_account_id), db.get(Account, instruction.receiver_account_id)
    if not sender or not receiver or sender.currency != tx.currency or receiver.currency != tx.currency:
        raise CaseError("Payment account or currency evidence is inconsistent; automatic resolution is unsafe.", 409)
    return tx, instruction, sender, receiver


def journal(db, tx, sender, receiver, amount, now, purpose):
    if amount <= 0:
        raise CaseError("The calculated corrective amount must be positive.", 409)
    ref = f"JRN-REM-{uuid4().hex[:16].upper()}"
    result = LedgerJournal(journal_ref=ref, source_transaction_id=tx.id, payment_reference=tx.reference,
                           currency=tx.currency, status="Posted", posted_at=now)
    db.add(result)
    db.flush()
    for account, side in ((sender, "Debit"), (receiver, "Credit")):
        db.add(LedgerEntry(entry_ref=f"{ref}-{side[0]}", journal_id=result.journal_id,
                           account_id=account.account_id, side=side, amount=amount, currency=tx.currency,
                           description=f"{purpose} - {'outgoing' if side == 'Debit' else 'incoming'} transfer",
                           posted=True))
    return result


def replayed(db, case, key):
    records = [db.scalar(select(ExceptionResolution).where(ExceptionResolution.idempotency_key == key)),
               db.scalar(select(LedgerPostingRemediation).where(LedgerPostingRemediation.idempotency_key == key))]
    for record in records:
        if record and record.exception_id != case.id:
            raise CaseError("Idempotency key is already used by another resolution.", 409)
    existing = (db.scalar(select(ExceptionResolution).where(ExceptionResolution.exception_id == case.id)) or
                db.scalar(select(LedgerPostingRemediation).where(LedgerPostingRemediation.exception_id == case.id)))
    if existing and existing.idempotency_key != key:
        raise CaseError("This case already has a resolution under a different idempotency key.", 409)
    return existing is not None


def finish(db, case, kind, key, role, now, summary, details, corrective_journal=None,
           action="REMEDIATION_COMPLETED", audit="EXCEPTION_REMEDIATED"):
    db.add(ExceptionResolution(exception_id=case.id, resolution_type=kind, idempotency_key=key,
                               journal_id=corrective_journal.journal_id if corrective_journal else None,
                               status="COMPLETED", details=details, created_by=role, created_at=now))
    case.status, case.updated_at, case.resolved_at, case.resolution_summary = "RESOLVED", now, now, summary
    db.add(ExceptionCaseAction(exception_id=case.id, action_type=action, actor=role, details=details, created_at=now))
    db.add(ExceptionCaseAction(exception_id=case.id, action_type="RESOLVED", actor=role,
                               details={"summary": summary}, created_at=now))
    db.add(AuditEvent(action=audit, actor=role, reference=f"CASE-{case.id:06d}", details=details, created_at=now))


def remediate_exception(db, case_id, request, role, now=None):
    now = now or simulation_now()
    case = get_case(db, case_id, lock=True)
    if replayed(db, case, request.idempotency_key):
        return case
    if case.status not in ("OPEN", "IN_REVIEW"):
        raise CaseError("Only an open or in-review case can be resolved.", 409)
    tx, instruction, sender, receiver = context(db, case)

    if case.exception_type == "Missing Ledger Posting":
        existing = db.scalar(select(LedgerJournal).where(or_(LedgerJournal.source_transaction_id == tx.id,
                                                             LedgerJournal.payment_reference == tx.reference)))
        legacy = db.scalar(select(LedgerRecord).where(LedgerRecord.transaction_id == tx.id))
        if existing or legacy:
            raise CaseError("A ledger posting arrived after detection; resolution stopped to prevent a duplicate.", 409)
        posted = journal(db, tx, sender, receiver, tx.amount, now, "Missing posting remediation")
        db.add(LedgerPostingRemediation(exception_id=case.id, journal_id=posted.journal_id,
            idempotency_key=request.idempotency_key, status="POSTED", created_by=role, created_at=now))
        summary = f"Balanced corrective journal {posted.journal_ref} posted from verified payment evidence."
        details = {"journalReference": posted.journal_ref, "amount": str(tx.amount), "currency": tx.currency, "note": request.note}
        case.status, case.updated_at, case.resolved_at, case.resolution_summary = "RESOLVED", now, now, summary
        db.add(ExceptionCaseAction(exception_id=case.id, action_type="REMEDIATION_POSTED", actor=role, details=details, created_at=now))
        db.add(ExceptionCaseAction(exception_id=case.id, action_type="RESOLVED", actor=role, details={"summary": summary}, created_at=now))
        db.add(AuditEvent(action="MISSING_LEDGER_REMEDIATED", actor=role, reference=f"CASE-{case.id:06d}", details=details, created_at=now))
        db.add(ProcessingEvent(transaction_id=tx.id, event_type="LEDGER_REMEDIATED", status="COMPLETED", details=summary, created_at=now))

    elif case.exception_type == "Amount Mismatch":
        valid_ids = set(db.scalars(valid_journals()))
        journals = db.scalars(select(LedgerJournal).where(or_(LedgerJournal.source_transaction_id == tx.id,
                                                              LedgerJournal.payment_reference == tx.reference))).all()
        ids = {j.journal_id for j in journals if j.payment_reference == tx.reference and j.journal_id in valid_ids}
        amount = sum(db.scalars(select(LedgerEntry.amount).where(LedgerEntry.journal_id.in_(ids),
                                                                 LedgerEntry.side == "Debit")), Decimal(0))
        shortfall = tx.amount - amount
        if shortfall <= 0:
            raise CaseError("No positive posting shortfall remains; automatic adjustment was stopped.", 409)
        posted = journal(db, tx, sender, receiver, shortfall, now, "Amount mismatch adjustment")
        summary = f"Adjustment journal {posted.journal_ref} posted the {tx.currency} {shortfall} shortfall."
        details = {"journalReference": posted.journal_ref, "expectedAmount": str(tx.amount),
                   "previouslyPostedAmount": str(amount), "adjustmentAmount": str(shortfall),
                   "currency": tx.currency, "note": request.note}
        finish(db, case, "AMOUNT_SHORTFALL_ADJUSTED", request.idempotency_key, role, now, summary,
               details, posted, "ADJUSTMENT_POSTED", "AMOUNT_MISMATCH_REMEDIATED")
        db.add(ProcessingEvent(transaction_id=tx.id, event_type="LEDGER_ADJUSTMENT_POSTED", status="COMPLETED", details=summary, created_at=now))

    elif case.exception_type == "Duplicate Transaction":
        if instruction.original_payment_id is None:
            raise CaseError("The duplicate has no verified original payment link; automatic rejection is unsafe.", 409)
        tx.status, instruction.completed_at = "REJECTED", now
        instruction.failure_code = "DUPLICATE_REJECTED"
        instruction.failure_description = "Duplicate instruction rejected; the original posting remains authoritative."
        summary = "Duplicate instruction rejected without an additional ledger posting."
        details = {"originalPaymentId": str(instruction.original_payment_id), "ledgerEffect": "NONE", "note": request.note}
        finish(db, case, "DUPLICATE_REJECTED", request.idempotency_key, role, now, summary,
               details, action="DUPLICATE_REJECTED", audit="DUPLICATE_REMEDIATED")
        db.add(ProcessingEvent(transaction_id=tx.id, event_type="DUPLICATE_REJECTED", status="REJECTED",
                               error_code="DUPLICATE_REJECTED", details=summary, created_at=now))

    elif case.exception_type == "Payment Processing Failure":
        existing = db.scalar(select(LedgerJournal).where(or_(LedgerJournal.source_transaction_id == tx.id,
                                                             LedgerJournal.payment_reference == tx.reference)))
        if existing:
            raise CaseError("A ledger journal already exists; retry stopped to prevent a duplicate posting.", 409)
        if sender.status != "Active" or receiver.status != "Active":
            raise CaseError("Both payment accounts must still be Active before retry.", 409)
        query, _ = account_query()
        if db.execute(query.where(Account.account_id == sender.account_id)).one().current < tx.amount:
            raise CaseError("Sender has insufficient available funds for a safe retry.", 409)
        posted = journal(db, tx, sender, receiver, tx.amount, now, "Processing failure retry")
        previous = instruction.failure_code
        tx.status, instruction.completed_at = "COMPLETED", now
        instruction.failure_code = instruction.failure_description = None
        summary = f"Failed instruction retried successfully and posted in {posted.journal_ref}."
        details = {"journalReference": posted.journal_ref, "amount": str(tx.amount), "currency": tx.currency,
                   "previousFailureCode": previous, "note": request.note}
        finish(db, case, "PROCESSING_RETRIED", request.idempotency_key, role, now, summary,
               details, posted, "PROCESSING_RETRIED", "PROCESSING_FAILURE_REMEDIATED")
        db.add(ProcessingEvent(transaction_id=tx.id, event_type="PROCESSING_RETRY_COMPLETED", status="COMPLETED", details=summary, created_at=now))
    else:
        raise CaseError("This exception type does not have an automated resolution policy.", 409)
    db.flush()
    return case
