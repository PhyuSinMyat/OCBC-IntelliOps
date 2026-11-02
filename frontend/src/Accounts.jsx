import React, { useEffect, useState } from 'react';
import { Building2, Search, ChevronRight, ShieldCheck } from 'lucide-react';

import { Link } from 'react-router-dom';
import { accounts, balanceFor, money, signedMoney, postingTime, useBankingRecords } from './bankingRecords.js';
import RecordDrawer from './RecordDrawer';

export default function Accounts() {
  const records = useBankingRecords();
  const [query, setQuery] = useState(() => sessionStorage.getItem('accounts-query') || '');
  const [status, setStatus] = useState(() => sessionStorage.getItem('accounts-status') || 'All statuses');
  const [currency, setCurrency] = useState(() => sessionStorage.getItem('accounts-currency') || 'All currencies');
  const [selected, setSelected] = useState(null);
  useEffect(() => {
    sessionStorage.setItem('accounts-query', query);
    sessionStorage.setItem('accounts-status', status);
    sessionStorage.setItem('accounts-currency', currency);
  }, [query, status, currency]);
  const balance = selected ? balanceFor(records, selected) : null;
  const rows = accounts.filter(a => `${a.reference} ${a.customerRef} ${a.customer}`.toLowerCase().includes(query.trim().toLowerCase()) && (status === 'All statuses' || a.status === status) && (currency === 'All currencies' || a.currency === currency));
  return <>
    <div className="page-heading"><p className="eyebrow">Core banking / ledger</p><h1>Accounts</h1><p>Explore fictional customers, account status and balances.</p></div>
    <div className="account-demo"><ShieldCheck size={15}/><span>Shared synthetic simulation · Balances use local posted ledger records. Backend integration is not connected.</span></div>
    <section className="account-metrics" aria-label="Account summary">
      {[[ 'Total accounts', accounts.length, 'Across 2 currencies' ], ['Active accounts', accounts.filter(a => a.status === 'Active').length, 'Available in this simulation'], ['Frozen accounts', 1, 'Restricted account'], ['Closed accounts', 1, 'Retained for reference']].map(([label, value, note]) => <div className="account-metric" key={label}><span>{label}</span><strong>{value}</strong><small>{note}</small></div>)}
    </section>
    <section className="accounts-panel" aria-labelledby="register-title">
      <div className="account-register-heading"><div><h2 id="register-title">Account register</h2><p>All account records in the synthetic dataset.</p></div><span className="record-count">{accounts.length} accounts</span></div>
      <div className="account-filters"><label className="account-search"><Search size={17}/><input aria-label="Search accounts" placeholder="Search account, customer or reference…" value={query} onChange={e => setQuery(e.target.value)}/></label><label><span className="filter-label">Status</span><select aria-label="Filter by status" value={status} onChange={e => setStatus(e.target.value)}>{['All statuses', 'Active', 'Frozen', 'Closed'].map(v => <option key={v}>{v}</option>)}</select></label><label><span className="filter-label">Currency</span><select aria-label="Filter by currency" value={currency} onChange={e => setCurrency(e.target.value)}>{['All currencies', 'SGD', 'USD'].map(v => <option key={v}>{v}</option>)}</select></label></div>
      <div className="account-table-scroll"><table className="account-table"><caption className="sr-only">Fictional accounts and ledger-derived current balances</caption><thead><tr>{['Account reference', 'Customer', 'Account Type', 'Currency', 'Current balance', 'Status', 'Actions'].map((h, i) => <th key={i} scope="col">{h || <span className="sr-only">Details</span>}</th>)}</tr></thead><tbody>{rows.map(a => <tr key={a.reference}><td><button className="account-link" onClick={e => { setSelected(a); }}>{a.reference}</button><small>Opening: {money(a.openingCents, a.currency)}</small></td><td><strong>{a.customer}</strong><small>{a.customerRef}</small></td><td>{a.type}</td><td>{a.currency}</td><td className="balance-cell">{money(balanceFor(records, a).current, a.currency)}<small className={balanceFor(records, a).net < 0 ? 'movement-out' : 'movement-in'}>{balanceFor(records, a).net ? 'Net change: ' + signedMoney(balanceFor(records, a).net, a.currency) : 'No change'}</small></td><td><span className={`account-status ${a.status.toLowerCase()}`}><i/>{a.status}</span></td><td><button className="icon-button" aria-label={`View ${a.reference}`} onClick={e => { setSelected(a); }}><ChevronRight size={17}/></button></td></tr>)}</tbody></table></div>
      {!rows.length && <div className="account-empty"><Search size={25}/><h3>No accounts found</h3><p>Try another search or clear your filters.</p><button className="account-link" onClick={() => { setQuery(''); setStatus('All statuses'); setCurrency('All currencies'); }}>Clear filters</button></div>}
      <div className="account-table-footer" aria-live="polite">Showing {rows.length} of {accounts.length} accounts <span>All records are fictional</span></div>
    </section>
    <RecordDrawer open={!!selected} title={selected?.reference || 'Account details'} onClose={() => setSelected(null)}>
      {selected && <>
        <section aria-label="Account identity"><div className="account-customer"><span className="portal-icon"><Building2 size={24}/></span><div><h3>{selected.customer}</h3><p>{selected.customerRef} · Fictional customer</p></div></div><div className="account-identity-meta"><span>{selected.type} · {selected.currency}</span><span className={'account-status ' + selected.status.toLowerCase()}><i/>{selected.status}</span></div></section>
        <section className="account-balance" aria-label="Current balance summary"><span>Current balance</span><strong>{money(balance.current, selected.currency)}</strong><span className={balance.net < 0 ? 'movement-out' : 'movement-in'}>Net change since opening: {signedMoney(balance.net, selected.currency)}</span><small>Opening balance + posted credits − posted debits</small></section>
        <section><h3 className="drawer-section-title">Balance Breakdown</h3><dl className="account-facts">{[['Opening balance', money(selected.openingCents, selected.currency)], ['Posted credits', '+' + money(balance.credits, selected.currency)], ['Posted debits', '-' + money(balance.debits, selected.currency)], ['Current balance', money(balance.current, selected.currency)]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></section>
        <section className="posted-history"><h3 className="drawer-section-title">Posted Transaction History</h3><p className="history-caption">Newest first · Times in Singapore (SGT)</p>{balance.entries.length ? balance.entries.map(entry => <article className="posted-entry" key={entry.id}><div className="posted-entry-top"><strong>{entry.description}</strong><strong className={entry.side === 'Credit' ? 'movement-in' : 'movement-out'}>{signedMoney(entry.side === 'Credit' ? entry.amountCents : -entry.amountCents, entry.currency)}</strong></div><div className="posted-entry-links"><Link to={'/core-banking/journals?journal=' + encodeURIComponent(entry.journalId)}>{entry.journalId}</Link><span>·</span>{records.payment_transactions.some(p => p.id === entry.journal.paymentId) ? <Link to={'/payments/transactions?transaction=' + encodeURIComponent(entry.journal.paymentId)}>{entry.journal.paymentId}</Link> : <span>Payment unavailable</span>}</div><div className="posted-entry-meta"><time dateTime={entry.journal.postedAt}>{postingTime(entry.journal.postedAt)}</time><span>{entry.side} · {entry.journal.status}</span></div></article>) : <div className="account-empty"><h3>No posted transactions yet.</h3><p>Current balance equals opening balance because no posted ledger movements are connected to this account.</p></div>}</section>
        <div className="account-demo"><ShieldCheck size={17}/><span>Shared local simulation, not backend ledger data. Only balanced, same-currency Posted journals affect balances. Draft, Pending, Failed and Reversed journals are excluded.</span></div>
      </>}
    </RecordDrawer>
  </>;
}
