from datetime import datetime
from typing import Literal
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, func, or_, asc, desc
from sqlalchemy.orm import aliased, defer
from sqlalchemy.exc import IntegrityError
from shared.security import actor, analyst
from modules.core_banking.router import get_db
from modules.core_banking.models import Account, Customer, LedgerJournal, LedgerEntry
from modules.intelliops.models import AuditEvent
from modules.intelliops.detection import detect, case_dtos
from modules.intelliops.automatic_detection import run_after_commit, status as detection_status
from modules.intelliops.rules import DetectionConfigurationError
from .models import Transaction, PaymentInstruction, ProcessingEvent
from .schemas import PaymentRequest, ScenarioRequest, ExceptionBatchRequest, PaymentOut, PaymentPage, EventOut, RelatedOut
from .service import create_payment, payment_dtos, find_payment, PaymentError, aware, fingerprint, operational_audit_details
from .batch import create_exception_batch
from .scenarios import generate_duplicate, generate_exception_variant, run_result
from .schemas import ScenarioOut
from shared.schema import capabilities, require_current_schema

router = APIRouter(prefix="/api", tags=["Payments"])


def lookup(db, reference):
    try:
        return find_payment(db, reference)
    except PaymentError as error:
        raise HTTPException(error.status, str(error)) from error


@router.get("/payments", response_model=PaymentPage)
def list_payments(search: str = Query("", max_length=200),
                  status: Literal["PENDING", "PROCESSING", "COMPLETED", "FAILED", "REJECTED", "HELD"] | None = None,
                  currency: str | None = Query(None, pattern=r"^[A-Z]{3}$"),
                  date_from: datetime | None = None, date_to: datetime | None = None,
                  sort: Literal["newest", "oldest", "amount-high", "amount-low", "status", "reference"] = "newest",
                  page: int = Query(1, ge=1), page_size: int = Query(25, ge=1, le=100),
                  db=Depends(get_db), role=Depends(actor)):
    sender, receiver, sc, rc = aliased(Account), aliased(Account), aliased(Customer), aliased(Customer)
    query = (select(Transaction, PaymentInstruction).outerjoin(PaymentInstruction, PaymentInstruction.transaction_id == Transaction.id)
             .outerjoin(sender, sender.account_id == PaymentInstruction.sender_account_id).outerjoin(sc, sc.customer_id == sender.customer_id)
             .outerjoin(receiver, receiver.account_id == PaymentInstruction.receiver_account_id).outerjoin(rc, rc.customer_id == receiver.customer_id))
    if date_from and date_to and aware(date_from) > aware(date_to):
        raise HTTPException(422, "Date range start must precede its end.")
    if search.strip():
        text = search.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        query = query.where(or_(*(c.ilike(f"%{text}%", escape="\\") for c in [Transaction.reference, sender.account_ref, receiver.account_ref, sc.customer_name, rc.customer_name])))
    for column, value in [(Transaction.status, status), (Transaction.currency, currency)]:
        if value:
            query = query.where(column == value)
    if date_from:
        query = query.where(Transaction.created_at >= date_from)
    if date_to:
        query = query.where(Transaction.created_at <= date_to)
    total = db.scalar(select(func.count()).select_from(query.subquery()))
    ordering = {"newest": Transaction.created_at.desc(), "oldest": Transaction.created_at,
                "amount-high": Transaction.amount.desc(), "amount-low": Transaction.amount,
                "status": Transaction.status, "reference": Transaction.reference}
    rows = db.execute(query.order_by(ordering[sort], Transaction.reference).offset((page-1)*page_size).limit(page_size)).all()
    return dict(items=payment_dtos(db, rows), total=total, page=page, page_size=page_size)


def submit(db, request, role, scenario):
    replayed = True
    try:
        with db.begin():
            require_current_schema(db)
            tx, replayed = create_payment(db, request, role, scenario)
            reference = tx.reference
    except PaymentError as error:
        raise HTTPException(error.status, str(error)) from error
    except IntegrityError:
        # A concurrent request may have won the unique idempotency-key race.
        replayed = True
        db.rollback()
        existing = db.scalar(select(PaymentInstruction).where(PaymentInstruction.idempotency_key == request.idempotency_key))
        if not existing or existing.request_fingerprint != fingerprint(request, scenario):
            raise HTTPException(409, "Conflicting or concurrent payment submission. Retry with the same key.")
        reference = db.get(Transaction, existing.transaction_id).reference
    except ValueError as error:
        db.rollback()
        with db.begin():
            db.add(AuditEvent(action="PAYMENT_POSTING_FAILED", actor=role,
                reference=request.idempotency_key,
                details={"reason": str(error), "financialChangesRolledBack": True}))
        raise HTTPException(422, "Ledger posting failed; financial changes were rolled back.") from error
    if not replayed:
        run_after_commit(db.get_bind(), [reference])
    return payment_dtos(db, [lookup(db, reference)])[0]


@router.post("/payments", response_model=PaymentOut, status_code=201)
def post_payment(request: PaymentRequest, db=Depends(get_db), role=Depends(analyst)):
    return submit(db, request, role, "NORMAL")


