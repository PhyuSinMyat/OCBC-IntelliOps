"""Add real outbound email delivery tracking."""
from alembic import op
import sqlalchemy as sa


revision = "20261119_10"
down_revision = "20261119_09"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("customer_communications") as batch:
        batch.drop_constraint("ck_communication_simulated", type_="check")
    op.create_table(
        "email_deliveries",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("communication_id", sa.String(36), sa.ForeignKey("customer_communications.id"), nullable=False, unique=True),
        sa.Column("recipient_email", sa.String(254), nullable=False),
        sa.Column("message_id", sa.String(254), nullable=False, unique=True),
        sa.Column("provider", sa.String(30), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("attempt_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("last_error_code", sa.String(80)),
        sa.Column("queued_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("attempted_at", sa.DateTime(timezone=True)),
        sa.Column("sent_at", sa.DateTime(timezone=True)),
        sa.CheckConstraint("status IN ('PENDING','SENDING','SENT','FAILED','UNKNOWN')", name="ck_email_delivery_status"),
        sa.CheckConstraint("attempt_count >= 0", name="ck_email_attempt_count"),
    )
    op.create_index("ix_email_delivery_status", "email_deliveries", ["status", "queued_at"])


def downgrade():
    op.drop_table("email_deliveries")
    with op.batch_alter_table("customer_communications") as batch:
        batch.create_check_constraint("ck_communication_simulated", "simulated = true")
