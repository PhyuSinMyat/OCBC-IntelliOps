"""Explicit, idempotent synthetic seed; never runs on navigation or API reads."""
import json
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from uuid import NAMESPACE_URL, uuid5
from sqlalchemy import select
from shared.database import SessionLocal
from modules.payment_processing.models import Transaction, PaymentInstruction, ProcessingEvent
from .models import Customer, Account, LedgerJournal, LedgerEntry
from .service import validate_ownership


def demo_id(reference):
    return uuid5(NAMESPACE_URL, f"intelliops/demo/{reference}")


def seed_demo(db):
    data = json.loads(Path(__file__).with_name("demo.json").read_text(encoding="utf-8"))
    report = {"created": 0, "preserved": 0, "manual_classification": []}

    def ensure(model, key, values):
        row = db.scalar(select(model).where(key == values[key.key]))
        if row is not None:
            # Do not overwrite conflicting existing data or silently relink records.
            for name, value in values.items():
                existing = getattr(row, name)
                if isinstance(value, datetime) and isinstance(existing, datetime):
                    # SQLite drops timezone metadata; all simulator timestamps are UTC.
                    existing = existing.replace(tzinfo=existing.tzinfo or timezone.utc)
                if name != "created_at" and existing != value:
                    raise ValueError(f"Existing {model.__name__} conflicts at {values[key.key]} ({name}); manual review required.")
            report["preserved"] += 1
            return row
        row = model(**values)
        db.add(row)
        db.flush()
        report["created"] += 1
        return row

    for c in data["customers"]:
        ensure(Customer, Customer.customer_ref, dict(customer_id=demo_id(c["id"]), customer_ref=c["id"],
               customer_name=c["name"], customer_type=c["customerType"], status="Active",
               created_at=datetime.fromisoformat("2026-10-01T00:00:00+00:00")))
    for a in data["accounts"]:
        owner = validate_ownership(db, demo_id(a["customerRef"]), a["accountType"])
        ensure(Account, Account.account_ref, dict(account_id=demo_id(a["id"]), account_ref=a["reference"],
               customer_id=owner.customer_id, customer_type=owner.customer_type, account_type=a["accountType"],
               currency=a["currency"], opening_balance=Decimal(a["openingCents"])/100, status=a["status"],
               created_at=datetime.fromisoformat(a["createdAt"].replace("Z", "+00:00"))))
    for p in data["payment_transactions"]:
        ensure(Transaction, Transaction.reference, dict(reference=p["id"], payment_reference=p["id"],
               amount=Decimal(p["amountCents"])/100, currency=p["currency"], status=p["status"].upper(),
               created_at=datetime.fromisoformat(p["createdAt"].replace("Z", "+00:00"))))
    for j in data["ledger_journals"]:
        ensure(LedgerJournal, LedgerJournal.journal_ref, dict(journal_id=demo_id(j["id"]), journal_ref=j["id"],
               payment_reference=j["paymentId"], currency=j["currency"], status=j["status"],
               posted_at=datetime.fromisoformat(j["postedAt"].replace("Z", "+00:00"))))
    for e in data["ledger_entries"]:
        ensure(LedgerEntry, LedgerEntry.entry_ref, dict(entry_id=demo_id(e["id"]), entry_ref=e["id"],
               journal_id=demo_id(e["journalId"]), account_id=demo_id(e["accountId"]), side=e["side"],
               amount=Decimal(e["amountCents"])/100, currency=e["currency"], description=e["description"], posted=True))
    for p in data["payment_transactions"]:
        tx = db.scalar(select(Transaction).where(Transaction.reference == p["id"]))
        instruction = db.scalar(select(PaymentInstruction).where(PaymentInstruction.transaction_id == tx.id))
        if instruction is None:
            db.add(PaymentInstruction(payment_id=demo_id(p["id"]), transaction_id=tx.id,
                sender_account_id=demo_id(p["senderId"]), receiver_account_id=demo_id(p["receiverId"]),
                idempotency_key=f"seed:{p['id']}", request_fingerprint="seed", scenario_code="NORMAL",
                completed_at=datetime.fromisoformat(p["createdAt"].replace("Z", "+00:00"))))
            db.add(ProcessingEvent(transaction_id=tx.id, event_type="SOURCE_IMPORTED", status="COMPLETED",
                details="Existing completed source and posted journal imported; earlier processing stages are unavailable.",
                created_at=datetime.now(timezone.utc)))
            report["created"] += 1
    db.flush()
    return report


if __name__ == "__main__":
    with SessionLocal.begin() as session:
        print(json.dumps(seed_demo(session), indent=2))
