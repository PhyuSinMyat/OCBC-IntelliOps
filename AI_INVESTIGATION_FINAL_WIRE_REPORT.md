# Final Phase 1: exact LLM input verification

**Result: passed for CASE-000010, CASE-000011 and CASE-000009.** No evidence leakage was
found in their captured OpenAI request inputs, including nested metadata injection tests.
No production changes were necessary. Added automated tests and verification artifacts only.
No paid OpenAI call, shared database write, migration, financial posting, commit or push occurred.

## Construction path verified for each case

1. The running FastAPI server receives authenticated GET
   `/api/exceptions/{case_id}/investigation-evidence`.
2. `investigation_router.collect` reads a repeatable-read/read-only snapshot through
   `investigation_evidence.retrieve_evidence` and releases the database transaction.
3. The returned live case evidence is supplied to a local in-process FastAPI POST
   `/api/exceptions/{case_id}/investigations`. Tests replace only the collection boundary
   with that frozen evidence; the local POST cannot access a source database.
4. The actual `investigation_service.investigate` calls `model_evidence`.
5. The actual `InvestigationProvider.analyze` serializes that projection into the Responses
   request's `input` string. `httpx.MockTransport` captures the HTTP body and returns a
   scripted structured response. No external OpenAI request is sent.

This verifies the routed service and actual HTTP serialization, not just the intended
output of a helper function. The only live application requests are the three evidence GETs.

## Fields transmitted in all three cases

The serialized evidence input has exactly these top-level keys:

```text
snapshot
financial_verification
evidence_references
retrieved_at
```

`snapshot` contains allowlisted case identity/status, original and related payments,
accounts/currencies, instructions, persisted request relationships, processing events,
journal references, ledger entries and legacy-posting observations where present.
Financial verification contains server-validated execution states, counts, separate
debit/credit totals, account movement and journal checks. Stable citation IDs are retained.

Explicitly excluded: verified_assessment, selected root_cause_code,
diagnosis_classification, recommended_action_code, required_cause_references, raw case
evidence, raw event descriptions, audit dictionaries/events, private batch metadata,
scenario selections/labels, expected answers, and intent-dependent expected/excess estimates.

For compatibility, the analyst GET response still contains the legacy heuristic dictionary,
marked `verified_assessment_scope: LEGACY_HEURISTIC_NOT_LLM_INPUT`. The full analyst response
is not the model input. The adapter rejects an unprojected analyst response before HTTP.

The request's separate output JSON Schema still names report properties such as
root_cause_code and provides permissible relationship/review-action vocabulary. These are
output-format definitions, not selected answers in the evidence input. Root-cause codes
have no enum limiting them to known simulator causes. No selected diagnosis or action is
provided through the system instructions; they ask for independent analysis and human review.

## Per-case results

| Case | Completed payments | Journals / entries | Debit total | Credit total | Request origins | Citation IDs: events / payments / requests / journals | Wire test |
| --- | --- | --- | --- | --- | --- | --- | --- |
| CASE-000010 | 1 | 1 / 2 | SGD 25.00 | SGD 25.00 | CUSTOMER / CUSTOMER | 14 / 2 / 2 / 1 | Passed |
| CASE-000011 | 2 | 2 / 4 | SGD 20.00 | SGD 20.00 | CUSTOMER / SYSTEM | 21 / 2 / 2 / 2 | Passed |
| CASE-000009 | 2 | 2 / 4 | SGD 6.66 | SGD 6.66 | CUSTOMER / CUSTOMER | 20 / 2 / 2 / 2 | Passed |

For **each case**, the construction path and field inclusion/exclusion rules above were
verified on the captured HTTP `input`. All event/payment ownership and non-null request FKs
resolve within the selected pair. All ledger entries belong to transmitted journals, and
separately recomputed entry sums equal the transmitted debit/credit totals. Each test returns
and successfully validates a model claim citing an actual event, payment, request and journal.

For **CASE-000010**, the accounting classification is SINGLE_POSTING_CONFIRMED. The held
request is not represented as a second posting. The mock can return an unresolved cause and
verification review without being forced to repeat the analyst heuristic's customer cause.

For **CASE-000011**, the accounting classification is DOUBLE_POSTING_CONFIRMED. Its SYSTEM
request retains a valid retry link; customer/system origins and correlated operational
evidence remain available. The mock can again return an unresolved cause and general review
without being forced to copy the legacy idempotency diagnosis or escalation choice.

