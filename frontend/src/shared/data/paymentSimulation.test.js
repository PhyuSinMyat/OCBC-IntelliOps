import test from 'node:test';
import assert from 'node:assert/strict';
import { accounts, initialRecords, balanceFor, validJournal, restoreRecords } from './bankingRecords.js';
import { processPayment, detectPayments, parseAmount, filterPayments, paymentFilters } from './paymentSimulation.js';

const now = '2026-11-03T03:00:00Z';
const later = '2026-11-03T03:01:01Z';
const request = overrides => ({ senderId: 'ACC-100003', receiverId: 'ACC-100001', amount: '100.00', idempotencyKey: 'test-key-00001', scenario: 'NORMAL', ...overrides });

test('exact decimal conversion rejects invalid precision, unsafe values and nonpositive amounts', () => {
  assert.equal(parseAmount('0.01'), 1);
  assert.equal(parseAmount('100.10'), 10010);
  for (const value of ['0', '-1', '1.001', '1e3', 'NaN', '900719925474099.99']) assert.throws(() => parseAmount(value));
});
test('normal payment is balanced, recorded, persistent and idempotent with conflict rejection', () => {
  const source = initialRecords();
  const result = processPayment(source, request(), { now });
  assert.equal(source.payment_transactions.length, 2);
  assert.equal(result.payment.status, 'Completed');
  assert.equal(result.payment.completedAt, now);
  assert.equal(balanceFor(result.state, accounts[0]).current, 4410000);
  assert.ok(validJournal(result.state, result.state.ledger_journals.at(-1)));
  assert.equal(result.state.processing_events.filter(e => e.paymentId === result.payment.id).at(-1).eventType, 'PROCESSING_COMPLETED');
  assert.equal(processPayment(result.state, request({ amount: '100.0' }), { now }).state, result.state);
  assert.throws(() => processPayment(result.state, request({ amount: '101' }), { now }), /different payment details/);
  const restored = restoreRecords({ getItem: () => JSON.stringify(result.state) });
  assert.equal(processPayment(restored, request(), { now }).payment.id, result.payment.id);
});
test('ownership, status, currency and funds validation precedes all ledger changes', () => {
  for (const overrides of [{ receiverId: 'ACC-100003' }, { receiverId: 'NONE' }, { receiverId: 'ACC-100005' }, { receiverId: 'ACC-100007' }, { receiverId: 'ACC-100004' }, { amount: '999999999' }]) {
    assert.throws(() => processPayment(initialRecords(), request(overrides), { now }));
  }
});
test('all five source scenarios are independently detectable after cutoffs without duplicate cases', () => {
  let state = initialRecords();
  for (const scenario of ['DUPLICATE', 'PROCESSING_FAILURE', 'MISSING_LEDGER', 'AMOUNT_MISMATCH', 'UNMATCHED']) {
    const result = processPayment(state, request({ scenario, idempotencyKey: scenario }), { role: 'ADMIN', now });
    state = result.state;
    assert.equal(state.exception_cases?.length || 0, 0);
  }
  assert.equal(state.ledger_journals.length, 5);
  assert.equal(state.payment_transactions.find(p => p.scenarioCode === 'PROCESSING_FAILURE').status, 'Failed');
  assert.ok(state.ledger_journals.every(j => validJournal(state, j)));
  assert.equal(balanceFor(state, accounts[0]).current, 4429999);
  const immediate = detectPayments(state, { now });
  assert.equal(immediate.exception_cases.length, 2);
  const detected = detectPayments(immediate, { now: later });
  assert.equal(detected.exception_cases.length, 5);
  assert.deepEqual(new Set(detected.exception_cases.map(c => c.exceptionType)), new Set(['Duplicate Transaction', 'Payment Processing Failure', 'Missing Ledger Posting', 'Amount Mismatch', 'Unmatched Transaction']));
  assert.equal(detectPayments(detected, { now: later }).exception_cases.length, 5);
  assert.ok(detected.exception_cases.every(c => c.status === 'OPEN'));
  assert.equal(detected.ledger_journals.length, 5);
  assert.throws(() => processPayment(initialRecords(), request({ scenario: 'MISSING_LEDGER' }), { role: 'ANALYST', now }), /ADMIN/);
});
test('combined search, Singapore date windows and sorting do not mutate source', () => {
  const records = initialRecords().payment_transactions;
  const filter = overrides => filterPayments(records, accounts, { ...paymentFilters, ...overrides }, now);
  assert.equal(filter({ search: 'Northstar', status: 'Completed', currency: 'SGD', range: '7days' }).length, 1);
  assert.equal(filter({ range: 'today' }).length, 0);
  assert.equal(filter({ range: 'custom', from: '2026-11-02', to: '2026-11-02' }).length, 2);
  assert.equal(filter({ sort: 'oldest' })[0].id, 'TXN-1001');
  assert.equal(filter({ sort: 'amount-low' })[0].id, 'TXN-1002');
  assert.equal(records[0].id, 'TXN-1001');
});
