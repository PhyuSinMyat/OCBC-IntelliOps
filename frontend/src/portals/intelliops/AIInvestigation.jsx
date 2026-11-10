import React, { useState, useSyncExternalStore } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, CheckCircle2, ChevronRight, FileSearch, FlaskConical, History, LoaderCircle, RotateCcw, TriangleAlert } from 'lucide-react';
import RecordDrawer from '../../shared/components/RecordDrawer.jsx';
import { accounts, backendConnected, useBankingRecords } from '../../shared/data/bankingRecords.js';
import { isDuplicate, relatedPayments, stages } from './investigation/analysis.js';
import { developmentFixture, fixtureOptions } from './investigation/fixtures.js';
import { getRuns, investigationKey, investigationRevision, sendToResolution, startInvestigation, subscribeInvestigations } from './investigation/service.js';
import { displayTime, humanize, InvestigationTrace, Section, SourceLink } from './investigation/ReportSections.jsx';
import { CausalTimeline, DiagnosisHero, EvidenceExplorer, ExecutionPaths, FinancialImpact, KeyResults, NextBestAction, ReadyInvestigation, StageDetails } from './investigation/CommandCenter.jsx';
import './investigation.css';

function DevelopmentExamples() {
  return <details className="inv-development"><summary>Development examples</summary><p>Isolated fixtures. Shared payments, exceptions and ledger data are unchanged.</p><div className="inv-example-links">{Object.entries(fixtureOptions).map(([key, title]) => <Link key={key} to={`/intelliops/investigation?fixture=${key}`}>{title}<ArrowRight size={14}/></Link>)}</div></details>;
}

function Progress({ run }) {
  const s = run.snapshot;
  const results = [
    [s.original, s.duplicate].filter(Boolean).map(p => p.id),
    s.events.map(e => `${e.id} · ${humanize(e.eventType)}`),
    s.journals.map(j => `${j.id} · ${j.status}`),
    ['Source-linked instruction relationship', 'Evidence-backed cause and missing records'],
    ['Structured diagnosis, execution assessment and proposal'],
  ];
  const summaries = [`${[s.original, s.duplicate].filter(Boolean).length} payment records in snapshot`, `${s.events.length} related events identified`, `${s.journals.length} linked journals · ${s.entries.length} entries`, 'Checking supported explanations and uncertainty', 'Preparing saved findings and evidence references'];
  return <section className="cc-progress" aria-labelledby="cc-progress-title"><div className="cc-section-heading"><div><p className="inv-kicker">Evidence collection / analysis</p><h2 id="cc-progress-title">{run.run_status === 'FAILED' ? 'Investigation stopped' : 'Following the payment trail'}</h2></div><span className="cc-tag">Simulated stages</span></div><p className="inv-muted">Deterministic prototype using this case’s snapshot. No live agent or tool calls.</p><ol className="inv-progress">{stages.map(([title, description], i) => {
    const completed = i < run.stage_index;
    const status = completed ? 'Completed' : i === run.stage_index ? run.run_status === 'FAILED' ? 'Failed' : 'Running' : 'Pending';
    return <li key={title} className={`inv-stage-${status.toLowerCase()}`}><span className="inv-stage-marker">{completed ? <CheckCircle2 size={18}/> : i + 1}</span><div><div className="inv-stage-heading"><strong>{title}</strong><span>{status}</span></div><p>{i <= run.stage_index ? summaries[i] : description}</p>{completed && <details><summary>Inspect collected evidence</summary>{results[i].length ? <ul>{results[i].map(ref => <li key={ref}>{ref}</li>)}</ul> : <p>No records found in this snapshot; absence alone is not proof of non-execution.</p>}</details>}</div></li>;
  })}</ol></section>;
}

export default function AIInvestigation() {
  const sharedRecords = useBankingRecords();
  useSyncExternalStore(subscribeInvestigations, investigationRevision);
  const [params] = useSearchParams();
  const location = useLocation(), navigate = useNavigate();
  const fixtureName = params.get('fixture'), fixture = developmentFixture(fixtureName);
  const records = fixture?.records || sharedRecords;
  const selected = fixture?.caseRecord || (sharedRecords.exception_cases || []).find(c => c.id === params.get('case'));
  const invalidFixture = Boolean(fixtureName && !fixture);
  const accountList = fixture?.accounts || accounts;
  const key = selected ? investigationKey(selected, fixture ? `fixture:${fixtureName}` : backendConnected ? `backend:${import.meta.env.VITE_BANKING_API_URL}` : 'local') : '';
  return <InvestigationWorkspace key={`${key}:${invalidFixture}`} {...{ selected, records, accountList, fixture, keyValue: key, location, navigate, invalidFixture }}/>;
}

