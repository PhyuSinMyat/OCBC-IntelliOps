import { expect, test } from '@playwright/test';

test('case drawer presents recorded findings, retains register context and fits the viewport', async ({ page }) => {
  await page.goto('/intelliops/exceptions');
  const cases = await page.evaluate(async () => {
    const data = await import('/src/shared/data/bankingRecords.js');
    for (const [index, scenario] of ['DUPLICATE', 'PROCESSING_FAILURE', 'MISSING_LEDGER', 'AMOUNT_MISMATCH', 'UNMATCHED'].entries()) {
      await data.createSyntheticPayment({
        senderId: 'ACC-100003', receiverId: 'ACC-100001', amount: String(100 + index), idempotencyKey: scenario, scenario,
      }, 'ADMIN');
    }
    data.advanceSimulationClock('ADMIN');
    await data.runPaymentDetection('ADMIN');
    return data.restoreRecords(localStorage).exception_cases;
  });

  const search = page.getByRole('searchbox', { name: 'Search exceptions' });
  const dialog = page.getByRole('dialog');
  const expected = {
    'Duplicate Transaction': 'One verified posting and a held repeat',
    'Payment Processing Failure': 'No movement observed at detection',
    'Missing Ledger Posting': 'No linked posting',
    'Amount Mismatch': 'SGD 103.00',
    'Unmatched Transaction': 'Reference conflict',
  };
  expect(cases).toHaveLength(5);
  for (const record of cases) {
    await search.fill(record.id);
    const rowButton = page.getByRole('button', { name: record.id, exact: true });
    await rowButton.click();
    await expect(dialog).toHaveAccessibleName(record.exceptionType);
    await expect(dialog.locator('.case-detail-metrics')).toContainText(expected[record.exceptionType]);
    await expect(dialog).toContainText('Exception detected');
    const disclosure = dialog.getByText('View Technical Evidence', { exact: true });
    await expect(dialog.locator('details')).not.toHaveAttribute('open', '');
    await disclosure.click();
    await expect(dialog.locator('details')).toHaveAttribute('open', '');
    await expect(dialog.getByRole('link', { name: 'View Payment' })).toHaveCount(record.relatedTransactionId ? 2 : 1);
    if (record.exceptionType === 'Duplicate Transaction') {
      await expect(dialog.locator('.case-detail-related').first()).toContainText(record.relatedTransactionId);
      const journal = record.evidence.originalJournalReferences[0];
      await expect(dialog.getByRole('link', { name: 'View Journal' })).toHaveAttribute('href', '/core-banking/journals?journal=' + journal);
    }
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await expect(rowButton).toBeFocused();
    await expect(search).toHaveValue(record.id);
  }

  for (const width of [1440, 1366, 1024, 390]) {
    await page.setViewportSize({ width, height: 850 });
    await page.getByRole('button', { name: cases.at(-1).id, exact: true }).click();
    await expect(dialog.getByRole('link', { name: 'Open AI Investigation' })).toBeInViewport();
    await expect.poll(() => dialog.evaluate(node => {
      const rect = node.getBoundingClientRect();
      const body = node.querySelector('.case-detail-body');
      return rect.left >= 0 && rect.right <= innerWidth && body.scrollWidth === body.clientWidth;
    })).toBe(true);
    await dialog.getByRole('button', { name: 'Close details' }).click();
    await expect(dialog).not.toBeVisible();
  }

  const duplicate = cases.find(record => record.relatedTransactionId);
  await page.goto('/intelliops/exceptions?case=' + duplicate.id + '&status=OPEN');
  await dialog.getByRole('link', { name: 'View Payment' }).first().click();
  await expect(page).toHaveURL(new RegExp('/payments/transactions\\?transaction=' + duplicate.relatedTransactionId));
  await expect(dialog).toContainText(duplicate.relatedTransactionId);
  await page.goBack();
  await dialog.getByRole('link', { name: 'Open AI Investigation' }).click();
  await expect(page.getByRole('heading', { name: 'Potential Duplicate Transaction' })).toBeVisible();
});
