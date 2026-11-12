import { analyzeSnapshot, evidenceSnapshot, isDuplicate, stages } from './analysis.js';
import { exceptionRequest } from '../../../shared/api/banking.js';

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
    run.error = run.prototype === false ? 'The AI request was interrupted by a page reload. Retry explicitly; no saved result is available.' : 'This simulated run was interrupted by a page reload. Retry to collect a fresh evidence snapshot.';
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

export async function loadPersistedInvestigations(key, caseId, { offset = 0 } = {}) {
  const history = await exceptionRequest(`/api/exceptions/${encodeURIComponent(caseId)}/investigations?limit=20&offset=${offset}`);
  const incoming = history.investigations.map(item => {
    const report = item.report;
    return { case_id: caseId, investigation_id: item.investigation_id || `REQUEST-${item.request_id}`,
      request_id: item.request_id, prototype: false, durable: true,
      run_status: report ? 'COMPLETED' : item.status === 'RUNNING' ? 'ANALYZING' : 'FAILED',
      started_at: report?.started_at || item.created_at, completed_at: report?.completed_at,
      evidence_snapshot_at: report?.evidence_snapshot_at,
      stage_index: -1, report: report || undefined,
      snapshot: report?.supporting_evidence || { events: [], journals: [], entries: [] },
      stale: item.stale, current_evidence_availability: history.current_evidence_availability,
      error: item.error?.detail || (item.status === 'RUNNING' ? 'An existing request is reserved. Refresh history; do not start a new paid request.' : undefined) };
  });
  const requestIds = new Set(incoming.map(r => r.request_id));
  const ids = new Set(incoming.map(r => r.investigation_id));
  saved.runs[key] = [...getRuns(key).filter(r => !requestIds.has(r.request_id) && !ids.has(r.investigation_id)), ...incoming]
    .sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at));
  persist(); notify();
  return { hasMore: incoming.length === 20, nextOffset: offset + incoming.length };
}

export async function startInvestigation({ key, caseRecord, records, accounts, fixture, failEvidence = false, mode }) {
  if (!isDuplicate(caseRecord)) throw new Error('Only Duplicate Transaction investigation is supported.');
  if (!['backend', 'prototype'].includes(mode)) throw new Error('Select an explicit backend or prototype investigation mode.');
  if (getRuns(key).some(r => activeStatuses.includes(r.run_status))) throw new Error('An investigation is already running for this case.');
  if (mode === 'backend') return startBackendInvestigation(key, caseRecord);
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

async function startBackendInvestigation(key, caseRecord) {
  const now = new Date().toISOString();
  const requestId = crypto.randomUUID();
  const run = { case_id: caseRecord.id, investigation_id: `REQUEST-${requestId}`, request_id: requestId,
    run_status: 'ANALYZING', started_at: now, completed_at: null, stage_index: -1, prototype: false,
    snapshot: { original: null, duplicate: null, events: [], journals: [], entries: [], fixture: null } };
  const previous = getRuns(key);
  saved.runs[key] = [...previous, run];
  try { persist(); } catch { saved.runs[key] = previous; throw new Error('Unable to save investigation state. Enable session storage and retry.'); }
  notify();
  try {
    const report = await exceptionRequest(`/api/exceptions/${encodeURIComponent(caseRecord.id)}/investigations`, { method: 'POST', requestId });
    if (report.case_id !== caseRecord.id || report.prototype !== false || report.run_status !== 'COMPLETED' || !report.llm_analysis || !report.supporting_evidence) {
      throw new Error('Backend returned an invalid AI investigation result. No prototype was substituted.');
    }
    Object.assign(run, { investigation_id: report.investigation_id, run_status: 'COMPLETED', report,
      completed_at: report.completed_at, evidence_snapshot_at: report.evidence_snapshot_at, snapshot: report.supporting_evidence,
      durable: report.persistence === 'BACKEND_DATABASE' });
    persist(); notify();
  } catch (error) {
    run.run_status = 'FAILED'; run.completed_at = new Date().toISOString(); run.error = error.message;
    delete run.report;
    try { persist(); } catch { run.error = 'The result could not be saved. Enable session storage and retry explicitly.'; }
    notify();
  }
  return run;
}
export function sendToResolution(key, investigationId) {
  const run = getRuns(key).find(r => r.investigation_id === investigationId);
  if (run?.run_status !== 'COMPLETED' || !run.report) throw new Error('A completed investigation is required.');
  const id = run.investigation_id;
  const handoff = structuredClone({ ...run.report, evidence_references: run.report.evidence_references || [
    ...run.snapshot.events.map(e => `event:${e.id}`), ...run.snapshot.journals.map(j => `journal:${j.id}`),
    ...[run.snapshot.original, run.snapshot.duplicate].filter(Boolean).map(p => `payment:${p.id}`),
  ], submitted_at: new Date().toISOString(), source_scope: key, fixture: run.snapshot.fixture });
  const previous = saved.handoffs[id];
  saved.handoffs[id] = handoff;
  try { persist(); } catch { if (previous) saved.handoffs[id] = previous; else delete saved.handoffs[id]; throw new Error('Unable to save Resolution handoff. Enable session storage and retry.'); }
  notify();
  return handoff;
}
