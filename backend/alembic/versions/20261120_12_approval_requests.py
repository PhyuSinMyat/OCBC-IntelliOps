"""Add durable administrator approval requests and decisions."""
from alembic import op
import sqlalchemy as sa


revision = "20261120_12"
down_revision = "20261120_11"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "approval_requests",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("case_id", sa.Integer(), sa.ForeignKey("exceptions.id"), nullable=False),
        sa.Column("assessment_id", sa.String(36), sa.ForeignKey("policy_assessments.id"), nullable=False, unique=True),
        sa.Column("plan_id", sa.String(36), sa.ForeignKey("resolution_plans.id"), nullable=False),
        sa.Column("investigation_id", sa.String(50), nullable=False),
        sa.Column("plan_version", sa.Integer(), nullable=False),
        sa.Column("proposed_action", sa.String(80), nullable=False),
        sa.Column("customer_snapshot_reference", sa.String(180), nullable=False),
        sa.Column("required_approver_role", sa.String(40), nullable=False, server_default="Administrator"),
        sa.Column("status", sa.String(30), nullable=False, server_default="PENDING_APPROVAL"),
        sa.Column("requested_by", sa.String(80), nullable=False),
        sa.Column("requested_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("decided_by", sa.String(80)),
        sa.Column("decided_at", sa.DateTime(timezone=True)),
        sa.Column("decision_reason", sa.Text()),
        sa.CheckConstraint("plan_version >= 1", name="ck_approval_plan_version"),
        sa.CheckConstraint("status IN ('PENDING_APPROVAL','APPROVED','REJECTED')", name="ck_approval_status"),
        sa.CheckConstraint("required_approver_role = 'Administrator'", name="ck_approval_required_role"),
        sa.CheckConstraint(
            "(status = 'PENDING_APPROVAL' AND decided_by IS NULL AND decided_at IS NULL AND decision_reason IS NULL) OR "
            "(status IN ('APPROVED','REJECTED') AND decided_by IS NOT NULL AND decided_at IS NOT NULL AND decision_reason IS NOT NULL)",
            name="ck_approval_decision_state"),
    )
    op.create_index("ix_approval_requests_case_id", "approval_requests", ["case_id"])
    op.create_index("ix_approval_requests_plan_id", "approval_requests", ["plan_id"])
    op.create_index("ix_approval_requests_investigation_id", "approval_requests", ["investigation_id"])
    op.create_index("ix_approval_status_requested", "approval_requests", ["status", "requested_at"])


def downgrade():
    op.drop_table("approval_requests")
