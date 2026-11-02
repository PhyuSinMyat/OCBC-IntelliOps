import test from 'node:test';
import assert from 'node:assert/strict';
import { accounts, addTransfer, balanceFor, validJournal } from './bankingRecords.js';
const alex = accounts[0];
const empty = () => ({ payment_transactions: [], ledger_journals: [], ledger_entries: [] });
const transfer = (state, amountCents = 500000) => addTransfer(state, { senderId: 'ACC-100003', receiverId: alex.id, amountCents, postedAt: '2026-11-02T02:00:00Z' });
test('balanced transfers derive balances without changing opening balances; entries are account scoped and newest first', () => {
  let state = transfer(empty());
  state = addTransfer(state, { senderId: alex.id, receiverId: 'ACC-100002', amountCents: 350000, postedAt: '2026-11-02T03:00:00Z' });
  const b = balanceFor(state, alex);
  assert.deepEqual([b.credits, b.debits, b.net, b.current], [500000, 350000, 150000, 4400000]);
  assert.equal(alex.openingCents, 4250000);
  assert.equal(b.entries[0].side, 'Debit');
  assert.ok(b.entries.every(e => e.accountId === alex.id));
  assert.ok(state.ledger_journals.every(j => validJournal(state, j)));
  assert.equal(accounts.reduce((sum, a) => sum + balanceFor(state, a).net, 0), 0);
  assert.equal(balanceFor(state, accounts[3]).entries.length, 0);
});
test('only Posted journals contribute; excluded reversal uses no compensating entries', () => {
  for (const status of ['Draft', 'Pending', 'Failed', 'Reversed']) {
    const state = transfer(empty()); state.ledger_journals[0].status = status;
    assert.equal(balanceFor(state, alex).current, alex.openingCents);
  }
});
test('unbalanced, currency-incompatible and malformed journals are excluded', () => {
  for (const mutate of [s => s.ledger_entries[0].amountCents++, s => s.ledger_entries[0].currency = 'USD', s => s.ledger_entries[0].side = 'Unknown', s => s.ledger_journals[0].postedAt = 'invalid']) {
    const state = transfer(empty()); mutate(state);
    assert.equal(balanceFor(state, alex).entries.length, 0);
  }
});
test('missing posting is never synthesized and payments alone cannot affect balances', () => {
  const state = empty(); state.payment_transactions.push({ id: 'TXN-MISSING', amountCents: 10000 });
  assert.equal(balanceFor(state, alex).current, alex.openingCents);
  assert.equal(state.ledger_journals.length, 0);
});
test('posting updates existing shared records and rejects invalid transfers atomically', () => {
  const state = transfer(empty()); const next = transfer(state, 100);
  assert.equal(balanceFor(next, alex).current - balanceFor(state, alex).current, 100);
  assert.equal(state.payment_transactions.length, 1);
  for (const overrides of [{ receiverId: alex.id, senderId: alex.id }, { receiverId: 'ACC-100004' }, { receiverId: 'ACC-100005' }, { amountCents: 0 }, { amountCents: 1.5 }, { amountCents: 999999999 }]) {
    assert.throws(() => addTransfer(state, { senderId: 'ACC-100003', receiverId: alex.id, amountCents: 100, postedAt: '2026-11-02T02:00:00Z', ...overrides }));
  }
});
