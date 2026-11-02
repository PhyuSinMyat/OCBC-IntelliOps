# Payment processing implementation

The existing `transactions` table and its integer primary keys remain the source
of payment amounts, currencies, statuses, references and initiation timestamps.
`payment_instructions` adds a UUID identity, normalized account ownership,
idempotency key/fingerprint, original-payment linkage, scenario, errors,
completion timestamp and reconciliation cutoff. `processing_events` is extended
with status and error code; its existing descriptions/timestamps are preserved.
Existing accounts, customers, ledger_records and exception relationships remain.

`ledger_journals.source_transaction_id` provides an independent source correlation
for deliberate business-reference mismatches. `payment_reference` still contains
the actual reconciliation reference, including any deliberate mismatch.
The migration adds audit events and a partial uniqueness index that prevents
duplicate active cases for the same transaction and exception type. Legacy
exception evidence stays in its existing JSON column rather than a duplicate table.

## Setup

From `backend/`, after installing requirements and configuring a synthetic database:

```powershell
alembic upgrade head
python -m modules.core_banking.seed
uvicorn main:app --reload
```

Configure distinct, nonempty `INTELLIOPS_ANALYST_TOKEN` and
`INTELLIOPS_ADMIN_TOKEN` environment values. Send `Authorization: Bearer <token>`.
The frontend requests a token when connecting to the backend. Tokens are not
embedded in the frontend bundle. This is a local demo credential boundary, not
production SSO, user administration, or a deployment authorization system.

The optional `INTELLIOPS_SIMULATION_TIME` ISO timestamp pins the backend clock.
Otherwise UTC wall time is used. `INTELLIOPS_RECONCILIATION_SECONDS` configures the
matching window (default 60 seconds). The UI receives that clock and cutoff.
When pinning time, advance the configured time and restart the server before
expecting cutoff-dependent detection. In local browser mode the ADMIN demo role
can advance the simulated clock by 61 seconds without changing source timestamps.

## APIs

| Endpoint | Behavior |
|---|---|
| GET /api/payments | search, status, currency, date_from, date_to, sort, page, page_size |
| GET /api/payments/{UUID or transaction reference} | payment and shared customer/account details |
| POST /api/payments | normal validated payment; ANALYST or ADMIN |
| GET /api/payments/{id}/events | actual recorded chronological processing events |
| GET /api/payments/{id}/related | actual journals, totals and exception relationships |
| POST /api/demo/payments/scenario | controlled fault injection; ADMIN only |
| POST /api/detection/run | explicit independent source-evidence detection |
| GET /api/exceptions | detected cases and evidence |
| GET /api/audit-events | recent recorded actions |
| GET /api/banking-snapshot | consistent shared UI record set and server balance summaries |

Normal request example:

```json
{
  "sender_account_ref": "ACC-100003",
  "receiver_account_ref": "ACC-100001",
  "amount": "100.00",
  "idempotency_key": "unique-request-key-0001"
}
```

Send decimal amounts as strings. Currency is derived from the same-currency
accounts; an explicit conflicting currency is rejected. Amounts must be positive,
have at most two decimal places, and fit the safe integer-cent UI limit. Both
accounts must exist, be distinct and Active, and the sender must have sufficient
funds. Input failures return 422, missing records 404, idempotency conflicts 409,
missing credentials 401 and unauthorized injection 403.

Normal posting locks the participating account rows in deterministic order on
PostgreSQL, validates current ledger-derived funds, records stages, creates a
balanced journal and positive posted entries, then marks the source completed.
All financial records and audit actions commit in one transaction. A replay with
the same idempotency key and canonical payload returns the existing result;
conflicting payloads do not create a second transfer. Unique constraints provide
a second boundary against concurrent duplicates. Production PostgreSQL concurrency
and deployment validation remain required; automated tests use isolated SQLite.

## Controlled source scenarios

| scenario_code | Source evidence and financial effect |
|---|---|
| NORMAL | completed source; balanced sender debit and receiver credit |
| DUPLICATE | original posts once; second instruction shares its business reference and stays Pending without a second posting |
| PROCESSING_FAILURE | Failed source with error/event; no successful journal |
| MISSING_LEDGER | Completed source, no journal, no balance movement; detect after cutoff |
| AMOUNT_MISMATCH | Completed expected amount; internally balanced journal posts one cent less; detect after cutoff |
| UNMATCHED | Completed source and balanced journal with deliberately different business reference, correlated by source ID; detect after cutoff |

Fault creation never creates cases directly. Run detection explicitly. It reads
the actual business references, statuses, journal availability and valid amounts;
case creation requires source evidence and the matching window where relevant.
Existing named detection rules are respected when disabled, and matching cases
reference their rule ID. Repeated detection does not duplicate active cases or
resolve existing cases. No corrective posting is generated by detection.

Seeded historical transfers retain their original amounts/parties and do not get
invented historical stages. Seeding records an actual SOURCE_IMPORTED event when
attaching normalized instruction metadata. Older unnormalized records show only
their available source events; missing ownership/completion information remains
unavailable until explicitly mapped.

## Demo and tests

Open Payment Processing / Transactions. Create a normal payment and inspect
Overview, Processing History and Related Records. In local mode select the
explicit ADMIN demo role for fault scenarios. Create a scenario, advance the
local clock when required (or wait for backend cutoff), run detection, and open
the actual case from Related Records. The case links to evidence review and
source records. Audit Trail records creation, injection and detection actions.
AI orchestration and automated resolution are not connected; evidence review does
not claim to be an AI investigation or resolve a case.

```powershell
# backend/
python -m unittest discover -s tests -v
# frontend/
npm.cmd test
npm.cmd run test:e2e
npm.cmd run test:connected
```

The connected browser fixture runs migrations and seeds an isolated in-memory
SQLite database on loopback port 8191, with test-only credentials. It never uses
the configured PostgreSQL database. Browser mode uses localStorage for data and
sessionStorage for filters and the explicitly simulated role; it is not server
authentication. Backend mode enforces roles server-side and refreshes the shared
snapshot after each operation. No new approval or balance-edit endpoint exists.
