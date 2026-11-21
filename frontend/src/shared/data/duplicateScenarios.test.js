import test from 'node:test';
import assert from 'node:assert/strict';
import { accounts, initialRecords, balanceFor } from './bankingRecords.js';
import { processDuplicateRun, duplicateScenarios } from './duplicateScenarios.js';
import { detectPayments } from './paymentSimulation.js';

const input = { senderId: 'ACC-100003', receiverId: 'ACC-100001', amount: '123.45', runKey: 'local-run-0001' };
const options = { role: 'ANALYST', now: '2026-11-03T03:00:00Z' };

for (const [index, variant] of duplicateScenarios.entries()) {
  test(`${variant.code}: actual journals, balances, origins, replay and candidate pair`, () => {
    const before = initialRecords();
    const sender = accounts.find(a => a.id === input.senderId), receiver = accounts.find(a => a.id === input.receiverId);
    const request = { ...input, duplicateScenario: variant.code };
    const { state, payment: result } = processDuplicateRun(before, request, options);
    const count = index === 0 ? 1 : 2;
    assert.equal(result.postingCount, count);
    assert.deepEqual(result.payments.map(p => p.status), ['Completed', index === 0 ? 'Held' : 'Completed']);
    assert.equal(new Set(result.requestIds).size, 2);
    assert.equal(result.instructionReferences.length, index === 2 ? 2 : 1);
    assert.equal(balanceFor(state, sender).current, balanceFor(before, sender).current - 12345 * count);
    assert.equal(balanceFor(state, receiver).current, balanceFor(before, receiver).current + 12345 * count);
    const receipts = result.payments.flatMap(p => p.requests);
    assert.equal(receipts.filter(r => r.origin === 'SYSTEM').length, Number(index === 1));
    assert.equal(receipts.filter(r => r.retryOfRequestId).length, Number(index === 1));
    assert.equal(new Set(receipts.filter(r => r.authorizationId).map(r => r.authorizationId)).size, index === 2 ? 2 : 0);
    assert.equal(processDuplicateRun(state, request, options).state, state);
    assert.throws(() => processDuplicateRun(state, { ...request, amount: '124.00' }, options), /different inputs/);
    const detected = detectPayments(state, { now: state.simulationNow });
    assert.equal(detected.exception_cases.length, 1);
    assert.equal(detected.exception_cases[0].evidence.rootCause, 'NOT_ESTABLISHED');
    assert.equal(detectPayments(detected, { now: state.simulationNow }).exception_cases.length, 1);
    assert.ok(!JSON.stringify(result).includes(variant.code));
    assert.deepEqual(before, initialRecords());
    assert.equal(state.ledger_entries.length - before.ledger_entries.length, count * 2);
  });
}

test('local validation is atomic, checks aggregate funds, and allows a hold after spending the remaining balance', () => {
  const state = initialRecords();
  const sender = accounts.find(a => a.id === input.senderId);
  const remaining = (balanceFor(state, sender).current / 100).toFixed(2);
  assert.equal(processDuplicateRun(state, { ...input, amount: remaining, duplicateScenario: duplicateScenarios[0].code }, options).payment.postingCount, 1);
  assert.throws(() => processDuplicateRun(state, { ...input, amount: remaining, duplicateScenario: duplicateScenarios[1].code }, options), /funds/);
  assert.throws(() => processDuplicateRun(state, { ...input, duplicateScenario: duplicateScenarios[0].code }, { ...options, role: 'ADMIN' }), /ANALYST/);
  assert.throws(() => processDuplicateRun(state, { ...input, receiverId: 'ACC-100005', duplicateScenario: duplicateScenarios[0].code }, options), /Active/);
});
