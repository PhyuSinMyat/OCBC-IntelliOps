# AI Investigation — teammate handoff

Phase 2 runs through React/Vite → FastAPI → Supabase PostgreSQL. Explicit new
investigations use the OpenAI Responses API with configurable `gpt-5.4-mini`.
Saved-history reads do not invoke the provider. No AI Resolution implementation,
automatic financial remediation or automatic case closure is included.

## Flow and ownership

1. FastAPI collects a bounded, read-only operational snapshot and releases the
   transaction before inference. `investigation_projection.py` builds the factual
   model input, excluding simulator answers and legacy causal assessments.
2. The provider uses strict structured output and actual-source citation enums.
   The service independently checks journal verification, monetary literals,
   source references, instruction relationships and review-action prerequisites.
   Authorization/action rationale flags remain visible for analyst review.
3. Durable mode reserves a UUID request before inference. Accepted reports are
   immutable; rejected/failed outcomes are separate safe summaries. Reusing the
   same request UUID does not create another paid call, including after restart.
4. The frontend loads history by authenticated GET. A separate envelope reports
   current-evidence staleness without modifying the saved report. Prototype runs
   and Resolution proposal receipts remain session-only.

Relevant code: `backend/modules/intelliops/investigation_*.py` and
`frontend/src/portals/intelliops/investigation/`. SQLAlchemy's storage model lives
in `investigation_storage.py`; startup never creates or migrates shared tables.

## Run locally (PowerShell)

From the repository root, create a local environment and install dependencies:

```powershell
py -3 -m venv venv
.\venv\Scripts\python.exe -m pip install -r backend\requirements.txt
if (!(Test-Path backend\.env)) { Copy-Item backend\.env.example backend\.env }
if (!(Test-Path frontend\.env)) { Copy-Item frontend\.env.example frontend\.env }
```

Fill local environment files using credentials obtained through the team's
approved channel. Never commit them. Backend settings:

```dotenv
DATABASE_URL=postgresql+psycopg2://<DB_USER>:<URL_ENCODED_DB_PASSWORD>@<DB_HOST>:5432/<DB_NAME>?sslmode=require
INTELLIOPS_ADMIN_TOKEN=<LOCAL_ADMIN_DEMO_TOKEN>
INTELLIOPS_ANALYST_TOKEN=<LOCAL_ANALYST_DEMO_TOKEN>
INTELLIOPS_INVESTIGATION_PERSISTENCE=true
OPENAI_API_KEY=<BACKEND_ONLY_OPENAI_KEY>
OPENAI_MODEL=gpt-5.4-mini
INTELLIOPS_LLM_TIMEOUT_SECONDS=45
INTELLIOPS_LLM_MAX_OUTPUT_TOKENS=4000
INTELLIOPS_LLM_MAX_INPUT_CHARS=200000
INTELLIOPS_LLM_DIAGNOSTICS_DIR=
```

Persistence is already deployed in the existing shared development database.
Only enable it against a database with the approved schema. The example file
defaults to false for undeployed environments. An OpenAI key is needed only for
an explicit new model call, not to retrieve the existing reports. Keep optional
candidate diagnostics disabled unless needed; any local diagnostics belong in
ignored `logs/`, not Git. No credentials belong in `VITE_*` variables.

Start FastAPI from `backend`:

```powershell
..\venv\Scripts\python.exe -m uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

In another terminal, from `frontend`:

```powershell
npm.cmd ci
npm.cmd run dev -- --host 127.0.0.1 --port 5173
```

The existing frontend example uses `VITE_BANKING_API_URL=/backend` and
`INTELLIOPS_BACKEND_TARGET=http://127.0.0.1:8000` for the Vite proxy. Open only
**http://localhost:5173**. At the demo access prompt, enter the matching local
ADMIN or ANALYST token and select **Connect to Demo Backend**. A fresh browser
session may require that token again; its reports are still stored server-side.

## Database: already deployed, do not rerun SQL

The approved [SQL record](../backend/sql/001_investigation_records.sql) was applied
once to the shared development database on 12 November 2026, and three accepted
reports were imported without provider calls. Deployed SHA-256:

`10d5e91e120de4abc8a6a6f8b608a94109817e4563f2dc68954ab5b2303699ef`

The per-file `.gitattributes` rule preserves LF line endings for this SQL record
on Windows so checkout conversion does not change that deployed checksum.

The file contains the 12-column `public.investigation_records` table, case FK,
request/report uniqueness, case-history and RUNNING-case indexes, status/report
checks, history-protection function/trigger, RLS and browser-role restrictions.
The existing Alembic revision remains `20261111_08`; no new migration was added.
The historical deployment-log filename in its comment is not a runtime dependency.

