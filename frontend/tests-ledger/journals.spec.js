import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
const token = process.env.INTELLIOPS_ADMIN_TOKEN;
const api = process.env.INTELLIOPS_LEDGER_API_URL || 'http://127.0.0.1:8000';
const runs = JSON.parse(readFileSync(new URL('../../SUPABASE_SCENARIO_VERIFICATION.json', import.meta.url))).scenarios;
const money = cents => `SGD ${(cents / 100).toLocaleString('en-SG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
test.beforeEach(async ({ page }) => {
  if (!token) throw new Error('Supply the existing backend ADMIN token via the test process environment.');
  await page.addInitScript(t => { sessionStorage.setItem('intelliops-api-token', t); localStorage.setItem('intelliops-banking-records-v1', JSON.stringify({ payment_transactions: [{ id: 'BROWSER-POISON' }], ledger_journals: [{ id: 'BROWSER-POISON' }], ledger_entries: [] })); }, token);
  await page.route('**/api/**', route => route.request().method() === 'GET' ? route.continue() : route.abort());
});

test('real FastAPI records: A/B/C entries, independent expansion, totals, filters, refresh and links', async ({ page, request }) => {
  const response = await request.get(api + '/api/banking-snapshot', { headers: { Authorization: 'Bearer ' + token } });
  expect(response.status()).toBe(200); const before = await response.json();
  await page.goto('/core-banking/journals');
  await expect(page.getByRole('heading', { name: 'Journal register' })).toBeVisible();
  await expect(page.locator('tr[data-journal-id]')).toHaveCount(before.ledger_journals.length);
  await expect(page.locator('.journal-expanded')).toHaveCount(0);
  for (const run of runs) {
    expect(run.journalReferences).toHaveLength(run.scenario === 'A' ? 1 : 2);
    if (run.scenario === 'A') expect(before.ledger_journals.some(journal => journal.sourcePaymentId === run.paymentReferences[1])).toBe(false);
    for (const ref of run.journalReferences) {
      const journal = before.ledger_journals.find(j => j.id === ref); expect(journal).toBeTruthy();
      const entries = before.ledger_entries.filter(e => e.journalId === ref); expect(entries).toHaveLength(2);
      const parent = page.locator('tr[data-journal-id]').filter({ has: page.getByRole('button', { name: ref, exact: true }) });
      await expect(parent).toContainText(ref);
      await expect(parent.getByRole('link')).toHaveAttribute('href', '/payments/transactions?transaction=' + (journal.sourcePaymentId || journal.paymentId));
      for (const entry of entries) await expect(parent).toContainText(before.accounts.find(a => a.id === entry.accountId).customer);
      await page.getByRole('button', { name: 'Expand ' + ref, exact: true }).click();
      const section = page.getByRole('region', { name: 'Journal Entries for ' + ref, exact: true });
      await expect(section.getByText('Balanced', { exact: true })).toBeVisible();
      await expect(section.locator('tbody tr')).toHaveCount(2);
      for (const entry of entries) {
        const row = section.locator('tbody tr').filter({ hasText: entry.id }); await expect(row).toHaveCount(1);
        await expect(row.locator('td').nth(entry.side === 'Debit' ? 4 : 5)).toHaveText(money(entry.amountCents));
        await expect(row.locator('td').nth(entry.side === 'Debit' ? 5 : 4)).toHaveText('—');
      }
      await expect(section.locator('tfoot')).toContainText(money(entries[0].amountCents));
      expect(await parent.evaluate(el => el.nextElementSibling.classList.contains('journal-expanded'))).toBe(true);
    }
  }
  await expect(page.locator('.journal-expanded')).toHaveCount(5);
  const ref = runs[1].journalReferences[0];
  await page.getByLabel('Search journals', { exact: true }).fill(ref);
  await expect(page.locator('tr[data-journal-id]')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Collapse ' + ref, exact: true })).toHaveAttribute('aria-expanded', 'true');
  await page.getByLabel('Sort journals').selectOption('reference');
  await page.getByRole('button', { name: 'Refresh journals', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Refresh journals', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Collapse ' + ref, exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Collapse ' + ref, exact: true }).click();
  await expect(page.locator('.journal-expanded')).toHaveCount(0);
  await page.getByLabel('Search journals', { exact: true }).fill('Synthetic Authoritative Backend Verification');
  await page.getByLabel('Filter journals by status').selectOption('Posted');
  const holderAccounts = new Set(before.accounts.filter(account => account.customer === 'Synthetic Authoritative Backend Verification').map(account => account.id));
  const holderJournals = new Set(before.ledger_entries.filter(entry => holderAccounts.has(entry.accountId)).map(entry => entry.journalId));
  const expectedMatches = before.ledger_journals.filter(journal => journal.status === 'Posted' && holderJournals.has(journal.id)).length;
  await expect(page.locator('tr[data-journal-id]')).toHaveCount(expectedMatches);
  await page.getByLabel('Search journals', { exact: true }).fill('no-such-journal');
  await expect(page.getByRole('heading', { name: 'No journals match your filters' })).toBeVisible();
  await page.getByRole('button', { name: 'Reset filters' }).click();
  await page.reload(); await expect(page.locator('tr[data-journal-id]')).toHaveCount(before.ledger_journals.length);
  await expect(page.getByText('BROWSER-POISON', { exact: true })).toHaveCount(0);
  await page.goto('/core-banking/journals?journal=' + ref);
  await expect(page.getByRole('dialog')).toContainText(ref);
  await expect(page.getByRole('dialog').getByRole('link', { name: 'Open Payment Transaction' })).toBeVisible();
  await page.getByRole('button', { name: 'Close details' }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '../logs/journal-reference/implemented-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: 'Expand ' + ref, exact: true }).click();
  await page.screenshot({ path: '../logs/journal-reference/implemented-expanded.png', fullPage: true });
  const after = await (await request.get(api + '/api/banking-snapshot', { headers: { Authorization: 'Bearer ' + token } })).json();
  for (const key of ['accounts', 'payment_transactions', 'ledger_journals', 'ledger_entries']) expect(after[key]).toEqual(before[key]);
});

test('loading, empty, initial API failure and recovery never display browser records', async ({ page }) => {
  await page.route('**/api/banking-snapshot', async route => { await new Promise(resolve => setTimeout(resolve, 1000)); await route.fulfill({ status: 503, json: { detail: 'Read-only verification: database unavailable.' } }); });
  await page.goto('/core-banking/journals');
  await expect(page.getByRole('status')).toContainText('Loading banking records');
  await expect(page.getByRole('heading', { name: 'Banking records unavailable' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('database unavailable');
  await expect(page.getByText('BROWSER-POISON', { exact: true })).toHaveCount(0);
  await page.unroute('**/api/banking-snapshot');
  await page.getByRole('button', { name: 'Retry connection' }).click();
  await expect(page.getByRole('heading', { name: 'Journal register' })).toBeVisible();
  await page.route('**/api/banking-snapshot', async route => { const response = await route.fetch(); const data = await response.json(); await route.fulfill({ json: { ...data, ledger_journals: [], ledger_entries: [] } }); });
  await page.getByRole('button', { name: 'Refresh journals', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'No ledger journals yet' })).toBeVisible();
  await page.unroute('**/api/banking-snapshot');
  await page.route('**/api/banking-snapshot', route => route.fulfill({ status: 503, json: { detail: 'Read-only verification refresh failed.' } }));
  await page.getByRole('button', { name: 'Refresh journals', exact: true }).click();
  await expect(page.locator('.journal-error')).toContainText('refresh failed');
  await expect(page.locator('tr[data-journal-id]')).toHaveCount(0);
});
