import { assessmentApplies, getPolicyActivity, listPolicyCaseIds, persistPolicyDecision, policySubmissionReadiness, resolvePolicyContext } from './policyDemoService.js';
import { getSessionResolutionVersions } from './resolutionPlannerService.js';

const requestIdFor = request => request.requestId || 'DEMO-APPROVAL:' + request.assessmentId;

export function approvalRequestSearch(request) {
  return '?' + new URLSearchParams({
    case: request.caseId, investigation: request.investigationId, plan: request.planId,
    version: String(request.planVersion), snapshot: request.customerSnapshotReference,
    freshness: 'current', assessment: request.assessmentId, request: requestIdFor(request),
  }).toString();
}

function linkedRequest(submission, state) {
  const requestId = requestIdFor(submission);
  const versions = getSessionResolutionVersions(submission.caseId, submission.investigationId);
  const plan = versions.find(item => item.planId === submission.planId && item.version === submission.planVersion);
  const assessment = state.assessments.find(item => item.assessmentId === submission.assessmentId);
  const decision = state.approvalDecisions?.find(item => item.requestId === requestId) || null;
  return { ...submission, requestId, plan, assessment, decision,
    status: decision?.decision || submission.status || 'PENDING_APPROVAL',
    proposedAction: submission.proposedAction || plan?.recommendedActionCode };
}

export function listApprovalRequests() {
  return listPolicyCaseIds().flatMap(caseId => {
    const state = getPolicyActivity(caseId);
    return state.submissions.filter(item => item.caseId === caseId && item.isSimulated === true)
      .map(item => linkedRequest(item, state));
  });
}

export function getApprovalRequest(params) {
  const caseId = params.get('case');
  const state = getPolicyActivity(caseId);
  const keys = [
    ['investigation', 'investigationId'], ['plan', 'planId'], ['version', 'planVersion'],
    ['snapshot', 'customerSnapshotReference'], ['assessment', 'assessmentId'],
  ];
  const submission = state.submissions.find(item => item.caseId === caseId && item.isSimulated === true &&
    (params.has('request') ? requestIdFor(item) === params.get('request') : params.get('assessment') === item.assessmentId) &&
    keys.every(([key, field]) => !params.has(key) || params.get(key) === String(item[field])));
  return submission ? linkedRequest(submission, state) : null;
}

export function approvalContext(request) {
  return resolvePolicyContext(new URLSearchParams(approvalRequestSearch(request)));
}

export function approvalBlock(request) {
  if (request.status !== 'PENDING_APPROVAL') return 'A decision has already been recorded for this request.';
  if (!request.plan) return 'The originally submitted plan is unavailable. The linked plan must be recovered before a decision.';
  if (!request.assessment) return 'The linked policy assessment is unavailable. The request cannot be decided.';
  const context = approvalContext(request);
  if (context.block) return context.block;
  const assessment = request.assessment;
  if (!assessmentApplies(assessment, context) || assessment.status !== 'APPROVAL_REQUIRED' ||
      request.proposedAction !== request.plan.recommendedActionCode || request.outcome !== assessment.status ||
      assessment.verification?.state !== 'CURRENT' || !assessment.evidenceSnapshotReference ||
      assessment.controls.some(control => ['BLOCKED', 'REVIEW_REQUIRED'].includes(control.status)) ||
      !['currency', 'evidence', 'financial', 'action', 'communication'].every(id =>
        assessment.controls.some(control => control.id === id && control.status === 'PASS')) ||
      !assessment.controls.some(control => control.id === 'approval' && control.status === 'APPROVAL_REQUIRED') ||
      assessment.requiredApproverRole !== 'Administrator' ||
      (request.requiredApproverRole && request.requiredApproverRole !== assessment.requiredApproverRole)) {
    return 'The submitted policy and verification references cannot be confirmed. Reassess the current plan and submit a new request.';
  }
  const readiness = policySubmissionReadiness(context, assessment, getPolicyActivity(request.caseId));
  return readiness.submission ? '' : readiness.reason || 'The linked submission is no longer eligible for review.';
}

export const validDecisionReason = reason => reason.trim().length >= 12 && /\p{L}/u.test(reason);

export function recordApprovalDecision(params, decision, reason, actingRole) {
  if (actingRole !== 'ADMIN') throw new Error('Only an Administrator can record a simulated decision.');
  if (!['APPROVED', 'REJECTED'].includes(decision) || !validDecisionReason(reason)) {
    throw new Error('Enter a decision reason of at least 12 characters.');
  }
  const request = getApprovalRequest(params);
  if (!request) throw new Error('The approval request is unavailable.');
  const blocked = approvalBlock(request);
  if (blocked) throw new Error(blocked);
  const decidedAt = new Date().toISOString();
  const decisionRecord = {
    requestId: request.requestId, caseId: request.caseId, planId: request.planId,
    planVersion: request.planVersion, assessmentId: request.assessmentId, investigationId: request.investigationId,
    customerSnapshotReference: request.customerSnapshotReference,
    decision, reason: reason.trim(), actingRole, decidedAt, isSimulated: true,
  };
  const state = getPolicyActivity(request.caseId);
  try {
    persistPolicyDecision(request.caseId, { ...state,
      approvalDecisions: [...(state.approvalDecisions || []), decisionRecord],
      approvalEvents: [...(state.approvalEvents || []), {
        ...decisionRecord, id: request.requestId + ':decision', eventType: 'APPROVAL_DECISION_RECORDED', createdAt: decidedAt,
      }],
    });
  } catch {
    throw new Error('The browser could not save this decision. The request is still pending.');
  }
}
