import React, { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, CheckCircle2, CircleHelp, LockKeyhole, MessageSquare, TriangleAlert, UserCheck, XCircle } from 'lucide-react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { contextSearch } from '../../../app/navigation.js';
import { exceptionRequest } from '../../../shared/api/banking.js';
import { displayTime, humanize } from '../investigation/ReportSections.jsx';
import { readResolutionVersions } from './resolutionBackendService.js';
import { submitApprovalRequest } from './approvalBackendService.js';
import './policy-assessment.css';
import './resolution-plans.css';

const plansPath = '/intelliops/workflows/plans';
const communicationPath = '/intelliops/workflows/communication';
const approvalPath = '/intelliops/approvals';
const currentPolicyVersion = 'RESOLUTION_POLICY_V2';
const states = {
  PASS: [CheckCircle2, 'pass', 'Passed'], REVIEW_REQUIRED: [TriangleAlert, 'warning', 'Review required'],
  APPROVAL_REQUIRED: [LockKeyhole, 'warning', 'Approval required'], BLOCKED: [XCircle, 'danger', 'Blocked'],
  NOT_REQUIRED: [CircleHelp, 'neutral', 'Not required'],
};
const outcomeText = {
  ELIGIBLE: 'The current proposal is eligible for its explicitly permitted non-financial next step.',
  APPROVAL_REQUIRED: 'The proposal may be submitted for Administrator review. No financial action has been executed.',
  REVIEW_REQUIRED: 'Additional verification or required communication is needed before this proposal can proceed.',
  BLOCKED: 'A hard prerequisite failed. Review the control results before continuing.',
};

async function readAssessments(caseId, signal) {
  const result = await exceptionRequest(`/api/exceptions/${encodeURIComponent(caseId)}/policy-assessments`, { signal });
  return result.assessments || [];
}
async function runAssessment(caseId, planId) {
  return exceptionRequest(`/api/exceptions/${encodeURIComponent(caseId)}/policy-assessments`, {
    method: 'POST', body: { plan_id: planId },
  });
}

