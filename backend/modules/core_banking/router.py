from typing import Literal
from uuid import UUID
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, func, or_
from shared.database import SessionLocal
from modules.payment_processing.models import Transaction
from .models import Account, Customer, LedgerJournal, LedgerEntry
from .schemas import AccountOut, AccountPage, CustomerOut, EntryOut, JournalOut
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


def journal_records(db, journals):
    ids = [j.journal_id for j in journals]
    movements = db.execute(select(LedgerEntry, Account.account_ref).join(
        Account, Account.account_id == LedgerEntry.account_id).where(
        LedgerEntry.journal_id.in_(ids)).order_by(LedgerEntry.entry_ref)).all()
    references = {r for r in db.scalars(select(Transaction.reference).where(
        Transaction.reference.in_([j.payment_reference for j in journals if j.payment_reference])))}
    grouped = {key: [] for key in ids}
    for entry, account_ref in movements:
        grouped[entry.journal_id].append(dict(entry_id=entry.entry_id, entry_ref=entry.entry_ref,
            account_ref=account_ref, side=entry.side, amount=entry.amount,
            currency=entry.currency, description=entry.description))
    return [dict(journal_id=j.journal_id, journal_ref=j.journal_ref,
        payment_reference=j.payment_reference, payment_available=j.payment_reference in references,
        status=j.status, currency=j.currency, created_at=j.created_at, posted_at=j.posted_at,
        total_debit=sum((e['amount'] for e in grouped[j.journal_id] if e['side'] == 'Debit'), 0),
        total_credit=sum((e['amount'] for e in grouped[j.journal_id] if e['side'] == 'Credit'), 0),
        entries=grouped[j.journal_id]) for j in journals]


@router.get("/ledger/journals", response_model=list[JournalOut])
def list_journals(page: int = Query(1, ge=1), page_size: int = Query(25, ge=1, le=100), db=Depends(get_db)):
    journals = db.scalars(select(LedgerJournal).order_by(LedgerJournal.created_at.desc(),
        LedgerJournal.journal_ref).offset((page-1)*page_size).limit(page_size)).all()
    return journal_records(db, journals)


@router.get("/ledger/journals/{journal_id}", response_model=JournalOut)
def journal_details(journal_id: str, db=Depends(get_db)):
    conditions = [LedgerJournal.journal_ref == journal_id]
    try:
        conditions.append(LedgerJournal.journal_id == UUID(journal_id))
    except ValueError:
        pass
    journal = db.scalar(select(LedgerJournal).where(or_(*conditions)))
    if journal is None:
        raise HTTPException(404, "Journal not found")
    return journal_records(db, [journal])[0]
