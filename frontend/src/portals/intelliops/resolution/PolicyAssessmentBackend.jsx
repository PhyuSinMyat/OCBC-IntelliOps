import React, { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, CheckCircle2, CircleHelp, LockKeyhole, TriangleAlert, XCircle } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { contextSearch } from '../../../app/navigation.js';
import { exceptionRequest } from '../../../shared/api/banking.js';
import { displayTime, humanize } from '../investigation/ReportSections.jsx';
import { readResolutionVersions } from './resolutionBackendService.js';
import './policy-assessment.css';
import './resolution-plans.css';

const plansPath = '/intelliops/workflows/plans';
const states = {
  PASS: [CheckCircle2, 'pass', 'Passed'], REVIEW_REQUIRED: [TriangleAlert, 'warning', 'Review required'],
  APPROVAL_REQUIRED: [LockKeyhole, 'warning', 'Approval required'], BLOCKED: [XCircle, 'danger', 'Blocked'],
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
  const caseId = params.get('case'), investigationId = params.get('investigation');
  const [plans, setPlans] = useState([]), [assessments, setAssessments] = useState([]);
  const [loading, setLoading] = useState(true), [running, setRunning] = useState(false), [error, setError] = useState('');
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
  const assessment = useMemo(() => [...assessments].reverse().find(item => item.planId === plan?.planId), [assessments, plan]);
  const back = plansPath + contextSearch(params);
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
    </>}
  </div>;
}
