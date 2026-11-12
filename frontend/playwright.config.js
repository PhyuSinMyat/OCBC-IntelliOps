import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:4179',
    headless: true,
    launchOptions: process.env.INTELLIOPS_BROWSER_PATH ? { executablePath: process.env.INTELLIOPS_BROWSER_PATH } : {},
  },
  webServer: {
    env: { VITE_BANKING_API_URL: '' },
    command: 'npm.cmd run dev -- --host 127.0.0.1 --port 4179 --strictPort',
    url: 'http://127.0.0.1:4179',
    reuseExistingServer: !process.env.CI,
  },
});
