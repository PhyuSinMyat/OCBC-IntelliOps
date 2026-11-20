"""Add idempotent inbound Gmail reply receipts."""
from alembic import op
import sqlalchemy as sa


revision = "20261120_11"
down_revision = "20261119_10"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "inbound_email_receipts",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("communication_id", sa.String(36), sa.ForeignKey("customer_communications.id"), nullable=False, unique=True),
        sa.Column("provider_message_id", sa.String(254), nullable=False, unique=True),
        sa.Column("mailbox", sa.String(120), nullable=False),
        sa.Column("mailbox_uid", sa.String(120), nullable=False),
        sa.Column("sender_email", sa.String(254), nullable=False),
        sa.Column("in_reply_to", sa.String(254), nullable=False),
        sa.Column("received_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("imported_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("mailbox", "mailbox_uid", name="uq_inbound_email_mailbox_uid"),
    )
    op.create_index("ix_inbound_email_received", "inbound_email_receipts", ["received_at"])


def downgrade():
    op.drop_table("inbound_email_receipts")