**Do not execute this script again**, run Alembic revision/upgrade/downgrade,
reset/seed Supabase or reimport reports as a setup step. New environments or
schema changes require separate explicit approval. If authorized for read-only
verification, inspect metadata through your team's existing database access:

```sql
SELECT column_name, data_type FROM information_schema.columns
WHERE table_schema='public' AND table_name='investigation_records';
SELECT indexname, indexdef FROM pg_indexes
WHERE schemaname='public' AND tablename='investigation_records';
SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
WHERE conrelid='public.investigation_records'::regclass;
SELECT tgname FROM pg_trigger
WHERE tgrelid='public.investigation_records'::regclass AND NOT tgisinternal;
SELECT version_num FROM public.alembic_version;
```

These are reads, not deployment permission. Never print connection passwords or
tokens. `import_investigation_reports.py` is an administrative, target-confirmed
write utility; it is not part of normal teammate startup and needs approval.

## Inspect the accepted cases without paying again

Open **IntelliOps → Exception Center**, select a case and choose
**Open Investigation**. The existing accepted report loads from PostgreSQL:

| Case | Verified core result | Review-only action |
|---|---|---|
| CASE-000010 | Shared customer submission; repeat held; one SGD 25 journal | `CLOSE_HELD_DUPLICATE` |
| CASE-000011 | System retry after timeout; control lookup MISS despite prior execution; two SGD 10 journals | `ESCALATE_DUPLICATE_FINANCIAL_EXECUTION` |
| CASE-000009 | Distinct verified customer authorizations; two SGD 3.33 journals | `REVIEW_FALSE_POSITIVE_CLOSURE` |

Inspect financial verification, source links, citations, uncertainty and any
review flags. Refresh, reopen saved history or restart the browser: these are
GET-based report reads, not new model requests. **Start AI Investigation** and
**Run new investigation** are explicit paid-capable actions. Use a new request
UUID only for an intentional new run; network retry must retain the original.

Authenticated endpoints (shared-case access for ADMIN and ANALYST):

| Endpoint | Effect |
|---|---|
| `GET /api/exceptions/{case_id}/investigation-evidence` | Current read-only evidence |
| `POST /api/exceptions/{case_id}/investigations` | Explicit new model call; durable mode requires UUID `X-Investigation-Request-ID` |
| `GET /api/exceptions/{case_id}/investigations?limit=20&offset=0` | Paginated report/request history, no model call |
| `GET /api/exceptions/{case_id}/investigations/{investigation_id}` | Accepted report plus current-source comparison, no model call |

All recommendations require human review. Sending a Resolution handoff saves a
proposal only; it does not approve, remediate or close a case. A crash may leave
a RUNNING reservation that blocks another paid run; an operator must review it,
never blindly retry or alter immutable history.

## Offline regression commands

From `backend`:

```powershell
..\venv\Scripts\python.exe -B -m unittest discover -s tests -p 'test_investigation*.py' -q
..\venv\Scripts\python.exe -B -m unittest discover -s tests -p 'test_payments.py' -q
```

From `frontend`:

```powershell
npm.cmd test
npm.cmd run build
```

Routine backend tests use mocked/saved analysis and disposable SQLite. The
existing-case wire tests are opt-in and skipped by default; leave
`INTELLIOPS_VERIFY_EXISTING_CASES` unset or `0` for fully offline runs. Tests
explicitly control persistence mode instead of inheriting shared configuration.
See [fixture notes](../backend/tests/fixtures/README.md) for the reviewed synthetic
regressions; no ignored local log or paid-call dump is required to run them.

Browser tests under `frontend/tests-ledger` require external, read-only case
access and the existing token supplied privately to the process. They are
**not part of fully offline verification**. `investigation-history.spec.js`
intercepts report/history responses; `investigation-deployed.spec.js` uses real
history GETs and additionally requires `INTELLIOPS_VERIFY_DEPLOYED_HISTORY=1`.
Both block mutations/provider URLs. Do not run either automatically as a local
unit-test substitute. No additional live-provider evaluation is authorized.

## Limits to retain in review

- A/B/C successes were controlled calls across evolving revisions, not proof of
  universal model accuracy. Known narrative omissions remain; explanations and
  action rationale require analyst review.
- Deterministic journal/financial verification is authoritative. Currency checks
  cover bounded literal formats, not every arithmetic or semantic assertion.
- A citation can name a real ID without proving the claim. Review flags assist
  review but neither their presence nor absence proves quality.
- Missing/conflicting evidence warrants caution; missing customer motivation
  alone does not invalidate recorded authorization. No simulator answer is sent.
- Saved reports are immutable snapshots. A changed fingerprint means stale;
  unavailable current evidence means unknown freshness. Revalidate current state
  before any separately authorized action.
- Roles are shared demo-token roles, not per-user case ACLs. Handoff remains a
  session-only proposal; Phase 3 AI Resolution is not implemented.
