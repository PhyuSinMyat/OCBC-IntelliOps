import hashlib
import json
import os
from datetime import datetime, timezone, timedelta
from decimal import Decimal
from uuid import uuid4
from sqlalchemy import select, or_
from .models import Transaction, ProcessingEvent, PaymentInstruction, PaymentRequestHistory, ExceptionBatchItem
from modules.core_banking.models import Account, Customer, LedgerJournal, LedgerEntry
from modules.core_banking.service import account_balance, post_normal_journal
from modules.intelliops.models import AuditEvent


class PaymentError(ValueError):
    def __init__(self, message, status=422):
        super().__init__(message)
        self.status = status


def operational_audit_details(details):
    allowed = {'source', 'paymentReferences', 'transactionReferences', 'countPerType', 'createdCases',
        'transactionReference', 'originalReference', 'observedAt', 'ruleCode', 'ruleVersion', 'ruleConfiguration',
        'evidenceFingerprint', 'financialAssessment', 'classification', 'rootCause', 'note', 'summary',
        'journalReference', 'amount', 'currency', 'ledgerEffect', 'financialChangesRolledBack'}
    return {key: value for key, value in (details or {}).items() if key in allowed}


def simulation_now():
    configured = os.getenv("INTELLIOPS_SIMULATION_TIME")
    return aware(datetime.fromisoformat(configured.replace("Z", "+00:00"))).astimezone(timezone.utc) if configured else datetime.now(timezone.utc)


def reconciliation_seconds():
    return max(1, int(os.getenv("INTELLIOPS_RECONCILIATION_SECONDS", "60")))


def aware(value):
    return value.replace(tzinfo=value.tzinfo or timezone.utc) if value else None


def fingerprint(request, scenario):
    payload = request.model_dump(exclude={"idempotency_key", "scenario_code", "duplicate_scenario", "run_key"}, mode="json")
    payload["amount"] = str(request.amount.quantize(Decimal("0.01")))
    payload["scenario_code"] = scenario
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()


def event(db, tx, kind, status, message, now, code=None, request_id=None):
    if request_id is None:
        request_id = db.scalar(select(PaymentRequestHistory.request_id).join(PaymentInstruction,
            PaymentInstruction.payment_id == PaymentRequestHistory.payment_id).where(PaymentInstruction.transaction_id == tx.id)
            .order_by(PaymentRequestHistory.received_at.desc()))
    db.add(ProcessingEvent(transaction_id=tx.id, request_id=request_id, event_type=kind, status=status,
                           details=json.dumps(message, sort_keys=True) if isinstance(message, dict) else message,
                           error_code=code, created_at=now))


def record_request(db, instruction, key, now, *, anchor=None, origin='CUSTOMER', retry=None, authorization=None, correlation=None):
    anchor = anchor or instruction
    if anchor.original_payment_id is not None:
        raise PaymentError('Business instruction anchor is not canonical.')
    source, target = db.get(Transaction, anchor.transaction_id), db.get(Transaction, instruction.transaction_id)
    if (anchor.sender_account_id, anchor.receiver_account_id, source.amount, source.currency) != (
            instruction.sender_account_id, instruction.receiver_account_id, target.amount, target.currency):
        raise PaymentError('Request conflicts with its business instruction.')
    if retry and (origin != 'SYSTEM' or retry.business_instruction_id != anchor.payment_id):
        raise PaymentError('Retry must reference the same instruction.')
    row = PaymentRequestHistory(business_instruction_id=anchor.payment_id, payment_id=instruction.payment_id,
        origin=origin, retry_of_request_id=retry.request_id if retry else None, submitted_idempotency_key=key,
        authorization_id=authorization, correlation_id=correlation, received_at=now)
    db.add(row)
    db.flush()
    return row


