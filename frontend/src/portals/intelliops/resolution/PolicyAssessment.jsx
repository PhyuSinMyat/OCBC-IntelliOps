import React, { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, CheckCircle2, ChevronRight, CircleHelp, Copy, LoaderCircle, LockKeyhole, Shield, ShieldCheck, TriangleAlert, UserRound, XCircle } from 'lucide-react';
import { contextSearch } from '../../../app/navigation.js';
import { useBankingRecords } from '../../../shared/data/bankingRecords.js';
import { displayTime } from '../investigation/ReportSections.jsx';
import { cachedResolutionCase, readResolutionCase } from './resolutionData.js';
import ApprovalWalkthroughButton, { approvalWalkthroughEvidence } from './approvalWalkthrough.jsx';
import { resolutionPolicySearch } from './resolutionPlannerService.js';
import { assessmentApplies, evaluatePolicy, getPolicyActivity, policyActionLabel, policySubmissionReadiness, recordPolicyAssessment, recordPolicySubmission, resolvePolicyContext } from './policyDemoService.js';
import './policy-assessment.css';

const plans = '/intelliops/workflows/plans';
const approvalCenter = '/intelliops/approvals';
const communication = '/intelliops/workflows/communication';
const decisions = {
  NOT_EVALUATED: [CircleHelp, 'neutral', 'Assessment Not Yet Run', 'Run policy assessment to evaluate the selected current resolution plan.'],
  ELIGIBLE: [CheckCircle2, 'pass', 'Eligible for Controlled Workflow', 'The proposal satisfies the applicable checks for its next permitted review step.'],
  APPROVAL_REQUIRED: [LockKeyhole, 'warning', 'Administrator Approval Required', 'This proposal passed the applicable policy controls, but financial correction requires authorized human review.'],
  REVIEW_REQUIRED: [TriangleAlert, 'warning', 'Verification Required', 'Review the outstanding controls before forwarding this proposal.'],
  BLOCKED: [XCircle, 'danger', 'Action Blocked', 'The proposal cannot proceed until outstanding requirements are satisfied.'],
};
const checkStates = {
  PASS: [CheckCircle2, 'pass', 'Passed'],
  REVIEW_REQUIRED: [TriangleAlert, 'warning', 'Review required'],
  APPROVAL_REQUIRED: [LockKeyhole, 'warning', 'Approval required'],
  BLOCKED: [XCircle, 'danger', 'Blocked'],
};

function PageHeader({ back, approvalTo }) {
  return <header className="pa-header">
    <div className="page-heading"><p className="eyebrow">Resolution Workspace</p><h1>Policy Assessment</h1>
      <p>Evaluate AI-recommended actions against operational controls and approval requirements.</p></div>
    <Link className="rp-button" to={back}><ArrowLeft size={16} aria-hidden="true"/>Back to Resolution Plan</Link>
    <nav className="pa-progress" aria-label="Resolution progress"><ol>
      <li><Link to={back}>Resolution Plan</Link></li>
      <li aria-current="step">Policy Assessment</li>
      <li>{approvalTo ? <Link to={approvalTo}>Approval Center</Link> : 'Approval Center'}</li>
    </ol></nav>
  </header>;
}

function Overview({ context, record, investigationAccepted }) {
  const { caseId, plan, current } = context;
  const [copyStatus, setCopyStatus] = useState('');
  const references = [['Resolution plan ID', plan.planId], ['Source investigation ID', plan.investigationId],
    ['Customer communication snapshot ID', plan.customerSnapshot.reference]].filter(([, value]) => Boolean(value));
  async function copy(label, value) {
    try { await navigator.clipboard.writeText(value); setCopyStatus(label + ' copied.'); }
    catch { setCopyStatus('Clipboard unavailable. Select the full reference to copy it manually.'); }
  }
  return <section className="pa-panel pa-overview" aria-labelledby="pa-overview-title">
    <div className="pa-heading"><h2 id="pa-overview-title">Assessment Overview</h2>
      <span className="rp-badge">{references.length} linked records</span></div>
    <p className="pa-overview-case"><strong>{caseId}</strong> · {record?.exceptionType || 'Exception type unavailable'}</p>
    <dl>
      <div><dt>Resolution plan</dt><dd>V{plan.version} · {current?.version === plan.version ? 'Current' : 'Superseded'}</dd></div>
      <div><dt>Proposed action</dt><dd>{policyActionLabel(plan)}</dd></div>
      <div><dt>AI investigation</dt><dd>{investigationAccepted ? 'Accepted' : 'Acceptance not confirmed'}</dd></div>
      <div><dt>Customer context</dt><dd>{plan.customerSnapshot.responses.length} {plan.customerSnapshot.responses.length === 1 ? 'response' : 'responses'} included</dd></div>
    </dl>
    <details className="pa-references"><summary>View technical references</summary>
      <dl>{references.map(([label, value]) =>
        <div key={label}><dt>{label}</dt><dd><code>{value}</code>
          <button className="rp-button pa-copy" type="button" aria-label={`Copy ${label}`} onClick={() => copy(label, value)}><Copy size={14} aria-hidden="true"/>Copy</button></dd></div>)}</dl>
      <p role="status">{copyStatus}</p>
    </details>
  </section>;
}

