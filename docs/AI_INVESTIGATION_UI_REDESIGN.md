# AI Investigation workspace redesign

The existing long command-center page now opens on Summary, with separate Evidence and History tabs. Case identity, report identifiers, completion time and snapshot freshness remain visible. Tab changes and report selection do not invoke inference.

## Implementation

- `frontend/src/portals/intelliops/AIInvestigation.jsx`: integrates tabs, saved history selection, report context and existing handoff into the current React Router workspace.
- `frontend/src/portals/intelliops/investigation/WorkspaceSections.jsx`: financial overview, key source timeline, visible analyst attention, saved history and selectable citation explorer.
- `frontend/src/portals/intelliops/investigation/CommandCenter.jsx`: concise conclusion and proposal action panel; full supporting action rationale remains disclosed.
- `frontend/src/portals/intelliops/investigation/presentation.js`: classification-based readable conclusions without case-specific logic.
- `frontend/src/portals/intelliops/investigation.css`: scoped neutral surfaces, brand red controls, desktop columns, responsive stacking and keyboard focus styles.
- `frontend/tests/investigation-workspace.spec.js`: offline accepted-report regression and responsive browser coverage.

Summary prioritizes conclusion, deterministic financial totals, recommended next step, six source milestones and visible uncertainties. Evidence retains original diagnosis, facts, hypotheses, trace, comparison, ledger records, citation sources and the complete saved report. History lists status, freshness, model, action, flags and report identity, and opens existing reports.

## Existing integrations preserved

The unchanged service uses GET `/api/exceptions/{case}/investigations?limit=20&offset=...` for history and POST `/api/exceptions/{case}/investigations` only through explicit start/retry actions. Case fetching, authentication, current routing, source record links and `sendToResolution` proposal handoff are reused. Backend, database and financial processing were not changed.

Amounts use structured financial verification fields, with separate sender debit and receiver credit. Excess is not inferred from narrative or journal count. No confidence percentage or loss is invented. Unresolved sources have an explicit unavailable fallback, and complete source payloads are disclosed on demand. Hypotheses remain labeled as interpretations.

## Verification

- Existing unit suite: 61 passed.
- Production build: passed (existing React Router directive warnings only).
- New Playwright suite: 2 passed, covering accepted A/B/C reports, separate financial totals, default Summary, tab changes, citation resolution, saved history selection, refresh without writes, and proposal-only handoff.
- Browser widths: 1440, 1024 and 390 pixels; overflow checks passed and screenshots saved to frontend/test-results. Desktop and mobile screenshots visually inspected.
- Browser used the existing installed Chromium through INTELLIOPS_BROWSER_PATH. The Playwright default browser revision was unavailable.

Browser verification used accepted report fixtures injected only in test session storage. API requests were blocked. It did not connect to shared Supabase, create records or invoke OpenAI. Live backend availability, durable pagination and real authentication were not end-to-end exercised. Existing legacy browser assertions targeting the previous single-page hierarchy require migration to the tabs; the new suite exercises the redesigned flow.

No commit, push or deployment was performed. Existing unrelated deleted root verification JSON files were left untouched.

## Second-pass refinement — 13 November 2026

The second pass retains the workspace and service architecture. The audit found a 272px application sidebar, repeated bordered white sections, 10–13px metadata, 22px conclusions and a large expanded uncertainty list. At 1280px the investigation content had roughly 940px available. Changes stay scoped to that existing content area.

The refinement introduces a dedicated `frontend/src/portals/intelliops/investigation-refinement.css` and replaces the first-pass appended overrides in `investigation.css`. The page title is 29px, primary conclusion 23–28px, financial values 27–35px, section headings 16–19px, body 14–15px and metadata mostly 12–13px. The header is more compact, financial metrics sit directly on the neutral workspace, the conclusion has a restrained emerald accent, and the action sits on a distinct neutral surface. Brand red remains concentrated on the primary proposal control and selected tabs.

`WorkspaceSections.jsx` adds reusable `PaymentRelationshipFlow`, `EvidencePanel` and `InvestigationSkeleton` components. The flow resolves requests by source payment references, checks integrity before displaying a shared instruction, requires valid distinct authorization and instruction IDs for distinct paths, and only labels a retry when the explicit retry linkage is validated. Held and posted outcomes use the existing financial assessments. Individual source amounts appear separately from aggregated debit and credit metrics.

The attention panel keeps every explicit review flag and freshness warning visible. Routine uncertainties and validation notes have two short previews, accurate counts and expandable full text. Evidence adds working subsection links, separate disclosures for facts versus hypotheses, collapsed citation lists, model metadata, full execution paths and raw reports. The source explorer supports identifier search and source-type filtering, with retained copy and unavailable-source behavior. `ReportSections.jsx` adds expandable complete event payloads. History uses a selected-report accent and clearer date, diagnosis and secondary model hierarchy. Refresh is shown only where backend history retrieval is available. Current report context stays above the content on all tabs.

Controls have visible keyboard focus and restrained transitions; reduced-motion preference disables transitions and animation. No dependency was added.

Second-pass changed files:
- `frontend/src/portals/intelliops/AIInvestigation.jsx`
- `frontend/src/portals/intelliops/investigation.css` (first-pass override block consolidated into the new stylesheet)
- `frontend/src/portals/intelliops/investigation-refinement.css`
- `frontend/src/portals/intelliops/investigation/WorkspaceSections.jsx`
- `frontend/src/portals/intelliops/investigation/CommandCenter.jsx`
- `frontend/src/portals/intelliops/investigation/ReportSections.jsx`
- `frontend/tests/investigation-workspace.spec.js`
- This implementation note

Verification: existing 61 unit tests passed; production build passed with the same React Router directive warnings. Three browser tests exercise accepted A/B/C flows, correct accounting totals, authorization and retry distinctions, history and reload without writes, citation search/filter/fallback, visible review flags and stale state, full uncertainty disclosure, keyboard tabs and proposal-only handoff. Summary, Evidence and History were captured and checked for horizontal overflow at 1920, 1440, 1280, 1024 and 390px. Screenshot files are in `frontend/test-results/investigation-{width}.png`, `investigation-evidence-{width}.png` and `investigation-history-{width}.png`. Actual desktop and mobile screenshots were visually inspected and informed a further disclosure refinement.

Limitations remain: browser checks use accepted offline fixtures, not live authentication or Supabase; live pagination and backend availability were not exercised. The legacy browser suite for the original long page was not migrated in this visual refinement. Long explanations remain available by expansion and can require scrolling. No backend code, prompts, records, schema, remediation or closure behavior changed; no OpenAI call, commit, push or deployment occurred.
