import { exceptionRequest } from '../../shared/api/banking.js';
import { fetchExceptionCase } from '../../shared/data/bankingRecords.js';
import { readInvestigationAuditRuns } from './investigation/service.js';

export const BACKEND = 'Backend Record';
export const SIMULATION = 'Frontend Simulation';
export const SESSION = 'Frontend Session';

export const auditLabel = value => String(value ?? '').replaceAll('_', ' ').toLowerCase().replace(/^./, letter => letter.toUpperCase());
export const auditActor = actor => actor === 'ADMIN' ? 'Administrator' : actor === 'ANALYST' ? 'Analyst' : actor === 'SYSTEM' ? 'System' : actor || 'Unavailable';

const operations = {
  DETECTED: ['Exception detected', 'Exception', 'An exception was recorded by the detection workflow.'],
  EXCEPTION_DETECTED: ['Exception detected', 'Exception', 'An exception was recorded by the detection workflow.'],
  CASE_STATUS_CHANGED: ['Case status changed', 'Exception', 'The recorded case status was updated from durable workflow evidence.'],
  SEVERITY_RECALCULATED: ['Severity recalculated', 'Exception', 'The current severity was updated using observable evidence.'],
  DETECTION_RUN: ['Detection run recorded', 'Exception', 'The detection workflow recorded a run.'],
  NOTE_ADDED: ['Review note added', 'Exception', 'A review note was recorded for the exception.'],
  EXCEPTION_NOTE_ADDED: ['Review note added', 'Exception', 'A review note was recorded for the exception.'],
  RESOLVED: ['Case marked resolved', 'Exception', 'The case lifecycle changed to resolved.'],
  CLOSED: ['Case closed', 'Exception', 'The case lifecycle changed to closed.'],
  EXCEPTION_CLOSED: ['Case closed', 'Exception', 'The case lifecycle changed to closed.'],
  MISSING_LEDGER_REMEDIATED: ['Missing ledger remediation recorded', 'Financial', 'The source audit records a missing-posting remediation.'],
  REMEDIATION_POSTED: ['Corrective posting recorded', 'Financial', 'The case log records a financial remediation posting.'],
  REMEDIATION_COMPLETED: ['Remediation completed', 'Exception', 'The case log records completion of its remediation.'],
  EXCEPTION_REMEDIATED: ['Exception remediation recorded', 'Exception', 'The source audit records a remediation for this exception.'],
  DUPLICATE_REMEDIATED: ['Duplicate exception remediated', 'Exception', 'The source audit records a duplicate exception remediation.'],
  DUPLICATE_REJECTED: ['Duplicate rejected', 'Exception', 'The case log records rejection of a duplicate request.'],
  PAYMENT_CREATED: ['Payment created', 'Financial', 'A payment creation was recorded.'],
  PAYMENT_POSTING_FAILED: ['Payment posting failed', 'Financial', 'The source audit records a failed posting.'],
  RESOLUTION_PLAN_CREATED: ['Resolution plan created', 'Resolution', 'A durable resolution plan version was recorded.'],
  RESOLUTION_PLAN_REASSESSED: ['Resolution plan reassessed', 'Resolution', 'A new durable resolution plan version was recorded.'],
  CUSTOMER_NOTIFICATION_RECORDED: ['Customer notification recorded', 'Communication', 'An outgoing customer communication was persisted.'],
  CUSTOMER_RESPONSE_RECORDED: ['Legacy customer response recorded', 'Communication', 'A legacy response record was persisted.'],
  CUSTOMER_EMAIL_REPLY_IMPORTED: ['Customer email reply imported', 'Communication', 'A linked customer reply was imported from Gmail and persisted.'],
  POLICY_ASSESSMENT_COMPLETED: ['Policy assessment completed', 'Policy', 'A deterministic backend policy assessment was persisted.'],
};

function displayEvent(key, id, properties) {
  return { key, id: String(id), caseId: null, occurredAt: null, actor: null, actorRole: null, outcome: null,
    references: {}, metadata: {}, ...properties };
}

function roleOf(actor) {
  return ['ADMIN', 'ANALYST'].includes(actor) ? actor : null;
}

function operationEvent(namespace, item, caseId, source) {
  const type = item.action || item.actionType || 'AUDIT_EVENT';
  const [title, category, summary] = operations[type] || [auditLabel(type), 'Operations', 'An operational event was recorded.'];
  const details = item.details || {};
  return displayEvent(namespace + ':' + item.id, item.id, {
    caseId, occurredAt: item.createdAt, actor: item.actor, actorRole: roleOf(item.actor),
    type, title, category, summary, source, outcome: type === 'CASE_STATUS_CHANGED' ? details.status : item.status || null,
    references: { sourceReference: item.reference, transaction: details.transactionReference, journal: details.journalReference },
    metadata: item,
  });
}

