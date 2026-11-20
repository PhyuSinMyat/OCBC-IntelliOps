import React, { useEffect, useRef, useState } from 'react';
import { FilterReset, FilterSearch } from '../../shared/components/FilterControls.jsx';
import CaseStatus from '../../shared/components/CaseStatus.jsx';
import TablePagination, { useTablePagination } from '../../shared/components/TablePagination.jsx';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, CheckCircle2, Clock3, Copy, FileCheck2, LockKeyhole, ShieldCheck, TriangleAlert, XCircle } from 'lucide-react';
import { backendConnected, useBankingRecords } from '../../shared/data/bankingRecords.js';
import { displayTime, humanize } from './investigation/ReportSections.jsx';
import { approvalBlock, approvalContext, approvalRequestSearch, getApprovalRequest, listApprovalRequests, recordApprovalDecision, validDecisionReason } from './resolution/approvalDemoService.js';
import { resolutionCustomerResponses, resolutionIncidentNotifications, responseTypes } from './resolution/communicationService.js';
import { assessmentApplies, evaluatePolicy, getPolicyActivity, policyActionLabel, resolvePolicyContext } from './resolution/policyDemoService.js';
import { readResolutionCase } from './resolution/resolutionData.js';
import { pendingResolutionResponses } from './resolution/resolutionPlannerService.js';
import { approvalWalkthroughEvidence } from './resolution/approvalWalkthrough.jsx';
import './approval-center.css';

const root = '/intelliops/approvals';
const workflow = '/intelliops/workflows';
const statuses = {
  PENDING_APPROVAL: ['Pending Review', 'pending', Clock3],
  APPROVED: ['Approved', 'approved', CheckCircle2],
  REJECTED: ['Rejected', 'rejected', XCircle],
};
const statusLabel = status => statuses[status]?.[0] || 'Unavailable';
const roleLabel = role => role === 'ADMIN' ? 'Administrator' : role === 'ANALYST' ? 'Analyst' : 'Role unavailable';
const actionLabel = request => request.proposedAction ? policyActionLabel({ recommendedActionCode: request.proposedAction }) : 'Unavailable';
const duplicateExcess = 'Apparent duplicate excess';
const planVersion = request => request.planVersion == null ? 'Unavailable' : `V${request.planVersion}`;
const caseLabel = caseId => !caseId ? 'Case unavailable' : caseId.startsWith('DEMO-APPROVAL-CASE-') ? `Walkthrough · ${caseId.slice(-8)}` :
  caseId.length > 24 ? `${caseId.slice(0, 12)}…${caseId.slice(-7)}` : caseId;

function CopyReference({ label, value }) {
  const [feedback, setFeedback] = useState('');
  if (!value) return null;
  return <span className="ac-copy-reference">
    <button className="ac-copy" type="button" title={`Copy ${label}`} aria-label={`Copy ${label}`} onClick={async () => {
      try { await navigator.clipboard.writeText(value); setFeedback('Copied'); }
      catch { setFeedback('Clipboard unavailable'); }
    }}><Copy size={14} aria-hidden="true"/></button>
    {feedback && <small role="status">{feedback}</small>}
  </span>;
}

function Status({ status }) {
  const [label, tone, Icon] = statuses[status] || ['Unavailable', 'neutral', TriangleAlert];
  return <span className={`ac-status ac-${tone}`}><Icon size={15} aria-hidden="true"/>{label}</span>;
}

function Header({ role, demoRole, onRoleChange, walkthrough }) {
  return <header className="ac-header">
    <div className="page-heading">
      <nav className="ac-breadcrumb" aria-label="Breadcrumb"><Link to={workflow}>Resolution Workspace</Link><span aria-hidden="true">/</span><Link to={root}>Approval Center</Link></nav>
      <h1>Approval Center</h1><p>Review and authorize AI-assisted resolution proposals in the simulated workflow.</p>
    </div>
    {backendConnected && !walkthrough ? <span className="rp-badge"><ShieldCheck size={15} aria-hidden="true"/>{roleLabel(role)}</span> :
      <label className="ac-role">{walkthrough ? 'Walkthrough role' : 'Local demo role'}<select value={demoRole} onChange={event => onRoleChange(event.target.value)}>
        <option value="ANALYST">Analyst</option><option value="ADMIN">Administrator</option>
      </select></label>}
  </header>;
}

