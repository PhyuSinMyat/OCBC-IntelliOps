import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, CheckCircle2, Clock3, FileCheck2, LockKeyhole, ShieldCheck, TriangleAlert, XCircle } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { useBankingRecords } from '../../shared/data/bankingRecords.js';
import { displayTime, humanize } from './investigation/ReportSections.jsx';
import { listApprovalRequests, readApprovalRequest, submitApprovalDecision } from './resolution/approvalBackendService.js';
import './approval-center.css';

const root = '/intelliops/approvals';
const statuses = {
  PENDING_APPROVAL: ['Pending Review', 'pending', Clock3],
  APPROVED: ['Approved', 'approved', CheckCircle2],
  REJECTED: ['Rejected', 'rejected', XCircle],
};
const roleLabel = role => role === 'ADMIN' ? 'Administrator' : role === 'ANALYST' ? 'Analyst' : 'Role unavailable';

function Status({ status }) {
  const [label, tone, Icon] = statuses[status] || ['Unavailable', 'neutral', TriangleAlert];
  return <span className={`ac-status ac-${tone}`}><Icon size={15}/>{label}</span>;
}

function Queue({ requests }) {
  const [filter, setFilter] = useState('ALL');
  const [search, setSearch] = useState('');
  const counts = useMemo(() => requests.reduce((result, item) => ({ ...result, [item.status]: (result[item.status] || 0) + 1 }), {}), [requests]);
  const term = search.trim().toLowerCase();
  const visible = requests.filter(item => (filter === 'ALL' || item.status === filter) &&
    [item.caseId, item.requestId, item.exceptionType, item.proposedAction].some(value => value?.toLowerCase().includes(term)));
  return <>
    <div className="ac-kpis">{Object.entries(statuses).map(([code, [label, tone, Icon]]) =>
      <div className="ac-panel ac-kpi" key={code}><span className={`ac-kpi-icon ac-${tone}`}><Icon size={18}/></span><div><strong>{counts[code] || 0}</strong><span>{label}</span></div></div>)}</div>
    <section className="ac-panel"><div className="ac-panel-heading"><h2>Approval queue</h2>
      <input className="ac-filter-search" type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search case, reference or action"/></div>
      <div className="ac-filters">{['ALL', ...Object.keys(statuses)].map(code => <button key={code} type="button" aria-pressed={filter === code} onClick={() => setFilter(code)}>{code === 'ALL' ? 'All' : statuses[code][0]}</button>)}</div>
      {visible.length ? <table className="ac-table"><thead><tr><th>Case</th><th>Exception</th><th>Proposed action</th><th>Plan version</th><th>Submitted at</th><th>Status</th><th>Review</th></tr></thead>
        <tbody>{visible.map(item => <tr key={item.requestId}><td data-label="Case"><strong>{item.caseId}</strong></td><td data-label="Exception">{humanize(item.exceptionType)}</td>
          <td data-label="Proposed action">{item.proposedActionLabel || humanize(item.proposedAction)}</td><td data-label="Plan version">V{item.planVersion}</td><td data-label="Submitted at">{displayTime(item.submittedAt)}</td>
          <td data-label="Status"><Status status={item.status}/></td><td data-label="Review"><Link className="rp-inline" to={`${root}?request=${encodeURIComponent(item.requestId)}`}>Review<ArrowRight size={15}/></Link></td></tr>)}</tbody></table> :
        <div className="ac-empty"><FileCheck2 size={25}/><h3>{requests.length ? 'No records match your filters.' : 'No approval requests yet'}</h3><p>Current policy assessments submitted for Administrator review appear here.</p></div>}
    </section>
  </>;
}

function FinancialFigures({ metrics }) {
  if (!metrics?.length) return null;
  return <div className="ac-financial"><p>Financial figures from the submitted assessment</p>
    <dl className="ac-facts">{metrics.slice(0, 3).map(metric => <div className={metric.warning ? 'ac-excess-figure' : undefined} key={metric.label}>
      <dt>{metric.label}</dt><dd>{metric.value}</dd><small>{metric.source}</small>
    </div>)}</dl>
  </div>;
}