@router.post("/demo/payments/scenario", response_model=ScenarioOut | PaymentOut, status_code=201)
def post_scenario(request: ScenarioRequest, db=Depends(get_db), role=Depends(analyst)):
    if request.duplicate_scenario or request.scenario_variant:
        try:
            with db.begin():
                require_current_schema(db)
                batch = generate_duplicate(db, request, role) if request.duplicate_scenario else generate_exception_variant(db, request, role)
            result = run_result(db, batch)
        except PaymentError as error:
            raise HTTPException(error.status, str(error)) from error
        except IntegrityError as error:
            db.rollback()
            raise HTTPException(409, 'Concurrent run conflicted; retry the same run key.') from error
        except ValueError as error:
            db.rollback()
            raise HTTPException(422, 'Scenario posting failed; all financial changes rolled back.') from error
        # Result projection starts a read transaction. Release it before the independent scan.
        db.rollback()
        run_after_commit(db.get_bind(), result["paymentReferences"])
        return result
    return submit(db, request, role, request.scenario_code)


@router.post("/demo/exception-batches", status_code=201)
def post_exception_batch(request: ExceptionBatchRequest, db=Depends(get_db), role=Depends(analyst)):
    try:
        with db.begin():
            require_current_schema(db)
            batch, transactions = create_exception_batch(db, request, role)
            references = [tx.reference for tx in transactions]
        run_after_commit(db.get_bind(), references)
        return {"batchId": str(batch.batch_id), "status": batch.status, "created": len(references),
                "exceptionTypes": batch.requested_scenarios, "countPerType": batch.count_per_type,
                "transactionReferences": references}
    except PaymentError as error:
        raise HTTPException(error.status, str(error)) from error


@router.get("/payments/{payment_id}", response_model=PaymentOut)
def payment_detail(payment_id: str, db=Depends(get_db), role=Depends(actor)):
    return payment_dtos(db, [lookup(db, payment_id)])[0]


@router.get("/payments/{payment_id}/events", response_model=list[EventOut])
def payment_events(payment_id: str, db=Depends(get_db), role=Depends(actor)):
    tx, _ = lookup(db, payment_id)
    schema = capabilities(db)
    query = select(ProcessingEvent).where(ProcessingEvent.transaction_id == tx.id).order_by(ProcessingEvent.created_at, ProcessingEvent.id)
    if not schema['events']:
        query = query.options(defer(ProcessingEvent.request_id))
    return [dict(id=str(e.id), paymentId=tx.reference, requestId=e.request_id if schema['events'] else None, eventType=e.event_type, status=e.status,
                 description=e.details, errorCode=e.error_code, occurredAt=aware(e.created_at))
            for e in db.scalars(query)]


@router.get("/payments/{payment_id}/related", response_model=RelatedOut)
def related_records(payment_id: str, db=Depends(get_db), role=Depends(actor)):
    tx, _ = lookup(db, payment_id)
    journals = db.scalars(select(LedgerJournal).where(or_(LedgerJournal.payment_reference == tx.reference, LedgerJournal.source_transaction_id == tx.id))).all()
    amounts = db.execute(select(LedgerEntry.journal_id, LedgerEntry.side, func.sum(LedgerEntry.amount))
                         .where(LedgerEntry.journal_id.in_([j.journal_id for j in journals])).group_by(LedgerEntry.journal_id, LedgerEntry.side)).all()
    totals = {(journal_id, side): str(amount) for journal_id, side, amount in amounts}
    payment = payment_dtos(db, [lookup(db, payment_id)])[0]
    return dict(payments=[p for p in payment_dtos(db) if p['id'] in payment['relatedPaymentReferences']],
                journals=[dict(id=j.journal_ref, status=j.status, postedAt=aware(j.posted_at), currency=j.currency,
                             paymentReference=j.payment_reference, debitTotal=totals.get((j.journal_id, "Debit"), "0.00"),
                             creditTotal=totals.get((j.journal_id, "Credit"), "0.00")) for j in journals], exceptions=case_dtos(db, tx.id))


@router.post("/detection/run")
def run_detection(db=Depends(get_db), role=Depends(analyst)):
    try:
        with db.begin():
            require_current_schema(db)
            ids = detect(db, role)
    except DetectionConfigurationError as error:
        raise HTTPException(422, str(error)) from error
    return {"created": len(ids), "caseIds": [f"CASE-{value:06d}" for value in ids]}


@router.get("/detection/status")
def read_detection_status(db=Depends(get_db), role=Depends(actor)):
    return detection_status(db)


@router.get("/exceptions")
def list_exceptions(db=Depends(get_db), role=Depends(actor)):
    return case_dtos(db)


@router.get("/audit-events")
def audit_events(db=Depends(get_db), role=Depends(actor)):
    return [dict(id=str(e.id), action=e.action, actor=e.actor, reference=e.reference,
                 details=operational_audit_details(e.details), createdAt=aware(e.created_at))
            for e in db.scalars(select(AuditEvent).order_by(AuditEvent.id.desc()).limit(500))]
