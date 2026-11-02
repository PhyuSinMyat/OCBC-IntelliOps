from datetime import datetime
from decimal import Decimal
from sqlalchemy import String, Numeric, ForeignKey, DateTime, Boolean, Integer, Text, JSON
from sqlalchemy.orm import Mapped, mapped_column
from shared.database import Base
from shared.timestamps import utc_now
from uuid import UUID, uuid4
from sqlalchemy import CheckConstraint, UniqueConstraint, ForeignKeyConstraint, Uuid


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


class Customer(Base):
    __tablename__ = "customers"
    __table_args__ = (
        CheckConstraint("customer_type IN ('INDIVIDUAL', 'BUSINESS')", name="ck_customer_type"),
        UniqueConstraint("customer_id", "customer_type", name="uq_customer_ownership"),
    )
    customer_id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    customer_ref: Mapped[str] = mapped_column(String(50), unique=True)
    customer_name: Mapped[str] = mapped_column(String(150))
    customer_type: Mapped[str] = mapped_column(String(20))
    status: Mapped[str] = mapped_column(String(20), default="Active")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)


class Account(Base):
    __tablename__ = "accounts"
    __table_args__ = (
        CheckConstraint("account_type IN ('SAVINGS', 'CURRENT')", name="ck_account_type"),
        CheckConstraint("customer_type = 'INDIVIDUAL' OR (customer_type = 'BUSINESS' AND account_type = 'CURRENT')", name="ck_account_ownership_product"),
        ForeignKeyConstraint(["customer_id", "customer_type"], ["customers.customer_id", "customers.customer_type"], name="fk_account_owner"),
    )
    account_id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    account_ref: Mapped[str] = mapped_column(String(50), unique=True)
    customer_id: Mapped[UUID] = mapped_column(Uuid, index=True)
    # Composite FK prevents false ownership classification even outside API services.
    customer_type: Mapped[str] = mapped_column(String(20))
    account_type: Mapped[str] = mapped_column(String(20))
    currency: Mapped[str] = mapped_column(String(3))
    opening_balance: Mapped[Decimal] = mapped_column(Numeric(18, 2))
    status: Mapped[str] = mapped_column(String(20), default="Active")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)


class LedgerJournal(Base):
    __tablename__ = "ledger_journals"
    journal_id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    journal_ref: Mapped[str] = mapped_column(String(50), unique=True)
    # Nullable: unmatched journals remain visible; no payment is fabricated.
    payment_reference: Mapped[str | None] = mapped_column(String(100), index=True)
    source_transaction_id: Mapped[int | None] = mapped_column(ForeignKey("transactions.id"), index=True)
    currency: Mapped[str] = mapped_column(String(3))
    status: Mapped[str] = mapped_column(String(20))
    posted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class LedgerEntry(Base):
    __tablename__ = "ledger_entries"
    __table_args__ = (
        CheckConstraint("amount > 0", name="ck_entry_positive"),
        CheckConstraint("side IN ('Debit', 'Credit')", name="ck_entry_side"),
    )
    entry_id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    entry_ref: Mapped[str] = mapped_column(String(80), unique=True)
    journal_id: Mapped[UUID] = mapped_column(ForeignKey("ledger_journals.journal_id"), index=True)
    account_id: Mapped[UUID] = mapped_column(ForeignKey("accounts.account_id"), index=True)
    side: Mapped[str] = mapped_column(String(10))
    amount: Mapped[Decimal] = mapped_column(Numeric(18, 2))
    currency: Mapped[str] = mapped_column(String(3))
    description: Mapped[str] = mapped_column(Text)
    posted: Mapped[bool] = mapped_column(Boolean, default=True)