function CustomerContext({ context, plan }) {
  if (!context) return <section><h2>Customer context</h2><p>Customer communication context is unavailable.</p></section>;
  const included = context.responses.filter(response => response.includedInPlan).length;
  const latest = context.responses.at(-1);
  return <section aria-labelledby="ac-customer-context"><h2 id="ac-customer-context">Customer context</h2>
    <p>{context.notificationCount ? 'Email notification delivered' : 'No delivered notification recorded'} · {context.responseCount ? `${context.responseCount} customer ${context.responseCount === 1 ? 'reply' : 'replies'} recorded` : 'No customer reply recorded'}</p>
    <p>{included} customer {included === 1 ? 'reply is' : 'replies are'} included in submitted plan V{plan?.version}.</p>
    {latest && <div className="ac-reply"><strong>Customer email reply</strong>
      <p><time dateTime={latest.receivedAt}>{displayTime(latest.receivedAt)}</time> · Backend email</p>
      <p>{latest.includedInPlan ? 'Latest reply included in submitted plan' : 'Latest reply is not included in submitted plan'}</p>
      {latest.subject && <p><strong>Subject:</strong> {latest.subject}</p>}
      <p className="ac-reply-preview">{latest.body}</p>
      <details><summary>View full customer reply</summary><p className="ac-message">{latest.body}</p></details>
    </div>}
  </section>;
}

function Review({ request, role, onUpdated }) {
  const dialog = useRef(null);
  const [choice, setChoice] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const source = '?' + new URLSearchParams({ case: request.caseId, investigation: request.investigationId, plan: request.planId, version: String(request.planVersion) }).toString();
  const pending = request.status === 'PENDING_APPROVAL';
  function openDecision(decision) {
    setChoice(decision); setReason(''); setError('');
    dialog.current?.showModal();
  }
  async function decide(event) {
    event.preventDefault(); setError('');
    if (reason.trim().length < 12) { setError('Enter a decision reason of at least 12 characters.'); return; }
    setBusy(true);
    try {
      onUpdated(await submitApprovalDecision(request.requestId, choice, reason));
      dialog.current?.close(); setChoice(''); setReason('');
    }
    catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }
  return <>
    <Link className="rp-inline" to={root}><ArrowLeft size={16}/>Back to approval queue</Link>
    <section className="ac-panel ac-overview"><div className="ac-panel-heading"><h2>Decision Overview</h2><Status status={request.status}/></div>
      <dl className="ac-facts"><div><dt>Case</dt><dd>{request.caseId}</dd></div><div><dt>Exception type</dt><dd>{humanize(request.exceptionType)}</dd></div>
        <div><dt>Submitted plan</dt><dd>V{request.planVersion}</dd></div>
        <div><dt>Proposed action</dt><dd>{request.proposedActionLabel || humanize(request.proposedAction)}</dd></div><div><dt>Submitted at</dt><dd>{displayTime(request.submittedAt)}</dd></div></dl>
      <FinancialFigures metrics={request.financialMetrics}/>
      <details className="ac-references"><summary>Technical references</summary><dl className="ac-facts"><div><dt>Request</dt><dd><code>{request.requestId}</code></dd></div><div><dt>Assessment</dt><dd><code>{request.assessmentId}</code></dd></div><div><dt>Customer snapshot</dt><dd><code>{request.customerSnapshotReference}</code></dd></div></dl></details>
    </section>
    <div className="ac-review-grid"><section className="ac-panel ac-context-panel"><section><h2>AI Resolution Recommendation</h2><h3>{request.plan?.resolutionTitle}</h3><p>{request.plan?.summary}</p>
      <div className="rp-actions ac-panel-links"><Link className="rp-inline" to={`/intelliops/workflows/plans${source}`}>View submitted resolution plan</Link><Link className="rp-inline" to={`/intelliops/investigation${source}`}>View investigation</Link></div></section>
      <CustomerContext context={request.customerContext} plan={request.plan}/>
      <section><h2>Policy Assessment</h2><p><strong>{humanize(request.assessment?.status)}</strong> · Administrator review</p>
        <ul className="ac-checks">{request.assessment?.controls.map(control => <li key={control.id}><strong>{control.name}</strong><span>{humanize(control.status)}</span><p>{control.reason}</p></li>)}</ul>
        <Link className="rp-inline ac-panel-links" to={`/intelliops/workflows/policy${source}`}>View Policy Assessment</Link></section></section>
      <section className="ac-panel ac-decision" data-status={request.status}><div className="ac-panel-heading"><h2>{pending ? 'Administrator Decision' : 'Decision Receipt'}</h2><Status status={request.status}/></div>
        {pending ? role !== 'ADMIN' ? <p>Awaiting Administrator review. Your current role is read-only.</p> : <><dl className="ac-decision-facts"><div><dt>Required approver</dt><dd>{request.requiredApproverRole}</dd></div><div><dt>Review eligibility</dt><dd>Eligible for review</dd></div></dl><div className="rp-actions ac-panel-links"><button className="rp-button ac-approve" onClick={() => openDecision('APPROVED')}>Approve</button><button className="rp-button ac-reject" onClick={() => openDecision('REJECTED')}>Decline</button></div>
          <p className="ac-decision-safety"><LockKeyhole size={15}/>The backend revalidates policy, evidence, plan currency, and customer context. No financial action is executed here.</p></> :
          <div className="ac-receipt"><dl className="ac-decision-facts"><div><dt>Acting role</dt><dd>{request.decision?.actingRole}</dd></div><div><dt>Recorded at</dt><dd>{displayTime(request.decision?.decidedAt)}</dd></div></dl><div className="ac-receipt-reason"><strong>Decision reason</strong><p>{request.decision?.reason}</p></div><p>No financial correction has been executed.</p></div>}
      </section></div>
    <dialog ref={dialog} className="ac-dialog" aria-labelledby="ac-confirm-title" onCancel={event => { if (busy) event.preventDefault(); else setChoice(''); }}>
      <form onSubmit={decide} noValidate><h2 id="ac-confirm-title">Confirm {choice === 'APPROVED' ? 'approval' : 'decline'}</h2>
        <p className="ac-dialog-context"><strong>{request.caseId} · V{request.planVersion}</strong><br/>{request.proposedActionLabel || humanize(request.proposedAction)}</p>
        <p>This records a durable Administrator decision for the next controlled workflow step.</p>
        <label htmlFor="modal-approval-reason">Decision reason<textarea id="modal-approval-reason" autoFocus rows="4" maxLength="1000" value={reason} onChange={event => setReason(event.target.value)} disabled={busy} aria-invalid={Boolean(error)}/></label>
        <small>Use at least 12 characters to explain the decision.</small>{error && <p className="ac-warning" role="alert">{error}</p>}
        <div className="rp-actions"><button className="rp-button" type="button" disabled={busy} onClick={() => { dialog.current?.close(); setChoice(''); }}>Cancel</button>
          <button className={`rp-button ${choice === 'APPROVED' ? 'ac-approve' : 'ac-reject'}`} disabled={busy}>{busy ? 'Revalidating…' : `Confirm ${choice === 'APPROVED' ? 'Approval' : 'Decline'}`}</button></div>
      </form>
    </dialog>
  </>;
}

