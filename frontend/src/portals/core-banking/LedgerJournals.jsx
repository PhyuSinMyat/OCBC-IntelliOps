import React, { Fragment, useMemo, useState } from 'react';
import { FilterReset, FilterSearch, FilterSelect } from '../../shared/components/FilterControls.jsx';
import TablePagination, { useTablePagination } from '../../shared/components/TablePagination.jsx';
import { Link, useSearchParams } from 'react-router-dom';
import { ChevronDown, ChevronRight, ShieldCheck } from 'lucide-react';
import { ReferenceText, TableBadge, TableHeading } from '../../shared/components/TablePresentation.jsx';
import RecordDrawer from '../../shared/components/RecordDrawer';
import { backendConnected, postingTime, refreshBackend, useBankingRecords } from '../../shared/data/bankingRecords.js';
import { filterJournals, journalMoney, journalRows } from './journalRows.js';
import './ledgerJournals.css';

function Party({ parties }) {
  return parties.length ? parties.map(party => <div className="journal-party" key={party.id}><strong>{party.name}</strong><small>{party.id}</small></div>) : <span className="unavailable-record">Unavailable</span>;
}

function PaymentLink({ row, children }) {
  return row.paymentAvailable ? <Link className="account-link" to={'/payments/transactions?transaction=' + encodeURIComponent(row.paymentReference)}>{children || <ReferenceText value={row.paymentReference}/>}</Link>
    : <span className="unavailable-record">{row.paymentReference || 'Payment unavailable'}</span>;
}

function Entries({ row, drawer = false }) {
  return <section className="journal-entry-section" aria-label={'Journal Entries for ' + row.id}>
    <div className="journal-entry-heading"><h3>Journal Entries</h3><span className={'journal-validation ' + (row.balanced ? 'is-balanced' : 'needs-review')}>{row.validation}{drawer && row.balanced ? ' · Included in account balances' : ''}</span></div>
    {row.entries.length ? <div className="journal-entry-scroll" tabIndex={0} role="region" aria-label="Scrollable journal entries"><table className="account-table journal-entry-table">
      <caption className="sr-only">Persisted entries for {row.id}</caption>
      <thead><tr>{['Entry Reference', 'Account Reference', 'Account Holder', 'Entry Type', 'Debit Amount', 'Credit Amount'].map(title => <th scope="col" key={title}>{title}</th>)}</tr></thead>
      <tbody>{row.entries.map(entry => <tr key={entry.id}><td>{entry.id}</td><td>{entry.accountId}</td><td>{entry.account?.customer || 'Account holder unavailable'}</td><td>{entry.side}</td><td className="journal-amount">{entry.side === 'Debit' ? journalMoney(entry.amountCents, entry.currency) : '—'}</td><td className="journal-amount">{entry.side === 'Credit' ? journalMoney(entry.amountCents, entry.currency) : '—'}</td></tr>)}</tbody>
      <tfoot><tr><th scope="row" colSpan={4}>Totals</th><td className="journal-amount"><span>Total Debit</span><strong>{journalMoney(row.debit, row.currency)}</strong></td><td className="journal-amount"><span>Total Credit</span><strong>{journalMoney(row.credit, row.currency)}</strong></td></tr></tfoot>
    </table></div> : <p className="account-empty">No persisted entries are available for this journal.</p>}
    <p className="history-caption">Deposit accounts: debit = money out; credit = money in. Only valid posted journals contribute to account balances.</p>
  </section>;
}

