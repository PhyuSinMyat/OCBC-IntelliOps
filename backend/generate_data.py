
import csv
import random
from datetime import datetime, timedelta, timezone
from decimal import Decimal

from faker import Faker
from sqlalchemy import select

from database import Base, engine, SessionLocal
from models import Transaction, LedgerRecord, ProcessingEvent

fake = Faker()
Faker.seed(42)
random.seed(42)

# 400 normal + 100 problematic = 500 transactions
DATA_PLAN = (
    ["NORMAL"] * 400
    + ["MISMATCH"] * 30
    + ["DUPLICATE"] * 20
    + ["TIMEOUT"] * 25
    + ["MISSING_LEDGER"] * 25
)

random.shuffle(DATA_PLAN)

if DATA_PLAN[0] != "NORMAL":
    first_normal = DATA_PLAN.index("NORMAL")
    DATA_PLAN[0], DATA_PLAN[first_normal] = (
        DATA_PLAN[first_normal],
        DATA_PLAN[0]
    )

BASE_TIME = datetime.now(timezone.utc) - timedelta(days=1)


def generate_amount():
    return Decimal(str(round(random.uniform(10, 5000), 2)))


def generate_data():
    Base.metadata.create_all(bind=engine)

    labels = []
    duplicate_payment_references = []

    with SessionLocal.begin() as db:
        # Prevent accidental double-generation.
        existing = db.scalar(
            select(Transaction.id).limit(1)
        )
        if existing is not None:
            raise RuntimeError(
                "Transactions already exist. "
                "Use a fresh development database."
            )

        for i, data_type in enumerate(DATA_PLAN, start=1):
            reference = f"TXN{i:06d}"
            amount = generate_amount()
            created_at = BASE_TIME + timedelta(seconds=i * 10)

            payment_reference = f"PAY{i:06d}"
            status = "COMPLETED"

            if data_type == "DUPLICATE":
                # Each duplicate shares the payment identifier
                # of an earlier successfully processed payment.
                payment_reference = random.choice(
                    duplicate_payment_references
                )

            if data_type == "TIMEOUT":
                status = "PENDING"

            transaction = Transaction(
                reference=reference,
                payment_reference=payment_reference,
                amount=amount,
                currency="SGD",
                status=status,
                created_at=created_at
            )

            db.add(transaction)
            db.flush()

            # Normal, duplicate, and mismatch transactions
            # have ledger records.
            if data_type not in ("TIMEOUT", "MISSING_LEDGER"):
                ledger_amount = amount

                if data_type == "MISMATCH":
                    ledger_amount = amount - Decimal("1.00")

                ledger = LedgerRecord(
                    transaction_id=transaction.id,
                    amount=ledger_amount,
                    currency="SGD",
                    entry_type="CREDIT",
                    created_at=created_at
                )
                db.add(ledger)

            event_type = (
                "PAYMENT_PENDING"
                if status == "PENDING"
                else "PAYMENT_COMPLETED"
            )

            db.add(
                ProcessingEvent(
                    transaction_id=transaction.id,
                    event_type=event_type,
                    details=f"Synthetic event: {data_type}",
                    created_at=created_at
                )
            )

            labels.append({
                "reference": reference,
                "payment_reference": payment_reference,
                "expected_type": data_type
            })

            # Store only successful, normal payment IDs
            # for generating duplicate attempts.
            if data_type == "NORMAL":
                duplicate_payment_references.append(
                    payment_reference
                )

    with open(
        "synthetic_labels.csv", "w", newline="", encoding="utf-8"
    ) as file:
        writer = csv.DictWriter(
            file,
            fieldnames=[
                "reference",
                "payment_reference",
                "expected_type"
            ]
        )
        writer.writeheader()
        writer.writerows(labels)

    print("Successfully generated 500 transactions!")
    print("Saved labels to synthetic_labels.csv")


if __name__ == "__main__":
    generate_data()
