"""One consistent read snapshot for all three frontend source-record views."""
from pydantic import BaseModel
from sqlalchemy import select
from .router import router, get_db
from .models import Account, Customer, LedgerJournal, LedgerEntry
from .service import account_query, serialize_account
from modules.payment_processing.models import Transaction, ProcessingEvent
from modules.payment_processing.service import payment_dtos, simulation_now, aware, reconciliation_seconds
from modules.intelliops.detection import case_dtos
from modules.intelliops.models import AuditEvent
from shared.security import actor
from fastapi import Depends


class SnapshotOut(BaseModel):
    customers: list[dict]
    accounts: list[dict]
    payment_transactions: list[dict]
    ledger_journals: list[dict]
    ledger_entries: list[dict]
    processing_events: list[dict]
    exception_cases: list[dict]
    audit_events: list[dict]
    simulationNow: str
    role: str
    reconciliationSeconds: int


@router.get("/banking-snapshot", response_model=SnapshotOut)
def banking_snapshot(db=Depends(get_db), role=Depends(actor)):
    query, _ = account_query()
    rows = db.execute(query.order_by(Account.account_ref)).all()
    accounts, refs, journal_refs = [], {}, {}
    for row in rows:
        a, c, *_ = row
        refs[a.account_id] = a.account_ref
        summary = serialize_account(row)["balance"]
        accounts.append(dict(id=a.account_ref, reference=a.account_ref, backendId=str(a.account_id),
                             customerRef=c.customer_ref, customer=c.customer_name, customerType=c.customer_type,
                             accountType=a.account_type, type=a.account_type.title(), currency=a.currency,
                             openingCents=int(a.opening_balance*100), status=a.status, createdAt=aware(a.created_at).isoformat(),
                             authoritativeBalance=dict(current=int(summary["current_balance"]*100),
                                                       credits=int(summary["posted_credits"]*100),
                                                       debits=int(summary["posted_debits"]*100), net=int(summary["net_change"]*100))))
    journals = []
    transaction_refs = dict(db.execute(select(Transaction.id, Transaction.reference)).all())
    for j in db.scalars(select(LedgerJournal).order_by(LedgerJournal.journal_ref)):
        journal_refs[j.journal_id] = j.journal_ref
        journals.append(dict(id=j.journal_ref, paymentId=j.payment_reference, currency=j.currency,
                             status=j.status, sourcePaymentId=transaction_refs.get(j.source_transaction_id),
                             postedAt=aware(j.posted_at).isoformat() if j.posted_at else None))
    entries = [dict(id=e.entry_ref, journalId=journal_refs[e.journal_id], accountId=refs[e.account_id],
                    side=e.side, amountCents=int(e.amount*100), currency=e.currency, description=e.description, posted=e.posted)
               for e in db.scalars(select(LedgerEntry).order_by(LedgerEntry.entry_ref))]
    # Original transaction records lack account ownership fields. Derive display-only
    # parties only when a single matching account movement exists; do not invent them.
    def party(reference, side):
        ids = {e["accountId"] for e in entries if e["side"] == side and
               any(j["id"] == e["journalId"] and j["paymentId"] == reference for j in journals)}
        return next(iter(ids)) if len(ids) == 1 else "Unavailable"
    payments = payment_dtos(db)
    for payment in payments:
        payment["senderId"] = payment["senderId"] or party(payment["id"], "Debit")
        payment["receiverId"] = payment["receiverId"] or party(payment["id"], "Credit")
    events = [dict(id=str(e.id), paymentId=transaction_refs[e.transaction_id], eventType=e.event_type,
                   status=e.status, description=e.details, errorCode=e.error_code, occurredAt=aware(e.created_at))
              for e in db.scalars(select(ProcessingEvent).order_by(ProcessingEvent.created_at, ProcessingEvent.id))]
    customers = [dict(id=c.customer_ref, name=c.customer_name, customerType=c.customer_type)
                 for c in db.scalars(select(Customer).order_by(Customer.customer_ref))]
    audit = [dict(id=str(e.id), action=e.action, actor=e.actor, reference=e.reference, details=e.details, createdAt=aware(e.created_at))
             for e in db.scalars(select(AuditEvent).order_by(AuditEvent.id.desc()).limit(500))]
    return dict(customers=customers, accounts=accounts, payment_transactions=payments, ledger_journals=journals,
                ledger_entries=entries, processing_events=events, exception_cases=case_dtos(db), audit_events=audit,
                simulationNow=simulation_now().isoformat(), role=role, reconciliationSeconds=reconciliation_seconds())
