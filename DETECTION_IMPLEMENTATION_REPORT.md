# Exception Detection Implementation Report

Date: 10 November 2026 (Asia/Singapore). Implements the local changes requested after `DETECTION_RULES_AUDIT.md`. **Not deployed:** Supabase was not connected to or modified during implementation. The additive migration is prepared for the user to apply later.

## Implemented changes

| Area | Before | After |
|---|---|---|
| Missing/invalid posting | Any linked journal could suppress missing-posting and amount checks | No records → Missing Ledger Posting; invalid/incomplete records → Invalid Ledger Posting, with explicit reasons and entry evidence |
| Payment-level ledger validity | Internal journal balance only | Also checks instruction sender/receiver, payment currency and conflicting source references; specific account/currency exception types |
| Amount reconciliation | Exact amount comparison, including potentially unsafe mixed evidence | Configurable cents tolerance; modern comparison only when all linked journals are valid/aligned and no legacy representation competes; legacy-only comparison remains explicitly labeled |
| Duplicate detection | Shared business reference treated uniformly | Explicit original-instruction link preferred; reference collision fallback; attributes, status, hold events and verified postings assessed separately; suspected intent remains suspected; root cause stays unknown |
| Financial assessment | No distinction between held request and second posting | One verified original posting plus source hold distinguished from two verified postings; absence alone does not establish non-execution |
| Rule identity/configuration | Optional database records, unused thresholds | Nine stable executable codes; unique code/type; persisted rule ID, name, description, severity, enabled, configuration, version and updated timestamp; supported thresholds applied and invalid/ambiguous settings rejected |
| Pending/processing | No timeout condition | Configurable inactivity and maximum-age policies; explicit external waits use bounded grace; held duplicates excluded until later source activity resumes |
| Repeat detection/recurrence | All terminal keys permanently suppressed | Active cases deduplicated; new occurrence after observed recovery under the same policy followed by a fresh violation; historical case/evidence never reopened or overwritten |
| Concurrent scans | Transaction row locks/partial index only | PostgreSQL transaction advisory lock serializes detector runs, including default-rule initialization; partial index retained; competing active-key insertion handled in a savepoint |
| Existing correction safety | Stale mismatch or double-posted duplicate could reach narrow correction branches | Current journals are revalidated before mismatch adjustment/duplicate rejection; unsafe evidence returns 409 rather than changing financial records |

Original five exception names remain unchanged. Added types: **Invalid Ledger Posting**, **Ledger Account Mismatch**, **Ledger Currency Mismatch**, **Processing Timeout**. Multiple precise types can apply to one source defect, such as internal currency corruption plus payment-currency mismatch.

## Files changed or added

| File | Purpose |
|---|---|
| `backend/modules/intelliops/detection.py` | Indexed source loading, pure rule evaluation, rule attribution, timeout/duplicate/ledger classification, observations, recurrence and conflict handling |
| `backend/modules/intelliops/rules.py` | Stable registry, validated defaults/threshold units, deterministic configuration loading |
| `backend/modules/intelliops/models.py` | Additive rule fields/constraints; DetectionObservation model |
| `backend/modules/core_banking/service.py` | Pure `assess_journal` helper; existing balance aggregation/posting functions retained |
| `backend/modules/intelliops/resolution.py` | Current journal/party/currency/reference safeguards for mismatch correction and duplicate containment |
| `backend/modules/payment_processing/api.py` | Invalid rule configuration returns HTTP 422; detection response contract unchanged |
| `backend/models.py` | Register/export DetectionObservation |
| `backend/alembic/versions/20261110_07_detection_engine.py` | Additive schema/default-rule migration from `_06`; no historical case rewrite |
| `backend/alembic/script.py.mako` | Restore template for future Alembic revision generation |
| `backend/tests/test_detection.py` | Isolated detector, recurrence, migration, conflict, compatibility and correction regressions |
| `backend/tests/test_detection_postgres.py` | Opt-in disposable local PostgreSQL concurrency and migration tests; remote/Supabase targets rejected |

No frontend source, `.env`, historical migration, seeded account balance or shared financial record was changed. The audit document remains a record of the old implementation; the new reference describes current local code.

## Schema and configuration

