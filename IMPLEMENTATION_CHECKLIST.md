# OCBC IntelliOps — Implementation Checklist

Audit: 10 November 2026 (Asia/Singapore). See [PROJECT_AUDIT_REPORT.md](PROJECT_AUDIT_REPORT.md) for evidence, limitations and test counts. Checked boxes mean successful verification of the exact stated scope; source presence or test existence alone does not qualify.

## Verified scope

- [x] Twelve deterministic investigation analysis/presentation tests pass; this is a browser prototype helper scope, not LLM or end-to-end verification.
- [x] All backend Python source parses successfully.
- [x] Backend app imports with an isolated process-local SQLite URL without database access; OpenAPI generates 24 application paths.
- [x] Six migration revision identifiers form one linear chain; no migration execution implied.
- [x] Relative frontend JavaScript/JSX imports resolve to existing local files; no successful build implied.

## Synthetic banking systems

- [ ] Normal payment creation, validation, balanced posting, event history and fingerprint idempotency — IMPLEMENTED — NOT VERIFIED.
- [ ] Customer/account classification, ownership constraints, ledger-backed balances and linked drawers — IMPLEMENTED — NOT VERIFIED.
- [ ] Individual scenario generation and persisted exception batches — IMPLEMENTED — NOT VERIFIED.
- [ ] Seed idempotence/preservation and legacy migration behavior — IMPLEMENTED — NOT VERIFIED; existing tests did not execute.
- [ ] Default browser banking simulation — MOCK / SIMULATED; remaining banking unit/browser tests blocked by dependencies.
- [ ] Legacy generator integration — PARTIAL; no normalized payment ownership, pending timeout rule or modern account-balance linkage.
- [ ] Source workflow tasks, events, failure/retry/approval states — NOT IMPLEMENTED.

## Detection and Exception Center

- [ ] Duplicate, amount mismatch, missing ledger, unmatched reference and FAILED-payment rules — IMPLEMENTED — NOT VERIFIED.
- [ ] Persisted cases, evidence, active deduplication and detection audit — IMPLEMENTED — NOT VERIFIED.
- [ ] Processing timeouts, missing approvals and workflow failures — NOT IMPLEMENTED.
- [ ] Invalid/incomplete linked journals detected as operational exceptions — PARTIAL; current source can skip both missing-posting and amount-mismatch conditions when a referenced journal exists but is invalid.
- [ ] Automatic scheduler, configured rule thresholds and recurring-fault semantics — PARTIAL / NOT IMPLEMENTED as detailed in report.
- [ ] Case list/detail, source links, severity/status, notes and direct closure — IMPLEMENTED — NOT VERIFIED.
- [ ] Smart tabs, search/filtering, case metrics, SLA and assignments — NOT IMPLEMENTED.
- [ ] Escalation routing/flags and verification-aware lifecycle — NOT IMPLEMENTED.

## AI Investigation

- [ ] Case navigation, staged runs, source evidence explorer, history and handoff — MOCK / SIMULATED; browser integration unverified.
- [ ] Actual LLM integration and constrained server investigation API — NOT IMPLEMENTED.
- [ ] Server-persisted investigation, report, evidence and error/retry state — NOT IMPLEMENTED.
- [ ] Non-duplicate investigation support — NOT IMPLEMENTED.
- [ ] Durable case/investigation/workflow evidence identity across users — NOT IMPLEMENTED.

## Resolution Workflows

- [ ] Missing ledger posting correction — PARTIAL; backend source exists, unverified, no independent verification.
- [ ] Reconciliation mismatch recovery — PARTIAL; positive shortfall correction only.
- [ ] Missing reference enrichment — NOT IMPLEMENTED.
- [ ] Duplicate record containment — PARTIAL; direct ADMIN rejection without approval workflow/current posting verification.
- [ ] Failed batch safe retry — PARTIAL adjacent payment retry only; actual failed task/batch workflow missing.
- [ ] Stable remediation replay key across retries — BROKEN frontend/backend contract.
- [ ] Shared account locking, status/funds/current evidence revalidation for every corrective writer — PARTIAL.
- [ ] Workflow definitions, plans, runs, steps, policy decisions and execution tracking — NOT IMPLEMENTED beyond direct type dispatch/outcome records.
- [ ] Resolution dry run — NOT IMPLEMENTED; existing fixtures/handoff are MOCK / SIMULATED.
- [ ] Approval pauses/resumption, fresh post-action verification and failure recovery/escalation — NOT IMPLEMENTED.

## Approval Center

- [ ] Persisted approval requests linked to case/run/action — NOT IMPLEMENTED.
- [ ] Listing/detail, approve/reject, decision history — NOT IMPLEMENTED.
- [ ] APPROVER permissions and separation of duties — NOT IMPLEMENTED.
- [ ] Decision expiry, evidence revalidation and safe repeated resume — NOT IMPLEMENTED.
- [ ] Operational approval page — NOT IMPLEMENTED; generic preview only.

## Audit, analytics and security

- [ ] Persisted operational events and case history — IMPLEMENTED — NOT VERIFIED.
- [ ] Complete failure/denial auditing, unique actors, workflow/approval/verification references — PARTIAL / NOT IMPLEMENTED.
- [ ] Audit filtering, paging, structured details and append-only database controls — PARTIAL.
- [ ] Payment/account counts computed from shared records — IMPLEMENTED — NOT VERIFIED; DB-backed only in connected mode.
- [ ] Real operations Overview/Analytics charts, verified success rate and SLA aggregates — NOT IMPLEMENTED.
- [ ] Demo bearer token authentication and ADMIN/ANALYST enforcement — IMPLEMENTED — NOT VERIFIED by current security tests.
- [ ] Unique user identity, token expiry/revocation and approval role — NOT IMPLEMENTED.
- [ ] Runtime synthetic-only guard, validated distinct tokens and config, deployment API routing — PARTIAL / NOT IMPLEMENTED.
- [ ] DB TLS/grants/backups, actual deployed migration revision and data provenance — UNKNOWN.

## Verification and delivery

- [ ] Install/recreate declared dependencies after reporting missing packages — NOT DONE during audit; React/Vite/Playwright installation absent; Alembic/Faker/psycopg2-binary absent.
- [ ] Frontend build — BROKEN environment; Vite unavailable.
- [ ] Full frontend unit suite — BLOCKED by missing React; 12 pass, 4 test-file load failures, 0 skips.
- [ ] Backend 21 business/migration test methods — UNVERIFIED; two module discovery errors, no actual methods executed.
- [ ] Local Playwright suites — NOT RUN; dependencies/browser environment unavailable.
- [ ] Connected Playwright suite — NOT RUN; dependencies absent and configured backend virtualenv missing.
- [ ] PostgreSQL migration/concurrency and complete approval/verification journeys — NOT RUN / missing implementation.
- [ ] Configured lint/type checks — NOT IMPLEMENTED.
- [ ] Resolve blueprint/current documentation contradictions and runtime mode labels — PARTIAL.

Immediate work order and acceptance criteria are in [DEVELOPMENT_ROADMAP.md](DEVELOPMENT_ROADMAP.md). No fixes, installs, seeds or database operations were performed during this audit.
