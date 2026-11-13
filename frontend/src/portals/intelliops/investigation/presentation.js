// Presentation derived from the saved report. No new financial or cause inference.
export const actionPresentation = {
  CLOSE_HELD_DUPLICATE: ['Review held-duplicate closure', 'Shared instruction, one verified posting and a held repeat. Human closure review only.'],
  ESCALATE_DUPLICATE_FINANCIAL_EXECUTION: ['Escalate duplicate financial execution for review', 'Shared instruction with two verified postings. Human review; no automatic financial correction.'],
  REVIEW_FALSE_POSITIVE_CLOSURE: ['Review false-positive closure', 'Independently authorized separate instructions with two verified postings. Human closure review only.'],
  ESCALATE_FOR_PAYMENT_VERIFICATION: ['Escalate for payment verification', 'Obtain additional evidence when intent or execution is uncertain. No closure or financial change.'],
};

export function conclusionPresentation(report) {
  const classification = report.financial_execution_assessment.classification;
  if (report.diagnosis_classification === 'LEGITIMATE_SEPARATE_INSTRUCTIONS') return ['Separate payment instructions', 'The investigation classifies these requests as independently authorized instructions. Review the authorization evidence alongside the verified financial postings.'];
  if (report.diagnosis_classification === 'CONFIRMED_DUPLICATE_REQUEST' && classification === 'SINGLE_POSTING_CONFIRMED') return ['Repeated request held before execution', 'The report identifies a shared payment instruction. One financial posting is verified, and the repeated request was held before execution.'];
  if (report.diagnosis_classification === 'CONFIRMED_DUPLICATE_REQUEST' && classification === 'DOUBLE_POSTING_CONFIRMED') return ['Duplicate financial execution needs review', 'The report identifies a shared instruction with two verified financial postings. Review the source evidence and proposed escalation before any action.'];
  return [report.root_cause_title, 'Review the recorded diagnosis and source evidence. The available financial assessment does not establish a complete outcome.'];
}

export function resultSummary(report) {
  const same = report.diagnosis_classification === 'CONFIRMED_DUPLICATE_REQUEST';
  const separate = report.diagnosis_classification === 'LEGITIMATE_SEPARATE_INSTRUCTIONS';
  const timeout = report.root_cause_code === 'CLIENT_RETRY_ACK_TIMEOUT';
  const idempotency = report.root_cause_code === 'IDEMPOTENCY_CONTROL_FAILURE';
  const customer = report.root_cause_code === 'CUSTOMER_DOUBLE_SUBMISSION';
  const modelInference = report.prototype === false && Boolean(report.root_cause_status);
  const identified = modelInference ? report.root_cause_status === 'MODEL_HYPOTHESIS' : timeout || separate || idempotency || customer;
  const f = report.financial_execution_assessment;
  const financial = {
    SINGLE_POSTING_CONFIRMED: ['One posting confirmed', 'Original posted; repeated request held before execution.', 'positive'],
    DOUBLE_POSTING_CONFIRMED: [modelInference ? 'Two postings verified' : same ? 'Duplicate execution confirmed' : 'Two postings confirmed', separate ? 'Two distinct instructions with verified postings.' : 'Two distinct posted journals. Human review required.', separate ? 'neutral' : 'danger'],
    NO_POSTING_CONFIRMED: ['No posting confirmed', 'Both requests are recorded as held before execution.', 'neutral'],
    EXECUTION_OUTCOME_UNKNOWN: ['Execution outcome unknown', 'Missing evidence prevents full financial verification.', 'caution'],
  }[f.classification] || ['Execution outcome unknown', 'Financial verification is incomplete.', 'caution'];
  const a = report.supporting_evidence.original, b = report.supporting_evidence.duplicate;
  const shared = a?.businessReference && a.businessReference === b?.businessReference ? a.businessReference : null;
  return {
    identified, same, separate, timeout,
    explanation: modelInference || idempotency || customer ? report.root_cause_explanation : timeout ? 'Correlated timeout and retry events link the repeated request to the same payment instruction.' : separate ?
      'Verified authorization evidence establishes separate intended instructions despite similar payment details.' : same ?
        'The requests share the same intended instruction. Available events do not establish why it was submitted again.' :
        'The available records do not establish the intended relationship or underlying cause.',
    relationship: [same ? 'Same intended instruction' : separate ? 'Different instructions' : 'Relationship unverified',
      same ? shared ? `Both requests share ${shared}.` : 'Source instruction evidence and payment attributes agree.' : separate ? 'Two separately verified payment instructions.' : 'Additional instruction evidence is needed.', same ? 'positive' : separate ? 'neutral' : 'caution'],
    cause: [modelInference ? report.root_cause_title : customer ? 'Customer double submission' : idempotency ? 'Idempotency control failure' : timeout ? 'Acknowledgment timeout' : separate ? 'Legitimate repeated payments' : 'Root cause unknown',
      modelInference ? report.root_cause_explanation : customer ? 'Two explicit customer submission events identify the same intended payment.' : idempotency ? 'The structured diagnosis identifies a control failure.' : timeout ? 'A correlated retry follows the timeout.' : separate ? 'Separate instructions explain the similarity.' : 'No evidence establishes the submission trigger.', modelInference ? 'caution' : identified ? 'neutral' : 'caution'],
    financial,
  };
}