Revision **`20261110_07`**, parent **`20261103_06`**, adds rule code/description/severity/configuration/version/updated_at and unique/check constraints. It creates `detection_observations` with one latest observation per transaction/rule. Application table count becomes 17 after deployment.

The migration provisions the nine known rules, preserving IDs, names and enabled states of existing matching rows. Existing case rule_id values, including NULLs, are untouched. New cases always reference a persisted rule and snapshot its code/version/configuration in evidence.

To avoid silently interpreting old ignored settings, migration preflight rejects duplicate exception types, reserved-name collisions and non-null legacy thresholds on known rules; negative legacy thresholds are also rejected. Resolve those configurations through a separate reviewed decision. Unregistered legacy rules remain readable but do not become executable.

The detector can materialize missing registry defaults inside an authorized detection transaction, supporting metadata-created test databases. This does not bypass the required schema migration. Unsupported configuration fails atomically; unknown rules never execute supplied SQL or code. Configuration administration/version increments remain an operator/service responsibility; no new settings UI/API was introduced.

## API and existing case compatibility

- `POST /api/detection/run` retains `{created, caseIds}` and existing bearer authorization. A malformed/conflicting configuration now returns 422 with a useful message.
- `GET /api/banking-snapshot`, exception list/detail APIs, payment APIs and ledger/account read contracts retain their fields and formatting.
- Existing CASE/TXN/JRN identifiers remain unchanged. Historical active cases with NULL rule_id or detection_key are recognized by transaction/type and remain readable without rewriting their evidence.
- CASE-000004-style duplicate investigation still receives `originalReference` and `businessReference`. New evidence is additive. No LLM, mock source evidence, or unrelated frontend design was added.
- New exception types display in the existing generic table/detail view. Existing AI Investigation remains duplicate-only. No automated correction was invented for new invalid-ledger/timeout types.
- Existing correction replay behavior remains; strengthened safety checks intentionally block unsafe stale cases. Broader approval/verification and financial account-locking redesign remain separate work.

## Recurrence policy

Never reopen a historical case. While any same-transaction/type case is active, do not create another. Following a terminal case, create a new linked occurrence only after an eligible scan observed no violation under the same version/configuration and a later scan observes a violation again. Evidence includes `recurrenceOf`; the old case's evidence/timeline is preserved.

Unchanged or merely changed-but-still-defective evidence is suppressed after closure. Disabled rules, unexpired reconciliation windows, non-completed payment states for ledger rules, clock rewinds and policy changes do not themselves establish ledger recovery. Historical terminal cases without cursors establish a conservative baseline rather than immediately recurring.

An entire recovery/regression between scans is not observable and remains suppressed. Observations are current detector cursors, not an immutable source history or independent resolution verification service. DETECTION_RUN audit rows continue to record every successful scan, including zero-case runs.

## Verification results

Updated 11 November 2026: the pending migration's sequence edge case is fixed and deployment verification is complete on disposable PostgreSQL 17.11. Supabase was not connected to or modified. Git remains on `feature/detection-improvements`; the working tree is intentionally dirty with the existing detection and AI investigation changes plus this migration fix. No push or merge was performed.

All mutation-based tests ran only against isolated databases. Application DATABASE_URL was forced to `sqlite:///:memory:` in the test subprocess, and existing fixtures bind requests to separate SQLite engines. No live FastAPI endpoints, Supabase connections, configured development database mutations, generator runs or remote migrations were used.

| Check | Actual result |
|---|---|
| Existing backend suite after initial implementation | 21 passed |
| Full current backend suite using backend/.venv, isolated DATABASE_URL and explicit disposable PostgreSQL test URL | **72 passed, 0 failed, 0 skipped** (includes subsequent AI investigation tests) |
| PostgreSQL-only tests | **8 passed, 0 failed, 0 skipped** on PostgreSQL 17.11; fresh migration, concurrent detection, four populated sequence states, injected-failure rollback and allocator-capacity rejection |
| `node --test --test-isolation=none src/portals/intelliops/investigation/analysis.test.js` | **12 passed, 0 failed, 0 skipped** |
| Backend import / OpenAPI | Passed; 24 application paths |
| PostgreSQL schema/default-rule migration | Executed fresh chain and populated `_06` to `_07`; 17 application tables; all nine registered codes/configurations validated |
| Revision chain | One head `20261110_07`, connected to the unchanged six original revisions |
| `git diff --check` | Passed; Git emitted only an informational line-ending warning |