function Queue({ requests, cases }) {
  const [filter, setFilter] = useState('ALL');
  const [search, setSearch] = useState('');
  const term = search.trim().toLowerCase();
  const counts = {};
  for (const request of requests) counts[request.status] = (counts[request.status] || 0) + 1;
  const titles = new Map(cases.map(record => [record.id, record.exceptionType]));
  const titleFor = request => approvalWalkthroughEvidence(request.caseId, request.investigationId)?.record.exceptionType ||
    titles.get(request.caseId) || request.plan?.resolutionTitle || 'Exception title unavailable';
  const visible = requests.filter(request => (filter === 'ALL' || filter === request.status) &&
    [request.caseId, request.requestId, request.planId, request.assessmentId, titleFor(request), actionLabel(request)].some(value => value?.toLowerCase().includes(term)))
    .sort((a, b) => Number(b.status === 'PENDING_APPROVAL') - Number(a.status === 'PENDING_APPROVAL') ||
      Date.parse(b.submittedAt) - Date.parse(a.submittedAt));
  const pagination = useTablePagination(visible.length);
  return <>
    <div className="ac-kpis" aria-label="Approval counts">{Object.entries(statuses).map(([value, [label, tone, Icon]]) =>
      <div className="ac-panel ac-kpi" key={value}><span className={`ac-kpi-icon ac-${tone}`}><Icon size={18} aria-hidden="true"/></span><div><strong>{counts[value] || 0}</strong><span>{label}</span></div></div>)}</div>
    <section className="ac-panel" aria-labelledby="ac-queue-title">
      <div className="ac-panel-heading"><h2 id="ac-queue-title">Approval queue</h2><FilterSearch className="ac-filter-search" value={search} onChange={event => { setSearch(event.target.value); pagination.resetPage(); }} placeholder="Search case, reference or action" aria-label="Search case, reference or action"/></div>
      <div className="ac-filters" aria-label="Filter approvals" role="group">
        {['ALL', ...Object.keys(statuses)].map(value => <button key={value} type="button" aria-pressed={filter === value}
          onClick={() => { setFilter(value); pagination.resetPage(); }}>{value === 'ALL' ? 'All' : statusLabel(value)}</button>)}
      </div>
      {visible.length ? <table className="ac-table">
        <thead><tr>{['Case', 'Proposed action', 'Financial impact', 'Plan version', 'Submitted at', 'Status', 'Review'].map(label => <th key={label} scope="col" className={label === 'Financial impact' ? 'ac-impact' : undefined}>{label}</th>)}</tr></thead>
        <tbody>{visible.slice(pagination.start, pagination.end).map(request => {
          const metrics = request.assessment?.verifiedFinancialMetrics || [];
          const impact = metrics.find(metric => metric.label === duplicateExcess) || metrics[0];
          return <tr key={request.requestId}>
            <td data-label="Case"><strong className="ac-case-title">{titleFor(request)}</strong>
              <span className="ac-case-cell"><span title={request.caseId}>{caseLabel(request.caseId)}</span><CopyReference label="case ID" value={request.caseId}/></span></td>
            <td data-label="Proposed action">{actionLabel(request)}</td>
            <td data-label="Financial impact" className="ac-impact">{impact ? <><strong className={impact.label === duplicateExcess ? 'ac-excess-value' : undefined}>{impact.value}</strong><small>{impact.label}</small></> : 'Not verified'}</td>
            <td data-label="Plan version">{planVersion(request)}</td>
            <td data-label="Submitted at">{displayTime(request.submittedAt)}</td>
            <td data-label="Status"><Status status={request.status}/></td>
            <td data-label="Review"><Link className="rp-inline" to={root + approvalRequestSearch(request)} aria-label={`Review ${caseLabel(request.caseId)} ${planVersion(request)}`}>Review<ArrowRight size={15} aria-hidden="true"/></Link></td>
          </tr>;
        })}</tbody>
      </table> : <div className="ac-empty"><FileCheck2 size={25} aria-hidden="true"/>
        <h3>{requests.length ? 'No records match your filters.' : 'No approval requests yet'}</h3>
        <p>{requests.length ? 'Try another status or search term.' : 'Proposals submitted from Policy Assessment appear here.'}</p>
        {requests.length > 0 && <FilterReset onClick={() => { setSearch(''); setFilter('ALL'); pagination.resetPage(); }}>Clear filters</FilterReset>}
        {!requests.length && <Link className="rp-button rp-primary" to={workflow + '/plans'}>Open Resolution Plans</Link>}
      </div>}
      <TablePagination pagination={pagination} label="Approval pages" recordLabel="requests"/>
    </section>
  </>;
}