export default function PolicyAssessmentBackend() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const caseId = params.get('case'), investigationId = params.get('investigation');
  const [plans, setPlans] = useState([]), [assessments, setAssessments] = useState([]);
  const [loading, setLoading] = useState(true), [running, setRunning] = useState(false), [submitting, setSubmitting] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    if (!caseId || !investigationId) { setLoading(false); return; }
    const controller = new AbortController();
    Promise.all([readResolutionVersions(caseId, investigationId, { signal: controller.signal }), readAssessments(caseId, controller.signal)])
      .then(([nextPlans, nextAssessments]) => { setPlans(nextPlans); setAssessments(nextAssessments); })
      .catch(failure => { if (failure.name !== 'AbortError') setError(failure.message); })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [caseId, investigationId]);
  const requested = params.get('plan'), requestedVersion = params.get('version');
  const currentPlan = plans.at(-1);
  const plan = plans.find(item => item.planId === requested && String(item.version) === requestedVersion) || currentPlan;
  const assessment = useMemo(() => [...assessments].reverse().find(item =>
    item.planId === plan?.planId && item.policyVersion === currentPolicyVersion), [assessments, plan]);
  const back = plansPath + contextSearch(params);
  const communicationControl = assessment?.controls.find(control => control.id === 'communication');
  const approvalControl = assessment?.controls.find(control => control.id === 'approval');
  const communicationNeeded = communicationControl?.status === 'REVIEW_REQUIRED';
  const approvalReady = Boolean(assessment && approvalControl?.status === 'APPROVAL_REQUIRED' &&
    assessment.controls.filter(control => control.id !== 'approval').every(control =>
      control.status === 'PASS' || control.status === 'NOT_REQUIRED'));
  const workflowContext = contextSearch(new URLSearchParams({ case: caseId || '', investigation: investigationId || '' }));
  const communicationTo = communicationPath + workflowContext;
  async function submitApproval() {
    if (!assessment || submitting) return;
    setSubmitting(true); setError('');
    try { const request = await submitApprovalRequest(assessment.assessmentId); navigate(`${approvalPath}?request=${encodeURIComponent(request.requestId)}`); }
    catch (failure) { setError(failure.message); }
    finally { setSubmitting(false); }
  }
  async function run() {
    if (!plan || running) return;
    setRunning(true); setError('');
    try {
      const result = await runAssessment(caseId, plan.planId);
      setAssessments(items => [...items, result]);
    } catch (failure) { setError(failure.message); }
    finally { setRunning(false); }
  }
  if (loading) return <div className="rp-workspace pa-workspace"><section className="pa-panel"><p role="status">Loading persisted policy workflow…</p></section></div>;
  return <div className="rp-workspace pa-workspace">
    <header className="pa-header"><div className="page-heading"><p className="eyebrow">Resolution Workspace</p><h1>Policy Assessment</h1>
      <p>Server-enforced deterministic controls for the selected persisted plan.</p></div>
      <Link className="rp-button" to={back}><ArrowLeft size={16}/>Back to Resolution Plan</Link></header>
    {!plan ? <section className="pa-panel pa-empty"><CircleHelp size={24}/><div><h2>A persisted resolution plan is required</h2>
      <p>Generate a resolution plan before running policy controls.</p><Link className="rp-button rp-primary" to={back}>Open Resolution Plans</Link></div></section> : <>
      <section className="pa-panel pa-overview"><div className="pa-heading"><h2>Assessment Overview</h2><span className="rp-badge">Backend persisted</span></div>
        <dl><div><dt>Case</dt><dd>{caseId}</dd></div><div><dt>Resolution plan</dt><dd>V{plan.version}</dd></div>
          <div><dt>Proposed action</dt><dd>{humanize(plan.recommendedActionCode)}</dd></div><div><dt>Investigation</dt><dd>{plan.investigationId}</dd></div></dl></section>
      <section className={`pa-decision pa-${assessment?.status === 'BLOCKED' ? 'danger' : assessment ? 'warning' : 'neutral'}`}>
        <span className="pa-decision-icon">{assessment ? <LockKeyhole size={28}/> : <CircleHelp size={28}/>}</span><div>
          <div className="pa-decision-kicker">Deterministic backend policy</div><h2>{assessment ? humanize(assessment.status) : 'Not evaluated'}</h2>
          <p>{assessment ? outcomeText[assessment.status] : 'Run all six controls against the current database evidence and customer context.'}</p>
          <button className="rp-button rp-primary" type="button" disabled={running} onClick={run}>{running ? 'Assessing…' : assessment ? 'Re-evaluate Policy' : 'Run Policy Assessment'}</button>
        </div></section>
      {error && <p className="pa-error" role="alert">{error}</p>}
      <section className="pa-panel"><div className="pa-heading"><h2>Policy control checks</h2>{assessment && <span className="rp-badge">{assessment.controls.length} evaluated</span>}</div>
        {assessment ? <ol className="pa-controls">{assessment.controls.map(control => { const [Icon, tone, label] = states[control.status]; return <li key={control.id}>
          <span className={`pa-check-icon pa-${tone}`}><Icon size={17}/></span><div><h3>{control.name}</h3><p>{control.reason}</p></div>
          <span className={`pa-check-badge pa-${tone}`}>{label}</span></li>; })}</ol> : <p>No assessment has been recorded.</p>}
      </section>
      {assessments.length > 0 && <details className="pa-panel pa-history"><summary>Assessment history · {assessments.length}</summary><ul>{[...assessments].reverse().map(item =>
        <li key={item.assessmentId}><strong>Plan V{item.planVersion} · {humanize(item.status)}</strong><time>{displayTime(item.evaluatedAt)}</time><code>{item.assessmentId}</code></li>)}</ul></details>}
      {communicationNeeded && <section className="pa-panel pa-next" aria-labelledby="pa-communication-next">
        <div><h2 id="pa-communication-next">Customer communication required</h2>
          <p>Complete the required customer notification, then return and re-evaluate this policy assessment.</p></div>
        <Link className="rp-button rp-primary" to={communicationTo}><MessageSquare size={16} aria-hidden="true"/>Open Customer Communication<ArrowRight size={16} aria-hidden="true"/></Link>
      </section>}
      {approvalReady && <section className="pa-panel pa-next" aria-labelledby="pa-approval-next">
        <div><h2 id="pa-approval-next">Ready for administrator approval</h2>
          <p>All prerequisite controls have passed. Continue to the Approval Center to request an authorised decision.</p></div>
        <button className="rp-button rp-primary" type="button" disabled={submitting} onClick={submitApproval}><UserCheck size={16} aria-hidden="true"/>{submitting ? 'Submitting…' : 'Request Administrator Approval'}<ArrowRight size={16} aria-hidden="true"/></button>
      </section>}
    </>}
  </div>;
}
