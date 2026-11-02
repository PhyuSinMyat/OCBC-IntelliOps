# IntelliOps frontend

Shared header and responsive navigation for the three synthetic banking portals. Page bodies are placeholders; no backend data or authentication is connected yet.

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