function ReviewSummary({ request, exceptionType, caseStatus, walkthrough }) {
  const metrics = request.assessment?.verifiedFinancialMetrics || [];
  const figures = ['Intended transfer', 'Posted transfer movement', duplicateExcess]
    .map(label => metrics.find(metric => metric.label === label && metric.value)).filter(Boolean);
  return <section className="ac-panel ac-overview" aria-labelledby="ac-summary-title">
    <div className="ac-panel-heading"><h2 id="ac-summary-title">Decision Overview</h2><Status status={request.status}/></div>
    <dl className="ac-facts">
      <div><dt>Case</dt><dd>{caseLabel(request.caseId)}</dd></div>
      <div><dt>Exception type</dt><dd>{exceptionType || 'Unavailable'}</dd></div>
      <div><dt>Case status</dt><dd><CaseStatus value={caseStatus}/></dd></div>
      <div><dt>Submitted plan</dt><dd>{planVersion(request)}</dd></div>
      <div><dt>Proposed action</dt><dd>{actionLabel(request)}</dd></div>
      <div><dt>Submitted at</dt><dd>{displayTime(request.submittedAt)}</dd></div>
    </dl>
    {figures.length ? <div className="ac-financial">
      <p>{walkthrough ? 'Walkthrough financial figures' : 'Financial figures from the submitted assessment'}</p>
      <dl className="ac-facts">{figures.map(metric => <div className={metric.label === duplicateExcess ? 'ac-excess-figure' : undefined} key={metric.label}>
        <dt>{metric.label}</dt><dd>{metric.value}</dd>
        <small>{metric.label === duplicateExcess ? 'Apparent impact only' : walkthrough ? 'Fixture evidence' : 'Verified source figure'}</small>
      </div>)}</dl>
    </div> : <p className="ac-panel-links">Transfer figures were not verified in the submitted assessment.</p>}
    <details className="ac-references"><summary>Technical References</summary>
      <dl className="ac-facts">{[['Case ID', request.caseId], ['Approval request ID', request.requestId], ['Resolution plan ID', request.planId],
        ['Policy assessment ID', request.assessmentId], ['Investigation ID', request.investigationId], ['Customer snapshot', request.customerSnapshotReference]].map(([label, value]) =>
        <div key={label}><dt>{label}</dt><dd className="ac-reference-value"><code>{value || 'Unavailable'}</code><CopyReference {...{ label, value }}/></dd></div>)}</dl>
    </details>
  </section>;
}

function LinkedReview({ request, source, planTo, policyTo, walkthrough }) {
  const { plan, assessment } = request;
  const controls = assessment?.controls || [];
  const controlSummary = Object.entries({ PASS: 'passed', BLOCKED: 'blocked', REVIEW_REQUIRED: 'require review', APPROVAL_REQUIRED: 'require approval' })
    .map(([code, label]) => [controls.filter(control => control.status === code).length, label])
    .filter(([count]) => count).map(([count, label]) => `${count} ${label}`).join(' · ');
  const blocker = controls.find(control => control.status === 'BLOCKED') || controls.find(control => control.status === 'REVIEW_REQUIRED');
  return <section className="ac-panel ac-context-panel" aria-label="Decision context">
    <section aria-labelledby="ac-recommendation-title">
      <h2 id="ac-recommendation-title">AI Resolution Recommendation</h2>
      {plan ? <><h3>{plan.resolutionTitle}</h3><p>{plan.summary}</p></> : <p>The submitted resolution plan is unavailable.</p>}
      {!walkthrough && <div className="rp-actions ac-panel-links"><Link className="rp-inline" to={planTo}>View submitted resolution plan</Link>
        <Link className="rp-inline" to={'/intelliops/investigation' + source}>View original investigation</Link></div>}
    </section>
    <section aria-labelledby="ac-policy-title">
      <h2 id="ac-policy-title">Policy Assessment</h2>
      {assessment ? <>
        <p className="ac-policy-result"><strong>{humanize(assessment.status)}</strong>{assessment.requiredApproverRole && <> · {assessment.requiredApproverRole} review</>}</p>
        {controlSummary && <p>{controlSummary}</p>}
        {blocker && <p className="ac-warning">{blocker.reason}</p>}
        <details className="ac-references"><summary>View policy checks</summary>
          <ul className="ac-checks">{controls.map(control => <li key={control.id}>
            <strong>{control.name}</strong><span>{humanize(control.status)}</span><p>{control.reason}</p>
          </li>)}</ul>
        </details>
      </> : <p>The linked policy assessment is unavailable.</p>}
      <Link className="rp-inline ac-panel-links" to={policyTo}>View Policy Assessment</Link>
    </section>
    <CustomerContext request={request}/>
  </section>;
}