function InvestigationWorkspace({ selected, records, accountList, fixture, keyValue, location, navigate, invalidFixture }) {
  const [drawer, setDrawer] = useState(null), [viewedId, setViewedId] = useState(null);
  const [error, setError] = useState(''), [failNext, setFailNext] = useState(false);
  const runs = getRuns(keyValue), latest = runs.at(-1);
  const viewed = viewedId ? runs.find(r => r.investigation_id === viewedId) : latest;
  const historical = Boolean(viewedId && viewedId !== latest?.investigation_id);
  const running = latest && ['QUEUED', 'COLLECTING_EVIDENCE', 'ANALYZING'].includes(latest.run_status);
  const report = viewed?.run_status === 'COMPLETED' ? viewed.report : null;
  const supported = isDuplicate(selected);
  const { original, duplicate } = selected ? relatedPayments(selected, records) : {};
  const fallback = selected && !fixture ? `/intelliops/exceptions?case=${encodeURIComponent(selected.id)}` : '/intelliops/exceptions';
  const from = location.state?.from;
  const back = typeof from === 'string' && /^\/intelliops\/exceptions(?:\?|$)/.test(from) ? from : fallback;
  const caseDetails = fixture ? <button className="cc-text-button" onClick={() => setDrawer({ type: 'fixture' })}>View Case Details<ChevronRight size={14}/></button> : <Link className="cc-text-button" to={back}>View Case Details<ChevronRight size={14}/></Link>;
  async function run(retry = false) {
    setError(''); setViewedId(null);
    const failEvidence = !retry && failNext;
    setFailNext(false);
    try { await startInvestigation({ key: keyValue, caseRecord: selected, records, accounts: accountList, fixture: fixture?.fixture, failEvidence }); }
    catch (e) { setError(e.message); }
  }
  function handoff() {
    try {
      const result = sendToResolution(keyValue, report.investigation_id);
      navigate(`/intelliops/workflows?case=${encodeURIComponent(result.case_id)}&investigation=${encodeURIComponent(result.investigation_id)}`);
    } catch (e) { setError(e.message); }
  }
  const onTrace = () => setDrawer({ type: 'trace' });
  const onInspect = context => setDrawer({ type: 'stage', context });
  const drawerTitle = drawer?.type === 'history' ? 'Investigation History' : drawer?.type === 'trace' ? 'Full Investigation Trace' : drawer?.type === 'stage' ? 'Execution Evidence' : 'Development Case Details';
  return <div className="inv-workspace cc-workspace">
    <Link className="inv-back" to={back}><ArrowLeft size={14}/>Back to Exception Center</Link>
    <div className="page-heading inv-page-heading cc-page-heading"><div><p className="eyebrow">Investigation command center</p><h1>AI Investigation</h1></div><span className="cc-page-purpose">From a detected exception to an evidence-backed finding.</span></div>
    {!selected || invalidFixture ? <><Section title={location.search ? 'Investigation unavailable' : 'No Investigation Selected'} className="inv-empty"><FileSearch size={36}/><p>{location.search ? 'The selected case or development fixture is unavailable in the current dataset.' : 'Choose an exception from Exception Center to begin investigating its underlying cause.'}</p><Link className="inv-button inv-primary" to="/intelliops/exceptions">Browse Exceptions<ArrowRight size={15}/></Link></Section><DevelopmentExamples/></> : <>
      <div className="cc-prototype-note"><FlaskConical size={14}/><strong>{fixture ? `Development fixture · ${fixtureOptions[fixture.fixture]}` : 'Prototype investigation adapter'}</strong><span>Deterministic simulation · No live LLM</span></div>
      <header className="inv-case-header cc-case-header"><div className="inv-case-top"><div><div className="cc-case-reference"><span>{selected.id}</span><span className={`cc-severity ${selected.severity?.toUpperCase() === 'HIGH' ? 'cc-high' : ''}`}>{humanize(selected.severity)} severity</span></div><h2>{supported ? 'Potential Duplicate Transaction' : selected.exceptionType}</h2><div className="inv-related">{supported && <><SourceLink reference={original?.id} fixture={fixture?.fixture}/><span className="cc-reference-divider">/</span></>}<SourceLink reference={duplicate?.id || selected.transactionId} fixture={fixture?.fixture}/></div></div><div className="inv-header-actions">{caseDetails}<button className="inv-button cc-history-button" onClick={() => setDrawer({ type: 'history' })}><History size={15}/>View Investigation History</button></div></div><div className="cc-case-footer"><span>Case status <strong>{humanize(selected.status)}</strong></span><span>Investigation <strong>{latest ? humanize(latest.run_status) : 'Ready to investigate'}</strong></span><details><summary>Case metadata</summary><p>Assigned analyst: {selected.assignedTo || 'Unassigned'}</p><p>Detected: {displayTime(selected.createdAt)}</p></details></div></header>
      {!supported ? <Section title="Investigation not yet supported"><p>This workspace supports Duplicate Transaction cases. No duplicate findings have been generated for this exception.</p>{caseDetails}</Section> : <>
        {error && <p className="inv-error" role="alert">{error}</p>}
        {historical && <div className="inv-history-banner"><span>Read-only previous report · {viewed.investigation_id}</span><button className="inv-button" onClick={() => setViewedId(null)}>Return to latest report</button></div>}
        {!viewed && <ReadyInvestigation {...{ original, duplicate, accounts: accountList, fixture: fixture?.fixture }} onStart={() => run()}/>}
        {viewed && !report && <><div className="inv-run-status" role="status">{running ? <LoaderCircle className="inv-spinner" size={17}/> : <TriangleAlert size={17}/>}<span>{humanize(viewed.run_status)} · {viewed.stage_index >= 0 ? stages[viewed.stage_index][0] : 'Waiting to collect evidence'}</span></div><Progress run={viewed}/>{viewed.run_status === 'FAILED' && <Section title="Investigation could not be completed" className="inv-failure"><p role="alert">{viewed.error}</p><p>No diagnosis produced. Your case is unchanged.</p><button className="inv-button inv-primary" onClick={() => run(true)} disabled={running}><RotateCcw size={15}/>Retry Investigation</button></Section>}</>}
        {report && <>
          <div className="cc-detected-signal"><span>Rule engine alert</span><p>Potential duplicate requests</p><ArrowRight size={14}/><strong>Investigation findings below</strong></div>
          <DiagnosisHero {...{ report, onTrace }}/>
          <KeyResults report={report}/>
          <ExecutionPaths {...{ report, onInspect }}/>
          <CausalTimeline {...{ report, onTrace, onInspect }}/>
          <FinancialImpact report={report}/>
          <EvidenceExplorer {...{ report, onInspect }}/>
          <NextBestAction {...{ report, historical, running }} onSend={handoff} onRun={() => run()}/>
        </>}
        {!running && !historical && <details className="inv-development"><summary>Prototype run controls</summary><label className="inv-checkbox"><input type="checkbox" checked={failNext} onChange={e => setFailNext(e.target.checked)}/>Simulate a ledger evidence timeout on the next new run</label><p>Retry collects a fresh snapshot. Previous runs remain in history.</p></details>}
      </>}
      <RecordDrawer open={Boolean(drawer)} title={drawerTitle} onClose={() => setDrawer(null)}>
        {drawer?.type === 'stage' && <StageDetails context={drawer.context}/>}
        {drawer?.type === 'trace' && report && <InvestigationTrace report={report}/>}
        {drawer?.type === 'history' && <div className="inv-drawer-content">{!runs.length && <p>No investigation runs yet.</p>}{[...runs].reverse().map(r => <article className="inv-history-entry" key={r.investigation_id}><h3>{r.investigation_id}</h3><dl className="inv-detail-list">{[['Started', displayTime(r.started_at)], ['Completed', r.completed_at ? displayTime(r.completed_at) : 'Not completed'], ['Status', humanize(r.run_status)], ['Root cause', r.report?.root_cause_title || 'No diagnosis available'], ['Classification', r.report?.diagnosis_classification || 'Unavailable'], ['Financial outcome', r.report?.financial_execution_assessment.classification || 'Not assessed'], ['Evidence snapshot', displayTime(r.evidence_snapshot_at)], ['Proposed action', r.report?.recommended_action_code || 'None']].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>{r.report && <button className="inv-button" onClick={() => { setViewedId(r.investigation_id); setDrawer(null); }}>Open saved report</button>}</article>)}{viewedId && <button className="inv-button" onClick={() => { setViewedId(null); setDrawer(null); }}>Return to latest report</button>}</div>}
        {drawer?.type === 'fixture' && <div className="inv-drawer-content"><h3>{selected.exceptionType}</h3><p>Isolated development fixture · Case lifecycle: {selected.status}</p><h3>Source evidence</h3><dl className="inv-detail-list">{Object.entries(selected.evidence || {}).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{typeof value === 'object' ? JSON.stringify(value) : String(value)}</dd></div>)}</dl></div>}
      </RecordDrawer>
    </>}
  </div>;
}
