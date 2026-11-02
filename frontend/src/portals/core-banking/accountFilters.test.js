import test from 'node:test';
import assert from 'node:assert/strict';
import { accounts, customers, balanceFor, initialRecords, restoreRecords, validJournal } from '../../shared/data/bankingRecords.js';
import { defaultFilters, selectAccounts, typeLabel } from './accountFilters.js';

const balances = Object.fromEntries(accounts.map(a => [a.id, balanceFor(initialRecords(), a)]));
const select = overrides => selectAccounts(accounts, balances, { ...defaultFilters, ...overrides });

test('explicit customer classification preserves account references, ownership and balances', () => {
  assert.equal(customers.length, 8);
  assert.equal(accounts.length, 8);
  assert.deepEqual(accounts.filter(a => a.customerType === 'BUSINESS').map(a => a.id), ['ACC-100003', 'ACC-100005', 'ACC-100008']);
  assert.ok(accounts.every(a => ['SAVINGS', 'CURRENT'].includes(a.accountType)));
  assert.ok(accounts.filter(a => a.customerType === 'BUSINESS').every(a => a.accountType === 'CURRENT'));
  assert.equal(balances['ACC-100001'].current, 4400000);
  assert.equal(typeLabel('INDIVIDUAL'), 'Individual');
  assert.equal(typeLabel('BUSINESS'), 'Business');
  assert.equal(typeLabel('CURRENT'), 'Current');
});

test('search supports all references and customer names; filters compose and reset', () => {
  for (const query of ['northstar', 'CUS-003', 'ACC-100003', ' NORTHSTAR ']) assert.equal(select({ query })[0].id, 'ACC-100003');
  assert.deepEqual(select({ customerType: 'BUSINESS', accountType: 'CURRENT', status: 'Active', currency: 'SGD' }).map(a => a.id), ['ACC-100003', 'ACC-100008']);
  assert.equal(select({ customerType: 'BUSINESS', accountType: 'SAVINGS' }).length, 0);
  assert.equal(select({ query: 'no such customer' }).length, 0);
  assert.equal(select({}).length, 8);
});

test('sorting is deterministic with reference tiebreakers and does not mutate source', () => {
  const ids = accounts.map(a => a.id);
  assert.equal(select({ sort: 'customer-asc' })[0].customer, 'Alex Tan');
  assert.equal(select({ sort: 'customer-desc' })[0].customer, 'Willow Studio Pte Ltd');
  assert.equal(select({ sort: 'balance-asc' })[0].id, 'ACC-100007');
  assert.equal(select({ sort: 'balance-desc' })[0].id, 'ACC-100003');
  assert.equal(select({ sort: 'created-desc' })[0].id, 'ACC-100008');
  assert.equal(select({ sort: 'created-asc' })[0].id, 'ACC-100001');
  assert.deepEqual(accounts.map(a => a.id), ids);
});

test('saved simulation survives refresh without adding or repairing journals', () => {
  const saved = initialRecords();
  saved.payment_transactions.push({ id: 'MISSING', status: 'Completed' });
  const restored = restoreRecords({ getItem: () => JSON.stringify(saved) });
  for (const key of Object.keys(saved)) assert.deepEqual(restored[key], saved[key]);
  assert.deepEqual(restored.exception_cases, []);
  assert.equal(restoreRecords({ getItem: () => null }).ledger_journals.length, 2);
  assert.throws(() => restoreRecords({ getItem: () => '{}' }));
});

test('unposted entry excludes the entire journal and an internal balanced mismatch remains posted', () => {
  const state = initialRecords();
  state.ledger_entries[0].posted = false;
  assert.equal(validJournal(state, state.ledger_journals[0]), false);
  state.ledger_entries[0].posted = true;
  state.payment_transactions[0].amountCents += 100;
  assert.equal(validJournal(state, state.ledger_journals[0]), true);
  assert.equal(balanceFor(state, accounts[0]).current, 4400000);
});