function CustomerContext({ request }) {
  const responses = resolutionCustomerResponses(request.caseId, request.investigationId);
  const latest = responses.at(-1);
  const sent = resolutionIncidentNotifications(request.caseId, request.investigationId).length > 0;
  const newReplies = request.plan ? pendingResolutionResponses(request.plan, responses) : [];
  return <section aria-labelledby="ac-context-title">
    <h2 id="ac-context-title">Customer context</h2>
    <p>{sent ? 'Simulated notification recorded' : 'No simulated notification recorded'} · {latest ? 'Reply recorded' : sent ? 'Awaiting reply' : 'No reply recorded'}</p>
    <p>{request.plan ? `${request.plan.customerSnapshot.responses.length} customer replies included in the submitted plan.` : 'Submitted customer snapshot unavailable.'}</p>
    {newReplies.length > 0 && <p className="ac-warning" role="status">New customer input is absent from the submitted snapshot. Reassess and resubmit the current plan before recording a decision.</p>}
    {latest && <div className="ac-reply">
      <strong>{responseTypes[latest.communicationType] || 'Customer email reply'}</strong>
      <p><time dateTime={latest.createdAt}>{displayTime(latest.createdAt)}</time> · Simulated</p>
      <p>{!request.plan ? 'Response inclusion unavailable' : newReplies.some(reply => reply.id === latest.id) ? 'Latest reply not included in submitted plan' : 'Latest reply included in submitted plan'}</p>
      <p className="ac-reply-preview">{latest.body}</p>
      <details><summary>View full customer reply</summary><p className="ac-message">{latest.body}</p></details>
    </div>}
  </section>;
}

