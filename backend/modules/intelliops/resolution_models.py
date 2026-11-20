"""Durable, append-only records for the resolution review workflow."""
from datetime import datetime
from uuid import uuid4

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, Integer, JSON, String, Text, UniqueConstraint, event, select
from sqlalchemy.orm import Mapped, mapped_column

from shared.database import Base
from shared.timestamps import utc_now


def new_id():
    return str(uuid4())


class ResolutionPlan(Base):
    __tablename__ = "resolution_plans"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    case_id: Mapped[int] = mapped_column(ForeignKey("exceptions.id"), nullable=False, index=True)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    previous_plan_id: Mapped[str | None] = mapped_column(ForeignKey("resolution_plans.id"))
    investigation_id: Mapped[str] = mapped_column(String(50), nullable=False, index=True)
    evidence_fingerprint: Mapped[str] = mapped_column(String(64), nullable=False)
    customer_context_revision: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    customer_snapshot: Mapped[dict] = mapped_column(JSON, nullable=False)
    action_code: Mapped[str] = mapped_column(String(80), nullable=False)
    plan_json: Mapped[dict] = mapped_column(JSON, nullable=False)
    model_metadata: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    created_by: Mapped[str] = mapped_column(String(80), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)
    __table_args__ = (
        UniqueConstraint("case_id", "version", name="uq_resolution_plan_case_version"),
        CheckConstraint("version >= 1", name="ck_resolution_plan_version"),
        CheckConstraint("customer_context_revision >= 0", name="ck_resolution_context_revision"),
    )


class CustomerCommunication(Base):
    __tablename__ = "customer_communications"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    case_id: Mapped[int] = mapped_column(ForeignKey("exceptions.id"), nullable=False, index=True)
    investigation_id: Mapped[str] = mapped_column(String(50), nullable=False, index=True)
    customer_id: Mapped[str] = mapped_column(String(80), nullable=False)
    related_transaction_id: Mapped[str | None] = mapped_column(String(80))
    direction: Mapped[str] = mapped_column(String(20), nullable=False)
    communication_type: Mapped[str] = mapped_column(String(50), nullable=False)
    subject: Mapped[str | None] = mapped_column(String(200))
    body: Mapped[str] = mapped_column(Text, nullable=False)
    recipient_email: Mapped[str | None] = mapped_column(String(254))
    status: Mapped[str] = mapped_column(String(30), nullable=False)
    related_communication_id: Mapped[str | None] = mapped_column(ForeignKey("customer_communications.id"))
    recorded_by: Mapped[str] = mapped_column(String(80), nullable=False)
    simulated: Mapped[bool] = mapped_column(nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)
    __table_args__ = (
        CheckConstraint("direction IN ('OUTGOING','INCOMING','SYSTEM')", name="ck_communication_direction"),
        Index("ix_communication_case_created", "case_id", "created_at"),
    )


class EmailDelivery(Base):
    __tablename__ = "email_deliveries"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    communication_id: Mapped[str] = mapped_column(ForeignKey("customer_communications.id"), nullable=False, unique=True)
    recipient_email: Mapped[str] = mapped_column(String(254), nullable=False)
    message_id: Mapped[str] = mapped_column(String(254), nullable=False, unique=True)
    provider: Mapped[str] = mapped_column(String(30), nullable=False, default="SMTP")
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="PENDING")
    attempt_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    last_error_code: Mapped[str | None] = mapped_column(String(80))
    queued_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)
    attempted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    __table_args__ = (
        CheckConstraint("status IN ('PENDING','SENDING','SENT','FAILED','UNKNOWN')", name="ck_email_delivery_status"),
        CheckConstraint("attempt_count >= 0", name="ck_email_attempt_count"),
        Index("ix_email_delivery_status", "status", "queued_at"),
    )


