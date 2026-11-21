import { test, expect } from '@playwright/test';

for (const [code, postings] of [['CUSTOMER_DOUBLE_CLICK', 1], ['AUTOMATIC_RETRY_FAILURE', 2], ['LEGITIMATE_REPEATED_PAYMENTS', 2]]) {
  test(`connected ${code} persists two requests and detects a pair`, async ({ page }) => {
    await page.addInitScript(() => sessionStorage.setItem('intelliops-api-token', 'integration-test-analyst-only'));
    await page.goto('/payments/transactions');
    await page.getByRole('button', { name: 'Create Synthetic Payment', exact: true }).click();
    await page.getByLabel('Sender account', { exact: true }).selectOption('ACC-100003');
    await page.getByLabel('Receiver account', { exact: true }).selectOption('ACC-100001');
    await page.getByLabel('Amount', { exact: true }).fill('137.25');
    await page.getByLabel('Exception type').selectOption('DUPLICATE');
    await page.getByLabel('Duplicate Transaction Scenario').selectOption(code);
    const pending = page.waitForResponse(r => r.url().endsWith('/api/demo/payments/scenario') && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Submit Synthetic Payment' }).click();
    const response = await pending;
    expect(response.status()).toBe(201);
    const result = await response.json();
    expect(result.postingCount).toBe(postings);
    expect(new Set(result.requestIds).size).toBe(2);
    const summary = page.getByRole('region', { name: 'Generated payment results' });
    await expect(summary).toContainText(`${postings} confirmed postings`);
    await summary.getByRole('button', { name: 'Run Detection' }).click();
    await expect(page.getByRole('status')).toContainText('Detection completed');
    await page.goto('/payments/transactions?transaction=' + result.paymentReferences[1]);
    await expect(page.getByRole('dialog')).toContainText(result.requestIds[1]);
    await page.getByRole('tab', { name: 'Related Records' }).click();
    await page.getByRole('link', { name: 'Open IntelliOps Case' }).first().click();
    await expect(page.getByRole('dialog')).toContainText('SUSPECTED_DUPLICATE');
    await expect(page.getByRole('dialog')).toContainText('NOT_ESTABLISHED');
    for (const ref of result.paymentReferences) await expect(page.getByRole('dialog')).toContainText(ref);
  });
}
