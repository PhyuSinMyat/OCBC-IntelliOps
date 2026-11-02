from datetime import datetime
from decimal import Decimal
from sqlalchemy import String, Numeric, ForeignKey, DateTime, Boolean, Integer, Text, JSON
from sqlalchemy.orm import Mapped, mapped_column
from shared.database import Base
from shared.timestamps import utc_now
from sqlalchemy import Index


class DetectionRule(Base):
    __tablename__ = "detection_rules"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(100), unique=True)
    exception_type: Mapped[str] = mapped_column(String(50))
    threshold: Mapped[int | None] = mapped_column(Integer)
    enabled: Mapped[bool] = mapped_column(
        Boolean, default=True
    )




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
    __table_args__ = (Index("uq_active_detection", "detection_key", unique=True,
                           postgresql_where=status.not_in(["RESOLVED", "CLOSED"]),
                           sqlite_where=status.not_in(["RESOLVED", "CLOSED"])),)


class AuditEvent(Base):
    __tablename__ = "audit_events"
    id: Mapped[int] = mapped_column(primary_key=True)
    action: Mapped[str] = mapped_column(String(80))
    actor: Mapped[str] = mapped_column(String(80))
    reference: Mapped[str] = mapped_column(String(100), index=True)
    details: Mapped[dict] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
