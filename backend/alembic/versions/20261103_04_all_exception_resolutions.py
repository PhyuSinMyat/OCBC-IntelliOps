"""Add durable resolution outcomes for all supported exception types."""
from alembic import op
import sqlalchemy as sa

revision = "20261103_04"
down_revision = "20261103_03"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("exception_resolutions",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("exception_id", sa.Integer(), sa.ForeignKey("exceptions.id"), nullable=False, unique=True),
        sa.Column("resolution_type", sa.String(50), nullable=False),
        sa.Column("idempotency_key", sa.String(100), nullable=False, unique=True),
        sa.Column("journal_id", sa.Uuid(), sa.ForeignKey("ledger_journals.journal_id"), unique=True),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("details", sa.JSON(), nullable=False),
        sa.Column("created_by", sa.String(80), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False))


def downgrade():
    raise RuntimeError("Exception resolution and audit history cannot be destructively downgraded.")
