"""Add request evidence and paired cases without changing financial history."""
from alembic import op
import sqlalchemy as sa

revision = '20261111_08'
down_revision = '20261110_07'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table('payment_requests',
        sa.Column('request_id', sa.Uuid(), primary_key=True),
        sa.Column('business_instruction_id', sa.Uuid(), sa.ForeignKey('payment_instructions.payment_id'), nullable=False),
        sa.Column('payment_id', sa.Uuid(), sa.ForeignKey('payment_instructions.payment_id'), nullable=False),
        sa.Column('origin', sa.String(10), nullable=False),
        sa.Column('retry_of_request_id', sa.Uuid(), sa.ForeignKey('payment_requests.request_id')),
        sa.Column('submitted_idempotency_key', sa.String(100), nullable=False),
        sa.Column('authorization_id', sa.Uuid(), unique=True),
        sa.Column('correlation_id', sa.Uuid()),
        sa.Column('received_at', sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("origin IN ('CUSTOMER', 'SYSTEM')", name='ck_request_origin'),
        sa.CheckConstraint("retry_of_request_id IS NULL OR (origin = 'SYSTEM' AND retry_of_request_id <> request_id)", name='ck_request_retry'))
    for col in ('business_instruction_id', 'payment_id', 'retry_of_request_id'):
        op.create_index(f'ix_payment_requests_{col}', 'payment_requests', [col])
    sqlite = op.get_bind().dialect.name == 'sqlite'
    if sqlite:
        # Do not rebuild populated parent tables or disable foreign-key checks.
        op.execute('ALTER TABLE processing_events ADD COLUMN request_id CHAR(32) REFERENCES payment_requests(request_id)')
        op.create_index('ix_processing_events_request_id', 'processing_events', ['request_id'])
        op.add_column('exception_batches', sa.Column('run_key', sa.String(100)))
        op.add_column('exception_batches', sa.Column('input_fingerprint', sa.String(64)))
        op.add_column('exception_batches', sa.Column('private_metadata', sa.JSON()))
        op.create_index('uq_batch_run_key', 'exception_batches', ['run_key'], unique=True)
        op.execute('ALTER TABLE exceptions ADD COLUMN related_transaction_id INTEGER REFERENCES transactions(id) '
                   'CONSTRAINT ck_exception_pair CHECK (related_transaction_id IS NULL OR transaction_id <> related_transaction_id)')
        op.create_index('ix_exceptions_related_transaction_id', 'exceptions', ['related_transaction_id'])
    else:
        with op.batch_alter_table('processing_events') as batch:
            batch.add_column(sa.Column('request_id', sa.Uuid()))
            batch.create_foreign_key('fk_event_request', 'payment_requests', ['request_id'], ['request_id'])
            batch.create_index('ix_processing_events_request_id', ['request_id'])
        with op.batch_alter_table('exception_batches') as batch:
            batch.add_column(sa.Column('run_key', sa.String(100)))
            batch.add_column(sa.Column('input_fingerprint', sa.String(64)))
            batch.add_column(sa.Column('private_metadata', sa.JSON()))
            batch.create_unique_constraint('uq_batch_run_key', ['run_key'])
        with op.batch_alter_table('exceptions') as batch:
            batch.add_column(sa.Column('related_transaction_id', sa.Integer()))
            batch.create_foreign_key('fk_exception_related', 'transactions', ['related_transaction_id'], ['id'])
            batch.create_index('ix_exceptions_related_transaction_id', ['related_transaction_id'])
            batch.create_check_constraint('ck_exception_pair', 'related_transaction_id IS NULL OR transaction_id <> related_transaction_id')
    with op.batch_alter_table('detection_observations') as batch:
        batch.add_column(sa.Column('related_transaction_id', sa.Integer()))
        batch.create_foreign_key('fk_observation_related', 'transactions', ['related_transaction_id'], ['id'])
        batch.create_index('ix_detection_observations_related_transaction_id', ['related_transaction_id'])
        batch.create_check_constraint('ck_observation_pair', 'related_transaction_id IS NULL OR transaction_id <> related_transaction_id')
        batch.drop_constraint('uq_detection_observation', type_='unique')
        batch.create_unique_constraint('uq_detection_observation_pair', ['transaction_id', 'rule_id', 'related_transaction_id'])
    op.create_index('uq_detection_observation_single', 'detection_observations', ['transaction_id', 'rule_id'], unique=True,
                    postgresql_where=sa.text('related_transaction_id IS NULL'), sqlite_where=sa.text('related_transaction_id IS NULL'))


def downgrade():
    # Consistent with the existing migration chain: never discard operational evidence.
    raise RuntimeError('Request and paired-case history must be preserved. Use a reviewed forward migration.')