def create_payment(db, request, role, scenario="NORMAL", now=None, *, _on_accepted=None):
    if scenario != "NORMAL" and role != "ADMIN":
        raise PaymentError("Only ADMIN may inject exception scenarios.", 403)
    now = now or simulation_now()
    signature = fingerprint(request, scenario)
    def replay():
        existing = db.scalar(select(PaymentInstruction).where(PaymentInstruction.idempotency_key == request.idempotency_key))
        if existing and existing.request_fingerprint != signature:
            raise PaymentError("Idempotency key already used with different payment details.", 409)
        if existing:
            prior = db.scalar(select(PaymentRequestHistory).where(PaymentRequestHistory.payment_id == existing.payment_id).order_by(PaymentRequestHistory.received_at))
            anchor = db.get(PaymentInstruction, prior.business_instruction_id) if prior else existing
            if anchor.original_payment_id is None:
                record_request(db, existing, request.idempotency_key, now, anchor=anchor)
        return existing
    if existing := replay():
        return db.get(Transaction, existing.transaction_id), True
    if request.sender_account_ref == request.receiver_account_ref:
        raise PaymentError("Sender and receiver must be different accounts.")
    # Serialize overlapping account operations in deterministic order on PostgreSQL.
    locked = db.scalars(select(Account).where(Account.account_ref.in_([request.sender_account_ref, request.receiver_account_ref]))
                        .order_by(Account.account_id).with_for_update()).all()
    by_ref = {a.account_ref: a for a in locked}
    sender, receiver = by_ref.get(request.sender_account_ref), by_ref.get(request.receiver_account_ref)
    if not sender or not receiver:
        raise PaymentError("Both sender and receiver accounts must exist.")
    if existing := replay():
        return db.get(Transaction, existing.transaction_id), True
    if sender.status != "Active" or receiver.status != "Active":
        raise PaymentError("Both accounts must be Active; Frozen and Closed accounts cannot transfer.")
    if sender.currency != receiver.currency or (request.currency and request.currency != sender.currency):
        raise PaymentError("Only same-currency transfers matching the account currency are supported.")
    current = account_balance(db, sender.account_id)["current_balance"]
    if current < request.amount:
        raise PaymentError("Sender has insufficient available funds.")
    if scenario == "AMOUNT_MISMATCH" and request.amount < Decimal("0.02"):
        raise PaymentError("Amount Mismatch requires at least 0.02 so both movements remain positive.")

    def process(code, key, original=None):
        suffix = uuid4().hex[:16].upper()
        tx = Transaction(reference=f"TXN-{suffix}", payment_reference=original[0].payment_reference if original else f"PAY-{suffix}",
                         amount=request.amount, currency=sender.currency, status="PENDING", created_at=now)
        db.add(tx)
        db.flush()
        instruction = PaymentInstruction(transaction_id=tx.id, sender_account_id=sender.account_id,
            receiver_account_id=receiver.account_id, idempotency_key=key, request_fingerprint=signature,
            scenario_code=code, original_payment_id=original[1].payment_id if original else None,
            reconciliation_due_at=now + timedelta(seconds=reconciliation_seconds()))
        db.add(instruction)
        db.flush()
        if _on_accepted:
            _on_accepted(tx, instruction)
        else:
            record_request(db, instruction, key, now, anchor=original[1] if original else None)
        event(db, tx, "PAYMENT_CREATED", "PENDING", "Synthetic instruction accepted.", now)
        event(db, tx, "VALIDATION_STARTED", "PROCESSING", "Validating accounts, currency and available funds.", now)
        event(db, tx, "VALIDATION_PASSED", "PROCESSING", "Account validation passed.", now)
        if original:
            event(db, tx, "DUPLICATE_BLOCKED", "PENDING", "Duplicate business reference held without another financial posting.", now, "DUPLICATE_REFERENCE")
            return tx, instruction
        tx.status = "PROCESSING"
        event(db, tx, "PROCESSING_STARTED", "PROCESSING", "Synthetic payment processing started.", now)
        if code == "PROCESSING_FAILURE":
            tx.status = "FAILED"
            instruction.failure_code = "SIM_PROCESSING_ERROR"
            instruction.failure_description = "Controlled synthetic processor failure. No ledger posting was made."
            event(db, tx, "PROCESSING_FAILED", "FAILED", instruction.failure_description, now, instruction.failure_code)
            return tx, instruction
        if code != "MISSING_LEDGER":
            posted_amount = request.amount - Decimal("0.01") if code == "AMOUNT_MISMATCH" else request.amount
            journal = LedgerJournal(journal_ref=f"JRN-{suffix}", source_transaction_id=tx.id,
                normal_transaction_id=tx.id if code == "NORMAL" else None,
                payment_reference=f"UNMATCHED-{suffix}" if code == "UNMATCHED" else tx.reference,
                currency=sender.currency, status="Draft", posted_at=None)
            db.add(journal)
            db.flush()
            for account, side in [(sender, "Debit"), (receiver, "Credit")]:
                db.add(LedgerEntry(entry_ref=f"{journal.journal_ref}-{side[0]}", journal_id=journal.journal_id,
                    account_id=account.account_id, side=side, amount=posted_amount, currency=sender.currency,
                    description="Outgoing transfer" if side == "Debit" else "Incoming transfer", posted=True))
            db.flush()
            if code == "NORMAL":
                post_normal_journal(db, journal, tx, sender, receiver, now)
            else:
                journal.status, journal.posted_at = "Posted", now
            event(db, tx, "LEDGER_POSTED", "PROCESSING", f"Balanced posting recorded in {journal.journal_ref}.", now)
        tx.status, instruction.completed_at = "COMPLETED", now
        event(db, tx, "PROCESSING_COMPLETED", "COMPLETED", "Payment source reports completion." if code == "MISSING_LEDGER" else "Synthetic processing completed.", now)
        return tx, instruction

    if scenario == "DUPLICATE":
        original = process("NORMAL", request.idempotency_key + ":original")
        result = process("DUPLICATE", request.idempotency_key, original)
    else:
        result = process(scenario, request.idempotency_key)
    db.add(AuditEvent(action="PAYMENT_CREATED", actor=role, reference=result[0].reference,
                     details={"source": "payment_processor"}, created_at=now))
    db.flush()
    return result[0], False


