import { test, expect } from '@playwright/test';

async function complete(page, fixture = 'prevented') {
  await page.goto(`/intelliops/investigation?fixture=${fixture}`);
  await expect(page.getByRole('heading', { name: 'Root Cause Analysis' })).not.toBeVisible();
  await page.getByRole('button', { name: 'Start AI Investigation', exact: true }).click();
  await expect(page.getByRole('status')).toContainText(/Queued|Collecting evidence/);
  await expect(page.getByRole('button', { name: 'Start AI Investigation', exact: true })).not.toBeVisible();
  await expect(page.getByRole('heading', { name: 'Root Cause Analysis' })).toBeVisible();
}

test('sidebar entry is empty, invalid cases are unavailable, development examples are explicit', async ({ page }) => {
  await page.goto('/intelliops/investigation');
  await expect(page.getByRole('heading', { name: 'No Investigation Selected' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start AI Investigation' })).not.toBeVisible();
  await page.getByText('Development examples', { exact: true }).click();
  await page.getByRole('link', { name: 'A · Retry held before posting' }).click();
  await expect(page.getByText('Development fixture ·', { exact: false })).toBeVisible();
  await page.goto('/intelliops/investigation?case=NOT-FOUND');
  await expect(page.getByRole('heading', { name: 'Investigation unavailable' })).toBeVisible();
});

test('supported report persists, trace expands, history is read only and structured handoff survives reload', async ({ page }) => {
  await complete(page);
  await expect(page.getByRole('heading', { name: 'Client Retry After Acknowledgment Timeout' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'One posting confirmed', exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'View Full Investigation Trace', exact: true }).first().click();
  await page.locator('#investigation-trace').getByText('Ack timeout', { exact: true }).click();
  await expect(page.getByText('DEV-CORR-1', { exact: false }).first()).toBeVisible();
  await page.keyboard.press('Escape');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Root Cause Analysis' })).toBeVisible();
  await page.getByRole('button', { name: 'Run new investigation' }).click();
  await expect(page.getByRole('heading', { name: 'Root Cause Analysis' })).toBeVisible();
  await page.getByRole('button', { name: 'View Investigation History' }).click();
  await expect(page.getByRole('dialog').locator('article')).toHaveCount(2);
  await page.getByRole('dialog').getByRole('button', { name: 'Open saved report' }).last().click();
  await expect(page.getByText('Read-only previous report', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send to Resolution' })).not.toBeVisible();
  await page.getByRole('button', { name: 'Return to latest report', exact: true }).click();
  await page.getByRole('button', { name: 'Send to Resolution' }).click();
  await expect(page.getByRole('heading', { name: 'Investigation proposal received' })).toBeVisible();
  await page.getByText('Inspect structured handoff', { exact: true }).click();
  await expect(page.locator('pre')).toContainText('CLOSE_HELD_DUPLICATE');
  await expect(page.locator('pre')).toContainText('evidence_references');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Investigation proposal received' })).toBeVisible();
});

test('double posting, separate instructions and unknown execution produce different proposals', async ({ page }) => {
  for (const [fixture, outcome, action] of [
    ['double', 'DOUBLE_POSTING_CONFIRMED', 'ESCALATE_DUPLICATE_FINANCIAL_EXECUTION'],
    ['legitimate', 'DOUBLE_POSTING_CONFIRMED', 'REVIEW_FALSE_POSITIVE_CLOSURE'],
    ['uncertain', 'EXECUTION_OUTCOME_UNKNOWN', 'ESCALATE_FOR_PAYMENT_VERIFICATION'],
  ]) {
    await complete(page, fixture);
    await page.locator('.cc-financial').getByText('Verification classification', { exact: true }).click();
    await expect(page.getByText(outcome, { exact: true })).toBeVisible();
    await page.locator('.cc-next').getByText('Action details', { exact: true }).click();
    await expect(page.locator('.cc-next code')).toContainText(action);
  }
});

test('failed run has no diagnosis; retry saves a separate successful run', async ({ page }) => {
  await page.goto('/intelliops/investigation?fixture=prevented');
  await page.getByText('Prototype run controls', { exact: true }).click();
  await page.getByLabel('Simulate a ledger evidence timeout').check();
  await page.getByRole('button', { name: 'Start AI Investigation', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Investigation could not be completed' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Root Cause Analysis' })).not.toBeVisible();
  await page.getByRole('button', { name: 'Retry Investigation', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Root Cause Analysis' })).toBeVisible();
  await page.getByRole('button', { name: 'View Investigation History' }).click();
  await expect(page.getByRole('dialog').locator('article')).toHaveCount(2);
  await expect(page.getByRole('dialog')).toContainText('Failed');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
});

test('reload interrupts simulated work without auto-rerunning, navigation keeps work active', async ({ page }) => {
  await page.goto('/intelliops/investigation?fixture=prevented');
  await page.getByRole('button', { name: 'Start AI Investigation', exact: true }).click();
  await page.getByRole('link', { name: 'Back to Exception Center' }).click();
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Root Cause Analysis' })).toBeVisible();
  await page.getByRole('button', { name: 'Run new investigation' }).click();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Investigation could not be completed' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('interrupted');
});

test('real shared duplicate opens directly, uses source links and never invents a timeout cause', async ({ page }) => {
  await page.goto('/payments/transactions');
  const caseId = await page.evaluate(async () => {
    const data = await import('/src/shared/data/bankingRecords.js');
    await data.createSyntheticPayment({ senderId: 'ACC-100003', receiverId: 'ACC-100001', amount: '100.00', idempotencyKey: 'investigation-e2e', scenario: 'DUPLICATE' }, 'ADMIN');
    await data.runPaymentDetection('ADMIN');
    return 'CASE-000001';
  });
  await page.goto(`/intelliops/exceptions?case=${caseId}&page=2&status=OPEN`);
  const before = await page.evaluate(() => localStorage.getItem('intelliops-banking-records-v1'));
  await page.getByRole('link', { name: 'Open Investigation', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Potential Duplicate Transaction' })).toBeVisible();
  await page.getByRole('button', { name: 'Start AI Investigation', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Underlying cause not established from available evidence.' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'One posting confirmed', exact: true }).first()).toBeVisible();
  const paymentLink = page.locator('.inv-case-header').getByRole('link').first();
  await paymentLink.click();
  await expect(page.getByRole('dialog')).toContainText('TXN-');
  await page.goBack();
  await page.locator('.inv-payment-pair').getByRole('link', { name: 'JRN-', exact: false }).first().click();
  await expect(page.getByRole('heading', { name: 'Backend connection required' })).toBeVisible();
  await page.goBack();
  await page.getByRole('link', { name: 'Back to Exception Center' }).click();
  await expect(page).toHaveURL(/page=2&status=OPEN/);
  expect(await page.evaluate(() => localStorage.getItem('intelliops-banking-records-v1'))).toBe(before);
});

test('mobile report has no page overflow and history drawer is keyboard accessible', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await complete(page, 'double');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'View Investigation History' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'View Investigation History' })).toBeFocused();
});

test('command center exposes source stages and hides technical comparison until requested', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await complete(page);
  await expect(page.getByRole('heading', { name: 'Payment Execution', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Payment Comparison', exact: true })).not.toBeVisible();
  await expect(page.getByRole('button', { name: /Inspect Validation passed/ })).toHaveCount(0);
  expect(await page.locator('.cc-causal-events > li').count()).toBeLessThanOrEqual(5);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath('command-center-desktop.png'), fullPage: true });
  const stage = page.getByRole('button', { name: 'Inspect Acknowledgment timeout for DEV-PAY-1001', exact: true });
  await stage.click();
  const drawer = page.getByRole('dialog');
  await expect(drawer).toContainText('ACK_TIMEOUT');
  await expect(drawer).toContainText('DEV-E3');
  await expect(drawer).toContainText('DEV-CORR-1');
  await page.keyboard.press('Escape');
  await expect(stage).toBeFocused();
  await page.getByRole('button', { name: 'Inspect No financial posting started for DEV-PAY-1002', exact: true }).click();
  await expect(drawer).toContainText('Not a processing event');
  await expect(drawer).toContainText('DEV-E5');
  await page.keyboard.press('Escape');
  await page.locator('.cc-evidence-group').filter({ has: page.locator('summary strong', { hasText: /^Payment Records$/ }) }).locator('summary').click();
  await expect(page.getByRole('heading', { name: 'Payment Comparison', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath('command-center-mobile.png'), fullPage: true });
});
