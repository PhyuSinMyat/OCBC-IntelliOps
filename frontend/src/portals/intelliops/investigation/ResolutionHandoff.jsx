import React from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { getHandoff } from './service.js';
import { displayTime, Section } from './ReportSections.jsx';
import '../investigation.css';

// Reviewable integration boundary for the Resolution team's future planner.
export default function ResolutionHandoff() {
  const [params] = useSearchParams();
  const result = getHandoff(params.get('investigation'));
  const valid = result && result.case_id === params.get('case');
  const back = valid ? `/intelliops/investigation?${result.fixture ? `fixture=${encodeURIComponent(result.fixture)}` : `case=${encodeURIComponent(result.case_id)}`}` : '/intelliops/exceptions';
  return <div className="inv-workspace"><div className="page-heading inv-page-heading"><p className="eyebrow">Investigation handoff</p><h1>Resolution Workflows</h1><p>Review the investigation proposal before policy evaluation.</p></div><Section title={valid ? 'Investigation proposal received' : 'Proposal unavailable'}>{valid ? <><div className="inv-notice"><strong>Prototype handoff receipt</strong><span>The Resolution Planner and Policy Engine are not connected. No action has been approved or executed.</span></div><dl className="inv-detail-list"><div><dt>Case</dt><dd>{result.case_id}</dd></div><div><dt>Investigation</dt><dd>{result.investigation_id}</dd></div><div><dt>Diagnosis</dt><dd>{result.root_cause_title}</dd></div><div><dt>Financial assessment</dt><dd>{result.financial_execution_assessment.classification}</dd></div><div><dt>Proposed action</dt><dd>{result.recommended_action_code}</dd></div><div><dt>Evidence snapshot</dt><dd>{displayTime(result.evidence_snapshot_at)}</dd></div></dl><p>{result.recommendation_reason}</p><details><summary>Inspect structured handoff</summary><pre className="inv-json">{JSON.stringify(result, null, 2)}</pre></details></> : <p>No matching saved handoff exists in this browser session. Open a completed investigation and send its proposal to Resolution.</p>}<Link className="inv-button" to={back}>{valid ? 'Return to investigation' : 'Browse Exceptions'}</Link></Section></div>;
}
