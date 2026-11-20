import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, Circle, ClipboardList, LoaderCircle, LockKeyhole, MessageSquare, ShieldCheck, Sparkles, TriangleAlert } from 'lucide-react';
import { displayTime } from '../investigation/ReportSections.jsx';
import { responseTypes } from './communicationService.js';
import { createResolutionVersion, pendingResolutionResponses, resolutionStages, supportsResolutionPlan } from './resolutionBackendService.js';

function VersionDetails({ plan, baseline }) {
  const newResponses = pendingResolutionResponses(baseline, plan.customerSnapshot.responses);
  const added = plan.steps.filter(step => !baseline.steps.some(previous => previous.id === step.id));
  const removed = baseline.steps.filter(step => !plan.steps.some(current => current.id === step.id));
  const updated = plan.steps.filter(step => baseline.steps.some(previous => previous.id === step.id && previous.description !== step.description));
  return <div className="rp-version-details">
    <p>Created {displayTime(plan.generatedAt)} · Source investigation <strong>{plan.investigationId}</strong></p>
    <details className="rp-findings">
      <summary>Customer snapshot · {plan.customerSnapshot.responses.length} responses included</summary>
      <p>{plan.customerSnapshot.reference}</p>
      {plan.customerSnapshot.responses.map(response => <div className="rp-version-response" key={response.id}>
        <strong>{responseTypes[response.communicationType]} · {displayTime(response.createdAt)}</strong>
        <p>{response.body}</p><small>Simulated response {response.id}</small>
      </div>)}
    </details>
    {plan.version > 1 && <section className="rp-version-comparison" aria-label="Version comparison">
      <h4>What changed from V1?</h4>
      <ul>
        <li><strong>Customer context:</strong> {newResponses.length ? newResponses.map(response => responseTypes[response.communicationType]).join(', ') : 'No additional responses in this snapshot'}.</li>
        <li><strong>Recommendation:</strong> {plan.recommendedActionCode === baseline.recommendedActionCode ? 'Core resolution approach retained.' : 'Resolution approach updated.'}</li>
        {added.length > 0 && <li><strong>Added steps:</strong> {added.map(step => step.title).join(', ')}.</li>}
        {removed.length > 0 && <li><strong>Removed steps:</strong> {removed.map(step => step.title).join(', ')}.</li>}
        {updated.length > 0 && <li><strong>Updated steps:</strong> {updated.map(step => step.title).join(', ')}.</li>}
        <li>Verified financial facts are unchanged.</li>
      </ul>
    </section>}
  </div>;
}

function GeneratedPlan({ plan }) {
  const { approvalRecommendation: approval, customerCommunication: communication } = plan;
  return <>
    <div className="rp-demo-summary" role="status">
      <span className="rp-badge rp-demo-generated"><Check size={14} aria-hidden="true"/>Persisted resolution plan</span>
      <h3>{plan.resolutionTitle}</h3>
      <p>{plan.summary}</p>
    </div>
    <h4 className="rp-demo-steps-title">Operational steps</h4>
    <ol className="rp-demo-steps" role="list">{plan.steps.map((step, index) => <li key={step.id}>
      <span className="rp-demo-step-number" aria-hidden="true">{index + 1}</span>
      <div><h5>{step.title}</h5><p>{step.description}</p></div>
    </li>)}</ol>
    <div className="rp-demo-review-grid">
      <section className="rp-demo-review-card" aria-labelledby="rp-demo-communication">
        <h4 id="rp-demo-communication"><MessageSquare size={17} aria-hidden="true"/>Customer communication</h4>
        <p><strong>Recommended: {communication.recommended ? 'Yes' : 'No'}</strong></p>
        <p>{communication.reason}</p>
        <p className="rp-demo-detail">{communication.suggestedMessageType}</p>
      </section>
      <section className="rp-demo-review-card" aria-labelledby="rp-demo-approval">
        <h4 id="rp-demo-approval"><LockKeyhole size={17} aria-hidden="true"/>Approval and safeguards</h4>
        <p><strong>{approval.required ? `${approval.suggestedRole} approval recommended` : 'Approval recommendation'}</strong></p>
        <p>{approval.reason}</p>
        <ul>{plan.risksAndSafeguards.slice(0, 3).map(item => <li key={item}>{item}</li>)}</ul>
        <p className="rp-demo-detail">Approval not submitted · No automatic financial execution</p>
      </section>
    </div>
    {plan.uncertainty.length > 0 && <aside className="rp-demo-uncertainty" aria-labelledby="rp-demo-uncertainty">
      <TriangleAlert size={17} aria-hidden="true"/>
      <div><h4 id="rp-demo-uncertainty">Material uncertainty</h4>
        {plan.uncertainty.map(item => <p key={item}>{item}</p>)}
      </div>
    </aside>}
  </>;
}

