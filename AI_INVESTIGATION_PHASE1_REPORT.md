# Phase 1: investigation evidence repair

The existing evidence and investigation endpoints are preserved. The backend now consumes
the actual A/B/C operational event and request structures, recognizes verified held-before-
execution outcomes, and supplies deterministic financial summaries. No UI, scenario generator,
ledger-posting, detection, resolution, OpenAI model, credentials or database schema changed.

## Bugs repaired

1. Strict event parsing previously rejected an entire JSON payload when it contained actual
   fields such as request_id/source_component. The new typed projection validates recognized
   fields individually, omits unknown/private fields, preserves valid facts and reports
   ABSENT, UNSTRUCTURED, UNSUPPORTED, VALID, PARTIAL or INVALID with non-sensitive diagnostics.
   The Pydantic schema still uses extra=forbid; unknown values are never forwarded automatically.
2. The financial assessment omitted HELD. It now distinguishes completed/posted, held before
   execution, failed/rejected, and pending/unknown states. A hold still requires a persisted
   blocked/rejected event, valid relationships, no linked journal/legacy posting and no evidence
   that processing started. Plain PENDING is never proof of a hold.
3. Request history was not retrieved. Relevant payment_requests now expose the persisted
   request ID, owning payment/instruction, origin, anchor, retry, authorization, correlation,
   timestamp and a hash of the submitted idempotency key. The model has no request-outcome
   column: outcome remains null/NOT_RECORDED, with paymentStatus separately identified.
4. Pair selection ignored the case's related_transaction_id. The persisted pair is now the
   starting point, cross-checked against original-instruction and detection references.
   Conflicts prevent confirmed intent/cause and excess-posting conclusions. Similar unrelated
   payments are not searched for or inserted into the selected pair.
5. Raw source descriptions/detection dictionaries could reach the model. A separate closed
   model-input projection now excludes both, all unknown keys, scenario/expected-answer
   metadata, private batches and unknown event types. Stable source IDs remain available for
   citations. Authorized analyst snapshots retain existing raw descriptions/detection evidence;
   these are not passed wholesale to OpenAI.
6. Financial summaries lacked explicit quantities. The backend now exposes completed-payment
   counts, unique valid journal counts, separate debit/credit totals per currency, per-account
   and sender/receiver movement, expected single-transfer movement and excess amount when
   intent/execution evidence supports them. All arithmetic uses Decimal and outputs exact
   two-decimal strings. Debit and credit are never added together as transfer value.

## Request and event integrity

Only requests owned by the selected payments are returned. Anchors must belong to the pair
and agree on accounts, amount and currency. Retry references must resolve within scope to
a different, earlier request with the same instruction/correlation and a SYSTEM retry origin.
An unresolved/out-of-pair retry is recorded as uncertainty rather than pulling in unrelated
payments. Request-to-event FKs, JSON request/intent IDs, correlation and relevant origins are
cross-checked. Normal system timeout events on a CUSTOMER-origin request remain supported.

Independent authorization requires one matching authorization event for each request, correct
authorization and instruction IDs, CUSTOMER origin, matching parties/amount/currency, and no
contradictory retry. Duplicate or conflicting authorization events remain uncertain. An
idempotency-control-failure conclusion additionally requires correlated timeout/retry events
and explicit MISS plus authoritative_execution_present=true control evidence.

Missing request history, invalid structured fields and conflicting links are explicitly
reported. Missing evidence is never replaced with fabricated authorization, retries or zero
financial movement. Journal validation continues using the existing core-banking validator.
Journal status, timestamp, amounts, currencies, parties, entries and payment links remain
subject to the existing checks; contradictory payment states prevent a complete outcome.

## Model evidence allowlist

The projection contains only selected payment/instruction references, amounts/currencies,
statuses/timestamps, account references/currencies, persisted journals/entries, safe request
provenance, known operational event types, validated operational payload fields, backend-
generated integrity/financial assessments and citation IDs. Payload fields include origin,
trigger, intent/request/submission IDs, source component, correlation/retry/authorization IDs,
authorization facts, party/amount/currency bindings and control/posting outcome fields.

