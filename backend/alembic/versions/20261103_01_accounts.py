"""Add customer ownership and account ledger tables without touching legacy rows."""
from alembic import op
import sqlalchemy as sa

revision = "20261103_01"
down_revision = None
branch_labels = None
depends_on = None


def upgrade():
    # The pre-existing app had no migration history. Preserve every legacy table.
    # Create the five original tables only on fresh installations.
    bind = op.get_bind()
    # Freeze the original schema: importing current ORM metadata here would add
    # future columns prematurely and make subsequent additive revisions fail.
    meta = sa.MetaData()
    sa.Table("transactions", meta, sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("reference", sa.String(100), unique=True, index=True, nullable=False),
        sa.Column("payment_reference", sa.String(100), index=True, nullable=False),
        sa.Column("amount", sa.Numeric(18, 2), nullable=False), sa.Column("currency", sa.String(3), nullable=False),
        sa.Column("status", sa.String(30), nullable=False), sa.Column("created_at", sa.DateTime(timezone=True), nullable=False))
    sa.Table("ledger_records", meta, sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("transaction_id", sa.Integer(), sa.ForeignKey("transactions.id"), index=True, nullable=False),
        sa.Column("amount", sa.Numeric(18, 2), nullable=False), sa.Column("currency", sa.String(3), nullable=False),
        sa.Column("entry_type", sa.String(20), nullable=False), sa.Column("created_at", sa.DateTime(timezone=True), nullable=False))
    sa.Table("processing_events", meta, sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("transaction_id", sa.Integer(), sa.ForeignKey("transactions.id"), index=True, nullable=False),
        sa.Column("event_type", sa.String(50), nullable=False), sa.Column("details", sa.Text()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False))
    sa.Table("detection_rules", meta, sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(100), unique=True, nullable=False), sa.Column("exception_type", sa.String(50), nullable=False),
        sa.Column("threshold", sa.Integer()), sa.Column("enabled", sa.Boolean(), nullable=False))
    sa.Table("exceptions", meta, sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("transaction_id", sa.Integer(), sa.ForeignKey("transactions.id"), index=True, nullable=False),
        sa.Column("rule_id", sa.Integer(), sa.ForeignKey("detection_rules.id")), sa.Column("exception_type", sa.String(50), nullable=False),
        sa.Column("severity", sa.String(20), nullable=False), sa.Column("status", sa.String(30), nullable=False),
        sa.Column("evidence", sa.JSON()), sa.Column("created_at", sa.DateTime(timezone=True), nullable=False))
    meta.create_all(bind, checkfirst=True)

    op.create_table("customers",
        sa.Column("customer_id", sa.Uuid(), primary_key=True),
        sa.Column("customer_ref", sa.String(50), nullable=False, unique=True),
        sa.Column("customer_name", sa.String(150), nullable=False),
        sa.Column("customer_type", sa.String(20), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("customer_type IN ('INDIVIDUAL', 'BUSINESS')", name="ck_customer_type"),
        sa.UniqueConstraint("customer_id", "customer_type", name="uq_customer_ownership"))
    op.create_table("accounts",
        sa.Column("account_id", sa.Uuid(), primary_key=True),
        sa.Column("account_ref", sa.String(50), nullable=False, unique=True),
        sa.Column("customer_id", sa.Uuid(), nullable=False),
        sa.Column("customer_type", sa.String(20), nullable=False),
        sa.Column("account_type", sa.String(20), nullable=False),
        sa.Column("currency", sa.String(3), nullable=False),
        sa.Column("opening_balance", sa.Numeric(18, 2), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["customer_id", "customer_type"], ["customers.customer_id", "customers.customer_type"], name="fk_account_owner"),
        sa.CheckConstraint("account_type IN ('SAVINGS', 'CURRENT')", name="ck_account_type"),
        sa.CheckConstraint("customer_type = 'INDIVIDUAL' OR (customer_type = 'BUSINESS' AND account_type = 'CURRENT')", name="ck_account_ownership_product"))
    op.create_index("ix_accounts_customer_id", "accounts", ["customer_id"])
    op.create_table("ledger_journals",
        sa.Column("journal_id", sa.Uuid(), primary_key=True),
        sa.Column("journal_ref", sa.String(50), nullable=False, unique=True),
        sa.Column("payment_reference", sa.String(100)),
        sa.Column("currency", sa.String(3), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("posted_at", sa.DateTime(timezone=True)))
    op.create_index("ix_ledger_journals_payment_reference", "ledger_journals", ["payment_reference"])
    op.create_table("ledger_entries",
        sa.Column("entry_id", sa.Uuid(), primary_key=True),
        sa.Column("entry_ref", sa.String(80), nullable=False, unique=True),
        sa.Column("journal_id", sa.Uuid(), sa.ForeignKey("ledger_journals.journal_id"), nullable=False),
        sa.Column("account_id", sa.Uuid(), sa.ForeignKey("accounts.account_id"), nullable=False),
        sa.Column("side", sa.String(10), nullable=False),
        sa.Column("amount", sa.Numeric(18, 2), nullable=False),
        sa.Column("currency", sa.String(3), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("posted", sa.Boolean(), nullable=False),
        sa.CheckConstraint("amount > 0", name="ck_entry_positive"),
        sa.CheckConstraint("side IN ('Debit', 'Credit')", name="ck_entry_side"))
    op.create_index("ix_ledger_entries_account_id", "ledger_entries", ["account_id"])
    op.create_index("ix_ledger_entries_journal_id", "ledger_entries", ["journal_id"])


def downgrade():
    # Deliberate guard: downgrading would destroy account and ledger history.
    raise RuntimeError("Destructive account-ledger downgrade is disabled; restore an approved backup instead.")
