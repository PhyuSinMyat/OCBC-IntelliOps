import { test, expect } from '@playwright/test';
import { developmentFixture } from '../src/portals/intelliops/investigation/fixtures.js';
import { analyzeSnapshot, evidenceSnapshot } from '../src/portals/intelliops/investigation/analysis.js';

// Explicit UI-only fixture; backend grounding is exercised separately against SQLAlchemy.
function responses() {
  const f = developmentFixture('prevented');
  const selected = { ...f.caseRecord, id: 'CASE-000004' };
  const snapshot = evidenceSnapshot(selected, f.records, f.accounts, null);
  snapshot.fixture = null;
  snapshot.events = snapshot.events.filter(e => !['ACK_TIMEOUT', 'RETRY_SUBMITTED'].includes(e.eventType));
  const report = { ...analyzeSnapshot(snapshot), case_id: selected.id, investigation_id: 'INV-browser-contract',
    prototype: false, provider: 'openai', model: 'test-model', run_status: 'COMPLETED',
    started_at: '2026-11-10T01:00:00Z', completed_at: '2026-11-10T01:00:02Z',
    evidence_snapshot_at: '2026-11-10T01:00:00Z', persistence: 'BROWSER_SESSION_ONLY',
    llm_analysis: { facts: [{ statement: 'Recorded hold and ledger evidence reviewed.', evidence_refs: ['case:CASE-000004'] }], hypotheses: [] } };
  return { selected, report, snapshot: { ...f.records, customers: [], accounts: f.accounts, exception_cases: [] } };
}

async function connect(page, failed = false) {
  const data = responses();
  let posts = 0;
  await page.route('**/backend/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/api/banking-snapshot')) return route.fulfill({ json: data.snapshot });
    if (path.endsWith('/api/exceptions/CASE-000004')) return route.fulfill({ json: data.selected });
    if (path.endsWith('/api/exceptions/CASE-000004/investigations')) {
      expect(route.request().method()).toBe('POST'); posts++;
      return route.fulfill(failed ? { status: 503, json: { detail: 'AI provider is not configured. No prototype result was substituted.' } } : { json: data.report });
    }
    // Every unexpected API request stays local and fails closed.
    return route.fulfill({ status: 404, json: { detail: 'Unexpected test API request' } });
  });
  await page.goto('/intelliops/investigation?case=CASE-000004');
  await expect(page.getByText('Backend AI investigation', { exact: true })).toBeVisible();
  return () => posts;
}

test('selected case loads directly, invokes backend, and saved report survives navigation and refresh', async ({ page }) => {
  const posts = await connect(page);
  await page.getByRole('button', { name: 'Start AI Investigation', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'AI Evidence Analysis' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Underlying cause not established from available evidence.' })).toBeVisible();
  await expect(page.getByText('Recorded hold and ledger evidence reviewed.')).toBeVisible();
  await expect(page.getByText('Prototype run controls')).not.toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'AI Evidence Analysis' })).toBeVisible();
  await page.getByRole('link', { name: 'Back to Exception Center' }).click();
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'AI Evidence Analysis' })).toBeVisible();
  expect(posts()).toBe(1);
});

test('provider error is visible and never becomes a prototype diagnosis', async ({ page }) => {
  const posts = await connect(page, true);
  await page.getByRole('button', { name: 'Start AI Investigation', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Investigation could not be completed' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('No prototype result was substituted');
  await expect(page.getByRole('heading', { name: 'AI Evidence Analysis' })).not.toBeVisible();
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('AI provider is not configured');
  expect(posts()).toBe(1);
});
