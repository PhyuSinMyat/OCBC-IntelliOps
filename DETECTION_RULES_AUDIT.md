# OCBC IntelliOps — Detection Rules Audit

Reviewed 10 November 2026 (Asia/Singapore). **Audit only:** source/test inspection and read-only Supabase queries; no detection runs, batches, seeds, application changes or database mutations. Existing test assertions were reviewed, not executed, because they invoke detection and scenario generation.

## Findings

Five hardcoded detection conditions exist in **`backend/modules/intelliops/detection.py:12`, function `detect`**. The only production caller found is `backend/modules/payment_processing/api.py:131`, POST `/api/detection/run`; it requires a configured demo bearer token and commits the scan in one transaction. Payment creation/batch generation does not automatically detect cases. No backend scheduler or second backend rule engine was found. Browser simulation rules are separate from this backend audit.

Read-only verification confirms **`detection_rules` currently contains zero records**. All five existing cases are OPEN/HIGH with null rule_id:

| Case | Exception type | Detection key |
|---|---|---|
| CASE-000001 | Missing Ledger Posting | `3:Missing Ledger Posting` |
| CASE-000002 | Missing Ledger Posting | `4:Missing Ledger Posting` |
| CASE-000003 | Amount Mismatch | `5:Amount Mismatch` |
| CASE-000004 | Duplicate Transaction | `7:Duplicate Transaction` |
| CASE-000005 | Payment Processing Failure | `8:Payment Processing Failure` |

Five detected **cases** therefore do not establish coverage of all five **types**: no existing Unmatched Transaction case was observed. Successful previous detection is user-confirmed and persisted cases were read; this audit did not rerun it or establish exhaustive correctness.

## Implementation matrix

**Rule IDs:** no stable rule-code constants or numeric IDs are assigned in Python. Each condition uses its exception-type string as its identity. An optional matching database row supplies `DetectionRule.id`; currently every condition has **no database rule ID**, and cases store NULL. CASE IDs are case identifiers, not rule IDs. Scenario codes such as DUPLICATE are source-generation controls, not rule IDs.

All rule locations below are in `backend/modules/intelliops/detection.py`.

| Exception type / rule ID | Exact source | Trigger and threshold | Severity | Tables/columns examined |
|---|---|---|---|---|
| Duplicate Transaction / none assigned | `:30–32` | Iterate transactions by ascending integer id; remember the first reference for each payment_reference. Every later transaction sharing that business reference is a candidate. Effective threshold: second or later record; no time, amount, party, currency or status filter. | HIGH | `transactions.id`, `.reference`, `.payment_reference` |
| Payment Processing Failure / none assigned | `:33–34` | `transactions.status == 'FAILED'`, immediately. No age, retry-count, error-category or amount threshold. Optional instruction failure_code is evidence, not an eligibility condition. | HIGH | `transactions.id`, `.reference`, `.status`; `payment_instructions.transaction_id`, `.failure_code` |
| Missing Ledger Posting / none assigned | `:35–37` | COMPLETED and now >= cutoff, with **no linked journal of any status** and no legacy ledger row. Zero linked records, not zero valid posted records. | HIGH | `transactions.status`, `.created_at`, `.reference`, `.id`; instruction `.reconciliation_due_at`; `ledger_journals.payment_reference`, `.source_transaction_id`; `ledger_records.transaction_id` |
| Unmatched Transaction / none assigned | `:35`, `:39–41` | COMPLETED and cutoff elapsed; a linked journal's payment_reference differs exactly from transaction.reference. Mismatched journals are usually found through source_transaction_id. No journal-status/validity filter for this condition. | MEDIUM | Same payment/cutoff fields; `ledger_journals.source_transaction_id`, `.payment_reference`, `.journal_ref` |
| Amount Mismatch / none assigned | `:35`, `:42–49` | COMPLETED and cutoff elapsed. For reference-matched valid journals, total Debit entries across those journals != transaction.amount. Separately, sum all linked legacy ledger amounts != transaction.amount. Exact Decimal inequality, **zero tolerance**; no configured materiality threshold. Modern branch requires at least one valid matching journal; legacy branch requires at least one row. | HIGH | `transactions.amount` and common payment/cutoff fields; journal id/reference/source fields; `ledger_entries.journal_id`, `.side`, `.amount`; `ledger_records.transaction_id`, `.amount`; valid-journal helper fields below |