function bankAudit(records) {
  const caseByTransaction = new Map();
  for (const record of records.exception_cases || []) {
    for (const reference of [record.transactionId, record.relatedTransactionId]) {
      if (!reference) continue;
      const existing = caseByTransaction.get(reference);
      caseByTransaction.set(reference, existing && existing !== record.id ? '' : existing ?? record.id);
    }
  }
  const source = records.dataSource === 'backend' ? BACKEND : SIMULATION;
  return (records.audit_events || []).filter(item => item.id != null).map(item => {
    const relatedCase = item.details?.caseId || (/^CASE-/.test(item.reference || '') ? item.reference :
      caseByTransaction.get(item.reference) || caseByTransaction.get(item.details?.transactionReference));
    return operationEvent('audit:' + source, item, relatedCase || null, source);
  });
}

function investigationEvents({ caseId, investigationId, requestId, report, startedAt, requestedAt, completedAt, status, source, metadata }) {
  const identity = requestId || investigationId;
  if (!identity || !caseId) return [];
  const namespace = 'investigation:' + source + ':' + caseId + ':' + identity;
  const references = { investigation: investigationId, request: requestId };
  const base = { caseId, category: 'Investigation', source, references, metadata };
  const events = [];
  if (startedAt || requestedAt) events.push(displayEvent(namespace + ':start', identity, {
    ...base, occurredAt: startedAt || requestedAt, type: startedAt ? 'INVESTIGATION_STARTED' : 'INVESTIGATION_REQUEST_RECORDED',
    title: startedAt ? 'AI investigation started' : 'Investigation request recorded',
    summary: startedAt ? 'The investigation record includes a start time.' : 'The backend recorded the investigation request.',
  }));
  if (report || ['FAILED', 'REJECTED', 'UNKNOWN'].includes(status)) {
    const title = report ? 'AI investigation completed' : status === 'UNKNOWN' ? 'Investigation outcome unknown' :
      status === 'REJECTED' ? 'Investigation report rejected' : 'AI investigation failed';
    events.push(displayEvent(namespace + ':outcome', identity, {
      ...base, occurredAt: completedAt, type: report ? 'INVESTIGATION_COMPLETED' : 'INVESTIGATION_' + status, title,
      summary: report ? source === SIMULATION ? 'A simulated investigation result was recorded.' :
        'An investigation report is available for this request.' : 'The request does not have an accepted report.',
      outcome: report ? report.validation_status || (source === SIMULATION ? 'COMPLETED' : 'ACCEPTED') : status,
    }));
  }
  return events;
}

function sessionInvestigations() {
  return readInvestigationAuditRuns().flatMap(run => investigationEvents({
    caseId: run.case_id, investigationId: run.report?.investigation_id || (run.investigation_id?.startsWith('REQUEST-') ? null : run.investigation_id),
    requestId: run.request_id, report: run.report,
    startedAt: run.durable ? run.report?.started_at : run.started_at,
    requestedAt: run.durable && !run.report?.started_at ? run.started_at : null,
    completedAt: run.durable ? run.report?.completed_at : run.completed_at, status: run.run_status,
    source: run.durable ? BACKEND : run.prototype === false ? SESSION : SIMULATION,
    metadata: { requestId: run.request_id, status: run.run_status, validationStatus: run.report?.validation_status,
      evidenceSnapshotAt: run.evidence_snapshot_at, error: run.error },
  }));
}

function persistedInvestigations(caseId, records) {
  return records.flatMap(item => investigationEvents({
    caseId, investigationId: item.investigation_id, requestId: item.request_id, report: item.report,
    startedAt: item.report?.started_at, requestedAt: item.created_at, completedAt: item.report?.completed_at, status: item.status,
    source: BACKEND,
    metadata: { requestId: item.request_id, status: item.status, recordedRequestAt: item.created_at,
      evidenceSnapshotAt: item.report?.evidence_snapshot_at, validationStatus: item.report?.validation_status, error: item.error },
  }));
}

function resolutionEvents() {
  return readResolutionAuditVersions().map(record => displayEvent('plan:' + record.planId + ':' + record.version, record.planId, {
    caseId: record.caseId, occurredAt: record.generatedAt, type: record.version === 1 ? 'PLAN_CREATED' : 'PLAN_REASSESSED',
    category: 'Resolution', title: record.version === 1 ? 'Resolution plan created' : 'Resolution plan reassessed',
    summary: 'Simulated resolution plan V' + record.version + ' recorded.', outcome: auditLabel(record.action), source: SIMULATION,
    references: { investigation: record.investigationId, plan: record.planId, version: record.version, snapshot: record.snapshot },
    metadata: record,
  }));
}

