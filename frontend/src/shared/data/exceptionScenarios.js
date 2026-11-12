import { accounts, validJournal } from './bankingRecords.js';
import { parseAmount, processPayment } from './paymentSimulation.js';

export const exceptionScenarios = [
  { scenarioCode: 'PROCESSING_FAILURE', code: 'PROCESSOR_UNAVAILABLE', label: 'Processor unavailable', description: 'The payment processor cannot be reached after validation, so no financial posting begins.' },
  { scenarioCode: 'PROCESSING_FAILURE', code: 'CLEARING_REJECTION', label: 'Clearing rejection', description: 'The processor accepts the instruction but the clearing network rejects it before settlement.' },
  { scenarioCode: 'PROCESSING_FAILURE', code: 'ACCOUNT_RESTRICTED_DURING_PROCESSING', label: 'Account restricted during processing', description: 'An account restriction is applied after validation and blocks processing before ledger posting.' },
  { scenarioCode: 'MISSING_LEDGER', code: 'POSTING_EVENT_LOST', label: 'Posting event lost', description: 'Payment processing completes, but publication of the ledger-posting event fails.' },
  { scenarioCode: 'MISSING_LEDGER', code: 'LEDGER_TRANSACTION_ROLLBACK', label: 'Ledger transaction rollback', description: 'Ledger posting starts and then rolls back atomically, leaving no journal.' },
  { scenarioCode: 'MISSING_LEDGER', code: 'LEDGER_CONSUMER_DEAD_LETTER', label: 'Ledger consumer dead-letter', description: 'The ledger consumer repeatedly fails and moves the posting message to its dead-letter queue.' },
  { scenarioCode: 'AMOUNT_MISMATCH', code: 'FEE_INCORRECTLY_NETTED', label: 'Fee incorrectly netted', description: 'A fee is incorrectly deducted from principal, so the balanced journal is one cent below the payment.' },
  { scenarioCode: 'AMOUNT_MISMATCH', code: 'PARTIAL_SETTLEMENT', label: 'Partial settlement', description: 'Only half of the instructed amount reaches the balanced ledger journal.' },
  { scenarioCode: 'AMOUNT_MISMATCH', code: 'DECIMAL_SCALING_ERROR', label: 'Decimal scaling error', description: 'A decimal conversion scales the posted amount down by a factor of one hundred.' },
  { scenarioCode: 'UNMATCHED', code: 'REFERENCE_TYPO', label: 'Reference typo', description: 'A mistyped payment reference prevents the posted journal from matching its payment.' },
  { scenarioCode: 'UNMATCHED', code: 'BATCH_CORRELATION_SHIFT', label: 'Batch correlation shift', description: 'A batch offset associates the journal with the wrong payment reference.' },
  { scenarioCode: 'UNMATCHED', code: 'MANUAL_JOURNAL_MISLINK', label: 'Manual journal mislink', description: 'An operator-created journal is linked to an unrelated payment reference.' },
];

export const variantsFor = scenarioCode => exceptionScenarios.filter(item => item.scenarioCode === scenarioCode);

function fingerprint(value) {
  let hash = 14695981039346656037n;
  for (const character of value) hash = BigInt.asUintN(64, (hash ^ BigInt(character.codePointAt(0))) * 1099511628211n);
  return hash.toString(16);
}

function roundHalfEven(value, divisor) {
  const quotient = Math.floor(value / divisor), remainder = value % divisor;
  return quotient + Number(remainder * 2 > divisor || remainder * 2 === divisor && quotient % 2 === 1);
}

function localResult(state, run) {
  const payments = run.paymentReferences.map(id => state.payment_transactions.find(payment => payment.id === id));
  const journals = state.ledger_journals.filter(journal =>
    payments.some(payment => journal.paymentId === payment.id || journal.sourcePaymentId === payment.id) && validJournal(state, journal));
  return { ...payments[0], runId: run.runId, payments, paymentReferences: run.paymentReferences,
    requestIds: payments.flatMap(payment => payment.requests.map(request => request.requestId)),
    instructionReferences: payments.map(payment => payment.paymentId || payment.id),
    journalReferences: journals.map(journal => journal.id), attemptCount: payments.length,
    postingCount: journals.length, timestamp: run.timestamp };
}

