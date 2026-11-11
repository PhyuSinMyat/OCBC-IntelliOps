# OCBC IntelliOps — Project Implementation Audit

Audit date: 10 November 2026 (Asia/Singapore). Scope: repository working tree, including the pre-existing modified root README. Audit only: no application source, environment file, database, migration, or seed was changed. Companion deliverables: [implementation checklist](IMPLEMENTATION_CHECKLIST.md) and [development roadmap](DEVELOPMENT_ROADMAP.md).

## Section 1 — Executive Summary

**Overall status: PARTIAL.** This is a substantial synthetic payment/ledger and case-management implementation with a deterministic investigation prototype. It is not yet the proposed AI-assisted, approval-controlled, verified resolution platform.

The backend contains actual SQLAlchemy persistence, authenticated payment APIs, deterministic detection, case notes, four direct remediation policies, closure, and audit records. Connected frontend mode uses a shared backend snapshot and refreshes it after mutations. Default frontend mode instead runs a persistent browser simulation. These are distinct operating modes, not equivalent evidence of database integration.

The largest gaps are the source workflow simulator, server-side investigation and LLM integration, durable resolution orchestration, approval decisions and resumption, independent verification, escalation, SLA, and operations analytics. Overview, Approval Center, Analytics, Settings, and the default Resolution Workflows page render a shared interface preview. The investigation-specific workflow route renders a session-only proposal receipt.

**Verification:** 12 investigation analysis/presentation tests passed. Four other frontend test files failed to load because React is absent; the build failed because Vite is absent. Backend unittest discovery produced two module import errors because Alembic is absent; its 21 actual test methods did not execute. Safe backend import, OpenAPI generation (24 application paths), Python parsing, migration-chain inspection, and relative JavaScript import inspection succeeded. No backend business feature is classified COMPLETE from these structural checks.

**Critical blockers:** missing runtime/test dependencies; no workflow/approval/verification lifecycle; direct remediation does not enforce an approval decision; corrective operations have weaker account locking and revalidation than normal payments. A frontend/backend idempotency mismatch also impairs recovery after an uncertain response.

**Integration readiness:** useful foundation for an integrated synthetic demonstration, but the complete Exception Center → AI Investigation → Resolution → Approval → Verification → Audit journey is not implemented. Existing backend capabilities should be extended, not rebuilt. Actual deployed database schema/data, PostgreSQL concurrency behavior, browser rendering, and external hosting are UNKNOWN in this audit.

Status meanings used below:

| Classification | Meaning |
|---|---|
| COMPLETE | Implemented, integrated within the stated narrow scope, and verified by successful relevant checks. |
| IMPLEMENTED — NOT VERIFIED | Source appears implemented; relevant execution has not confirmed it. |
| PARTIAL | Some functionality exists; important requirements or integration are missing. |
| MOCK / SIMULATED | Browser simulation, deterministic prototype, fixture, or preview without the intended backend implementation. |
| NOT IMPLEMENTED | No meaningful implementation found. |
| BROKEN | Demonstrable failure or incompatible interface; environment failures are explicitly distinguished. |
| UNKNOWN | Available evidence cannot establish the result. |

Evidence references below use repository-relative `path:line` and named functions. A successful import is not proof of successful database behavior. Existing test code and historical reports are coverage/intention evidence, not current passing results.

## Section 2 — Implementation Status Matrix

