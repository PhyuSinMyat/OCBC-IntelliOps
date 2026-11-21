import { accounts, addTransfer, balanceFor, validJournal } from './bankingRecords.js';
import { parseAmount, nextReference } from './paymentSimulation.js';

export const duplicateScenarios = [
  { code: 'CUSTOMER_DOUBLE_CLICK', label: 'Scenario A — Customer Double-Click', description: 'Two customer requests, one Completed payment, one Held payment, and one posted journal.' },
  { code: 'AUTOMATIC_RETRY_FAILURE', label: 'Scenario B — Automatic Retry Failure', description: 'One customer request and one system retry, two Completed payments, and two posted journals.' },
  { code: 'LEGITIMATE_REPEATED_PAYMENTS', label: 'Scenario C — Legitimate Repeated Payments', description: 'Two independently authorized instructions, two Completed payments, and two posted journals.' },
];

// An opaque input fingerprint, not an operational diagnosis or exported scenario label.
function fingerprint(value) {
  let hash = 14695981039346656037n;
  for (const character of value) hash = BigInt.asUintN(64, (hash ^ BigInt(character.codePointAt(0))) * 1099511628211n);
  return hash.toString(16);
}

export function processDuplicateRun(state, input, { role = 'ANALYST', now = new Date().toISOString() } = {}) {
  if (role !== 'ANALYST') throw new Error('Only ANALYST may run synthetic scenarios.');
  if (!duplicateScenarios.some(s => s.code === input.duplicateScenario)) throw new Error('Choose a supported duplicate scenario.');
  const runKey = input.runKey || input.idempotencyKey;
  if (!runKey) throw new Error('A scenario run key is required.');
  const amountCents = parseAmount(input.amount);
  const signature = fingerprint(JSON.stringify([input.senderId, input.receiverId, amountCents, input.duplicateScenario]));
  const prior = state.duplicate_runs?.[runKey];
  if (prior) {
    if (prior.signature !== signature) throw new Error('Run key already used with different inputs.');
    return { state, payment: localResult(state, prior) };
  }
  const sender = accounts.find(a => a.id === input.senderId), receiver = accounts.find(a => a.id === input.receiverId);
  if (!sender || !receiver || sender.id === receiver.id || sender.status !== 'Active' || receiver.status !== 'Active' || sender.currency !== receiver.currency) throw new Error('Choose different Active accounts in the same currency.');
  const [a, b] = duplicateScenarios;
  const prevented = input.duplicateScenario === a.code, retry = input.duplicateScenario === b.code;
  if (balanceFor(state, sender).current < amountCents * (prevented ? 1 : 2)) throw new Error('Insufficient funds for all scenario postings.');
  if (!Number.isFinite(Date.parse(now))) throw new Error('Invalid simulation timestamp.');
  let next = state;
  const runId = crypto.randomUUID(), correlationId = crypto.randomUUID(), payments = [], receipts = [];
  const time = seconds => new Date(Date.parse(now) + seconds * 1000).toISOString();
  const events = [];
  const emit = (payment, receipt, eventType, seconds, facts = {}) => events.push({
    id: crypto.randomUUID(), paymentId: payment.id, requestId: receipt.requestId, eventType,
    status: eventType === 'PAYMENT_AUTHORIZED' ? 'COMPLETED' : payment.status.toUpperCase(), occurredAt: time(seconds),
    description: JSON.stringify({ source_component: 'browser_simulator', request_id: receipt.requestId,
      intent_id: receipt.instructionReference, origin: receipt.origin, ...facts }),
  });
  for (let index = 0; index < 2; index++) {
    let payment;
    if (index && prevented) {
      // The actual lookup must find a completed execution before recording a hold.
      const match = next.payment_transactions.find(p => p.paymentId === payments[0].paymentId && p.status === 'Completed');
      if (!match) throw new Error('Original instruction execution was not found.');
      payment = { id: nextReference(next), paymentId: crypto.randomUUID(), senderId: sender.id, receiverId: receiver.id,
        amountCents, currency: sender.currency, status: 'Held', createdAt: time(5), completedAt: null,
        originalPaymentId: payments[0].paymentId, businessReference: payments[0].businessReference };
      next = { ...next, payment_transactions: [...next.payment_transactions, payment] };
    } else {
      if (index && retry) {
        const authoritative = next.payment_transactions.find(p => p.paymentId === payments[0].paymentId);
        const lostAssociationLookup = () => null;
        if (!authoritative || lostAssociationLookup(payments[0].paymentId) !== null) throw new Error('Synthetic replay lookup did not return a false miss.');
      }
      next = addTransfer(next, { senderId: sender.id, receiverId: receiver.id, amountCents, postedAt: time(index * 5 + 1) });
      const posted = next.payment_transactions.at(-1);
      payment = { ...posted, paymentId: crypto.randomUUID(), journalReference: next.ledger_journals.at(-1).id,
        businessReference: index && retry ? payments[0].businessReference : crypto.randomUUID(),
        originalPaymentId: index && retry ? payments[0].paymentId : null };
    }
    const receipt = { requestId: crypto.randomUUID(), instructionReference: index && (retry || prevented) ? receipts[0].instructionReference : payment.paymentId,
      origin: index && retry ? 'SYSTEM' : 'CUSTOMER', retryOfRequestId: index && retry ? receipts[0].requestId : null,
      authorizationId: !retry && !prevented ? crypto.randomUUID() : null, correlationId, receivedAt: time(index * 5) };
    payment.requests = [receipt];
    payments.push(payment); receipts.push(receipt);
    next = { ...next, payment_transactions: next.payment_transactions.map(p => p.id === payment.id ? payment : p),
      processing_events: (next.processing_events || []).map(e => e.paymentId === payment.id ? { ...e, requestId: receipt.requestId } : e) };
    if (receipt.authorizationId) emit(payment, receipt, 'PAYMENT_AUTHORIZED', index * 5, {
      authorization_id: receipt.authorizationId, authorized: true, sender_account_ref: sender.id, receiver_account_ref: receiver.id,
      amount: (amountCents / 100).toFixed(2), currency: sender.currency });
    if (receipt.origin === 'CUSTOMER') emit(payment, receipt, 'CLIENT_SUBMISSION', index * 5, { trigger: 'USER_SUBMIT', submission_id: receipt.requestId });
    else {
      emit(payment, receipt, 'RETRY_SUBMITTED', 5, { trigger: 'AUTOMATIC_RETRY', correlation_id: correlationId, original_payment_ref: payments[0].id });
      emit(payment, receipt, 'IDEMPOTENCY_CHECK_FAILED', 5.2, { lookup_result: 'MISS', authoritative_execution_present: true, correlation_id: correlationId, original_payment_ref: payments[0].id });
    }
    emit(payment, receipt, 'PAYMENT_REQUEST_RECEIVED', index * 5 + .1);
    if (payment.journalReference) emit(payment, receipt, 'LEDGER_POSTING_CONFIRMED', index * 5 + 2, { journal_reference: payment.journalReference });
    if (!index && prevented) emit(payment, receipt, 'CLIENT_CONFIRMATION_DELAYED', 3);
    if (!index && retry) {
      emit(payment, receipt, 'ACK_TIMEOUT', 3, { origin: 'SYSTEM', correlation_id: correlationId });
      emit(payment, receipt, 'RETRY_SCHEDULED', 4, { origin: 'SYSTEM', correlation_id: correlationId });
    }
    if (index && prevented) {
      emit(payment, receipt, 'DUPLICATE_CONTROL_MATCH', 6, { matched_payment_ref: payments[0].id });
      emit(payment, receipt, 'DUPLICATE_BLOCKED', 7, { posting_started: false });
    }
  }
  const ids = payments.map(p => p.id);
  next = { ...next, payment_transactions: next.payment_transactions.map(p => ids.includes(p.id) ? { ...p, relatedPaymentReferences: ids.filter(id => id !== p.id) } : p),
    processing_events: [...(next.processing_events || []), ...events].sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt)),
    simulationNow: time(8), duplicate_runs: { ...next.duplicate_runs, [runKey]: { signature, runId, paymentReferences: ids, timestamp: time(8) } } };
  return { state: next, payment: localResult(next, next.duplicate_runs[runKey]) };
}

function localResult(state, run) {
  const payments = run.paymentReferences.map(id => state.payment_transactions.find(p => p.id === id));
  const journals = state.ledger_journals.filter(j => run.paymentReferences.includes(j.paymentId) && validJournal(state, j));
  return { ...payments[0], runId: run.runId, payments, paymentReferences: run.paymentReferences,
    requestIds: payments.flatMap(p => p.requests.map(r => r.requestId)),
    instructionReferences: [...new Set(payments.flatMap(p => p.requests.map(r => r.instructionReference)))],
    journalReferences: journals.map(j => j.id), attemptCount: payments.length, postingCount: journals.length, timestamp: run.timestamp };
}
