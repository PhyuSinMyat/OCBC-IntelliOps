import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, CheckCircle2, ChevronRight, FileSearch, FlaskConical, History, LoaderCircle, RotateCcw, TriangleAlert } from 'lucide-react';
import RecordDrawer from '../../shared/components/RecordDrawer.jsx';
import { accounts, backendConnected, fetchExceptionCase, useBankingRecords } from '../../shared/data/bankingRecords.js';
import { isAmountMismatch, isDuplicate, isMissingLedger, relatedPayments, stages } from './investigation/analysis.js';
import { developmentFixture, fixtureOptions } from './investigation/fixtures.js';
import { getRuns, investigationKey, investigationRevision, loadPersistedInvestigations, sendToResolution, startInvestigation, subscribeInvestigations } from './investigation/service.js';
import { displayTime, humanize, InvestigationTrace, Section, SourceLink } from './investigation/ReportSections.jsx';
import { AmountReconciliation, CausalTimeline, DiagnosisHero, EvidenceExplorer, ExecutionPaths, FinancialImpact, KeyResults, MissingLedgerVerification, NextBestAction, ReadyAmountInvestigation, ReadyInvestigation, ReadyMissingLedgerInvestigation, StageDetails, ModelFindings } from './investigation/CommandCenter.jsx';
import { AnalystAttention, CitationExplorer, EvidencePanel, FinancialOverview, InvestigationSkeleton, KeyTimeline, PaymentRelationshipFlow, SavedHistory } from './investigation/WorkspaceSections.jsx';
import './investigation.css';
import './investigation-refinement.css';

function DevelopmentExamples() {
  return <details className="inv-development"><summary>Development examples</summary><p>Isolated fixtures. Shared payments, exceptions and ledger data are unchanged.</p><div className="inv-example-links">{Object.entries(fixtureOptions).map(([key, title]) => <Link key={key} to={`/intelliops/investigation?fixture=${key}`}>{title}<ArrowRight size={14}/></Link>)}</div></details>;
}

function Progress({ run }) {
  if (run.prototype === false) return <section className="cc-progress"><h2>{run.run_status === 'FAILED' ? 'Investigation stopped' : 'Reviewing source evidence with AI'}</h2><p>The backend retrieves database evidence, verifies ledger facts and requests a structured model analysis. No financial action is executed.</p><p>Accepted results are saved on the backend when durable history is enabled. Reload and history reads do not start another model call.</p></section>;
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
  const caseId = params.get('case');
  const [loadedCase, setLoadedCase] = useState(null), [loadError, setLoadError] = useState('');
  useEffect(() => {
    setLoadedCase(null); setLoadError('');
    if (!backendConnected || !caseId) return;
    let current = true;
    fetchExceptionCase(caseId).then(value => { if (current) setLoadedCase(value); })
      .catch(error => { if (current) setLoadError(error.message); });
    return () => { current = false; };
  }, [caseId]);
  const fixtureName = params.get('fixture'), fixture = developmentFixture(fixtureName);
  const records = fixture?.records || sharedRecords;
  const selected = fixture?.caseRecord || (loadedCase?.id === caseId ? loadedCase : null) || (sharedRecords.exception_cases || []).find(c => c.id === caseId);
  const invalidFixture = Boolean(fixtureName && (!fixture || caseId));
  const accountList = fixture?.accounts || accounts;
  const key = selected ? investigationKey(selected, fixture ? `fixture:${fixtureName}` : backendConnected ? `backend-llm:${import.meta.env.VITE_BANKING_API_URL}` : 'local') : '';
  if (backendConnected && caseId && !selected && !loadError) return <p role="status">Loading selected case…</p>;
  if (loadError) return <p className="inv-error" role="alert">{loadError}</p>;
  const linkedReportId = params.get('investigation');
  return <InvestigationWorkspace key={JSON.stringify([key, invalidFixture, linkedReportId])} {...{ selected, records, accountList, fixture, keyValue: key, location, navigate, invalidFixture, linkedReportId }}/>;
}

