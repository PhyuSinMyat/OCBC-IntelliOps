import React from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ChevronRight, ClipboardList, MessageSquare, Scale, ShieldCheck, TriangleAlert } from 'lucide-react';
import { contextSearch } from '../../../app/navigation.js';

// Landing/empty-state for the Resolution Workspace parent route (/intelliops/workflows).
// Renders only when there is no ?investigation handoff (the handoff branch in PortalPage
// takes precedence and remains unchanged). When a case is present in the URL it is shown
// as context; otherwise an explicit empty state guides the user to pick a case.
const CARDS = [
  { to: 'workflows/plans', title: 'Resolution Plans', icon: ClipboardList, blurb: 'Draft and sequence corrective actions for the selected case.' },
  { to: 'workflows/communication', title: 'Customer Communication', icon: MessageSquare, blurb: 'Prepare messaging and acknowledgements for the customer.' },
  { to: 'workflows/policy', title: 'Policy Assessment', icon: Scale, blurb: 'Check the proposed resolution against policy controls.' },
];

export default function ResolutionWorkspace() {
  const [params] = useSearchParams();
  const caseId = params.get('case');
  const investigationId = params.get('investigation');
  const ctx = contextSearch(params);
  return (
    <div className="resolution-workspace">
      <div className="page-heading">
        <p className="eyebrow">Resolution Workspace</p>
        <h1>Resolution Workspace</h1>
        <p>Turn an investigation outcome into a structured, policy-aware resolution for this case.</p>
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
          <p>The Resolution Workspace is a navigation preview. Planner, communication and policy features are not yet connected — no actions are approved or executed here.</p>
        </div>
      </section>

      <section className="resolution-cards" aria-label="Resolution sections">
        <h2>Resolution sections</h2>
        <div className="resolution-card-grid">
          {CARDS.map(card => (
            <Link key={card.to} className="resolution-card" to={`/intelliops/${card.to}${ctx}`}>
              <span className="resolution-card-icon"><card.icon size={20} aria-hidden="true" /></span>
              <h3>{card.title}</h3>
              <p>{card.blurb}</p>
              <span className="resolution-shortcut-action">Open <ChevronRight size={15} aria-hidden="true" /></span>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
