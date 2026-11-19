const storagePrefix = 'intelliops-resolution-demo-v1:';
const sessionPlans = new Map();

export const resolutionStages = [
  'Preparing investigation context',
  'Reviewing verified financial evidence',
  'Assessing resolution options',
  'Structuring recommended next steps',
];

const examples = {
  ESCALATE_DUPLICATE_FINANCIAL_EXECUTION: {
    diagnosis: 'CONFIRMED_DUPLICATE_REQUEST',
    classification: 'DOUBLE_POSTING_CONFIRMED',
    journalCount: 2,
    resolutionTitle: 'Escalate Duplicate Financial Execution for Correction Review',
    summary: 'The accepted investigation supports duplicate financial execution for one instruction. Prepare a controlled correction review and verify the current ledger before any decision.',
    steps: [
      ['verify', 'Verify the original and retry postings', 'Compare the linked instructions, payment records, and journals to confirm the excess execution.', ['payment', 'instruction', 'journal']],
      ['impact', 'Review customer impact', 'Identify the affected parties and confirm the apparent excess against the verified financial evidence.', ['payment', 'journal']],
      ['communicate', 'Prepare customer communication', 'Draft an apology and incident notification for review. Record customer preferences only when a response is available.', ['payment']],
      ['prepare', 'Prepare the correction review', 'Document the apparent excess and the supporting evidence for authorised financial operations review.', ['journal']],
      ['approve', 'Route for administrator review', 'Prepare the escalation for deterministic policy checks and authorised approval.', []],
      ['audit', 'Record the decision and next steps', 'Document the authorised decision, audit history, and any customer status update.', []],
    ],
    customerCommunication: {
      recommended: true,
      reason: 'An additional transfer may have affected the customer. Review the incident wording and any available response before contacting them.',
      suggestedMessageType: 'Incident notification and apology draft',
    },
    financialConsiderations: ['Reconcile both postings against the same underlying instruction.', 'Verify the current ledger and check for any previous correction.'],
    risksAndSafeguards: [
      'Prevent incorrect or duplicate corrections by reconciling the current ledger and checking prior actions.',
      'Assess customer and recipient-account impact before deciding whether to escalate.',
      'Require deterministic policy validation and authorised approval. Keep an audit trail of the decision.',
      'Prevent automatic financial posting or reversal.',
    ],
    approvalRecommendation: {
      required: true, suggestedRole: 'Admin',
      reason: 'A financial correction requires authorised review and separate verification.',
    },
    uncertainty: ['The appropriate accounting action and customer impact require separate verification and authorisation.'],
  },
  CLOSE_HELD_DUPLICATE: {
    diagnosis: 'CONFIRMED_DUPLICATE_REQUEST',
    classification: 'SINGLE_POSTING_CONFIRMED',
    journalCount: 1,
    resolutionTitle: 'Review Held-Duplicate Closure',
    summary: 'Review the held repeat for closure after confirming that the original transfer posted and the repeat remains unexecuted.',
    steps: [
      ['verify', 'Confirm the original posting and repeat hold', 'Check the payment and journal records for the original instruction and verify the repeat remains held.', ['payment', 'journal']],
      ['check', 'Check for a later release or retry', 'Recheck the processing trail and current ledger before recommending closure.', ['event', 'journal']],
      ['review', 'Record the closure recommendation', 'Document the evidence and route the recommendation to an authorised reviewer.', []],
    ],
    customerCommunication: {
      recommended: false, reason: 'The saved evidence shows one posting. Review communication if the customer reported an issue or a policy requires contact.',
      suggestedMessageType: 'Status clarification if required',
    },
    financialConsiderations: ['Verify that the original payment is the only posting for the instruction.'],
    risksAndSafeguards: ['Check the held request for any late execution.', 'Require authorised closure review and record its outcome.'],
    approvalRecommendation: { required: true, suggestedRole: 'Authorised case reviewer', reason: 'A reviewer should confirm the repeat remains held before closure.' },
    uncertainty: ['The repeat’s current state must be confirmed before closure.'],
  },
  REVIEW_FALSE_POSITIVE_CLOSURE: {
    diagnosis: 'LEGITIMATE_SEPARATE_INSTRUCTIONS',
    classification: 'DOUBLE_POSTING_CONFIRMED',
    journalCount: 2,
    resolutionTitle: 'Review False-Positive Closure',
    summary: 'Review the alert for closure after confirming that each posting belongs to a separately authorised instruction.',
    steps: [
      ['verify', 'Verify both authorisations', 'Confirm that each payment is backed by its own authorised instruction.', ['instruction', 'event', 'payment']],
      ['reconcile', 'Reconcile each posting to its instruction', 'Check the journals individually and retain both authorised postings in the review.', ['payment', 'journal']],
      ['review', 'Document the false-positive rationale', 'Send the closure recommendation and its evidence to an authorised reviewer.', []],
    ],
    customerCommunication: {
      recommended: false, reason: 'The saved evidence supports two independent instructions. Contact may be appropriate if the customer queried either payment.',
      suggestedMessageType: 'Payment clarification if requested',
    },
    financialConsiderations: ['Validate the postings separately and preserve the distinction between the two instructions.'],
    risksAndSafeguards: ['Avoid treating independently authorised transfers as duplicate execution.', 'Confirm the current evidence and retain the audit trail for closure review.'],
    approvalRecommendation: { required: true, suggestedRole: 'Authorised case reviewer', reason: 'Closure should be supported by the distinct authorisations and matched postings.' },
    uncertainty: ['The current status of both payments and any customer dispute remain subject to review.'],
  },
};

