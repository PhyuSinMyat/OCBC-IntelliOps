import { accounts, addTransfer, balanceFor, validJournal } from './bankingRecords.js';
import { assessSimulationSeverity } from './simulationSeverity.js';

export const scenarios = { NORMAL: 'Normal Payment', DUPLICATE: 'Duplicate Transaction', PROCESSING_FAILURE: 'Payment Processing Failure', MISSING_LEDGER: 'Missing Ledger Posting', AMOUNT_MISMATCH: 'Amount Mismatch', UNMATCHED: 'Unmatched Transaction' };
export const processingStatuses = ['Pending', 'Processing', 'Completed', 'Failed', 'Rejected', 'Held'];
export function parseAmount(value) {
  if (!/^\d+(\.\d{1,2})?$/.test(String(value))) throw new Error('Amount must be positive with at most two decimal places.');
  const [whole, fraction = ''] = String(value).split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (cents <= 0n || cents > 999999999999999n) throw new Error('Enter a positive amount within the simulator limit.');
  return Number(cents);
}
export function nextReference(state) {
  let number = 1001 + state.payment_transactions.length;
  while (state.payment_transactions.some(p => p.id === `TXN-${number}`) || state.ledger_journals.some(j => j.id === `JRN-${number}`)) number++;
  return `TXN-${number}`;
}
export function processPayment(state, input, { role = 'ANALYST', now = new Date().toISOString() } = {}) {
  const scenario = input.scenario || 'NORMAL';
  if (!Object.hasOwn(scenarios, scenario)) throw new Error('Unsupported simulation scenario.');
  if (scenario !== 'NORMAL' && role !== 'ANALYST') throw new Error('Only the ANALYST demo role may inject scenarios.');
  if (!input.idempotencyKey) throw new Error('An idempotency key is required.');
  const amountCents = parseAmount(input.amount);
  const signature = JSON.stringify([input.senderId, input.receiverId, amountCents, scenario]);
  const prior = state.payment_requests?.[input.idempotencyKey];
  if (prior) {
    if (prior.signature !== signature) throw new Error('Idempotency key already used with different payment details.');
    return { state, payment: state.payment_transactions.find(p => p.id === prior.id) };
  }
  const sender = accounts.find(a => a.id === input.senderId), receiver = accounts.find(a => a.id === input.receiverId);
  if (!sender || !receiver || sender.id === receiver.id) throw new Error('Choose two different existing accounts.');
  if (sender.status !== 'Active' || receiver.status !== 'Active') throw new Error('Both accounts must be Active.');
  if (sender.currency !== receiver.currency) throw new Error('Both accounts must use the same currency.');
  if (balanceFor(state, sender).current < amountCents) throw new Error('Sender has insufficient available funds.');
  if (scenario === 'AMOUNT_MISMATCH' && amountCents < 2) throw new Error('Amount Mismatch requires at least 0.02.');
  if (!Number.isFinite(Date.parse(now))) throw new Error('Simulation time is invalid.');
  let next = state;
  let payment;
  if (['NORMAL', 'DUPLICATE', 'AMOUNT_MISMATCH', 'UNMATCHED'].includes(scenario)) {
    next = addTransfer(state, { senderId: sender.id, receiverId: receiver.id, amountCents: scenario === 'AMOUNT_MISMATCH' ? amountCents - 1 : amountCents, postedAt: now });
    const posted = next.payment_transactions.at(-1);
    payment = { ...posted, amountCents, scenarioCode: scenario, businessReference: posted.id, reconciliationDueAt: new Date(Date.parse(now) + 60000).toISOString() };
    next = { ...next, payment_transactions: next.payment_transactions.map(p => p.id === posted.id ? payment : p) };
    if (scenario === 'UNMATCHED') next = { ...next, ledger_journals: next.ledger_journals.map(j => j.paymentId === payment.id ? { ...j, sourcePaymentId: payment.id, paymentId: `UNMATCHED-${payment.id}` } : j) };
    if (scenario === 'DUPLICATE') {
      const original = payment;
      payment = { ...original, id: nextReference(next), status: 'Pending', completedAt: null, originalPaymentId: original.id, scenarioCode: 'DUPLICATE' };
      next = { ...next, payment_transactions: [...next.payment_transactions, payment], processing_events: [...(next.processing_events || []),
        { id: `${payment.id}-created`, paymentId: payment.id, eventType: 'PAYMENT_CREATED', status: 'PENDING', description: 'Duplicate instruction received.', occurredAt: now },
        { id: `${payment.id}-blocked`, paymentId: payment.id, eventType: 'DUPLICATE_BLOCKED', status: 'PENDING', description: 'Duplicate business reference held without a second financial posting.', errorCode: 'DUPLICATE_REFERENCE', occurredAt: now }] };
    }
  } else {
    const failed = scenario === 'PROCESSING_FAILURE';
    payment = { id: nextReference(state), senderId: sender.id, receiverId: receiver.id, amountCents, currency: sender.currency,
      status: failed ? 'Failed' : 'Completed', createdAt: now, completedAt: failed ? null : now, scenarioCode: scenario,
      failureCode: failed ? 'SIM_PROCESSING_ERROR' : null, failureDescription: failed ? 'Controlled processor failure. No ledger posting was made.' : null,
      reconciliationDueAt: new Date(Date.parse(now) + 60000).toISOString() };
    const stages = ['PAYMENT_CREATED', 'VALIDATION_STARTED', 'VALIDATION_PASSED', 'PROCESSING_STARTED', failed ? 'PROCESSING_FAILED' : 'PROCESSING_COMPLETED'];
    next = { ...state, payment_transactions: [...state.payment_transactions, payment], processing_events: [...(state.processing_events || []), ...stages.map((kind, index) => ({
      id: `${payment.id}-${index}`, paymentId: payment.id, eventType: kind, status: index === 0 ? 'PENDING' : index === 4 ? (failed ? 'FAILED' : 'COMPLETED') : 'PROCESSING',
      description: index === 4 ? (payment.failureDescription || 'Payment source reports completion; no ledger posting recorded.') : kind.replaceAll('_', ' ').toLowerCase(),
      errorCode: index === 4 ? payment.failureCode : null, occurredAt: now }))] };
  }
  next = { ...next, simulationNow: now, payment_requests: { ...next.payment_requests, [input.idempotencyKey]: { signature, id: payment.id } },
    audit_events: [...(next.audit_events || []), { id: `AUD-${(next.audit_events || []).length + 1}`, action: scenario === 'NORMAL' ? 'PAYMENT_CREATED' : 'SCENARIO_INJECTED', actor: role, reference: payment.id, createdAt: now, details: { scenario } }] };
  return { state: next, payment };
}

