# OCBC IntelliOps — Development Roadmap

Prepared 10 November 2026 (Asia/Singapore), from [PROJECT_AUDIT_REPORT.md](PROJECT_AUDIT_REPORT.md). This is a plan only. Preserve existing payment/ledger/case services and public CASE/TXN/JRN references. Extend them behind explicit policy, approval and verification contracts. Source inspection does not establish passing backend functionality; begin with verification.

## P0 — Critical

### P0-1 — Restore a reproducible verification baseline

- **Task:** recreate declared frontend and Python dependencies, align connected test Python launch with a documented interpreter, and record current checks. Report missing dependencies before installation. Current gaps: frontend node_modules (React, Vite, Playwright), Alembic, Faker, psycopg2-binary; connected config references nonexistent backend/venv.
- **Affected:** `frontend/package.json`, lockfile, Playwright configs; `backend/requirements*.txt`, test setup and setup docs.
- **Dependencies:** suitable local environment and dependency installation; no existing DB reset/seed required for isolated suites.
- **Acceptance:** frontend build succeeds, full unit suite runs without loader failures, all 21 backend methods execute with results recorded, and connected Playwright runs against its isolated in-memory fixture. Keep PostgreSQL concurrency verification separate. Configure lint/type checks only as a deliberate follow-up, not a claimed existing capability.
- **Complexity:** Small.

### P0-2 — Make correction execution and uncertain-response recovery safe

- **Task:** share account locking/current-party/status/currency/funds checks between normal payments and corrective writers; strengthen duplicate state checks; retain one idempotency key per intended remediation; reconcile committed mutations separately from failed snapshot refresh.
- **Affected:** `backend/modules/intelliops/resolution.py`, `service.py`, `core_banking/service.py`; `frontend/src/shared/data/bankingRecords.js`, `ExceptionRecords.jsx`; targeted backend/connected tests.
- **Dependencies:** P0-1. Use disposable PostgreSQL for real lock semantics.
- **Acceptance:** repeated same-key correction returns the persisted outcome; dropped POST response or failed subsequent GET recovers through the same key; different intent conflicts visibly; frozen/closed/underfunded or changed-party evidence blocks execution; concurrent payment/correction and correction/correction cannot overspend or double-post. Rejection preserves source and records a reviewable reason.
- **Complexity:** Large.

### P0-3 — Implement source workflow tasks and durable resolution orchestration

- **Task:** create the missing synthetic source workflow/task/events, then versioned resolution definitions, deterministic eligibility matching, plans/runs/steps and bounded retries. Reuse current controlled executors; distinguish source workflow state from resolution workflow state.
- **Affected:** `backend/modules/workflow/`; IntelliOps models/services/schemas/routes and Alembic revisions; new frontend workflow API/page replacing `IntelliOpsPage`/receipt-only routing.
- **Dependencies:** P0-1, P0-2; stable case/source references.
- **Acceptance:** injected failed source task produces authoritative task/event evidence; detection opens a linked case; a stored plan/run/step invokes an allowed action idempotently; restart/repeated requests cannot repeat financial effects; every state transition is durable/audited. At least one task retry flow is exercised before adding more workflow variants.
- **Complexity:** Large.

### P0-4 — Add approval decisions and safe workflow resumption

- **Task:** persist requests and approve/reject decisions with actor, reason, case/run/action/evidence version and expiry; add APPROVER permissions, separation of duties, pause/resume and current-state policy revalidation. Route restricted direct remediation through the same gate.
- **Affected:** `backend/shared/security.py`; new approval models/routes/services/migrations; workflow engine; direct remediation route; frontend Approval Center/client and workflow links.
- **Dependencies:** P0-3; identity contract supporting distinct decision makers.
- **Acceptance:** a restricted action cannot execute through any API without a valid matching decision; analyst/unauthorized actor rejected; approval history links exact case/run/action; reject and expire prevent execution; repeated approve/resume remains idempotent; source changes after approval trigger revalidation/blocking instead of stale execution.
- **Complexity:** Large.

### P0-5 — Make verification control resolution, closure and escalation