function Review({ request, params, banking, role, onSaved, walkthrough }) {
  const dialog = useRef(null);
  const inFlight = useRef(null);
  const receipt = useRef(null);
  const latestRole = useRef(role);
  useEffect(() => { latestRole.current = role; }, [role]);
  useEffect(() => () => inFlight.current?.abort(), []);
  const [choice, setChoice] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  useEffect(() => { if (success) receipt.current?.focus(); }, [success]);
  const blocked = approvalBlock(request);
  const currentPlan = approvalContext(request).current;
  const pending = request.status === 'PENDING_APPROVAL';
  const source = '?' + new URLSearchParams({ case: request.caseId, investigation: request.investigationId }).toString();
  const planTo = workflow + '/plans' + source + '&' + new URLSearchParams({ plan: request.planId, version: String(request.planVersion) }).toString();
  const policyTo = workflow + '/policy' + approvalRequestSearch(request);
  const caseRecord = (banking.exception_cases || []).find(item => item.id === request.caseId);
  const exceptionType = walkthrough?.record.exceptionType || caseRecord?.exceptionType;
  const openDialog = decision => {
    setChoice(decision); setReason(''); setError('');
    dialog.current.showModal();
  };
  async function confirm(event) {
    event.preventDefault();
    if (inFlight.current) return;
    if (!validDecisionReason(reason)) { setError('Enter a decision reason of at least 12 characters.'); return; }
    const current = getApprovalRequest(params);
    const issue = current ? approvalBlock(current) : 'The approval request is unavailable.';
    if (issue || latestRole.current !== 'ADMIN') { setError(issue || 'Administrator role is required.'); return; }

    const controller = new AbortController();
    inFlight.current = controller;
    const timer = setTimeout(() => controller.abort(new DOMException('Evidence verification timed out', 'TimeoutError')), 10000);
    setBusy(true);
    setError('');
    try {
      const localCase = (banking.exception_cases || []).find(item => item.id === current.caseId);
      const evidence = walkthrough || await readResolutionCase(current.caseId, current.investigationId, localCase, { signal: controller.signal });
      controller.signal.throwIfAborted();
      const decisionContext = approvalContext(current);
      const fresh = evaluatePolicy(decisionContext, evidence);
      if (fresh.status !== 'APPROVAL_REQUIRED' || fresh.verification.state !== 'CURRENT' ||
          fresh.evidenceSnapshotReference !== current.assessment.evidenceSnapshotReference) {
        throw new Error('Current evidence or policy prerequisites could not be confirmed. Re-evaluate policy before submitting a new request.');
      }
      recordApprovalDecision(params, choice, reason, latestRole.current);
      dialog.current.close();
      setReason('');
      onSaved();
      setSuccess('Simulated decision recorded.');
    } catch (failure) {
      if (controller.signal.reason?.name !== 'AbortError') setError(failure.name === 'TimeoutError' ? 'Evidence verification timed out. Try again before recording a decision.' : failure.message);
    } finally {
      clearTimeout(timer);
      inFlight.current = null;
      if (controller.signal.reason?.name !== 'AbortError') setBusy(false);
    }
  }

  return <>
    <Link className="rp-inline" to={root}><ArrowLeft size={16} aria-hidden="true"/>Back to approval queue</Link>
    <ReviewSummary caseStatus={caseRecord?.status} {...{ request, exceptionType, walkthrough }}/>
    <div className="ac-review-grid">
    <LinkedReview {...{ request, source, planTo, policyTo, walkthrough }}/>
    <section className="ac-panel ac-decision" data-status={request.status} aria-labelledby="ac-decision-title">
      <div className="ac-panel-heading"><h2 id="ac-decision-title">{pending ? 'Administrator Decision' : 'Decision Receipt'}</h2><Status status={request.status}/></div>
      {currentPlan && currentPlan.version !== request.planVersion && <p>Submitted V{request.planVersion} · Current plan V{currentPlan.version}</p>}
      {pending ? <>
        <dl className="ac-decision-facts">
          <div><dt>Required approver</dt><dd>{request.requiredApproverRole || request.assessment?.requiredApproverRole || 'Unavailable'}</dd></div>
          <div><dt>Review eligibility</dt><dd>{blocked ? 'Blocked' : role !== 'ADMIN' ? 'Read-only in this role' : 'Eligible for review'}</dd></div>
        </dl>
        {blocked ? <p className="ac-warning" role="status">{blocked}</p> : role !== 'ADMIN' ? <p>Awaiting Administrator review.</p> : <p>Choose a decision and document your reason.</p>}
        {!blocked && role === 'ADMIN' && <div className="rp-actions ac-panel-links">
          <button className="rp-button ac-approve" type="button" onClick={() => openDialog('APPROVED')}>Approve</button>
          <button className="rp-button ac-reject" type="button" onClick={() => openDialog('REJECTED')}>Reject</button>
        </div>}
        {blocked && <Link className="rp-inline" to={workflow + '/plans' + source}>Open current resolution plan</Link>}
        <p className="ac-decision-safety"><LockKeyhole size={15} aria-hidden="true"/>Approval authorizes the next controlled workflow step. No financial correction is executed here.</p>
      </> : <div className="ac-receipt" ref={receipt} tabIndex={-1} role="status">
        <p className="ac-receipt-case">{caseLabel(request.caseId)} · {planVersion(request)}</p>
        {request.decision && <>
          <dl className="ac-decision-facts">
            <div><dt>Acting role</dt><dd>Demo {roleLabel(request.decision.actingRole)}</dd></div>
            <div><dt>Recorded at</dt><dd><time dateTime={request.decision.decidedAt}>{displayTime(request.decision.decidedAt)}</time></dd></div>
          </dl>
          <div className="ac-receipt-reason"><strong>Decision reason</strong><p className="ac-message">{request.decision.reason}</p></div>
        </>}
        <div className="ac-receipt-next"><strong>Next controlled step</strong>
          <p>{request.status === 'APPROVED' ? 'Approved for the next controlled workflow step.' :
            request.status === 'REJECTED' ? 'Rejected by Administrator. Return to the source plan for review.' : 'Next step unavailable.'}</p>
          <p>No financial correction has been executed.</p>
        </div>
        <Link className="rp-inline" to={walkthrough ? policyTo : planTo}>{walkthrough ? 'Review demo assessment' : 'Review source plan'}</Link>
      </div>}
    </section>
    </div>
    <dialog ref={dialog} className="ac-dialog" aria-labelledby="ac-confirm-title" onCancel={event => { if (busy) event.preventDefault(); }}>
      <form onSubmit={confirm} noValidate>
        <h2 id="ac-confirm-title">{choice === 'APPROVED' ? 'Confirm approval' : 'Confirm rejection'}</h2>
        <p className="ac-dialog-context"><strong>{caseLabel(request.caseId)} · {planVersion(request)}</strong><br/>{actionLabel(request)}</p>
        <p>This records a simulated decision for the next workflow step.</p>
        <label htmlFor="ac-decision-reason">Decision reason</label>
        <textarea id="ac-decision-reason" autoFocus rows={4} maxLength={1000} value={reason} onChange={event => setReason(event.target.value)}
          placeholder={choice === 'APPROVED' ? 'Which evidence supports proceeding to review?' : 'What issue needs to be resolved before this can proceed?'}
          required minLength={12} disabled={busy} aria-invalid={Boolean(error && !validDecisionReason(reason))} aria-describedby="ac-reason-help"/>
        <small id="ac-reason-help">Use at least 12 characters to explain the decision.</small>
        {error && <p className="ac-warning" role="alert">{error}</p>}
        <div className="rp-actions"><button className="rp-button" type="button" disabled={busy} onClick={() => dialog.current.close()}>Cancel</button>
          <button className={`rp-button ${choice === 'APPROVED' ? 'ac-approve' : 'ac-reject'}`} type="submit" disabled={busy}>
            {busy ? 'Verifying evidence…' : choice === 'APPROVED' ? 'Confirm Approval' : 'Confirm Rejection'}</button></div>
      </form>
    </dialog>
  </>;
}

