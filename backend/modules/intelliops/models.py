from datetime import datetime
from decimal import Decimal
from sqlalchemy import String, Numeric, ForeignKey, DateTime, Boolean, Integer, Text, JSON
from sqlalchemy.orm import Mapped, mapped_column
from shared.database import Base
from shared.timestamps import utc_now
from sqlalchemy import Index, Uuid, CheckConstraint, UniqueConstraint
from uuid import UUID


class DetectionRule(Base):
    __tablename__ = "detection_rules"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(100), unique=True)
    exception_type: Mapped[str] = mapped_column(String(50))
    threshold: Mapped[int | None] = mapped_column(Integer)
    enabled: Mapped[bool] = mapped_column(
        Boolean, default=True
    )
    code: Mapped[str | None] = mapped_column(String(60), unique=True)
    description: Mapped[str] = mapped_column(Text, default="")
    severity: Mapped[str] = mapped_column(String(20), default="HIGH")
    configuration: Mapped[dict] = mapped_column(JSON, default=dict)
    version: Mapped[int] = mapped_column(Integer, default=1)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, onupdate=utc_now)
    __table_args__ = (
        UniqueConstraint("exception_type", name="uq_detection_rule_type"),
        CheckConstraint("version >= 1", name="ck_detection_rule_version"),
        CheckConstraint("severity IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')", name="ck_detection_rule_severity"),
        CheckConstraint("threshold IS NULL OR threshold >= 0", name="ck_detection_rule_threshold"),
    )


class DetectionObservation(Base):
    """Latest detector observation; recovery must be observed before recurrence.

    This mutable cursor is separate from immutable case evidence/history.
    """
    __tablename__ = "detection_observations"
    id: Mapped[int] = mapped_column(primary_key=True)
    transaction_id: Mapped[int] = mapped_column(ForeignKey("transactions.id"), index=True)
    rule_id: Mapped[int] = mapped_column(ForeignKey("detection_rules.id"))
    defective: Mapped[bool] = mapped_column(Boolean)
    fingerprint: Mapped[str | None] = mapped_column(String(64))
    policy_fingerprint: Mapped[str] = mapped_column(String(64))
    observed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    __table_args__ = (UniqueConstraint("transaction_id", "rule_id", name="uq_detection_observation"),)




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
    detection_key: Mapped[str | None] = mapped_column(String(150))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now
    )
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    resolution_summary: Mapped[str | None] = mapped_column(Text)
    __table_args__ = (Index("uq_active_detection", "detection_key", unique=True,
                           postgresql_where=status.not_in(["RESOLVED", "CLOSED"]),
                           sqlite_where=status.not_in(["RESOLVED", "CLOSED"])),)


class ExceptionCaseAction(Base):
    """Append-only operational history for an exception case."""
    __tablename__ = "exception_case_actions"

    id: Mapped[int] = mapped_column(primary_key=True)
    exception_id: Mapped[int] = mapped_column(ForeignKey("exceptions.id"), index=True)
    action_type: Mapped[str] = mapped_column(String(40))
    actor: Mapped[str] = mapped_column(String(80))
    details: Mapped[dict] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)


class LedgerPostingRemediation(Base):
    """One durable, idempotent corrective posting for a missing-ledger case."""
    __tablename__ = "ledger_posting_remediations"

    id: Mapped[int] = mapped_column(primary_key=True)
    exception_id: Mapped[int] = mapped_column(ForeignKey("exceptions.id"), unique=True)
    journal_id: Mapped[UUID] = mapped_column(ForeignKey("ledger_journals.journal_id"), unique=True)
    idempotency_key: Mapped[str] = mapped_column(String(100), unique=True)
    status: Mapped[str] = mapped_column(String(20), default="POSTED")
    created_by: Mapped[str] = mapped_column(String(80))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)


class ExceptionResolution(Base):
    """Idempotent resolution outcome for non-missing-ledger exception types."""
    __tablename__ = "exception_resolutions"

    id: Mapped[int] = mapped_column(primary_key=True)
    exception_id: Mapped[int] = mapped_column(ForeignKey("exceptions.id"), unique=True)
    resolution_type: Mapped[str] = mapped_column(String(50))
    idempotency_key: Mapped[str] = mapped_column(String(100), unique=True)
    journal_id: Mapped[UUID | None] = mapped_column(ForeignKey("ledger_journals.journal_id"), unique=True)
    status: Mapped[str] = mapped_column(String(20), default="COMPLETED")
    details: Mapped[dict] = mapped_column(JSON)
    created_by: Mapped[str] = mapped_column(String(80))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)


class AuditEvent(Base):
    __tablename__ = "audit_events"
    id: Mapped[int] = mapped_column(primary_key=True)
    action: Mapped[str] = mapped_column(String(80))
    actor: Mapped[str] = mapped_column(String(80))
    reference: Mapped[str] = mapped_column(String(100), index=True)
    details: Mapped[dict] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
