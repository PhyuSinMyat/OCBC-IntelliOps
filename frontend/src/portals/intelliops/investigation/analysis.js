// Deterministic prototype checks. No scenario labels, injection audits or LLM output are consumed.
export const stages = [
  ['Retrieving Payment Instructions', 'Locate the flagged request and its source-linked original.'],
  ['Correlating Processing Events', 'Check recorded holds, submission attempts and retry evidence.'],
  ['Checking Ledger Postings', 'Validate linked journals, entries, amounts and account movements.'],
  ['Analyzing Root Cause', 'Separate supported findings from missing or contradictory evidence.'],
  ['Preparing Investigation Report', 'Save an evidence snapshot and a proposed next action.'],
];
export const isDuplicate = c => ['DUPLICATE_TRANSACTION', 'Duplicate Transaction'].includes(c?.exceptionType);
export const isAmountMismatch = c => ['AMOUNT_MISMATCH', 'Amount Mismatch'].includes(c?.exceptionType);
export const isMissingLedger = c => ['MISSING_LEDGER_POSTING', 'Missing Ledger Posting'].includes(c?.exceptionType);
export const isInvestigable = c => isDuplicate(c) || isAmountMismatch(c) || isMissingLedger(c);
export function relatedPayments(c, records) {
  const payments = records.payment_transactions || [];
  const duplicate = payments.find(p => p.id === c.transactionId);
  const explicit = payments.find(p => p.id === duplicate?.originalPaymentId || p.paymentId && p.paymentId === duplicate?.originalPaymentId);
  const detected = payments.find(p => p.id === c.evidence?.originalReference);
  const original = explicit || detected;
  return { original: original?.id === duplicate?.id ? null : original, duplicate,
    linkConflict: Boolean(explicit && detected && explicit.id !== detected.id) };
}
function cleanPayment(p) {
  if (!p) return null;
  const fields = ['id', 'paymentId', 'senderId', 'receiverId', 'amountCents', 'currency', 'status', 'createdAt',
    'completedAt', 'businessReference', 'instructionVerified', 'originalPaymentId'];
  return Object.fromEntries(fields.filter(k => p[k] !== undefined).map(k => [k, p[k]]));
}
export function evidenceSnapshot(c, records, accountList, fixture = null) {
  const { original, duplicate, linkConflict } = relatedPayments(c, records);
  const payments = [original, duplicate].filter(Boolean);
  const refs = payments.map(p => p.id);
  const journals = (records.ledger_journals || []).filter(j => refs.includes(j.paymentId) || refs.includes(j.sourcePaymentId));
  const journalIds = new Set(journals.map(j => j.id));
  return structuredClone({ fixture, caseRecord: { id: c.id, transactionId: c.transactionId, exceptionType: c.exceptionType,
    severity: c.severity, status: c.status, evidence: c.evidence || {}, createdAt: c.createdAt },
    original: cleanPayment(original), duplicate: cleanPayment(duplicate), linkConflict,
    accounts: accountList.map(a => ({ id: a.id, customer: a.customer, currency: a.currency })),
    journals: journals.map(j => ({ id: j.id, paymentId: j.paymentId, sourcePaymentId: j.sourcePaymentId, status: j.status, currency: j.currency, postedAt: j.postedAt })),
    entries: (records.ledger_entries || []).filter(e => journalIds.has(e.journalId)).map(e => ({ id: e.id, journalId: e.journalId,
      accountId: e.accountId, side: e.side, amountCents: e.amountCents, currency: e.currency, posted: e.posted })),
    events: (records.processing_events || []).filter(e => refs.includes(e.paymentId)).map(e => ({ id: e.id, paymentId: e.paymentId,
      eventType: e.eventType, status: e.status, description: e.description, errorCode: e.errorCode,
      occurredAt: e.occurredAt, correlationId: e.correlationId })).sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt)) });
}
function assessPayment(payment, snapshot) {
  if (!payment) return { payment_ref: null, execution: 'Unknown', journals: [], valid_journals: [], reason: 'Payment record unavailable.' };
  const linked = snapshot.journals.filter(j => j.paymentId === payment.id || j.sourcePaymentId === payment.id);
  const valid = linked.filter(j => {
    const entries = snapshot.entries.filter(e => e.journalId === j.id);
    const debit = entries.filter(e => e.side === 'Debit'), credit = entries.filter(e => e.side === 'Credit');
    const totals = group => group.reduce((sum, e) => sum + BigInt(e.amountCents), 0n);
    return j.status === 'Posted' && Number.isFinite(Date.parse(j.postedAt)) && j.currency === payment.currency &&
      (!j.sourcePaymentId || j.sourcePaymentId === payment.id) && j.paymentId === payment.id &&
      entries.length >= 2 && entries.every(e => Number.isSafeInteger(e.amountCents) && e.amountCents > 0 && e.posted !== false &&
        ['Debit', 'Credit'].includes(e.side) && e.currency === j.currency && snapshot.accounts.some(a => a.id === e.accountId && a.currency === e.currency)) &&
      debit.length > 0 && credit.length > 0 && Number.isSafeInteger(payment.amountCents) &&
      totals(debit) === BigInt(payment.amountCents) && totals(credit) === BigInt(payment.amountCents) &&
      debit.every(e => e.accountId === payment.senderId) && credit.every(e => e.accountId === payment.receiverId);
  });
  const events = snapshot.events.filter(e => e.paymentId === payment.id);
  const blocked = events.find(e => e.eventType === 'DUPLICATE_BLOCKED');
  const began = events.some(e => ['PROCESSING_STARTED', 'LEDGER_POSTED', 'PROCESSING_COMPLETED'].includes(e.eventType));
  const held = blocked && !began && !linked.length && payment.status?.toUpperCase() === 'PENDING';
  const verified = valid.length > 0 && valid.length === linked.length;
  return { payment_ref: payment.id, execution: verified ? 'Posted' : held ? 'Not Started' : 'Unknown',
    journals: linked.map(j => j.id), valid_journals: valid.map(j => j.id),
    reason: verified ? `${valid.length} journal(s) validated against posted entries, amount, currency and parties.` : held ?
      `Event ${blocked.id} records a hold before execution; no processing-start event or linked journal appears in this snapshot.` :
      'Financial outcome not fully verified. Missing journals alone do not prove non-execution.' };
}
export function analyzeSnapshot(s) {
  const a = s.original, b = s.duplicate;
  const attributesMatch = a && b && a.id !== b.id && a.senderId && a.receiverId && a.senderId !== a.receiverId &&
    ![a.senderId, a.receiverId].includes('Unavailable') && a.senderId === b.senderId && a.receiverId === b.receiverId &&
    Number.isSafeInteger(a.amountCents) && a.amountCents > 0 && a.amountCents === b.amountCents && a.currency && a.currency === b.currency;
  const directLink = a && b && (b.originalPaymentId === a.id || a.paymentId && b.originalPaymentId === a.paymentId);
  const sharedInstruction = a?.businessReference && a.businessReference === b?.businessReference;
  const separate = a?.instructionVerified === true && b?.instructionVerified === true && a.businessReference && b.businessReference &&
    a.businessReference !== b.businessReference && !directLink && !s.linkConflict;
  const same = Boolean(attributesMatch && (directLink || sharedInstruction) && !s.linkConflict && !separate);
  const original = assessPayment(a, s), duplicate = assessPayment(b, s);
  const unique = new Set([...original.valid_journals, ...duplicate.valid_journals]);
  let financial = 'EXECUTION_OUTCOME_UNKNOWN', assessment = 'Financial outcome not fully verified.';
  if (original.execution === 'Posted' && duplicate.execution === 'Not Started' && unique.size === 1) {
    financial = 'SINGLE_POSTING_CONFIRMED'; assessment = 'One confirmed financial posting. The second request is recorded as held before execution in this evidence snapshot.';
  } else if (original.execution === 'Posted' && duplicate.execution === 'Posted' && unique.size === 2 && original.valid_journals.length === 1 && duplicate.valid_journals.length === 1) {
    financial = 'DOUBLE_POSTING_CONFIRMED'; assessment = 'Two distinct financial postings are confirmed. Whether these represent duplicate execution depends on the instruction relationship.';
  } else if (original.execution === 'Not Started' && duplicate.execution === 'Not Started') {
    financial = 'NO_POSTING_CONFIRMED'; assessment = 'Both requests are recorded as held before execution in this snapshot.';
  }
  const timeout = s.events.find(e => e.paymentId === a?.id && e.eventType === 'ACK_TIMEOUT' && e.correlationId);
  const retry = timeout && s.events.find(e => e.paymentId === b?.id && e.eventType === 'RETRY_SUBMITTED' && e.correlationId === timeout.correlationId && Date.parse(e.occurredAt) >= Date.parse(timeout.occurredAt));
  const questions = [];
  if (!a || !b) questions.push('One or both payment records are unavailable. Retrieve both instructions before diagnosing the relationship.');
  if (s.linkConflict) questions.push('The detection reference conflicts with the source original-payment link. Verify the relationship.');
  if (!same && !separate) questions.push('The available instruction links and payment attributes do not establish whether this is the same intended payment.');
  if (!retry && !separate) questions.push('No correlated acknowledgment-timeout and retry events establish why the second request was generated.');
  if (financial === 'EXECUTION_OUTCOME_UNKNOWN') questions.push('Obtain ledger confirmation and processing-stage evidence to verify financial execution.');
  let cause = 'Underlying cause not established from available evidence.', code = 'CAUSE_NOT_ESTABLISHED';
  if (separate) { cause = 'Separate verified business instructions'; code = 'LEGITIMATE_REPEATED_PAYMENT'; }
  else if (same && retry) { cause = 'Client Retry After Acknowledgment Timeout'; code = 'CLIENT_RETRY_ACK_TIMEOUT'; }
  else if (same && financial === 'DOUBLE_POSTING_CONFIRMED') { cause = 'Duplicate financial execution confirmed; triggering cause unknown'; code = 'DUPLICATE_FINANCIAL_EXECUTION'; }
  const classification = separate ? 'LEGITIMATE_SEPARATE_INSTRUCTIONS' : same ? 'CONFIRMED_DUPLICATE_REQUEST' : a && b ? 'SUSPECTED_DUPLICATE' : 'INSUFFICIENT_EVIDENCE';
  let action = 'Escalate for payment verification', actionCode = 'ESCALATE_FOR_PAYMENT_VERIFICATION';
  if (same && financial === 'SINGLE_POSTING_CONFIRMED') { action = 'Close held duplicate, subject to policy verification'; actionCode = 'CLOSE_HELD_DUPLICATE'; }
  if (same && financial === 'DOUBLE_POSTING_CONFIRMED') { action = 'Escalate duplicate financial execution'; actionCode = 'ESCALATE_DUPLICATE_FINANCIAL_EXECUTION'; }
  if (separate && financial === 'DOUBLE_POSTING_CONFIRMED') { action = 'Review false-positive closure'; actionCode = 'REVIEW_FALSE_POSITIVE_CLOSURE'; }
  return { exception_type: 'DUPLICATE_TRANSACTION', original_payment_ref: a?.id || null, suspected_duplicate_ref: b?.id || null,
    diagnosis_classification: classification, root_cause_code: code, root_cause_title: cause,
    root_cause_explanation: separate ? 'Source records identify two separately verified business instructions. Similar payment attributes alone do not establish a duplicate.' :
      same ? `Source instruction links and matching payment attributes establish the same intended payment. ${retry ? `Events ${timeout.id} and ${retry.id} correlate the acknowledgment timeout with the second submission.` : 'The available events do not establish the trigger for the second request.'}` :
      'The detection alert is a starting point. Available source evidence is insufficient to confirm the instruction relationship or underlying cause.',
    evidence_strength: same && retry && financial !== 'EXECUTION_OUTCOME_UNKNOWN' || separate && financial === 'DOUBLE_POSTING_CONFIRMED' ? 'Strong supporting evidence' : same || separate ? 'Partial supporting evidence' : 'Insufficient evidence',
    unresolved_questions: questions, payment_comparison: [a, b],
    financial_execution_assessment: { classification: financial, explanation: assessment, original, duplicate },
    investigation_trace: s.events, supporting_evidence: s,
    recommended_action: action, recommended_action_code: actionCode,
    recommendation_reason: `${assessment} ${same ? 'The source records support the same intended instruction.' : separate ? 'The source records support separate intended instructions.' : 'The instruction relationship needs verification.'}`,
    risk_consideration: 'Recheck current processing and ledger state before any action. This snapshot is not authorization for a financial correction.',
    policy_review_required: true };
}
