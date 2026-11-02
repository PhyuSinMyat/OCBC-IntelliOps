from fastapi import APIRouter, Depends
from shared.security import actor
from sqlalchemy import select
from shared.database import SessionLocal
from .models import Transaction
from modules.intelliops.models import AuditEvent

router = APIRouter(tags=["Payment Processing"], dependencies=[Depends(actor)])


@router.post("/demo/transactions")
def create_demo_transaction(role=Depends(actor)):
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
        db.add(AuditEvent(action="LEGACY_DEMO_TRANSACTION_CREATED", actor=role, reference="TXN001", details={"source": "legacy-demo-endpoint"}))

    return {"message": "Transaction created", "reference": "TXN001"}


@router.get("/transactions")
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
