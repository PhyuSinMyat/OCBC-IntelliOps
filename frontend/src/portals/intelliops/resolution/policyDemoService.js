import { resolutionCustomerResponses, resolutionIncidentNotifications } from './communicationService.js';
import { financialMetrics, isOpenCase } from './resolutionData.js';
import { getSessionResolutionVersions, pendingResolutionResponses } from './resolutionPlannerService.js';

const memory = new Map();
const storagePrefix = 'intelliops-policy-demo-v1:';
const storageKey = caseId => storagePrefix + JSON.stringify(caseId);
const actions = {
  ESCALATE_DUPLICATE_FINANCIAL_EXECUTION: {
    label: 'Financial Correction Review', financial: true, classification: 'DOUBLE_POSTING_CONFIRMED',
    diagnosis: 'CONFIRMED_DUPLICATE_REQUEST', journals: 2,
  },
  CLOSE_HELD_DUPLICATE: {
    label: 'Held-Duplicate Closure Review', financial: false, classification: 'SINGLE_POSTING_CONFIRMED',
    diagnosis: 'CONFIRMED_DUPLICATE_REQUEST', journals: 1,
  },
  REVIEW_FALSE_POSITIVE_CLOSURE: {
    label: 'False-Positive Closure Review', financial: false, classification: 'DOUBLE_POSTING_CONFIRMED',
    diagnosis: 'LEGITIMATE_SEPARATE_INSTRUCTIONS', journals: 2,
  },
};

const actionRule = plan => Object.hasOwn(actions, plan?.recommendedActionCode) ? actions[plan.recommendedActionCode] : null;
export const policyActionLabel = plan => actionRule(plan)?.label || 'Unsupported action';
const selectKeys = ['plan', 'version', 'snapshot', 'freshness'];

export function resolvePolicyContext(params) {
  const caseId = params.get('case');
  const investigationId = params.get('investigation');
  const versions = getSessionResolutionVersions(caseId, investigationId);
  const current = versions.at(-1);
  const explicit = selectKeys.some(key => params.has(key));
  const plan = explicit ? versions.find(item => item.planId === params.get('plan') && String(item.version) === params.get('version')) : current;
  const responses = resolutionCustomerResponses(caseId, investigationId);
  const notifications = resolutionIncidentNotifications(caseId, investigationId);
  const pending = Boolean(plan && pendingResolutionResponses(plan, responses).length);
  let block = '';
  if (explicit && !plan) block = 'The selected plan reference is unavailable in this browser session.';
  else if (plan && plan !== current) block = 'This resolution plan has been superseded. Open the current version in Resolution Plans.';
  else if (pending) block = 'The current plan has unreviewed customer input. Reassess it before policy handoff.';
  else if (explicit && (params.get('snapshot') !== plan?.customerSnapshot.reference || params.get('freshness') !== 'current')) {
    block = 'The handoff references a different snapshot or freshness status. Reopen Policy Assessment from the current plan.';
  }
  return { caseId, investigationId, plan, current, explicit, block, responses, notifications };
}

function workflowFingerprint(context) {
  return JSON.stringify([
    context.plan?.customerSnapshot.reference,
    context.responses.map(response => response.id).sort(),
    [...context.notifications].sort(),
  ]);
}

export function assessmentApplies(assessment, context) {
  return Boolean(assessment && !context.block && assessment.caseId === context.caseId &&
    assessment.investigationId === context.investigationId && assessment.planId === context.plan?.planId &&
    assessment.planVersion === context.plan?.version && assessment.customerSnapshotReference === context.plan?.customerSnapshot.reference &&
    assessment.workflowFingerprint === workflowFingerprint(context));
}

const pass = description => ['PASS', description];
const verify = description => ['REVIEW_REQUIRED', description];
const block = description => ['BLOCKED', description];
const approve = description => ['APPROVAL_REQUIRED', description];

