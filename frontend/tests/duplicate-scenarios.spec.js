import { test, expect } from '@playwright/test';

for (const [code, count, status] of [
  ['CUSTOMER_DOUBLE_CLICK', 1, 'Held'],
  ['AUTOMATIC_RETRY_FAILURE', 2, 'Completed'],
  ['LEGITIMATE_REPEATED_PAYMENTS', 2, 'Completed'],
]) {
  test(`browser-only ${code} is selectable and records the correct financial outcome`, async ({ page }) => {
    await page.addInitScript(() => sessionStorage.setItem('payment-demo-role', 'ADMIN'));
    await page.goto('/payments/transactions');
    await page.getByRole('button', { name: 'Create Synthetic Payment', exact: true }).click();
    await page.getByLabel('Sender account', { exact: true }).selectOption('ACC-100003');
    await page.getByLabel('Receiver account', { exact: true }).selectOption('ACC-100001');
    await page.getByLabel('Amount', { exact: true }).fill('137.25');
    await page.getByLabel('Exception type').selectOption('DUPLICATE');
    await expect(page.getByLabel('Duplicate Transaction Scenario')).toBeEnabled();
    await page.getByLabel('Duplicate Transaction Scenario').selectOption(code);
    await expect(page.getByRole('dialog')).toContainText('Local-only simulation');
    await page.getByRole('button', { name: 'Submit Synthetic Payment' }).click();
    const summary = page.getByRole('region', { name: 'Generated payment results' });
    await expect(summary).toContainText(`${count} confirmed postings`);
    const refs = await summary.locator('button.account-link').allTextContents();
    expect(refs).toHaveLength(2);
    await summary.getByRole('button', { name: 'Run Detection' }).click();
    await page.goto('/payments/transactions?transaction=' + refs[1]);
    await expect(page.getByRole('dialog')).toContainText(status);
    await expect(page.getByRole('dialog')).toContainText(code === 'AUTOMATIC_RETRY_FAILURE' ? 'SYSTEM' : 'CUSTOMER');
    await page.getByRole('tab', { name: 'Related Records' }).click();
    await page.getByRole('link', { name: 'Open IntelliOps Case' }).click();
    await expect(page.getByRole('dialog')).toContainText('SUSPECTED_DUPLICATE');
    await expect(page.getByRole('dialog')).toContainText('NOT_ESTABLISHED');
    await expect(page.getByRole('dialog')).toContainText(refs[0]);
    await expect(page.getByRole('dialog')).toContainText(refs[1]);
  });
}