function InvestigationWorkspace({ selected, records, accountList, fixture, keyValue, location, navigate, invalidFixture, linkedReportId }) {
  const [tab, setTab] = useState('summary');
  const [drawer, setDrawer] = useState(null), [viewedId, setViewedId] = useState(linkedReportId);
  const [error, setError] = useState(''), [failNext, setFailNext] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(backendConnected && !fixture), [historyError, setHistoryError] = useState('');
  const [historyPage, setHistoryPage] = useState({ hasMore: false, nextOffset: 0 });
  async function refreshHistory(offset = 0) {
    if (!selected || fixture || !backendConnected) return;
    setHistoryLoading(true); setHistoryError('');
    try {
      setHistoryPage(await loadPersistedInvestigations(keyValue, selected.id, { offset }));
      if (linkedReportId && offset === 0 && !getRuns(keyValue).some(run => run.investigation_id === linkedReportId && run.durable)) {
        await loadPersistedInvestigations(keyValue, selected.id, { investigationId: linkedReportId });
      }
    }
    catch (e) { setHistoryError(e.message); }
    finally { setHistoryLoading(false); }
  }
  useEffect(() => { refreshHistory(); }, [keyValue]);
  const runs = getRuns(keyValue), latest = runs.at(-1);
  const viewed = viewedId ? runs.find(r => r.investigation_id === viewedId) : latest;
  const historical = Boolean(viewed && viewedId && viewedId !== latest?.investigation_id);
  const running = latest && ['QUEUED', 'COLLECTING_EVIDENCE', 'ANALYZING'].includes(latest.run_status);
  const report = viewed?.run_status === 'COMPLETED' ? viewed.report : null;
  const amountMismatch = isAmountMismatch(selected);
  const missingLedger = isMissingLedger(selected), singlePayment = amountMismatch || missingLedger;
  const supported = isDuplicate(selected) || (singlePayment && backendConnected && !fixture);
  const { original, duplicate } = selected ? relatedPayments(selected, records) : {};
  const fallback = selected && !fixture ? `/intelliops/exceptions?case=${encodeURIComponent(selected.id)}` : '/intelliops/exceptions';
  const from = location.state?.from;
  const back = typeof from === 'string' && /^\/intelliops\/exceptions(?:\?|$)/.test(from) ? from : fallback;
  const caseDetails = fixture ? <button className="cc-text-button" onClick={() => setDrawer({ type: 'fixture' })}>View Case Details<ChevronRight size={14}/></button> : <Link className="cc-text-button" to={back}>View Case Details<ChevronRight size={14}/></Link>;
  async function run(retry = false) {
    setError(''); setViewedId(null);
    const failEvidence = !retry && failNext;
    setFailNext(false);
    try { await startInvestigation({ key: keyValue, caseRecord: selected, records, accounts: accountList, fixture: fixture?.fixture, failEvidence, mode: backendConnected && !fixture ? 'backend' : 'prototype' }); }
    catch (e) { setError(e.message); }
  }
  function handoff() {
    try {
      const result = sendToResolution(keyValue, report.investigation_id);
      navigate(`/intelliops/workflows?case=${encodeURIComponent(result.case_id)}&investigation=${encodeURIComponent(result.investigation_id)}`);
    } catch (e) { setError(e.message); }
  }
  const onTrace = () => setTab('evidence');
  const onInspect = context => setDrawer({ type: 'stage', context });
  const drawerTitle = drawer?.type === 'history' ? 'Investigation History' : drawer?.type === 'trace' ? 'Full Investigation Trace' : drawer?.type === 'stage' ? 'Execution Evidence' : 'Development Case Details';
  return <div className="inv-workspace cc-workspace">
    <Link className="inv-back" to={back}><ArrowLeft size={14}/>Back to Exception Center</Link>
    <div className="page-heading inv-page-heading cc-page-heading"><div><p className="eyebrow">Investigation command center</p><h1>AI Investigation</h1></div><span className="cc-page-purpose">From a detected exception to an evidence-backed finding.</span></div>
    {!selected || invalidFixture ? <><Section title={location.search ? 'Investigation unavailable' : 'No Investigation Selected'} className="inv-empty"><FileSearch size={36}/><p>{location.search ? 'The selected case or development fixture is unavailable in the current dataset.' : 'Choose an exception from Exception Center to begin investigating its underlying cause.'}</p><Link className="inv-button inv-primary" to="/intelliops/exceptions">Browse Exceptions<ArrowRight size={15}/></Link></Section><DevelopmentExamples/></> : <>
      <div className="cc-prototype-note"><FlaskConical size={14}/><strong>{fixture ? `Development fixture · ${fixtureOptions[fixture.fixture]}` : backendConnected ? 'Backend AI investigation' : 'Prototype investigation adapter'}</strong><span>{backendConnected && !fixture ? 'Database evidence · Structured model analysis · Saved investigation history' : 'Deterministic simulation · No live LLM'}</span></div>
      <header className="inv-case-header cc-case-header"><div className="inv-case-top"><div><div className="cc-case-reference"><span>{selected.id}</span><span className={`cc-severity ${selected.severity?.toUpperCase() === 'HIGH' ? 'cc-high' : ''}`}>{humanize(selected.severity)} severity</span></div><h2>{isDuplicate(selected) ? 'Potential Duplicate Transaction' : selected.exceptionType}</h2><div className="inv-related">{isDuplicate(selected) && <><SourceLink reference={original?.id} fixture={fixture?.fixture}/><span className="cc-reference-divider">/</span></>}<SourceLink reference={duplicate?.id || selected.transactionId} fixture={fixture?.fixture}/></div></div><div className="inv-header-actions">{caseDetails}<button className="inv-button cc-history-button" onClick={() => setTab('history')}><History size={15}/>View Investigation History</button></div></div><div className="cc-case-footer"><span>Case status <strong>{humanize(selected.status)}</strong></span><span>Investigation <strong>{latest ? humanize(latest.run_status) : 'Ready to investigate'}</strong></span><details><summary>Case metadata</summary><p>Assigned analyst: {selected.assignedTo || 'Unassigned'}</p><p>Detected: {displayTime(selected.createdAt)}</p></details></div></header>
      {!supported ? <Section title="Investigation not yet supported"><p>This workspace supports Duplicate Transaction, Amount Mismatch and Missing Ledger Posting cases.</p>{caseDetails}</Section> : <>
        {error && <p className="inv-error" role="alert">{error}</p>}
        {historical && <div className="inv-history-banner"><span>Read-only previous report · {viewed.investigation_id}</span><button className="inv-button" onClick={() => setViewedId(null)}>Return to latest report</button></div>}
        <div className="iw-tabs" role="tablist" aria-label="Investigation views">{[['summary', 'Summary'], ['evidence', 'Evidence'], ['history', 'History']].map(([id, label], index) => <button key={id} id={`iw-tab-${id}`} type="button" role="tab" aria-selected={tab === id} aria-controls={`iw-panel-${id}`} tabIndex={tab === id ? 0 : -1} onClick={() => setTab(id)} onKeyDown={e => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) { e.preventDefault(); const ids = ['summary', 'evidence', 'history']; const next = e.key === 'Home' ? 0 : e.key === 'End' ? 2 : (index + (e.key === 'ArrowRight' ? 1 : 2)) % 3; setTab(ids[next]); document.getElementById('iw-tab-' + ids[next])?.focus(); } }}>{label}{id === 'history' && <span>{runs.length}</span>}</button>)}</div>
        <div role="tabpanel" id={`iw-panel-${tab}`} aria-labelledby={`iw-tab-${tab}`} tabIndex={0}>
        {report && <>
          {viewed.durable && <div className={`inv-history-banner ${viewed.stale === true ? 'iw-stale' : viewed.stale == null ? 'iw-freshness-unknown' : ''}`}><span>Saved investigation snapshot · {viewed.stale === true ? 'Current source evidence has changed. Revalidate before action.' : viewed.stale === false ? 'Current evidence matches this snapshot.' : 'Current source comparison unavailable; staleness is unknown.'}</span></div>}
          <div className="iw-report-meta"><span><CheckCircle2 size={14}/> {humanize(report.validation_status || report.run_status)}</span><span>{displayTime(report.completed_at)}</span><span>Report {report.investigation_id}</span></div>
        </>}
        {tab === 'history' && <SavedHistory {...{ runs, latest, viewed }} canRefresh={backendConnected && !fixture} loading={historyLoading} onRefresh={() => refreshHistory()} hasMore={historyPage.hasMore} onMore={() => refreshHistory(historyPage.nextOffset)} onOpen={id => { setViewedId(id); setTab('summary'); }}/>}
        {historyLoading && <InvestigationSkeleton/>}
        {historyError && <p className="inv-error" role="alert">Saved history unavailable: {historyError}</p>}
        {tab === 'evidence' && !report && <Section title="No accepted evidence report"><p>A completed investigation is needed to explore its reasoning and saved sources. Return to Summary to review the investigation status.</p></Section>}
        {tab === 'summary' && !viewed && !historyLoading && (amountMismatch ? <ReadyAmountInvestigation payment={duplicate} accounts={accountList} fixture={fixture?.fixture} onStart={() => run()}/> : missingLedger ? <ReadyMissingLedgerInvestigation payment={duplicate} accounts={accountList} fixture={fixture?.fixture} onStart={() => run()}/> : <ReadyInvestigation {...{ original, duplicate, accounts: accountList, fixture: fixture?.fixture }} onStart={() => run()}/>)}
        {tab === 'summary' && viewed && !report && <><div className="inv-run-status" role="status">{running ? <LoaderCircle className="inv-spinner" size={17}/> : <TriangleAlert size={17}/>}<span>{humanize(viewed.run_status)} · {viewed.stage_index >= 0 ? stages[viewed.stage_index][0] : 'Waiting to collect evidence'}</span></div><Progress run={viewed}/>{viewed.run_status === 'FAILED' && <Section title="Investigation could not be completed" className="inv-failure"><p role="alert">{viewed.error}</p><p>No diagnosis produced. Your case is unchanged.</p><button className="inv-button inv-primary" onClick={() => run(true)} disabled={running}><RotateCcw size={15}/>Retry Investigation</button></Section>}</>}
        {report && <>
          {tab === 'summary' && <>
            <div className="iw-summary-grid"><div><DiagnosisHero {...{ report, onTrace }}/><FinancialOverview report={report}/></div><NextBestAction {...{ report, historical, running }} onSend={handoff} onRun={() => run()}/></div>
            {amountMismatch ? <AmountReconciliation report={report}/> : missingLedger ? <MissingLedgerVerification report={report}/> : <PaymentRelationshipFlow report={report}/>}<KeyTimeline report={report} onEvidence={onTrace} {...{ onInspect }}/>
            <AnalystAttention {...{ report, viewed }}/>
          </>}
          {tab === 'evidence' && <>
            <nav className="iw-evidence-nav" aria-label="Evidence sections">{[['reasoning','AI reasoning'],['execution','Payment Execution'],['events','Timeline'],['ledger','Ledger'],['sources','Sources']].map(([id,label]) => <a key={id} href={'#iw-'+id} onClick={() => { const panel=document.getElementById('iw-'+id); if(panel?.tagName === 'DETAILS') panel.open=true; }}>{label}</a>)}</nav>
            <div className="iw-evidence-overview"><div><p className="inv-kicker">The evidence behind the finding</p><h2>Verify the investigation</h2><p>Explore source records, financial checks and AI interpretation at your own pace.</p></div><div><strong>{report.supporting_evidence.events.length}</strong><span>source events</span></div><div><strong>{report.supporting_evidence.journals.length}</strong><span>linked journals</span></div></div>
            <EvidencePanel id="iw-reasoning" title="AI reasoning" subtitle="Original diagnosis, supported findings and unconfirmed hypotheses" open>
              <section className="inv-section"><p className="inv-kicker">AI interpretation · human review required</p><h2>Why this happened</h2><h3>{report.root_cause_title}</h3><p>{report.root_cause_explanation}</p><details><summary>Classification and uncertainty</summary><p className="inv-kicker">{report.root_cause_code} · {report.diagnosis_classification}</p>{(report.unresolved_questions || []).map((q, i) => <p key={i}>{q}</p>)}</details></section><ModelFindings report={report}/>
            </EvidencePanel>
            <EvidencePanel id="iw-execution" title="Payment Execution" subtitle={amountMismatch ? 'Reconcile the payment instruction with verified ledger totals' : missingLedger ? 'Verify source completion against modern and legacy ledger records' : 'Compare original and related payment stages · select a stage to inspect its evidence'}>{amountMismatch ? <AmountReconciliation report={report}/> : missingLedger ? <MissingLedgerVerification report={report}/> : <ExecutionPaths {...{ report, onInspect }}/>}</EvidencePanel>
            <EvidencePanel id="iw-events" title="Processing timeline" subtitle={report.investigation_trace.length + ' recorded events · expandable event details'}><InvestigationTrace report={report}/></EvidencePanel>
            <EvidencePanel id="iw-ledger" title="Ledger verification & records" subtitle="Financial assessment, payment comparisons and complete source records"><FinancialOverview report={report}/>{amountMismatch ? <AmountReconciliation report={report}/> : missingLedger ? <MissingLedgerVerification report={report}/> : <FinancialImpact report={report}/>}<EvidenceExplorer {...{ report, onInspect }}/></EvidencePanel>
            <EvidencePanel id="iw-sources" title="Source evidence explorer" subtitle="Search and inspect the citations supporting this report"><CitationExplorer report={report}/></EvidencePanel>
            <details className="inv-section iw-raw-report"><summary>Complete saved investigation report</summary><pre>{JSON.stringify(report, null, 2)}</pre></details>
          </>}
        </>}
        </div>
        {tab === 'summary' && (!backendConnected || fixture) && !running && !historical && <details className="inv-development"><summary>Prototype run controls</summary><label className="inv-checkbox"><input type="checkbox" checked={failNext} onChange={e => setFailNext(e.target.checked)}/>Simulate a ledger evidence timeout on the next new run</label><p>Retry collects a fresh snapshot. Previous runs remain in history.</p></details>}
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