| Module | Feature | Status | Frontend | Backend | Database | Evidence |
|---|---|---|---|---|---|---|
| Synthetic systems | Normal payment creation and processing events | IMPLEMENTED — NOT VERIFIED | Form, validation, history | Transactional service, fingerprint replay | Transaction, PaymentInstruction, ProcessingEvent | `frontend/src/portals/payment-processing/CreatePaymentForm.jsx:15`; `backend/modules/payment_processing/service.py:44` |
| Synthetic systems | Account ownership, balances, journal views | IMPLEMENTED — NOT VERIFIED | Registers and linked drawers | SQL journal validation/aggregation | Customer, Account, LedgerJournal, LedgerEntry | `backend/modules/core_banking/service.py:22`; `frontend/src/portals/core-banking/Accounts.jsx:10` |
| Synthetic systems | Source scenario generation | IMPLEMENTED — NOT VERIFIED | Four selectable fault types | Six scenario codes including NORMAL and UNMATCHED | PaymentInstruction + source records | `backend/modules/payment_processing/schemas.py:7`; `service.py:84`; `frontend/src/portals/payment-processing/CreatePaymentForm.jsx:6` |
| Synthetic systems | Exception batch generation | IMPLEMENTED — NOT VERIFIED | Connected ADMIN form | Transactional scenario generation | ExceptionBatch, ExceptionBatchItem | `backend/modules/payment_processing/batch.py:12`; `api.py:93` |
| Synthetic systems | Legacy 500-record generator | PARTIAL | No direct integration | Generator exists; no normalized ownership | Transactions, single-sided LedgerRecord | `backend/generate_data.py:17`; `generate_data.py:45` |
| Synthetic systems | Default local banking mode | MOCK / SIMULATED | localStorage, integer cents | None in this mode | Browser only | `frontend/src/shared/data/bankingRecords.js:6`, `:58`, `:84` |
| Synthetic systems | Workflow Engine | NOT IMPLEMENTED | No source-task UI | Empty module | No task/workflow tables | `backend/modules/workflow/README.md:3` |
| Detection | Duplicate transaction | IMPLEMENTED — NOT VERIFIED | Manual run, case list | Shared business-reference rule | Case, evidence, action, audit | `backend/modules/intelliops/detection.py:30` |
| Detection | Amount mismatch | IMPLEMENTED — NOT VERIFIED | Displays detected cases | Valid-journal debit total / legacy amount | Same | `backend/modules/intelliops/detection.py:43` |
| Detection | Missing ledger posting | IMPLEMENTED — NOT VERIFIED | Manual run | Completion + reconciliation cutoff + absence | Same | `backend/modules/intelliops/detection.py:35` |
| Detection | Unmatched reference | IMPLEMENTED — NOT VERIFIED | Case visible; generation not selectable in main form | Source-linked journal reference mismatch | Same | `backend/modules/intelliops/detection.py:40` |
| Detection | Payment processing failure | IMPLEMENTED — NOT VERIFIED | Case visible | FAILED transaction status | Same | `backend/modules/intelliops/detection.py:33` |
| Detection | Processing timeout | NOT IMPLEMENTED | Legacy pending records possible | No pending-age condition | No timeout case creation | `backend/generate_data.py:80`; `backend/modules/intelliops/detection.py:12` |
| Detection | Missing approval / workflow failure | NOT IMPLEMENTED | Preview navigation only | No source-task/approval rules | Missing entities | `backend/modules/workflow/README.md:3` |
| Detection | Case creation and active deduplication | IMPLEMENTED — NOT VERIFIED | Snapshot updates | Detection key + partial unique index | exceptions | `backend/modules/intelliops/detection.py:21`; `models.py:50` |
| Detection | Scheduled monitoring / configurable thresholds | PARTIAL | Run Detection buttons | Explicit POST only; enabled flag read, rule threshold unused | DetectionRule exists | `backend/modules/payment_processing/api.py:131`; `backend/modules/intelliops/detection.py:24` |
| Exception Center | List, evidence, severity, lifecycle, notes, closure | IMPLEMENTED — NOT VERIFIED | Table/drawer/actions | Case services and transactions | Durable cases/actions | `frontend/src/portals/intelliops/ExceptionRecords.jsx:15`; `backend/modules/intelliops/service.py:30` |
| Exception Center | Smart tabs, search, filters, dashboard metrics, SLA | NOT IMPLEMENTED | Basic unfiltered case table | No corresponding aggregations/SLA service | No SLA/assignment fields | `frontend/src/portals/intelliops/ExceptionRecords.jsx:52`; `backend/modules/intelliops/models.py:25` |
| Exception Center | Assignment and escalation | NOT IMPLEMENTED | Investigation shows fallback Unassigned | No mutation/routing service | No assignment/escalation fields | `frontend/src/portals/intelliops/AIInvestigation.jsx:84` |
| Exception Center | Case → investigation navigation | IMPLEMENTED — NOT VERIFIED | URL carries CASE ID | Investigation uses already-loaded snapshot | Case persisted; report not persisted | `frontend/src/portals/intelliops/ExceptionRecords.jsx:63`; `AIInvestigation.jsx:39` |
| AI Investigation | Evidence classification and presentation helpers | COMPLETE | Pure deterministic analysis helpers only | None | None | 12 passing tests in `frontend/src/portals/intelliops/investigation/analysis.test.js:9`; `analysis.js:25`, `:68` |
| AI Investigation | Staged investigation, cause/risk/proposal, history | MOCK / SIMULATED | Snapshot analysis, timed stages, sessionStorage | No investigation route | No investigation model | `frontend/src/portals/intelliops/investigation/service.js:29`, `:33`; `analysis.js:100` |
| AI Investigation | Actual LLM and server investigation API | NOT IMPLEMENTED | Explicit No live LLM label | No provider client/route/dependency | None | `frontend/src/portals/intelliops/AIInvestigation.jsx:83`; registered route inspection |
| AI Investigation | Other exception types | NOT IMPLEMENTED | Explicit unsupported state | No server investigation | None | `frontend/src/portals/intelliops/AIInvestigation.jsx:85`; `investigation/service.js:34` |
| Resolution | Reconciliation mismatch recovery | PARTIAL | Direct case action, not workflow page | Positive shortfall only | ExceptionResolution + journal | `backend/modules/intelliops/resolution.py:90` |
| Resolution | Missing reference enrichment | NOT IMPLEMENTED | No action for Unmatched Transaction | Unsupported type returns 409 | No outcome for this policy | `backend/modules/intelliops/resolution.py:143`; `frontend/src/portals/intelliops/ExceptionRecords.jsx:7` |
| Resolution | Duplicate record containment | PARTIAL | ADMIN direct reject | Rejects linked instruction; no approval/state verification workflow | ExceptionResolution | `backend/modules/intelliops/resolution.py:110` |
| Resolution | Failed batch safe retry | PARTIAL | Retry Failed Payment is single-payment action | Payment retry exists; no failed workflow/batch retry engine | Payment resolution, no workflow run | `backend/modules/intelliops/resolution.py:122`; `backend/modules/payment_processing/models.py:65` |
| Resolution | Missing ledger corrective journal | PARTIAL | Direct case action | Source-linked balanced journal, late-arrival guard | LedgerPostingRemediation | `backend/modules/intelliops/resolution.py:74` |
| Resolution | Definitions, matching, engine, tracking, policy decisions | PARTIAL | Receipt or preview only | Exception-type dispatch is not orchestration | No workflow-run/step/policy entities | `backend/modules/intelliops/resolution.py:65`; `frontend/src/app/PortalPage.jsx:17` |
| Resolution | Idempotency across frontend retries | BROKEN | New key on every remediation attempt | Existing case requires same key | Unique stored key | `frontend/src/shared/data/bankingRecords.js:141`; `backend/modules/intelliops/resolution.py:40` |
| Resolution | Simulation/dry run | MOCK / SIMULATED | Local scenarios and investigation fixtures | No resolution dry-run API | No simulation result | `frontend/src/portals/intelliops/investigation/fixtures.js:1`; `ResolutionHandoff.jsx:13` |
| Resolution | Approval pause, resume, verification, recovery escalation | NOT IMPLEMENTED | No connected controls | Immediate resolution or HTTP error | No durable stages/results | `backend/modules/intelliops/resolution.py:53`; `service.py:126` |
| Approval Center | Requests, list, decision, permissions, history, revalidation/resume | NOT IMPLEMENTED | Generic interface preview | No approval routes | No approval model | `frontend/src/app/PortalPage.jsx:19`; `backend/models.py:2` |
| Audit | Events, actor role, timestamp, case history | IMPLEMENTED — NOT VERIFIED | Snapshot event table + case timeline | Inserted inside successful operational transactions | AuditEvent, ExceptionCaseAction | `backend/modules/intelliops/models.py:55`, `:95`; `backend/modules/payment_processing/api.py:143` |
| Audit | Filtering, user identity, workflow references, tamper protection, failure completeness | PARTIAL | No filters/details/workflow tracking | Role actor; selected successful events + posting failure only | Generic text reference/JSON; no immutability constraint | `backend/shared/security.py:10`; `backend/modules/intelliops/models.py:95` |
| Overview / Analytics | Operational dashboard, workflow/success/SLA charts | NOT IMPLEMENTED | Preview page | No metrics API | No metric aggregation | `frontend/src/portals/intelliops/IntelliOpsPage.jsx:24` |
| Overview / Analytics | Payment/account summary counts | IMPLEMENTED — NOT VERIFIED | Derived from shared records | Connected source comes from DB snapshot | Source tables | `frontend/src/portals/payment-processing/TransactionsPage.jsx:44`; `core-banking/Accounts.jsx:37` |
| Security | Static demo bearer validation and ADMIN/ANALYST boundary | IMPLEMENTED — NOT VERIFIED | Manual token connection | compare_digest; Depends role checks | No user/session tables | `backend/shared/security.py:10`; `frontend/src/main.jsx:11` |
| Security | Identity, expiry, revocation, APPROVER role, segregation of duties | NOT IMPLEMENTED | Demo avatar only | No such mechanism | No users/decisions | `frontend/src/app/App.jsx:53`; `backend/shared/security.py:12` |
| Security | Validation / secrets / CORS / synthetic enforcement | PARTIAL | No embedded production credential found in reviewed code | Bounded Pydantic input; env config; no CORS middleware or environment guard | URL-controlled DB; grants/TLS unknown | `backend/modules/payment_processing/schemas.py:11`; `backend/shared/database.py:6`; `backend/main.py:1` |
| Runtime | Build and complete test environment | BROKEN | Missing React/Vite/Playwright installation | Missing Alembic, Faker, PostgreSQL driver | No existing DB accessed | Section 10: actual command results; environment failure, not proven source defect |
| Deployment | Existing DB revision, PostgreSQL operations, production hosting | UNKNOWN | Not exercised | Not exercised | Not inspected | No deployment/db access performed |

