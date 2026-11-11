# Detection Rules Reference

Local implementation: 10 November 2026. Requires Alembic **`20261110_07`**. Executable registry: `backend/modules/intelliops/rules.py`; evaluation: `backend/modules/intelliops/detection.py`; financial helper: `backend/modules/core_banking/service.py:assess_journal`. No LLM participates in detection.

## Configuration and evidence contract

Each rule has a stable code, unique exception type, integer database ID, descriptive name/description, enabled state, severity, configuration JSON, version and updated timestamp. Code/type identity is validated against the executable registry; database text never supplies executable logic. Version is the current policy version, not multiple simultaneously active rows; increment it deliberately when changing policy. Each new case snapshots the version and effective configuration. Existing cases are not rewritten.

Supported severities are LOW, MEDIUM, HIGH and CRITICAL. All rules default to HIGH except UNMATCHED_TRANSACTION (MEDIUM). `enabled=false` prevents new cases and does not count as observed recovery. Unknown JSON keys, non-integer/invalid values, unsupported integer thresholds and conflicting threshold declarations return configuration errors. Changing severity/fields through ORM updates updated_at; direct SQL administration must maintain timestamps/version explicitly.

The legacy integer `threshold` remains supported only with explicit units shown below. Prefer configuration JSON. Do not supply both threshold and the JSON key it aliases. Previously ignored non-null settings require review before migration rather than silent reinterpretation.

Every case preserves public transaction reference, observation time, stable rule code/version/configuration and evidence fingerprint. Ledger findings include journal references/status/currency/source links, entry IDs/accounts/sides/amounts/currencies/posted flags, reason codes and legacy records where present. Missing ownership is labeled UNAVAILABLE_LEGACY, not invented. All findings add case actions and audit events transactionally; financial source records are never changed by detection.

## Common reconciliation window

Only eligible COMPLETED payments are evaluated for ledger rules. By default the detector honors PaymentInstruction.reconciliation_due_at; when absent it uses transaction.created_at plus INTELLIOPS_RECONCILIATION_SECONDS (default 60, minimum 1). This preserves the original creation-based behavior; it is not a new completion-based grace period. New source instructions store their cutoff at creation.

Optional `configuration.reconciliation_seconds` overrides the cutoff as creation time plus the configured positive integer. This override applies to all six ledger rules, including AMOUNT_MISMATCH. At `now == cutoff` the rule is eligible. Before cutoff or outside COMPLETED state, the ledger rule is not evaluated and cannot establish recovery. A fixed INTELLIOPS_SIMULATION_TIME does not advance by waiting. Detection remains explicitly triggered, not scheduled.

## Rule definitions

