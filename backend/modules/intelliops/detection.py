"""Independent source-evidence detection; never called by the payment form."""
from datetime import timedelta
from decimal import Decimal
from sqlalchemy import select, or_
from modules.payment_processing.models import Transaction, PaymentInstruction
from modules.payment_processing.service import simulation_now, aware, reconciliation_seconds
from modules.core_banking.models import LedgerJournal, LedgerEntry, LedgerRecord
from modules.core_banking.service import valid_journals
from .models import ExceptionCase, AuditEvent, DetectionRule


def detect(db, role, now=None):
    now = now or simulation_now()
    payments = db.execute(select(Transaction, PaymentInstruction).outerjoin(PaymentInstruction, PaymentInstruction.transaction_id == Transaction.id)
                          .order_by(Transaction.id).with_for_update(of=Transaction)).all()
    journals = db.scalars(select(LedgerJournal)).all()
    entries = db.scalars(select(LedgerEntry)).all()
    valid = set(db.scalars(valid_journals()))
    legacy = db.scalars(select(LedgerRecord)).all()
    active = {c.detection_key for c in db.scalars(select(ExceptionCase).where(ExceptionCase.status.not_in(["RESOLVED", "CLOSED"])))}
    rules = {r.exception_type: r for r in db.scalars(select(DetectionRule))}
    first_references, created = {}, []
    for tx, instruction in payments:
        linked = [j for j in journals if j.payment_reference == tx.reference or j.source_transaction_id == tx.id]
        old_postings = [e for e in legacy if e.transaction_id == tx.id]
        cutoff = (aware(instruction.reconciliation_due_at) if instruction else None) or aware(tx.created_at) + timedelta(seconds=reconciliation_seconds())
        conditions = []
        original = first_references.setdefault(tx.payment_reference, tx.reference)
        if original != tx.reference:
            conditions.append(("Duplicate Transaction", "HIGH", {"originalReference": original, "businessReference": tx.payment_reference}))
        if tx.status == "FAILED":
            conditions.append(("Payment Processing Failure", "HIGH", {"failureCode": instruction.failure_code if instruction else None}))
        if tx.status == "COMPLETED" and now >= cutoff:
            if not linked and not old_postings:
                conditions.append(("Missing Ledger Posting", "HIGH", {"cutoff": cutoff.isoformat(), "journalReferences": []}))
            for journal in linked:
                if journal.payment_reference != tx.reference:
                    conditions.append(("Unmatched Transaction", "MEDIUM", {"journalReference": journal.journal_ref, "actualReference": journal.payment_reference, "expectedReference": tx.reference, "cutoff": cutoff.isoformat()}))
                elif journal.journal_id in valid:
                    debit = sum((e.amount for e in entries if e.journal_id == journal.journal_id and e.side == "Debit"), Decimal(0))
                    if debit != tx.amount:
                        conditions.append(("Amount Mismatch", "HIGH", {"journalReference": journal.journal_ref, "expectedAmount": str(tx.amount), "postedAmount": str(debit)}))
            if old_postings and sum((e.amount for e in old_postings), Decimal(0)) != tx.amount:
                conditions.append(("Amount Mismatch", "HIGH", {"legacyLedgerIds": [e.id for e in old_postings], "expectedAmount": str(tx.amount)}))
        for kind, severity, evidence in conditions:
            rule = rules.get(kind)
            if rule and not rule.enabled:
                continue
            key = f"{tx.id}:{kind}"
            if key in active:
                continue
            case = ExceptionCase(transaction_id=tx.id, rule_id=rule.id if rule else None, exception_type=kind, severity=severity, status="OPEN", detection_key=key,
                evidence={"transactionReference": tx.reference, "observedAt": now.isoformat(), **evidence}, created_at=now)
            db.add(case)
            db.flush()
            active.add(key)
            created.append(case.id)
            db.add(AuditEvent(action="EXCEPTION_DETECTED", actor=role, reference=f"CASE-{case.id:06d}",
                              details=case.evidence, created_at=now))
    db.add(AuditEvent(action="DETECTION_RUN", actor=role, reference="DETECTION", details={"createdCases": created}, created_at=now))
    db.flush()
    return created


def case_dtos(db, transaction_id=None):
    query = select(ExceptionCase, Transaction.reference).join(Transaction, Transaction.id == ExceptionCase.transaction_id)
    if transaction_id is not None:
        query = query.where(ExceptionCase.transaction_id == transaction_id)
    return [dict(id=f"CASE-{c.id:06d}", transactionId=reference, exceptionType=c.exception_type,
                 severity=c.severity, status=c.status, evidence=c.evidence or {}, createdAt=aware(c.created_at))
            for c, reference in db.execute(query.order_by(ExceptionCase.id.desc()))]