## Section 3 — Completed Features

The only business-code functionality meeting the strict verified criterion is the **narrow deterministic duplicate investigation analysis/presentation helper scope**. Twelve existing tests passed, covering held duplicates, correlated timeout/retry evidence, two postings, separate instructions, unknown execution, invalid parties/journals, conflicting links, independence from scenario labels, and truthful causal presentation. Functions: `evidenceSnapshot`, `analyzeSnapshot`, `relatedPayments` in `frontend/src/portals/intelliops/investigation/analysis.js:10`, `:25`, `:68`, and helpers in `presentation.js:2`, `:47`, `:69`. This does not make the AI module or browser flow COMPLETE.

Verified structural results: all backend Python files parsed; `main.app` imported with a process-local in-memory SQLite URL; OpenAPI generated; the six migration revisions form a linear chain; JavaScript relative import paths resolved to repository files. These establish structural integrity, not API business correctness or deployed schema readiness.

Substantial implemented source remains unverified:

- Payments: `create_payment` (`backend/modules/payment_processing/service.py:44`) validates parties, account status, currency, funds and request fingerprints; locks overlapping accounts in deterministic order; creates source instructions and processing events. `submit` (`api.py:59`) wraps changes transactionally and handles replay/conflicts and posting rollback.
- Ledger: `post_normal_journal` (`backend/modules/core_banking/service.py:53`) checks exact parties, amounts, currency, linked transaction and journal balance before posting. `valid_journals`, `account_query`, `account_balance` (`:22`, `:38`, `:82`) exclude invalid journals from account balances.
- Case processing: `detect` (`backend/modules/intelliops/detection.py:12`), `case_detail`, `add_note`, `close_case` (`service.py:30`, `:51`, `:126`) supply source evidence and durable actions.
- Controlled corrections: `remediate_exception` (`backend/modules/intelliops/resolution.py:65`) implements four direct policies and durable outcome records. These are genuine SQL operations in source, not merely UI status updates.
- Shared frontend integration: `loadBackendSnapshot`, `refreshBackend`, case/payment mutation wrappers (`frontend/src/shared/data/bankingRecords.js:76`, `:117`, `:97`, `:134`) publish updates through `useSyncExternalStore`.

## Section 4 — Partially Implemented Features

### 4.1 Detection and monitoring

Five conditions exist: duplicate, FAILED payment, missing posting, amount mismatch, unmatched reference. Running detection automatically creates cases, action history and audit rows; triggering is manual HTTP/UI only. No scheduler, workflow task source, approval rule, or pending processing-timeout rule exists. `DetectionRule.enabled` is honored when a matching row exists; rules still execute when none exists, and the model's `threshold` is not consumed (`detection.py:24`, `:50`).

Deduplication is stronger than just UI filtering: a partial unique detection index protects active cases. However, `detect` also suppresses any detection key found in resolved/closed cases (`detection.py:22`, `:54`), so a recurring fault of the same type on the same transaction cannot create a new occurrence. Define recurrence semantics and add explicit tests before claiming continuous monitoring.

The scan loads all transactions, journals, entries, legacy postings and cases, then repeatedly filters them in Python. Snapshot/UI reads similarly load whole datasets. This is a scale limitation, not a measured performance failure.

There is also a source-visible detection blind spot: a correctly referenced linked journal that is Draft, unbalanced, or otherwise excluded by `valid_journals()` prevents the absence-based Missing Ledger Posting rule, but contributes nothing to `matched_valid`, so the amount comparison does not run when no valid journal remains (`detection.py:35`, `:42`, `:44`). With no legacy posting or other triggering condition, this completed payment can have no valid balance effect and still receive no ledger exception. This path was not runtime-tested; add explicit invalid/incomplete-posting detection and regression coverage rather than treating any linked journal as sufficient evidence.

Next: preserve existing rules, add task/approval/timeout evidence and recurrence semantics, then an idempotent scheduled/manual scan service with bounded queries.

### 4.2 Case lifecycle and Exception Center

Cases support OPEN → IN_REVIEW via notes, RESOLVED via correction, CLOSED via closure. Severity, timestamps, resolution summary, source evidence and timelines persist. Missing: assignment, escalation routing, SLA deadlines/breaches, smart tabs, search/filtering, case metrics, pending approval/execution/verification lifecycle. The case table renders every snapshot case without those controls (`frontend/src/portals/intelliops/ExceptionRecords.jsx:52`).

Next: extend existing case schema/services and list APIs; avoid replacing the working case ID and source-reference conventions.

### 4.3 Corrective policies and financial safeguards

Normal payments lock accounts. Corrective paths lock the case (`backend/modules/intelliops/service.py:22`) but do not take matching account locks. `context` checks account existence/currency, not status/funds. Only payment retry checks Active status and available funds (`resolution.py:128`). Missing-posting and mismatch branches can debit without those current checks. Concurrent remediations or payment/remediation overlap therefore require PostgreSQL tests and shared locking/revalidation. This is a source-supported risk; no concurrency exploit was executed.

Mismatch recovery computes a positive difference against aggregate valid debit totals. It rejects zero/negative differences and does not repair over-postings, wrong parties, currency discrepancies, or legacy single-sided postings as a general reconciliation workflow (`resolution.py:90`). Missing reference enrichment is unsupported. Duplicate containment checks an original instruction link but does not comprehensively revalidate current journals or the original's execution state before rejection (`resolution.py:110`). Retry is a single payment correction, not a task/batch workflow with bounded attempts and transient-error policy.

Cases are marked RESOLVED inside the correction transaction (`resolution.py:58`, `:85`). There is no independent post-action verification result. `close_case` only requires RESOLVED. Next: reuse these executors behind policy and durable workflow/verification services.