For **CASE-000009**, DOUBLE_POSTING_CONFIRMED means two verified postings, not automatically
an erroneous duplicate. Both independent authorization bindings remain present. The scripted
mock returns LEGITIMATE_SEPARATE_INSTRUCTIONS and REVIEW_FALSE_POSITIVE_CLOSURE; the service
accepts this while retaining the two-posting accounting classification. The report's financial
explanation explicitly leaves intent to separate assessment. No reversal or correction occurs.

## Nested leakage tests

Each case was transmitted twice through the actual mocked HTTP path: once with the original
live evidence and once after injecting a sentinel into legacy diagnosis/action fields, nested
case evidence, audit metadata/events, raw descriptions, unknown structured event fields,
source-validation metadata, request metadata and journal-validation metadata.

The captured input strings were **byte-for-byte identical** for clean and poisoned evidence
in every case. Recursive key checks and value scans found no selected answer or private
simulator label. No production fix was indicated by these tests.

This demonstrates exclusion for the inspected construction path, cases and tested vectors;
it is not a proof against every possible future schema or application change.

## Missing evidence remains truthful

All three cases retain `outcome: null` and `outcomeAvailability: NOT_RECORDED` on request
records. The request model has no dedicated recorded request-outcome field. Its separately
observed payment status is not substituted for that missing outcome.

UNSTRUCTURED events retain their real database event identity, type, time, status and any
actual FK, but have empty projected sourceData. No payload origin, correlation or authorization
metadata is manufactured. Tests inspect this in the captured request, not only the parser.

## Unknown causes and accounting safety

The captured output schema accepts an open uppercase root-cause identifier, title,
explanation and evidence references. An existing regression test independently exercises an
unfamiliar broker-lease event and accepts a cited new cause hypothesis. The code does not
select a report by simulator scenario label. Actual financial verification remains server
controlled, and inconsistent accounting claims or unsupported closure recommendations fail.

Relationship/action output categories are intentionally bounded review vocabulary; those
categories do not constrain root-cause hypotheses to three causes or authorize remediation.

## Actual automated results

**44 tests passed, zero failed, zero skipped.** This includes three new existing-case wire
tests plus the previous 41 evidence, independence, authentication and provider-failure tests.
The three new tests made six captured mock Responses calls in total: clean and nested-poison
for each case. The rest of the suite uses in-memory SQLite and mocked providers.

The live-case tests are opt-in with `INTELLIOPS_VERIFY_EXISTING_CASES=1` and require the
existing demo access token in the process environment. The focused command, from backend:

```powershell
..\venv\Scripts\python.exe -B -m unittest discover -s tests -p 'test_investigation*.py' -v
```

Without the opt-in flag, the three live-case tests skip rather than silently accessing the
running server. This verification run explicitly enabled them. Actual credentials were used
only for authenticated evidence GETs; mock-provider keys/model names are harmless placeholders.
Headers and API keys are never saved in captures or the report.

Before/after read-only hashes/counts matched across 14 source tables, including payments,
requests, events, journals/entries, accounts, cases/actions, audits and batch history.
Supabase remained at revision 20261111_08. `git diff --check` passed.

## Capture locations and changed files

Exact body-only request captures, with no headers or credentials:

- [CASE-000010 clean request](logs/phase1-final-llm-input/CASE-000010-clean-request.json)
- [CASE-000011 clean request](logs/phase1-final-llm-input/CASE-000011-clean-request.json)
- [CASE-000009 clean request](logs/phase1-final-llm-input/CASE-000009-clean-request.json)

The corresponding `*-nested-poison-request.json` and `*-summary.json` files are in the same
ignored logs directory. The bodies include the output schema and instructions, so readers
can distinguish output-property names from the serialized evidence input.

Files added in this task:

- backend/tests/test_investigation_live_wire.py
- AI_INVESTIGATION_FINAL_WIRE_VERIFICATION.json
- AI_INVESTIGATION_FINAL_WIRE_REPORT.md

No production source file was changed. Existing unrelated working-tree changes were preserved.

## Remaining issues

No leakage was found requiring a production fix. Paid model reasoning quality was not
evaluated: scripted responses prove the transport/validation behavior, not that a live model
will always diagnose correctly. Citation availability proves referenced records exist, not
semantic truth of every generated sentence. Hypotheses still require analyst review.

No scenario generation, shared record modification, ledger change, migration, automatic
remediation, commit or push was performed.
