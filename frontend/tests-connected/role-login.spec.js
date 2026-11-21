import { test, expect } from '@playwright/test';

test('Analyst and Administrator profiles authenticate to their backend roles', async ({ page }) => {
  await page.goto('/intelliops/approvals');
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();

  await page.getByLabel('Access password').fill('integration-test-analyst-only');
  await page.getByRole('button', { name: 'Sign in as Analyst' }).click();
  await expect(page.getByRole('heading', { name: 'Approval Center' })).toBeVisible();
  await expect(page.getByText('Analyst', { exact: true })).toBeVisible();
  const analystSidebar = page.getByRole('complementary');
  await expect(analystSidebar.getByRole('link', { name: 'Overview' })).toBeVisible();
  await expect(analystSidebar.getByRole('link', { name: 'Exception Center' })).toBeVisible();
  await expect(analystSidebar.getByRole('link', { name: 'AI Investigation' })).toBeVisible();
  await expect(analystSidebar.getByRole('button', { name: 'Resolution Workspace' })).toBeVisible();
  await expect(analystSidebar.getByRole('link', { name: 'Approval Center' })).toBeVisible();
  await expect(analystSidebar.getByRole('link', { name: 'Audit Trail' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Portals' }).getByRole('link', { name: 'Payment Processing' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Portals' }).getByRole('link', { name: 'Core Banking / Ledger' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Administrator Decision' })).toHaveCount(0);

  await page.goto('/intelliops/exceptions');
  await expect(page).toHaveURL(/\/intelliops\/exceptions$/);
  await page.goto('/intelliops/investigation');
  await expect(page).toHaveURL(/\/intelliops\/investigation$/);
  await page.goto('/intelliops/workflows/plans');
  await expect(page).toHaveURL(/\/intelliops\/workflows\/plans$/);
  await page.goto('/intelliops/workflows/communication');
  await expect(page).toHaveURL(/\/intelliops\/workflows\/communication$/);
  await page.goto('/intelliops/workflows/policy');
  await expect(page).toHaveURL(/\/intelliops\/workflows\/policy$/);
  await page.goto('/payments/transactions');
  await expect(page).toHaveURL(/\/payments\/transactions$/);

  await page.getByRole('button', { name: 'Analyst account' }).click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();

  await page.getByRole('radio', { name: /Administrator/ }).click();
  await page.getByLabel('Access password').fill('integration-test-admin-only');
  await page.getByRole('button', { name: 'Sign in as Administrator' }).click();
  await expect(page.getByRole('heading', { name: 'Approval Center' })).toBeVisible();
  await expect(page.getByText('Administrator', { exact: true })).toBeVisible();
  const adminNavigation = page.getByRole('complementary').getByRole('navigation', { name: 'Workspace' });
  await expect(adminNavigation.getByRole('link', { name: 'Approval Center' })).toBeVisible();
  await expect(adminNavigation.getByRole('link', { name: 'Overview' })).toHaveCount(0);
  await expect(adminNavigation.getByRole('link')).toHaveCount(1);

  await page.goto('/payments/transactions');
  await expect(page).toHaveURL(/\/intelliops\/approvals$/);
  await expect(page.getByRole('heading', { name: 'Approval Center' })).toBeVisible();
});
