import { useSyncExternalStore } from 'react';

import { processPayment, detectPayments, nextReference } from './paymentSimulation.js';
import { paymentRequest, exceptionRequest, fetchBankingSnapshot } from '../api/banking.js';
import { processDuplicateRun } from './duplicateScenarios.js';
import { bankingApiUrl, backendModeRequested } from '../api/config.js';

export const customers = [
  ['CUS-001', 'Alex Tan', 'INDIVIDUAL'], ['CUS-002', 'Maya Lim', 'INDIVIDUAL'], ['CUS-003', 'Northstar Trading Pte Ltd', 'BUSINESS'],
  ['CUS-004', 'Daniel Koh', 'INDIVIDUAL'], ['CUS-005', 'Willow Studio Pte Ltd', 'BUSINESS'], ['CUS-006', 'Priya Nair', 'INDIVIDUAL'],
  ['CUS-007', 'Ethan Lee', 'INDIVIDUAL'], ['CUS-008', 'Harbour Works Pte Ltd', 'BUSINESS'],
].map(([id, name, customerType]) => ({ id, name, customerType }));
export const accounts = [
  ['ACC-100001', 'CUS-001', 'Savings', 'SGD', 4250000, 'Active'],
  ['ACC-100002', 'CUS-002', 'Current', 'SGD', 1875000, 'Active'],
  ['ACC-100003', 'CUS-003', 'Current', 'SGD', 28500000, 'Active'],
  ['ACC-100004', 'CUS-004', 'Savings', 'USD', 1240000, 'Active'],
  ['ACC-100005', 'CUS-005', 'Current', 'SGD', 6700000, 'Frozen'],
  ['ACC-100006', 'CUS-006', 'Savings', 'SGD', 980000, 'Active'],
  ['ACC-100007', 'CUS-007', 'Current', 'USD', 0, 'Closed'],
  ['ACC-100008', 'CUS-008', 'Current', 'SGD', 15600000, 'Active'],
].map(([id, customerRef, type, currency, openingCents, status], index) => ({ id, reference: id, customerRef, customer: customers.find(c => c.id === customerRef).name, customerType: customers.find(c => c.id === customerRef).customerType, accountType: type.toUpperCase(), type, currency, openingCents, status, createdAt: `2026-10-${String(index + 1).padStart(2, '0')}T00:00:00Z` }));
export const money = (cents, currency) => `${currency} ${(cents / 100).toLocaleString('en-SG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const signedMoney = (cents, currency) => `${cents < 0 ? '-' : '+'}${money(Math.abs(cents), currency)}`;
export const postingTime = value => new Intl.DateTimeFormat('en-SG', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Singapore' }).format(new Date(value));

export function validJournal(state, journal) {
  const entries = state.ledger_entries.filter(e => e.journalId === journal.id);
  return journal.status === 'Posted' && Number.isFinite(Date.parse(journal.postedAt)) && entries.length >= 2 &&
    entries.every(e => e.posted !== false && Number.isSafeInteger(e.amountCents) && e.amountCents > 0 && ['Debit', 'Credit'].includes(e.side) && e.currency === journal.currency && accounts.some(a => a.id === e.accountId && a.currency === e.currency)) &&
    entries.reduce((sum, e) => sum + (e.side === 'Credit' ? e.amountCents : -e.amountCents), 0) === 0;
}
export function balanceFor(state, account) {
  const entries = state.ledger_entries.filter(e => e.accountId === account.id && e.currency === account.currency && state.ledger_journals.some(j => j.id === e.journalId && j.currency === account.currency && validJournal(state, j)))
    .map(e => ({ ...e, journal: state.ledger_journals.find(j => j.id === e.journalId) }))
    .sort((a, b) => Date.parse(b.journal.postedAt) - Date.parse(a.journal.postedAt) || b.id.localeCompare(a.id));
  const credits = entries.filter(e => e.side === 'Credit').reduce((sum, e) => sum + e.amountCents, 0);
  const debits = entries.filter(e => e.side === 'Debit').reduce((sum, e) => sum + e.amountCents, 0);
  return { entries, credits, debits, net: credits - debits, current: account.openingCents + credits - debits, ...account.authoritativeBalance };
}
export function addTransfer(state, { senderId, receiverId, amountCents, postedAt }) {
  const sender = accounts.find(a => a.id === senderId), receiver = accounts.find(a => a.id === receiverId);
  if (!sender || !receiver || sender.id === receiver.id || sender.status !== 'Active' || receiver.status !== 'Active' || sender.currency !== receiver.currency || !Number.isSafeInteger(amountCents) || amountCents <= 0 || !Number.isFinite(Date.parse(postedAt))) throw new Error('Select two different active accounts in the same currency and a positive amount with at most two decimals.');
  if (balanceFor(state, sender).current < amountCents) throw new Error('The sending account has insufficient funds.');
  const number = nextReference(state).slice(4);
  const payment = { id: `TXN-${number}`, senderId, receiverId, amountCents, currency: sender.currency, status: 'Completed', createdAt: postedAt, completedAt: postedAt };
  const journal = { id: `JRN-${number}`, paymentId: payment.id, currency: sender.currency, status: 'Posted', postedAt };
  const entries = [ { id: `${journal.id}-D`, journalId: journal.id, accountId: senderId, side: 'Debit', description: 'Outgoing transfer' }, { id: `${journal.id}-C`, journalId: journal.id, accountId: receiverId, side: 'Credit', description: 'Incoming transfer' } ].map(e => ({ ...e, amountCents, currency: sender.currency }));
  const events = ['PAYMENT_CREATED', 'VALIDATION_STARTED', 'VALIDATION_PASSED', 'PROCESSING_STARTED', 'LEDGER_POSTED', 'PROCESSING_COMPLETED'].map((kind, index) => ({
    id: `${payment.id}-${index}`, paymentId: payment.id, eventType: kind, status: index === 0 ? 'PENDING' : index === 5 ? 'COMPLETED' : 'PROCESSING',
    description: kind === 'LEDGER_POSTED' ? `Balanced posting recorded in ${journal.id}.` : kind.replaceAll('_', ' ').toLowerCase(), occurredAt: postedAt, errorCode: null }));
  return { ...state, payment_transactions: [...state.payment_transactions, payment], ledger_journals: [...state.ledger_journals, journal], ledger_entries: [...state.ledger_entries, ...entries], processing_events: [...(state.processing_events || []), ...events] };
}
export function initialRecords() {
  let records = { payment_transactions: [], ledger_journals: [], ledger_entries: [] };
  records = addTransfer(records, { senderId: 'ACC-100003', receiverId: 'ACC-100001', amountCents: 500000, postedAt: '2026-11-02T02:00:00Z' });
  return addTransfer(records, { senderId: 'ACC-100001', receiverId: 'ACC-100002', amountCents: 350000, postedAt: '2026-11-02T03:00:00Z' });
}
const STORAGE_KEY = 'intelliops-banking-records-v1';
export function restoreRecords(storage) {
  const raw = storage?.getItem(STORAGE_KEY);
  if (!raw) return initialRecords();
  const saved = JSON.parse(raw);
  if (!['payment_transactions', 'ledger_journals', 'ledger_entries'].every(key => Array.isArray(saved[key]))) throw new Error('Saved simulation data is invalid.');
  return { processing_events: [], exception_cases: [], audit_events: [], payment_requests: {}, ...saved };
}
let state;
if (backendModeRequested) {
  // Never initialize financial records from browser storage in authoritative mode.
  customers.splice(0); accounts.splice(0);
  state = { customers: [], accounts: [], payment_transactions: [], ledger_journals: [], ledger_entries: [],
    processing_events: [], exception_cases: [], audit_events: [], dataSource: 'backend', connectionState: 'loading' };
} else {
  try { state = restoreRecords(globalThis.localStorage); } catch { state = initialRecords(); }
}
const listeners = new Set();
globalThis.addEventListener?.('storage', event => {
  if (backendConnected || (event.key !== STORAGE_KEY && event.key !== null)) return;
  try {
    state = restoreRecords(globalThis.localStorage);
    listeners.forEach(fn => fn());
  } catch { /* Retain the last valid snapshot. */ }
});
export let backendConnected = backendModeRequested;
export function loadBackendSnapshot(snapshot) {
  customers.splice(0, customers.length, ...snapshot.customers);
  accounts.splice(0, accounts.length, ...snapshot.accounts);
  state = { ...snapshot, processing_events: snapshot.processing_events || [], exception_cases: snapshot.exception_cases || [], audit_events: snapshot.audit_events || [],
    dataSource: 'backend', connectionState: 'ready', connectionError: null };
  backendConnected = true;
  listeners.forEach(fn => fn());
}
export function postTransfer(input) {
  if (backendConnected) throw new Error('Backend ledger access is read-only. Posting requires a controlled, authenticated backend service.');
  const next = addTransfer(state, input);
  try { globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { throw new Error('Unable to save the simulation. Enable browser storage before posting.'); }
  state = next;
  listeners.forEach(fn => fn());
}
function save(next) {
  if (backendConnected) throw new Error('Backend records cannot be saved as a browser-only simulation.');
  try { globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { throw new Error('Unable to save the simulation. Enable browser storage before submitting.'); }
  state = next;
  listeners.forEach(fn => fn());
}
export const getSimulationNow = () => new Date(Math.max(Date.now(), Date.parse(state.simulationNow) || 0)).toISOString();
export async function createSyntheticPayment(input, role = 'ANALYST') {
  if (backendConnected) {
    const result = await paymentRequest(input.scenario && input.scenario !== 'NORMAL' ? '/api/demo/payments/scenario' : '/api/payments', {
      sender_account_ref: input.senderId, receiver_account_ref: input.receiverId, amount: input.amount,
      currency: input.currency || accounts.find(a => a.id === input.senderId)?.currency, idempotency_key: input.idempotencyKey,
      ...(input.scenario && input.scenario !== 'NORMAL' ? { scenario_code: input.scenario } : {}),
      ...(input.scenario === 'DUPLICATE' && input.duplicateScenario ? { duplicate_scenario: input.duplicateScenario, run_key: input.runKey } : {}),
    });
    await refreshBackend({ fresh: true });
    return result;
  }
  const result = input.scenario === 'DUPLICATE' && input.duplicateScenario
    ? processDuplicateRun(state, input, { role, now: getSimulationNow() })
    : processPayment(state, input, { role, now: getSimulationNow() });
  save(result.state);
  return result.payment;
}
export async function createExceptionBatch(exceptionTypes, countPerType) {
  if (!backendConnected) throw new Error('Automatic exception batches require the connected backend.');
  const result = await paymentRequest('/api/demo/exception-batches', {
    exception_types: exceptionTypes, count_per_type: countPerType,
  });
  await refreshBackend({ fresh: true });
  return result;
}
let refreshInFlight;
export function refreshBackend({ fresh = false } = {}) {
  if (!backendConnected) return Promise.resolve();
  // A response captured before a committed write must not satisfy its refresh.
  if (fresh && refreshInFlight) return refreshInFlight.catch(() => {}).then(() => refreshBackend());
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = fetchBankingSnapshot(bankingApiUrl).then(snapshot => {
    loadBackendSnapshot(snapshot);
    return snapshot;
  }).catch(error => {
    state = { ...state, connectionState: 'error', connectionError: error.message };
    listeners.forEach(fn => fn());
    throw error;
  }).finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}
export async function runPaymentDetection(role = 'ANALYST') {
  if (backendConnected) {
    const result = await paymentRequest('/api/detection/run', {});
    await refreshBackend({ fresh: true });
    return result.created;
  }
  const next = detectPayments(state, { role, now: getSimulationNow() });
  const count = next.exception_cases.length - (state.exception_cases || []).length;
  save(next);
  return count;
}
export async function fetchExceptionCase(caseId) {
  if (!backendConnected) return state.exception_cases.find(item => item.id === caseId) || null;
  return exceptionRequest(`/api/exceptions/${encodeURIComponent(caseId)}`);
}
export async function addExceptionNote(caseId, note) {
  if (!backendConnected) throw new Error('Case lifecycle actions require the connected backend.');
  const result = await exceptionRequest(`/api/exceptions/${encodeURIComponent(caseId)}/notes`, { method: 'POST', body: { note } });
  await refreshBackend({ fresh: true });
  return result;
}
export async function remediateException(caseId, note) {
  if (!backendConnected) throw new Error('Case resolution requires the connected backend.');
  const result = await exceptionRequest(`/api/exceptions/${encodeURIComponent(caseId)}/remediate`, { method: 'POST', body: {
    idempotency_key: `case-resolution-${caseId}-${crypto.randomUUID()}`, note: note || null,
  } });
  await refreshBackend({ fresh: true });
  return result;
}
export async function closeException(caseId, note) {
  if (!backendConnected) throw new Error('Case closure requires the connected backend.');
  const result = await exceptionRequest(`/api/exceptions/${encodeURIComponent(caseId)}/close`, { method: 'POST', body: { note: note || null } });
  await refreshBackend({ fresh: true });
  return result;
}
export function advanceSimulationClock(role) {
  if (backendConnected || role !== 'ADMIN') throw new Error('Clock advance is available only to the local ADMIN demo role.');
  const now = new Date(Date.parse(getSimulationNow()) + 61000).toISOString();
  save({ ...state, simulationNow: now, audit_events: [...(state.audit_events || []), { id: `AUD-CLOCK-${(state.audit_events || []).length}`, action: 'SIMULATION_CLOCK_ADVANCED', actor: role, reference: 'LOCAL_CLOCK', details: { seconds: 61 }, createdAt: now }] });
}
export function useBankingRecords() { return useSyncExternalStore(fn => { listeners.add(fn); return () => listeners.delete(fn); }, () => state); }
// Deposit-account simulation: a Reversed journal contributes no active movements.
// No compensating reversal entries are generated by this prototype.
