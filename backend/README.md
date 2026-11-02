# IntelliOps backend

From the repository root, activate the project virtual environment and install
`backend/requirements.txt` (or `backend/requirements-dev.txt` for tests).
Set `DATABASE_URL` to a synthetic PostgreSQL development database in `backend/.env`.
Then run from `backend/`:

```powershell
alembic upgrade head
python -m modules.core_banking.seed
uvicorn main:app --reload
```

The seed preserves all eight public account references, opening balances and the
two original frontend transfers. It is explicit, idempotent and refuses conflicts.
The original `python generate_data.py` scenario generator remains available for
a fresh legacy transaction dataset; it is independent of the account seed and
does not infer accounting postings for existing exceptions.

`modules/core_banking/MIGRATION_REPORT.md` documents the explicit customer map,
Corporate-to-Current label changes, new UUID identifiers and preserved legacy
relationships. No existing ledger_records are converted into invented journals.

The account read APIs support:

- `GET /api/accounts`: search, customer_type, account_type, currency, status, sort,
  page and page_size. Sort values match the frontend: reference, customer-asc,
  customer-desc, balance-asc, balance-desc, created-asc and created-desc.
- `GET /api/accounts/{account_id}`: UUID lookup with customer and balance summary.
- `GET /api/accounts/{account_id}/ledger-entries`: valid posted account movements.
- `GET /api/customers`: explicitly classified fictional customers.
- `GET /api/banking-snapshot`: shared source records for frontend connected mode.

Balance summaries use SQL aggregation across entire valid posted journals,
requiring at least two positive same-currency posted entries and equal debit and
credit totals. Reversed journals retain the existing exclusion semantics; no
compensating reversal entries are generated. Payment amount mismatches, unmatched
payment references and missing ledger postings are not repaired. Balance sorting
compares nominal amounts in the selected currencies; filter by currency to compare
like amounts. Account list queries do not issue per-account database queries.

No account creation/editing endpoints existed, so none are added. Database
constraints enforce customer/product combinations for all future write paths;
`validate_ownership` provides clear service validation errors. Payment operations
now use configured synthetic-demo bearer credentials for ANALYST and ADMIN.
Set distinct `INTELLIOPS_ANALYST_TOKEN` and `INTELLIOPS_ADMIN_TOKEN` values in the
backend environment. Account, payment and snapshot reads require a valid token;
normal payment creation permits both roles, and scenario injection requires ADMIN.
The public root and health endpoints remain available. This is demo authentication,
not production identity management. No approval permissions are granted to ANALYST.

Payment APIs and the end-to-end demonstration are documented in
[PAYMENTS.md](PAYMENTS.md). The new migration extends the original transaction and
event tables through normalized payment instructions, preserving integer IDs and
legacy exception FKs. All writes occur through the controlled payment service.

Run automated database, migration, financial consistency and API tests:

```powershell
python -m unittest discover -s tests -v
```

Tests use isolated SQLite databases with foreign keys enabled. They never touch
your configured PostgreSQL data. PostgreSQL deployment validation should be run
against a dedicated development database before using the migration there.
