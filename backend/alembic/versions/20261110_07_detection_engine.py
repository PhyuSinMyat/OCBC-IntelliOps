"""Add rule identity/configuration and recovery cursors without rewriting cases."""
from alembic import op
import sqlalchemy as sa

revision = "20261110_07"
down_revision = "20261103_06"
branch_labels = None
depends_on = None

# Frozen migration data: do not import the mutable application rule registry.
RULES = [
    ("DUPLICATE_TRANSACTION", "Duplicate Transaction", "Source-linked duplicate request or reference collision.", "HIGH"),
    ("PAYMENT_PROCESSING_FAILURE", "Payment Processing Failure", "Payment source reports FAILED.", "HIGH"),
    ("MISSING_LEDGER_POSTING", "Missing Ledger Posting", "No posting records after reconciliation cutoff.", "HIGH"),
    ("UNMATCHED_TRANSACTION", "Unmatched Transaction", "Valid journal has conflicting source references.", "MEDIUM"),
    ("AMOUNT_MISMATCH", "Amount Mismatch", "Valid aligned posting totals differ from payment.", "HIGH"),
    ("INVALID_LEDGER_POSTING", "Invalid Ledger Posting", "Linked posting is invalid or incomplete.", "HIGH"),
    ("LEDGER_ACCOUNT_MISMATCH", "Ledger Account Mismatch", "Posting accounts conflict with instruction.", "HIGH"),
    ("LEDGER_CURRENCY_MISMATCH", "Ledger Currency Mismatch", "Posting currency conflicts with payment.", "HIGH"),
    ("PROCESSING_TIMEOUT", "Processing Timeout", "Unheld pending or processing payment exceeds time policy.", "HIGH"),
]


def reconcile_rule_sequence(bind, missing_rules):
    """Advance a lagging PostgreSQL allocator without renumbering existing rows.

    The caller holds the rules-table lock and deployment pauses source writers.
    RESTART is transactional, unlike setval; never rewind an ahead allocator.
    Sequence names come from the catalog and are quoted by the dialect.
    """
    sequence = bind.execute(sa.text("""
        SELECT n.nspname, c.relname, s.seqincrement, s.seqmax, s.seqcycle
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_sequence s ON s.seqrelid = c.oid
        WHERE c.oid = pg_get_serial_sequence('detection_rules', 'id')::regclass
    """)).mappings().one_or_none()
    if sequence is None or sequence["seqincrement"] <= 0 or sequence["seqcycle"]:
        raise RuntimeError("Detection rule IDs require an owned ascending, non-cycling PostgreSQL sequence; review before migration.")
    quote = bind.dialect.identifier_preparer.quote_identifier
    name = f'{quote(sequence["nspname"])}.{quote(sequence["relname"])}'
    state = bind.execute(sa.text(f"SELECT last_value, is_called FROM {name}")).mappings().one()
    maximum = bind.execute(sa.text("SELECT MAX(id) FROM detection_rules")).scalar_one()
    next_id = state["last_value"] + (sequence["seqincrement"] if state["is_called"] else 0)
    lagging = maximum is not None and next_id <= maximum
    if lagging:
        next_id = maximum + sequence["seqincrement"]
    if (lagging or missing_rules) and next_id + max(missing_rules - 1, 0) * sequence["seqincrement"] > min(sequence["seqmax"], 2147483647):
        raise RuntimeError("Detection rule ID sequence has insufficient capacity; review before migration.")
    if lagging:
        bind.execute(sa.text(f"ALTER SEQUENCE {name} RESTART WITH {int(next_id)}"))


def upgrade():
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        # Take this before reading MAX(id)/legacy rows; ordinary rule inserts
        # cannot race reconciliation or default provisioning in this transaction.
        bind.execute(sa.text("LOCK TABLE detection_rules IN ACCESS EXCLUSIVE MODE"))
    existing = list(bind.execute(sa.text("SELECT id, name, exception_type, threshold FROM detection_rules ORDER BY id")).mappings())
    types = [r["exception_type"] for r in existing]
    if len(types) != len(set(types)):
        raise RuntimeError("Duplicate detection exception_type configurations: reconcile explicitly before migration.")
    if any(r["threshold"] is not None and r["threshold"] < 0 for r in existing):
        raise RuntimeError("Negative legacy thresholds require explicit review before migration.")
    known = {r[1] for r in RULES}
    if any(r["exception_type"] in known and r["threshold"] is not None for r in existing):
        raise RuntimeError("Legacy thresholds were previously ignored; review their units explicitly before migration.")
    if any(r["name"] in known and r["name"] != r["exception_type"] for r in existing):
        raise RuntimeError("A reserved default rule name belongs to another exception type; review before migration.")
    if bind.dialect.name == "postgresql":
        reconcile_rule_sequence(bind, sum(kind not in types for _, kind, _, _ in RULES))
    with op.batch_alter_table("detection_rules") as batch:
        batch.add_column(sa.Column("code", sa.String(60), nullable=True))
        batch.add_column(sa.Column("description", sa.Text(), nullable=False, server_default=""))
        batch.add_column(sa.Column("severity", sa.String(20), nullable=False, server_default="HIGH"))
        batch.add_column(sa.Column("configuration", sa.JSON(), nullable=False, server_default=sa.text("'{}'")))
        batch.add_column(sa.Column("version", sa.Integer(), nullable=False, server_default="1"))
        batch.add_column(sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()))
        batch.create_unique_constraint("uq_detection_rule_code", ["code"])
        batch.create_unique_constraint("uq_detection_rule_type", ["exception_type"])
        batch.create_check_constraint("ck_detection_rule_version", "version >= 1")
        batch.create_check_constraint("ck_detection_rule_severity", "severity IN ('LOW','MEDIUM','HIGH','CRITICAL')")
        batch.create_check_constraint("ck_detection_rule_threshold", "threshold IS NULL OR threshold >= 0")
    table = sa.table("detection_rules", sa.column("id", sa.Integer()), sa.column("name", sa.String()),
        sa.column("exception_type", sa.String()), sa.column("threshold", sa.Integer()),
        sa.column("enabled", sa.Boolean()), sa.column("code", sa.String()),
        sa.column("description", sa.Text()), sa.column("severity", sa.String()))
    mapping = {kind: (code, description, severity) for code, kind, description, severity in RULES}
    for row in existing:
        code, description, severity = mapping.get(row["exception_type"],
            (f"LEGACY_{row['id']}", "Unregistered legacy configuration; not executable.", "HIGH"))
        bind.execute(table.update().where(table.c.id == row["id"]).values(code=code, description=description, severity=severity))
    for code, kind, description, severity in RULES:
        if kind not in types:
            bind.execute(table.insert().values(name=kind, exception_type=kind, code=code,
                                              description=description, severity=severity, enabled=True))
    op.create_table("detection_observations",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("transaction_id", sa.Integer(), sa.ForeignKey("transactions.id"), nullable=False),
        sa.Column("rule_id", sa.Integer(), sa.ForeignKey("detection_rules.id"), nullable=False),
        sa.Column("defective", sa.Boolean(), nullable=False),
        sa.Column("fingerprint", sa.String(64)),
        sa.Column("policy_fingerprint", sa.String(64), nullable=False),
        sa.Column("observed_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("transaction_id", "rule_id", name="uq_detection_observation"))
    op.create_index("ix_detection_observations_transaction_id", "detection_observations", ["transaction_id"])


def downgrade():
    raise RuntimeError("Rule identity and detection history require a reviewed forward migration.")
