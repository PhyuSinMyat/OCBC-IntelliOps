// Read-only projection of persisted snapshot records; never creates accounting entries.
export function journalRows(snapshot) {
  const accounts = new Map(snapshot.accounts.map(account => [account.id, account]));
  const payments = new Set(snapshot.payment_transactions.map(payment => payment.id));
  const grouped = new Map();
  for (const entry of snapshot.ledger_entries) {
    if (!grouped.has(entry.journalId)) grouped.set(entry.journalId, []);
    grouped.get(entry.journalId).push(entry);
  }
  return snapshot.ledger_journals.map(journal => {
    const entries = (grouped.get(journal.id) || []).map(entry => ({ ...entry, account: accounts.get(entry.accountId) }));
    const unique = new Set(entries.map(entry => entry.id)).size === entries.length;
    const amountsValid = entries.length > 0 && entries.every(entry => Number.isSafeInteger(entry.amountCents) && entry.amountCents > 0 && ['Debit', 'Credit'].includes(entry.side) && entry.currency === journal.currency);
    const total = side => amountsValid && unique ? entries.filter(entry => entry.side === side).reduce((sum, entry) => sum + BigInt(entry.amountCents), 0n) : null;
    const debit = total('Debit'), credit = total('Credit');
    const complete = entries.length >= 2 && unique && amountsValid && entries.every(entry => entry.posted === true && entry.account?.currency === entry.currency);
    const balanced = journal.status === 'Posted' && Number.isFinite(Date.parse(journal.postedAt)) && complete && debit === credit && debit > 0n;
    const validation = balanced ? 'Balanced' : journal.status !== 'Posted' ? journal.status
      : !entries.length ? 'Entries unavailable' : !complete || !Number.isFinite(Date.parse(journal.postedAt)) ? 'Incomplete or invalid entries' : 'Unbalanced';
    const parties = side => [...new Set(entries.filter(entry => entry.side === side).map(entry => entry.accountId))].map(id => ({ id, name: accounts.get(id)?.customer || 'Account holder unavailable' }));
    // Shared payment references must not merge independent transaction journals.
    const paymentReference = journal.sourcePaymentId || journal.paymentId;
    return { ...journal, entries, debit, credit, balanced, validation, senders: parties('Debit'), receivers: parties('Credit'),
      paymentReference, paymentAvailable: payments.has(paymentReference),
      searchText: [journal.id, journal.paymentId, journal.sourcePaymentId, ...entries.flatMap(entry => [entry.accountId, entry.account?.customer, entry.account?.customerRef])].filter(Boolean).join(' ').toLowerCase() };
  });
}

export { tableMoney as journalMoney } from '../../shared/components/tableMoney.js';

export function filterJournals(rows, { query, status, sort }) {
  const search = query.trim().toLowerCase();
  return rows.filter(row => (!search || row.searchText.includes(search)) && (!status || row.status === status)).sort((a, b) => {
    if (sort === 'reference') return a.id.localeCompare(b.id);
    const time = row => Number.isFinite(Date.parse(row.postedAt)) ? Date.parse(row.postedAt) : 0;
    return (sort === 'oldest' ? time(a) - time(b) : time(b) - time(a)) || a.id.localeCompare(b.id);
  });
}