class InboundEmailReceipt(Base):
    __tablename__ = "inbound_email_receipts"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    communication_id: Mapped[str] = mapped_column(ForeignKey("customer_communications.id"), nullable=False, unique=True)
    provider_message_id: Mapped[str] = mapped_column(String(254), nullable=False, unique=True)
    mailbox: Mapped[str] = mapped_column(String(120), nullable=False)
    mailbox_uid: Mapped[str] = mapped_column(String(120), nullable=False)
    sender_email: Mapped[str] = mapped_column(String(254), nullable=False)
    in_reply_to: Mapped[str] = mapped_column(String(254), nullable=False)
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    imported_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)
    __table_args__ = (
        UniqueConstraint("mailbox", "mailbox_uid", name="uq_inbound_email_mailbox_uid"),
        Index("ix_inbound_email_received", "received_at"),
    )


class PolicyAssessment(Base):
    __tablename__ = "policy_assessments"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    case_id: Mapped[int] = mapped_column(ForeignKey("exceptions.id"), nullable=False, index=True)
    plan_id: Mapped[str] = mapped_column(ForeignKey("resolution_plans.id"), nullable=False, index=True)
    investigation_id: Mapped[str] = mapped_column(String(50), nullable=False)
    plan_version: Mapped[int] = mapped_column(Integer, nullable=False)
    policy_version: Mapped[str] = mapped_column(String(30), nullable=False)
    outcome: Mapped[str] = mapped_column(String(30), nullable=False)
    check_results: Mapped[list] = mapped_column(JSON, nullable=False)
    evidence_fingerprint: Mapped[str] = mapped_column(String(64), nullable=False)
    context_revision: Mapped[int] = mapped_column(Integer, nullable=False)
    verification: Mapped[dict] = mapped_column(JSON, nullable=False)
    assessed_by: Mapped[str] = mapped_column(String(80), nullable=False)
    assessed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)
    __table_args__ = (
        CheckConstraint("outcome IN ('BLOCKED','REVIEW_REQUIRED','APPROVAL_REQUIRED','ELIGIBLE')", name="ck_policy_outcome"),
        Index("ix_policy_case_assessed", "case_id", "assessed_at"),
    )


class ApprovalRequest(Base):
    """Durable human-approval handoff; decisions never execute financial work."""
    __tablename__ = "approval_requests"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    case_id: Mapped[int] = mapped_column(ForeignKey("exceptions.id"), nullable=False, index=True)
    assessment_id: Mapped[str] = mapped_column(ForeignKey("policy_assessments.id"), nullable=False, unique=True)
    plan_id: Mapped[str] = mapped_column(ForeignKey("resolution_plans.id"), nullable=False, index=True)
    investigation_id: Mapped[str] = mapped_column(String(50), nullable=False, index=True)
    plan_version: Mapped[int] = mapped_column(Integer, nullable=False)
    proposed_action: Mapped[str] = mapped_column(String(80), nullable=False)
    customer_snapshot_reference: Mapped[str] = mapped_column(String(180), nullable=False)
    required_approver_role: Mapped[str] = mapped_column(String(40), nullable=False, default="Administrator")
    status: Mapped[str] = mapped_column(String(30), nullable=False, default="PENDING_APPROVAL")
    requested_by: Mapped[str] = mapped_column(String(80), nullable=False)
    requested_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)
    decided_by: Mapped[str | None] = mapped_column(String(80))
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    decision_reason: Mapped[str | None] = mapped_column(Text)
    __table_args__ = (
        CheckConstraint("plan_version >= 1", name="ck_approval_plan_version"),
        CheckConstraint("status IN ('PENDING_APPROVAL','APPROVED','REJECTED')", name="ck_approval_status"),
        CheckConstraint("required_approver_role = 'Administrator'", name="ck_approval_required_role"),
        CheckConstraint(
            "(status = 'PENDING_APPROVAL' AND decided_by IS NULL AND decided_at IS NULL AND decision_reason IS NULL) OR "
            "(status IN ('APPROVED','REJECTED') AND decided_by IS NOT NULL AND decided_at IS NOT NULL AND decision_reason IS NOT NULL)",
            name="ck_approval_decision_state"),
        Index("ix_approval_status_requested", "status", "requested_at"),
    )


def _immutable(mapper, connection, target):
    raise ValueError(f"{target.__class__.__name__} records are append-only.")


for immutable_model in (ResolutionPlan, CustomerCommunication, PolicyAssessment):
    event.listen(immutable_model, "before_update", _immutable)
    event.listen(immutable_model, "before_delete", _immutable)