function Decision({ status, assessment, reason, running, outdated, onRun, readiness, planVersion }) {
  const [Icon, tone, title, description] = decisions[running ? 'NOT_EVALUATED' : status];
  return <section className={`pa-decision pa-${tone}`} aria-labelledby="pa-decision-title" aria-busy={running}>
    <span className="pa-decision-icon">{running ? <LoaderCircle className="pa-spinner" size={28} aria-hidden="true"/> : <Icon size={28} aria-hidden="true"/>}</span>
    <div>
      <div className="pa-decision-kicker">{!running && status === 'APPROVAL_REQUIRED' ? 'Approval required' : assessment ? 'Simulated deterministic assessment' : 'Deterministic policy controls'}</div>
      <h2 id="pa-decision-title">{running ? 'Running Policy Assessment' :
        status === 'REVIEW_REQUIRED' && assessment?.verification?.state === 'UNAVAILABLE' ? 'Current Verification Required' : title}</h2>
      <p>{running ? 'Checking plan currency, investigation evidence and operational controls.' : reason ||
        (status === 'APPROVAL_REQUIRED' && readiness.reason) ||
        (outdated ? 'The last assessment used different workflow inputs. Run a fresh assessment before continuing.' : description)}</p>
      <dl>
        {!running && status === 'APPROVAL_REQUIRED' && <div><dt>Required approver</dt><dd>{assessment.requiredApproverRole}</dd></div>}
        <div><dt>Financial execution</dt><dd>Not authorized</dd></div>
      </dl>
      {!running && status === 'APPROVAL_REQUIRED' && readiness.ready &&
        <p className="pa-decision-next"><strong>Next:</strong> Submit Plan V{planVersion} for Administrator review.</p>}
      {!running && status === 'APPROVAL_REQUIRED' && readiness.submission &&
        <p className="pa-decision-next">Simulated assessment · Pending Administrator review</p>}
      {status === 'NOT_EVALUATED' && !running && <button className="rp-button pa-decision-action" type="button" onClick={onRun}>Run Policy Assessment</button>}
    </div>
  </section>;
}

function ControlList({ assessment, communicationTo, outdated, blockedReason, retryVerification, busy }) {
  const summary = assessment && Object.entries(checkStates).map(([code, [, , label]]) => [
    assessment.controls.filter(control => control.status === code).length, label,
  ]).filter(([count]) => count > 0).map(([count, label]) => `${count} ${label}`).join(' · ');
  return <section className="pa-panel" id="policy-checks" aria-labelledby="pa-checks-title">
    <div className="pa-heading"><h2 id="pa-checks-title">Policy control checks</h2>{assessment && <span className="rp-badge">{assessment.controls.length} evaluated</span>}</div>
    {assessment ? <>
      <p className="pa-check-summary">{summary}</p>
      {outdated && <p>These results belong to the last recorded assessment. Run a new assessment to use updated inputs.</p>}
      <ol className="pa-controls">{assessment.controls.map(control => {
        const [Icon, tone, label] = checkStates[control.status];
        return <li key={control.id} id={`policy-control-${control.id}`}>
          <span className={`pa-check-icon pa-${tone}`}><Icon size={17} aria-hidden="true"/></span>
          <div><h3>{control.name}</h3><p>{control.reason}</p>
            {control.id === 'financial' && assessment.verification?.checkedAt && <details className="pa-control-details">
              <summary>Verification details</summary><p>Source match confirmed at {displayTime(assessment.verification.checkedAt)}.</p>
              <p>Saved evidence snapshot: {assessment.evidenceSnapshotReference || 'Reference unavailable'}</p>
            </details>}
            {control.id === 'financial' && control.status === 'REVIEW_REQUIRED' && !outdated && !blockedReason &&
              <button className="rp-button pa-retry" type="button" disabled={Boolean(busy)} onClick={retryVerification}>Retry Evidence Verification</button>}
            {control.id === 'communication' && control.status === 'REVIEW_REQUIRED' && <Link className="rp-inline" to={communicationTo}>Open Customer Communication<ChevronRight size={14} aria-hidden="true"/></Link>}
          </div>
          <span className={`pa-check-badge pa-${tone}`}>{label}</span>
        </li>;
      })}</ol>
    </> : blockedReason ? <ol className="pa-controls">
      <li><span className="pa-check-icon pa-danger"><XCircle size={17} aria-hidden="true"/></span>
        <div><h3>Resolution Plan Currency</h3><p>{blockedReason} The remaining controls have not been evaluated.</p></div>
        <span className="pa-check-badge pa-danger">Blocked</span></li>
    </ol> : <p>Run the assessment to see the results of all six controls.</p>}
  </section>;
}

