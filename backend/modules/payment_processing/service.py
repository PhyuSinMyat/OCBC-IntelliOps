import hashlib
import json
import os
from datetime import datetime, timezone, timedelta
from decimal import Decimal
from uuid import uuid4
from sqlalchemy import select, or_
from .models import Transaction, ProcessingEvent, PaymentInstruction
from modules.core_banking.models import Account, Customer, LedgerJournal, LedgerEntry
from modules.core_banking.service import account_balance, post_normal_journal
from modules.intelliops.models import AuditEvent


class PaymentError(ValueError):
    def __init__(self, message, status=422):
        super().__init__(message)
        self.status = status


def simulation_now():
    configured = os.getenv("INTELLIOPS_SIMULATION_TIME")
    return aware(datetime.fromisoformat(configured.replace("Z", "+00:00"))).astimezone(timezone.utc) if configured else datetime.now(timezone.utc)


def reconciliation_seconds():
    return max(1, int(os.getenv("INTELLIOPS_RECONCILIATION_SECONDS", "60")))


def aware(value):
    return value.replace(tzinfo=value.tzinfo or timezone.utc) if value else None


def fingerprint(request, scenario):
    payload = request.model_dump(exclude={"idempotency_key", "scenario_code"}, mode="json")
    payload["amount"] = str(request.amount.quantize(Decimal("0.01")))
    payload["scenario_code"] = scenario
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()


def event(db, tx, kind, status, message, now, code=None):
    db.add(ProcessingEvent(transaction_id=tx.id, event_type=kind, status=status, details=message, error_code=code, created_at=now))


def create_payment(db, request, role, scenario="NORMAL", now=None):
    if scenario != "NORMAL" and role != "ADMIN":
        raise PaymentError("Only ADMIN may inject exception scenarios.", 403)
    now = now or simulation_now()
    signature = fingerprint(request, scenario)
    def replay():
        existing = db.scalar(select(PaymentInstruction).where(PaymentInstruction.idempotency_key == request.idempotency_key))
        if existing and existing.request_fingerprint != signature:
            raise PaymentError("Idempotency key already used with different payment details.", 409)
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
    db.add(AuditEvent(action="PAYMENT_CREATED" if scenario == "NORMAL" else "SCENARIO_INJECTED", actor=role,
                     reference=result[0].reference, details={"scenario": scenario, "idempotency_key": request.idempotency_key}, created_at=now))
    db.flush()
    return result[0], False


def payment_rows(db):
    return db.execute(select(Transaction, PaymentInstruction).outerjoin(PaymentInstruction, PaymentInstruction.transaction_id == Transaction.id)).all()


def payment_dtos(db, rows=None):
    # Constant query count: all parties are loaded in one join, never per payment.
    journals = {j.source_transaction_id: j.journal_ref for j in db.scalars(
        select(LedgerJournal).where(LedgerJournal.normal_transaction_id.is_not(None)))}
    parties = {a.account_id: dict(id=a.account_ref, customer=c.customer_name, customerRef=c.customer_ref,
                                customerType=c.customer_type, accountType=a.account_type)
               for a, c in db.execute(select(Account, Customer).join(Customer, Customer.customer_id == Account.customer_id))}
    result = []
    for tx, instruction in rows if rows is not None else payment_rows(db):
        sender = parties.get(instruction.sender_account_id) if instruction else None
        receiver = parties.get(instruction.receiver_account_id) if instruction else None
        result.append(dict(id=tx.reference, journalReference=journals.get(tx.id), paymentId=str(instruction.payment_id) if instruction else None,
            senderId=sender["id"] if sender else None, receiverId=receiver["id"] if receiver else None,
            sender=sender, receiver=receiver, amountCents=int(tx.amount*100), currency=tx.currency,
            status=tx.status.title(), createdAt=aware(tx.created_at), completedAt=aware(instruction.completed_at) if instruction else None,
            failureCode=instruction.failure_code if instruction else None, failureDescription=instruction.failure_description if instruction else None,
            scenarioCode=instruction.scenario_code if instruction else None, reconciliationDueAt=aware(instruction.reconciliation_due_at) if instruction else None,
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
