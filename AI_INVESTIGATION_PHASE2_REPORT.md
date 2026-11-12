# Phase 2 investigation validation

Date: 2026-11-12. Branch: `feature/ai-investigation-phase2`. No commit or push.

## Outcome

Approved deployment follow-up: [durable-history deployment](AI_INVESTIGATION_PERSISTENCE_DEPLOYMENT.md) is complete. The exact SQL applied once, three accepted reports imported with provider HTTP blocked, local durable mode enabled, and real authenticated GET/API/browser retrieval passed for A/B/C. No new paid calls. Every pre-deployment record across all 14 source tables is preserved; separate concurrent payment activity was detected and left untouched. This supersedes the pending deployment status in the earlier implementation record below. Known model-quality limitations remain.

Completion integration update: [persistence/frontend completion report](AI_INVESTIGATION_PERSISTENCE_COMPLETION.md) documents the implemented opt-in durable store, immutable authenticated history, request deduplication and GET-only frontend reopening. Latest tests: **84 investigation passes / 3 skips, 12 payment workflow passes, 48 frontend passes, 2 browser tests passed; build passed**. All 14 financial/case source tables match the preserved baseline. No paid calls or shared writes occurred. **Supabase SQL and historical report import are prepared, not executed, and require separate approval before deployment.** Full deployed Phase 2 acceptance remains pending that step and deployed read-only verification.

Latest result: the separately authorized final CASE-000009 retest **passed core independent-authorization/action quality review**, with provider/application HTTP 200, `REVIEW_FALSE_POSITIVE_CLOSURE`, semantically relevant authorization-event findings and empty review flags. All 14 source tables remained unchanged. See [final C evaluation](AI_INVESTIGATION_CASE_000009_FINAL_RETEST.md), including the caveat that SGD 6.66 aggregate totals appear in deterministic fields but not model prose. Core A/B/C known-case live coverage is complete across controlled runs; frontend end-to-end verification and full Phase 2 acceptance remain pending. No further paid calls are authorized. The [initial C evaluation](AI_INVESTIGATION_CASE_000009_LIVE_RESULT.md) failed independent recommendation quality and remains preserved. Sections below describe earlier evaluation history unless explicitly updated.

Offline follow-up: the [monetary validation fix and explanation audit](AI_INVESTIGATION_MONETARY_VALIDATION_FIX.md) rejects the unchanged initial B report, preserves the real A monetary replay, adds source-derived major units, and clarifies general mechanism reasoning. Latest tests: 66 investigation passes/3 opt-in skips, 12 payment workflow passes and 48 frontend passes; build passed. The separately approved B retest above verifies the two targeted live improvements; full Phase 2 acceptance remains pending.

Offline authorization follow-up: the [authorization/uncertainty audit](AI_INVESTIGATION_AUTHORIZATION_UNCERTAINTY_AUDIT.md) clarifies affirmative authorization versus unknown customer motivation and adds output-only rationale/citation review flags without forcing a recommendation. The unchanged initial C candidate still replays with both flags; the separately approved final C retest above now independently demonstrates the targeted live improvement. Latest offline results: **75 investigation passes / 3 skips, 12 payment workflow passes, 48 frontend passes; production build passed**.

## Existing capability and changes

The existing React investigation service calls FastAPI, which collects a read-only Supabase snapshot, releases its transaction, builds the separate model projection, and calls the OpenAI Responses API. Deterministic journal validation remains authoritative. No source records, scenario generators, financial posting logic, migrations or database schemas were changed.

Model input remains limited to `snapshot`, `financial_verification`, `evidence_references`, and `retrieved_at`. The legacy assessment and predetermined causal/action answers remain excluded. Root-cause codes are open strings, permitting previously unseen causes; mocked tests cannot establish real model generalization.

Changes:

- `backend/modules/intelliops/investigation_llm.py`: bounded configuration, safe usage/latency metadata, optional local candidate diagnostics, clearer independent-instruction definitions and source citation instructions; dynamic citation enums in the actual structured-output request.
- `investigation_projection.py`: factual adjacent request receipt intervals derived from persisted timestamps.
- New `investigation_validation.py`: reject explicit unsupported currency amounts and mismatching request-receipt interval claims.
- `investigation_service.py` and `investigation_router.py`: validation reporting, safe error metadata and request-ID support.
- New `investigation_runs.py`: bounded process-local request-ID deduplication for success and failure.
- `backend/main.py`: allow the request-ID CORS header. `backend/.env.example`: document limits and optional diagnostics.
- New `backend/evaluate_investigation_live.py`: explicitly opt-in single-call runner with an exclusive attempt marker; no automatic retry.
- New `backend/tests/test_investigation_phase2.py`: mocked configuration, usage, monetary, chronology, citation-schema, retry-ID and missing-evidence regressions.
- Frontend `shared/api/banking.js`, investigation `service.js`, `presentation.js`, `CommandCenter.jsx`: send request IDs, show backend root-cause hypotheses without requiring a predefined cause code, show usage and verified totals, label two postings as financial evidence requiring interpretation.