function matchingExample(report) {
  const action = report?.recommended_action_code;
  const example = Object.hasOwn(examples, action) ? examples[action] : null;
  if (report?.prototype !== false || report.run_status !== 'COMPLETED' || report.exception_type !== 'DUPLICATE_TRANSACTION' || !example) return null;
  if (report.diagnosis_classification !== example.diagnosis ||
      report.financial_execution_assessment?.classification !== example.classification ||
      report.financial_impact?.confirmedPostedJournalCount !== example.journalCount) return null;
  return example;
}

export const supportsResolutionDemo = report => Boolean(matchingExample(report));

export function normalizeResolutionPlan(raw) {
  return {
    generatedAt: Number.isFinite(Date.parse(raw.generatedAt)) ? raw.generatedAt : null,
    resolutionTitle: raw.resolutionTitle,
    summary: raw.summary,
    recommendedActionCode: raw.recommendedActionCode,
    steps: raw.steps.map(step => ({
      id: step.id,
      title: step.title,
      description: step.description,
      evidenceReferences: [...step.evidenceReferences],
      requiresHumanReview: step.requiresHumanReview,
    })),
    customerCommunication: { ...raw.customerCommunication },
    financialConsiderations: [...raw.financialConsiderations],
    risksAndSafeguards: [...raw.risksAndSafeguards],
    approvalRecommendation: { ...raw.approvalRecommendation },
    uncertainty: [...raw.uncertainty],
    supportingEvidence: [...raw.supportingEvidence],
  };
}

const storageKey = (caseId, investigationId) => storagePrefix + JSON.stringify([caseId, investigationId]);

export function getSessionResolutionVersions(caseId, investigationId) {
  if (!caseId || !investigationId) return [];
  const key = storageKey(caseId, investigationId);
  if (sessionPlans.has(key)) return sessionPlans.get(key);
  try {
    const saved = JSON.parse(globalThis.sessionStorage.getItem(key));
    const versions = Array.isArray(saved?.versions) ? saved.versions : saved ? [saved] : [];
    return versions.map((version, index) => versionMetadata(caseId, investigationId, index + 1, version, version.customerSnapshot));
  } catch {
    return [];
  }
}