export default function ApprovalCenter() {
  const [params] = useSearchParams();
  const banking = useBankingRecords();
  const [demoRole, setDemoRole] = useState(() => {
    try { return sessionStorage.getItem('payment-demo-role') === 'ADMIN' ? 'ADMIN' : 'ANALYST'; } catch { return 'ANALYST'; }
  });
  const [, setRevision] = useState(0);
  const [walkthroughRole, setWalkthroughRole] = useState('ANALYST');
  const reviewing = params.has('request') || params.has('assessment');
  const request = reviewing ? getApprovalRequest(params) : null;
  const walkthrough = request && approvalWalkthroughEvidence(request.caseId, request.investigationId);
  const role = walkthrough ? walkthroughRole : backendConnected ? banking.role : demoRole;
  const handoff = reviewing && !request && !params.has('request') ? resolvePolicyContext(params) : null;
  const permitted = handoff && getPolicyActivity(handoff.caseId).assessments.findLast(item =>
    item.planId === handoff.plan?.planId && item.planVersion === handoff.plan?.version);
  const permittedReview = permitted?.assessmentId === params.get('assessment') && permitted?.status === 'ELIGIBLE' && assessmentApplies(permitted, handoff);
  const onRoleChange = value => {
    setDemoRole(value);
    try { sessionStorage.setItem('payment-demo-role', value); } catch { /* The current view retains the demo role. */ }
  };

  return <div className="rp-workspace ac-workspace">
    <Header role={role} demoRole={walkthrough ? walkthroughRole : demoRole} onRoleChange={walkthrough ? setWalkthroughRole : onRoleChange} walkthrough={walkthrough}/>
    <p className="ac-demo"><ShieldCheck size={17} aria-hidden="true"/>{walkthrough
      ? 'Simulated approval workflow · This request uses fixture evidence and a walkthrough role.'
      : 'Simulated approval workflow · Requests and decisions stay in this browser session.'}</p>
    {request ? <Review key={request.requestId} {...{ request, params, banking, role, walkthrough }} onSaved={() => setRevision(value => value + 1)}/> :
      permittedReview ? <section className="ac-panel ac-empty"><FileCheck2 size={24} aria-hidden="true"/>
        <h2>Eligible for controlled review</h2><p>{permitted.caseId} · V{permitted.planVersion} qualifies for human review without an Administrator approval request.</p>
        <Link className="rp-button" to={workflow + '/policy?' + params.toString()}>Back to Policy Assessment</Link></section> :
      reviewing ? <section className="ac-panel ac-empty"><TriangleAlert size={24} aria-hidden="true"/>
        <h2>Approval request unavailable</h2><p>The link does not identify a saved approval request in this session.</p><Link className="rp-button" to={root}>Back to approval queue</Link></section> :
        <Queue requests={listApprovalRequests()} cases={banking.exception_cases || []}/>}
  </div>;
}
