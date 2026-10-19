
from datetime import datetime, timezone
from decimal import Decimal

from sqlalchemy import (
    String, Numeric, ForeignKey, DateTime,
    Boolean, Integer, Text, JSON
)
from sqlalchemy.orm import Mapped, mapped_column

from database import Base


def utc_now():
    return datetime.now(timezone.utc)


# 1. Transactions
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


# 2. Ledger Records
class LedgerRecord(Base):
    __tablename__ = "ledger_records"

    id: Mapped[int] = mapped_column(primary_key=True)
    transaction_id: Mapped[int] = mapped_column(
        ForeignKey("transactions.id"), index=True
    )
    amount: Mapped[Decimal] = mapped_column(Numeric(18, 2))
    currency: Mapped[str] = mapped_column(String(3))
    entry_type: Mapped[str] = mapped_column(String(20))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now
    )


# 3. Processing Events
class ProcessingEvent(Base):
    __tablename__ = "processing_events"

    id: Mapped[int] = mapped_column(primary_key=True)
    transaction_id: Mapped[int] = mapped_column(
        ForeignKey("transactions.id"), index=True
    )
    event_type: Mapped[str] = mapped_column(String(50))
    details: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now
    )


# 4. Detection Rules
class DetectionRule(Base):
    __tablename__ = "detection_rules"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(100), unique=True)
    exception_type: Mapped[str] = mapped_column(String(50))
    threshold: Mapped[int | None] = mapped_column(Integer)
    enabled: Mapped[bool] = mapped_column(
        Boolean, default=True
    )


# 5. Exceptions
class ExceptionCase(Base):
    __tablename__ = "exceptions"

    id: Mapped[int] = mapped_column(primary_key=True)
    transaction_id: Mapped[int] = mapped_column(
        ForeignKey("transactions.id"), index=True
    )
    rule_id: Mapped[int | None] = mapped_column(
        ForeignKey("detection_rules.id")
    )
    exception_type: Mapped[str] = mapped_column(String(50))
    severity: Mapped[str] = mapped_column(String(20))
    status: Mapped[str] = mapped_column(
        String(30), default="OPEN"
    )
    evidence: Mapped[dict | None] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now
    )