export function detectPayments(state, { now = new Date().toISOString(), role = 'ANALYST' } = {}) {
  const cases = [...(state.exception_cases || [])];
  const firstReferences = new Map();
  for (const p of state.payment_transactions) {
    const linked = state.ledger_journals.filter(j => j.paymentId === p.id || j.sourcePaymentId === p.id);
    const business = p.businessReference || p.id;
    const original = firstReferences.get(business);
    if (!original) firstReferences.set(business, p.id);
    const findings = [];
    // Duplicate pairs are evaluated separately below; do not collapse pairs by payment.
    if (p.status === 'Failed') {
      const events = (state.processing_events || []).filter(event => event.paymentId === p.id);
      const financialMovementObserved = state.ledger_entries.some(entry => linked.some(j => j.id === entry.journalId) && entry.posted !== false);
      const uncertain = [p.failureCode, ...events.flatMap(event => [event.eventType, event.errorCode])]
        .some(code => /TIMEOUT|TIMED_OUT|UNKNOWN/i.test(code || ''));
      const terminalFailure = events.some(event => ['PROCESSING_FAILED', 'CLEARING_REJECTED'].includes(event.eventType));
      const executionRecorded = events.some(event => ['LEDGER_POSTED', 'PROCESSING_COMPLETED'].includes(event.eventType));
      findings.push(['Payment Processing Failure', { failureCode: p.failureCode || null, financialMovementObserved,
        failureContained: terminalFailure && !linked.length && !executionRecorded && !uncertain }]);
    }
    const cutoff = p.reconciliationDueAt || new Date(Date.parse(p.createdAt) + 60000).toISOString();
    if (p.status === 'Completed' && Date.parse(now) >= Date.parse(cutoff)) {
      if (!linked.length) findings.push(['Missing Ledger Posting', { cutoff, journalReferences: [] }]);
      for (const j of linked) {
        if (j.paymentId !== p.id) {
          const entries = state.ledger_entries.filter(entry => entry.journalId === j.id);
          const attributed = linked.length === 1 && j.sourcePaymentId === p.id && j.currency === p.currency &&
            validJournal(state, j) && entries.every(entry => entry.accountId === (entry.side === 'Debit' ? p.senderId : p.receiverId));
          const debit = entries.filter(entry => entry.side === 'Debit').reduce((sum, entry) => sum + entry.amountCents, 0);
          findings.push(['Unmatched Transaction', { journalReference: j.id, actualReference: j.paymentId, expectedReference: p.id, cutoff,
            financialDiscrepancy: attributed && debit !== p.amountCents }]);
        }
        else if (validJournal(state, j)) {
          const debit = state.ledger_entries.filter(e => e.journalId === j.id && e.side === 'Debit').reduce((sum, e) => sum + e.amountCents, 0);
          if (debit !== p.amountCents) findings.push(['Amount Mismatch', { journalReference: j.id, expectedCents: p.amountCents, postedCents: debit }]);
        }
      }
    }
    for (const [exceptionType, evidence] of findings) {
      if (cases.some(c => c.transactionId === p.id && c.exceptionType === exceptionType && !['RESOLVED', 'CLOSED'].includes(c.status))) continue;
      let number = cases.length + 1;
      while (cases.some(c => c.id === `CASE-${String(number).padStart(6, '0')}`)) number++;
      const severityAssessment = assessSimulationSeverity(exceptionType, evidence);
      cases.push({ id: `CASE-${String(number).padStart(6, '0')}`, transactionId: p.id, exceptionType, severity: severityAssessment.severity,
        status: 'OPEN', createdAt: now, evidence: { transactionReference: p.id, observedAt: now, ...evidence, severityAssessment } });
    }
  }
  const ordered = [...state.payment_transactions].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id));
  for (let i = 0; i < ordered.length; i++) for (let j = i + 1; j < ordered.length; j++) {
    const a = ordered[i], b = ordered[j];
    const matching = a.senderId === b.senderId && a.receiverId === b.receiverId && a.amountCents === b.amountCents && a.currency === b.currency;
    const direct = b.originalPaymentId && b.originalPaymentId === (a.paymentId || a.id);
    const shared = a.businessReference && a.businessReference === b.businessReference;
    const elapsed = Math.abs(Date.parse(a.createdAt) - Date.parse(b.createdAt)) / 1000;
    const window = state.duplicateSimilarityWindowSeconds ?? 120;
    if (!(direct || shared || matching && a.status === 'Completed' && b.status === 'Completed' && elapsed <= window)) continue;
    const pairKey = ['DUPLICATE_TRANSACTION', ...[a.id, b.id].sort()].join(':');
    const prior = cases.filter(c => c.exceptionType === 'Duplicate Transaction' && (c.detectionKey === pairKey || c.transactionId === b.id && c.evidence?.originalReference === a.id));
    // Local cases have no resolution UI; preserve terminal history as well as active cases.
    if (prior.length) continue;
    const linked = p => state.ledger_journals.filter(j => j.paymentId === p.id || j.sourcePaymentId === p.id);
    const journals = p => linked(p).filter(j => validJournal(state, j) && state.ledger_entries.filter(e => e.journalId === j.id)
      .every(e => e.amountCents === p.amountCents && e.accountId === (e.side === 'Debit' ? p.senderId : p.receiverId)));
    const aj = journals(a), bj = journals(b);
    const consistent = aj.length === linked(a).length && bj.length === linked(b).length;
    const events = (state.processing_events || []).filter(event => event.paymentId === b.id);
    const blocked = events.some(event => event.eventType === 'DUPLICATE_BLOCKED') &&
      !events.some(event => ['PROCESSING_STARTED', 'LEDGER_POSTED', 'PROCESSING_COMPLETED'].includes(event.eventType));
    const financial = consistent && aj.length === 1 && bj.length === 1 && aj[0].id !== bj[0].id ? 'TWO_POSTINGS_CONFIRMED'
      : consistent && aj.length === 1 && !bj.length && ['Held', 'Pending'].includes(b.status) && blocked
        ? 'SINGLE_POSTING_CONFIRMED_DUPLICATE_HELD' : 'EXECUTION_OUTCOME_UNKNOWN';
    const severityAssessment = assessSimulationSeverity('Duplicate Transaction', { financialAssessment: financial });
    let number = cases.length + 1;
    while (cases.some(c => c.id === `CASE-${String(number).padStart(6, '0')}`)) number++;
    cases.push({ id: `CASE-${String(number).padStart(6, '0')}`, transactionId: b.id, relatedTransactionId: a.id,
      exceptionType: 'Duplicate Transaction', detectionKey: pairKey, severity: severityAssessment.severity, status: 'OPEN', createdAt: now,
      evidence: { transactionReference: b.id, originalReference: a.id, observedAt: now, classification: 'SUSPECTED_DUPLICATE',
        rootCause: 'NOT_ESTABLISHED', attributesMatch: matching, timeDifferenceSeconds: elapsed, originalInstructionLinked: Boolean(direct),
        financialAssessment: financial, originalJournalReferences: aj.map(j => j.id), duplicateJournalReferences: bj.map(j => j.id), severityAssessment } });
  }
  const added = cases.slice((state.exception_cases || []).length);
  return { ...state, exception_cases: cases, simulationNow: now,
    audit_events: [...(state.audit_events || []), ...added.map(c => ({ id: `AUD-${c.id}`, action: 'EXCEPTION_DETECTED', actor: role, reference: c.id, details: c.evidence, createdAt: now })),
      { id: `AUD-RUN-${(state.audit_events || []).length}`, action: 'DETECTION_RUN', actor: role, reference: 'DETECTION', details: { createdCases: added.map(c => c.id) }, createdAt: now }] };
}

