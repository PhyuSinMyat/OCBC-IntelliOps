# Normal payment ledger milestone

The repository already provides PostgreSQL-backed payment creation, deterministic
account row locks, idempotent instructions, posted-journal balance aggregation,
account movement APIs, and shared snapshot-backed React drawers. Local mode is a
browser-storage simulation; connected mode takes authoritative balances from the
backend and refreshes its snapshot after payment submission.

## Changes

- `modules/core_banking/service.py`: reusable account balance lookup and controlled
  normal journal posting validation. Exactly two persisted entries must match the
  sender debit, receiver credit, payment amount, currencies and references before
  posting. Posted reversal entries contribute according to their direction.
- `modules/core_banking/models.py` and migration `20261103_03_normal_posting.py`:
  journal creation time and a nullable unique normal transaction foreign key.
  Existing historical journals are not relabelled or rewritten.
- `modules/payment_processing/service.py`: normal payments use those services;
  responses include `journalReference`. Existing exception scenarios are preserved.
- `modules/payment_processing/api.py`: validation failure rolls back the financial
  transaction and records a separate `PAYMENT_POSTING_FAILED` audit outcome.
- Core banking router and schemas: typed journal list/detail APIs, entries, totals,
  and actual payment availability. Detail accepts UUID or business reference.
- `frontend/src/shared/components/BankingRecords.jsx`: clarify connected data text
  and payment link action while preserving the existing layout and record URLs.
- `tests/test_payments.py`: add 5000 transfer/balance/history/API assertions and
  injected posting-validation rollback coverage.
- `frontend/tests/normal-ledger.spec.js`: add 5000 payment/journal traceability,
  refresh and browser Back/Forward coverage.

## Executed validation

- Frontend unit tests: 17 passed.
- Existing Playwright tests with installed Chrome: 12 passed.
- New normal-ledger Playwright test: 1 passed.
- Vite production build: passed.
- `git diff --check`: passed.

The initial Playwright run could not launch its default browser; configuring
`INTELLIOPS_BROWSER_PATH` to installed Chrome resolved this.

Backend pytest could not start: both the workspace virtualenv Python and installed
Python launcher report "A specified logon session does not exist." No backend test,
migration execution or PostgreSQL concurrency verification is claimed. Browser
tests exercised shared local simulation, not persisted PostgreSQL operations.

## Remaining execution

On a working Python environment, install requirements and requirements-dev, run
`python -m pytest tests -q` from backend, apply `alembic upgrade head` to the intended
database, and run the connected Playwright suite. Verify concurrent PostgreSQL
payments cannot overspend with the existing deterministic `FOR UPDATE` locks.
Deploy the migration before the updated backend code. No database was reset or
seeded during this change.

The supplied seed has Northstar and other existing customers, but no Willow Studio
account. Tests use existing active SGD accounts instead of rewriting demonstration
customers or opening balances.