export default function ApprovalCenterBackend() {
  const [params] = useSearchParams();
  const { role } = useBankingRecords();
  const requestId = params.get('request');
  const [requests, setRequests] = useState([]);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => { const controller = new AbortController(); setLoading(true); setError('');
    (requestId ? readApprovalRequest(requestId, { signal: controller.signal }) : listApprovalRequests({ signal: controller.signal }))
      .then(result => requestId ? setSelected(result) : setRequests(result)).catch(failure => { if (failure.name !== 'AbortError') setError(failure.message); }).finally(() => setLoading(false));
    return () => controller.abort(); }, [requestId]);
  return <div className="rp-workspace ac-workspace"><header className="ac-header"><div className="page-heading"><p className="eyebrow">Resolution Workspace</p><h1>Approval Center</h1><p>Review durable backend approval requests for AI-assisted resolution proposals.</p></div><span className="rp-badge"><ShieldCheck size={15}/>{roleLabel(role)}</span></header>
    <p className="ac-demo"><ShieldCheck size={17}/>Backend persisted workflow · Decisions are audited and revalidated against current evidence.</p>
    {loading ? <section className="ac-panel"><p role="status">Loading approval records…</p></section> : error ? <section className="ac-panel ac-empty"><TriangleAlert size={24}/><h2>Approval workflow unavailable</h2><p role="alert">{error}</p></section> : requestId ? selected ? <Review request={selected} role={role} onUpdated={setSelected}/> : null : <Queue requests={requests}/>}</div>;
}
