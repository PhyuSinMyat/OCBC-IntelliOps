import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
const reports = JSON.parse(readFileSync(new URL('../../backend/tests/fixtures/accepted_investigation_reports.json', import.meta.url)));
async function saved(page, id, { stale = false, reviewFlag = null } = {}) {
  page.on('pageerror', e => console.log('PAGE ERROR', e.message));
  const report = structuredClone(reports[id]);
  if (reviewFlag) report.review_flags = [{ code: 'TEST_REVIEW', message: reviewFlag }];
  await page.addInitScript(({ report, stale }) => {
    const run = { investigation_id:report.investigation_id, run_status:'COMPLETED', report, snapshot:report.supporting_evidence, started_at:report.started_at, completed_at:report.completed_at, durable:true, stale };
    if (!sessionStorage.getItem('intelliops-investigations-prototype-v2')) sessionStorage.setItem('intelliops-investigations-prototype-v2',JSON.stringify({runs:{'fixture:prevented:DEV-CASE-PREVENTED:DEV-PAY-1002':[run]},handoffs:{}}));
  }, { report, stale });
  await page.route('**/api/**',r=>new URL(r.request().url()).pathname.startsWith('/api/') ? r.abort() : r.continue());
  await page.goto('/intelliops/investigation?fixture=prevented');
}
test('saved accepted reports preserve totals, tabs, sources and proposal handoff',async({browser})=>{
  for(const [id,total] of [['CASE-000010','25.00'],['CASE-000011','20.00'],['CASE-000009','6.66']]) {
    const page=await browser.newPage(); let writes=0;
    page.on('request',r=>{if(r.method()!=='GET')writes++;});
    await saved(page,id);
    await expect(page.getByRole('tab',{name:'Summary'})).toHaveAttribute('aria-selected','true');
    await expect(page.locator('.iw-metrics strong').filter({hasText:'SGD '+total})).toHaveCount(2);
    const flow = page.getByRole('region', { name: 'Payment relationship', exact: true });
    await expect(flow.locator('.iw-flow-path')).toHaveCount(2);
    if (id === 'CASE-000010') {
      await expect(flow).toContainText('Held before execution');
      await expect(flow.locator('.iw-flow-held')).toHaveCount(1);
    } else if (id === 'CASE-000011') {
      await expect(flow).toContainText('System retry');
      await expect(flow.getByText('Posting verified', { exact: true })).toHaveCount(2);
    } else {
      await expect(flow).toContainText('Distinct authorized instructions');
      await expect(flow.getByText('Customer origin · Authorization verified', { exact: true })).toHaveCount(2);
    }
    await page.getByRole('tab',{name:'Evidence'}).click();
    await expect(page.getByText(reports[id].root_cause_explanation,{exact:true})).toBeVisible();
    await page.getByRole('link', { name: 'Payment Execution', exact: true }).click();
    await expect(page.locator('#iw-execution')).toHaveAttribute('open');
    await expect(page.locator('#iw-execution .cc-path')).toHaveCount(2);
    await page.locator('#iw-execution .cc-node').first().click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('dialog')).toContainText('Source event ID');
    await page.getByRole('button', { name: 'Close details', exact: true }).click();
    await page.locator('#iw-sources > summary').click();
    await page.getByRole('combobox', { name: 'Source type' }).selectOption('event');
    await page.getByRole('textbox', { name: 'Search source citations' }).fill('no-such-evidence');
    await expect(page.getByText('No matching source references.')).toBeVisible();
    await page.getByRole('textbox', { name: 'Search source citations' }).fill('');
    await page.locator('.iw-citation-list button').filter({hasText:'event:'}).first().click();
    await expect(page.locator('.iw-source')).not.toContainText('Source unavailable');
    await page.getByRole('tab',{name:'History'}).click();
    await page.getByRole('button',{name:'Open saved report'}).click();
    await page.reload();
    await expect(page.getByRole('tab',{name:'Summary'})).toHaveAttribute('aria-selected','true');
    expect(writes).toBe(0);
    await page.getByRole('button',{name:'Review resolution proposal'}).click();
    await expect(page.getByText('No action has been approved or executed.',{exact:false})).toBeVisible();
    await page.close();
  }
});
test('review flags and stale reports stay visible while routine notes disclose fully', async ({ page }) => {
  await saved(page, 'CASE-000011', { stale: true, reviewFlag: 'Verify the current financial execution before acting.' });
  await expect(page.locator('.iw-stale')).toContainText('Current source evidence has changed.');
  await expect(page.locator('.iw-important-notes')).toContainText('Verify the current financial execution before acting.');
  await expect(page.locator('.iw-review-details')).not.toHaveAttribute('open');
  await page.locator('.iw-review-details > summary').click();
  await expect(page.locator('.iw-review-details')).toContainText(reports['CASE-000011'].unresolved_questions.at(-1));
  await page.getByRole('tab', { name: 'Evidence' }).click();
  await page.getByRole('link', { name: 'Sources', exact: true }).click();
  await expect(page.locator('#iw-sources')).toHaveAttribute('open');
  await page.getByRole('textbox', { name: 'Search source citations' }).fill('case:');
  await page.locator('.iw-citation-list button').first().click();
  await expect(page.locator('.iw-source')).toContainText('Source unavailable.');
});
test('responsive layout and keyboard tabs',async({page})=>{
  await saved(page,'CASE-000011');
  for(const width of [1920,1440,1280,1024,390]) {
    await page.setViewportSize({width,height:1000});
    await expect(page.locator('#cc-diagnosis-title')).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBeTruthy();
    await page.screenshot({path:`test-results/investigation-${width}.png`,fullPage:true});
    await page.getByRole('tab',{name:'Evidence'}).click();
    await expect(page.locator('#iw-relationships')).toHaveCount(0);
    await page.locator('#iw-execution > summary').click();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBeTruthy();
    await page.screenshot({path:`test-results/investigation-evidence-${width}.png`,fullPage:true});
    await page.getByRole('tab',{name:'History'}).click();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBeTruthy();
    await page.screenshot({path:`test-results/investigation-history-${width}.png`,fullPage:true});
    await page.getByRole('tab',{name:'Summary'}).click();
  }
  await page.getByRole('tab',{name:'Summary'}).focus();await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab',{name:'Evidence'})).toBeFocused();
  await page.keyboard.press('End');await expect(page.getByRole('tab',{name:'History'})).toBeFocused();
});