export const paymentFilters = { search: '', status: '', currency: '', range: '', from: '', to: '', sort: 'newest' };
const dayInSingapore = date => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(date));
export function filterPayments(records, accountList, filters, now) {
  const today = dayInSingapore(now);
  let start = filters.from, end = filters.to;
  if (filters.range && filters.range !== 'custom') {
    const days = filters.range === 'today' ? 0 : filters.range === '7days' ? 6 : 29;
    start = dayInSingapore(Date.parse(`${today}T00:00:00+08:00`) - days * 86400000);
    end = today;
  }
  return records.filter(p => {
    const sender = accountList.find(a => a.id === p.senderId), receiver = accountList.find(a => a.id === p.receiverId);
    const date = Number.isFinite(Date.parse(p.createdAt)) ? dayInSingapore(p.createdAt) : '';
    return `${p.id} ${p.senderId || ''} ${p.receiverId || ''} ${sender?.customer || ''} ${receiver?.customer || ''}`.toLowerCase().includes(filters.search.trim().toLowerCase()) &&
      (!filters.status || p.status === filters.status) && (!filters.currency || p.currency === filters.currency) &&
      (!filters.range || ((!start || date >= start) && (!end || date <= end)));
  }).sort((a, b) => {
    const order = filters.sort === 'reference' ? a.id.localeCompare(b.id) : filters.sort === 'status' ? a.status.localeCompare(b.status) : filters.sort === 'amount-high' ? b.amountCents - a.amountCents : filters.sort === 'amount-low' ? a.amountCents - b.amountCents : filters.sort === 'oldest' ? Date.parse(a.createdAt) - Date.parse(b.createdAt) : Date.parse(b.createdAt) - Date.parse(a.createdAt);
    return order || a.id.localeCompare(b.id);
  });
}