export function evaluatePolicy(context, evidence) {
  const { plan } = context;
  const rule = actionRule(plan);
  const report = evidence.item?.report;
  const accepted = evidence.record?.id === context.caseId && report?.prototype === false &&
    report.run_status === 'COMPLETED' && report.case_id === context.caseId && report.investigation_id === context.investigationId;
  const classificationMatches = accepted && rule && report.financial_execution_assessment?.classification === rule.classification &&
    report.diagnosis_classification === rule.diagnosis && report.recommended_action_code === plan.recommendedActionCode;
  const metrics = accepted ? financialMetrics(report) : [];
  const supportedAmounts = rule?.financial
    ? ['Intended transfer', 'Posted transfer movement', 'Apparent duplicate excess'].every(label => metrics.some(metric => metric[0] === label && metric[1] != null))
    : metrics.some(([label, value]) => ['Posted transfer movement', 'Verified debit totals'].includes(label) && value);
  const currentEvidence = accepted && evidence.item.stale === false;
  const inconsistentEvidence = accepted && evidence.item.stale === true;
  const evaluatedAt = new Date().toISOString();
  const active = accepted && isOpenCase(evidence.record);
  const inspection = {
    currency: context.block || !plan ? block(context.block || 'Select a current resolution plan.') :
      pass('The selected version is current and includes all recorded customer replies.'),
    evidence: accepted ? pass(evidence.isWalkthrough ? 'The local walkthrough investigation fixture is linked to this proposal.' :
      'An accepted historical investigation is linked to this proposal.') :
      evidence.kind === 'unavailable' ? verify('The accepted investigation could not be checked.') :
        block('The linked accepted investigation could not be found for this case.'),
    financial: inconsistentEvidence && rule?.financial ? block('Current source records differ from the saved snapshot. Financial correction review is blocked.') :
      !currentEvidence ? verify(evidence.reason || (inconsistentEvidence
        ? 'Current source records differ from the saved snapshot.'
        : 'Current source evidence could not be confirmed.')) :
      !rule ? block('The proposed action has no supported financial verification rule in this demo.') :
      !supportedAmounts || report.financial_impact?.confirmedPostedJournalCount !== rule.journals
        ? verify('Verification required. The saved report does not establish the expected posting count and supported amounts.') :
        pass(rule.financial ? 'The verified instruction, posted movement and apparent excess support a correction review.' :
          'Verified postings support a closure review. This plan does not propose a financial correction.'),
    action: !rule ? block('This action is outside the controlled demo workflow.') :
      !accepted ? verify('Verification required before action eligibility can be checked.') :
      !active ? block('This exception is no longer open.') :
      !classificationMatches ? block('The proposed action does not match the saved investigation’s financial and instruction classifications.') :
        pass('The proposed action matches the saved findings and routes to human review.'),
    approval: !rule ? block('An unsupported action cannot be forwarded for approval.') :
      rule.financial ? approve('An Administrator must review the financial correction proposal. The Analyst cannot self-approve.') :
        pass('The next step is human closure review. This assessment does not close the case.'),
    communication: context.block && plan && pendingResolutionResponses(plan, context.responses).length
      ? block('A recorded customer reply is absent from this plan’s snapshot.') :
      rule?.financial && plan.customerCommunication.recommended && !context.notifications.length
        ? verify('Record the recommended simulated incident notification before forwarding this financial correction proposal.') :
        pass(context.notifications.length ? 'A simulated incident notification is on record. Customer replies are optional for internal review.' :
          'A customer notification is not required for this internal review step.'),
  };
  const names = [
    ['currency', 'Resolution Plan Currency'], ['evidence', 'Investigation Evidence'],
    ['financial', 'Current Financial Verification'], ['action', 'Action Eligibility'],
    ['approval', 'Approval Requirement'], ['communication', 'Customer Communication'],
  ];
  const controls = names.map(([id, name]) => {
    const [status, reason] = inspection[id];
    return { id, name, status, reason };
  });
  const precedence = ['BLOCKED', 'REVIEW_REQUIRED', 'APPROVAL_REQUIRED'];
  const status = precedence.find(candidate => controls.some(control => control.status === candidate)) || 'ELIGIBLE';
  return {
    assessmentId: crypto.randomUUID?.() || Array.from(crypto.getRandomValues(new Uint32Array(4)), value => value.toString(16)).join('-'),
    caseId: context.caseId, investigationId: context.investigationId,
    planId: plan?.planId, planVersion: plan?.version, evaluatedAt,
    status, controls, requiredApproverRole: rule?.financial ? 'Administrator' : null,
    customerResponseIds: plan?.customerSnapshot.responses.map(response => response.id) || [],
    customerSnapshotReference: plan?.customerSnapshot.reference,
    evidenceSnapshotReference: accepted ? report.evidence_snapshot_at || null : null,
    verifiedFinancialMetrics: currentEvidence && inspection.financial[0] === 'PASS'
      ? metrics.filter(([, value]) => value != null).map(([label, value]) => ({ label, value })) : [],
    verification: { state: currentEvidence ? 'CURRENT' : inconsistentEvidence ? 'INCONSISTENT' : 'UNAVAILABLE',
      checkedAt: currentEvidence ? evaluatedAt : null },
    workflowFingerprint: workflowFingerprint(context), isSimulated: true,
  };
}

export function getPolicyActivity(caseId) {
  if (!caseId) return { assessments: [], submissions: [] };
  if (memory.has(caseId)) return memory.get(caseId);
  try {
    const saved = JSON.parse(globalThis.sessionStorage.getItem(storageKey(caseId)));
    if (Array.isArray(saved?.assessments) && Array.isArray(saved?.submissions)) return saved;
  } catch {
    // Use the in-memory session if browser storage is restricted.
  }
  return { assessments: [], submissions: [] };
}

