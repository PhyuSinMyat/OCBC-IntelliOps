"""Add auditable automatic exception batch generation."""
from alembic import op
import sqlalchemy as sa

revision = "20261103_05"
down_revision = "20261103_04"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("exception_batches",
        sa.Column("batch_id", sa.Uuid(), primary_key=True),
        sa.Column("requested_scenarios", sa.JSON(), nullable=False),
        sa.Column("count_per_type", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("created_by", sa.String(80), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True)))
    op.create_table("exception_batch_items",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("batch_id", sa.Uuid(), sa.ForeignKey("exception_batches.batch_id"), nullable=False),
        sa.Column("transaction_id", sa.Integer(), sa.ForeignKey("transactions.id"), nullable=False, unique=True),
        sa.Column("scenario_code", sa.String(50), nullable=False),
        sa.Column("sequence", sa.Integer(), nullable=False))
    op.create_index("ix_exception_batch_items_batch_id", "exception_batch_items", ["batch_id"])


def downgrade():
    raise RuntimeError("Exception batch history cannot be destructively downgraded.")