function Authorization() {
  return <section className="pa-panel pa-authorization" aria-labelledby="pa-authorization-title">
    <h2 id="pa-authorization-title">Authorization requirements</h2>
    <div>
      <article><div className="pa-role-heading"><UserRound size={19} aria-hidden="true"/><h3>Analyst</h3><span className="rp-badge">Prepare &amp; Submit</span></div>
        <p>Reviews plans and policy results and submits eligible proposals for approval.</p></article>
      <article><div className="pa-role-heading"><Shield size={19} aria-hidden="true"/><h3>Administrator</h3><span className="rp-badge">Approve or Reject</span></div>
        <p>Reviews eligible submissions and records an authorized decision.</p></article>
    </div>
    <p><ShieldCheck size={16} aria-hidden="true"/>Approval authorizes the next controlled workflow step. It does not execute a financial reversal.</p>
  </section>;
}

function AssessmentHistory({ activity, currentAssessment, context }) {
  if (!activity.length) return null;
  return <details className="pa-panel pa-history">
    <summary>Assessment history · {activity.length} {activity.length === 1 ? 'record' : 'records'}</summary>
    <ul>{[...activity].reverse().sort((a, b) => Date.parse(b.evaluatedAt) - Date.parse(a.evaluatedAt)).map(item => <li key={item.assessmentId}><details>
      <summary>
        <span className="pa-history-row">
          <span title={item.assessmentId}>Ref {item.assessmentId.slice(0, 8)}</span>
          <strong>V{item.planVersion}</strong><span className={`pa-check-badge pa-${decisions[item.status][1]}`}>{decisions[item.status][2]}</span>
          <time dateTime={item.evaluatedAt}>{displayTime(item.evaluatedAt)}</time>
          <span className="rp-badge">{item === currentAssessment && assessmentApplies(item, context) ? 'Current' : 'Historical'}</span>
        </span>
      </summary>
      <div className="pa-history-result">
        <p>Assessment reference <code>{item.assessmentId}</code></p>
        <p>Recorded results · Read-only · Plan V{item.planVersion}</p>
        <p>Evidence snapshot: {item.evidenceSnapshotReference ? displayTime(item.evidenceSnapshotReference) : 'Unavailable'}</p>
        <dl>{item.controls.map(control => <div key={control.id}>
          <dt>{control.name} · {checkStates[control.status][2]}</dt><dd>{control.reason}</dd>
        </div>)}</dl>
      </div>
    </details></li>)}</ul>
  </details>;
}

