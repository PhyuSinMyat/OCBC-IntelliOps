from datetime import timedelta
from decimal import Decimal
from sqlalchemy import select
from modules.core_banking.models import Account
from modules.core_banking.service import account_query
from modules.intelliops.models import AuditEvent
from .models import ExceptionBatch, ExceptionBatchItem
from .schemas import PaymentRequest
from .service import PaymentError, create_payment, simulation_now


def create_exception_batch(db, request, role):
    scenarios = list(dict.fromkeys(request.exception_types))
    if len(scenarios) != len(request.exception_types):
        raise PaymentError("Select each exception type at most once.")
    now = simulation_now()
    batch = ExceptionBatch(requested_scenarios=scenarios, count_per_type=request.count_per_type,
                           status="PROCESSING", created_by=role, created_at=now)
    db.add(batch)
    db.flush()
    transactions = []
    sequence = 0
    for scenario in scenarios:
        for _ in range(request.count_per_type):
            query, current = account_query()
            rows = db.execute(query.where(Account.status == "Active").order_by(current.desc(), Account.account_ref)).all()
            amount = Decimal(10 + sequence)
            pair = next(((sender[0], receiver[0]) for sender in rows for receiver in rows
                         if sender[0].account_id != receiver[0].account_id
                         and sender[0].currency == receiver[0].currency and sender.current >= amount), None)
            if pair is None:
                raise PaymentError("No safe active same-currency account pair has enough funds for this batch.", 409)
            sender, receiver = pair
            payment = PaymentRequest(sender_account_ref=sender.account_ref, receiver_account_ref=receiver.account_ref,
                                     amount=amount, currency=sender.currency,
                                     idempotency_key=f"batch-{batch.batch_id}-{sequence:03d}")
            tx, _ = create_payment(db, payment, role, scenario, now + timedelta(microseconds=sequence))
            db.add(ExceptionBatchItem(batch_id=batch.batch_id, transaction_id=tx.id,
                                      scenario_code=scenario, sequence=sequence))
            transactions.append(tx)
            sequence += 1
    batch.status, batch.completed_at = "COMPLETED", now + timedelta(microseconds=sequence)
    db.add(AuditEvent(action="EXCEPTION_BATCH_GENERATED", actor=role, reference=f"BATCH-{batch.batch_id}",
                      details={"exceptionTypes": scenarios, "countPerType": request.count_per_type,
                               "transactionReferences": [tx.reference for tx in transactions]}, created_at=now))
    db.flush()
    return batch, transactions