## Real calls and generated findings

All calls used the real authenticated FastAPI investigation endpoint, `gpt-5.4-mini` (resolved `gpt-5.4-mini-2026-03-17`), 4,000 maximum output tokens, 45-second provider timeout, and no automatic retries.

| CASE-000010 attempt | Provider / application | Input / output tokens | Cached input | Latency | Result |
|---|---|---|---|---|---|
| Initial authorized call | 200 / 502 | 5515 / 1041 | 0 | 10.157 s | Unsupported monetary assertion; original candidate was not retained, so the precise assertion is unknown. |
| Approved diagnostic retest | 200 / 502 | 5515 / 1057 | 5376 | 5.940 s | Candidate described one posting and a held duplicate but classified shared intent as independently authorized instructions; cited bare `financial_verification`, which is not an actual source ID. |
| Approved final retest | 200 / 502 | 5639 / 1071 | 0 | 7.931 s | Candidate classified a duplicate request and suggested customer resubmission with uncertainty; still cited the invalid field name. It also said requests arrived four seconds apart when receipts were five seconds apart. |

The final candidate confused a completion-to-receipt interval with receipt-to-receipt chronology. Strict rejection prevented an invalid report from being presented as accepted. Dynamic citation enums and explicit receipt chronology were added **after** this final call and tested offline only. Their real model effectiveness is unverified.

Local ignored artifacts: `logs/phase2-live/CASE-000010.json`, `logs/phase2-retest/CASE-000010.json`, `logs/phase2-final/CASE-000010.json`, and optional candidate files under `logs/phase2-live/candidates`. These are rejected diagnostic candidates, not accepted investigation records. No API keys or request headers are saved in them.

## Financial evidence and uncertainty

Existing evidence: A CASE-000010 has one posted journal for SGD 25 and a held repeated request; B CASE-000011 has two postings of SGD 10 (SGD 20 total); C CASE-000009 has two postings of SGD 3.33 (SGD 6.66 total). Debit and credit totals are verified separately, never added to represent money moved. Two postings alone do not establish an erroneous duplicate.

Payment, request, event and journal source IDs remain citable. UNSTRUCTURED payloads remain empty; missing request outcomes remain NOT_RECORDED. Offline missing-history and redacted-intent copies preserve accounting facts and accept an explicitly uncertain causal response. These are scripted regression cases, not evidence that the real model reasons correctly about unseen causes.

## Verification

- Offline backend investigation suite: 55 discovered, 52 passed, 3 opt-in existing-case tests skipped.
- Frontend suite: 46 passed.
- Frontend production build: passed; existing React Router `use client` bundler notices remain nonfatal.
- `git diff --check`: passed.
- Opt-in existing-case suite: all 3 passed, retrieving current A/B/C evidence through GET and inspecting in-process FastAPI POSTs with a mocked OpenAI transport. No paid calls or source writes occurred in this check.

## Cost

Standard published pricing used for this estimate: $0.75/M input, $0.075/M cached input, $4.50/M output. Initial $0.00882075; diagnostic $0.00526395; final $0.00904875; total approximately **$0.02313345 USD**. This is an estimate, not a billing receipt. [Official model documentation](https://developers.openai.com/api/docs/models/gpt-5.4-mini).

## Integration and remaining limits

Frontend source/API integration compiles and existing frontend tests pass. A real accepted report has not traversed the browser end-to-end in this phase. Loading/error/session-history paths already existed; browser interaction was not newly verified here. Reports remain browser-tab session history, without durable backend persistence. Retry deduplication lasts five minutes in one backend process and does not survive restarts or span workers; calls without the optional request-ID header are not deduplicated. An explicit new investigation creates a new ID and can incur another charge.

Monetary checks recognize explicit currency-prefixed values and chronology checks recognize a bounded wording pattern. They do not prove that every natural-language assertion is supported or that a valid citation actually entails a claim. Analyst review remains required. No automatic financial remediation is implemented.

## Manual verification

From the repository root, start the backend with the existing configured environment:

```powershell
Set-Location backend
..\venv\Scripts\python.exe -m uvicorn main:app --host 127.0.0.1 --port 8000
```

In another terminal from the repository root:

```powershell
Set-Location frontend
npm.cmd run dev -- --host 127.0.0.1 --port 5173
```

Open only `http://localhost:5173`, sign in with the existing demo credentials and open an existing duplicate case. Viewing evidence is read-only. Starting an investigation invokes the paid provider; do not resume paid evaluations until the current failure and call budget have been reviewed. B and C remain gated on A succeeding. The runner refuses a repeated attempt in the same output directory; do not remove markers to bypass that safeguard.

Offline regression commands from the respective directories:

```powershell
# backend
..\venv\Scripts\python.exe -B -m unittest discover -s tests -p 'test_investigation*.py' -q
# frontend
npm.cmd test
npm.cmd run build
```
