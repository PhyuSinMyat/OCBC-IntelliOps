import { defineConfig } from '@playwright/test';

// Read-only checks against the normal running app; never starts a fixture or migration.
export default defineConfig({
  testDir: './tests-ledger', workers: 1, timeout: 240000,
  expect: { timeout: 60000 },
  use: { baseURL: process.env.INTELLIOPS_LEDGER_UI_URL || 'http://127.0.0.1:5173', headless: true,
    launchOptions: { executablePath: process.env.INTELLIOPS_BROWSER_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' } },
});