export default function LedgerJournals() {
  const snapshot = useBankingRecords();
  const [params, setParams] = useSearchParams();
  const [expanded, setExpanded] = useState(() => new Set());
  const [filters, setFilters] = useState({ query: '', status: '', sort: 'newest' });
  const [refreshing, setRefreshing] = useState(false);
  const connected = backendConnected && snapshot.dataSource === 'backend';
  const journals = useMemo(() => connected ? journalRows(snapshot) : [], [snapshot, connected]);
  const rows = useMemo(() => filterJournals(journals, filters), [journals, filters]);
  const pagination = useTablePagination(rows.length);
  const selectedId = params.get('journal');
  const selected = journals.find(row => row.id === selectedId);
  const change = (key, value) => {
    setFilters(previous => ({ ...previous, [key]: value }));
    if (key !== 'sort') pagination.resetPage();
  };
  const reset = () => { setFilters({ query: '', status: '', sort: 'newest' }); pagination.resetPage(); };
  const toggle = id => setExpanded(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const close = () => { const next = new URLSearchParams(params); next.delete('journal'); setParams(next, { replace: true }); };
  async function refresh() { setRefreshing(true); try { await refreshBackend({ fresh: true }); } catch { /* Shared store exposes API errors. */ } finally { setRefreshing(false); } }
  const loading = refreshing || snapshot.connectionState === 'loading';
  return <>
    <div className="page-heading"><p className="eyebrow">Core banking / ledger</p><h1>Ledger Journals</h1><p>Review persisted journals and their underlying accounting entries.</p></div>
    <p className="account-demo"><ShieldCheck size={15}/>Read-only FastAPI records. Posting times are shown in Singapore Time (SGT).</p>
    {!connected ? <section className="account-empty" role="alert"><h3>Backend connection required</h3><p>Connect to FastAPI to view persisted journals. Browser-only financial records are not displayed here.</p></section> : <>
      {snapshot.connectionError && <p role="alert" className="journal-error">Unable to refresh journals: {snapshot.connectionError} Previously retrieved backend records remain visible.</p>}
      <section className="accounts-panel" aria-labelledby="journal-register-title" aria-busy={loading}>
        <div className="account-register-heading"><div><h2 id="journal-register-title">Journal register</h2><p>Expand a journal to review its persisted debit and credit entries.</p></div><button className="account-link" onClick={refresh} disabled={refreshing}>{refreshing ? 'Refreshing journals…' : 'Refresh journals'}</button></div>
        <div className="account-filters enhanced-filters">
          <FilterSearch aria-label="Search journals" placeholder="Search journal, payment, sender or receiver…" value={filters.query} onChange={event => change('query', event.target.value)}/>
          <label><span className="filter-label">Status</span><FilterSelect active={Boolean(filters.status)} aria-label="Filter journals by status" value={filters.status} onChange={event => change('status', event.target.value)}><option value="">All statuses</option>{[...new Set(journals.map(row => row.status))].sort().map(status => <option key={status}>{status}</option>)}</FilterSelect></label>
          <label><span className="filter-label">Sort by</span><FilterSelect active={filters.sort !== 'newest'} aria-label="Sort journals" value={filters.sort} onChange={event => change('sort', event.target.value)}><option value="newest">Newest posting</option><option value="oldest">Oldest posting</option><option value="reference">Journal reference</option></FilterSelect></label>
          <FilterReset disabled={!filters.query && !filters.status && filters.sort === 'newest'} onClick={reset}>Reset filters</FilterReset>
        </div>
        {loading && <p role="status" className="journal-loading">Loading journals from FastAPI…</p>}
        <div className="account-table-scroll journal-register-scroll" tabIndex={0} role="region" aria-label="Scrollable journal register"><table className="account-table enterprise-register journal-register">
          <caption className="sr-only">Persisted ledger journals with independently expandable entries</caption>
          <thead><tr>{['', 'Journal Reference', 'Linked Payment', 'Sender', 'Receiver', 'Total Debit', 'Total Credit', 'Status', 'Posted At (SGT)'].map((title, index) => <TableHeading key={index} direction={
            index === 1 && filters.sort === 'reference' ? 'ascending' :
            index === 8 && filters.sort !== 'reference' ? (filters.sort === 'oldest' ? 'ascending' : 'descending') : undefined
          }>{title || <span className="sr-only">Expand entries</span>}</TableHeading>)}</tr></thead>
          <tbody>{rows.slice(pagination.start, pagination.end).map(row => { const open = expanded.has(row.id); const sectionId = 'journal-entries-' + row.id; return <Fragment key={row.id}>
            <tr data-journal-id={row.id} data-selected={selectedId === row.id || undefined} className={open ? 'journal-parent is-expanded' : 'journal-parent'}>
              <td><button className="icon-button journal-expand" aria-label={(open ? 'Collapse ' : 'Expand ') + row.id} aria-expanded={open} aria-controls={open ? sectionId : undefined} onClick={() => toggle(row.id)}>{open ? <ChevronDown size={17}/> : <ChevronRight size={17}/>}</button></td>
              <td><button className="account-link" onClick={() => { const next = new URLSearchParams(params); next.set('journal', row.id); setParams(next); }}><ReferenceText value={row.id}/></button></td><td><PaymentLink row={row}/></td>
              <td><Party parties={row.senders}/></td><td><Party parties={row.receivers}/></td>
              <td className="journal-amount">{journalMoney(row.debit, row.currency)}</td><td className="journal-amount">{journalMoney(row.credit, row.currency)}</td>
              <td><TableBadge value={row.status}/></td>
              <td className="table-secondary register-timestamp">{Number.isFinite(Date.parse(row.postedAt)) ? <time dateTime={row.postedAt}>{postingTime(row.postedAt)}</time> : 'Not posted'}</td>
            </tr>
            {open && <tr className="journal-expanded"><td colSpan={9}><div id={sectionId}><Entries row={row}/></div></td></tr>}
          </Fragment>; })}</tbody>
        </table></div>
        {!rows.length && !loading && <div className="account-empty"><h3>{journals.length ? 'No journals match your filters' : 'No ledger journals yet'}</h3><p>{journals.length ? 'No records match your filters.' : 'No persisted journals were returned by FastAPI.'}</p></div>}
        <TablePagination pagination={pagination} label="Journal pages" recordLabel="journals"/>
      </section>
      <RecordDrawer open={!!selectedId} title={selected?.id || 'Record unavailable'} onClose={close}>
        {selected ? <><section className="account-balance" aria-label="Journal posting summary"><span>Ledger journal</span><strong>{selected.id}</strong><span>{selected.status}</span><small>{selected.currency} / {selected.entries.length} accounting entries</small></section><p><PaymentLink row={selected}>Open Payment Transaction</PaymentLink></p><Entries row={selected} drawer/></> : <p>This record is unavailable in the backend snapshot.</p>}
      </RecordDrawer>
    </>}
  </>;
}
