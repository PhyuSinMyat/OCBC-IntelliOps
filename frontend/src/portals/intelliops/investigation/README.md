# Duplicate Transaction Investigation

The existing route is `/intelliops/investigation?case=CASE-…`. Exception Center's
**Open Investigation** link passes the complete return URL through router state.
Opening the sidebar route without a case shows an empty state, not another queue.
Other exception types display a supported-state placeholder and case evidence.

## Prototype boundaries

- `analysis.js` collects a frozen subset of existing shared records and runs
  deterministic checks. It excludes scenario codes and scenario-injection audits.
- `service.js` is the integration seam for future FastAPI start/status/report APIs.
  Its queued/collection/analysis stages are explicitly simulated. No LLM is called.
- `CommandCenter.jsx` renders the diagnosis hero, summary findings, dual payment
  paths, compact causal timeline, financial impact and expandable Evidence Explorer.
  `presentation.js` derives these displays from saved reports without changing
  their diagnosis or financial classifications. No generated prose is parsed.
- Payment comparisons stay inside Evidence Explorer. Individual execution stages
  open the shared right-side drawer with source event details; the full trace and
  history also use that drawer. Actual case details return to Exception Center's
  existing drawer. No second case-management interface is created.
- Reports, failed runs and Resolution handoffs are saved separately from banking
  records in **sessionStorage** under `intelliops-investigations-prototype-v2`.
  They survive navigation and reload in the same tab. They are not server records
  or cross-user history. Source context distinguishes local, backend and fixtures.
- Runs continue during client-side navigation. A page reload interrupts an active
  simulated run and presents an explicit retry. It never automatically reruns AI.
- Resolution handoff opens the existing Workflows route with `case` and
  `investigation` query parameters. That route displays a proposal receipt with
  the complete saved report and evidence references. Planner/policy execution is
  not implemented. Existing Workflows navigation without a handoff is preserved.

## Evidence criteria

Confirming the same intended instruction requires a source original-payment link
or shared business reference **and** matching known parties, amount and currency.
Conflicting original links prevent confirmation. Separately verified business
references can establish legitimate repeated instructions.

Posted execution requires linked, posted, balanced journals with valid positive
same-currency entries for the expected accounts and amount. Invalid additional
journals prevent a complete execution assessment. A journal cannot be counted
twice as two distinct postings. Missing journals alone mean unknown execution.

The existing simulator's `DUPLICATE_BLOCKED` event, Pending status, absence of
processing-start events and absence of linked journals support a held-before-
execution assessment within the snapshot. Recheck current state before resolution.
The simulator does not record acknowledgment-timeout/retry correlation: its report
therefore leaves the request-generation cause unknown. A timeout diagnosis requires
explicitly correlated timeout and later retry events for the two payments.

## Isolated development fixtures

Expand **Development examples** on the empty investigation page, or use:

- `?fixture=prevented`: correlated timeout/retry, one posting and a recorded hold.
- `?fixture=double`: same instruction, two distinct postings; trigger unknown.
- `?fixture=legitimate`: separate verified instructions, two postings.
- `?fixture=uncertain`: execution unverified; no automatic retry or reversal.

Fixtures never populate the shared banking store. Their references are displayed
as fixtures instead of linking to nonexistent records in the source portals.
Shared cases retain working payment and journal links. **Prototype run controls**
can fail the next new run at ledger collection; retry creates a separate run.

The backend should ultimately determine evidence strength, classifications and
snapshot scope. Required report fields are defined by the object returned from
`analyzeSnapshot`, enriched by run IDs, timestamps and status in `service.js`.

## Verification

`npm.cmd test` includes evidence-classification tests. Browser tests in
`tests/investigation.spec.js` cover actual shared-case navigation, fixtures,
history, persistence, retry, interrupted runs, handoff and mobile layout.
Use the existing `INTELLIOPS_BROWSER_PATH` setting when running Playwright against
an installed browser rather than Playwright's bundled Chromium.

## Durable-history integration

The backend store and the accepted A/B/C reports are deployed in development.
The earlier session-only roadmap above describes the legacy/prototype adapter.
See the [teammate handoff](../../../../../docs/AI_INVESTIGATION_HANDOFF.md) for
current GET-based history, snapshot staleness, environment setup, offline tests
and opt-in browser verification. Do not rerun the deployed SQL. Refresh/history
reads do not start a model call; Resolution handoff remains a proposal only.