### 4.4 Retry and refresh boundary — BROKEN integration

`remediateException` builds `case-resolution-${caseId}-${crypto.randomUUID()}` for every call (`frontend/src/shared/data/bankingRecords.js:143`). Backend `replayed` accepts a resolved case only under its original key; a different key produces 409 (`backend/modules/intelliops/resolution.py:47`).

Deterministic failure sequence: POST commits; response or subsequent `refreshBackend()` fails; frontend reports failure and may retain an OPEN snapshot; user retries; frontend sends a different key; backend rejects the already-completed correction. The second attempt cannot recover the first result through the existing replay contract. This is an incompatible interface established by source; the network-loss scenario was not browser-executed. Preserve one operation key until outcome is reconciled and distinguish committed mutation from failed refresh. Payment creation already retains a form key across unchanged submissions (`CreatePaymentForm.jsx:22`) and offers a useful pattern.

### 4.5 Audit and accountability

Success events exist for payment/scenario/batch generation, detection, notes, correction and closure. Actors are only ADMIN/ANALYST strings; no user identity, approver, decision or run can be reconstructed. Audit models are described as append-only but have no database immutability control. The frontend shows reference/action/actor/time, not filtering or structured details. Snapshot audit history is capped at 500 (`backend/modules/core_banking/snapshot.py:70`); the separate audit API is unpaginated (`payment_processing/api.py:144`).

`submit` records a normal posting ValueError rollback; many validation failures, authorization denials, remediation guard failures and read activity have no durable audit event. No claim of complete audit coverage is justified. Next: define auditable outcomes and add identity/run/approval/verification linkage, paging and failure events without leaking credentials.

### 4.6 Authentication, environment and deployment

Backend role resolution uses configured bearer tokens and constant-time equality. Both roles can read, create normal payments, detect, note and close; ADMIN alone injects the main fault scenarios and remediates. No APPROVER role, token expiry, session revocation, identity provider or distinct user attribution exists. Equal configured tokens resolve to ADMIN because ADMIN is checked first; examples request distinct tokens but startup does not enforce this (`backend/shared/security.py:12`).

All banking/core routes have bearer dependencies; the legacy `/demo/transactions` creation endpoint only requires either role, unlike the main ADMIN-only scenario endpoint (`backend/modules/payment_processing/router.py:9`, `:11`). Whether to retain that weaker legacy demo action should be explicit.

`.env` files are ignored, examples contain placeholders, and no provider secret is required for the current prototype. `DATABASE_URL` is required at import; invalid clock/reconciliation configuration is not centrally validated. There is no runtime synthetic-environment gate or restriction of scenario endpoints to a demo deployment. CORS middleware is absent: Vite's same-origin `/backend` development proxy can work, but a different-origin production frontend requires deployment/CORS configuration. No production reverse proxy is provided in this tree; the dev proxy alone does not configure static hosting. DB transport security, least-privilege grants, backups and actual data provenance remain UNKNOWN.

## Section 5 — Mocked or Hardcoded Features

| Feature | Evidence | Actual behavior and limit |
|---|---|---|
| Default banking dataset | `frontend/src/shared/data/bankingRecords.js:6`, `:13`, `:58` | Fictional customer/account arrays and two starting transfers; localStorage persistence, not SQL persistence. |
| Local processing/detection | `frontend/src/shared/data/paymentSimulation.js:1`; `bankingRecords.js:97`, `:120` | Implements synthetic rules locally when not connected. Local role selection has no server authority. |
| Investigation stages | `frontend/src/portals/intelliops/investigation/service.js:29`, `:46` | 420 ms pauses and deterministic snapshot analysis; no live tools, agents or LLM. |
| Investigation explanations and risk | `frontend/src/portals/intelliops/investigation/analysis.js:68`, `:100` | Evidence-dependent branches with authored text, action codes and fixed risk consideration. Not arbitrary fake answers, but also not AI-generated analysis. |
| Investigation persistence | `frontend/src/portals/intelliops/investigation/service.js:3`, `:19` | Runs, reports, evidence and handoffs in sessionStorage. Interrupted runs become FAILED after reload. No server durability or cross-user visibility. |
| Development fixtures | `frontend/src/portals/intelliops/investigation/fixtures.js:1` | Isolated examples for prevented duplication, double posting, separate instructions and unknown execution; not injected into shared banking data. |
| Resolution handoff | `frontend/src/portals/intelliops/investigation/ResolutionHandoff.jsx:8` | Displays matching case/investigation receipt and JSON; explicitly says planner/policy are disconnected. No execution. |
| Overview/approvals/analytics/settings/default workflows | `frontend/src/app/PortalPage.jsx:17`; `frontend/src/portals/intelliops/IntelliOpsPage.jsx:24` | Shared welcome/shortcut preview; no module-specific operational controls. |
| Global account/notifications/status | `frontend/src/app/App.jsx:52`, `:53`, `:62` | Demo initials, no-notifications placeholder and fixed local-simulation sidebar messaging; can contradict connected source-page mode. |

**Dashboard metrics:** no fabricated operational success/SLA dashboard numbers were found in the implemented overview, because it is a preview. Payment and account summary numbers are computed from the current shared dataset (`TransactionsPage.jsx:44`, `Accounts.jsx:37`), which is DB-backed only in connected mode. Do not label these counts as hardcoded or as complete operational analytics.

**Placeholder API integration:** investigation's adapter comment explicitly calls for future FastAPI start/status/report calls (`investigation/service.js:31`). It currently issues none. No active banking API client call to a nonexistent endpoint was found; the important gap is absent integration, not a fabricated 404 claim.

## Section 6 — Missing Features

- **Synthetic workflow source:** workflow definitions, instances, tasks, task events, missing approvals, transient/permanent task failures and retry history. `backend/modules/workflow/` is reserved only.
- **Detection:** pending processing timeouts, workflow failure/missing approval rules, unattended scheduling and configurable business thresholds. Existing FAILED-payment detection is not workflow failure detection.
- **Exception Center:** smart tabs, case search/filtering, workload metrics, SLA calculation, assignment, escalation and attention flags.
- **Investigation:** backend API, LLM/provider integration, durable reports/evidence references, server error/retry tracking, supported analysis of non-duplicate cases.
- **Resolution:** reusable workflow definitions/versions, plan matching, workflow runs/steps, durable policy decisions, approval pause/resume, dry runs, missing-reference enrichment, true failed-batch/task retries, independent verification, failure escalation/recovery.
- **Approval Center:** approval request generation, list/detail, authorized approve/reject, decision history, case/run linkage, expiry, pre-execution revalidation and separation of duties.
- **Analytics:** operational overview APIs/charts; workflow counts, verified success rate, resolution times, SLA performance.
- **Security/operations:** actual user identity and APPROVER permissions, runtime demo isolation, configuration validation, durable denied-action audit coverage, explicit deployment setup and consistent connected-mode status. No CI/deployment configuration or lint/type-check script was found in the tracked inventory.

