# IntelliOps frontend

The primary application mode is FastAPI/PostgreSQL-backed. Configure the public
`VITE_BANKING_API_URL` in `.env.local` (see `.env.example`), start the normal FastAPI
service, and run `npm.cmd run dev`. Open only the normal Vite URL. An empty API URL
explicitly selects the separate browser-only demonstration. Backend errors never
switch to that mode or import its browser records. See
[AUTHORITATIVE_BACKEND_REPORT.md](../AUTHORITATIVE_BACKEND_REPORT.md) for migration
status, diagnostics, exact startup commands and verification.

Payment Processing at `/payments/transactions` uses `src/portals/payment-processing/TransactionsPage.jsx`. It includes four derived KPI counts, sender/receiver details, initiation/completion timestamps, combined search/status/currency/date filters, sorting and pagination. The drawer has Overview, Processing History and Related Records tabs. Create Synthetic Payment opens a validated form with optional admin scenario controls. Filters persist in the browser tab. Missing journals and unavailable parties stay explicit.

Shared header and responsive navigation for the three synthetic banking portals. Accounts retains eight fictional accounts, search, filters and its details drawer. Balances and posted history derive from the same shared synthetic records displayed in Ledger Journals and Payments. Record links open matching details; unknown references show an unavailable state. Local simulation is the default. An optional authenticated backend connection supports controlled payment processing.

The initial transfers credit Alex Tan SGD 5,000.00 from Northstar Trading and debit SGD 3,500.00 to Maya Lim, resulting in SGD 44,000.00 from an unchanged SGD 42,500.00 opening balance. Ledger Journals offers a synthetic transfer form that updates shared records and account balances. Transfers require different active accounts, the same currency, a positive integer-cent amount and sufficient sender funds. Records survive portal navigation and browser refresh through localStorage. Account filters persist in the browser tab.

Balance rules use integer cents and include only balanced Posted journals whose entries match account and journal currencies. Draft, Pending, Failed and Reversed journals contribute nothing. This prototype uses exclusion for Reversed journals; it does not create compensating reversal postings. Payments without journals never affect balances. Existing backend scenario data is untouched.

Run financial-integrity checks from this directory with `node --test src/shared/data/bankingRecords.test.js`.

From this directory:

```powershell
npm.cmd install
npm.cmd run dev
```

Open the local URL printed by Vite. `npm.cmd` also works when PowerShell blocks `npm.ps1`.

```powershell
npm.cmd run build
```

`src/main.jsx` boots the app. Shared navigation and routes live in `src/app/`; portal pages live in `src/portals/intelliops/`, `src/portals/core-banking/`, and `src/portals/payment-processing/`. Reusable components live in `src/shared/components/`, synthetic records and their tests in `src/shared/data/`, and API clients in `src/shared/api/`. Shared styles remain in `src/styles.css`. Portal switching opens each portal's default page. Sidebar links, direct URLs, and browser history use React Router. Production hosting must rewrite unknown page paths to `index.html`.


Accounts distinguish customer ownership (Individual or Business) from account
products (Savings or Current). Business accounts use Current. Account references,
opening balances, statuses and original journal links are preserved. Combined
customer/product/status/currency filters, substring search, stable sorting, active
filter chips and reset are supported. Filters persist in sessionStorage and survive
drawer navigation. The register scrolls horizontally on narrow screens and
vertically for larger datasets. Sorting balances compares nominal amounts; use a
currency filter when comparing balances. No exchange-rate conversion is performed.

To connect every source-record portal to the database, apply the backend migration
and explicit seed, start FastAPI on 127.0.0.1:8000, and set
`VITE_BANKING_API_URL=/backend` in frontend/.env.local. Restart Vite. The dev
proxy forwards /backend to FastAPI. Production hosting needs an equivalent proxy.
Connected mode loads shared source records and server-calculated balances. It requests a configured ANALYST or ADMIN demo token and validates payment operations on the backend.
Loading or connection errors are shown explicitly; local data is not substituted.
The shared snapshot refreshes after payment creation or detection. The legacy ledger transfer form remains local-only; use Create Synthetic Payment for controlled backend posting. The local transfer form
continues to work in the default simulation mode and never writes to a database.

Tests:

```powershell
npm.cmd test
npx.cmd playwright install chromium
npm.cmd run test:e2e
```

Playwright is a development-only dependency. Set INTELLIOPS_BROWSER_PATH to use an
existing compatible Chromium executable. Browser tests cover columns, badges,
combined filters, sorting, empty/reset states, drawer focus and history links,
transfer persistence, and the mobile table scroll region.


The complete payment workflow, API contracts, role configuration, scenario semantics and migration notes are documented in [backend/PAYMENTS.md](../backend/PAYMENTS.md). The transaction drawer has Overview, Processing History and Related Records tabs. Payment creation supports decimal-safe validation, idempotent submission and five controlled admin scenarios. Date filters use Singapore dates and the shared simulation clock; the table paginates in stable groups of ten. Pending and Processing counts remain distinct. Detection is explicit and cutoff-aware. It creates cases from source evidence, with links to the Exception Center, evidence review and audit actions. AI orchestration and automated resolution remain unconnected.

Run `npm.cmd run test:connected` to test the frontend against a real FastAPI process with an isolated migrated SQLite database. This test uses loopback ports 4180 and 8191 and test-only demo credentials.
