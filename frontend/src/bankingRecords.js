import { useSyncExternalStore } from 'react';

export const customers = [
  ['CUS-001', 'Alex Tan'], ['CUS-002', 'Maya Lim'], ['CUS-003', 'Northstar Trading Pte Ltd'],
  ['CUS-004', 'Daniel Koh'], ['CUS-005', 'Willow Studio Pte Ltd'], ['CUS-006', 'Priya Nair'],
  ['CUS-007', 'Ethan Lee'], ['CUS-008', 'Harbour Works Pte Ltd'],
].map(([id, name]) => ({ id, name }));
export const accounts = [
  ['ACC-100001', 'CUS-001', 'Savings', 'SGD', 4250000, 'Active'],
  ['ACC-100002', 'CUS-002', 'Current', 'SGD', 1875000, 'Active'],
  ['ACC-100003', 'CUS-003', 'Corporate', 'SGD', 28500000, 'Active'],
  ['ACC-100004', 'CUS-004', 'Savings', 'USD', 1240000, 'Active'],
  ['ACC-100005', 'CUS-005', 'Corporate', 'SGD', 6700000, 'Frozen'],
  ['ACC-100006', 'CUS-006', 'Savings', 'SGD', 980000, 'Active'],
  ['ACC-100007', 'CUS-007', 'Current', 'USD', 0, 'Closed'],
  ['ACC-100008', 'CUS-008', 'Corporate', 'SGD', 15600000, 'Active'],
].map(([id, customerRef, type, currency, openingCents, status]) => ({ id, reference: id, customerRef, customer: customers.find(c => c.id === customerRef).name, type, currency, openingCents, status }));
export const money = (cents, currency) => `${currency} ${(cents / 100).toLocaleString('en-SG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const signedMoney = (cents, currency) => `${cents < 0 ? '-' : '+'}${money(Math.abs(cents), currency)}`;
export const postingTime = value => new Intl.DateTimeFormat('en-SG', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Singapore' }).format(new Date(value));

export function validJournal(state, journal) {
  const entries = state.ledger_entries.filter(e => e.journalId === journal.id);
  return journal.status === 'Posted' && Number.isFinite(Date.parse(journal.postedAt)) && entries.length >= 2 &&
    entries.every(e => Number.isSafeInteger(e.amountCents) && e.amountCents > 0 && ['Debit', 'Credit'].includes(e.side) && e.currency === journal.currency && accounts.some(a => a.id === e.accountId && a.currency === e.currency)) &&
    entries.reduce((sum, e) => sum + (e.side === 'Credit' ? e.amountCents : -e.amountCents), 0) === 0;
}
export function balanceFor(state, account) {
  const entries = state.ledger_entries.filter(e => e.accountId === account.id && e.currency === account.currency && state.ledger_journals.some(j => j.id === e.journalId && j.currency === account.currency && validJournal(state, j)))
    .map(e => ({ ...e, journal: state.ledger_journals.find(j => j.id === e.journalId) }))
    .sort((a, b) => Date.parse(b.journal.postedAt) - Date.parse(a.journal.postedAt) || b.id.localeCompare(a.id));
  const credits = entries.filter(e => e.side === 'Credit').reduce((sum, e) => sum + e.amountCents, 0);
  const debits = entries.filter(e => e.side === 'Debit').reduce((sum, e) => sum + e.amountCents, 0);
  return { entries, credits, debits, net: credits - debits, current: account.openingCents + credits - debits };
}
export function addTransfer(state, { senderId, receiverId, amountCents, postedAt }) {
  const sender = accounts.find(a => a.id === senderId), receiver = accounts.find(a => a.id === receiverId);
  if (!sender || !receiver || sender.id === receiver.id || sender.status !== 'Active' || receiver.status !== 'Active' || sender.currency !== receiver.currency || !Number.isSafeInteger(amountCents) || amountCents <= 0 || !Number.isFinite(Date.parse(postedAt))) throw new Error('Select two different active accounts in the same currency and a positive amount with at most two decimals.');
  if (balanceFor(state, sender).current < amountCents) throw new Error('The sending account has insufficient funds.');
  const number = 1001 + state.payment_transactions.length;
  const payment = { id: `TXN-${number}`, senderId, receiverId, amountCents, currency: sender.currency, status: 'Completed', createdAt: postedAt };
  const journal = { id: `JRN-${number}`, paymentId: payment.id, currency: sender.currency, status: 'Posted', postedAt };
  const entries = [ { id: `${journal.id}-D`, journalId: journal.id, accountId: senderId, side: 'Debit', description: 'Outgoing transfer' }, { id: `${journal.id}-C`, journalId: journal.id, accountId: receiverId, side: 'Credit', description: 'Incoming transfer' } ].map(e => ({ ...e, amountCents, currency: sender.currency }));
  return { ...state, payment_transactions: [...state.payment_transactions, payment], ledger_journals: [...state.ledger_journals, journal], ledger_entries: [...state.ledger_entries, ...entries] };
}
let state = { payment_transactions: [], ledger_journals: [], ledger_entries: [] };
state = addTransfer(state, { senderId: 'ACC-100003', receiverId: 'ACC-100001', amountCents: 500000, postedAt: '2026-11-02T02:00:00Z' });
state = addTransfer(state, { senderId: 'ACC-100001', receiverId: 'ACC-100002', amountCents: 350000, postedAt: '2026-11-02T03:00:00Z' });
const listeners = new Set();
export function postTransfer(input) { state = addTransfer(state, input); listeners.forEach(fn => fn()); }
export function useBankingRecords() { return useSyncExternalStore(fn => { listeners.add(fn); return () => listeners.delete(fn); }, () => state); }
// Deposit-account simulation: a Reversed journal contributes no active movements.
// No compensating reversal entries are generated by this prototype.
