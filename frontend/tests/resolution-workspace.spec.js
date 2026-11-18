import { test, expect } from '@playwright/test';

// Focused e2e coverage for the expandable Resolution Workspace sidebar navigation.
// Selectors are scoped to #workspace-navigation so they never collide with the
// in-page cross-links rendered on the Resolution Workspace placeholder pages.

const GROUP = 'Resolution Workspace';
const CHILDREN = ['Resolution Plans', 'Customer Communication', 'Policy Assessment'];
const PATHS = {
  'Resolution Plans': '/intelliops/workflows/plans',
  'Customer Communication': '/intelliops/workflows/communication',
  'Policy Assessment': '/intelliops/workflows/policy',
};

const nav = (page) => page.locator('#workspace-navigation');
const groupButton = (page) => nav(page).getByRole('button', { name: GROUP });
// Use the submenu class (not role) so visibility tracks the collapsed (0fr/inert) state.
const childLink = (page, name) => nav(page).locator('.nav-submenu-link', { hasText: name });
const primaryLink = (page, name) => nav(page).getByRole('link', { name });

test('parent toggles the submenu open and closed', async ({ page }) => {
  await page.goto('/intelliops/overview');
  const toggle = groupButton(page);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(childLink(page, 'Resolution Plans')).toBeHidden();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  for (const label of CHILDREN) await expect(childLink(page, label)).toBeVisible();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(childLink(page, 'Resolution Plans')).toBeHidden();
});

test('direct child URL auto-expands the parent and marks only the active child', async ({ page }) => {
  await page.goto('/intelliops/workflows/plans');
  await expect(groupButton(page)).toHaveAttribute('aria-expanded', 'true');
  await expect(childLink(page, 'Resolution Plans')).toHaveAttribute('aria-current', 'page');
  await expect(childLink(page, 'Customer Communication')).not.toHaveAttribute('aria-current', 'page');
  await expect(childLink(page, 'Policy Assessment')).not.toHaveAttribute('aria-current', 'page');
});

test('each child navigates, becomes active, and keeps the group expanded', async ({ page }) => {
  for (const label of CHILDREN) {
    await page.goto('/intelliops/overview');
    await groupButton(page).click();
    await childLink(page, label).click();
    await expect(page).toHaveURL(PATHS[label]);
    await expect(childLink(page, label)).toHaveAttribute('aria-current', 'page');
    await expect(groupButton(page)).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('heading', { name: label, exact: true })).toBeVisible();
  }
});

test('active child survives reload and browser back/forward', async ({ page }) => {
  await page.goto('/intelliops/workflows/communication');
  await expect(childLink(page, 'Customer Communication')).toHaveAttribute('aria-current', 'page');
  await page.reload();
  await expect(childLink(page, 'Customer Communication')).toHaveAttribute('aria-current', 'page');
  await expect(groupButton(page)).toHaveAttribute('aria-expanded', 'true');
  await page.goto('/intelliops/workflows/policy');
  await expect(childLink(page, 'Policy Assessment')).toHaveAttribute('aria-current', 'page');
  await page.goBack();
  await expect(page).toHaveURL('/intelliops/workflows/communication');
  await expect(childLink(page, 'Customer Communication')).toHaveAttribute('aria-current', 'page');
  await page.goForward();
  await expect(page).toHaveURL('/intelliops/workflows/policy');
  await expect(childLink(page, 'Policy Assessment')).toHaveAttribute('aria-current', 'page');
});

test('case context is preserved across section switches and absent when not provided', async ({ page }) => {
  await page.goto('/intelliops/workflows/plans?case=CASE-7&investigation=INV-42');
  await expect(page.getByText('Case CASE-7')).toBeVisible();
  await expect(page.getByText('Investigation INV-42')).toBeVisible();
  await childLink(page, 'Customer Communication').click();
  await expect(page).toHaveURL(/\/intelliops\/workflows\/communication\?case=CASE-7&investigation=INV-42$/);
  await expect(page.getByText('Case CASE-7')).toBeVisible();
  // No case -> explicit empty state, never undefined/broken context.
  await page.goto('/intelliops/workflows/policy');
  await expect(page.getByText('No case selected', { exact: false })).toBeVisible();
  await expect(page.getByText('undefined')).toHaveCount(0);
});

test('keyboard: toggle with Enter, children focusable only when open', async ({ page }) => {
  await page.goto('/intelliops/overview');
  const toggle = groupButton(page);
  await toggle.focus();
  await expect(toggle).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Tab');
  await expect(childLink(page, 'Resolution Plans')).toBeFocused();
  // Collapse from the parent; focus returns to the toggle, children become non-focusable.
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('Tab');
  await expect(primaryLink(page, 'Approval Center')).toBeFocused();
});

test('existing sidebar items still navigate', async ({ page }) => {
  await page.goto('/intelliops/workflows/plans');
  await primaryLink(page, 'Overview').click();
  await expect(page).toHaveURL('/intelliops/overview');
  await expect(primaryLink(page, 'Overview')).toHaveAttribute('aria-current', 'page');
});

test('no horizontal overflow at desktop and mobile widths', async ({ page }) => {
  for (const width of [1366, 1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/intelliops/workflows/plans');
    if (width <= 800) await page.getByRole('button', { name: 'Open navigation' }).click();
    // The group is auto-expanded on this route; ensure the layout never overflows horizontally.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  }
});