| Code / exception type | Description and trigger | Threshold | Required evidence / safeguards | Example |
|---|---|---|---|---|
| **DUPLICATE_TRANSACTION** / Duplicate Transaction | Resolve explicit original_payment_id first, otherwise an earlier shared business-reference candidate. Confirm request relationship only with matching parties/amount/currency, an explicit source link or recorded duplicate hold, and completed original. Otherwise classify SUSPECTED_DUPLICATE. | No configurable similarity threshold; similar attributes alone never create a candidate. Integer threshold unsupported. | Instruction identities, key equality where available, original/current business references and statuses, hold/processing events, aligned journals and entries. Legitimate independent references stay separate; rejected requests without postings need no new containment alert. Root cause always NOT_ESTABLISHED. HIGH. | Original completes; second source-linked request is held. Case confirms duplicate request with one posting, not two losses. |
| **PAYMENT_PROCESSING_FAILURE** / Payment Processing Failure | Transaction source status is FAILED. | Immediate; integer threshold unsupported. | Source status, transaction reference and optional recorded instruction failure code. Does not stand in for task/workflow failure. HIGH. | Controlled processor failure before posting produces a failure case. |
| **MISSING_LEDGER_POSTING** / Missing Ledger Posting | Eligible completed payment has no linked journal and no legacy ledger row. | Reconciliation window; integer threshold aliases reconciliation_seconds. | Absence in declared payment-linked source scope; records with invalid journals are classified more precisely instead. HIGH. | Completed source still has no posting after its allowed window. |
| **UNMATCHED_TRANSACTION** / Unmatched Transaction | An internally valid linked journal has a different public payment reference or a conflicting non-null source_transaction_id. | Reconciliation window; integer threshold aliases reconciliation_seconds. | Posted, timestamped, internally balanced journal; actual/expected references and all journal assessments retained. Invalid Draft records go to invalid-posting classification. MEDIUM. | Source-linked journal uses UNMATCHED-* instead of its payment reference. |
| **AMOUNT_MISMATCH** / Amount Mismatch | Aggregate aligned valid modern debit postings differ from payment amount by more than tolerance. Legacy-only valid same-currency single-sided amounts are compared separately and labeled LEGACY. | amount_tolerance_cents defaults **0**; nonnegative integer. Integer threshold aliases this cents key. Also accepts reconciliation_seconds JSON override. | Requires all linked modern journals to be internally valid, correctly referenced and payment-party/currency aligned; no competing legacy representation. Mixed/unsafe evidence is not a shortfall recommendation. HIGH. | Expected 100.00; valid posting 99.99 → case at zero tolerance; tolerated when configured tolerance is 1 cent. |
| **INVALID_LEDGER_POSTING** / Invalid Ledger Posting | Linked journal fails internal accounting/state checks, legacy rows are malformed/ambiguous, or modern and legacy posting representations compete. | Reconciliation window; integer threshold aliases reconciliation_seconds. | Explicit reasons: NOT_POSTED, MISSING_POSTING_TIMESTAMP, MISSING_ENTRIES, INVALID_ENTRY, MISSING_ACCOUNT, INTERNAL_CURRENCY_CONFLICT, UNBALANCED_OR_EMPTY; mixed/legacy flags. Does not invent a missing posting or corrective amount. HIGH. | Only a Draft/Reversed journal exists, or one side of a journal is missing. |
| **LEDGER_ACCOUNT_MISMATCH** / Ledger Account Mismatch | Journal debit accounts differ from instruction sender or credit accounts differ from receiver. | Reconciliation window; integer threshold aliases reconciliation_seconds. | Uses authoritative instruction accounts, entry sides/account IDs; absent ownership remains unknown. May coexist with invalid-posting classification. HIGH. | Balanced credit is posted to a different same-currency customer account. |
| **LEDGER_CURRENCY_MISMATCH** / Ledger Currency Mismatch | Journal/entry or legacy currency differs from payment currency. | Reconciliation window; integer threshold aliases reconciliation_seconds. | Compares against the payment, in addition to internal journal/account currency checks. Does not treat equal numeric values in different currencies as reconciled. HIGH. | SGD payment is linked to an internally balanced USD posting. |
| **PROCESSING_TIMEOUT** / Processing Timeout | PENDING/PROCESSING payment breaches inactivity or total-age policy, unless explicitly held before duplicate execution. | inactivity_seconds **300**; max_pending_seconds **1800**, positive integers. Integer threshold aliases inactivity_seconds only. Equality triggers. | Latest recorded event/activity and creation time; retry event count; explicit external-wait state. DUPLICATE_BLOCKED as latest event with no posting suppresses timeout. Later activity resumes normal evaluation. No inferred retries/approvals. HIGH. | No processing progress for five minutes; or external wait exceeds thirty-minute maximum. |

## Duplicate financial assessment

- **SINGLE_POSTING_CONFIRMED_DUPLICATE_HELD:** original has exactly one full payment-aligned journal; duplicate is PENDING with a recorded hold, no linked modern/legacy posting and no processing-start/post/completion events.
- **TWO_POSTINGS_CONFIRMED:** both instructions have exactly one full payment-aligned valid journal, with no additional incomplete or legacy evidence. This is a financial observation; uncertain intent remains SUSPECTED_DUPLICATE, not confirmed loss or an inferred idempotency bug.
- **EXECUTION_OUTCOME_UNKNOWN:** evidence does not satisfy those checks. Missing journals alone are not proof of non-execution. Without authoritative instruction ownership, financial execution stays unknown.

The source simulator does not record a causal acknowledgment-timeout/retry relationship, so no such root cause is invented. Duplicate evidence preserves originalReference/businessReference for existing AI Investigation consumers.

## Timeout details

Activity is the latest transaction creation or recorded ProcessingEvent.created_at. Observed retries count RETRY_SUBMITTED and PROCESSING_RETRY_STARTED; no retry-limit policy is invented because no authoritative maximum retry field exists.

The explicit source event types WAITING_FOR_EXTERNAL_SYSTEM and WAITING_FOR_CLEARING exempt the latest wait from inactivity timeout, but not maximum total age. The current generator does not fabricate those events. The latest DUPLICATE_BLOCKED event exempts a held, unposted request from timeout. A later retry/processing event removes that exemption; posting evidence also prevents treating a request as merely held.

## Idempotency, history and recurrence

Detection key remains `transaction_id:exception_type`, preserving existing integrations and the partial active-case unique index. PostgreSQL detector runs use one transaction advisory lock; competing active-key inserts are handled within a savepoint. History also checks transaction/type so legacy NULL keys cannot silently create a duplicate active case.

Historical cases are never reopened. New occurrences require a scanned eligible recovery under the same policy followed by a scanned violation; new evidence links recurrenceOf to the prior public CASE ID. Unchanged ongoing violations, disabled rules, configuration changes, clock rewinds and ineligible ledger states do not prove recovery. Original case evidence/timelines remain unchanged. Recovery/regression entirely between scans cannot be established from current source snapshots.

## Blocked rules

Failed workflow steps, overdue workflow tasks and missing required approvals are blocked on authoritative source models/events. `backend/modules/workflow/` is reserved only. Payment processing failure and timeout rules do not pretend to implement those domains. No LLM, fake workflow or approval records were added.
