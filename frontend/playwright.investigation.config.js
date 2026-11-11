import { defineConfig } from '@playwright/test';

// Browser API responses are intercepted by this suite; no backend/database is started.
export default defineConfig({
  testDir: './tests-investigation', workers: 1,
  use: { baseURL: 'http://127.0.0.1:4183', headless: true,
    launchOptions: process.env.INTELLIOPS_BROWSER_PATH ? { executablePath: process.env.INTELLIOPS_BROWSER_PATH } : {} },
  webServer: { command: 'npm.cmd run dev -- --host 127.0.0.1 --port 4183 --strictPort',
    url: 'http://127.0.0.1:4183', reuseExistingServer: false,
    env: { VITE_BANKING_API_URL: '/backend' } },
});