An early expanded-test run had 22 fixture setup errors because the new test class omitted shared setup aliases. The aliases were corrected; no production failure was hidden, and the final suite passed. Starlette emits a TestClient/httpx deprecation warning; it did not fail checks. No dependencies were installed.

Coverage includes all five original rules, Draft/Reversed/unbalanced/incomplete journals, missing timestamps/unposted/invalid entries, wrong parties/currencies/source references, held and double-posted duplicates, legitimate repeated payments, uncertain collisions, last activity/retries/waits, thresholds and boundaries, configuration rejection, repeated scans, recurrence, immutable historical evidence, legacy/mixed ledgers, CASE-000004-style reads, savepoint recovery, migration preservation and existing API/correction regressions.

## Blocked dependencies and remaining limits

- Workflow failure, overdue workflow task and missing required approval rules are **blocked**: no authoritative workflow/approval models or source events exist (`backend/modules/workflow/README.md`). No fake source system was added.
- PostgreSQL concurrency and actual PostgreSQL migration execution are now **verified on a disposable database**. The live Supabase target's current revision, privileges, rule configurations and schema still need the read-only deployment preflight; this work deliberately did not inspect it.
- Runtime scans still load whole datasets, although linkage maps replace repeated full-list filtering. The scan-wide lock trades throughput for safe serialization. Source writers that do not coordinate with payment locks can still race multi-query reads; a point-in-time source snapshot/event protocol is future work.
- Orphan journals with neither usable payment reference nor source link remain outside payment-scoped detection. Legacy rows cannot establish modern account ownership; uncertainty is explicit.
- Identical idempotency keys across separate instructions are already prevented by the database unique constraint. Different request keys with an authoritative original link can still expose duplicate financial execution; the detector does not label this an idempotency root cause without evidence.
- Invalid configuration changes, scheduler setup, automatic case resolution, manual resolution of new types, approval control and independent post-action verification are outside this implementation.

## Deployment next steps

Review [DATABASE_MIGRATION_PLAN.md](DATABASE_MIGRATION_PLAN.md), perform its target/TLS/revision/configuration preflight and record a backup/baseline, then apply the explicit reviewed target `20261110_07` while writers are stopped. PostgreSQL verification is complete; there is no remaining known migration-code blocker for supported `_06` schemas. Existing preflight rejection conditions and the deliberately disabled destructive downgrade still apply. Restart backend connections after verification; do not run the new detector against revision `_06`.

## Sequence reconciliation and preservation evidence

The original pending migration assumed the detection_rules SERIAL allocator already followed explicit legacy IDs. It now takes an exclusive rules-table lock before reading legacy rows, resolves the actual owned PostgreSQL sequence, and checks both `last_value` and `is_called`. A lagging sequence advances past the maximum preserved ID using transactional `ALTER SEQUENCE ... RESTART WITH`; an ahead sequence retains its allocation point. Unsupported descending/cycling/missing allocators and insufficient capacity fail before schema changes. Historical six revisions and application source were not changed by this fix.

Populated regression fixtures include explicit legacy rule IDs 1 and 42, a custom disabled known rule, an unknown rule with a preserved threshold, historical case IDs 4 and 73, populated and NULL case rule IDs, active/terminal detection keys, customers/accounts, completed payments/instructions/events, journals/entries and audits. Exact snapshots of all pre-existing non-rule source tables and opening/current account balances are identical after upgrade. Existing rule IDs, names and enabled flags are retained; the nine executable rules have expected types/severities, configuration `{}`, version 1 and timestamps. The extra unknown legacy row remains non-executable. No seed/backfill is required, and observations start empty.

A test forces failure after sequence reconciliation and rule provisioning: PostgreSQL restores `_06`, the original columns, source records and the original sequence state; a subsequent clean upgrade succeeds. Repeated `upgrade head` is a no-op. This is transaction-abort recovery, not permission to downgrade a successfully deployed history: `_07` still intentionally rejects downgrade.
