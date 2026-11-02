"""Read-only ledger summaries and controlled ownership validation.

Reversed journals use the existing simulator's exclusion semantics. A missing
payment or a payment/journal amount mismatch never causes a journal repair.
"""
from decimal import Decimal
from sqlalchemy import select, func, case, and_
from .models import Account, Customer, LedgerJournal, LedgerEntry


def validate_ownership(db, customer_id, account_type):
    customer = db.get(Customer, customer_id)
    if customer is None:
        raise ValueError("Customer does not exist.")
    if account_type not in ("SAVINGS", "CURRENT"):
        raise ValueError("Account type must be SAVINGS or CURRENT.")
    if customer.customer_type == "BUSINESS" and account_type != "CURRENT":
        raise ValueError("Business customers must use Current accounts.")
    return customer


def valid_journals():
    """Validate entire journals before aggregating account entries, in SQL."""
    signed = case((LedgerEntry.side == "Credit", LedgerEntry.amount), else_=-LedgerEntry.amount)
    valid_entry = and_(LedgerEntry.posted.is_(True), LedgerEntry.amount > 0,
                       LedgerEntry.side.in_(["Debit", "Credit"]),
                       LedgerEntry.currency == LedgerJournal.currency,
                       Account.currency == LedgerEntry.currency)
    return (select(LedgerJournal.journal_id)
            .join(LedgerEntry, LedgerEntry.journal_id == LedgerJournal.journal_id)
            .join(Account, Account.account_id == LedgerEntry.account_id)
            .where(LedgerJournal.status == "Posted", LedgerJournal.posted_at.is_not(None))
            .group_by(LedgerJournal.journal_id)
            .having(func.count() >= 2, func.sum(signed) == 0,
                    func.sum(case((valid_entry, 0), else_=1)) == 0))


def account_query():
    totals = (select(LedgerEntry.account_id,
                     func.sum(case((LedgerEntry.side == "Credit", LedgerEntry.amount), else_=0)).label("credits"),
                     func.sum(case((LedgerEntry.side == "Debit", LedgerEntry.amount), else_=0)).label("debits"))
              .where(LedgerEntry.journal_id.in_(valid_journals()))
              .group_by(LedgerEntry.account_id).subquery())
    credits = func.coalesce(totals.c.credits, 0)
    debits = func.coalesce(totals.c.debits, 0)
    current = Account.opening_balance + credits - debits
    query = (select(Account, Customer, credits.label("credits"), debits.label("debits"), current.label("current"))
             .join(Customer, Customer.customer_id == Account.customer_id)
             .outerjoin(totals, totals.c.account_id == Account.account_id))
    return query, current


def serialize_account(row):
    account, customer, credits, debits, current = row
    credits, debits = Decimal(credits), Decimal(debits)
    return dict(account_id=account.account_id, account_ref=account.account_ref,
                account_type=account.account_type, currency=account.currency,
                status=account.status, created_at=account.created_at, customer=customer,
                balance=dict(opening_balance=account.opening_balance, posted_credits=credits,
                             posted_debits=debits, net_change=credits-debits, current_balance=current))
