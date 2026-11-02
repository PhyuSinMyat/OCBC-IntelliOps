from typing import Literal
from uuid import UUID
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, func, or_
from shared.database import SessionLocal
from modules.payment_processing.models import Transaction
from .models import Account, Customer, LedgerJournal, LedgerEntry
from .schemas import AccountOut, AccountPage, CustomerOut, EntryOut
from .service import account_query, serialize_account, valid_journals
from shared.security import actor

router = APIRouter(prefix="/api", tags=["Core Banking"], dependencies=[Depends(actor)])


def get_db():
    with SessionLocal() as db:
        yield db


@router.get("/accounts", response_model=AccountPage)
def list_accounts(search: str = Query("", max_length=200),
                  customer_type: Literal["INDIVIDUAL", "BUSINESS"] | None = None,
                  account_type: Literal["SAVINGS", "CURRENT"] | None = None,
                  currency: str | None = Query(None, pattern=r"^[A-Z]{3}$"),
                  status: str | None = None,
                  sort: Literal["reference", "customer-asc", "customer-desc", "balance-asc", "balance-desc", "created-asc", "created-desc"] = "reference",
                  page: int = Query(1, ge=1), page_size: int = Query(25, ge=1, le=100), db=Depends(get_db)):
    query, current = account_query()
    if search.strip():
        # Escape wildcard characters so search behaves like the UI's substring search.
        text = search.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        query = query.where(or_(*(column.ilike(f"%{text}%", escape="\\") for column in
                                  [Account.account_ref, Customer.customer_name, Customer.customer_ref])))
    for column, value in [(Customer.customer_type, customer_type), (Account.account_type, account_type),
                          (Account.currency, currency), (Account.status, status)]:
        if value is not None:
            query = query.where(column == value)
    total = db.scalar(select(func.count()).select_from(query.subquery()))
    ordering = {"reference": Account.account_ref, "customer-asc": func.lower(Customer.customer_name),
                "customer-desc": func.lower(Customer.customer_name).desc(), "balance-asc": current,
                "balance-desc": current.desc(), "created-asc": Account.created_at, "created-desc": Account.created_at.desc()}
    rows = db.execute(query.order_by(ordering[sort], Account.account_ref).offset((page-1)*page_size).limit(page_size)).all()
    return dict(items=[serialize_account(row) for row in rows], total=total, page=page, page_size=page_size)


@router.get("/accounts/{account_id}", response_model=AccountOut)
def account_details(account_id: UUID, db=Depends(get_db)):
    query, _ = account_query()
    row = db.execute(query.where(Account.account_id == account_id)).first()
    if row is None:
        raise HTTPException(404, "Account not found")
    return serialize_account(row)


@router.get("/accounts/{account_id}/ledger-entries", response_model=list[EntryOut])
def account_entries(account_id: UUID, db=Depends(get_db)):
    if db.get(Account, account_id) is None:
        raise HTTPException(404, "Account not found")
    rows = db.execute(select(LedgerEntry, LedgerJournal, Transaction.reference)
                      .join(LedgerJournal, LedgerJournal.journal_id == LedgerEntry.journal_id)
                      .outerjoin(Transaction, Transaction.reference == LedgerJournal.payment_reference)
                      .where(LedgerEntry.account_id == account_id, LedgerEntry.journal_id.in_(valid_journals()))
                      .order_by(LedgerJournal.posted_at.desc(), LedgerEntry.entry_ref.desc())).all()
    return [dict(entry_id=e.entry_id, journal_reference=j.journal_ref,
                 payment_reference=j.payment_reference, payment_available=reference is not None,
                 description=e.description, posted_at=j.posted_at, side=e.side, amount=e.amount,
                 signed_amount=e.amount if e.side == "Credit" else -e.amount, currency=e.currency)
            for e, j, reference in rows]


@router.get("/customers", response_model=list[CustomerOut])
def list_customers(db=Depends(get_db)):
    return db.scalars(select(Customer).order_by(Customer.customer_ref)).all()
