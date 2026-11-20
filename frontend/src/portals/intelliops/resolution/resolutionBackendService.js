import { exceptionRequest } from '../../../shared/api/banking.js';

// Remove obsolete browser-only workflow records. Investigation session state is
// intentionally preserved; only the three features now backed by the database
// (plus their old approval-preview state) are cleared.
try {
  const prefixes = ['intelliops-resolution-demo-v1:', 'intelliops-communication-demo-v1:',
    'intelliops-communication-audit-v1:', 'intelliops-policy-demo-v1:'];
  for (const key of Object.keys(globalThis.sessionStorage || {})) {
    if (prefixes.some(prefix => key.startsWith(prefix))) globalThis.sessionStorage.removeItem(key);
  }
} catch { /* Backend workflow remains authoritative when browser storage is unavailable. */ }

export const resolutionStages = ['Preparing investigation context', 'Reviewing verified financial evidence',
  'Assessing resolution options', 'Saving the resolution plan'];
const supported = {
  ESCALATE_DUPLICATE_FINANCIAL_EXECUTION: ['DUPLICATE_TRANSACTION', 'CONFIRMED_DUPLICATE_REQUEST', 'DOUBLE_POSTING_CONFIRMED', 2],
  CLOSE_HELD_DUPLICATE: ['DUPLICATE_TRANSACTION', 'CONFIRMED_DUPLICATE_REQUEST', 'SINGLE_POSTING_CONFIRMED', 1],
  REVIEW_FALSE_POSITIVE_CLOSURE: [
    ['DUPLICATE_TRANSACTION', 'LEGITIMATE_SEPARATE_INSTRUCTIONS', 'DOUBLE_POSTING_CONFIRMED', 2],
    ['AMOUNT_MISMATCH', 'NO_AMOUNT_MISMATCH', 'AMOUNT_MATCH_CONFIRMED', null],
    ['MISSING_LEDGER_POSTING', 'POSTING_RECORD_PRESENT', 'POSTING_RECORD_PRESENT', null],
  ],
  ESCALATE_FOR_PAYMENT_VERIFICATION: ['DUPLICATE_TRANSACTION', null, null, null],
  REVIEW_SHORTFALL_ADJUSTMENT: ['AMOUNT_MISMATCH', 'CONFIRMED_AMOUNT_MISMATCH', 'UNDERPOSTING_CONFIRMED', 1],
  REVIEW_OVERPOSTING_CORRECTION: ['AMOUNT_MISMATCH', 'CONFIRMED_AMOUNT_MISMATCH', 'OVERPOSTING_CONFIRMED', 1],
  ESCALATE_FOR_AMOUNT_VERIFICATION: ['AMOUNT_MISMATCH', 'INSUFFICIENT_EVIDENCE', 'EXECUTION_OUTCOME_UNKNOWN', null],
  REVIEW_MISSING_POSTING_REMEDIATION: ['MISSING_LEDGER_POSTING', 'CONFIRMED_MISSING_POSTING', 'NO_POSTING_RECORD_CONFIRMED', 0],
  ESCALATE_FOR_LEDGER_VERIFICATION: ['MISSING_LEDGER_POSTING', 'INSUFFICIENT_EVIDENCE', 'EXECUTION_OUTCOME_UNKNOWN', null],
  REVIEW_PROCESSING_FAILURE_RECOVERY: ['PAYMENT_PROCESSING_FAILURE', 'CONFIRMED_PROCESSING_FAILURE', null, null],
  REVIEW_UNMATCHED_TRANSACTION_RECONCILIATION: ['UNMATCHED_TRANSACTION', 'CONFIRMED_UNMATCHED_TRANSACTION', null, null],
  REVIEW_INVALID_LEDGER_REMEDIATION: ['INVALID_LEDGER_POSTING', 'CONFIRMED_INVALID_LEDGER_POSTING', null, null],
  REVIEW_ACCOUNT_MISMATCH_REMEDIATION: ['LEDGER_ACCOUNT_MISMATCH', 'CONFIRMED_LEDGER_ACCOUNT_MISMATCH', null, null],
  REVIEW_CURRENCY_MISMATCH_REMEDIATION: ['LEDGER_CURRENCY_MISMATCH', 'CONFIRMED_LEDGER_CURRENCY_MISMATCH', null, null],
  REVIEW_PROCESSING_TIMEOUT_RECOVERY: ['PROCESSING_TIMEOUT', 'CONFIRMED_PROCESSING_TIMEOUT', null, null],
};
export function supportsResolutionPlan(report) {
  const configured = supported[report?.recommended_action_code];
  const rules = Array.isArray(configured?.[0]) ? configured : configured ? [configured] : [];
  const matched = rules.some(rule => report.exception_type === rule[0] &&
    (rule[1] == null || report.diagnosis_classification === rule[1]) &&
    (rule[2] == null || report.financial_execution_assessment?.classification === rule[2]) &&
    (rule[3] == null || report.financial_impact?.confirmedPostedJournalCount === rule[3]));
  return Boolean(report?.prototype === false && report.persistence === 'BACKEND_DATABASE' && report.run_status === 'COMPLETED' && matched);
}

export async function readResolutionVersions(caseId, investigationId, options) {
  if (!caseId || !investigationId) return [];
  const query = new URLSearchParams({ investigation_id: investigationId });
  const result = await exceptionRequest(`/api/exceptions/${encodeURIComponent(caseId)}/resolution-plans?${query}`, options);
  return result.plans || [];
}

export async function createResolutionVersion(caseId, investigationId, expectedVersion, options = {}) {
  const result = await exceptionRequest(`/api/exceptions/${encodeURIComponent(caseId)}/resolution-plans`, {
    method: 'POST', signal: options.signal,
    body: { investigation_id: investigationId, expected_version: expectedVersion },
  });
  return result.plans || [];
}

export function pendingResolutionResponses(plan, responses) {
  const included = new Set((plan?.customerSnapshot?.responses || []).map(response => response.id));
  return (responses || []).filter(response => !included.has(response.id));
}

export function hasNewCommunicationContext(plan, contextRevision) {
  return Boolean(plan && Number.isInteger(contextRevision) &&
    plan.customerSnapshot?.revision !== contextRevision);
}

export function resolutionPolicySearch(search, plan, freshness = 'current') {
  if (!plan) return search;
  const params = new URLSearchParams(search);
  params.set('plan', plan.planId); params.set('version', String(plan.version));
  params.set('snapshot', plan.customerSnapshot.reference); params.set('freshness', freshness);
  return '?' + params.toString();
}
