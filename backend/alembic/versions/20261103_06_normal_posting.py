"""Enforce one controlled normal journal without altering historical scenarios."""
from alembic import op
import sqlalchemy as sa

revision = "20261103_06"
down_revision = "20261103_05"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("ledger_journals") as batch:
        batch.add_column(sa.Column("normal_transaction_id", sa.Integer(), nullable=True))
        batch.add_column(sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                                   server_default=sa.func.now()))
        batch.create_foreign_key("fk_normal_journal_transaction", "transactions", ["normal_transaction_id"], ["id"])
        batch.create_unique_constraint("uq_normal_journal_transaction", ["normal_transaction_id"])


def downgrade():
    raise RuntimeError("Financial history is preserved; destructive downgrade is disabled.")
