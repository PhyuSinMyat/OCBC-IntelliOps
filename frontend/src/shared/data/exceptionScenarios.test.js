import test from 'node:test';
import assert from 'node:assert/strict';

import { accounts, balanceFor, initialRecords } from './bankingRecords.js';
import { exceptionScenarios, processExceptionRun } from './exceptionScenarios.js';
import { detectPayments } from './paymentSimulation.js';

const exceptionNames = {
  PROCESSING_FAILURE: 'Payment Processing Failure',
  MISSING_LEDGER: 'Missing Ledger Posting',
  AMOUNT_MISMATCH: 'Amount Mismatch',
  UNMATCHED: 'Unmatched Transaction',
};

const expectedEvents = {
  PROCESSOR_UNAVAILABLE: 'PROCESSOR_CONNECTION_FAILED', CLEARING_REJECTION: 'CLEARING_REJECTED',
  ACCOUNT_RESTRICTED_DURING_PROCESSING: 'ACCOUNT_STATUS_CHANGED', POSTING_EVENT_LOST: 'LEDGER_EVENT_PUBLICATION_FAILED',
  LEDGER_TRANSACTION_ROLLBACK: 'LEDGER_TRANSACTION_ROLLED_BACK', LEDGER_CONSUMER_DEAD_LETTER: 'LEDGER_MESSAGE_DEAD_LETTERED',
  FEE_INCORRECTLY_NETTED: 'FEE_APPLIED_TO_PRINCIPAL', PARTIAL_SETTLEMENT: 'PARTIAL_SETTLEMENT_APPLIED',
  DECIMAL_SCALING_ERROR: 'AMOUNT_SCALE_TRANSFORMED', REFERENCE_TYPO: 'REFERENCE_MAPPING_APPLIED',
  BATCH_CORRELATION_SHIFT: 'SETTLEMENT_BATCH_CORRELATED', MANUAL_JOURNAL_MISLINK: 'MANUAL_JOURNAL_SUBMITTED',
};

for (const [index, variant] of exceptionScenarios.entries()) {
  test(`${variant.code}: evidence, accounting, replay and independent detection`, () => {
    const before = initialRecords();
    const sender = accounts.find(account => account.id === 'ACC-100003');
    const receiver = accounts.find(account => account.id === 'ACC-100001');
    const input = { senderId: sender.id, receiverId: receiver.id, amount: '123.45', scenario: variant.scenarioCode,
      scenarioVariant: variant.code, runKey: `variant-run-${index}` };
    const options = { role: 'ANALYST', now: '2026-11-03T03:00:00Z' };
    const { state, payment: result } = processExceptionRun(before, input, options);
    const postings = ['AMOUNT_MISMATCH', 'UNMATCHED'].includes(variant.scenarioCode) ? 1 : 0;
    assert.equal(result.attemptCount, 1);
    assert.equal(result.postingCount, postings);
    assert.equal(result.payments[0].status, variant.scenarioCode === 'PROCESSING_FAILURE' ? 'Failed' : 'Completed');
    assert.ok(state.processing_events.some(event => event.paymentId === result.id && event.eventType === expectedEvents[variant.code] && event.requestId));
    assert.equal(processExceptionRun(state, input, options).state, state);
    assert.throws(() => processExceptionRun(state, { ...input, amount: '123.46' }, options), /different inputs/);

    const postedCents = variant.scenarioCode === 'UNMATCHED' ? 12345
      : variant.code === 'FEE_INCORRECTLY_NETTED' ? 12344
        : variant.code === 'PARTIAL_SETTLEMENT' ? 6172
          : variant.code === 'DECIMAL_SCALING_ERROR' ? 123 : 0;
    assert.equal(balanceFor(state, sender).current, balanceFor(before, sender).current - postedCents);
    assert.equal(balanceFor(state, receiver).current, balanceFor(before, receiver).current + postedCents);

    const detected = detectPayments(state, { role: 'ANALYST', now: '2026-11-03T03:01:01Z' });
    const cases = detected.exception_cases.filter(item => item.transactionId === result.id);
    assert.equal(cases.length, 1);
    assert.equal(cases[0].exceptionType, exceptionNames[variant.scenarioCode]);
    assert.equal(detectPayments(detected, { role: 'ANALYST', now: '2026-11-03T03:01:02Z' }).exception_cases.length, detected.exception_cases.length);
    assert.deepEqual(before, initialRecords());
  });
}

test('variant validation is ANALYST-only and atomic', () => {
  const state = initialRecords();
  const input = { senderId: 'ACC-100003', receiverId: 'ACC-100001', amount: '10.00', scenario: 'MISSING_LEDGER',
    scenarioVariant: 'POSTING_EVENT_LOST', runKey: 'validation-run' };
  assert.throws(() => processExceptionRun(state, input, { role: 'ADMIN' }), /ANALYST/);
  assert.throws(() => processExceptionRun(state, { ...input, scenario: 'AMOUNT_MISMATCH' }, { role: 'ANALYST' }), /supported scenario variant/);
  assert.deepEqual(state, initialRecords());
});
