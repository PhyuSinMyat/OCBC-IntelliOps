import React from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ChevronRight, ShieldCheck, TriangleAlert } from 'lucide-react';
import { contextSearch } from '../../../app/navigation.js';

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
          <p>This screen is a navigation preview. Resolution planning, customer communication and policy features are not yet connected — no actions are approved or executed here.</p>
        </div>
      </section>

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