def payment_rows(db):
    return db.execute(select(Transaction, PaymentInstruction).outerjoin(PaymentInstruction, PaymentInstruction.transaction_id == Transaction.id)).all()


def payment_dtos(db, rows=None, schema=None):
    # Constant query count: all parties are loaded in one join, never per payment.
    journals = {j.source_transaction_id: j.journal_ref for j in db.scalars(
        select(LedgerJournal).where(LedgerJournal.normal_transaction_id.is_not(None)))}
    parties = {a.account_id: dict(id=a.account_ref, customer=c.customer_name, customerRef=c.customer_ref,
                                customerType=c.customer_type, accountType=a.account_type)
               for a, c in db.execute(select(Account, Customer).join(Customer, Customer.customer_id == Account.customer_id))}
    result = []
    from shared.schema import capabilities
    schema = schema or capabilities(db)
    requests = db.scalars(select(PaymentRequestHistory).order_by(PaymentRequestHistory.received_at, PaymentRequestHistory.request_id)).all() if schema['requests'] else []
    refs = dict(db.execute(select(PaymentInstruction.payment_id, Transaction.reference).join(Transaction, Transaction.id == PaymentInstruction.transaction_id)).all())
    receipts, groups = {}, {}
    for r in requests:
        receipts.setdefault(r.payment_id, []).append(r)
        groups.setdefault(r.business_instruction_id, set()).add(r.payment_id)
    batch_items = db.execute(select(ExceptionBatchItem.batch_id, ExceptionBatchItem.transaction_id, Transaction.reference).join(Transaction, Transaction.id == ExceptionBatchItem.transaction_id)).all()
    batches, membership = {}, {}
    for batch, tx_id, ref in batch_items:
        batches.setdefault(batch, set()).add(ref)
        membership[tx_id] = batch
    for tx, instruction in rows if rows is not None else payment_rows(db):
        sender = parties.get(instruction.sender_account_id) if instruction else None
        receiver = parties.get(instruction.receiver_account_id) if instruction else None
        result.append(dict(id=tx.reference, journalReference=journals.get(tx.id), paymentId=str(instruction.payment_id) if instruction else None,
            senderId=sender["id"] if sender else None, receiverId=receiver["id"] if receiver else None,
            sender=sender, receiver=receiver, amountCents=int(tx.amount*100), currency=tx.currency,
            status=tx.status.title(), createdAt=aware(tx.created_at), completedAt=aware(instruction.completed_at) if instruction else None,
            failureCode=instruction.failure_code if instruction else None, failureDescription=instruction.failure_description if instruction else None,
            requests=[dict(requestId=str(r.request_id), instructionReference=str(r.business_instruction_id), origin=r.origin,
                retryOfRequestId=str(r.retry_of_request_id) if r.retry_of_request_id else None,
                authorizationId=str(r.authorization_id) if r.authorization_id else None,
                correlationId=str(r.correlation_id) if r.correlation_id else None, receivedAt=aware(r.received_at))
                for r in receipts.get(instruction.payment_id, [])] if instruction else [],
            relatedPaymentReferences=sorted((batches.get(membership.get(tx.id), set()) | {
                refs[p] for r in receipts.get(instruction.payment_id, []) for p in groups[r.business_instruction_id]
            } if instruction else set()) - {tx.reference}),
            reconciliationDueAt=aware(instruction.reconciliation_due_at) if instruction else None,
            originalPaymentId=str(instruction.original_payment_id) if instruction and instruction.original_payment_id else None))
    return result


def find_payment(db, reference):
    from uuid import UUID
    conditions = [Transaction.reference == reference]
    try:
        conditions.append(PaymentInstruction.payment_id == UUID(reference))
    except ValueError:
        pass
    row = db.execute(select(Transaction, PaymentInstruction).outerjoin(PaymentInstruction, PaymentInstruction.transaction_id == Transaction.id).where(or_(*conditions))).first()
    if row is None:
        raise PaymentError("Payment not found.", 404)
    return row
