import React, { useEffect, useState } from 'react';
import { FilterReset, FilterSearch, FilterSelect } from '../../shared/components/FilterControls.jsx';
import CaseStatus, { canonicalCaseStatus, caseStatuses, caseStatusLabel } from '../../shared/components/CaseStatus.jsx';
import TablePagination, { useTablePagination } from '../../shared/components/TablePagination.jsx';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, Clock3, Files, LoaderCircle, ScanSearch, Workflow } from 'lucide-react';
import { TableBadge } from '../../shared/components/TablePresentation.jsx';
import ExceptionDetailsDrawer from './ExceptionDetailsDrawer.jsx';
import { exceptionRequest } from '../../shared/api/banking.js';
import { backendConnected, fetchExceptionCase, postingTime, runPaymentDetection, useBankingRecords } from '../../shared/data/bankingRecords.js';
import './exception-center.css';

const filterFields = [['exceptionType', 'Exception type'], ['severity', 'Severity'], ['status', 'Status']];
const severityLevels = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
const detectionTime = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  hourCycle: 'h23', timeZone: 'Asia/Singapore',
});

function transactionReferences(record) {
  const { transactionId, relatedTransactionId } = record;
  const references = record.evidence?.originalReference === relatedTransactionId
    ? [relatedTransactionId, transactionId]
    : [transactionId, relatedTransactionId];
  return [...new Set(references.filter(Boolean))];
}

function OperationalSummary({ cases, loading }) {
  const counts = { priority: 0, progress: 0, pending: 0 };
  for (const record of cases) {
    const status = canonicalCaseStatus(record.status);
    if (['HIGH', 'CRITICAL'].includes(record.severity) && !['RESOLVED', 'CLOSED'].includes(status)) counts.priority++;
    if (status === 'IN_PROGRESS') counts.progress++;
    if (status === 'PENDING_APPROVAL') counts.pending++;
  }
  const metrics = [
    ['Total Exceptions', cases.length, 'All registered cases', Files, 'neutral'],
    ['High Priority', counts.priority, 'High or critical, excluding resolved and closed', AlertTriangle, 'priority'],
    ['In Progress', counts.progress, 'Cases under review', Workflow, 'progress'],
    ['Pending Approval', counts.pending, 'Awaiting a decision', Clock3, 'pending'],
  ];
  return <dl className="exception-summary" aria-label="Operational summary" aria-busy={loading}>
    {metrics.map(([label, count, description, Icon, tone]) => <div className="exception-metric" key={label}>
      <dt>{label}<span className={`exception-metric-icon exception-metric-${tone}`}><Icon size={17} aria-hidden="true"/></span></dt>
      <dd><strong>{loading ? '—' : count.toLocaleString('en-SG')}</strong><small>{description}</small></dd>
    </div>)}
  </dl>;
}