export function useResolutionGeneration({ report, plan, current, pending, responses, onGenerated }) {
  const [stage, setStage] = useState(null);
  const [error, setError] = useState('');
  const [createdVersion, setCreatedVersion] = useState(null);
  const active = useRef(null);
  const supported = supportsResolutionPlan(report);
  const reviewingCurrent = plan?.version === current?.version;
  useEffect(() => () => active.current?.abort(), []);

  async function generate() {
    if (active.current || !supported || (current && (!reviewingCurrent || !pending))) return;
    const controller = new AbortController();
    active.current = controller;
    setError('');
    setCreatedVersion(null);
    try {
      setStage(0);
      const updated = await createResolutionVersion(report.case_id, report.investigation_id, current?.version || 0, {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      onGenerated(updated);
      setCreatedVersion(updated.at(-1).version);
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure.message || 'The resolution plan could not be saved.');
    } finally {
      active.current = null;
      if (!controller.signal.aborted) setStage(null);
    }
  }
  return { stage, error, createdVersion, supported, generate };
}

function ResolutionHistory({ versions, plan, generating, onSelect }) {
  const latest = versions.at(-1);
  const label = version => `V${version.version} · ${version.version === 1 ? 'Original' : 'Updated'}`;
  return <section className="rp-history" aria-labelledby="rp-history-title">
    <header>
      <div><h3 id="rp-history-title">Resolution History</h3>
        <p>{versions.length} {versions.length === 1 ? 'version' : 'versions'} · Latest V{latest.version}</p></div>
      <span className="rp-badge rp-history-current">Current Plan · V{latest.version}</span>
    </header>
    {versions.length <= 3 ? <div className="rp-history-segments" role="group" aria-label="Plan versions">
      {versions.map(version => <button key={version.version} type="button" aria-pressed={version === plan} disabled={generating}
        onClick={() => onSelect(version.version)}>{label(version)}</button>)}
    </div> : <label className="rp-version-toolbar">Plan version
      <select value={plan.version} disabled={generating} onChange={event => onSelect(Number(event.target.value))}>
        {versions.map(version => <option key={version.version} value={version.version}>{label(version)}</option>)}
      </select>
    </label>}
  </section>;
}

export default function ResolutionPlanner({ report, communicationTo, hasFinancials, plan, versions, pending, responses, onSelect, generation }) {
  const { stage, error, createdVersion, supported } = generation;
  const generating = stage !== null;
  const current = versions.at(-1);
  const reviewingCurrent = plan === current;
  const generatedBeforeResponse = plan?.version === 1 && plan.customerSnapshot.responses.length === 0 &&
    responses.length > 0 && responses.every(response => Date.parse(response.createdAt) > Date.parse(plan.generatedAt));

  return <section className="rp-panel rp-planner" aria-labelledby="rp-planner-title">
    <div className="rp-panel-heading rp-planner-heading">
      <div className="rp-planner-title"><span className="rp-icon"><Sparkles size={21} aria-hidden="true"/></span><h2 id="rp-planner-title">AI Resolution Planner</h2></div>
      <span className="rp-badge rp-demo-badge">Backend-persisted proposal</span>
    </div>
    {plan && <ResolutionHistory {...{ versions, plan, generating, onSelect }}/>}
    {plan && !reviewingCurrent && <div className="rp-plan-state rp-plan-previous">
      <div><strong>Previous Version</strong><p>This historical recommendation is preserved for review and cannot be submitted for policy assessment.</p>
        {generatedBeforeResponse && <p>Generated before customer response</p>}</div>
      <button className="rp-button" type="button" onClick={() => onSelect(current.version)}>Return to Current Plan</button>
    </div>}
    {plan && reviewingCurrent && (pending ? <div className="rp-plan-state rp-plan-pending">
      <TriangleAlert size={18} aria-hidden="true"/>
      <div><strong>New customer communication available</strong><p>The current plan’s snapshot does not include all persisted customer communication. Reassess the recommendation before submitting it for policy review.</p>
        <div className="rp-actions"><button className="rp-button rp-primary" type="button" disabled={generating || !supported} onClick={generation.generate}>Reassess AI Resolution</button>
          <Link className="rp-button" to={communicationTo}>View Customer Communication</Link></div>
      </div>
    </div> : <div className="rp-plan-state rp-plan-current">
      <Check size={18} aria-hidden="true"/><div role="status"><strong>Latest customer information included</strong><p>This resolution plan reflects the latest recorded customer context.</p></div>
    </div>)}
    {error && <p className="rp-demo-error" role="alert">{error}</p>}
    {!generating && createdVersion === plan?.version && <p className="rp-version-success" role="status">V{createdVersion} saved to the backend.</p>}
    {generating && <div className="rp-demo-progress">
      <h3>{current ? 'Simulated AI Resolution Reassessment' : 'Simulated AI Resolution Generation'}</h3>
      <div className="sr-only" role="status">{resolutionStages[stage]}</div>
      <ol>{resolutionStages.map((label, index) => {
        const Icon = index < stage ? Check : index === stage ? LoaderCircle : Circle;
        return <li key={label} aria-current={index === stage ? 'step' : undefined}>
          <Icon size={16} aria-hidden="true"/>{label}
          {index < stage && <span className="sr-only">Completed</span>}
        </li>;
      })}</ol>
    </div>}
    {plan ? <><GeneratedPlan plan={plan}/><VersionDetails plan={plan} baseline={versions[0]}/></> : !generating && <>
      <p className="rp-planner-description">Generate a structured resolution proposal using the accepted investigation, verified financial evidence, and any available customer communication.</p>
      <div className="rp-demo-inputs" aria-label="Planner inputs and controls">
        <span><ClipboardList size={16} aria-hidden="true"/>{report.prototype === false ? 'Accepted investigation available' : 'Accepted investigation unavailable'}</span>
        <span><Check size={16} aria-hidden="true"/>{hasFinancials ? 'Financial evidence available' : 'Financial evidence unavailable'}</span>
        <span><Circle size={15} aria-hidden="true"/>{responses.length ? 'Customer responses available' : 'Customer response unavailable'}</span>
        <span><ShieldCheck size={16} aria-hidden="true"/>Human review required</span>
      </div>
      {!supported && <div className="rp-demo-unsupported">
        <TriangleAlert size={18} aria-hidden="true"/>
        <div><h3>Resolution generation unavailable</h3><p>{report.persistence !== 'BACKEND_DATABASE'
          ? 'This investigation exists only in browser or prototype state. Reopen a backend-saved report from Investigation History before generating a persistent plan.'
          : 'The planner requires a completed accepted finding with a supported, internally consistent financial assessment.'}</p></div>
      </div>}
    </>}
  </section>;
}