## Section 7 — Frontend–Backend Integration Matrix

In connected mode, reads generally use **one full snapshot**, not each specialized read API. The snapshot is fetched at startup and after this tab's mutations; no polling/subscription refreshes it for another operator's changes. All paths below are actual registered paths unless marked absent.

| Frontend Feature | API Endpoint | Backend Handler | Database | Integration Status | Missing Work |
|---|---|---|---|---|---|
| Initial token connection / all source pages | GET `/api/banking-snapshot` | `core_banking/snapshot.py:30 banking_snapshot` | Customers/accounts/payments/journals/entries/events/cases/audit | IMPLEMENTED — NOT VERIFIED; `main.jsx:11` → `fetchBankingSnapshot` → `loadBackendSnapshot` → subscribers | Successful browser execution, freshness/scaling |
| Accounts search/filter/sort/detail/history | GET `/api/banking-snapshot` | Same; `account_query` | Account/Customer/valid journal entries | IMPLEMENTED — NOT VERIFIED; `Accounts` → shared store → client filtering → drawer | Specialized paging APIs exist but UI does not use them |
| Account specialized API | GET `/api/accounts`, `/api/accounts/{account_id}`, `/api/accounts/{account_id}/ledger-entries`, `/api/customers` | `core_banking/router.py:21`, `:47`, `:56`, `:72` | Account/Customer/Journal/Entry | Backend-only direct read endpoints; UI uses snapshot instead | Decide when to adopt at scale |
| Transactions list/filter/details/events/related | GET `/api/banking-snapshot` | Snapshot → `payment_dtos`, `case_dtos` | Transaction/Instruction/Event/Journal/Case | IMPLEMENTED — NOT VERIFIED; `TransactionsPage`/`TransactionDetailsDrawer` read shared store | Server paging/filter adoption; cross-user refresh |
| Payment specialized read API | GET `/api/payments`, `/api/payments/{payment_id}`, `/api/payments/{payment_id}/events`, `/api/payments/{payment_id}/related` | `payment_processing/api.py:28`, `:107`, `:112`, `:120` | Same | Backend endpoints, tested in source tests but not used for main UI reads | Current execution verification |
| Create normal payment | POST `/api/payments` | `post_payment` → `submit` → `create_payment` | Transaction/Instruction/Event/Journal/Entry/Audit | IMPLEMENTED — NOT VERIFIED; form → `createSyntheticPayment` → `paymentRequest` → commit → snapshot refresh → drawer | Run build, API and connected tests |
| Generate individual fault scenario | POST `/api/demo/payments/scenario` | `post_scenario` → same service | Same, deliberate discrepancy | IMPLEMENTED — NOT VERIFIED; ADMIN form → refresh | Runtime demo gate; UNMATCHED UI not selectable |
| Generate exception batch | POST `/api/demo/exception-batches` | `post_exception_batch` → `create_exception_batch` | Batch/Items/source records/audit | IMPLEMENTED — NOT VERIFIED; form → `createExceptionBatch` → refresh | Request-level batch idempotency, batch recovery/history |
| Run detection | POST `/api/detection/run` | `run_detection` → `detect` | ExceptionCase/Action/Audit | IMPLEMENTED — NOT VERIFIED; case/payment button → `runPaymentDetection` → refresh | Scheduling and missing rules |
| Exceptions list | GET `/api/banking-snapshot`; GET `/api/exceptions` also exists | Snapshot / `list_exceptions` → `case_dtos` | Case/Transaction | IMPLEMENTED — NOT VERIFIED; table consumes snapshot, not list endpoint | Filter/paging/smart tabs/SLA |
| Open case details | GET `/api/exceptions/{case_id}` | `exception_detail` → `get_case` / `case_detail` | Case/Action/Resolution/Journal | IMPLEMENTED — NOT VERIFIED; URL → `fetchExceptionCase` → local detail state | Stale/failed detail presentation |
| Add note | POST `/api/exceptions/{case_id}/notes` | `note` → `add_note` | Case/Action/Audit | IMPLEMENTED — NOT VERIFIED; `perform` → `addExceptionNote` → commit → refresh/detail | Distinct operator identity |
| Correct case | POST `/api/exceptions/{case_id}/remediate` | `remediate` → `remediate_exception` | Resolution or Remediation + source effects/action/audit | PARTIAL; direct ADMIN action; retry interface BROKEN | Stable replay key, policy/approval/verification |
| Close case | POST `/api/exceptions/{case_id}/close` | `close` → `close_case` | Case/Action/Audit | IMPLEMENTED — NOT VERIFIED within existing RESOLVED-only contract | Require independent verified result |
| Open/run investigation/history | No investigation HTTP endpoint | Browser `startInvestigation` → `evidenceSnapshot` / `analyzeSnapshot` | Browser session only | MOCK / SIMULATED; backend source can supply input, but run is local | Durable backend service/LLM/error state |
| Send to Resolution Workflows | No workflow HTTP endpoint | Browser `sendToResolution` → session handoff → `ResolutionHandoff` | None | MOCK / SIMULATED; case + INV IDs remain local | Plan/run API, IDs, policy decision |
| Approval list/approve/reject/resume | No approval endpoints | Generic preview | None | NOT IMPLEMENTED | Complete approval contract and backend/UI |
| Verify outcome / escalate | No verification/escalation endpoints | Immediate `finish` is not verification | No verification entity | NOT IMPLEMENTED | Evidence-based result and guarded closure |
| Audit list | GET `/api/banking-snapshot`; GET `/api/audit-events` also exists | Snapshot / `audit_events` | AuditEvent | IMPLEMENTED — NOT VERIFIED; `ExceptionRecords audit` reads shared snapshot | Filters, details, history beyond 500, run/decision links |
| Overview/Analytics/Settings | No corresponding feature APIs | `IntelliOpsPage` preview | None | NOT IMPLEMENTED | Implement actual modules |
| Legacy demo/list | POST `/demo/transactions`; GET `/transactions` | `payment_processing/router.py:12`, `:42` | Transaction/Audit | Backend only; direct SessionLocal | Decide retention, align demo authorization and normalized ownership |

