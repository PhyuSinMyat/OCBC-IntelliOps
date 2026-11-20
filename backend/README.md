# IntelliOps backend

From the repository root, activate the project virtual environment and install
`backend/requirements.txt` (or `backend/requirements-dev.txt` for tests).
Set `DATABASE_URL` to a synthetic PostgreSQL development database in `backend/.env`.

### Automatic exception detection

Payment creation, scenario simulation and exception batches invoke a scoped scan after the payment transaction commits. The scan uses its own database session and the same rules as `POST /api/detection/run` (Scan Now). PostgreSQL uses a 1.5-second lock timeout and a 4-second per-statement timeout for automatic scans. Failures are recorded in the audit log when available and leave the committed financial result intact. Set `INTELLIOPS_AUTOMATIC_DETECTION=false` to disable automation while retaining manual scans.

The existing case `created_at` is the first detection time. The existing detector lock, active-case uniqueness, stable transaction and rule identity, and ordered duplicate-pair identity apply to both paths. Existing resolved cases follow the detector's current recurrence rules.

Run `python backend/run_overdue_detection.py --watch` as one separately supervised process to check overdue missing-ledger postings every 20 seconds. Each pass first filters for completed payments without a matched modern or legacy posting and considers at most 50 due payments. The process skips when another detector holds the advisory lock. FastAPI does not start the worker. Run the same command without `--watch` for one check. Both forms can create cases in the configured database, so use an isolated database for verification. The scheduled pass targets overdue observations and leaves recovery checks for the full manual scan.

`GET /api/detection/status` requires the existing demo authentication. It reports post-commit availability and the last recorded success or failure. It does not report scheduler uptime.

### Initial exception severity

New cases store a rule-based severity assessment in their existing evidence and detection audit records. The detection-rule severity field remains available as legacy configuration metadata. Case creation uses the evidence assessment for the assigned severity.

Critical severity applies to recent confirmed defects of the same type across distinct transactions and known sender-account owners. Eligible cohorts cover missing postings after cutoff, exact amount mismatches and posted currency or account discrepancies. An isolated or historical issue does not qualify. The default cohort requires 10 transactions and 3 distinct customers over 900 seconds, with a transaction in the last 300 seconds and at least 60 seconds between the earliest and latest transaction.

Override the thresholds with `INTELLIOPS_SEVERITY_MIN_TRANSACTIONS`, `INTELLIOPS_SEVERITY_MIN_CUSTOMERS`, `INTELLIOPS_SEVERITY_WINDOW_SECONDS` or `INTELLIOPS_SEVERITY_RECENT_SECONDS`. Count thresholds have a minimum of 2, the full window has a minimum of 120 seconds, and the recent window is limited to the full window. Invalid integer values fall back to defaults.

To review a one-time severity recalculation, run `python backend/recalculate_exception_severity.py` from the repository root with the backend dependencies installed. The default command opens a read-only PostgreSQL transaction and reports the configured target fingerprint, proposed distribution, and plan fingerprint. A recognized case with inconclusive current evidence receives Medium. Unsupported case types or missing primary payments block the update.

After verifying the target and plan, run the same command with `--apply --confirm-target TARGET --confirm-plan PLAN --backup PATH`. Use a new backup path outside version control. The command rechecks the plan, backs up the case IDs and severities, updates only the current severity, and appends existing audit records for changed cases. Protected accounting, exception and investigation records are checked before commit. A changed plan or unavailable schema prevents the write.

### Case status reconciliation

Run `python backend/reconcile_case_statuses.py` for the read-only preview. After verifying the target and plan, supply `--apply --confirm-target TARGET --confirm-plan PLAN --backup PATH` to update cases and append audit entries in a single transaction. Existing durable investigation records and review notes support In Progress. Terminal cases and existing statuses without enough evidence are preserved. See [the approval persistence proposal](../docs/case-approval-persistence-proposal.md) for the remaining workflow stages.
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

## Persistent resolution workflow

Migration `20261119_09` adds immutable, append-only `resolution_plans`,
`customer_communications`, and `policy_assessments` tables. The application never
applies this migration at startup. Review it and run `alembic upgrade head` only
against an explicitly approved target database.

Authenticated endpoints:

- `GET/POST /api/exceptions/{case_id}/resolution-plans`
- `GET/POST /api/exceptions/{case_id}/communications`
- `GET/POST /api/exceptions/{case_id}/policy-assessments`

Plan generation is an explicit paid OpenAI request. The model receives a bounded,
server-built projection of the accepted investigation, verified accounting facts,
allowlisted evidence references, and recorded customer context. Strict structured
output is required. The backend independently fixes the eligible action code,
validates citations and unsafe completion claims, and keeps approval and financial
authority out of the model. Set `INTELLIOPS_RESOLUTION_MODEL` to use a different
model from `OPENAI_MODEL`; otherwise the investigation model is reused.

Every version is immutable and captures the accepted investigation fingerprint
plus the current persisted customer-context revision. New communications append
records; they cannot be cleared from the UI. Policy assessment remains entirely
deterministic: it evaluates six server controls and appends a historical result.
These endpoints never post, reverse, refund, close, or otherwise mutate payment
and ledger records. Tests use mocked provider transports and never make paid calls.

## Outbound customer email

Migration `20261119_10` removes the simulation-only communication constraint and
adds a durable `email_deliveries` outbox. Apply it through the normal reviewed
Alembic deployment; the application does not migrate the database at startup.

Real email is ADMIN-only and remains disabled unless `INTELLIOPS_EMAIL_ENABLED`
is true. Configure the SMTP and sender variables documented in `.env.example`.
`STARTTLS` is the default transport security. `INTELLIOPS_EMAIL_ALLOWED_DOMAINS`
can restrict recipients during development or staged rollout.

The backend commits the communication and pending delivery before contacting the
SMTP server. Known failures may be retried explicitly from the timeline. A
delivery left in `SENDING`/`UNKNOWN` is not automatically retried because SMTP
cannot guarantee idempotency after an interrupted connection. The stable
Message-ID is retained for provider-side duplicate detection and audit review.

## Inbound Gmail replies

Migration `20261120_11` adds durable, idempotent receipt records for customer
email replies. Review the migration and apply it through the normal Alembic
deployment before enabling inbox synchronization; startup never runs migrations.

Set `INTELLIOPS_INBOUND_EMAIL_ENABLED=true` and configure the IMAP variables in
`.env.example`. For Gmail, enable IMAP access and use a Google App Password with
`imap.gmail.com:993`; the IMAP username and password may be omitted when they are
the same as the configured SMTP credentials.

An ADMIN can explicitly check for replies from the communication timeline. The
backend opens the mailbox read-only, scans a bounded date/message window, and
imports only plain-text messages that reference an exact outbound Message-ID and
come from that email's recipient address. Imported provider Message-IDs and
mailbox UIDs are unique, so repeated checks do not duplicate a reply. Attachments,
HTML-only messages, unrelated mail, and mismatched senders are ignored. The old
manual customer-response simulator is not exposed by either the API or UI.
