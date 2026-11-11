"""Read-only ledger summaries and controlled ownership validation.

Posted reversal journals contribute their actual debit/credit direction.
Historical demonstration records are never repaired.
"""
from decimal import Decimal
from sqlalchemy import select, func, case, and_
from .models import Account, Customer, LedgerJournal, LedgerEntry


def assess_journal(journal, entries, accounts, transaction=None, instruction=None):
    """Read-only accounting and payment-level checks; amount is assessed separately."""
    reasons = []
    if journal.status != "Posted":
        reasons.append("NOT_POSTED")
    if journal.posted_at is None:
        reasons.append("MISSING_POSTING_TIMESTAMP")
    if len(entries) < 2:
        reasons.append("MISSING_ENTRIES")
    debit = credit = Decimal(0)
    for entry in entries:
        account = accounts.get(entry.account_id)
        if entry.side not in ("Debit", "Credit") or not entry.posted or not entry.amount.is_finite() or entry.amount <= 0:
            reasons.append("INVALID_ENTRY")
        elif entry.side == "Debit":
            debit += entry.amount
        else:
            credit += entry.amount
        if not account:
            reasons.append("MISSING_ACCOUNT")
        if entry.currency != journal.currency or account and account.currency != entry.currency:
            reasons.append("INTERNAL_CURRENCY_CONFLICT")
    if debit != credit or debit <= 0:
        reasons.append("UNBALANCED_OR_EMPTY")
    return dict(valid=not reasons, reasons=sorted(set(reasons)), debit=debit, credit=credit,
                currency_mismatch=bool(transaction and (journal.currency != transaction.currency or any(e.currency != transaction.currency for e in entries))),
                party_mismatch=bool(instruction and any(e.account_id != (instruction.sender_account_id if e.side == "Debit" else instruction.receiver_account_id) for e in entries if e.side in ("Debit", "Credit"))),
                reference_mismatch=bool(transaction and (journal.payment_reference != transaction.reference or journal.source_transaction_id not in (None, transaction.id))))


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


def post_normal_journal(db, journal, transaction, sender, receiver, now):
    """Validate persisted movements before the atomic payment can complete."""
    if journal.status != "Draft" or journal.posted_at is not None:
        raise ValueError("Journal is not an unposted Draft.")
    if (journal.source_transaction_id != transaction.id or journal.normal_transaction_id != transaction.id
            or journal.payment_reference != transaction.reference):
        raise ValueError("Journal payment reference is inconsistent.")
    other = db.scalar(select(LedgerJournal.journal_id).where(
        LedgerJournal.source_transaction_id == transaction.id,
        LedgerJournal.journal_id != journal.journal_id))
    if other is not None:
        raise ValueError("Payment already has a posting journal.")
    entries = db.scalars(select(LedgerEntry).where(LedgerEntry.journal_id == journal.journal_id)).all()
    if len(entries) != 2 or {(e.account_id, e.side) for e in entries} != {
            (sender.account_id, "Debit"), (receiver.account_id, "Credit")}:
        raise ValueError("Normal posting requires one sender debit and one receiver credit.")
    for entry in entries:
        account = db.get(Account, entry.account_id)
        if (account is None or account.currency != journal.currency or entry.currency != journal.currency
                or journal.currency != transaction.currency or not entry.posted
                or not entry.amount.is_finite() or entry.amount <= 0
                or entry.amount != entry.amount.quantize(Decimal("0.01"))
                or entry.amount != transaction.amount):
            raise ValueError("Invalid journal amount, currency or account.")
    if sum(e.amount for e in entries if e.side == "Debit") != sum(e.amount for e in entries if e.side == "Credit"):
        raise ValueError("Journal is unbalanced.")
    journal.status, journal.posted_at = "Posted", now


def account_balance(db, account_id):
    query, _ = account_query()
    row = db.execute(query.where(Account.account_id == account_id)).first()
    if row is None:
        raise ValueError("Account not found.")
    return serialize_account(row)["balance"]


def serialize_account(row):
    account, customer, credits, debits, current = row
    credits, debits = Decimal(credits), Decimal(debits)
    return dict(account_id=account.account_id, account_ref=account.account_ref,
                account_type=account.account_type, currency=account.currency,
                status=account.status, created_at=account.created_at, customer=customer,
                balance=dict(opening_balance=account.opening_balance, posted_credits=credits,
                             posted_debits=debits, net_change=credits-debits, current_balance=current))