Cross-page identifiers: `CASE-000001` maps to an integer case PK; `transactionId` maps to public `TXN-*`; `PaymentInstruction.payment_id` is a UUID, including the original instruction self-link. Frontend `relatedPayments` resolves the original UUID or detected public reference (`analysis.js:10`). Journals use public `JRN-*` in frontend links and UUID PKs internally; journal detail API accepts either. Remediation detail links a persisted journal reference. These are deliberate conversions, not inherently inconsistent IDs.

`INV-*` identifiers are generated in the browser and never recorded in SQL. Handoffs validate matching case/investigation query parameters but do not validate freshness, current backend ownership, policy or authorization. No Workflow Run ID or Approval ID exists anywhere in the actual chain. Evidence references in a handoff are session-copied payment/event/journal IDs, not durable workflow evidence associations.

The backend snapshot uses several queries without explicitly requesting a repeatable-read transaction; its “one consistent read snapshot” docstring should not be treated as proof of PostgreSQL point-in-time consistency under concurrent commits. Cross-page same-tab state is shared; cross-user/current-source consistency remains unverified.

## Section 8 — End-to-End Workflow Audit

### Scenario A: Duplicate Transaction

| Stage | Actual path | Audit result |
|---|---|---|
| Detection | ADMIN DUPLICATE scenario makes an original normal payment and held duplicate sharing business reference; manual scan creates case | IMPLEMENTED — NOT VERIFIED; backend test assertions exist, did not execute |
| Exception Center | Snapshot case → CASE query parameter → details | IMPLEMENTED — NOT VERIFIED |
| Investigation | Source links/events/journals → deterministic `analyzeSnapshot` | MOCK / SIMULATED as a user flow; 12 helper tests passed |
| Proposed resolution | Authored evidence-based action code; sessionStorage handoff | MOCK / SIMULATED |
| Human approval | Approval Center preview | NOT IMPLEMENTED |
| Authorized containment | Direct ADMIN `/remediate` rejects duplicate if original link exists | PARTIAL; bypasses proposed workflow/approval chain |
| Verification | Case becomes RESOLVED immediately, no separate check/result | NOT IMPLEMENTED |
| Audit | Detection/correction/case timeline persisted in service code | PARTIAL overall; no investigation/approval/run/verification audit linkage |

The simulator does not emit ACK_TIMEOUT/RETRY_SUBMITTED correlation. Real shared duplicate cases therefore cannot legitimately acquire that specific causal diagnosis from the current source; fixtures can supply it. The analyzer deliberately leaves cause unknown without evidence (`analysis.js:88`). Do not demonstrate a fixture cause as a backend-discovered cause.

### Scenario B: Reconciliation Mismatch

| Stage | Actual path | Audit result |
|---|---|---|
| Detection | Completed payment with internally balanced posting 0.01 short; after cutoff compares debit totals | IMPLEMENTED — NOT VERIFIED |
| Investigation | AI route explicitly supports duplicate cases only | NOT IMPLEMENTED for mismatch; manual case evidence review exists |
| Eligible correction | ADMIN direct action recomputes positive shortfall | PARTIAL; lacks workflow policy/approval and full current-party/account checks |
| Execution | New balanced adjustment journal + ExceptionResolution + case actions/audit | IMPLEMENTED — NOT VERIFIED within positive-shortfall branch |
| Verification | No fresh independent check or saved result; immediately resolves | NOT IMPLEMENTED |
| Closure | Analyst/admin may close a RESOLVED case | IMPLEMENTED — NOT VERIFIED within existing contract; verified closure chain PARTIAL |

Over-posted and unmatched-reference cases do not have a general correction path. A balanced adjustment journal alone is not proof of successful full reconciliation.

### Scenario C: Failed Workflow

| Stage | Actual path | Audit result |
|---|---|---|
| Source failure | Workflow simulator/task records absent | NOT IMPLEMENTED |
| Detection | FAILED payment detection exists; no workflow/task rule | NOT IMPLEMENTED for requested workflow scenario |
| Investigation | Non-duplicate types unsupported | NOT IMPLEMENTED |
| Attempted correction | Direct failed-payment retry exists, not failed workflow/batch retry | PARTIAL adjacent capability only |
| Verification failure | No verifier or persisted failed verification | NOT IMPLEMENTED |
| Escalation | HTTP guard errors return to caller, no escalation state/event/routing | NOT IMPLEMENTED |

No successful failed-workflow recovery can be claimed. The existing connected Playwright test targets payment failure → direct retry → close, not task workflow → failed verification → escalation (`frontend/tests-connected/payment-api.spec.js:40`). It was NOT RUN.

## Section 9 — Database Audit

The imported ORM metadata contains **16 domain tables**. Actual database contents/revision were not queried.

| Table | Model / source | Key relationships and purpose |
|---|---|---|
| transactions | Transaction, `backend/modules/payment_processing/models.py:11` | Integer PK, unique public reference, shared business payment_reference; source status/amount |
| processing_events | ProcessingEvent, same `:31` | FK transaction; ordered processing evidence |
| payment_instructions | PaymentInstruction, same `:47` | Unique transaction FK and idempotency key, UUID PK, sender/receiver account FKs, original instruction self-FK |
| exception_batches | ExceptionBatch, same `:65` | UUID batch, requested scenario JSON, role/status/times |
| exception_batch_items | ExceptionBatchItem, same `:76` | Batch FK, unique transaction FK, scenario and sequence |
| ledger_records | LedgerRecord, `backend/modules/core_banking/models.py:11` | Legacy single-sided amount/transaction FK; distinct from balanced journals |
| customers | Customer, same `:26` | UUID and unique reference; classification check/composite ownership key |
| accounts | Account, same `:40` | UUID/reference; composite owner/type FK, ownership/product checks, opening balance |
| ledger_journals | LedgerJournal, same `:59` | UUID/reference; source transaction FK; unique nullable normal transaction FK; logical payment reference |
| ledger_entries | LedgerEntry, same `:73` | Account/journal FKs; positive amount and Debit/Credit checks |
| detection_rules | DetectionRule, `backend/modules/intelliops/models.py:11` | Rule name/type/threshold/enabled; nullable rule FK from cases |
| exceptions | ExceptionCase, same `:25` | Transaction/rule FKs, JSON evidence, partial unique active detection key, lifecycle times |
| exception_case_actions | ExceptionCaseAction, same `:55` | Case FK, action/actor/details/time |
| ledger_posting_remediations | LedgerPostingRemediation, same `:67` | Unique case/journal/key; missing-posting outcome |
| exception_resolutions | ExceptionResolution, same `:80` | Unique case/key; optional unique corrective journal; other correction outcomes |
| audit_events | AuditEvent, same `:95` | Generic action/role/reference/JSON/time; no typed case/run/approval FK |

