import React, { useEffect, useMemo, useState } from 'react';
import { Building2, Search, ChevronRight, ShieldCheck } from 'lucide-react';

import { Link, useSearchParams } from 'react-router-dom';
import { accounts, backendConnected, balanceFor, money, signedMoney, postingTime, useBankingRecords } from '../../shared/data/bankingRecords.js';
import { defaultFilters, selectAccounts, typeLabel } from './accountFilters.js';
import RecordDrawer from '../../shared/components/RecordDrawer';

export default function Accounts() {
  const records = useBankingRecords();
  const [filters, setFilters] = useState(() => {
    try { return { ...defaultFilters, ...JSON.parse(sessionStorage.getItem('accounts-filters-v2') || '{}') }; }
    catch { return { ...defaultFilters }; }
  });
  const [params, setParams] = useSearchParams();
  const selected = accounts.find(a => a.id === params.get('account')) || null;
  const setSelected = account => {
    const next = new URLSearchParams(params);
    if (account) next.set('account', account.id);
    else next.delete('account');
    setParams(next, { replace: !account });
  };
  useEffect(() => { try { sessionStorage.setItem('accounts-filters-v2', JSON.stringify(filters)); } catch {} }, [filters]);
  const balances = useMemo(() => Object.fromEntries(accounts.map(a => [a.id, balanceFor(records, a)])), [records]);
  const balance = selected ? balances[selected.id] : null;
  const rows = selectAccounts(accounts, balances, filters);
  const change = (key, value) => setFilters(previous => ({ ...previous, [key]: value }));
  const reset = () => setFilters({ ...defaultFilters });
  const options = {
    customerType: ['INDIVIDUAL', 'BUSINESS'], accountType: ['SAVINGS', 'CURRENT'],
    currency: [...new Set(accounts.map(a => a.currency))], status: [...new Set(accounts.map(a => a.status))],
  };
  const labels = { customerType: 'Customer type', accountType: 'Account type', currency: 'Currency', status: 'Status' };
  const activeFilters = ['query', ...Object.keys(options)].filter(key => filters[key]);
  return <>
    <div className="page-heading"><p className="eyebrow">Core banking / ledger</p><h1>Accounts</h1><p>Explore fictional customers, account status and balances.</p></div>
    <div className="account-demo"><ShieldCheck size={15}/><span>{backendConnected ? 'Connected synthetic database · Read-only snapshot with server-calculated balances. Refresh to retrieve updates.' : 'Shared synthetic simulation · Balances use locally saved posted ledger records. Backend integration is not connected.'}</span></div>
    <section className="account-metrics" aria-label="Account summary">
      {[[ 'Total accounts', accounts.length, `Across ${new Set(accounts.map(a => a.currency)).size} currencies` ], ['Active accounts', accounts.filter(a => a.status === 'Active').length, 'Available in this simulation'], ['Frozen accounts', accounts.filter(a => a.status === 'Frozen').length, 'Restricted account'], ['Closed accounts', accounts.filter(a => a.status === 'Closed').length, 'Retained for reference']].map(([label, value, note]) => <div className="account-metric" key={label}><span>{label}</span><strong>{value}</strong><small>{note}</small></div>)}
    </section>
    <section className="accounts-panel" aria-labelledby="register-title">
      <div className="account-register-heading"><div><h2 id="register-title">Account register</h2><p>All account records in the synthetic dataset.</p></div><span className="record-count">{rows.length} accounts</span></div>
      <div className="account-filters enhanced-filters">
        <label className="account-search"><Search size={17}/><input aria-label="Search accounts" placeholder="Search account, customer or reference…" value={filters.query} onChange={e => change('query', e.target.value)}/></label>
        {['customerType', 'accountType'].map(key => <label key={key}><span className="filter-label">{labels[key]}</span><select aria-label={'Filter by ' + labels[key].toLowerCase()} value={filters[key]} onChange={e => change(key, e.target.value)}><option value="">All</option>{options[key].map(value => <option value={value} key={value}>{typeLabel(value)}</option>)}</select></label>)}
        <details className="advanced-filters"><summary>More filters{filters.currency || filters.status ? ' •' : ''}</summary><div className="advanced-filter-panel">{['currency', 'status'].map(key => <label key={key}><span className="filter-label">{labels[key]}</span><select aria-label={'Filter by ' + labels[key].toLowerCase()} value={filters[key]} onChange={e => change(key, e.target.value)}><option value="">All</option>{options[key].map(value => <option key={value}>{value}</option>)}</select></label>)}</div></details>
        <label><span className="filter-label">Sort by</span><select aria-label="Sort accounts" value={filters.sort} onChange={e => change('sort', e.target.value)}>{[['reference', 'Account reference'], ['customer-asc', 'Customer A–Z'], ['customer-desc', 'Customer Z–A'], ['balance-asc', 'Balance low–high'], ['balance-desc', 'Balance high–low'], ['created-desc', 'Newest accounts'], ['created-asc', 'Oldest accounts']].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <button className="account-link reset-filters" onClick={reset}>Reset filters</button>
      </div>
      {activeFilters.length > 0 && <div className="active-filter-chips" aria-label="Active filters">{activeFilters.map(key => <button key={key} onClick={() => change(key, '')} aria-label={'Remove ' + (labels[key] || 'search') + ' filter'}>{labels[key] || 'Search'}: {typeLabel(filters[key])}<span aria-hidden="true"> ×</span></button>)}</div>}
      <div className="account-table-scroll" tabIndex={0} role="region" aria-label="Scrollable account register"><table className="account-table"><caption className="sr-only">Fictional accounts and ledger-derived current balances</caption><thead><tr>{['Account reference', 'Customer', 'Customer Type', 'Account Type', 'Currency', 'Current balance', 'Status', 'Actions'].map((h, i) => <th key={i} scope="col" className={h === 'Current balance' ? 'balance-cell' : undefined}>{h || <span className="sr-only">Details</span>}</th>)}</tr></thead><tbody>{rows.map(a => <tr key={a.reference}><td><button className="account-link" onClick={e => { setSelected(a); }}>{a.reference}</button><small>Opening: {money(a.openingCents, a.currency)}</small></td><td><strong>{a.customer}</strong><small>{a.customerRef}</small></td><td><span className="customer-type-badge">{typeLabel(a.customerType)}</span></td><td>{typeLabel(a.accountType)}</td><td>{a.currency}</td><td className="balance-cell">{money(balances[a.id].current, a.currency)}<small className={balances[a.id].net < 0 ? 'movement-out' : 'movement-in'}>{balances[a.id].net ? 'Net change: ' + signedMoney(balances[a.id].net, a.currency) : 'No change'}</small></td><td><span className={`account-status ${a.status.toLowerCase()}`}><i/>{a.status}</span></td><td><button className="icon-button" aria-label={`View ${a.reference}`} onClick={e => { setSelected(a); }}><ChevronRight size={17}/></button></td></tr>)}</tbody></table></div>
      {!rows.length && <div className="account-empty"><Search size={25}/><h3>No accounts found</h3><p>Try another search or clear your filters.</p><button className="account-link" onClick={reset}>Clear filters</button></div>}
      <div className="account-table-footer" aria-live="polite">Showing {rows.length} of {accounts.length} accounts <span>All records are fictional</span></div>
    </section>
    <RecordDrawer open={!!selected} title={selected?.reference || 'Account details'} onClose={() => setSelected(null)}>
      {selected && <>
        <section aria-label="Account information"><h3 className="drawer-section-title">Account Information</h3><div className="account-customer"><span className="portal-icon"><Building2 size={24}/></span><div><h3>{selected.customer}</h3><p>{selected.customerRef} · Fictional customer</p></div></div><div className="account-identity-meta"><span>{selected.type} · {selected.currency}</span><span className={'account-status ' + selected.status.toLowerCase()}><i/>{selected.status}</span></div><dl className="account-facts account-information">{[['Account reference', selected.reference], ['Customer name', selected.customer], ['Customer reference', selected.customerRef], ['Customer type', typeLabel(selected.customerType)], ['Account type', typeLabel(selected.accountType)], ['Currency', selected.currency], ['Account status', selected.status]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></section>
        <section className="account-balance" aria-label="Current balance summary"><span>Current balance</span><strong>{money(balance.current, selected.currency)}</strong><span className={balance.net < 0 ? 'movement-out' : 'movement-in'}>Net change since opening: {signedMoney(balance.net, selected.currency)}</span><small>Opening balance + posted credits − posted debits</small></section>
        <section><h3 className="drawer-section-title">Balance Breakdown</h3><dl className="account-facts">{[['Opening balance', money(selected.openingCents, selected.currency)], ['Posted credits', '+' + money(balance.credits, selected.currency)], ['Posted debits', '-' + money(balance.debits, selected.currency)], ['Current balance', money(balance.current, selected.currency)]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></section>
        <section className="posted-history"><h3 className="drawer-section-title">Posted Transaction History</h3><p className="history-caption">Newest first · Times in Singapore (SGT)</p>{balance.entries.length ? balance.entries.map(entry => <article className="posted-entry" key={entry.id}><div className="posted-entry-top"><strong>{entry.description}</strong><strong className={entry.side === 'Credit' ? 'movement-in' : 'movement-out'}>{signedMoney(entry.side === 'Credit' ? entry.amountCents : -entry.amountCents, entry.currency)}</strong></div><div className="posted-entry-links"><Link to={'/core-banking/journals?journal=' + encodeURIComponent(entry.journalId)}>{entry.journalId}</Link><span>·</span>{records.payment_transactions.some(p => p.id === entry.journal.paymentId) ? <Link to={'/payments/transactions?transaction=' + encodeURIComponent(entry.journal.paymentId)}>{entry.journal.paymentId}</Link> : <span>Payment unavailable</span>}</div><div className="posted-entry-meta"><time dateTime={entry.journal.postedAt}>{postingTime(entry.journal.postedAt)}</time><span>{entry.side} · {entry.journal.status}</span></div></article>) : <div className="account-empty"><h3>No posted transactions yet.</h3><p>Current balance equals the opening balance because no posted ledger entries exist for this account.</p></div>}</section>
        <div className="account-demo"><ShieldCheck size={17}/><span>{backendConnected ? 'Read-only backend ledger snapshot.' : 'Shared local simulation, not backend ledger data.'} Only balanced, same-currency Posted journals affect balances. Draft, Pending and Failed journals are excluded. Posted reversal entries affect balances by their debit or credit direction.</span></div>
      </>}
    </RecordDrawer>
  </>;
}