function PolicyWorkspace() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const banking = useBankingRecords();
  const context = resolvePolicyContext(params);
  const walkthrough = approvalWalkthroughEvidence(context.caseId, context.investigationId);
  const fallbackRecord = walkthrough?.record || (banking.exception_cases || []).find(item => item.id === context.caseId);
  const search = contextSearch(params);
  const latestPlanTo = walkthrough ? plans : plans + search;
  const backQuery = new URLSearchParams(search);
  if (context.plan) {
    backQuery.set('plan', context.plan.planId);
    backQuery.set('version', String(context.plan.version));
  }
  const back = context.plan && !walkthrough ? plans + '?' + backQuery.toString() : latestPlanTo;
  const communicationTo = communication + search;
  const [activity, setActivity] = useState(() => getPolicyActivity(context.caseId));
  const [record, setRecord] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const running = useRef(null);
  useEffect(() => () => running.current?.abort(), []);

  const assessment = activity.assessments.findLast(item => item.planId === context.plan?.planId && item.planVersion === context.plan?.version);
  const current = assessmentApplies(assessment, context);
  const status = context.block ? 'BLOCKED' : current ? assessment.status : 'NOT_EVALUATED';
  const readiness = policySubmissionReadiness(context, assessment, activity);
  const { submission } = readiness;
  const investigationAccepted = assessment?.controls.some(control => control.id === 'evidence' && control.status === 'PASS') ||
    Boolean(cachedResolutionCase(fallbackRecord, context.investigationId));
  const approvalQuery = new URLSearchParams(resolutionPolicySearch(search, context.plan));
  if (current) approvalQuery.set('assessment', assessment.assessmentId);
  if (submission?.requestId) approvalQuery.set('request', submission.requestId);
  const approvalTo = !busy && current && (status === 'ELIGIBLE' || submission) ? approvalCenter + '?' + approvalQuery.toString() : null;
  const firstRequired = current && assessment.controls.find(control => control.status === 'REVIEW_REQUIRED');
  const decisionReason = context.block || (status === 'BLOCKED' && current
    ? assessment.controls.find(control => control.status === 'BLOCKED')?.reason
    : status === 'REVIEW_REQUIRED' && assessment?.verification?.state === 'UNAVAILABLE'
      ? assessment.controls.find(control => control.id === 'financial')?.reason : '');
  const latestContext = () => resolvePolicyContext(new URLSearchParams(params));

  async function checkEvidence(selected, signal) {
    if (walkthrough) return walkthrough;
    try {
      return await readResolutionCase(selected.caseId, selected.investigationId, fallbackRecord, { signal });
    } catch (failure) {
      if (failure.status === 404) return { kind: 'missing' };
      return { ...cachedResolutionCase(fallbackRecord, selected.investigationId), kind: 'unavailable', reason: failure.name === 'TimeoutError'
        ? 'The source evidence check timed out.' : 'The source evidence check could not be completed.' };
    }
  }

  async function run(submit = false) {
    if (running.current || !context.plan || context.block) return;
    if (submit && !policySubmissionReadiness(latestContext(), assessment, getPolicyActivity(context.caseId)).ready) return;
    const controller = new AbortController();
    running.current = controller;
    const timer = setTimeout(() => controller.abort(new DOMException('Evidence check timed out', 'TimeoutError')), 10000);
    setBusy(submit ? 'submitting' : 'assessing');
    setError('');
    try {
      const evidence = await checkEvidence(context, controller.signal);
      if (controller.signal.aborted && controller.signal.reason?.name !== 'TimeoutError') return;
      const selected = latestContext();
      if (evidence.record) setRecord(evidence.record);
      const result = evaluatePolicy(selected, evidence);
      if (submit && result.status === 'APPROVAL_REQUIRED' && result.verification.state === 'CURRENT' &&
          policySubmissionReadiness(selected, assessment, getPolicyActivity(selected.caseId)).ready &&
          result.evidenceSnapshotReference === assessment.evidenceSnapshotReference) {
        const updated = recordPolicySubmission(selected, assessment, walkthrough ? 'ANALYST' : banking.role);
        setActivity(updated);
        const receipt = updated.submissions.find(item => item.assessmentId === assessment.assessmentId);
        const query = new URLSearchParams(resolutionPolicySearch(search, selected.plan));
        query.set('assessment', assessment.assessmentId);
        if (receipt?.requestId) query.set('request', receipt.requestId);
        navigate(approvalCenter + '?' + query.toString());
      } else {
        setActivity(recordPolicyAssessment(result));
        if (submit) setError('The inputs or control results changed. Review the new assessment before recording a submission.');
      }
    } catch (failure) {
      if (controller.signal.reason?.name !== 'AbortError') setError(failure.message || 'The assessment could not be completed. Try again.');
    } finally {
      clearTimeout(timer);
      running.current = null;
      if (controller.signal.reason?.name !== 'AbortError') setBusy('');
    }
  }

  if (!context.plan) return <>
    <PageHeader {...{ back }}/>
    <section className="pa-panel pa-empty" aria-labelledby="pa-empty-title">
      <CircleHelp size={24} aria-hidden="true"/><div><h2 id="pa-empty-title">{context.block ? 'Policy handoff unavailable' : context.caseId ? 'A current resolution plan is required' : 'Select a case and resolution plan'}</h2>
        <p>{context.block || 'Open Resolution Plans to select a case and generate a simulated plan for assessment.'}</p>
        <Link className="rp-button rp-primary" to={back}>Open Resolution Plans<ArrowRight size={16} aria-hidden="true"/></Link></div>
    </section>
  </>;

  return <>
    <PageHeader {...{ back, approvalTo }}/>
    <Overview context={context} record={record || fallbackRecord} {...{ investigationAccepted }}/>
    {walkthrough && <p className="pa-check-summary" role="status">Approval workflow demo · Uses a separate local case with fixture evidence and a simulated notification.</p>}
    <Decision {...{ status }} assessment={current ? assessment : null} running={Boolean(busy)}
      reason={decisionReason} outdated={Boolean(assessment && !current)} onRun={() => run()} {...{ readiness }} planVersion={context.plan.version}/>
    {error && <p className="pa-error" role="alert">{error}</p>}
    <ControlList assessment={assessment} {...{ communicationTo, busy }} outdated={Boolean(assessment && !current)} blockedReason={context.block} retryVerification={() => run()}/>
    <Authorization/>
    <section className="pa-panel pa-next" aria-labelledby="pa-next-title">
      <div><h2 id="pa-next-title">Next actions</h2>
        {submission ? <p role="status">Plan V{context.plan.version} submitted for simulated Administrator review.</p> :
          <p id="pa-submission-guidance">{status === 'APPROVAL_REQUIRED' && readiness.reason ? readiness.reason :
            'Assessment and submission are frontend simulations.'}</p>}</div>
      <div className="rp-actions">
        {status === 'BLOCKED' ? <a className="rp-button" href="#policy-checks">View Blocking Requirements</a> : <Link className="rp-button" to={back}>Back to Resolution Plan</Link>}
        {!busy && !walkthrough && status === 'REVIEW_REQUIRED' && assessment?.verification?.state === 'UNAVAILABLE' && <ApprovalWalkthroughButton/>}
        {!busy && !context.block && ['BLOCKED', 'ELIGIBLE', 'APPROVAL_REQUIRED'].includes(status) &&
          <button className="rp-button" type="button" onClick={() => run()}>Re-evaluate Policy</button>}
        {busy ? <button className="rp-button rp-primary" type="button" disabled>{busy === 'submitting' ? 'Checking submission…' : 'Assessing…'}</button> :
          status === 'BLOCKED' ? <Link className="rp-button rp-primary" to={latestPlanTo}>Return to Resolution Plan</Link> :
          status === 'REVIEW_REQUIRED' ? <><button className="rp-button" type="button" onClick={() => run()}>Re-evaluate Policy</button>
            <a className="rp-button rp-primary" href={firstRequired ? '#policy-control-' + firstRequired.id : '#policy-checks'}>Review Required Evidence</a></> :
          status === 'ELIGIBLE' ? <Link className="rp-button rp-primary" to={approvalTo}>Continue to Permitted Workflow<ArrowRight size={16} aria-hidden="true"/></Link> :
          submission ? <Link className="rp-button rp-primary" to={approvalTo}>Open Approval Center<ArrowRight size={16} aria-hidden="true"/></Link> :
          status === 'APPROVAL_REQUIRED' ? <button className="rp-button rp-primary" type="button" disabled={!readiness.ready}
            aria-describedby={!readiness.ready ? 'pa-submission-guidance' : undefined} onClick={() => run(true)}>Submit for Administrator Approval</button> :
            <button className="rp-button rp-primary" type="button" onClick={() => run()}>Run Policy Assessment</button>}
      </div>
    </section>
    <AssessmentHistory activity={activity.assessments} currentAssessment={assessment} {...{ context }}/>
  </>;
}

export default function PolicyAssessment() {
  const [params] = useSearchParams();
  const routeKey = params.toString();
  return <div className="rp-workspace pa-workspace"><PolicyWorkspace key={routeKey}/></div>;
}
