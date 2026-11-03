import { test, expect } from '@playwright/test';

test('normal 5000 transfer retains journal and payment identity across browser history', async ({ page }) => {
  await page.goto('/payments/transactions');
  await page.getByRole('button', { name: 'Create Synthetic Payment', exact: true }).click();
  await page.getByLabel('Sender account', { exact: true }).selectOption('ACC-100003');
  await page.getByLabel('Receiver account', { exact: true }).selectOption('ACC-100002');
  await page.getByLabel('Amount', { exact: true }).fill('5000.00');
  await page.getByRole('button', { name: 'Submit Synthetic Payment' }).click();
  await expect(page.getByRole('dialog')).toContainText('SGD 5,000.00');
  const paymentUrl = page.url();
  const payment = new URL(paymentUrl).searchParams.get('transaction');
  await page.getByRole('tab', { name: 'Related Records' }).click();
  await page.getByRole('link', { name: 'Open Ledger Journal', exact: true }).click();
  const journalUrl = page.url();
  const journal = new URL(journalUrl).searchParams.get('journal');
  await expect(page.getByRole('dialog').getByRole('heading', { name: journal, exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toContainText('Debit: SGD 5,000.00');
  await expect(page.getByRole('dialog')).toContainText('Credit: SGD 5,000.00');
  await page.reload();
  await expect(page.getByRole('dialog')).toContainText(journal);
  await page.goBack();
  await expect(page).toHaveURL(paymentUrl);
  await expect(page.getByRole('dialog')).toContainText(payment);
  await page.goForward();
  await expect(page).toHaveURL(journalUrl);
  await page.getByRole('dialog').getByRole('link', { name: 'Open Payment Transaction', exact: true }).click();
  await expect(page).toHaveURL(paymentUrl);
});

test('account selection and balance breakdown survive refresh and direct links', async ({ page }) => {
  await page.goto('/core-banking/accounts');
  await page.getByRole('button', { name: 'ACC-100001', exact: true }).click();
  await expect(page).toHaveURL(/account=ACC-100001/);
  await page.reload();
  const drawer = page.getByRole('dialog');
  await expect(drawer.getByRole('heading', { name: 'ACC-100001', exact: true })).toBeVisible();
  await expect(drawer.getByLabel('Current balance summary')).toContainText('SGD 44,000.00');
  await expect(drawer).toContainText('Posted Transaction History');
  await drawer.getByRole('link', { name: 'JRN-1002', exact: true }).click();
  await expect(page.getByLabel('Journal posting summary')).toContainText('Posted');
  await page.goBack();
  await expect(page.getByRole('dialog').getByRole('heading', { name: 'ACC-100001', exact: true })).toBeVisible();
});
