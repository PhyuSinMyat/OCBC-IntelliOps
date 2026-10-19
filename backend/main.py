from fastapi import FastAPI
from database import Base, engine, SessionLocal
from models import Transaction
from sqlalchemy import select

app = FastAPI(title="OCBC IntelliOps API")

# For initial local development only.
# Use Alembic migrations later.
Base.metadata.create_all(bind=engine)


@app.get("/")
def home():
    return {
        "project": "OCBC IntelliOps",
        "status": "Backend running"
    }


@app.post("/demo/transactions")
def create_demo_transaction():
    from decimal import Decimal

    with SessionLocal.begin() as db:
        existing = db.scalar(
            select(Transaction).where(
                Transaction.reference == "TXN001"
            )
        )

        if existing:
            return {
                "message": "Transaction already exists",
                "reference": existing.reference
            }

        transaction = Transaction(
            reference="TXN001",
            payment_reference="PAY001",
            amount=Decimal("500.00"),
            currency="SGD",
            status="COMPLETED"
        )
        db.add(transaction)

    return {"message": "Transaction created", "reference": "TXN001"}


@app.get("/transactions")
def get_transactions():
    with SessionLocal() as db:
        transactions = db.scalars(
            select(Transaction)
        ).all()

        return [
            {
                "reference": t.reference,
                "amount": str(t.amount),
                "currency": t.currency,
                "status": t.status
            }
            for t in transactions
        ]

@app.get("/health")
def health():
    return {"status": "healthy"}