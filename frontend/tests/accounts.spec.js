import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/core-banking/accounts');
});

test('customer and product columns are distinct and preserve current balances', async ({ page }) => {
  await expect(page.getByRole('columnheader')).toHaveText(['Account reference', 'Customer', 'Customer Type', 'Account Type', 'Currency', 'Current balance', 'Status', 'Actions']);
  await expect(page.locator('tbody tr')).toHaveCount(8);
  const business = page.locator('tbody tr').filter({ hasText: 'Northstar Trading' });
  await expect(business.locator('td').nth(2)).toHaveText('Business');
  await expect(business.locator('td').nth(3)).toHaveText('Current');
  await expect(page.locator('tbody tr').filter({ hasText: 'Alex Tan' })).toContainText('SGD 44,000.00');
  await expect(page.getByText('Corporate', { exact: true })).toHaveCount(0);
});

test('combined filters, chips, sorting, empty state and reset work', async ({ page }) => {
  await page.getByLabel('Filter by customer type').selectOption('BUSINESS');
  await page.getByLabel('Filter by account type').selectOption('CURRENT');
  await page.getByText('More filters').click();
  await page.getByLabel('Filter by status', { exact: true }).selectOption('Active');
  await page.getByLabel('Filter by currency', { exact: true }).selectOption('SGD');
  await expect(page.locator('tbody tr')).toHaveCount(2);
  await expect(page.getByText('Showing 2 of 8 accounts')).toBeVisible();
  await page.getByLabel('Sort accounts').selectOption('customer-desc');
  await expect(page.locator('tbody tr').first()).toContainText('Northstar');
  await page.getByLabel('Search accounts', { exact: true }).fill('CUS-008');
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await expect(page.getByLabel('Active filters')).toContainText('Business');
  await page.getByLabel('Search accounts', { exact: true }).fill('not-found');
  await expect(page.getByRole('heading', { name: 'No accounts found' })).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await expect(page.locator('tbody tr')).toHaveCount(8);
  await expect(page.getByLabel('Sort accounts')).toHaveValue('reference');
});

test('drawer shows four sections, preserves filters and returns focus', async ({ page }) => {
  await page.getByLabel('Search accounts', { exact: true }).fill('Alex');
  const opener = page.getByRole('button', { name: 'ACC-100001', exact: true });
  await opener.click();
  const drawer = page.getByRole('dialog');
  await expect(drawer.getByRole('heading', { name: 'Account Information' })).toBeVisible();
  await expect(drawer.getByLabel('Current balance summary')).toContainText('SGD 44,000.00');
  await expect(drawer).toContainText('+SGD 1,500.00');
  await expect(drawer.getByRole('heading', { name: 'Balance Breakdown' })).toBeVisible();
  await expect(drawer.getByRole('heading', { name: 'Posted Transaction History' })).toBeVisible();
  await expect(drawer.locator('dl').first()).toContainText('Individual');
  await page.keyboard.press('Escape');
  await expect(drawer).not.toBeVisible();
  await expect(opener).toBeFocused();
  await expect(page.getByLabel('Search accounts', { exact: true })).toHaveValue('Alex');
  await expect(page.locator('tbody tr')).toHaveCount(1);
});

test('journal and payment references open their matching existing drawers', async ({ page }) => {
  await page.getByRole('button', { name: 'ACC-100001', exact: true }).click();
  await page.getByRole('dialog').getByRole('link', { name: 'JRN-1002', exact: true }).click();
  await expect(page).toHaveURL(/core-banking\/journals\?journal=JRN-1002/);
  await expect(page.getByRole('dialog').getByRole('heading', { name: 'JRN-1002' })).toBeVisible();
  await page.getByRole('dialog').getByRole('link', { name: 'Open Payment Transaction', exact: true }).click();
  await expect(page).toHaveURL(/payments\/transactions\?transaction=TXN-1002/);
  await expect(page.getByRole('dialog')).toContainText('SGD 3,500.00');
  await page.goto('/core-banking/journals?journal=DOES-NOT-EXIST');
  await expect(page.getByRole('dialog')).toContainText('This record is unavailable');
});

test('synthetic transfer remains consistent across portals and refresh', async ({ page }) => {
  await page.goto('/core-banking/journals');
  await page.getByRole('button', { name: 'Create synthetic transfer', exact: true }).click();
  await page.getByLabel('Amount', { exact: true }).fill('10.00');
  await page.getByRole('button', { name: 'Post synthetic transfer' }).click();
  await expect(page.locator('tbody tr')).toHaveCount(3);
  await page.reload();
  await expect(page.locator('tbody tr')).toHaveCount(3);
  await page.goto('/core-banking/accounts');
  await expect(page.locator('tbody tr').filter({ hasText: 'Alex Tan' })).toContainText('SGD 44,010.00');
  await page.goto('/payments/transactions?transaction=TXN-1003');
  await expect(page.getByRole('dialog')).toContainText('SGD 10.00');
});

test('small screens scroll the table without overflowing the page', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('heading', { name: 'Accounts', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const region = page.getByRole('region', { name: 'Scrollable account register' });
  expect(await region.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
  await page.getByRole('button', { name: 'ACC-100001', exact: true }).click();
  expect(await page.getByRole('dialog').evaluate(el => el.getBoundingClientRect().width)).toBeLessThanOrEqual(390);
  await expect(page.getByRole('button', { name: 'Close details' })).toBeVisible();
});
