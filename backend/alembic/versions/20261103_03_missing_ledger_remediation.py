"""Add an auditable, idempotent missing-ledger remediation lifecycle."""
from alembic import op
import sqlalchemy as sa

revision = "20261103_03"
down_revision = "20261103_02"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("exceptions") as batch:
        batch.add_column(sa.Column("updated_at", sa.DateTime(timezone=True)))
        batch.add_column(sa.Column("resolved_at", sa.DateTime(timezone=True)))
        batch.add_column(sa.Column("resolution_summary", sa.Text()))
    op.execute("UPDATE exceptions SET updated_at = created_at WHERE updated_at IS NULL")
    with op.batch_alter_table("exceptions") as batch:
        batch.alter_column("updated_at", nullable=False)
    op.create_table("exception_case_actions",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("exception_id", sa.Integer(), sa.ForeignKey("exceptions.id"), nullable=False),
        sa.Column("action_type", sa.String(40), nullable=False),
        sa.Column("actor", sa.String(80), nullable=False),
        sa.Column("details", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False))
    op.create_index("ix_exception_case_actions_exception_id", "exception_case_actions", ["exception_id"])
    op.create_table("ledger_posting_remediations",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("exception_id", sa.Integer(), sa.ForeignKey("exceptions.id"), nullable=False, unique=True),
        sa.Column("journal_id", sa.Uuid(), sa.ForeignKey("ledger_journals.journal_id"), nullable=False, unique=True),
        sa.Column("idempotency_key", sa.String(100), nullable=False, unique=True),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("created_by", sa.String(80), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False))


def downgrade():
    raise RuntimeError("Remediation and audit history cannot be destructively downgraded.")