export function processExceptionRun(state, input, { role = 'ANALYST', now = new Date().toISOString() } = {}) {
  if (role !== 'ADMIN') throw new Error('Only ADMIN may run synthetic scenarios.');
  const variant = exceptionScenarios.find(item => item.code === input.scenarioVariant);
  if (!variant || variant.scenarioCode !== input.scenario) throw new Error('Choose a supported scenario variant for this exception type.');
  const runKey = input.runKey || input.idempotencyKey;
  if (!runKey) throw new Error('A scenario run key is required.');
  const amountCents = parseAmount(input.amount);
  const signature = fingerprint(JSON.stringify([input.senderId, input.receiverId, amountCents, input.scenario, input.scenarioVariant]));
  const prior = state.exception_runs?.[runKey];
  if (prior) {
    if (prior.signature !== signature) throw new Error('Run key already used with different inputs.');
    return { state, payment: localResult(state, prior) };
  }

  const processed = processPayment(state, { ...input, scenario: input.scenario, idempotencyKey: `scenario:${runKey}` }, { role, now });
  let next = processed.state;
  let payment = processed.payment;
  const request = { requestId: crypto.randomUUID(), instructionReference: payment.paymentId || payment.id,
    origin: 'CUSTOMER', retryOfRequestId: null, authorizationId: crypto.randomUUID(),
    correlationId: crypto.randomUUID(), receivedAt: now };
  payment = { ...payment, requests: [request] };

  const descriptions = {
    PROCESSOR_UNAVAILABLE: 'Processor connection failed before a financial posting began.',
    CLEARING_REJECTION: 'Clearing rejected the submitted payment before settlement.',
    ACCOUNT_RESTRICTED_DURING_PROCESSING: 'Account status changed to restricted during processing.',
    POSTING_EVENT_LOST: 'Ledger event publication failed after payment completion.',
    LEDGER_TRANSACTION_ROLLBACK: 'The ledger transaction rolled back before commit.',
    LEDGER_CONSUMER_DEAD_LETTER: 'The ledger message exhausted retries and entered the dead-letter queue.',
    FEE_INCORRECTLY_NETTED: 'A fee was incorrectly netted from the payment principal.',
    PARTIAL_SETTLEMENT: 'Only part of the instructed amount was settled.',
    DECIMAL_SCALING_ERROR: 'The instructed amount was transformed using the wrong decimal scale.',
    REFERENCE_TYPO: 'The journal contains a mistyped payment reference.',
    BATCH_CORRELATION_SHIFT: 'A batch correlation offset linked the journal to the wrong reference.',
    MANUAL_JOURNAL_MISLINK: 'A manual journal was linked to an unrelated payment reference.',
  };
  const eventTypes = {
    PROCESSOR_UNAVAILABLE: 'PROCESSOR_CONNECTION_FAILED', CLEARING_REJECTION: 'CLEARING_REJECTED',
    ACCOUNT_RESTRICTED_DURING_PROCESSING: 'ACCOUNT_STATUS_CHANGED', POSTING_EVENT_LOST: 'LEDGER_EVENT_PUBLICATION_FAILED',
    LEDGER_TRANSACTION_ROLLBACK: 'LEDGER_TRANSACTION_ROLLED_BACK', LEDGER_CONSUMER_DEAD_LETTER: 'LEDGER_MESSAGE_DEAD_LETTERED',
    FEE_INCORRECTLY_NETTED: 'FEE_APPLIED_TO_PRINCIPAL', PARTIAL_SETTLEMENT: 'PARTIAL_SETTLEMENT_APPLIED',
    DECIMAL_SCALING_ERROR: 'AMOUNT_SCALE_TRANSFORMED', REFERENCE_TYPO: 'REFERENCE_MAPPING_APPLIED',
    BATCH_CORRELATION_SHIFT: 'SETTLEMENT_BATCH_CORRELATED', MANUAL_JOURNAL_MISLINK: 'MANUAL_JOURNAL_SUBMITTED',
  };

  if (input.scenario === 'PROCESSING_FAILURE') {
    payment = { ...payment, failureCode: input.scenarioVariant, failureDescription: descriptions[input.scenarioVariant] };
  }
  if (input.scenario === 'AMOUNT_MISMATCH') {
    const postedCents = input.scenarioVariant === 'FEE_INCORRECTLY_NETTED' ? amountCents - 1
      : input.scenarioVariant === 'PARTIAL_SETTLEMENT' ? roundHalfEven(amountCents, 2)
        : Math.max(1, roundHalfEven(amountCents, 100));
    const journal = next.ledger_journals.find(item => item.paymentId === payment.id);
    next = { ...next, ledger_entries: next.ledger_entries.map(entry => entry.journalId === journal?.id ? { ...entry, amountCents: postedCents } : entry) };
  }
  if (input.scenario === 'UNMATCHED') {
    const prefix = { REFERENCE_TYPO: 'TYPO', BATCH_CORRELATION_SHIFT: 'BATCH-SHIFT', MANUAL_JOURNAL_MISLINK: 'MANUAL-LINK' }[input.scenarioVariant];
    next = { ...next, ledger_journals: next.ledger_journals.map(journal => journal.sourcePaymentId === payment.id
      ? { ...journal, paymentId: `${prefix}-${payment.id}` } : journal) };
  }

  next = { ...next,
    payment_transactions: next.payment_transactions.map(item => item.id === payment.id ? payment : item),
    processing_events: [...(next.processing_events || []).map(item => item.paymentId === payment.id ? { ...item, requestId: request.requestId } : item), {
      id: crypto.randomUUID(), paymentId: payment.id, requestId: request.requestId,
      eventType: eventTypes[input.scenarioVariant], status: payment.status.toUpperCase(),
      description: descriptions[input.scenarioVariant], occurredAt: new Date(Date.parse(now) + 1000).toISOString(), errorCode: payment.failureCode || null,
    }],
  };
  const timestamp = new Date(Date.parse(now) + 2000).toISOString();
  const run = { signature, runId: crypto.randomUUID(), paymentReferences: [payment.id], timestamp };
  next = { ...next, simulationNow: timestamp, exception_runs: { ...next.exception_runs, [runKey]: run } };
  return { state: next, payment: localResult(next, run) };
}