- **Task:** introduce persisted independent post-action checks against fresh source evidence; record passed/failed/unknown outcomes; require passed result before RESOLVED/CLOSED; route failure/uncertainty for human attention with durable events.
- **Affected:** new verification services/models/routes/migrations; `intelliops/resolution.py`, `service.py:close_case`; workflow engine; Exception Center/workflow/audit UIs.
- **Dependencies:** P0-3; P0-4 for restricted execution; P0-2 for source safeguards.
- **Acceptance:** a successful executor alone does not resolve a case; fresh payment/ledger/task checks prove policy-specific outcome; injected verification failure leaves case unresolved, records why and escalation; duplicate verification is safe; closure rejects absent/failed/stale verification. Trace one complete flow including failure handling and audit.
- **Complexity:** Large.

## P1 — High

### P1-1 — Persist investigations and integrate constrained AI

- **Task:** introduce start/status/report APIs, immutable evidence snapshots, structured report persistence and error/retry history; replace browser adapter and add optional provider integration. Retain tested deterministic classification/uncertainty checks. Add non-duplicate support incrementally.
- **Affected:** new backend investigation module/models/routes/provider config and migrations; frontend `investigation/service.js`, `AIInvestigation.jsx`, `ResolutionHandoff.jsx` and API clients.
- **Dependencies:** P0-1 and stable case/source identities; P0-3 contract for handoff into a real plan/run.
- **Acceptance:** reports survive browser/session loss and are access-controlled; real configured provider invocation is observable when enabled; absence/provider failure is explicit; output cites fetched evidence and validates schema; source text cannot invent tool permissions; no LLM output executes or approves actions. Existing 12 evidence tests retain their guarantees. Case, investigation, run and evidence IDs remain consistent.
- **Complexity:** Large.

### P1-2 — Complete named correction policy coverage

- **Task:** specify and implement missing reference enrichment, true failed source task/batch safe retry, and explicit handling/escalation for non-shortfall reconciliation and duplicate financial execution. Add versioned eligibility and dry-run evidence where required.
- **Affected:** workflow/detection/resolution services and definitions, source modules, policy tests, workflow/source UIs.
- **Dependencies:** P0-2 through P0-5; investigation integration for report-driven handoff.
- **Acceptance:** each of the four requested named workflows has a tested trigger, plan, allowed correction, approval rule, idempotency protection, verification and failure route. Unknown reference ownership, over-posting and prior irreversible effects cannot be “fixed” by invented matching or automatic unsafe retry/reversal.
- **Complexity:** Large.

### P1-3 — Expand detection and make monitoring repeatable

- **Task:** add pending timeout, workflow failure, missing approval and invalid/incomplete ledger posting rules; apply configured thresholds; define recurrence after closure; schedule the existing detection service while keeping manual authorized triggers.
- **Affected:** `intelliops/detection.py`, DetectionRule/case schemas, workflow source, scheduler/config and detection tests.
- **Dependencies:** P0-3 and P0-4 provide task/approval evidence.
- **Acceptance:** repeat scans do not duplicate active cases; configured cutoff/threshold affects results; missing approval and failed workflow use authoritative state; a linked Draft/unbalanced/invalid journal cannot silently suppress all ledger exceptions; recurrence behavior is explicit/tested; concurrent scheduled/manual runs produce stable outcomes and auditable failures.
- **Complexity:** Medium.

### P1-4 — Complete case-management integration

- **Task:** add assignment, escalation/attention flags, SLA deadlines and breach calculation, smart tabs, search/filters and lifecycle views; preserve direct case/source deep links.
- **Affected:** ExceptionCase models/schemas/list services/routes/migrations; `ExceptionRecords.jsx`, API/store and navigation.
- **Dependencies:** P0-3 through P0-5 for actual run/approval/verification state; identity for assignment.
- **Acceptance:** smart tabs derive from persisted state; filters compose; SLA handles UTC/SGT boundaries; analyst ownership/escalation is persisted/audited; all pages show matching CASE/INV/run/approval/journal IDs and truthful statuses after mutations and reload.
- **Complexity:** Large.

### P1-5 — Strengthen identity, synthetic isolation and audit completeness

