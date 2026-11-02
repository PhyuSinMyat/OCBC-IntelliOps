# IntelliOps frontend

Shared header and responsive navigation for the three synthetic banking portals. Accounts retains eight fictional accounts, search, filters and its details drawer. Balances and posted history derive from the same in-memory synthetic records displayed in Ledger Journals and Payments. Record links open matching details; unknown references show an unavailable state. Backend data and authentication are not connected.

The initial transfers credit Alex Tan SGD 5,000.00 from Northstar Trading and debit SGD 3,500.00 to Maya Lim, resulting in SGD 44,000.00 from an unchanged SGD 42,500.00 opening balance. Ledger Journals offers a synthetic transfer form that updates shared records and account balances. Transfers require different active accounts, the same currency, a positive integer-cent amount and sufficient sender funds. Records survive portal navigation but reset on browser refresh. Account filters persist in the browser tab.

Balance rules use integer cents and include only balanced Posted journals whose entries match account and journal currencies. Draft, Pending, Failed and Reversed journals contribute nothing. This prototype uses exclusion for Reversed journals; it does not create compensating reversal postings. Payments without journals never affect balances. Existing backend scenario data is untouched.

Run financial-integrity checks from this directory with `node --test src/bankingRecords.test.js`.

From this directory:

```powershell
npm.cmd install
npm.cmd run dev
```

Open the local URL printed by Vite. `npm.cmd` also works when PowerShell blocks `npm.ps1`.

```powershell
npm.cmd run build
```

Routes are defined in `src/main.jsx`; shared styles are in `src/styles.css`. Portal switching opens each portal's default page. Sidebar links, direct URLs, and browser history use React Router. Production hosting must rewrite unknown page paths to `index.html`.
