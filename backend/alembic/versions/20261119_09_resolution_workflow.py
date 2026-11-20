"""durable resolution plans, communications and policy assessments"""
from alembic import op
import sqlalchemy as sa

revision = "20261119_09"
down_revision = "20261111_08"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "resolution_plans",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("case_id", sa.Integer(), sa.ForeignKey("exceptions.id"), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("previous_plan_id", sa.String(36), sa.ForeignKey("resolution_plans.id")),
        sa.Column("investigation_id", sa.String(50), nullable=False),
        sa.Column("evidence_fingerprint", sa.String(64), nullable=False),
        sa.Column("customer_context_revision", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("customer_snapshot", sa.JSON(), nullable=False),
        sa.Column("action_code", sa.String(80), nullable=False),
        sa.Column("plan_json", sa.JSON(), nullable=False),
        sa.Column("model_metadata", sa.JSON(), nullable=False),
        sa.Column("created_by", sa.String(80), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("version >= 1", name="ck_resolution_plan_version"),
        sa.CheckConstraint("customer_context_revision >= 0", name="ck_resolution_context_revision"),
        sa.UniqueConstraint("case_id", "version", name="uq_resolution_plan_case_version"),
    )
    op.create_index("ix_resolution_plans_case_id", "resolution_plans", ["case_id"])
    op.create_index("ix_resolution_plans_investigation_id", "resolution_plans", ["investigation_id"])
    op.create_table(
        "customer_communications",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("case_id", sa.Integer(), sa.ForeignKey("exceptions.id"), nullable=False),
        sa.Column("investigation_id", sa.String(50), nullable=False),
        sa.Column("customer_id", sa.String(80), nullable=False),
        sa.Column("related_transaction_id", sa.String(80)),
        sa.Column("direction", sa.String(20), nullable=False),
        sa.Column("communication_type", sa.String(50), nullable=False),
        sa.Column("subject", sa.String(200)),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("recipient_email", sa.String(254)),
        sa.Column("status", sa.String(30), nullable=False),
        sa.Column("related_communication_id", sa.String(36), sa.ForeignKey("customer_communications.id")),
        sa.Column("recorded_by", sa.String(80), nullable=False),
        sa.Column("simulated", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("direction IN ('OUTGOING','INCOMING','SYSTEM')", name="ck_communication_direction"),
        sa.CheckConstraint("simulated = true", name="ck_communication_simulated"),
    )
    op.create_index("ix_customer_communications_case_id", "customer_communications", ["case_id"])
    op.create_index("ix_customer_communications_investigation_id", "customer_communications", ["investigation_id"])
    op.create_index("ix_communication_case_created", "customer_communications", ["case_id", "created_at"])
    op.create_table(
        "policy_assessments",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("case_id", sa.Integer(), sa.ForeignKey("exceptions.id"), nullable=False),
        sa.Column("plan_id", sa.String(36), sa.ForeignKey("resolution_plans.id"), nullable=False),
        sa.Column("investigation_id", sa.String(50), nullable=False),
        sa.Column("plan_version", sa.Integer(), nullable=False),
        sa.Column("policy_version", sa.String(30), nullable=False),
        sa.Column("outcome", sa.String(30), nullable=False),
        sa.Column("check_results", sa.JSON(), nullable=False),
        sa.Column("evidence_fingerprint", sa.String(64), nullable=False),
        sa.Column("context_revision", sa.Integer(), nullable=False),
        sa.Column("verification", sa.JSON(), nullable=False),
        sa.Column("assessed_by", sa.String(80), nullable=False),
        sa.Column("assessed_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("outcome IN ('BLOCKED','REVIEW_REQUIRED','APPROVAL_REQUIRED','ELIGIBLE')", name="ck_policy_outcome"),
    )
    op.create_index("ix_policy_assessments_case_id", "policy_assessments", ["case_id"])
    op.create_index("ix_policy_assessments_plan_id", "policy_assessments", ["plan_id"])
    op.create_index("ix_policy_case_assessed", "policy_assessments", ["case_id", "assessed_at"])
    if op.get_bind().dialect.name == "postgresql":
        op.execute("""
        CREATE FUNCTION protect_resolution_workflow_history() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'Resolution workflow history is append-only';
        END;
        $$;
        """)
        for table in ("resolution_plans", "customer_communications", "policy_assessments"):
            op.execute(f"CREATE TRIGGER protect_{table}_history BEFORE UPDATE OR DELETE ON {table} FOR EACH ROW EXECUTE FUNCTION protect_resolution_workflow_history()")


def downgrade():
    if op.get_bind().dialect.name == "postgresql":
        for table in ("policy_assessments", "customer_communications", "resolution_plans"):
            op.execute(f"DROP TRIGGER IF EXISTS protect_{table}_history ON {table}")
        op.execute("DROP FUNCTION IF EXISTS protect_resolution_workflow_history()")
    op.drop_table("policy_assessments")
    op.drop_table("customer_communications")
    op.drop_table("resolution_plans")