export function getSessionResolutionPlan(caseId, investigationId) {
  return getSessionResolutionVersions(caseId, investigationId).at(-1) || null;
}

function versionMetadata(caseId, investigationId, version, proposal, snapshot) {
  const planId = `DEMO-RP:${caseId}:${investigationId}`;
  return {
    ...normalizeResolutionPlan(proposal),
    planId, version, investigationId, simulated: true,
    customerSnapshot: {
      reference: `${planId}/C${version}`,
      responses: snapshot?.responses || [],
    },
  };
}

export function pendingResolutionResponses(plan, responses) {
  const included = new Set(plan?.customerSnapshot.responses.map(response => response.id));
  return responses.filter(response => !included.has(response.id));
}

export function resolutionPolicySearch(search, plan, freshness = 'current') {
  if (!plan) return search;
  const params = new URLSearchParams(search);
  params.set('plan', plan.planId);
  params.set('version', String(plan.version));
  params.set('snapshot', plan.customerSnapshot.reference);
  params.set('freshness', freshness);
  return '?' + params.toString();
}

export function saveSessionResolutionPlan(caseId, investigationId, plan, customerResponses, expectedVersion) {
  const key = storageKey(caseId, investigationId);
  const versions = getSessionResolutionVersions(caseId, investigationId);
  const current = versions.at(-1);
  if ((current?.version || 0) !== expectedVersion) throw new Error('The current plan changed. Reopen Resolution Plans to continue.');
  const saved = versionMetadata(caseId, investigationId, expectedVersion + 1,
    { ...plan, generatedAt: new Date().toISOString() }, { responses: customerResponses });
  const updated = [...versions, saved];
  sessionPlans.set(key, updated);
  try {
    globalThis.sessionStorage.setItem(key, JSON.stringify({ versions: updated }));
  } catch {
    // Browser storage can be unavailable. The open application still retains the demo.
  }
  return updated;
}

async function waitForDemoStage(signal) {
  signal.throwIfAborted();
  await new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, 600);
    signal.addEventListener('abort', abort, { once: true });
  });
}

export async function generateResolutionPlan(caseId, investigationId, { report, signal, onStage, customerResponses = [] }) {
  const example = matchingExample(report);
  if (!example || report.case_id !== caseId || report.investigation_id !== investigationId) {
    throw new Error('A supported accepted investigation is required to generate this simulation.');
  }

  const references = [...new Set(report.evidence_references || [])];
  for (let index = 0; index < resolutionStages.length; index++) {
    onStage(index);
    await waitForDemoStage(signal);
  }

  const steps = example.steps.map(([id, title, description, prefixes]) => ({
    id, title, description, requiresHumanReview: true,
    evidenceReferences: references.filter(ref => prefixes.includes(ref.split(':', 1)[0])).slice(0, 4),
  }));
  const latestResponse = customerResponses.at(-1);
  const followUp = ({
    REQUEST_CORRECTION: 'Acknowledge the request for correction and explain that the request is subject to financial review.',
    REQUEST_ASSISTANCE: 'Arrange an explanation of the incident and the next review steps.',
    CUSTOM_RESPONSE: 'Review the customer’s recorded message and agree the appropriate follow-up.',
  })[latestResponse?.communicationType];
  if (followUp) steps.splice(1, 0, {
    id: 'review-customer-input', title: 'Review customer input and follow up',
    description: followUp, requiresHumanReview: true, evidenceReferences: [],
  });
  return normalizeResolutionPlan({
    ...example, recommendedActionCode: report.recommended_action_code, steps,
    summary: followUp ? `${example.summary} The proposal includes ${customerResponses.length} simulated customer ${customerResponses.length === 1 ? 'reply' : 'replies'} and adds a follow-up step.` : example.summary,
    customerCommunication: followUp ? { recommended: true, reason: followUp, suggestedMessageType: 'Follow-up on customer response' } : example.customerCommunication,
    supportingEvidence: [...new Set(steps.flatMap(step => step.evidenceReferences))],
  });
}
