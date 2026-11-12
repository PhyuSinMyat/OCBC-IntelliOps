import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';

const reports = JSON.parse(readFileSync(new URL('../../backend/tests/fixtures/accepted_investigation_reports.json', import.meta.url)));
const token = process.env.INTELLIOPS_ADMIN_TOKEN;

test('deployed Supabase history reopens across refresh and fresh contexts using GET only', async ({ browser }) => {
  test.skip(process.env.INTELLIOPS_VERIFY_DEPLOYED_HISTORY !== '1', 'Explicit GET-only deployed-history verification opt-in');
  expect(token).toBeTruthy();
  const stats = { providerRequests: 0, mutationRequests: [], historyGets: 0, cases: [] };
  for (const [caseId, expected] of Object.entries(reports)) {
    const context = await browser.newContext({ baseURL: process.env.INTELLIOPS_LEDGER_UI_URL || 'http://127.0.0.1:5173' });
    await context.addInitScript(t => sessionStorage.setItem('intelliops-api-token', t), token);
    await context.route('**/api.openai.com/**', route => { stats.providerRequests++; return route.abort(); });
    await context.route('**/api/**', route => {
      const request = route.request();
      if (request.method() !== 'GET') { stats.mutationRequests.push(new URL(request.url()).pathname); return route.abort(); }
      if (/\/investigations(?:\?|$)/.test(request.url())) stats.historyGets++;
      return route.continue(); // No report fixtures or mocked history in this test.
    });
    const page = await context.newPage();
    await page.goto('/intelliops/exceptions?case=' + caseId);
    await page.getByRole('link', { name: 'Open Investigation', exact: true }).click();
    await expect(page.locator('#cc-diagnosis-title')).toHaveText(expected.root_cause_title);
    await expect(page.getByText('Saved investigation snapshot', { exact: false })).toBeVisible();
    await page.getByText('Verified financial totals', { exact: true }).click();
    const total = expected.financial_impact.validDebitTotals.SGD;
    await expect(page.getByText(`Debit: SGD ${total} / Credit: SGD ${total}`, { exact: true })).toBeVisible();
    await expect(page.locator('.cc-next code')).toHaveText(expected.recommended_action_code);
    await page.getByRole('button', { name: 'View Investigation History', exact: true }).click();
    await page.getByRole('button', { name: 'Open saved report', exact: true }).click();
    await page.reload();
    await expect(page.locator('#cc-diagnosis-title')).toHaveText(expected.root_cause_title);
    await expect(page.getByText('Saved investigation snapshot', { exact: false })).toBeVisible();
    await page.getByRole('button', { name: 'Send to Resolution', exact: true }).click();
    await expect(page.getByText('No action has been approved or executed.', { exact: false })).toBeVisible();
    stats.cases.push({ caseId, titleVerified: true, totalsVerified: true, refreshVerified: true, handoffOnly: true });
    await context.close();
  }
  expect(stats.providerRequests).toBe(0); expect(stats.mutationRequests).toEqual([]);
  expect(stats.historyGets).toBeGreaterThanOrEqual(6);
  writeFileSync(new URL('../../logs/phase2-persistence-deployment/browser-verification.json', import.meta.url), JSON.stringify(stats, null, 2));
});
