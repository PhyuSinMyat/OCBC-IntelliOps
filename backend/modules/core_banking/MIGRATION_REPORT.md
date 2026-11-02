# Account classification and migration report

The repository had no customer/account database tables or account-linked journal
tables. The additive migration preserves the original transactions, ledger_records,
processing_events, detection_rules and exceptions, including their IDs and FKs.
It does not reinterpret legacy single-sided ledger_records as balanced journals.

The explicit ownership map is CUS-001/002/004/006/007 → INDIVIDUAL and
CUS-003/005/008 → BUSINESS. The three company accounts ACC-100003/005/008 change
their product label from Corporate to Current. All eight existing account
references, opening balances, statuses, currencies, payment references and journal
references are preserved. UUIDs are deterministic internal identifiers; existing
ACC references remain public identifiers. No record requires manual classification
in this checked-in dataset.

The seed is explicit and idempotent, refuses conflicting records, and never
overwrites existing transactions or repairs exceptions. If a deployment already
contains independently created customers/accounts tables, review that schema and
classify its records before applying this migration; this initial revision does
not guess or overwrite an unknown external schema.

Run from backend after installing requirements:

```powershell
alembic upgrade head
python -m modules.core_banking.seed
```

Do this before starting the API. Schema creation now runs through Alembic rather
than implicitly at API startup.
The migration is additive and has no automatic destructive downgrade.

Read-only account APIs are available at /api/accounts, /api/accounts/{UUID},
/api/accounts/{UUID}/ledger-entries and /api/customers. /api/banking-snapshot
supplies one shared frontend dataset, including server-calculated balances.
No account-management
endpoints or balance-edit endpoints are exposed. Ownership validation is available
to future controlled services and enforced by database constraints. The payment enhancement adds configured demo bearer-token authentication for ANALYST and ADMIN, including account and snapshot reads. It is not production SSO. No approval permissions are changed.