Unrestricted free-text descriptions, source error strings, unknown fields, raw detection JSON,
private batch metadata, scenario selections and expected answers are excluded from model input.
Malformed values are omitted with field-level diagnostics; rejected values/private field names
are not echoed in diagnostics. Unknown event types become UNRECOGNIZED_EVENT for the model.

## Actual verification

Live GET requests verified that the existing cases still exist and have these facts:

| Existing case | Source cause supported | Completed payments | Journals / entries | Debit total | Credit total | Sender net | Receiver net | Excess |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| CASE-000007 (A) | CUSTOMER_DOUBLE_SUBMISSION | 1 | 1 / 2 | SGD 1.11 | SGD 1.11 | -1.11 | +1.11 | SGD 0.00 |
| CASE-000008 (B) | IDEMPOTENCY_CONTROL_FAILURE | 2 | 2 / 4 | SGD 4.44 | SGD 4.44 | -4.44 | +4.44 | SGD 2.22 |
| CASE-000009 (C) | LEGITIMATE_REPEATED_PAYMENT | 2 | 2 / 4 | SGD 6.66 | SGD 6.66 | -6.66 | +6.66 | Not asserted |

Each case has two valid request records. Origins are CUSTOMER/CUSTOMER for A and C,
CUSTOMER/SYSTEM for B. B's retry resolves to its original request; C has two verified,
independently bound authorizations. A's HELD payment has no second journal.

The read-only database inspection confirmed revision 20261111_08 and the existing request
columns. Before/after hashes/counts matched across 14 source tables, including accounts,
payments, instructions, requests, events, journals/entries, legacy ledger records, cases,
case actions, audits and batch history. No Supabase DML/DDL, reset, reseed or Alembic command
was executed. Verification details/hashes are in AI_INVESTIGATION_PHASE1_VERIFICATION.json.

Focused test command, from backend:

```powershell
..\venv\Scripts\python.exe -B -m unittest discover -s tests -p 'test_investigation*.py' -v
```

**31 tests passed, zero failed**: 20 new Phase 1 tests and 11 existing investigation/provider
tests. The existing tests were decoupled from Alembic-backed test helpers and now also use
actual production-generated scenario/request/event shapes. All test mutations use in-memory
SQLite only; provider HTTP is mocked. Coverage includes parser omissions/errors, held/pending/
failed states, request and authorization conflicts, persisted pair priority, exact totals,
model-input leakage, authentication, API/report compatibility, read-only fingerprints, causal
citations and malformed/refused/incomplete/timed-out provider responses.

The initial test command ran from the repository root without backend on the import path
and failed to import main. Running the documented command from backend resolved that runner
configuration issue. The final focused suites pass. `git diff --check` also passes.

## Exact files changed

- backend/modules/intelliops/investigation_evidence.py
- backend/modules/intelliops/investigation_schemas.py
- backend/modules/intelliops/investigation_router.py
- backend/modules/intelliops/investigation_service.py
- backend/modules/intelliops/investigation_projection.py (new)
- backend/modules/intelliops/investigation_requests.py (new)
- backend/tests/test_investigation.py
- backend/tests/test_investigation_evidence_phase1.py (new)
- AI_INVESTIGATION_PHASE1_VERIFICATION.json (new; synthetic references and hashes, no credentials)
- AI_INVESTIGATION_PHASE1_REPORT.md (new)

No SQLAlchemy model or database-object changes were necessary. The evidence endpoint has
an additive response schema and financial_impact field. The existing report retains its
fields and adds financial_impact. The existing Responses adapter/model and frontend report
consumers are preserved. Pre-existing unrelated uncommitted work was not reverted.

## Remaining limitations

This phase verifies evidence and deterministic assessments, not live LLM quality. No live
OpenAI call was made. Novel-cause generalization, semantic validation of generated prose,
confidence improvements and cross-user report persistence remain separate work. Existing
reports/history still use the prior browser-session persistence contract. Missing historical
provenance is explicitly uncertain rather than repaired. Backend schema 20261111_08 remains
the prerequisite for request-history retrieval.

No AI Resolution, UI redesign, financial correction, commit or push was performed.
