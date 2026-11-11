import test from 'node:test';
import assert from 'node:assert/strict';
import { filterJournals, journalMoney, journalRows } from './journalRows.js';

// Unit fixtures exercise validation only; never served or written to any database.
const fixture = () => ({ accounts: [{ id: 'a', customer: 'Sender', currency: 'SGD' }, { id: 'b', customer: 'Receiver', currency: 'SGD' }],
  payment_transactions: [{ id: 'payment' }], ledger_journals: [{ id: 'journal', paymentId: 'shared-anchor', sourcePaymentId: 'payment', status: 'Posted', currency: 'SGD', postedAt: '2026-11-11T00:00:00Z' }],
  ledger_entries: [{ id: 'debit', journalId: 'journal', accountId: 'a', side: 'Debit', amountCents: 50000, currency: 'SGD', posted: true }, { id: 'credit', journalId: 'journal', accountId: 'b', side: 'Credit', amountCents: 50000, currency: 'SGD', posted: true }] });

test('uses actual parties, source transaction and separate debit/credit totals', () => {
  const [row] = journalRows(fixture());
  assert.equal(row.debit, 50000n); assert.equal(row.credit, 50000n); assert.equal(row.balanced, true);
  assert.equal(row.senders[0].name, 'Sender'); assert.equal(row.receivers[0].name, 'Receiver');
  assert.equal(row.paymentReference, 'payment'); assert.equal(row.paymentAvailable, true);
  assert.deepEqual(row.entries.map(e => e.id), ['debit', 'credit']);
});
for (const [name, mutate] of [
  ['Draft', s => { s.ledger_journals[0].status = 'Draft'; }],
  ['unbalanced', s => { s.ledger_entries[1].amountCents = 49999; }],
  ['unposted entry', s => { s.ledger_entries[0].posted = false; }],
  ['missing account', s => { s.accounts.pop(); }],
  ['wrong currency', s => { s.ledger_entries[1].currency = 'USD'; }],
  ['unsafe integer', s => { s.ledger_entries[1].amountCents = Number.MAX_SAFE_INTEGER + 1; }],
  ['missing timestamp', s => { s.ledger_journals[0].postedAt = null; }],
  ['duplicate entry ID', s => { s.ledger_entries.push({ ...s.ledger_entries[0] }); }],
  ['no entries', s => { s.ledger_entries = []; }],
]) test(`never marks ${name} as balanced`, () => {
  const snapshot = fixture(); mutate(snapshot); const [row] = journalRows(snapshot);
  assert.equal(row.balanced, false); assert.notEqual(row.validation, 'Balanced');
});
test('decimal-safe aggregation does not overflow or combine debit and credit', () => {
  const snapshot = fixture(); snapshot.ledger_entries.forEach(e => { e.amountCents = Number.MAX_SAFE_INTEGER; });
  snapshot.ledger_entries.push(...snapshot.ledger_entries.map(e => ({ ...e, id: e.id + '-2' })));
  const [row] = journalRows(snapshot);
  assert.equal(row.debit, 18014398509481982n); assert.equal(row.credit, row.debit);
  assert.equal(journalMoney(row.debit, 'SGD'), 'SGD 180,143,985,094,819.82');
  assert.equal(journalMoney(111, 'SGD'), 'SGD 1.11'); assert.equal(journalMoney(null, 'SGD'), 'Unavailable');
});
test('independent journals are never merged by shared payment reference', () => {
  const snapshot = fixture(); snapshot.ledger_journals.push({ ...snapshot.ledger_journals[0], id: 'other' });
  snapshot.ledger_entries.push(...snapshot.ledger_entries.map(e => ({ ...e, id: e.id + '-2', journalId: 'other' })));
  const rows = journalRows(snapshot); assert.equal(rows.length, 2); assert.ok(rows.every(row => row.entries.length === 2));
});
test('searches references and holders, combines status, and sorts without mutation', () => {
  const rows = journalRows(fixture());
  for (const query of ['JOURNAL', 'shared-anchor', 'payment', 'Sender', 'Receiver', 'a']) assert.equal(filterJournals(rows, { query, status: 'Posted', sort: 'reference' }).length, 1);
  assert.equal(filterJournals(rows, { query: 'missing', status: '', sort: 'newest' }).length, 0);
  assert.equal(filterJournals(rows, { query: '', status: 'Draft', sort: 'oldest' }).length, 0);
  assert.equal(rows.length, 1);
});