Common linkage (`detection.py:26–28`): a journal matches if **payment_reference == transaction.reference OR source_transaction_id == transaction.id**. Instruction matching is an outer join on transaction_id; missing instructions do not exclude legacy payments.

Amount validation delegates to **`backend/modules/core_banking/service.py:22`, `valid_journals`**: journal status must be Posted, posted_at non-null, and it must have at least two entries, zero signed sum, positive amounts, Debit/Credit sides, posted=True and entry currency matching both journal and account currency. It reads `ledger_journals.journal_id/status/posted_at/currency`, `ledger_entries.journal_id/account_id/side/amount/posted/currency` and `accounts.account_id/currency`. It does **not** establish payment-currency or payment-party agreement. Customers, processing event history, scenario_code and audit injection labels do not drive these rules.

## Hardcoded conditions versus detection_rules

`backend/modules/intelliops/models.py:11` defines integer id, unique name, exception_type, nullable integer threshold and enabled. This is much narrower than the proposed versioned rule schema in `README.md:507`.

- `detect` builds a dictionary keyed by **exact exception_type**, not name (`detection.py:23`). A matching disabled row suppresses new case creation; a matching enabled row supplies the case's rule_id (`:50–57`).
- Missing database rows leave hardcoded conditions enabled. Adding an unknown exception_type cannot introduce executable logic.
- **threshold is never read.** Conditions, severity, matching semantics and cutoff behavior remain Python/environment-controlled. Rule name is descriptive only.
- Multiple rows may share exception_type because only name is unique. Dictionary overwrite means one row wins without a defined ORDER BY; conflicting enabled flags are therefore ambiguous.
- Existing cases are not reclassified or relinked when rule configuration changes. The current core seed does not populate detection_rules (`backend/modules/core_banking/seed.py:18`). Null rule_id is expected under today's configuration, not evidence of failed detection.

## Reconciliation cutoff and payment status

`backend/modules/payment_processing/service.py:20–30` defines the clock and duration. Default duration is **60 seconds** from INTELLIOPS_RECONCILIATION_SECONDS, clamped to at least 1. Non-integer/empty invalid values can fail parsing. `simulation_now` uses UTC wall time unless INTELLIOPS_SIMULATION_TIME supplies a fixed timestamp; naive values are treated as UTC by `aware`.

For each transaction (`detection.py:28`):

```text
cutoff = instruction.reconciliation_due_at, when available
         otherwise transaction.created_at + configured seconds
eligible when status == COMPLETED and now >= cutoff
```

New payment instructions store due_at at creation (`service.py:86`), using that creation clock plus the duration. This is **not completed_at + 60 seconds**. Changing the environment duration does not rewrite stored due_at values; it affects new instructions and fallback calculations. A frozen clock does not advance by waiting. No background timer runs detection when the cutoff arrives; a later scan must be triggered.

| Source status | Current handling | Assessment |
|---|---|---|
| FAILED | Immediate failure condition; duplicate condition may also apply. Ledger checks skipped. | Appropriate for alerting source failure; no detection of an unexpected posting after failure. |
| PENDING | Duplicate condition only; age/cutoff never produces timeout. | Supports the held-duplicate demo; stuck non-duplicate payments remain undetected. |
| PROCESSING | Duplicate condition only. | Stuck processing/retry exhaustion missing. |
| COMPLETED | Reconciliation conditions after cutoff; duplicate condition immediate. | Intended basic flow implemented; ledger-validity/currency/party gaps below. |
| REJECTED / other values | Duplicate condition still applies; other conditions skipped. Exact uppercase comparisons are used. | Rejected duplicates can still be candidates; nonstandard persisted status casing is not normalized here. |

## Idempotency and persistence

`detection.py:21–22`, `:53–67` uses key **`transaction_id:exception_type`**, suppressing keys found in either active **or RESOLVED/CLOSED** cases. Newly created keys are added to the in-memory set, preventing duplicate conditions in one scan from creating multiple same-type cases. Different types on one transaction remain possible.

