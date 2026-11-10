import { analyzeSnapshot, evidenceSnapshot, isDuplicate, stages } from './analysis.js';

const storageKey = 'intelliops-investigations-prototype-v2';
const listeners = new Set();
let revision = 0;
let saved = { runs: {}, handoffs: {} };
try {
  const value = JSON.parse(globalThis.sessionStorage?.getItem(storageKey) || 'null');
  if (value?.runs && value?.handoffs) saved = value;
} catch { /* An invalid prototype cache does not affect banking records. */ }
const activeStatuses = ['QUEUED', 'COLLECTING_EVIDENCE', 'ANALYZING'];
for (const runs of Object.values(saved.runs)) {
  for (const run of runs) if (activeStatuses.includes(run.run_status)) {
    run.run_status = 'FAILED';
    run.error = 'This simulated run was interrupted by a page reload. Retry to collect a fresh evidence snapshot.';
    run.completed_at = new Date().toISOString();
  }
}
function persist() {
  // Fail explicitly if storage is unavailable: do not claim a report was saved.
  globalThis.sessionStorage?.setItem(storageKey, JSON.stringify(saved));
}
function notify() { revision++; listeners.forEach(fn => fn()); }
export const subscribeInvestigations = fn => { listeners.add(fn); return () => listeners.delete(fn); };
export const investigationRevision = () => revision;
export const investigationKey = (c, scope) => `${scope}:${c.id}:${c.transactionId}`;
export const getRuns = key => saved.runs[key] || [];
export const getHandoff = id => saved.handoffs[id] || null;
const pause = () => new Promise(resolve => setTimeout(resolve, 420));

// Replace this adapter with FastAPI start/status/report calls when available.
// Components consume structured reports and never parse generated prose.
export async function startInvestigation({ key, caseRecord, records, accounts, fixture, failEvidence = false }) {
  if (!isDuplicate(caseRecord)) throw new Error('Only Duplicate Transaction investigation is supported.');
  if (getRuns(key).some(r => activeStatuses.includes(r.run_status))) throw new Error('An investigation is already running for this case.');
  const now = new Date().toISOString();
  const snapshot = evidenceSnapshot(caseRecord, records, accounts, fixture);
  const run = { case_id: caseRecord.id, investigation_id: `INV-${crypto.randomUUID()}`, run_status: 'QUEUED',
    started_at: now, completed_at: null, evidence_snapshot_at: now, stage_index: -1, snapshot, prototype: true };
  const oldRuns = getRuns(key);
  saved.runs[key] = [...oldRuns, run];
  try { persist(); } catch { saved.runs[key] = oldRuns; throw new Error('Unable to save investigation state. Enable session storage and retry.'); }
  notify();
  try {
    await pause();
    for (let index = 0; index < stages.length; index++) {
      run.stage_index = index;
      run.run_status = index < 3 ? 'COLLECTING_EVIDENCE' : 'ANALYZING';
      persist(); notify(); await pause();
      if (index === 2 && failEvidence) throw new Error('Simulated ledger evidence timeout. No diagnosis was produced. Retry collects a fresh snapshot.');
    }
    run.report = { ...analyzeSnapshot(snapshot), case_id: caseRecord.id, investigation_id: run.investigation_id,
      run_status: 'COMPLETED', started_at: now, completed_at: new Date().toISOString(), evidence_snapshot_at: now, prototype: true };
    run.run_status = 'COMPLETED';
    run.completed_at = run.report.completed_at;
    persist(); notify();
  } catch (error) {
    run.run_status = 'FAILED'; run.completed_at = new Date().toISOString(); run.error = error.message;
    delete run.report;
    try { persist(); } catch { run.error = 'Investigation could not be saved. Enable session storage, then retry.'; }
    notify();
  }
  return run;
}
export function sendToResolution(key, investigationId) {
  const run = getRuns(key).find(r => r.investigation_id === investigationId);
  if (run?.run_status !== 'COMPLETED' || !run.report) throw new Error('A completed investigation is required.');
  const id = run.investigation_id;
  const handoff = structuredClone({ ...run.report, evidence_references: [
    ...run.snapshot.events.map(e => `event:${e.id}`), ...run.snapshot.journals.map(j => `journal:${j.id}`),
    ...[run.snapshot.original, run.snapshot.duplicate].filter(Boolean).map(p => `payment:${p.id}`),
  ], submitted_at: new Date().toISOString(), source_scope: key, fixture: run.snapshot.fixture });
  const previous = saved.handoffs[id];
  saved.handoffs[id] = handoff;
  try { persist(); } catch { if (previous) saved.handoffs[id] = previous; else delete saved.handoffs[id]; throw new Error('Unable to save Resolution handoff. Enable session storage and retry.'); }
  notify();
  return handoff;
}
