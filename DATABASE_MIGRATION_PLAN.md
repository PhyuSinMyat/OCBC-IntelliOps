# Detection Engine Database Migration Plan

Updated 11 November 2026 (Asia/Singapore). **Ready for deployment subject to target preflight. Instructions for later execution only: Supabase was not connected to or modified.** Its current revision is expected to be `20261103_06`; this has not been rechecked remotely.

## Revision and expected effects

New file: `backend/alembic/versions/20261110_07_detection_engine.py`.

```text
20261103_01 → 20261103_02 → 20261103_03 → 20261103_04
             → 20261103_05 → 20261103_06 → 20261110_07
```

One head: **20261110_07**, directly following **20261103_06**. The pending `_07` was amended before deployment; the six historical migration files were not edited. This is an online migration; the initial historical revision depends on database inspection, so a full offline SQL-render workflow is not established.

| Object | Additive changes |
|---|---|
| detection_rules | Add nullable unique code VARCHAR(60); description TEXT; severity VARCHAR(20); configuration JSON; version INTEGER; updated_at TIMESTAMPTZ. Non-null defaults for description/severity/configuration/version/time support existing rows. Unique exception_type; version >= 1, supported severity and nonnegative legacy-threshold checks. |
| detection_rules records | Provision nine known stable rule codes. Match existing types to preserve numeric IDs, custom names and enabled flags; assign code/description/default severity/version/configuration. Preserve unknown legacy rows under LEGACY_<id> codes without making them executable. |
| detection_observations | New table: integer PK, transaction FK/index, rule FK, defective boolean, optional evidence fingerprint, required policy fingerprint and observation timestamp; unique transaction_id/rule_id. Empty until an authorized scan. |
| exceptions / history | **No row rewrite, deletion, rule-ID backfill, key rewrite or new column.** Existing cases retain IDs/evidence, including NULL rule_id. Active-detection partial unique index remains unchanged. |
| Financial source tables | No transactions, accounts, opening balances, journals, entries or events are seeded/recreated/modified. |

Application table count becomes **17** (plus alembic_version). Nine rule rows are expected for a currently empty rule table; extra unregistered legacy rows remain if present. Integer IDs are database-assigned; use stable code rather than assuming IDs 1–9.

`backend/alembic/script.py.mako` was restored for future revision generation. It is not an additional revision and does not change runtime data.

## Sequence edge case fixed and tested

Explicit legacy rule IDs do not advance PostgreSQL's allocator. A never-called sequence at 1 alongside existing ID 1 previously caused a primary-key collision while provisioning missing rules; an allocator behind a higher legacy ID could also collide later.

On PostgreSQL, `_07` now locks `detection_rules` before reading its legacy rows, resolves the actual owned sequence from PostgreSQL catalogs, and reads `last_value` **and** `is_called`. Only a lagging allocator is restarted above the maximum existing rule ID; an already-ahead allocator is never rewound. Identifier quoting supports schema-qualified/catalog-resolved sequence names. The migration rejects absent, descending or cycling allocators and insufficient integer/sequence capacity before schema changes. SQLite behavior is unchanged.