function communicationEvents() {
  return readCommunicationAuditRecords().map(record => {
    const kind = record.direction === 'INCOMING' ? 'CUSTOMER_RESPONSE_RECORDED' : record.direction === 'SYSTEM'
      ? 'CUSTOMER_RESPONSE_NOT_RECEIVED' : 'CUSTOMER_NOTIFICATION_RECORDED';
    const titles = {
      CUSTOMER_RESPONSE_RECORDED: 'Customer response recorded',
      CUSTOMER_RESPONSE_NOT_RECEIVED: 'No-response observation recorded',
      CUSTOMER_NOTIFICATION_RECORDED: 'Outgoing notification recorded',
    };
    return displayEvent('communication:' + record.id, record.id, {
      caseId: record.caseId, occurredAt: record.createdAt, actor: record.recordedBy, actorRole: roleOf(record.recordedBy),
      type: kind, category: 'Communication', title: titles[kind],
      summary: auditLabel(record.communicationType) + ' recorded in the simulated conversation.',
      outcome: record.status === 'SENT_SIMULATED' ? 'Simulated send recorded' : auditLabel(record.status), source: SIMULATION,
      references: { investigation: record.investigationId, communication: record.id, relatedCommunication: record.relatedCommunicationId,
        transaction: record.relatedTransactionId }, metadata: record,
    });
  });
}

function approvalEvents(state) {
  const events = new Map();
  for (const item of state.submissions) {
    const requestId = item.requestId || (item.assessmentId ? 'DEMO-APPROVAL:' + item.assessmentId : null);
    if (requestId) events.set(requestId + ':submission', { ...item, requestId, createdAt: item.submittedAt, actingRole: item.submittedByRole });
  }
  for (const item of state.approvalDecisions || []) {
    events.set(item.requestId + ':decision', { ...item, createdAt: item.decidedAt });
  }
  for (const item of state.approvalEvents || []) {
    const key = item.requestId + (item.eventType === 'APPROVAL_DECISION_RECORDED' ? ':decision' : ':submission');
    events.set(key, { ...events.get(key), ...item });
  }
  return [...events.entries()].map(([key, item]) => {
    const title = item.decision === 'APPROVED' ? 'Approval recorded' : item.decision === 'REJECTED' ? 'Rejection recorded' : 'Approval request submitted';
    return displayEvent('approval:' + key, item.id || item.requestId, {
      caseId: item.caseId, occurredAt: item.createdAt, actor: item.actingRole, actorRole: roleOf(item.actingRole),
      type: item.decision ? 'APPROVAL_' + item.decision : 'APPROVAL_REQUEST_SUBMITTED', category: 'Approval', title,
      summary: item.decision ? 'A simulated decision was recorded for the submitted plan. This event does not record financial execution.' :
        'A simulated approval request was recorded for the submitted plan.',
      outcome: auditLabel(item.decision || item.status || 'PENDING_APPROVAL'), source: SIMULATION,
      references: { investigation: item.investigationId, plan: item.planId, version: item.planVersion, assessment: item.assessmentId,
        approval: item.requestId, snapshot: item.customerSnapshotReference }, metadata: item,
    });
  });
}

function policyEvents() {
  return listPolicyCaseIds().flatMap(caseId => {
    const state = getPolicyActivity(caseId);
    return [
      ...state.assessments.map(item => displayEvent('policy:' + item.assessmentId, item.assessmentId, {
        caseId: item.caseId, occurredAt: item.evaluatedAt, type: 'POLICY_ASSESSMENT_COMPLETED', category: 'Policy',
        title: 'Policy assessment completed', summary: 'Deterministic frontend checks were recorded for plan V' + item.planVersion + '.',
        outcome: auditLabel(item.status), source: SIMULATION,
        references: { investigation: item.investigationId, plan: item.planId, version: item.planVersion,
          snapshot: item.customerSnapshotReference, assessment: item.assessmentId }, metadata: item,
      })),
      ...approvalEvents(state),
    ];
  });
}

export function normalizeAuditEvents(records, caseHistories) {
  return [...new Map([
    ...bankAudit(records), ...sessionInvestigations(),
    ...caseHistories.flatMap(scoped => [
      ...(scoped.caseRecord?.timeline || []).filter(item => item.id != null).map(item =>
        operationEvent('case-action:' + scoped.caseRecord.id, item, scoped.caseRecord.id, BACKEND)),
      ...persistedInvestigations(scoped.caseId, scoped.investigations || []),
    ]),
  ].map(event => [event.key, event])).values()];
}

export async function readCaseAuditHistory(caseId, signal) {
  const limit = 50;
  const [details, history] = await Promise.allSettled([
    fetchExceptionCase(caseId, { signal }),
    exceptionRequest(`/api/exceptions/${encodeURIComponent(caseId)}/investigations?limit=${limit}&offset=0`, { signal }),
  ]);
  const investigations = history.status === 'fulfilled' && Array.isArray(history.value?.investigations) ? history.value.investigations : [];
  const errors = [
    details.status === 'rejected' && 'Case lifecycle history unavailable.',
    (history.status === 'rejected' || !Array.isArray(history.value?.investigations)) && 'Saved investigation history unavailable.',
  ].filter(Boolean);
  return { caseId, caseRecord: details.status === 'fulfilled' ? details.value : null, investigations,
    errors, historyLimited: investigations.length === limit };
}
