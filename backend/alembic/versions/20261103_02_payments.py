"""Preserve transaction IDs while adding payment instructions, events and audit."""
from alembic import op
import sqlalchemy as sa

revision = "20261103_02"
down_revision = "20261103_01"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("ledger_journals") as batch:
        batch.add_column(sa.Column("source_transaction_id", sa.Integer()))
        batch.create_foreign_key("fk_journal_source_transaction", "transactions", ["source_transaction_id"], ["id"])
        batch.create_index("ix_ledger_journals_source_transaction_id", ["source_transaction_id"])
    op.add_column("processing_events", sa.Column("status", sa.String(30)))
    op.add_column("processing_events", sa.Column("error_code", sa.String(50)))
    op.add_column("exceptions", sa.Column("detection_key", sa.String(150)))
    condition = sa.text("status NOT IN ('RESOLVED', 'CLOSED')")
    op.create_index("uq_active_detection", "exceptions", ["detection_key"], unique=True,
                    postgresql_where=condition, sqlite_where=condition)
    op.create_table("payment_instructions",
        sa.Column("payment_id", sa.Uuid(), primary_key=True),
        sa.Column("transaction_id", sa.Integer(), sa.ForeignKey("transactions.id"), nullable=False, unique=True),
        sa.Column("sender_account_id", sa.Uuid(), sa.ForeignKey("accounts.account_id"), nullable=False),
        sa.Column("receiver_account_id", sa.Uuid(), sa.ForeignKey("accounts.account_id"), nullable=False),
        sa.Column("idempotency_key", sa.String(100), nullable=False, unique=True),
        sa.Column("request_fingerprint", sa.String(64), nullable=False),
        sa.Column("original_payment_id", sa.Uuid(), sa.ForeignKey("payment_instructions.payment_id")),
        sa.Column("scenario_code", sa.String(50), nullable=False),
        sa.Column("failure_code", sa.String(50)), sa.Column("failure_description", sa.Text()),
        sa.Column("completed_at", sa.DateTime(timezone=True)),
        sa.Column("reconciliation_due_at", sa.DateTime(timezone=True)),
        sa.CheckConstraint("sender_account_id <> receiver_account_id", name="ck_payment_parties"))
    op.create_index("ix_payment_instructions_sender_account_id", "payment_instructions", ["sender_account_id"])
    op.create_index("ix_payment_instructions_receiver_account_id", "payment_instructions", ["receiver_account_id"])
    op.create_table("audit_events",
        sa.Column("id", sa.Integer(), primary_key=True), sa.Column("action", sa.String(80), nullable=False),
        sa.Column("actor", sa.String(80), nullable=False), sa.Column("reference", sa.String(100), nullable=False),
        sa.Column("details", sa.JSON(), nullable=False), sa.Column("created_at", sa.DateTime(timezone=True), nullable=False))
    op.create_index("ix_audit_events_reference", "audit_events", ["reference"])


def downgrade():
    raise RuntimeError("Payment history is preserved; destructive downgrade is disabled.")
