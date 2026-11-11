from datetime import datetime
from decimal import Decimal
from sqlalchemy import String, Numeric, ForeignKey, DateTime, Boolean, Integer, Text, JSON
from sqlalchemy.orm import Mapped, mapped_column
from shared.database import Base
from shared.timestamps import utc_now
from uuid import UUID, uuid4
from sqlalchemy import Uuid, CheckConstraint


class Transaction(Base):
    __tablename__ = "transactions"

    id: Mapped[int] = mapped_column(primary_key=True)
    reference: Mapped[str] = mapped_column(
        String(100), unique=True, index=True
    )
    payment_reference: Mapped[str] = mapped_column(
    String(100), index=True
    )
    amount: Mapped[Decimal] = mapped_column(Numeric(18, 2))
    currency: Mapped[str] = mapped_column(String(3))
    status: Mapped[str] = mapped_column(String(30))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now
    )




class ProcessingEvent(Base):
    __tablename__ = "processing_events"

    id: Mapped[int] = mapped_column(primary_key=True)
    request_id: Mapped[UUID | None] = mapped_column(ForeignKey("payment_requests.request_id"), index=True)
    transaction_id: Mapped[int] = mapped_column(
        ForeignKey("transactions.id"), index=True
    )
    event_type: Mapped[str] = mapped_column(String(50))
    details: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str | None] = mapped_column(String(30))
    error_code: Mapped[str | None] = mapped_column(String(50))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now
    )


class PaymentInstruction(Base):
    """Normalized extension of transactions; legacy integer IDs stay intact."""
    __tablename__ = "payment_instructions"
    payment_id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    transaction_id: Mapped[int] = mapped_column(ForeignKey("transactions.id"), unique=True)
    sender_account_id: Mapped[UUID] = mapped_column(ForeignKey("accounts.account_id"), index=True)
    receiver_account_id: Mapped[UUID] = mapped_column(ForeignKey("accounts.account_id"), index=True)
    idempotency_key: Mapped[str] = mapped_column(String(100), unique=True)
    request_fingerprint: Mapped[str] = mapped_column(String(64))
    original_payment_id: Mapped[UUID | None] = mapped_column(ForeignKey("payment_instructions.payment_id"))
    scenario_code: Mapped[str] = mapped_column(String(50), default="NORMAL")
    failure_code: Mapped[str | None] = mapped_column(String(50))
    failure_description: Mapped[str | None] = mapped_column(Text)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    reconciliation_due_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    __table_args__ = (CheckConstraint("sender_account_id <> receiver_account_id", name="ck_payment_parties"),)


class ExceptionBatch(Base):
    __tablename__ = "exception_batches"
    batch_id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    run_key: Mapped[str | None] = mapped_column(String(100), unique=True)
    input_fingerprint: Mapped[str | None] = mapped_column(String(64))
    private_metadata: Mapped[dict | None] = mapped_column(JSON)
    requested_scenarios: Mapped[list] = mapped_column(JSON)
    count_per_type: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(20), default="COMPLETED")
    created_by: Mapped[str] = mapped_column(String(80))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class ExceptionBatchItem(Base):
    __tablename__ = "exception_batch_items"
    id: Mapped[int] = mapped_column(primary_key=True)
    batch_id: Mapped[UUID] = mapped_column(ForeignKey("exception_batches.batch_id"), index=True)
    transaction_id: Mapped[int] = mapped_column(ForeignKey("transactions.id"), unique=True)
    scenario_code: Mapped[str] = mapped_column(String(50))
    sequence: Mapped[int] = mapped_column(Integer)


class PaymentRequestHistory(Base):
    __tablename__ = "payment_requests"
    request_id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    business_instruction_id: Mapped[UUID] = mapped_column(ForeignKey("payment_instructions.payment_id"), index=True)
    payment_id: Mapped[UUID] = mapped_column(ForeignKey("payment_instructions.payment_id"), index=True)
    origin: Mapped[str] = mapped_column(String(10))
    retry_of_request_id: Mapped[UUID | None] = mapped_column(ForeignKey("payment_requests.request_id"), index=True)
    submitted_idempotency_key: Mapped[str] = mapped_column(String(100))
    authorization_id: Mapped[UUID | None] = mapped_column(Uuid, unique=True)
    correlation_id: Mapped[UUID | None] = mapped_column(Uuid)
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    __table_args__ = (
        CheckConstraint("origin IN ('CUSTOMER', 'SYSTEM')", name="ck_request_origin"),
        CheckConstraint("retry_of_request_id IS NULL OR (origin = 'SYSTEM' AND retry_of_request_id <> request_id)", name="ck_request_retry"),
    )
