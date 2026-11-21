import { test, expect } from '@playwright/test';

const token = 'integration-test-analyst-only';
const localData = JSON.stringify({
  payment_transactions: [{ id: 'TXN-BROWSER-ONLY', status: 'Completed', amountCents: 999999999 }],
  ledger_journals: [], ledger_entries: [],
});

async function snapshot(page) {
  return page.evaluate(async credential => {
    const response = await fetch('/backend/api/banking-snapshot', { headers: { Authorization: `Bearer ${credential}` } });
    if (!response.ok) throw new Error('Snapshot read failed');
    return response.json();
  }, token);
}

const currency = cents => `SGD ${(cents / 100).toLocaleString('en-SG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

test('two authenticated profiles share backend payments, journals, balances and cases without local copies', async ({ browser, baseURL }) => {
  const first = await browser.newContext({ baseURL }), second = await browser.newContext({ baseURL });
  for (const context of [first, second]) await context.addInitScript(({ credential, poison }) => {
    sessionStorage.setItem('intelliops-api-token', credential);
    localStorage.setItem('intelliops-banking-records-v1', poison);
  }, { credential: token, poison: localData });
  const a = await first.newPage(), b = await second.newPage();
  try {
    await a.goto('/payments/transactions');
    await b.goto('/core-banking/accounts');
    await expect(a.getByRole('heading', { name: 'Transaction register' })).toBeVisible();
    await expect(a.getByText('TXN-BROWSER-ONLY', { exact: true })).toHaveCount(0);
    for (const [index, code] of ['CUSTOMER_DOUBLE_CLICK', 'AUTOMATIC_RETRY_FAILURE', 'LEGITIMATE_REPEATED_PAYMENTS'].entries()) {
      const before = await snapshot(a);
      const amountCents = 21111 + index * 111;
      const amount = (amountCents / 100).toFixed(2);
      await a.goto('/payments/transactions');
      await a.getByRole('button', { name: 'Create Synthetic Payment', exact: true }).click();
      await a.getByLabel('Sender account', { exact: true }).selectOption('ACC-100003');
      await a.getByLabel('Receiver account', { exact: true }).selectOption('ACC-100001');
      await a.getByLabel('Amount', { exact: true }).fill(amount);
      await a.getByLabel('Exception type').selectOption('DUPLICATE');
      await a.getByLabel('Duplicate Transaction Scenario').selectOption(code);
      const pending = a.waitForResponse(response => response.url().endsWith('/api/demo/payments/scenario') && response.request().method() === 'POST');
      await a.getByRole('button', { name: 'Submit Synthetic Payment' }).click();
      const response = await pending;
      expect(response.status()).toBe(201);
      const body = response.request().postDataJSON(), result = await response.json();
      expect(body.currency).toBe('SGD');
      expect(body.run_key).toBeTruthy();
      const postings = index === 0 ? 1 : 2;
      expect(result.postingCount).toBe(postings);
      expect(result.payments.map(p => p.status)).toEqual(['Completed', index === 0 ? 'Held' : 'Completed']);
      expect(result.instructionReferences).toHaveLength(index === 2 ? 2 : 1);
      const after = await snapshot(a);
      expect(after.payment_transactions.length - before.payment_transactions.length).toBe(2);
      expect(after.ledger_journals.length - before.ledger_journals.length).toBe(postings);
      expect(after.ledger_entries.length - before.ledger_entries.length).toBe(2 * postings);
      for (const [ref, sign] of [['ACC-100003', -1], ['ACC-100001', 1]]) {
        const expected = before.accounts.find(account => account.id === ref).authoritativeBalance.current + sign * amountCents * postings;
        expect(after.accounts.find(account => account.id === ref).authoritativeBalance.current).toBe(expected);
        await b.goto('/core-banking/accounts');
        await expect(b.locator('tbody tr').filter({ hasText: ref })).toContainText(currency(expected));
      }
      for (const journal of result.journalReferences) {
        await b.goto('/core-banking/journals?journal=' + encodeURIComponent(journal));
        await expect(b.getByRole('dialog').locator('tbody tr').filter({ hasText: 'Debit' })).toContainText(currency(amountCents));
        await expect(b.getByRole('dialog').locator('tbody tr').filter({ hasText: 'Credit' })).toContainText(currency(amountCents));
        await expect(b.getByRole('dialog')).toContainText('Balanced');
      }
      // Replay the exact captured HTTP request: no extra records or financial effects.
      const replay = await a.evaluate(async ({ credential, request }) => {
        const response = await fetch('/backend/api/demo/payments/scenario', { method: 'POST', headers: {
          Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json',
        }, body: JSON.stringify(request) });
        return { status: response.status, result: await response.json() };
      }, { credential: token, request: body });
      expect(replay.status).toBe(201);
      expect(replay.result.requestIds).toEqual(result.requestIds);
      expect((await snapshot(a)).payment_transactions.length).toBe(after.payment_transactions.length);
      await a.goto('/payments/transactions');
      await a.getByRole('button', { name: 'Run Detection', exact: true }).click();
      await expect(a.getByRole('status')).toContainText('Detection completed');
      const detected = await snapshot(a);
      const pair = detected.exception_cases.filter(c => [c.transactionId, c.relatedTransactionId].sort().join() === [...result.paymentReferences].sort().join());
      expect(pair).toHaveLength(1);
      expect(pair[0].evidence.rootCause).toBe('NOT_ESTABLISHED');
      await a.getByRole('button', { name: 'Run Detection', exact: true }).click();
      await expect(a.getByRole('status')).toContainText('0 new cases');
      await b.goto('/intelliops/exceptions?case=' + pair[0].id);
      for (const ref of result.paymentReferences) await expect(b.getByRole('dialog')).toContainText(ref);
      await a.goto('/payments/transactions?transaction=' + result.paymentReferences[1]);
      await a.reload();
      await expect(a.getByRole('dialog')).toContainText(result.requestIds[1]);
      await expect(a.getByRole('dialog')).toContainText(index === 1 ? 'SYSTEM' : 'CUSTOMER');
      for (const page of [a, b]) expect(await page.evaluate(() => localStorage.getItem('intelliops-banking-records-v1'))).toBe(localData);
    }
    // A database outage is an explicit error; poison browser records never replace it.
    await a.route('**/api/banking-snapshot', route => route.fulfill({ status: 503, json: {
      code: 'DATABASE_UNAVAILABLE', detail: 'Database unavailable; no browser fallback.',
    } }));
    await a.reload();
    await expect(a.getByRole('heading', { name: 'Banking records unavailable' })).toBeVisible();
    await expect(a.getByRole('alert')).toContainText('no browser fallback');
    await expect(a.getByText('TXN-BROWSER-ONLY', { exact: true })).toHaveCount(0);
    await a.unroute('**/api/banking-snapshot');
    await a.getByRole('button', { name: 'Retry connection' }).click();
    await expect(a.getByRole('dialog')).toBeVisible();
  } finally {
    await first.close();
    await second.close();
  }
});
