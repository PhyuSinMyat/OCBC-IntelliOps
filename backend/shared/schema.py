"""Read-only additive rollout capability checks. Never migrate from application reads."""
from sqlalchemy import inspect


def capabilities(db):
    inspector = inspect(db.connection())
    tables = set(inspector.get_table_names())
    def has(table, *columns):
        return table in tables and set(columns) <= {c['name'] for c in inspector.get_columns(table)}
    result = dict(requests=has('payment_requests', 'request_id', 'business_instruction_id', 'payment_id'),
                  events=has('processing_events', 'request_id'), cases=has('exceptions', 'related_transaction_id'))
    result['ready'] = all(result.values()) and has('exception_batches', 'run_key', 'input_fingerprint', 'private_metadata') and has('detection_observations', 'related_transaction_id')
    return result


def require_current_schema(db):
    if not capabilities(db)['ready']:
        from fastapi import HTTPException
        raise HTTPException(503, 'Existing records remain readable. Database-backed payment generation and detection require migration 20261111_08; no migration was applied automatically.')
