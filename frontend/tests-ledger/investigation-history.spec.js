import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const reports = JSON.parse(readFileSync(new URL('../../backend/tests/fixtures/accepted_investigation_reports.json', import.meta.url)));
const token = process.env.INTELLIOPS_ADMIN_TOKEN;
const api = process.env.INTELLIOPS_LEDGER_API_URL || 'http://127.0.0.1:8000';

// Normal frontend + real GET-only source records. All investigation writes are
// fulfilled locally; every other mutation and every provider URL is blocked.
async function setup(context, state) {
  await context.addInitScript(t => sessionStorage.setItem('intelliops-api-token', t), token);
  await context.route('**/api.openai.com/**', route => { state.providerRequests++; return route.abort(); });
  await context.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const match = path.match(/^\/api\/exceptions\/(CASE-\d+)\/investigations$/);
    if (match && request.method() === 'GET') {
      const rows = state.history[match[1]] || [];
      return route.fulfill({ json: { persistence: 'BACKEND_DATABASE', investigations: rows,
        current_evidence_availability: 'AVAILABLE', offset: 0, limit: 20 } });
    }
    if (match && request.method() === 'POST' && state.allowMockPost) {
      state.mockPosts++; state.requestIds.push(request.headers()['x-investigation-request-id']);
      await new Promise(resolve => setTimeout(resolve, 700));
      if (state.mockPosts === 1) return route.fulfill({ status: 503, json: { detail: 'Offline mocked provider failure; no paid request.' } });
      const report = structuredClone(reports[match[1]]);
      report.started_at = new Date().toISOString(); report.completed_at = report.started_at;
      state.history[match[1]] = [row(report, false)];
      return route.fulfill({ json: report });
    }
    if (request.method() === 'GET') return route.continue();
    state.forbiddenMutations.push(path); return route.abort();
  });
}
function row(report, stale) {
  return { request_id: report.investigation_id, investigation_id: report.investigation_id,
    created_at: report.started_at, status: 'ACCEPTED', report, stale,
    evidence_fingerprint: report.evidence_fingerprint };
}
function stateFor(history = {}) { return { history, mockPosts: 0, providerRequests: 0, forbiddenMutations: [], requestIds: [] }; }

test('accepted A/B/C reports reopen, render evidence and survive fresh browser contexts without paid requests', async ({ browser, request }) => {
  expect(token, 'Supply existing token through the test environment').toBeTruthy();
  const response = await request.get(api + '/api/banking-snapshot', { headers: { Authorization: 'Bearer ' + token } });
  expect(response.status()).toBe(200); const before = await response.json();
  const state = stateFor(Object.fromEntries(Object.entries(reports).map(([caseId, report]) => [caseId, [row(report, false)]])));
  for (const [caseId, report] of Object.entries(reports)) {
    // A fresh context has no investigation cache, simulating browser restart.
    const context = await browser.newContext({ baseURL: process.env.INTELLIOPS_LEDGER_UI_URL || 'http://127.0.0.1:5173' }); await setup(context, state);
    const page = await context.newPage();
    await page.goto('/intelliops/exceptions?case=' + caseId);
    await page.getByRole('link', { name: 'Open Investigation', exact: true }).click();
    await expect(page.locator('#cc-diagnosis-title')).toHaveText(report.root_cause_title);
    await expect(page.getByText('Current evidence matches this snapshot.', { exact: false })).toBeVisible();
    await page.getByText('Verified financial totals', { exact: true }).click();
    const total = report.financial_impact.validDebitTotals.SGD;
    await expect(page.getByText(`Debit: SGD ${total} / Credit: SGD ${total}`, { exact: true })).toBeVisible();
    await expect(page.getByText('Proposal · Policy review required', { exact: true })).toBeVisible();
    await expect(page.locator('.cc-next')).toContainText(report.recommendation_reason);
    await expect(page.locator('.inv-workspace')).toContainText(report.llm_analysis.facts[0].evidence_refs[0]);
    await page.getByText('Ledger Journals and Entries', { exact: true }).click();
    const ledger = page.locator('.cc-evidence-group').filter({ hasText: 'Ledger Journals and Entries' });
    await expect(ledger.locator('tbody tr')).toHaveCount(report.supporting_evidence.entries.length);
    const journalLink = ledger.getByRole('link', { name: report.supporting_evidence.journals[0].id, exact: true });
    await expect(journalLink).toHaveAttribute('href', /\/core-banking\/journals\?journal=/);
    await page.getByRole('button', { name: 'View Investigation History', exact: true }).click();
    await page.getByRole('button', { name: 'Open saved report', exact: true }).click();
    await page.reload();
    await expect(page.locator('#cc-diagnosis-title')).toHaveText(report.root_cause_title);
    await page.getByRole('button', { name: 'Send to Resolution', exact: true }).click();
    await expect(page.getByText('No action has been approved or executed.', { exact: false })).toBeVisible();
    await context.close();
  }
  const after = await (await request.get(api + '/api/banking-snapshot', { headers: { Authorization: 'Bearer ' + token } })).json();
  for (const key of ['accounts', 'payment_transactions', 'ledger_journals', 'ledger_entries', 'exception_cases', 'audit_events']) expect(after[key]).toEqual(before[key]);
  expect(state.mockPosts).toBe(0); expect(state.providerRequests).toBe(0); expect(state.forbiddenMutations).toEqual([]);
});

test('mocked loading/error/new request, flags and stale snapshot; refresh never resubmits', async ({ browser }) => {
  const state = stateFor(); state.allowMockPost = true;
  const context = await browser.newContext({ baseURL: process.env.INTELLIOPS_LEDGER_UI_URL || 'http://127.0.0.1:5173' }); await setup(context, state); const page = await context.newPage();
  await page.goto('/intelliops/investigation?case=CASE-000009');
  await page.getByRole('button', { name: 'Start AI Investigation', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Reviewing source evidence with AI' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Offline mocked provider failure');
  await page.getByRole('button', { name: 'Retry Investigation', exact: true }).click();
  await expect(page.locator('#cc-diagnosis-title')).toHaveText(reports['CASE-000009'].root_cause_title);
  const report = structuredClone(state.history['CASE-000009'][0].report);
  report.review_flags = [{ code: 'OFFLINE_REVIEW', message: 'Offline test: verify the material uncertainty.' }];
  state.history['CASE-000009'] = [row(report, true)];
  await page.getByRole('button', { name: 'Refresh saved history', exact: true }).click();
  await expect(page.getByText('Offline test: verify the material uncertainty.')).toBeVisible();
  await expect(page.getByText('Current source evidence has changed.', { exact: false })).toBeVisible();
  await page.getByText('Classification and uncertainty', { exact: false }).click();
  await expect(page.locator('.cc-diagnosis-details')).toContainText(report.unresolved_questions[0]);
  await page.reload(); await expect(page.getByText('Offline test: verify the material uncertainty.')).toBeVisible();
  expect(state.mockPosts).toBe(2); expect(new Set(state.requestIds).size).toBe(2);
  expect(state.providerRequests).toBe(0); expect(state.forbiddenMutations).toEqual([]);
  await context.close();
});