- **Task:** enforce distinct identity/roles, validate demo token/config invariants, gate scenario routes by runtime environment, align legacy demo route permissions, record important denied/failed operational outcomes and link audit to decisions/runs/verifications. Add paginated/filterable audit detail.
- **Affected:** shared security/config, `main.py`, legacy/main payment routes, audit models/services/migrations, all mutation boundaries and Audit Trail UI.
- **Dependencies:** P0-4 identity/approval model; stable run/verification identifiers.
- **Acceptance:** same credential cannot silently confer unintended ADMIN privilege; demo routes disabled outside configured synthetic deployments; secrets excluded from events/errors; distinct actors and decision/action ordering reconstructable; audit failure behavior and immutability/access policy documented/tested; history beyond the latest 500 can be retrieved safely.
- **Complexity:** Large.

## P2 — Medium

### P2-1 — Build database-backed Overview and Analytics

- **Task:** implement case/run/verified-resolution/SLA aggregates and visualizations with explicit definitions and time windows.
- **Affected:** new aggregate APIs/services; actual overview/analytics pages replacing shared preview.
- **Dependencies:** P0-5 and P1-4 supply trustworthy status and timestamps.
- **Acceptance:** fixture-backed aggregates match displayed values; verified success excludes proposal-only or failed verification; SLA denominators and missing-data handling explicit; empty/error states truthful.
- **Complexity:** Medium.

### P2-2 — Bound reads and refresh cross-user state

- **Task:** adopt specialized paginated list/detail APIs where needed, bound detection queries, establish transaction consistency requirements and add refresh/subscription behavior for other operators' changes.
- **Affected:** snapshot/read APIs, detection service, shared store/API, account/payment/case/audit pages.
- **Dependencies:** stable lifecycle/list contracts.
- **Acceptance:** large synthetic datasets avoid unbounded browser snapshots/scans; server filters/paging retain deep links and totals; concurrent source updates become visible; defined evidence snapshot semantics hold under concurrent commits.
- **Complexity:** Medium.

### P2-3 — Reconcile documentation, generation paths and deployment

- **Task:** separate blueprint from current implementation, document current actual endpoints and roles, choose supported legacy/modern seed paths, align test commands and document/build production API routing plus SPA fallback.
- **Affected:** README and module docs, `generate_data.py`, seed tools, Vite/hosting setup and environment examples.
- **Dependencies:** P0-1 and chosen deployment/data mode; verified current contracts.
- **Acceptance:** a fresh synthetic setup can migrate/seed/start/test without conflicting records; existing databases preserved; TIMEOUT labels no longer imply an absent rule; static deployment can reach API and open deep links; documentation distinguishes localStorage/sessionStorage from SQL durability.
- **Complexity:** Medium.

## P3 — Low

### P3-1 — Polish operator status, notifications and accessibility

- **Task:** drive global mode/identity labels and notifications from actual application state; finish responsive/keyboard/error presentations.
- **Affected:** `App.jsx`, shared components/styles, notification integration and browser specs.
- **Dependencies:** working identity/event/module integration.
- **Acceptance:** connected backend no longer shows fixed local-only status; notifications link real records; keyboard focus and mobile overflow checks pass on major flows.
- **Complexity:** Small.

### P3-2 — Add optional dry runs and shareable reporting

- **Task:** add clearly labeled resolution previews and controlled audit/report exports after execution safety is established.
- **Affected:** workflow planner, audit/export APIs and frontend reporting controls.
- **Dependencies:** P0 lifecycle and P1 authorization/audit.
- **Acceptance:** preview cannot mutate source or claim execution; exported report reflects persisted authorized records and exact evidence/run identity.
- **Complexity:** Medium.

## Delivery sequence and gates

1. P0-1 produces a reproducible baseline, not new features.
2. P0-2 secures existing correction executors before orchestration adds writers.
3. P0-3 supplies missing source workflow and persisted execution contracts.
4. P0-4 and P0-5 establish authorized, verified end-to-end outcomes. First acceptance includes a rejected approval, stale-source block and failed verification escalation.
5. P1-1 replaces prototype investigation persistence/analysis boundaries; P1-2 and P1-3 add remaining workflow/rule coverage.
6. P1-4/P1-5 complete operational case/security/audit integration; P2 analytics consumes those trustworthy records; then scale/deployment and P3 polish.

Do not rebuild normal payment posting, journal validation, case notes, source ID conversion or deterministic evidence helpers merely because the broader product is incomplete. Reuse them and verify their integration. Complexity labels describe relative implementation size, not elapsed-time commitments.
