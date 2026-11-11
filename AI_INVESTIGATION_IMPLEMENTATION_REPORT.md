# Duplicate AI investigation implementation

Implemented a case-linked, read-only backend investigation and connected the existing React investigation page. No Supabase connections, shared seed runs, migrations, pushes or merges were performed. Existing detection changes on `feature/detection-improvements` were preserved.

## Flow and files

- `GET /api/exceptions/{case_id}/investigation-evidence` retrieves the case, original/repeated transactions, normalized instructions, source events, relevant accounts, journals, entries and legacy-posting indicators. `POST /api/exceptions/{case_id}/investigations` retrieves a fresh snapshot and requests an actual OpenAI structured analysis. Both use the existing bearer-token dependency.
- `backend/modules/intelliops/investigation_evidence.py` correlates explicit source links, verifies journal status/balance/currency/parties/amount/reference, and establishes conservative supported classifications. Missing or conflicting records remain unverified. Raw idempotency keys are replaced with hashes.
- `investigation_schemas.py`, `investigation_llm.py`, `investigation_service.py` and `investigation_router.py` implement strict output validation, source citations, evidence bounds, sanitized failures, and the authenticated endpoints. PostgreSQL snapshots use a read-only repeatable-read transaction, released before the model call.
- `frontend/src/portals/intelliops/AIInvestigation.jsx` retrieves the case from its URL, including when absent from the shared snapshot. `investigation/service.js` calls the backend for connected cases. Existing command-center components display the canonical diagnosis, verified financial impact, model findings/hypotheses, citations, uncertainty and proposed action.

The provider uses [OpenAI Responses structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses), with `store: false`, no tools and no financial execution permissions. Classifications/action codes must agree with verified evidence bounds; facts/hypotheses must cite available record IDs and causal findings must include the required source-event citations. Free-text model explanations still require analyst review: schema/citation validation alone cannot prove every natural-language assertion.

## Minimum authoritative source evidence

Existing `processing_events.details` TEXT can carry strict JSON; no schema migration is needed. This implementation consumes these records, but does not fabricate them or add new event producers.

| Scenario | Required evidence | Result and proposal |
|---|---|---|
| A: customer double submission | One `CLIENT_SUBMISSION` per request, `origin: CUSTOMER`, `trigger: USER_SUBMIT`, same nonempty `intent_id`, distinct `submission_id`; matching payment parties/amount/currency; verified original posting and duplicate hold without execution | `CUSTOMER_DOUBLE_SUBMISSION`, `SINGLE_POSTING_CONFIRMED`; review closure of held duplicate, no refund |
| B: automatic retry/control failure | Explicit original-payment relationship; correlated original `ACK_TIMEOUT`, duplicate `RETRY_SUBMITTED` and `IDEMPOTENCY_CHECK_FAILED`, `origin: SYSTEM`, common `correlation_id`, retry `trigger: AUTOMATIC_RETRY`, matching `original_payment_ref`; chronological timeout/retry/failure; duplicate processing events; two distinct verified journals | `IDEMPOTENCY_CONTROL_FAILURE`, `DOUBLE_POSTING_CONFIRMED`; escalate for controlled human review and approval |
| C: legitimate repeated payments | Each request has exactly one completed `PAYMENT_AUTHORIZED` event with `authorized: true`, distinct nonempty `authorization_id` and `intent_id`, normalized instructions, no contradictory direct original-payment link | `LEGITIMATE_REPEATED_PAYMENT`; with both postings verified, review false-positive closure without reversal |
| Historical CASE-000004 pattern | Original completed/posted, repeated request held, direct original link, no authoritative cause events | `CONFIRMED_DUPLICATE_REQUEST`, `SINGLE_POSTING_CONFIRMED`, **`CAUSE_NOT_ESTABLISHED`** |

Supported optional JSON keys are `origin`, `trigger`, `intent_id`, `submission_id`, `authorization_id`, `authorized`, `correlation_id`, `original_payment_ref`. Unknown keys, invalid JSON/types or missing identifiers do not establish a cause. Similar timestamps, amounts, scenario labels and instruction rows alone do not prove customer intent. Historical Supabase CASE-000004 was not queried or changed; its evidence pattern is covered by an isolated test.

## Configuration and use

1. Install runtime dependencies: from `backend`, run `.\.venv\Scripts\python.exe -m pip install -r requirements.txt`.
2. Set `OPENAI_API_KEY` and `OPENAI_MODEL` in backend `.env` only. Choose an available model supporting Responses structured outputs. Optional `INTELLIOPS_LLM_TIMEOUT_SECONDS` defaults to 45, bounded to 1–120 seconds. Do not put provider credentials in frontend variables.
3. Start the existing backend and frontend with their normal database and authenticated frontend connection configuration. This change requires no new migration or seed command.
4. Open Exception Center's investigation link, or `/intelliops/investigation?case=CASE-000004`, then select **Start AI Investigation**. Evidence is sent to the configured external model only after this request.

Provider missing configuration returns 503, provider/invalid result errors 502, and timeout 504. Unsupported exception types return 409. No error silently invokes the prototype. Explicit development fixtures and disconnected prototype mode remain labeled as simulations.

Reports/history persist in this browser tab's session storage, with a distinct backend scope; navigation and refresh retain completed reports. A refresh during an unfinished request marks it interrupted and requires explicit retry. There is no durable database investigation history or cross-device persistence. Existing proposal handoff remains a browser-side handoff; no resolution/approval execution was added.

## Validation

- Backend discovery: **64 passed, 2 optional PostgreSQL tests skipped** (66 total). Eleven new investigation test methods cover A/B/C and historical baseline, missing/invalid source evidence, missing independent authorization, conflicting original links, invalid ledger entries, required causal citations, invented citations/unsupported model classifications, authentication, provider failure, timeout, refusal and malformed/incomplete results. Before/after fingerprints verify all isolated source tables remain unchanged.
- Frontend unit suite: **29 passed**. Production Vite build passed.
- Isolated connected-mode browser suite: **2 passed**, with every backend call intercepted: case retrieval outside the snapshot, backend POST, visible model evidence, refresh/navigation persistence and explicit failure without fallback.
- Existing prototype investigation browser suite: **8 passed**, including historical unknown cause, saved reports, history/handoff, mobile layout, keyboard access and interruption handling; backend connectivity was explicitly disabled.

No configured OpenAI credentials were available for a live provider call. Provider tests use explicit mocked HTTP responses against the real adapter; browser tests use explicit test responses. Real model availability, provider acceptance of the configured model and live latency remain to be verified after backend credentials are configured. No production/shared data was used in these tests.

Reproduce from `backend`: `.\.venv\Scripts\python.exe -m unittest discover -s tests -q`. From `frontend`: `npm test`, `npm run build`, and `npx playwright test --config playwright.investigation.config.js` (set `INTELLIOPS_BROWSER_PATH` if required). Run prototype browser tests with `VITE_BANKING_API_URL` explicitly empty.