const stageNames = {
  PAYMENT_CREATED: 'Request received', VALIDATION_STARTED: 'Validation started', VALIDATION_PASSED: 'Validation passed',
  PROCESSING_STARTED: 'Processing started', LEDGER_POSTED: 'Ledger posting recorded', PROCESSING_COMPLETED: 'Payment completed',
  ACK_TIMEOUT: 'Acknowledgment timeout', RETRY_SUBMITTED: 'Retry request submitted', DUPLICATE_BLOCKED: 'Duplicate request held',
  PROCESSING_FAILED: 'Processing failed',
};
export const eventLabel = type => stageNames[type] || String(type || 'Source event').replaceAll('_', ' ').toLowerCase();

export function eventContext(report, event) {
  const payment = report.payment_comparison.find(p => p?.id === event.paymentId);
  const f = report.financial_execution_assessment;
  const assessment = event.paymentId === f.original.payment_ref ? f.original : event.paymentId === f.duplicate.payment_ref ? f.duplicate : null;
  return { node: { kind: 'event', event, title: eventLabel(event.eventType), at: event.occurredAt,
    journalRefs: event.eventType === 'LEDGER_POSTED' ? assessment?.valid_journals || [] : [] }, payment, report };
}

export function paymentPath(report, side) {
  const s = report.supporting_evidence;
  const payment = side === 'original' ? s.original : s.duplicate;
  const assessment = report.financial_execution_assessment[side];
  const events = s.events.filter(e => e.paymentId === payment?.id);
  const validJournals = s.journals.filter(j => assessment.valid_journals.includes(j.id));
  const nodes = events.map(e => ({ id: `event:${e.id}`, kind: 'event', event: e, title: eventLabel(e.eventType),
    at: e.occurredAt, journalRefs: e.eventType === 'LEDGER_POSTED' ? validJournals.map(j => j.id) : [],
    tone: ['ACK_TIMEOUT', 'DUPLICATE_BLOCKED'].includes(e.eventType) ? 'caution' : e.eventType === 'PROCESSING_FAILED' ? 'danger' : 'neutral' }));
  // A journal may exist without a processing event. Show it as ledger evidence,
  // not as an invented payment-processing stage.
  for (const j of validJournals) if (!events.some(e => e.eventType === 'LEDGER_POSTED')) nodes.push({
    id: `journal:${j.id}`, kind: 'journal', journal: j, title: 'Posted journal verified', at: j.postedAt, journalRefs: [j.id], tone: 'positive',
  });
  nodes.sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0));
  // Execution assessment is an explicit diagnostic check, not a synthetic event.
  nodes.push({ id: `assessment:${side}`, kind: 'assessment', title: assessment.execution === 'Posted' ? 'Financial posting verified' :
    assessment.execution === 'Not Started' ? 'No financial posting started' : 'Execution not fully verified',
    assessment, journalRefs: assessment.valid_journals, tone: assessment.execution === 'Unknown' ? 'caution' : assessment.execution === 'Not Started' ? 'caution' : 'positive' });
  return { payment, nodes, assessment };
}

export function causalEvents(report) {
  const events = report.investigation_trace;
  const s = report.supporting_evidence;
  const result = [];
  const add = event => { if (event && !result.some(e => e.id === event.id)) result.push(event); };
  add(events.find(e => e.paymentId === s.original?.id && e.eventType === 'PAYMENT_CREATED'));
  add(events.find(e => e.paymentId === s.original?.id && e.eventType === 'LEDGER_POSTED'));
  if (report.root_cause_code === 'CLIENT_RETRY_ACK_TIMEOUT') {
    const timeout = events.find(e => e.paymentId === s.original?.id && e.eventType === 'ACK_TIMEOUT' && e.correlationId);
    add(timeout);
    add(events.find(e => e.paymentId === s.duplicate?.id && e.eventType === 'RETRY_SUBMITTED' && e.correlationId === timeout?.correlationId && Date.parse(e.occurredAt) >= Date.parse(timeout?.occurredAt)));
  } else add(events.find(e => e.paymentId === s.duplicate?.id && e.eventType === 'PAYMENT_CREATED'));
  if (report.prototype === false) {
    const cited = new Set(report.root_cause_evidence_refs || []);
    events.filter(event => cited.has(`event:${event.id}`)).forEach(add);
    const types = report.root_cause_code === 'CUSTOMER_DOUBLE_SUBMISSION' ? ['CLIENT_SUBMISSION'] :
      report.root_cause_code === 'IDEMPOTENCY_CONTROL_FAILURE' ? ['ACK_TIMEOUT', 'RETRY_SUBMITTED', 'IDEMPOTENCY_CHECK_FAILED'] :
      report.root_cause_code === 'LEGITIMATE_REPEATED_PAYMENT' ? ['PAYMENT_AUTHORIZED'] : [];
    events.filter(e => types.includes(e.eventType)).forEach(add);
  }
  add(events.find(e => e.paymentId === s.duplicate?.id && ['DUPLICATE_BLOCKED', 'LEDGER_POSTED'].includes(e.eventType)));
  return result.sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
}