The deployed **uq_active_detection** index was verified read-only. It uniquely indexes non-null detection_key for statuses other than RESOLVED/CLOSED (`backend/modules/intelliops/models.py:50`; migration `backend/alembic/versions/20261103_02_payments.py:18`). Transactions are locked FOR UPDATE during scanning (`detection.py:14–15`). These protections support repeat-scan deduplication, but concurrent PostgreSQL behavior was not exercised.

Limits:

- Resolved keys are permanently suppressed in application logic even though the DB index permits later occurrences. A recurring defect on the same transaction/type cannot reopen or create a new case.
- Historical/manually inserted cases with NULL or inconsistent detection_key are not matched by the computed key; the index permits multiple NULLs.
- No rule version is included in the key. Multiple mismatched journals or modern/legacy mismatch branches yield one case and can retain only the first condition's evidence; existing evidence is not refreshed by subsequent scans.
- **The whole operation is not side-effect-idempotent:** every successful scan inserts DETECTION_RUN audit history, even when zero cases are created. New cases additionally insert DETECTED actions and EXCEPTION_DETECTED audit events.
- The route has no explicit concurrent unique-conflict retry handler; an unhandled IntegrityError can abort the scan if a race reaches the DB constraint. Existing row locks are helpful, not a substitute for concurrency tests across all writers.

## False-positive and false-negative risks

| Risk | Evidence / effect |
|---|---|
| **Invalid linked journal hides a posting failure — false negative** | A Draft, Reversed, unbalanced or otherwise invalid correctly referenced journal prevents missing-posting detection, but contributes nothing to matched_valid; with no valid/legacy posting the amount comparison never runs (`detection.py:36`, `:42–44`). |
| **Wrong currency/parties can pass — false negative** | valid_journals checks internal account/journal currency agreement, not transaction currency or instruction sender/receiver. Equal numeric debit totals can mask posting to wrong same-currency accounts or a different payment currency. |
| **Duplicate meaning is weak — false positive/negative** | Shared business reference alone is treated as duplicate, even for failed/rejected originals or legitimate reference reuse; earliest integer id is not necessarily the authoritative successful original. Actual duplicate intent under different references is missed. |
| **Unmatched search scope is incomplete — false negative** | Wrong reference plus no source_transaction_id cannot link a journal. A payment may get Missing Ledger Posting instead, while the orphan journal is never investigated separately. |
| **Non-posted journal reference mismatch — false positive risk** | Unmatched condition does not require Posted/valid state. A deliberately incomplete Draft reference can create a case after cutoff; desired semantics need specifying. |
| **Mixed legacy and modern evidence — false positive/negative** | Legacy summation ignores currency and entry_type/direction; both stores are evaluated independently. Modern journals can reconcile while separate legacy rows trigger mismatch. Aggregate modern debit totals can also hide offsetting journal-level errors. |
| **Cutoff tied to creation — premature alert risk** | If processing takes a long time before completion, the posting grace period may already have expired when status becomes COMPLETED. There is no per-rule/business-calendar/completion-time policy. |
| **Changing-source scan — transient results** | Source records are fetched in multiple queries; transaction locks do not lock every journal/entry writer or prove a single point-in-time snapshot. A late posting can race with absence checks. No automatic case refresh/retraction follows. |
| **Permanent resolved-key suppression — false negative** | Later regression of the same transaction/type is ignored (`detection.py:54`). |
| **Configuration ambiguity/fail-open behavior** | Empty table enables everything; duplicate exception_type rows overwrite each other; thresholds ignored. Disabling after a case exists does not remove/update it. |

These are source-supported paths/risks, not newly executed reproduction results. The implementation loads all source/case rows and repeatedly filters them in Python, so scan cost and lock duration also grow with dataset size.

## Existing automated test coverage

All references below are `backend/tests/test_payments.py` unless otherwise stated. **Reviewed only; NOT RUN in this audit.** Existing tests seed/generate scenarios and call detection, contrary to this task's execution restriction. They use isolated SQLite through `backend/tests/test_accounts.py:25–45`; they are not PostgreSQL concurrency tests.

