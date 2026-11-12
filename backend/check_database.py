"""Read-only deployment preflight. Never migrates, seeds or prints credentials."""
import json
import sys
from sqlalchemy import inspect, text
from sqlalchemy.exc import SQLAlchemyError
from shared.database import engine, Base
import models


def check():
    report = {'connection': 'unverified', 'expected_revision': '20261111_08', 'schema_drift': {}}
    try:
        with engine.connect() as connection:
            transaction = connection.begin()
            if engine.dialect.name != 'postgresql':
                raise ValueError('This preflight requires PostgreSQL.')
            connection.execute(text('SET TRANSACTION READ ONLY'))
            connection.execute(text("SET LOCAL statement_timeout = '10s'"))
            report['select_1'] = connection.execute(text('SELECT 1')).scalar_one()
            report['connection'] = 'verified'
            report['read_only'] = connection.execute(text('SHOW transaction_read_only')).scalar_one()
            inspector = inspect(connection)
            tables = set(inspector.get_table_names())
            report['deployed_revisions'] = connection.execute(text('SELECT version_num FROM alembic_version')).scalars().all() if 'alembic_version' in tables else []
            for name, table in Base.metadata.tables.items():
                if name not in tables:
                    report['schema_drift'][name] = {'missing_table': True}
                    continue
                actual = {col['name']: col for col in inspector.get_columns(name)}
                missing = sorted(set(table.columns.keys()) - set(actual))
                expected_fks = {(tuple(fk.column_keys), fk.referred_table.name, tuple(e.column.name for e in fk.elements)) for fk in table.foreign_key_constraints}
                actual_fks = {(tuple(fk['constrained_columns']), fk['referred_table'], tuple(fk['referred_columns'])) for fk in inspector.get_foreign_keys(name)}
                expected_unique = {tuple(col.name for col in constraint.columns) for constraint in table.constraints if constraint.__class__.__name__ == 'UniqueConstraint'}
                actual_unique = {tuple(constraint['column_names']) for constraint in inspector.get_unique_constraints(name)}
                actual_unique |= {tuple(index['column_names']) for index in inspector.get_indexes(name) if index.get('unique') and not index.get('dialect_options', {}).get('postgresql_where')}
                expected_indexes = {(tuple(col.name for col in index.columns), index.unique,
                    index.dialect_options['postgresql'].get('where') is not None) for index in table.indexes}
                actual_indexes = {(tuple(index['column_names']), index.get('unique', False),
                    index.get('dialect_options', {}).get('postgresql_where') is not None) for index in inspector.get_indexes(name)}
                expected_checks = {constraint.name for constraint in table.constraints if constraint.__class__.__name__ == 'CheckConstraint' and constraint.name}
                actual_checks = {constraint['name'] for constraint in inspector.get_check_constraints(name)}
                mismatches = {}
                for col in table.columns:
                    if col.name not in actual:
                        continue
                    deployed = actual[col.name]
                    # Compare dialect-compiled types rather than generic ORM spellings.
                    if str(col.type.compile(engine.dialect)).lower() != str(deployed['type'].compile(engine.dialect)).lower() or col.nullable != deployed['nullable']:
                        mismatches[col.name] = {'expected_type': str(col.type.compile(engine.dialect)), 'actual_type': str(deployed['type']),
                                                'expected_nullable': col.nullable, 'actual_nullable': deployed['nullable']}
                drift = dict(missing_columns=missing, missing_foreign_keys=sorted(expected_fks - actual_fks),
                             missing_unique_constraints=sorted(expected_unique - actual_unique), missing_indexes=sorted(expected_indexes - actual_indexes),
                             missing_checks=sorted(expected_checks - actual_checks), column_mismatches=mismatches)
                if any(drift.values()):
                    report['schema_drift'][name] = drift
            report['compatible'] = not report['schema_drift'] and report['expected_revision'] in report['deployed_revisions']
            transaction.rollback()
    except (SQLAlchemyError, ValueError) as error:
        # Driver error messages may contain connection strings, hosts or passwords.
        report['error_type'] = type(error).__name__
        report['compatible'] = False
    print(json.dumps(report, indent=2))
    return 0 if report['compatible'] else 1


if __name__ == '__main__':
    sys.exit(check())