export function listPolicyCaseIds() {
  const ids = new Set(memory.keys());
  try {
    for (let index = 0; index < globalThis.sessionStorage.length; index++) {
      const key = globalThis.sessionStorage.key(index);
      if (key?.startsWith(storagePrefix)) {
        const caseId = JSON.parse(key.slice(storagePrefix.length));
        if (typeof caseId === 'string') ids.add(caseId);
      }
    }
  } catch {
    // Browser storage can be unavailable. In-memory case activity is still readable.
  }
  return [...ids];
}

export function persistPolicyDecision(caseId, state) {
  globalThis.sessionStorage.setItem(storageKey(caseId), JSON.stringify(state));
  memory.set(caseId, state);
}

function saveActivity(caseId, state) {
  memory.set(caseId, state);
  try {
    globalThis.sessionStorage.setItem(storageKey(caseId), JSON.stringify(state));
  } catch {
    // The open application retains the decision history in memory.
  }
  return state;
}

export function recordPolicyAssessment(assessment) {
  const state = getPolicyActivity(assessment.caseId);
  return saveActivity(assessment.caseId, { ...state, assessments: [...state.assessments, assessment] });
}

export function policySubmissionReadiness(context, assessment, state) {
  const latest = state.assessments.findLast(item => item.planId === context.plan?.planId && item.planVersion === context.plan?.version);
  if (context.block) return { reason: context.block };
  if (!assessmentApplies(assessment, context) || assessment.assessmentId !== latest?.assessmentId ||
      context.plan?.version !== context.current?.version) {
    return { reason: 'Re-evaluate Policy using the current plan and customer snapshot before submitting.' };
  }
  if (assessment.status !== 'APPROVAL_REQUIRED' ||
      assessment.controls.some(control => ['BLOCKED', 'REVIEW_REQUIRED'].includes(control.status))) {
    return { reason: 'The policy result does not permit submission for Administrator review.' };
  }
  const submission = state.submissions.find(item => item.caseId === context.caseId &&
    item.planId === assessment.planId && item.planVersion === assessment.planVersion && item.assessmentId === assessment.assessmentId);
  if (submission) return { submission };
  const passed = id => assessment.controls.some(control => control.id === id && control.status === 'PASS');
  if (assessment.verification?.state !== 'CURRENT' || !assessment.evidenceSnapshotReference ||
      !passed('evidence') || !passed('financial') || !assessment.requiredApproverRole ||
      !assessment.controls.some(control => control.id === 'approval' && control.status === 'APPROVAL_REQUIRED')) {
    return { reason: 'Unable to verify submission readiness. Re-evaluate Policy to confirm current evidence and approval requirements.' };
  }
  return { ready: true };
}

export function recordPolicySubmission(context, assessment, submittedByRole) {
  const state = getPolicyActivity(context.caseId);
  const readiness = policySubmissionReadiness(context, assessment, state);
  if (readiness.submission) return state;
  if (!readiness.ready) throw new Error(readiness.reason);
  const submission = {
    requestId: 'DEMO-APPROVAL:' + assessment.assessmentId,
    assessmentId: assessment.assessmentId, caseId: assessment.caseId, investigationId: assessment.investigationId,
    planId: assessment.planId, planVersion: assessment.planVersion, customerSnapshotReference: assessment.customerSnapshotReference,
    outcome: assessment.status, proposedAction: context.plan.recommendedActionCode,
    requiredApproverRole: assessment.requiredApproverRole, status: 'PENDING_APPROVAL',
    submittedByRole: submittedByRole || null, submittedAt: new Date().toISOString(), isSimulated: true,
  };
  return saveActivity(context.caseId, { ...state, submissions: [...state.submissions, submission],
    approvalEvents: [...(state.approvalEvents || []), {
      id: submission.requestId + ':submitted', eventType: 'APPROVAL_REQUEST_SUBMITTED', requestId: submission.requestId,
      caseId: submission.caseId, planId: submission.planId, planVersion: submission.planVersion,
      assessmentId: submission.assessmentId, actingRole: submission.submittedByRole,
      createdAt: submission.submittedAt, isSimulated: true,
    }],
  });
}

export function getPolicySubmission(params) {
  return getPolicyActivity(params.get('case')).submissions.find(item =>
    item.assessmentId === params.get('assessment') && item.investigationId === params.get('investigation') &&
    item.planId === params.get('plan') && String(item.planVersion) === params.get('version') &&
    item.customerSnapshotReference === params.get('snapshot') &&
    (!params.has('request') || item.requestId === params.get('request')));
}