| Rule / behavior | Existing assertions | Coverage limitation |
|---|---|---|
| All five conditions, immediate versus delayed detection | `test_all_scenarios_detection_cutoff_and_no_duplicate_active_cases` at `:136`: five scenarios, 2 cases immediately, 3 at +61 seconds, 0 on repeat; verifies all five exception types and OPEN/evidence timestamps | Combined happy-path test; no exact +59/+60 boundary, mixed invalid evidence or detailed per-rule severity/config tests |
| Disabled rule and linked numeric rule_id | `test_disabled_existing_detection_rule_is_respected`, `:177`: disabled failure rule creates 0; enabling creates 1 with non-null rule_id | Failure rule only; no threshold semantics, duplicate configuration rows or rule version tests |
| Missing posting lifecycle and closed suppression | `test_missing_ledger_case_review_remediation_and_close_flow`, `:188`: detects, notes, corrects, closes, repeat detects 0 | Demonstrates intended suppression, not recurrence handling |
| Late posting safeguard | `test_missing_ledger_remediation_stops_when_a_late_journal_exists`, `:226` | Tests remediation guard after detection, not detector race handling or invalid-journal detection |
| Duplicate, mismatch and failure after correction | `test_duplicate_mismatch_and_processing_failure_resolution_policies`, `:242`: detection before/after cutoff, correction, no new cases | Does not isolate terminal-key suppression from successful source correction |
| Invalid journal/currency and legacy ledger reads | `backend/tests/test_accounts.py:98`, `:118` | Tests balance exclusion and preservation, not detector completeness |
| Batch generation | `test_admin_can_generate_selected_exception_batch_with_automatic_inputs`, `:269` | Tests source generation, not additional rule correctness |

No dedicated detector tests found for pending/processing timeouts, missing approvals, workflow failures, exact cutoff equality/custom durations, legacy-only rule behavior, rejected duplicate candidates, wrong parties/payment currency, invalid-linked-journal blind spot, recurrence, NULL historical keys or concurrent scans/writers.

## Missing required rules and prioritized improvements

README requirements are intentions, not implemented rules. Processing timeout is represented in the legacy generator (`backend/generate_data.py:18`, `:80`) but has no detector condition. Workflow failure/overdue tasks and missing required approval are documented at `README.md:349–390`; `backend/modules/workflow/README.md:3` confirms the source workflow simulator is absent. FAILED-payment detection does not implement failed-workflow detection.

| Priority | Improvement / affected files | Acceptance criterion |
|---|---|---|
| **P0** | Detect absent **valid** postings/incomplete journals and verify payment currency/parties — `intelliops/detection.py`, `core_banking/service.py`, targeted tests | Completed payment with only invalid journals, wrong currency or wrong accounts produces an appropriate explicit case instead of silently passing |
| **P1** | Add pending/processing timeout rules with validated age thresholds — detector/config/tests | Stuck payments alert after a defined threshold; healthy in-window and deliberately held states handled by explicit policy |
| **P1** | Define duplicate intent, terminal-state and recurrence policies — detector/models/tests | Legitimate reference reuse not automatically confirmed as duplicate; recurrent faults are visible without duplicate active cases |
| **P1** | Introduce stable rule codes/versioning and deterministic configuration semantics; either implement threshold use or remove misleading configurability — DetectionRule, detector, additive migration | Rule identity recorded; duplicate configuration rejected; enabling, severity and thresholds behave as documented |
| **P1** | Add source workflow/approval evidence then task-failure/overdue/missing-approval rules — workflow module, detector, models/tests | Cases reference authoritative task/approval evidence; no simulated stand-in presented as implemented workflow detection |
| **P1** | Add regression and PostgreSQL concurrency coverage — `backend/tests/` | Boundary/custom/frozen clocks, invalid evidence, legacy/mixed stores, NULL keys and concurrent scans/late postings verified in isolated environments |
| **P2** | Expand unmatched/orphan coverage and preserve complete/current evidence — detector/case history | Unlinked journals can be triaged; all conflicting references captured without silently replacing historical evidence |
| **P2** | Bound queries/lock duration and add reliable scheduled triggering — detector/API/config | Scans scale to larger synthetic datasets; scheduled/manual overlap safe; each run has explicit success/failure audit and no duplicate active cases |

**Conclusion:** five simple source-evidence conditions are implemented and existing cases are persisted correctly enough to inspect. Rule-table records are optional controls, not the executable rule engine. Repeat-case protection is present, but detector completeness, configurability, recurrence and concurrency require further work. Only this report was created.
