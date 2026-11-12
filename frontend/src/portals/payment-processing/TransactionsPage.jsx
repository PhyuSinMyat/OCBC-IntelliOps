import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ChevronRight, Search, ShieldCheck } from 'lucide-react';
import { accounts, backendConnected, getSimulationNow, money, runPaymentDetection, advanceSimulationClock, useBankingRecords } from '../../shared/data/bankingRecords.js';
import { filterPayments, paymentFilters, processingStatuses } from '../../shared/data/paymentSimulation.js';
import CreatePaymentForm from './CreatePaymentForm.jsx';
import CreateExceptionBatchForm from './CreateExceptionBatchForm.jsx';
import TransactionDetailsDrawer, { StatusBadge, timestamp } from './TransactionDetailsDrawer.jsx';

export default function TransactionsPage() {
  const records = useBankingRecords();
  const [params, setParams] = useSearchParams();
  const [filters, setFilters] = useState(() => {
    try { return { ...paymentFilters, ...JSON.parse(sessionStorage.getItem('payment-filters-v2') || '{}') }; }
    catch { return { ...paymentFilters }; }
  });
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [creatingBatch, setCreatingBatch] = useState(false);
  const [demoRole, setDemoRole] = useState(() => sessionStorage.getItem('payment-demo-role') || 'ANALYST');
  const role = backendConnected ? records.role : demoRole;
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [generated, setGenerated] = useState(null);
  useEffect(() => { try { sessionStorage.setItem('payment-filters-v2', JSON.stringify(filters)); } catch {} }, [filters]);
  const change = (key, value) => { setFilters(previous => ({ ...previous, [key]: value })); setPage(1); };
  const reset = () => { setFilters({ ...paymentFilters }); setPage(1); };
  const matching = filterPayments(records.payment_transactions, accounts, filters, records.simulationNow || getSimulationNow());
  const pageSize = 10, pages = Math.max(1, Math.ceil(matching.length / pageSize));
  const currentPage = Math.min(page, pages);
  const rows = matching.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const open = id => { const next = new URLSearchParams(params); next.set('transaction', id); setParams(next); };
  const close = () => { const next = new URLSearchParams(params); next.delete('transaction'); setParams(next, { replace: true }); };
  const party = id => { const a = accounts.find(account => account.id === id); return <><strong>{a?.customer || 'Customer unavailable'}</strong><small>{a?.reference || 'Account unavailable'}</small></>; };
  async function detect() {
    setBusy(true); setError(''); setMessage('');
    try { const count = await runPaymentDetection(role); setMessage(`Detection completed: ${count} new case${count === 1 ? '' : 's'}. Reconciliation cases require the ${records.reconciliationSeconds || 60}-second cutoff to have elapsed.`); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  return <>
    <div className="payment-page-header"><div className="page-heading"><p className="eyebrow">PAYMENT OPERATIONS</p><h1>Transactions</h1><p>Monitor and manage synthetic payment transactions and processing outcomes.</p></div><div className="payment-header-actions">{backendConnected && role === 'ADMIN' && <button className="account-link" onClick={() => setCreatingBatch(true)}>Generate Exception Batch</button>}<button className="simulation-button" onClick={() => setCreating(true)}>Create Synthetic Payment</button></div></div>
    <div className="account-demo"><ShieldCheck size={15}/><span>{backendConnected ? `Connected synthetic database · Authenticated ${role} · Financial operations validated by the backend.` : 'Browser-only simulation · Records persist locally, not to PostgreSQL.'}</span></div>
    <section className="account-metrics" aria-label="Payment summary">{[
      ['Total Transactions', records.payment_transactions.length, 'All processing statuses'],
      ...['Completed', 'Processing', 'Failed', 'Held'].map(status => [status, records.payment_transactions.filter(p => p.status === status).length, `${status} payment instructions`]),
    ].map(([label, count, text]) => <div className="account-metric" key={label}><span>{label}</span><strong>{count}</strong><small>{text}</small></div>)}</section>
    <div className="payment-simulation-controls">{!backendConnected && <label>Local demo role <select aria-label="Local demo role" value={role} onChange={e => { setDemoRole(e.target.value); sessionStorage.setItem('payment-demo-role', e.target.value); }}><option>ANALYST</option><option>ADMIN</option></select></label>}<button className="account-link" disabled={busy} onClick={detect}>{busy ? 'Running detection…' : 'Run Detection'}</button>{!backendConnected && role === 'ADMIN' && <button className="account-link" onClick={() => { advanceSimulationClock(role); setMessage('Local simulation clock advanced by 61 seconds. Run Detection to evaluate the cutoff.'); }}>Advance Local Clock +61s</button>}<small>Simulation time: {timestamp(records.simulationNow || getSimulationNow())}</small></div>
    {message && <p className="payment-feedback" role="status">{message}</p>}{error && <p role="alert" className="movement-out">{error}</p>}
    {records.schemaReady === false && <p className="payment-feedback" role="status">Existing database records remain available. Database-backed generation and detection require the pending scenario migration.</p>}
    {generated && <section className="accounts-panel" aria-label="Generated payment results"><h2>Generated payments</h2>
      <p>{generated.attemptCount} attempts · {generated.postingCount} confirmed postings{!backendConnected && ' · Browser-only records'}</p>
      {generated.payments.map(p => <p key={p.id}><button className="account-link" onClick={() => open(p.id)}>{p.id}</button> · <StatusBadge status={p.status}/>
        {p.journalReference && <> · <a className="account-link" href={'/core-banking/journals?journal=' + encodeURIComponent(p.journalReference)}>{p.journalReference}</a></>}</p>)}
      <button className="simulation-button" disabled={busy} onClick={detect}>Run Detection</button></section>}
    <section className="accounts-panel" aria-labelledby="transaction-register-title"><div className="account-register-heading"><div><h2 id="transaction-register-title">Transaction register</h2><p>Search payments and inspect their processing history.</p></div><span className="record-count">{matching.length} transactions</span></div>
      <div className="account-filters enhanced-filters">
        <label className="account-search"><Search size={17}/><input aria-label="Search transactions" placeholder="Search transaction, customer or account…" value={filters.search} onChange={e => change('search', e.target.value)}/></label>
        <label><span className="filter-label">Processing Status</span><select aria-label="Filter payments by status" value={filters.status} onChange={e => change('status', e.target.value)}><option value="">All Statuses</option>{processingStatuses.map(status => <option key={status}>{status}</option>)}</select></label>
        <label><span className="filter-label">Currency</span><select aria-label="Filter payments by currency" value={filters.currency} onChange={e => change('currency', e.target.value)}><option value="">All Currencies</option>{[...new Set(records.payment_transactions.map(p => p.currency))].sort().map(value => <option key={value}>{value}</option>)}</select></label>
        <label><span className="filter-label">Date Range</span><select aria-label="Payment date range" value={filters.range} onChange={e => change('range', e.target.value)}>{[['', 'All Dates'], ['today', 'Today'], ['7days', 'Last 7 Days'], ['30days', 'Last 30 Days'], ['custom', 'Custom Range']].map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label>
        {filters.range === 'custom' && <><label><span className="filter-label">From</span><input aria-label="Payment date from" type="date" value={filters.from} max={filters.to || undefined} onChange={e => change('from', e.target.value)}/></label><label><span className="filter-label">To</span><input aria-label="Payment date to" type="date" value={filters.to} min={filters.from || undefined} onChange={e => change('to', e.target.value)}/></label></>}
        <label><span className="filter-label">Sort by</span><select aria-label="Sort transactions" value={filters.sort} onChange={e => change('sort', e.target.value)}>{[['newest', 'Newest First'], ['oldest', 'Oldest First'], ['amount-high', 'Amount High to Low'], ['amount-low', 'Amount Low to High'], ['status', 'Status']].map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label>
        <button className="account-link reset-filters" onClick={reset}>Reset Filters</button>
      </div>
      {filters.range === 'custom' && filters.from && filters.to && filters.from > filters.to && <p className="payment-feedback movement-out" role="alert">The start date must precede the end date.</p>}
      <div className="account-table-scroll" tabIndex={0} role="region" aria-label="Scrollable transaction register"><table className="account-table payment-table"><caption className="sr-only">Synthetic payment instructions and processing outcomes</caption><thead><tr>{['Transaction ID', 'Sender', 'Receiver', 'Amount', 'Status', 'Initiated At', 'Completed At', 'Actions'].map(label => <th key={label} scope="col" className={label === 'Amount' ? 'balance-cell' : undefined}>{label}</th>)}</tr></thead><tbody>{rows.map(p => <tr key={p.id}><td><button className="account-link" onClick={() => open(p.id)}>{p.id}</button></td><td>{party(p.senderId)}</td><td>{party(p.receiverId)}</td><td className="balance-cell">{money(p.amountCents, p.currency)}</td><td><StatusBadge status={p.status}/></td><td>{timestamp(p.createdAt)}</td><td>{timestamp(p.completedAt)}</td><td><button className="icon-button" aria-label={`View Details ${p.id}`} onClick={() => open(p.id)}><ChevronRight size={17}/></button></td></tr>)}</tbody></table></div>
      {!matching.length && <div className="account-empty"><Search size={25}/><h3>No transactions found</h3><p>Try another reference or adjust the combined filters.</p><button className="account-link" onClick={reset}>Clear filters</button></div>}
      <div className="account-table-footer" aria-live="polite"><span>Showing {matching.length ? (currentPage-1)*pageSize+1 : 0}–{Math.min(currentPage*pageSize, matching.length)} of {matching.length} matching transactions</span><nav className="payment-pagination" aria-label="Transaction pages"><button disabled={currentPage === 1} onClick={() => setPage(currentPage-1)}>Previous</button><span>Page {currentPage} of {pages}</span><button disabled={currentPage === pages} onClick={() => setPage(currentPage+1)}>Next</button></nav></div>
    </section>
    <TransactionDetailsDrawer key={params.get('transaction') || 'closed'} id={params.get('transaction')} onClose={close}/>
    {creating && <CreatePaymentForm open role={role} onClose={() => setCreating(false)} onCreated={p => { setCreating(false); setGenerated(p.payments ? p : null); setMessage(`${p.id} saved as ${p.status}.`); if (!p.payments) open(p.id); }}/>}
    {creatingBatch && <CreateExceptionBatchForm open
      onClose={() => setCreatingBatch(false)}
      onCreated={batch => {
        setCreatingBatch(false);
        setMessage(`${batch.created} exception payments generated automatically in batch ${batch.batchId}. Run detection when their reconciliation cutoffs are eligible.`);
      }}
    />}
  </>;
}
