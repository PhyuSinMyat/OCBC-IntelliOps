import { test, expect } from '@playwright/test';

test('payment register shows parties, filters, amounts and matching journal links', async ({ page }) => {
  await page.goto('/payments/transactions');
  await expect(page.getByRole('heading', { name: 'Transaction register' })).toBeVisible();
  await expect(page.getByRole('columnheader')).toHaveText(['Transaction ID', 'Sender', 'Receiver', 'Amount', 'Status', 'Initiated At', 'Completed At', 'Actions']);
  await page.getByLabel('Search transactions').fill('Northstar');
  await page.getByLabel('Filter payments by status').selectOption('Completed');
  await page.getByLabel('Filter payments by currency').selectOption('SGD');
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await expect(page.locator('tbody tr')).toContainText('Alex Tan');
  await expect(page.locator('tbody tr')).toContainText('SGD 5,000.00');
  await page.getByRole('button', { name: 'TXN-1001', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Northstar Trading Pte Ltd');
  await page.getByRole('tab', { name: 'Related Records' }).click();
  await page.getByRole('link', { name: 'Open Ledger Journal', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Backend connection required' })).toBeVisible();
});

test('payment sorting, empty state, reset and mobile scrolling work', async ({ page }) => {
  await page.goto('/payments/transactions');
  await page.getByLabel('Sort transactions').selectOption('amount-high');
  await expect(page.locator('tbody tr').first()).toContainText('TXN-1001');
  await page.getByLabel('Sort transactions').selectOption('amount-low');
  await expect(page.locator('tbody tr').first()).toContainText('TXN-1002');
  await page.getByLabel('Search transactions').fill('no-such-payment');
  await expect(page.getByRole('heading', { name: 'No transactions found' })).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(page.locator('tbody tr')).toHaveCount(2);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.getByRole('region', { name: 'Scrollable transaction register' }).evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
});

test('missing ledger postings and unavailable payment references remain explicit', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('intelliops-banking-records-v1', JSON.stringify({
      payment_transactions: [{ id: 'TXN-MISSING', senderId: 'ACC-100003', receiverId: 'ACC-100001', amountCents: 10000, currency: 'SGD', status: 'Failed', createdAt: '2026-11-02T02:00:00Z' }],
      ledger_journals: [], ledger_entries: [],
    }));
  });
  await page.goto('/payments/transactions');
  await page.getByRole('button', { name: 'TXN-MISSING', exact: true }).click();
  await page.getByRole('tab', { name: 'Related Records' }).click();
  await expect(page.getByRole('dialog')).toContainText('No corresponding ledger journal found.');
  await page.goto('/payments/transactions?transaction=UNKNOWN');
  await expect(page.getByRole('dialog')).toContainText('This record is unavailable');
});