function AutomaticDetectionStatus({ scanning }) {
  const [status, setStatus] = useState(null);
  useEffect(() => {
    if (!backendConnected || scanning) return;
    const controller = new AbortController();
    const refresh = () => exceptionRequest('/api/detection/status', {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
    }).then(value => { if (!controller.signal.aborted) setStatus(value); })
      .catch(() => { if (!controller.signal.aborted) setStatus({ state: 'UNAVAILABLE' }); });
    refresh();
    const timer = setInterval(refresh, 30000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [scanning]);
  const state = backendConnected ? status?.state : 'UNAVAILABLE';
  const labels = {
    ENABLED: 'Automatic detection enabled after payment',
    DEGRADED: 'Automatic detection degraded',
    UNAVAILABLE: 'Automatic detection unavailable',
  };
  const lastScan = status?.lastSuccessfulScan;
  return <div className="exception-auto-detection" data-state={state}>
    <span className="exception-auto-dot" aria-hidden="true"/>
    <span>{labels[state] || 'Checking automatic detection'}</span>
    {Number.isFinite(Date.parse(lastScan)) && <span>Last automatic payment scan <time dateTime={lastScan} title={lastScan}>
      {detectionTime.format(new Date(lastScan))} SGT
    </time></span>}
  </div>;
}

export default function ExceptionRecords({ investigation = false, audit = false }) {
  const records = useBankingRecords();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const [busy, setBusy] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [detectionResult, setDetectionResult] = useState(null);
  const [detail, setDetail] = useState(null);
  const cases = records.exception_cases || [];
  const [filters, setFilters] = useState({});
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('newest');
  const term = search.trim().toLowerCase();
  const hasFilters = Boolean(term) || Object.values(filters).some(Boolean);
  const matches = audit ? (records.audit_events || []) : cases.filter(record =>
    filterFields.every(([key]) => !filters[key] || filters[key] === (key === 'status' ? canonicalCaseStatus(record[key]) : record[key])) &&
    (!term || [record.id, record.transactionId, record.relatedTransactionId, record.exceptionType]
      .some(value => value?.toLowerCase().includes(term))));
  if (!audit && sort) {
    matches.sort((a, b) => (sort === 'oldest' ? 1 : -1) * (Date.parse(a.createdAt) - Date.parse(b.createdAt)));
  }
  const pagination = useTablePagination(matches.length, audit ? 20 : 10);
  const pageRows = matches.slice(pagination.start, pagination.end);
  const clearFilters = () => { setFilters({}); setSearch(''); pagination.resetPage(); };
  const caseId = params.get('case');
  const summary = cases.find(c => c.id === caseId);
  const detailResult = detail?.id === caseId ? detail : null;
  const selected = detailResult?.record || summary;
  const title = audit ? 'Audit Trail' : investigation ? 'AI Investigation' : 'Exception Center';

  useEffect(() => {
    setDetail(null);
    if (!caseId) return;
    const controller = new AbortController();
    fetchExceptionCase(caseId, { signal: controller.signal })
      .then(record => { if (!controller.signal.aborted) setDetail({ id: caseId, record }); })
      .catch(() => { if (!controller.signal.aborted) setDetail({ id: caseId, error: true }); });
    return () => controller.abort();
  }, [caseId]);

  async function detect() {
    setBusy(true); setDetecting(true); setDetectionResult(null);
    try {
      const count = await runPaymentDetection(backendConnected ? records.role : sessionStorage.getItem('payment-demo-role') || 'ANALYST');
      const message = count === 0 ? 'No new exceptions found.' : Number.isSafeInteger(count) && count > 0
        ? `${count} new ${count === 1 ? 'exception' : 'exceptions'} detected. The register has been refreshed.`
        : 'The exception register has been refreshed.';
      setDetectionResult({ message });
    } catch (error) {
      const message = [401, 403].includes(error.status) ? 'Check your demo session and permissions.' :
        error.status === 409 ? 'The source records changed. Refresh the page before retrying.' :
          'Check the connection and try again.';
      setDetectionResult({ message, failed: true });
    } finally { setBusy(false); setDetecting(false); }
  }

  const loading = backendConnected && records.connectionState === 'loading';
  return <div className={!audit ? 'exception-workspace' : undefined}>
    <header className="exception-heading">
      <div>
        <p className="exception-kicker">Intelligent Operations / Case Management</p>
        <h1>{title}</h1>
        <p className="exception-description">{audit ? 'Recorded simulation and detection actions.' : 'Monitor, prioritize and investigate payment exceptions.'}</p>
      </div>
      {!audit && <button className="simulation-button exception-detect" type="button" disabled={busy} onClick={detect}>
        {detecting ? <LoaderCircle className="exception-spinner" size={17} aria-hidden="true"/> : <ScanSearch size={17} aria-hidden="true"/>}
        {detecting ? 'Scanning…' : 'Scan Now'}
      </button>}
      {!audit && <AutomaticDetectionStatus scanning={detecting}/>}
    </header>
    {!audit && <OperationalSummary cases={cases} loading={loading}/>}
    {detecting && <span className="sr-only" role="status">Scanning for exceptions…</span>}
    {detectionResult && <div className={`exception-feedback${detectionResult.failed ? ' is-error' : ''}`} role={detectionResult.failed ? 'alert' : 'status'}>
      {detectionResult.failed ? <AlertTriangle size={17} aria-hidden="true"/> : <CheckCircle2 size={17} aria-hidden="true"/>}
      <div><strong>{detectionResult.failed ? 'Detection scan failed' : 'Scan completed'}</strong><p>{detectionResult.message}</p></div>
    </div>}
    <section className="accounts-panel exception-register-panel" aria-labelledby={!audit ? 'exception-register-title' : undefined} aria-busy={loading}>
      {!audit && <div className="exception-register-heading">
        <div><h2 id="exception-register-title">Exception Register</h2><p>Review and manage detected operational exceptions.</p></div>
        {!loading && <span className="record-count">{matches.length.toLocaleString('en-SG')} {hasFilters ? 'matching ' : ''}{matches.length === 1 ? 'case' : 'cases'}</span>}
      </div>}
      {!audit && cases.length > 0 && <div className="account-filters enhanced-filters">
        <FilterSearch aria-label="Search exceptions" placeholder="Search case, transaction or type"
          value={search} onChange={event => { setSearch(event.target.value); pagination.resetPage(); }}/>
        {filterFields.map(([key, label]) => <label key={key}><span className="filter-label">{label}</span>
          <FilterSelect active={Boolean(filters[key])} aria-label={label} value={filters[key] || ''} onChange={event => {
            const value = event.target.value;
            setFilters(previous => ({ ...previous, [key]: value }));
            pagination.resetPage();
          }}>
            <option value="">All</option>
            {(key === 'severity' ? severityLevels : key === 'status' ? [...new Set([...caseStatuses, ...cases.map(record => canonicalCaseStatus(record.status)).filter(Boolean)])] : [...new Set(cases.map(record => record[key]).filter(Boolean))].sort())
              .map(value => <option key={value} value={value}>{key === 'status' ? caseStatusLabel(value) : value}</option>)}
          </FilterSelect>
        </label>)}
        <label><span className="filter-label">Sort by</span><FilterSelect active={sort !== 'newest'} aria-label="Sort exceptions" value={sort} onChange={event => setSort(event.target.value)}>
          <option value="newest">Newest detected</option><option value="oldest">Oldest detected</option>
        </FilterSelect></label>
        <FilterReset disabled={!hasFilters} onClick={clearFilters}>Clear filters</FilterReset>
      </div>}
      <div className="account-table-scroll" tabIndex={0} role="region" aria-label={audit ? 'Scrollable audit records' : 'Scrollable exception register'}>
        <table className={audit ? 'account-table' : 'account-table enterprise-register exception-register'}>
          <thead><tr>{(audit ? ['Reference', 'Action', 'Actor', 'Occurred At (SGT)'] : ['Case Reference', 'Transaction', 'Exception Type', 'Severity', 'Status', 'Detected At']).map(text =>
            <th scope="col" key={text} aria-sort={text === 'Detected At' ? (sort === 'oldest' ? 'ascending' : 'descending') : undefined}>{text}</th>)}</tr></thead>
          <tbody>{audit ? pageRows.map(e =>
            <tr key={e.id}><td>{e.reference}</td><td>{e.action}</td><td>{e.actor}</td><td>{postingTime(e.createdAt)}</td></tr>
          ) : pageRows.map(c => <tr key={c.id} data-selected={params.get('case') === c.id || undefined}>
            <td><button className="account-link register-primary" onClick={() => {
              const next = new URLSearchParams(params);
              next.set('case', c.id);
              setParams(next);
            }}>{c.id}</button></td>
            <td>
              <div className="exception-transaction-references">
                {transactionReferences(c).map(reference => <Link key={reference} className="account-link"
                  to={'/payments/transactions?transaction=' + encodeURIComponent(reference)}>{reference}</Link>)}
              </div>
            </td>
            <td className="register-secondary">{c.exceptionType}</td>
            <td><TableBadge value={c.severity}/></td>
            <td><CaseStatus value={c.status}/></td>
            <td className="exception-detected-at">{Number.isFinite(Date.parse(c.createdAt))
              ? <time dateTime={c.createdAt} title={new Date(c.createdAt).toISOString()} aria-label={detectionTime.format(new Date(c.createdAt)) + ' Singapore time'}>
                {detectionTime.format(new Date(c.createdAt))}
              </time> : 'Unavailable'}</td>
          </tr>)}</tbody>
        </table>
      </div>
      {loading ? <p className="account-empty" role="status">Loading exceptions…</p> : !matches.length && <div className="account-empty"><h3>{audit ? 'No audit events yet' : hasFilters ? 'No records match your filters.' : 'No detected exceptions'}</h3><p>{hasFilters ? 'Clear filters to see all available cases.' : audit ? 'Simulation actions and detection runs will appear here.' : 'Create source scenarios in Payment Processing, wait for the matching cutoff, then run detection.'}</p></div>}
      <TablePagination pagination={pagination} label={audit ? "Audit record pages" : "Exception pages"} recordLabel={audit ? "events" : "cases"}/>
    </section>
    {!audit && caseId && <ExceptionDetailsDrawer key={caseId} caseId={caseId} record={selected} records={records}
      detailLoading={!detailResult} detailError={detailResult?.error} busy={busy} setBusy={setBusy}
      onUpdate={record => setDetail({ id: caseId, record })}
      onClose={() => {
        if (busy) return;
        const next = new URLSearchParams(params);
        next.delete('case');
        setParams(next, { replace: true });
      }}
      from={location.pathname + location.search} investigation={investigation}/>}
  </div>;
}
