import { test, expect } from '@playwright/test';

async function fillPayment(page, scenario = 'NORMAL', amount = '100.00') {
  await page.getByRole('button', { name: 'Create Synthetic Payment', exact: true }).click();
  const form = page.getByRole('dialog');
  await form.getByLabel('Sender account', { exact: true }).selectOption('ACC-100003');
  await form.getByLabel('Receiver account', { exact: true }).selectOption('ACC-100001');
  await form.getByLabel('Amount', { exact: true }).fill(amount);
  if (scenario !== 'NORMAL') {
    await form.getByText('Advanced Simulation Options', { exact: true }).click();
    await form.getByLabel('Simulation Scenario').selectOption(scenario);
  }
}

test('normal payment validates fields and records actual history and balanced journal', async ({ page }) => {
  await page.goto('/payments/transactions');
  await fillPayment(page, 'NORMAL', '1.001');
  await page.getByRole('button', { name: 'Submit Synthetic Payment' }).click();
  await expect(page.getByRole('alert')).toContainText('two decimal');
  await page.getByLabel('Amount', { exact: true }).fill('100.00');
  await page.getByRole('button', { name: 'Submit Synthetic Payment' }).click();
  await expect(page.getByRole('dialog').getByRole('heading', { name: 'TXN-1003' })).toBeVisible();
  await expect(page.getByRole('dialog')).toContainText('Business');
  await page.getByRole('tab', { name: 'Processing History' }).click();
  await expect(page.getByRole('tabpanel')).toContainText('Processing completed');
  await expect(page.locator('.processing-timeline li')).toHaveCount(6);
  await page.getByRole('tab', { name: 'Related Records' }).click();
  await expect(page.getByRole('tabpanel')).toContainText('Debit total');
  await expect(page.getByRole('tabpanel')).toContainText('No linked exceptions.');
  await page.getByRole('link', { name: 'Open Ledger Journal' }).click();
  await expect(page.getByRole('dialog')).toContainText('Balanced');
  await page.goto('/core-banking/accounts');
  await expect(page.locator('tbody tr').filter({ hasText: 'Alex Tan' })).toContainText('SGD 44,100.00');
});

test('all source scenarios trace through detection, cases, investigation and audit without repairs', async ({ page }) => {
  await page.goto('/payments/transactions');
  await page.getByLabel('Local demo role').selectOption('ADMIN');
  let missingReference;
  for (const scenario of ['DUPLICATE', 'PROCESSING_FAILURE', 'MISSING_LEDGER', 'AMOUNT_MISMATCH', 'UNMATCHED']) {
    await fillPayment(page, scenario);
    await page.getByRole('button', { name: 'Submit Synthetic Payment' }).click();
    await expect(page.getByRole('tab', { name: 'Overview', exact: true })).toBeVisible();
    if (scenario === 'MISSING_LEDGER') missingReference = new URL(page.url()).searchParams.get('transaction');
    if (scenario === 'PROCESSING_FAILURE') {
      await page.getByRole('tab', { name: 'Processing History' }).click();
      await expect(page.getByRole('tabpanel')).toContainText('SIM_PROCESSING_ERROR');
      await expect(page.getByRole('tabpanel')).not.toContainText('Processing completed');
    }
    await page.getByRole('button', { name: 'Close details' }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();
  }
  await page.getByRole('button', { name: 'Advance Local Clock +61s' }).click();
  await page.getByRole('button', { name: 'Run Detection', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('5 new cases');
  await page.getByRole('button', { name: 'Run Detection', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('0 new cases');
  await page.goto('/payments/transactions?transaction=' + missingReference);
  await page.getByRole('tab', { name: 'Related Records' }).click();
  await expect(page.getByRole('tabpanel')).toContainText('No corresponding ledger journal found.');
  await page.getByRole('link', { name: 'Open IntelliOps Case' }).click();
  await expect(page.getByRole('dialog')).toContainText('Missing Ledger Posting');
  await expect(page.getByRole('dialog')).toContainText('OPEN');
  await page.getByRole('link', { name: 'Open Investigation' }).click();
  await expect(page.getByRole('heading', { name: 'AI Investigation', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Investigation not yet supported' })).toBeVisible();
  await page.getByRole('link', { name: 'View Case Details', exact: true }).first().click();
  await expect(page.getByRole('dialog')).toContainText('Source evidence');
  await page.goto('/intelliops/audit');
  await expect(page.locator('tbody')).toContainText('SCENARIO_INJECTED');
  await expect(page.locator('tbody')).toContainText('EXCEPTION_DETECTED');
});

test('pagination and combined date filters preserve source records and reset page', async ({ page }) => {
  await page.addInitScript(() => {
    const payments = Array.from({ length: 23 }, (_, n) => ({ id: `TXN-${n}`, senderId: 'ACC-100003', receiverId: 'ACC-100001', amountCents: n + 1, currency: 'SGD', status: n === 0 ? 'Pending' : 'Completed', createdAt: '2026-11-02T02:00:00Z' }));
    localStorage.setItem('intelliops-banking-records-v1', JSON.stringify({ payment_transactions: payments, ledger_entries: [], ledger_journals: [] }));
  });
  await page.goto('/payments/transactions');
  await expect(page.locator('tbody tr')).toHaveCount(10);
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Transaction pages' })).toContainText('Page 2 of 3');
  await page.getByLabel('Filter payments by status').selectOption('Pending');
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await expect(page.getByRole('navigation', { name: 'Transaction pages' })).toContainText('Page 1 of 1');
  const metrics = page.getByLabel('Payment summary');
  await expect(metrics.locator('.account-metric').filter({ has: page.getByText('Processing', { exact: true }) }).locator('strong')).toHaveText('0');
  await page.getByLabel('Payment date range').selectOption('custom');
  await page.getByLabel('Payment date from').fill('2026-11-03');
  await expect(page.getByRole('heading', { name: 'No transactions found' })).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(page.locator('tbody tr')).toHaveCount(10);
});
