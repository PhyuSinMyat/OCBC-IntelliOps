import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fetchBankingSnapshot } from './banking.js';
import { accounts, backendConnected, balanceFor, loadBackendSnapshot, postTransfer } from '../data/bankingRecords.js';

test('backend client reports errors and accepts an authoritative empty snapshot', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: false, status: 503 });
    await assert.rejects(fetchBankingSnapshot('/backend'), /503/);
    globalThis.fetch = async () => { throw new TypeError('Network error'); };
    await assert.rejects(fetchBankingSnapshot('/backend'), /Cannot reach FastAPI/);
    globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({ code: 'DATABASE_UNAVAILABLE', detail: 'PostgreSQL is unavailable; no local fallback.' }) });
    await assert.rejects(fetchBankingSnapshot('/backend'), error => error.status === 503 && error.code === 'DATABASE_UNAVAILABLE' && error.message.includes('PostgreSQL'));
    globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });
    await assert.rejects(fetchBankingSnapshot('/backend'), /invalid snapshot/);
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ customers: [], accounts: [], payment_transactions: [], ledger_journals: [], ledger_entries: [] }) });
    assert.equal((await fetchBankingSnapshot('/backend')).accounts.length, 0);
  } finally { globalThis.fetch = original; }
});

test('connected records preserve shared references, use server summaries and reject local posting', () => {
  const snapshot = JSON.parse(readFileSync(new URL('../../../../backend/modules/core_banking/demo.json', import.meta.url), 'utf8'));
  snapshot.accounts[0].authoritativeBalance = { credits: 500000, debits: 350000, net: 150000, current: 4400000 };
  loadBackendSnapshot(snapshot);
  assert.equal(backendConnected, true);
  assert.equal(balanceFor(snapshot, accounts[0]).current, 4400000);
  assert.equal(snapshot.ledger_journals[0].paymentId, snapshot.payment_transactions[0].id);
  assert.throws(() => postTransfer({}), /read-only/);
});
