import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests-connected',
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:4180', headless: true, launchOptions: process.env.INTELLIOPS_BROWSER_PATH ? { executablePath: process.env.INTELLIOPS_BROWSER_PATH } : {} },
  webServer: [
    { command: '..\\venv\\Scripts\\python.exe ..\\backend\\tests\\serve_demo.py', url: 'http://127.0.0.1:8191/health', reuseExistingServer: false },
    { command: 'npm.cmd run dev -- --host 127.0.0.1 --port 4180 --strictPort', url: 'http://127.0.0.1:4180', reuseExistingServer: false,
      env: { VITE_BANKING_API_URL: '/backend', INTELLIOPS_BACKEND_TARGET: 'http://127.0.0.1:8191' } },
  ],
});