Migration coverage is linear: `20261103_01` creates original tables if missing plus ownership/ledger tables; `_02` adds instructions, event fields, source journal links, detection key/index and audit; `_03` adds lifecycle/action/missing-ledger remediation; `_04` adds other resolutions; `_05` adds batches/items; `_06` adds unique normal-posting transaction link and journal created time. Paths: `backend/alembic/versions/20261103_*.py`. Static chain verified; actual upgrades/model-schema parity NOT VERIFIED because Alembic cannot import. The existing `MigrationTests` uses an isolated database and preservation assertions (`backend/tests/test_accounts.py:154`), but did not execute.

Missing entities: workflow definitions/instances/tasks/events/runs/steps, investigation reports/evidence associations, approvals/decisions, verification results, user identity, policy decisions, assignment/SLA/escalation. README Section 11 is expressly a proposed logical schema (`README.md:516`), not the current physical schema.

Persistence and consistency risks:

- Local banking records and session investigation history do not become SQL rows when browsing other pages; investigation remains session-only even in connected mode.
- Legacy generator creates no PaymentInstruction/account ownership. Automatic remediation refuses cases lacking instructions (`resolution.py:17`). It also creates TIMEOUT/PENDING records the current detector does not flag. Its single-sided LedgerRecord entries do not drive modern account balances.
- `generate_data.py:46` still calls `create_all`, outside migration history, while app startup correctly does not create tables. Do not mix generation/seed paths without deciding source dataset and migration order.
- Journal balance/currency/party invariants are mostly service/read validation, not cross-row DB constraints. Only normal journal linkage is unique per transaction; corrective journal linkage permits multiple source journals by design.
- Two outcome tables each enforce their own idempotency uniqueness; the service checks both, but there is no cross-table database uniqueness constraint.
- Corrective case locks do not serialize all account writers; snapshot multi-query consistency and PostgreSQL concurrent detection/retry behavior remain unverified.
- Migration `_06` supplies created_at with the migration server time for existing journals, which is not original historical creation time. Model client defaults and migration server defaults are not proof of semantic timestamp parity.
- Audit append-only intent is not a DB access restriction. Actual grants, migration revision, dataset provenance and backup/restore controls are UNKNOWN.

## Section 10 — Test Results

Checks were run without dependency installation, live database access, seeds, migrations, source changes, or environment-file changes. Python checks used `-B` to avoid bytecode artifacts. Test isolation was inspected before execution: `test_accounts.py:2` forces an in-memory URL and uses a separate StaticPool database; the connected fixture also uses isolated memory, but could not be launched with the current dependencies/configuration.

| Command / check | Working directory | Result |
|---|---|---|
| `git status --short` | root | Baseline: only `README.md` already modified; preserved |
| `python --version`; `node --version` | root | Python 3.13.3; Node v24.15.0 |
| `npm.cmd test` in sandbox | frontend | Exit 1; all five test-file workers blocked by `spawn EPERM`; no assertion result |
| `npm.cmd test` rerun outside sandbox after approval | frontend | Exit 1; **12 passed, 4 failed test-file loads, 0 skipped, 0 cancelled**; four files cannot import React |
| `npm.cmd run build` | frontend | Exit 1; `vite` not recognized; no bundle produced |
| `python -B -m unittest discover -s tests -v` | backend | Exit 1; two failed module imports (`test_accounts`, `test_payments`), `cannot import name 'command' from 'alembic'`; 0 actual business test methods executed |
| `python -B -m pip show fastapi SQLAlchemy python-dotenv psycopg2-binary Faker alembic httpx uvicorn` | root | FastAPI 0.135.1, SQLAlchemy 2.0.36, dotenv 1.2.2, httpx 0.28.0, uvicorn 0.41.0 present; **Faker, Alembic, psycopg2-binary absent** |
| AST parse all backend `.py` using `ast.parse` | backend | PASS; syntax only |
| Process-local `DATABASE_URL=sqlite:///:memory:`; import `main.app`; inspect routes and ORM metadata | backend | PASS; no connection/DDL; 16 domain tables, routes registered |
| `app.openapi()` under same isolated process config | backend | PASS; 24 application paths generated; no business request executed |
| AST inspect migration revision/down_revision values | backend | PASS; six linear revisions, one head `_06`; no migration executed |
| Static resolve relative `.js`/`.jsx` import paths | root | PASS; no unresolved local import target found; external dependency loading/build remains blocked |
| Tracked file inventory | root | 103 tracked files at baseline; no AGENTS.md found in workspace scan |

The 12 passing tests belong to `frontend/src/portals/intelliops/investigation/analysis.test.js`. The four load failures are `accountFilters.test.js`, `banking.test.js`, `bankingRecords.test.js`, `paymentSimulation.test.js`, all reaching an unavailable React import through the shared banking module. These are **environment/dependency failures**, not 4 proven incorrect business assertions. The initial 5 EPERM failures are a separate attempt and must not be added to final assertion counts.

Backend contains 21 test methods across accounts/migration/payment suites. Their intended coverage includes ownership checks, journal balance calculations, seed preservation, migration legacy-row preservation, payment validation and rollback, detection cutoff/deduplication, authentication, remediation replay/late-arrival guard and other correction policies. None can be counted as passing today.

NOT RUN:

- `npm.cmd run test:e2e`: node_modules/Playwright unavailable; no browser environment validated. Five local spec files target simulated flows, drawers, navigation and investigation fixtures, not proof of PostgreSQL operations.
- `npm.cmd run test:connected`: dependencies absent and configured executable `backend/venv/Scripts/python.exe` does not exist. One connected spec uses an in-memory migrated FastAPI fixture. No PostgreSQL coverage is implied even when this spec passes.
- Lint/type-check: no configured scripts, ESLint/TypeScript config or tool dependencies found. Static path checks do not substitute for a Vite build.
- Alembic upgrades/autogenerate/schema parity, database health queries, seeds, data generation, deployed route probes and PostgreSQL concurrency: not run; dependencies missing and existing database deliberately untouched.
- LLM calls, approval/resumption and verification scenarios: no implementation to exercise.

Missing dependencies were reported in chat; none installed. Historical check counts in `backend/PAYMENTS.md`, `backend/NORMAL_LEDGER_REPORT.md`, migration reports and frontend READMEs do not replace the above execution results. Some historical commands mention pytest although requirements-dev lists httpx only; this audit used the actual unittest suites.

## Section 11 — Prioritized Implementation Roadmap

The standalone [DEVELOPMENT_ROADMAP.md](DEVELOPMENT_ROADMAP.md) expands these tasks. No task was implemented during this audit.