Reconciliation uses `ALTER SEQUENCE ... RESTART WITH`, not `setval`. PostgreSQL documents RESTART as transactional and blocking concurrent allocation ([PostgreSQL 17 reference](https://www.postgresql.org/docs/17/sql-altersequence.html)). A test injects a later migration failure and confirms the schema, sequence restart and revision all roll back. Normal `nextval` operations can still leave harmless sequence gaps after a failed transaction; IDs are never renumbered or reused deliberately.

Stop writers and restart backend connections as part of deployment, especially with customized sequence caches or clients calling `nextval` independently of INSERT. The migration lock coordinates ordinary rule-table DML; it is not a global protocol for unrelated direct allocator users. The migration role must own/can alter the sequence, in addition to ordinary schema migration permissions. No manual sequence reset is needed for the normal lagging-sequence case.

## Before applying

1. Review the migration and arrange the usual development-database backup/recovery point. Stop backend/detector writers and clients preallocating rule IDs; restart them with fresh connections after successful verification. Do not run the new detector while the database remains at `_06`.
2. Confirm the selected interpreter is `backend/.venv/Scripts/python.exe`, DATABASE_URL resolves to the intended development project, TLS is required, and the effective schema is public. Never print the URL/password. A shell-level DATABASE_URL overrides `.env`; do not carry a SQLite test override into deployment commands.
3. Run the following **read-only** SQL preflight in the intended database:

   ```sql
   SELECT current_database(), current_user, current_schema();
   SELECT version_num FROM public.alembic_version;
   SELECT id, name, exception_type, threshold, enabled
   FROM public.detection_rules ORDER BY id;
   SELECT exception_type, count(*)
   FROM public.detection_rules
   GROUP BY exception_type HAVING count(*) > 1;
   SELECT count(*) AS existing_cases FROM public.exceptions;

   -- Read-only: does not consume/reset any sequence value.
   SELECT pg_get_serial_sequence('public.detection_rules', 'id') AS rule_sequence,
          (SELECT max(id) FROM public.detection_rules) AS highest_rule_id;
   SELECT schemaname, sequencename, increment_by, max_value, cycle, cache_size, last_value
   FROM pg_sequences
   WHERE schemaname = 'public'
     AND sequencename = (
       SELECT c.relname FROM pg_class c
       WHERE c.oid = pg_get_serial_sequence('public.detection_rules','id')::regclass
     );
   ```

4. The migration deliberately stops **before schema changes** for duplicate types, negative thresholds, reserved default-name collisions or known rule types with non-null legacy thresholds. Old thresholds were ignored, so their units cannot be inferred safely. Review intended meanings separately; do not silently discard, merge, delete or reinterpret shared configurations to force migration through.
5. Confirm no independently created detection_observations table or conflicting rule columns already exist. Partial/manual schema state needs review, not a blind stamp/reset.

## Supabase security considerations

The application uses authenticated FastAPI as its browser data boundary. New control tables must not accidentally become writable through Supabase's Data API. Earlier read-only review observed broad anon/authenticated default grants in public; these migrations contain no blanket privilege changes or RLS policies.

Before exposing the deployed application, explicitly review public-schema Data API exposure and the grants/RLS policy for detection_rules, detection_observations, exceptions and financial tables. Prefer backend-only access for detector control state; implement any required grant/RLS changes in a separately reviewed reproducible security migration. Direct SQL connections with the postgres role are privileged and do not demonstrate client-role isolation.

Migration execution needs CREATE/ALTER/INDEX/REFERENCES privileges; the runtime detector needs its control/case/action/audit DML and source reads/row locks. TLS credentials stay backend-only. No Supabase keys, passwords or full connection URLs belong in these documents or frontend variables.

## Commands to apply later

Run later from the repository root in a fresh PowerShell deployment shell. Confirm the backup and read-only SQL preflight above first. Keep the backend `.env` Session pooler URL on port 5432 with `sslmode=require` (or verify-ca/verify-full), and the intended project reference `bluodtbpbpevzjptxstw`. Do not print it. The checks below reject a shell DATABASE_URL override, verify the intended pooler target/TLS and expected revision, and perform no detection or seeding:

```powershell
Set-Location backend
if (Test-Path Env:DATABASE_URL) {
    throw 'A shell DATABASE_URL overrides backend/.env. Start a clean shell or clear the override deliberately.'
}
@'
from pathlib import Path
from dotenv import load_dotenv
load_dotenv(Path.cwd() / ".env", override=False)
from shared.database import engine
from sqlalchemy import text
url = engine.url
assert url.get_backend_name() == "postgresql", "Expected PostgreSQL"
assert url.username == "postgres.bluodtbpbpevzjptxstw", "Unexpected Supabase project"
assert (url.host or "").endswith(".pooler.supabase.com") and url.port == 5432, "Expected Session pooler on 5432"
assert url.database == "postgres", "Unexpected database"
assert url.query.get("sslmode") in ("require", "verify-ca", "verify-full"), "Require TLS in backend/.env"
with engine.connect() as conn:
    conn.execute(text("SET TRANSACTION READ ONLY"))
    assert conn.connection.driver_connection.info.ssl_in_use, "Client-to-pooler TLS is inactive"
    assert conn.execute(text("SELECT current_schema()")).scalar_one() == "public", "Unexpected schema"
    assert conn.execute(text("SELECT version_num FROM public.alembic_version")).scalar_one() == "20261103_06", "Stop: revision is not 20261103_06"
print("Read-only preflight passed: intended Session pooler, TLS active, public schema, revision 20261103_06.")
engine.dispose()
'@ | .\.venv\Scripts\python.exe -
if ($LASTEXITCODE -ne 0) { throw 'Preflight failed; do not migrate.' }
.\.venv\Scripts\python.exe -m alembic current
if ($LASTEXITCODE -ne 0) { throw 'Revision check failed.' }
.\.venv\Scripts\python.exe -m alembic heads
if ($LASTEXITCODE -ne 0) { throw 'Head check failed.' }

# This next command applies ONLY the reviewed target. Do not run until preflight passes.
.\.venv\Scripts\python.exe -m alembic upgrade 20261110_07
if ($LASTEXITCODE -ne 0) { throw 'Migration failed. Keep writers stopped and inspect; do not stamp/reset.' }
.\.venv\Scripts\python.exe -m alembic current
if ($LASTEXITCODE -ne 0) { throw 'Post-migration revision check failed.' }
```

Expected current before migration: `20261103_06`; expected head/current afterward: `20261110_07`. Only `upgrade` applies migrations. Its explicit revision avoids accidentally applying a future unreviewed head. `python -m alembic upgrade head` is equivalent only while `_07` remains the sole head. The migration takes an exclusive rule-table lock; investigate active sessions if it waits unexpectedly. Do not use generate_data.py, create_all, reset, drop, or alembic stamp as substitutes. Defaults are provisioned by this migration; no Supabase seed/backfill command is needed. JSON configuration `{}` is intentional: the registry supplies validated effective defaults (amount tolerance 0 cents, timeout inactivity 300 seconds / maximum pending 1800 seconds; reconciliation uses the existing configured cutoff).

The downgrade intentionally raises rather than deleting rule/observation history. Recover through a reviewed forward fix or approved backup procedure; do not assume automatic destructive rollback is supported.

## Post-migration read-only verification

```sql
SELECT version_num FROM public.alembic_version;

SELECT id, code, name, exception_type, enabled, severity,
       threshold, configuration, version, updated_at
FROM public.detection_rules ORDER BY code;

SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('detection_rules', 'detection_observations')
ORDER BY table_name, ordinal_position;

SELECT indexname, indexdef FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename IN ('detection_rules', 'detection_observations', 'exceptions')
ORDER BY tablename, indexname;

SELECT id, rule_id, exception_type, status, detection_key
FROM public.exceptions ORDER BY id;

SELECT count(*) AS observations_before_first_scan
FROM public.detection_observations;
```

Expect existing cases unchanged and observations empty before the first scan. Historical NULL rule_id values remain valid. Compare financial source counts/balances with the recorded pre-deployment baseline; this migration does not alter them. New cases receive rule IDs only when an authorized detector run subsequently finds a new eligible condition.

After deployment, read existing snapshot/case APIs first, including CASE-000004. Run mutation-based synthetic acceptance checks only when explicitly authorized. A first upgraded scan can identify previously missed invalid postings or old pending payments; more case types than the old engine are an intentional change, not automatic source repair.

## Safe automated verification

Verified 11 November 2026 on disposable loopback **PostgreSQL 17.11** (`postgres:17-alpine`, no host data mounts). Eight PostgreSQL tests cover a fresh full revision chain, concurrency, populated `_06` upgrades with called/never-called lagging sequences and called/uncalled ahead sequences, capacity rejection, and transactional rollback after an injected later failure. All nine known codes/configurations validate; extra legacy rule rows remain. Repeat `upgrade` is a no-op.

Populated fixtures include customers, accounts, payment instructions, completed payments, processing events, journals/entries, audits and historical cases with both populated/NULL rule IDs and active/terminal detection keys. Exact snapshots of every pre-existing non-rule source table and independently calculated opening/current account balances match before/after. Rule IDs 1 and 42, custom names, enabled flags and unknown legacy thresholds are preserved. `detection_observations` starts empty. No actual Supabase rows were queried for this comparison.

For a later repeat of isolated tests without leaving a shell-level DATABASE_URL override:

```powershell
Set-Location backend
.\.venv\Scripts\python.exe -B -c "import os, unittest; os.environ['DATABASE_URL']='sqlite:///:memory:'; suite=unittest.defaultTestLoader.discover('tests'); result=unittest.TextTestRunner(verbosity=2).run(suite); raise SystemExit(not result.wasSuccessful())"
```

PostgreSQL concurrency and migration tests are opt-in through **INTELLIOPS_TEST_POSTGRES_URL**, never application DATABASE_URL. The configured host must be loopback and database name must end `_test`; remote/Supabase URLs and host-override query parameters are rejected. Tests create and remove their own random schema in that disposable database. Do not point them at shared development data. With the disposable URL configured, the full suite now passes **72 tests, 0 failures, 0 skipped**, including all **8 PostgreSQL tests**. Without the explicit disposable URL, those 8 tests intentionally skip.

Workflow/approval source systems, a settings management API, scheduling, independent verification and automatic actions for new exception types remain separate dependencies/features, not prerequisites to this additive schema deployment.
