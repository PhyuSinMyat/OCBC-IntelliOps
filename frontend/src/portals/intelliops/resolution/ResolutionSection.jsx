import React from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ChevronRight, ShieldCheck, TriangleAlert } from 'lucide-react';
import { contextSearch } from '../../../app/navigation.js';
import { resolutionCustomerResponses } from './communicationService.js';
import { getSessionResolutionPlan, pendingResolutionResponses } from './resolutionPlannerService.js';

// Shared empty-state shell for the Resolution Workspace sub-sections.
// Placeholder only: a correct title, short description, case-context chip,
// an explicit under-development notice, and cross-links that preserve case
// context. No financial data is fabricated and no backend feature is implied.
const SECTIONS = {
  plans: { title: 'Resolution Plans', blurb: 'Draft, sequence and track the corrective actions proposed for this case before they are approved or executed.' },
  communication: { title: 'Customer Communication', blurb: 'Prepare customer-facing messaging, disclosures and acknowledgements related to the case.' },
  policy: { title: 'Policy Assessment', blurb: 'Evaluate the proposed resolution against policy controls and approval gates.' },
};
const ORDER = ['plans', 'communication', 'policy'];

export default function ResolutionSection({ kind }) {
  const [params] = useSearchParams();
  const caseId = params.get('case');
  const investigationId = params.get('investigation');
  const ctx = contextSearch(params);
  const section = SECTIONS[kind];
  const others = ORDER.filter(k => k !== kind);
  const plan = getSessionResolutionPlan(caseId, investigationId);
  const explicitPlan = ['plan', 'version', 'snapshot', 'freshness'].some(key => params.has(key));
  const superseded = explicitPlan && (!plan || params.get('plan') !== plan.planId || params.get('version') !== String(plan.version));
  const pending = plan && pendingResolutionResponses(plan, resolutionCustomerResponses(caseId, investigationId)).length > 0;
  const invalidSnapshot = explicitPlan && plan && (params.get('snapshot') !== plan.customerSnapshot.reference || params.get('freshness') !== 'current');
  const blocked = kind === 'policy' && (superseded || pending || invalidSnapshot);
  return (
    <div className="resolution-workspace">
      <div className="page-heading">
        <p className="eyebrow">Resolution Workspace</p>
        <h1>{section.title}</h1>
        <p>{section.blurb}</p>
      </div>

      <section className="resolution-context">
        {caseId || investigationId ? (
          <div className="resolution-context-case">
            <span className="resolution-context-label">Working case</span>
            {caseId && <span className="resolution-chip">Case {caseId}</span>}
            {investigationId && <span className="resolution-chip">Investigation {investigationId}</span>}
          </div>
        ) : (
          <div className="resolution-context-empty">
            <TriangleAlert size={16} aria-hidden="true" />
            <span>No case selected. Open a case from the Exception Center or AI Investigation to prepare its resolution.</span>
            <Link className="account-link" to="/intelliops/exceptions">Browse exceptions</Link>
          </div>
        )}
      </section>

      <section className="resolution-notice">
        <ShieldCheck size={18} aria-hidden="true" />
        <div>
          <strong>Section under development</strong>
          <p>{kind === 'communication' ? 'Customer communication is a preview. Messages and customer responses are unavailable.' : 'Policy Assessment is a preview. Policy checks and approval submission are unavailable.'}</p>
        </div>
      </section>

      {blocked && <section className="resolution-notice" role="status">
        <TriangleAlert size={18} aria-hidden="true"/>
        <div>
          <strong>Policy handoff unavailable</strong>
          <p>{superseded ? 'The selected plan version is unavailable or superseded. Open the current version in Resolution Plans.' :
            pending ? 'The current plan has unreviewed customer input. Reassess it before policy handoff.' :
              'The snapshot or freshness reference is out of date. Reopen policy handoff from the current plan.'}</p>
          <Link className="account-link" to={`/intelliops/workflows/plans${ctx}`}>Open Resolution Plans</Link>
        </div>
      </section>}
      {plan && !blocked && <section className="resolution-notice" aria-label="Session-only simulated resolution plan">
        <ShieldCheck size={18} aria-hidden="true"/>
        <div>
          <strong>{explicitPlan && kind === 'policy' ? `Assessing Resolution Plan V${plan.version}` : `Session-only simulated plan · V${plan.version} Current`}</strong>
          <p><b>{plan.resolutionTitle}</b></p>
          <p>Plan ID {plan.planId}</p>
          {explicitPlan && <p>Current · Customer snapshot {plan.customerSnapshot.reference}</p>}
          {kind === 'communication' ? <>
            <p>{plan.customerCommunication.recommended ? 'Communication recommended for review' : 'Communication depends on customer or policy needs'}</p>
            <p>{plan.customerCommunication.reason}</p>
            <p>{plan.customerCommunication.suggestedMessageType}</p>
          </> : <>
            <p>Suggested reviewer: {plan.approvalRecommendation.suggestedRole}</p>
            <p>{plan.approvalRecommendation.reason} Approval not submitted.</p>
          </>}
          <Link className="account-link" to={`/intelliops/workflows/plans${ctx}`}>View simulated plan</Link>
        </div>
      </section>}

      <section className="resolution-shortcuts" aria-label="Switch resolution section">
        <h2>Other resolution sections</h2>
        <div className="resolution-shortcut-grid">
          {others.map(k => (
            <Link key={k} className="resolution-shortcut" to={`/intelliops/workflows/${k}${ctx}`}>
              <span>{SECTIONS[k].title}</span>
              <span className="resolution-shortcut-action">Open <ChevronRight size={15} aria-hidden="true" /></span>
            </Link>
          ))}
          <Link className="resolution-shortcut" to={`/intelliops/workflows${ctx}`}>
            <span>Resolution Workspace overview</span>
            <span className="resolution-shortcut-action">Open <ChevronRight size={15} aria-hidden="true" /></span>
          </Link>
        </div>
      </section>
    </div>
  );
}