| ID / priority | Task | Affected files/modules | Dependencies | Acceptance criteria | Complexity |
|---|---|---|---|---|---|
| P0-1 | Restore reproducible verification | Requirements, package manifests, Playwright configs, docs | Dependency installation reported first; suitable local environment | Frontend build/unit tests and backend 21 methods run; connected suite uses available Python; record actual results | Small |
| P0-2 | Strengthen correction safety and retry recovery | `intelliops/resolution.py`, `core_banking/service.py`, `bankingRecords.js`, case UI | P0-1 | Account locks/current parties/status/funds checked; uncertain response reuses key; concurrent corrections cannot overspend or double-post | Large |
| P0-3 | Implement durable source workflow and resolution execution | `modules/workflow/`, IntelliOps models/services/routes, Alembic, workflow UI | P0-1, P0-2 | Failed source task creates case; versioned plan/run/step records invoke existing controlled executors idempotently | Large |
| P0-4 | Implement approval gate and resume | Security, approval models/routes/UI, run service | P0-3 | Required actions cannot execute without matching authorized decision; approve/reject/history; stale/repeated resume safe | Large |
| P0-5 | Implement verification and failure escalation | Verification service/models, case closure, run engine, audit UI | P0-3; P0-4 for restricted actions | Fresh persisted verification governs resolution/closure; failure leaves unresolved case, records reason and escalation | Large |
| P1-1 | Persist investigations and connect actual AI | Investigation backend/API, provider config, frontend adapter | P0-1, stable source/case IDs | Server report survives browser loss; constrained evidence-based output; provider failure recorded; no action authorization from LLM | Large |
| P1-2 | Close named policy coverage gaps | Detection/resolution/workflow modules, form/UI, tests | P0-2 through P0-5 | Reference enrichment and true failed task/batch retry supported; mismatch overposting unsafe cases routed explicitly | Large |
| P1-3 | Add missing detection and reliable triggering | DetectionRule, detector, workflow source, scheduler | P0-3, P0-4 for approval evidence | Timeout/missing approval/task failure rules; repeat/recurrence tests; scheduled/manual deduplication | Medium |
| P1-4 | Complete Exception Center lifecycle UX | Cases schemas/routes/models, ExceptionRecords | P0-3 through P0-5 | Smart tabs/filter/search, assignment/escalation, SLA and valid cross-page IDs | Large |
| P1-5 | Extend identity, isolation and audit | Security/config, AuditEvent, all mutations, audit UI | P0-4; migration support | Unique actors, role separation, demo endpoint environment gate, durable important failures and run/approval/verification links | Large |
| P2-1 | Implement overview/analytics | New aggregate services/routes, overview/analytics UI | Verified lifecycle and timestamps | Charts match DB aggregates; verified success and SLA denominators defined/tested | Medium |
| P2-2 | Bound reads and improve freshness | Snapshot/read APIs, store, list UIs | Stable API contracts | Paging/filter endpoints adopted where needed; concurrent updates become visible; consistency expectations documented/tested | Medium |
| P2-3 | Reconcile documentation/data paths/deployment | README, module docs, generators, Vite/hosting setup | P0-1 and chosen deployment/data mode | Distinguish blueprint/current API; safe seed/generator order; same-origin API and SPA deep links work | Medium |
| P3-1 | Polish operator experience | App shell, notifications, accessibility/responsiveness | Functional module data | Connected status truthful; real notification events; keyboard/mobile checks pass | Small |
| P3-2 | Optional enhanced reporting/simulation | Workflow planner, audit exports, analytics | Core verified lifecycle | Dry-run cannot mutate source; exports reflect persisted records and authorization | Medium |

## Section 12 — Recommended Development Order

1. Recreate the declared development environment and establish a passing baseline without rewriting working services. Resolve missing dependencies and test-launch paths first; record actual checks.
2. Repair remediation replay/refresh handling and reuse normal-payment account validation/locking for correction executors. Add meaningful PostgreSQL concurrency coverage before introducing more automated writers.
3. Build the missing source task simulator and durable resolution plan/run/step contract. Start with one failed-task recovery; retain existing CASE/TXN/JRN conventions and reuse controlled payment/ledger corrections where appropriate.
4. Add approval authorization, persisted decisions and safe resume. Add independent verification and guarded closure immediately afterward; the first end-to-end acceptance must include rejection, stale evidence and verification failure/escalation.
5. Replace the browser investigation adapter with persisted APIs and an optional constrained LLM integration. Retain the tested deterministic evidence checks as safeguards; support more exception types incrementally.
6. Extend missing rules/policies, case management and audit coverage. Then build analytics from verified lifecycle data, optimize reads and finish deployment/UX polish.

P0-2 through P0-5 are the core five technical capabilities when counting verification baseline separately: safe corrections, durable workflows, approvals, verification/escalation and durable investigation. The first five roadmap tasks are ordered for immediate execution, with environment restoration included because current checks are blocked.

## Section 13 — Final Summary

1. **Done:** real source exists for synthetic payments, balanced ledger/account reads, five detection conditions, case evidence/notes/closure, four direct remediation policies and audit records. Twelve deterministic investigation helper tests passed. Most backend business capabilities remain IMPLEMENTED — NOT VERIFIED.
2. **Partially done:** case lifecycle, correction safety/coverage, audit completeness, role security and cross-page snapshot integration. Direct corrections exist but do not constitute approval-controlled resolution workflows.
3. **Missing:** workflow source/tasks and durable run engine, actual AI/backend investigation, approvals and resume, independent verification and escalation, SLA/assignment, operational dashboards and analytics.
4. **Broken:** remediation retry keys conflict with backend replay; build/test execution is blocked by absent frontend/Python dependencies; connected test configuration points to a missing virtual environment. The dependency failures are not proven source assertion failures. No unresolved relative frontend import or backend app import defect was observed.
5. **Five next tasks:** (1) restore verification baseline; (2) fix corrective locking/revalidation and replay recovery; (3) implement durable source/resolution workflows; (4) add approval gating/resumption; (5) implement verification-driven closure and failure escalation. Durable AI investigation follows the core execution controls.

Audit coverage included the tracked root docs/configuration; backend entrypoint/compatibility exports, all domain model/schema/router/service modules, shared security/database/timestamps, generator/seed and fixture data, six migrations and tests; frontend entrypoint/shell/routing, all portal pages, shared data/API/components, investigation adapter/analysis/presentation/fixtures, unit/browser/connected specs, CSS/HTML and build/test/environment configuration. No deployment artifacts or hidden production systems were assumed. Source inspection and structural checks cannot establish actual deployment state; browser and DB behavior remain explicitly unverified where noted.
