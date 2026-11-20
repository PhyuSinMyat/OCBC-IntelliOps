import React, { useEffect, useRef, useState } from 'react';
import CaseStatus from '../../../shared/components/CaseStatus.jsx';
import TablePagination, { useTablePagination } from '../../../shared/components/TablePagination.jsx';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Bot, ChevronRight, FileSearch, TriangleAlert } from 'lucide-react';
import { contextSearch } from '../../../app/navigation.js';
import { backendConnected, useBankingRecords } from '../../../shared/data/bankingRecords.js';
import { isInvestigable } from '../investigation/analysis.js';
import { displayTime, humanize } from '../investigation/ReportSections.jsx';
import { actionTitle, financialMetrics, isOpenCase, postingDiscrepancy, readResolutionCase, readResolutionQueue, resolutionPreview } from './resolutionData.js';
import ResolutionPlanner, { useResolutionGeneration } from './ResolutionPlanner.jsx';
import { customerResponses, readCommunicationBundle } from './communicationBackendService.js';
import { hasNewCommunicationContext, readResolutionVersions, resolutionPolicySearch } from './resolutionBackendService.js';
import './resolution-plans.css';

const exceptions = '/intelliops/exceptions';
const investigation = '/intelliops/investigation';
const workspace = '/intelliops/workflows';
const toContext = (path, caseId, reportId) =>
  path + contextSearch(new URLSearchParams({ case: caseId || '', investigation: reportId || '' }));
const reportDestination = (caseId, report) => report?.fixture
  ? investigation + '?' + new URLSearchParams({ fixture: report.fixture, investigation: report.investigation_id })
  : toContext(investigation, caseId, report?.investigation_id);

function useResolutionRead(key, read) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState(null);
  useEffect(() => {
    let current = true;
    read().then(data => {
      if (current) setResult({ key, attempt, data });
    }).catch(error => {
      if (current) setResult({ key, attempt, error });
    });
    return () => { current = false; };
  }, [key, attempt]);
  return {
    ...(result?.key === key && result.attempt === attempt ? result : { loading: true }),
    retry: () => setAttempt(value => value + 1),
  };
}

function Header({ caseId, report, record }) {
  const caseLink = toContext(exceptions, caseId);
  const reportLink = reportDestination(caseId, report);
  return <header className="rp-heading">
    <nav className="rp-breadcrumb" aria-label="Breadcrumb">
      <Link to={caseLink}>Exception Center</Link><ChevronRight size={14} aria-hidden="true"/>
      <Link to={reportLink}>AI Investigation</Link><ChevronRight size={14} aria-hidden="true"/>
      <span aria-current="page">Resolution Plans</span>
    </nav>
    <div className="rp-heading-row">
      <div className="page-heading">
        <h1>{caseId ? 'Resolution Plan' : 'Resolution Plans'}</h1>
        <p>{caseId ? 'Review AI-recommended next steps and prepare a controlled resolution proposal.' : 'Review investigation findings and prepare resolution proposals for operational exceptions.'}</p>
      </div>
      {caseId && <div className="rp-actions">
        <Link className="rp-button" to={reportLink}><ArrowLeft size={16} aria-hidden="true"/>Back to Investigation</Link>
        {record && !report?.fixture && <Link className="rp-button" to={caseLink}>View Case Details<ChevronRight size={16} aria-hidden="true"/></Link>}
      </div>}
    </div>
  </header>;
}

function Loading({ children }) {
  return <section className="rp-panel rp-loading" role="status">
    <p>{children}</p>
    <div aria-hidden="true"/><div aria-hidden="true"/><div aria-hidden="true"/>
  </section>;
}

function Notice({ title, children, action, error = false }) {
  const Icon = error ? TriangleAlert : FileSearch;
  return <section className={`rp-panel rp-notice${error ? ' rp-notice-warning' : ''}`} role={error ? 'alert' : undefined}>
    <span className="rp-icon"><Icon size={21} aria-hidden="true"/></span>
    <div><h2>{title}</h2><p>{children}</p>{action && <div className="rp-actions">{action}</div>}</div>
  </section>;
}

function Queue({ records, rememberSelection }) {
  const active = records.filter(record => isOpenCase(record) && isInvestigable(record));
  const caseKey = JSON.stringify(backendConnected ? active.map(record => record.id).sort() : []);
  const { data, loading, error, retry } = useResolutionRead(caseKey, () => readResolutionQueue(JSON.parse(caseKey)));
  const reports = [...(data?.reports || [])].sort((a, b) => String(b.report.completed_at || b.created_at).localeCompare(String(a.report.completed_at || a.created_at)));
  const pagination = useTablePagination(reports.length);
  const browse = <Link className="rp-button" to={exceptions}>Browse Exception Center<ArrowRight size={16} aria-hidden="true"/></Link>;
  const retryButton = <button className="rp-button" onClick={retry} type="button">Retry</button>;
  if (!backendConnected) return <Notice title="Saved investigations unavailable" action={browse}>Connect to the banking backend to browse accepted reports, or open Resolution Plans from an investigation handoff in this session.</Notice>;
  if (loading) return <Loading>Loading eligible investigations…</Loading>;
  if (error || (data.failed && !data.reports.length)) return <Notice title="Investigation queue unavailable" error action={<>{retryButton}{browse}</>}>Some investigation histories could not be retrieved. Retry to check for accepted reports.</Notice>;
  if (!data.reports.length) return <Notice title="No eligible investigations" action={browse}>Open cases with an accepted investigation report appear here when they are ready for analyst review.</Notice>;

  const byCase = new Map(active.map(record => [record.id, record]));
  return <>
    {data.failed > 0 && <Notice title="Queue may be incomplete" error action={retryButton}>Some investigation histories could not be retrieved.</Notice>}
    <section className="rp-panel rp-queue" aria-labelledby="rp-queue-title">
      <div className="rp-panel-heading"><h2 id="rp-queue-title">Eligible cases</h2><span className="rp-badge">{reports.length} {reports.length === 1 ? 'case' : 'cases'}</span></div>
      <ul className="rp-queue-list">{reports.slice(pagination.start, pagination.end).map(item => {
        const { report, stale } = item;
        const metrics = financialMetrics(report);
        const impact = (report.exception_type === 'MISSING_LEDGER_POSTING' || metrics.length < 3 ? metrics : [...metrics].reverse())
          .find(([, value]) => value !== null);
        return <li className="rp-queue-item" key={report.case_id}>
          <div><strong>{report.case_id}</strong><span>{byCase.get(report.case_id)?.exceptionType || humanize(report.exception_type)}</span></div>
          <div><span>Investigation</span><strong>{humanize(report.validation_status || 'ACCEPTED')}</strong><EvidenceStatus status={freshness(stale)}/></div>
          <div><span>Recommended action</span><strong>{actionTitle(report)}</strong></div>
          <div><span>{impact?.[0] || 'Financial impact'}</span><strong>{impact ? impact[1] : 'Unavailable'}</strong><span>Proposal preview</span></div>
          <Link className="rp-button" onClick={() => rememberSelection(item)} to={toContext(workspace + '/plans', report.case_id, report.investigation_id)}>Open Resolution<ArrowRight size={16} aria-hidden="true"/></Link>
        </li>;
      })}</ul>
      <TablePagination pagination={pagination} label="Eligible resolution case pages" recordLabel="cases"/>
    </section>
  </>;
}

function freshness(stale, checking = false) {
  if (checking) return 'Checking';
  if (stale === true) return 'Stale';
  if (stale === false) return 'Current';
  return 'Unavailable';
}

function EvidenceStatus({ status }) {
  return <span className={`rp-badge rp-evidence-status rp-status-${status.toLowerCase()}`}>
    <span className="rp-status-dot" aria-hidden="true"/>{status}
  </span>;
}

function FinancialImpact({ report, evidenceStatus }) {
  const metrics = financialMetrics(report);
  const available = metrics.some(([, value]) => value !== null);
  return <section className="rp-panel rp-financial" aria-labelledby="rp-financial-title">
    <div className="rp-panel-heading"><h2 id="rp-financial-title">Financial impact</h2>{available && <span className="rp-badge">{evidenceStatus === 'Current' ? 'Current source evidence' : 'Saved snapshot'}</span>}</div>
    {available ? <>
      <dl className="rp-metrics">{metrics.map(([label, value, note, warning]) => <div key={label} className={warning ? 'rp-metric-warning' : undefined}>
        <dt>{label}</dt><dd>{value ?? 'Unavailable'}</dd><small>{note}</small>
      </div>)}</dl>
      {evidenceStatus !== 'Current' && <p className="rp-muted">Amounts reflect the saved investigation snapshot.</p>}
    </> : <p>Verified financial data is unavailable for this report.</p>}
  </section>;
}

function EvidenceReferences({ references, kind, fixture }) {
  if (!references.length) return 'Unavailable';
  const isPayment = kind === 'payment';
  const source = isPayment ? 'Payment' : 'Journal';
  const route = isPayment ? '/payments/transactions?transaction=' : '/core-banking/journals?journal=';
  return references.map(ref => fixture ? <span key={ref}>{ref} (fixture)</span> :
    <Link key={ref} className="rp-inline" to={route + encodeURIComponent(ref)} aria-label={`${source} ${ref}`}>
      {ref}<ChevronRight size={14} aria-hidden="true"/>
    </Link>);
}

function SupportingEvidence({ report, evidenceStatus }) {
  const citations = new Set(report.evidence_references || []);
  const findings = (report.llm_analysis?.facts || []).filter(fact =>
    fact.statement && fact.evidence_refs?.length && fact.evidence_refs.every(ref => citations.has(ref))
  ).slice(0, 3);
  const refs = prefix => [...citations].filter(ref => ref.startsWith(prefix + ':')).map(ref => ref.slice(prefix.length + 1));
  const payments = refs('payment');
  const journals = refs('journal');
  const classification = report.financial_execution_assessment?.classification;
  const discrepancy = postingDiscrepancy(report);
  return <details className="rp-panel rp-evidence">
    <summary>Supporting evidence</summary>
    <dl className="rp-evidence-list">
      <div><dt>Investigation status</dt><dd>
        <span>{report.prototype === false ? humanize(report.validation_status || 'COMPLETED') : 'Simulated investigation'}</span>
        <small>Snapshot captured {displayTime(report.evidence_snapshot_at)}</small>
      </dd></div>
      <div><dt>Financial verification</dt><dd>{report.prototype === false && classification ? <>
        <span>{humanize(classification)}</span>
        <small>{evidenceStatus === 'Current' ? 'Saved evidence matches current sources' : 'Assessment from the saved snapshot'}</small>
        {discrepancy && <small>Signed difference (posted minus instructed): {discrepancy.signed}</small>}
      </> : 'Unavailable'}</dd></div>
      <div><dt>Source records</dt><dd>{payments.length || journals.length
        ? `${payments.length} ${payments.length === 1 ? 'payment' : 'payments'} · ${journals.length} ledger ${journals.length === 1 ? 'journal' : 'journals'} cited`
        : 'Payment and ledger references unavailable'}</dd></div>
    </dl>
    {(payments.length > 0 || journals.length > 0) && <details className="rp-findings rp-reference-details">
      <summary>Transaction and journal IDs</summary>
      <ul>
        {payments.length > 0 && <li><strong>Payments</strong><div className="rp-record-links"><EvidenceReferences references={payments} kind="payment" fixture={report.fixture}/></div></li>}
        {journals.length > 0 && <li><strong>Ledger journals</strong><div className="rp-record-links"><EvidenceReferences references={journals} kind="journal" fixture={report.fixture}/></div></li>}
      </ul>
    </details>}
    {findings.length ? <details className="rp-findings"><summary>Key cited findings</summary><ul>{findings.map((finding, index) => <li key={index}>{finding.statement}<small>{finding.evidence_refs.join(' · ')}</small></li>)}</ul></details> : <p className="rp-muted">Key cited findings are unavailable.</p>}
    <details className="rp-findings rp-reference-details">
      <summary>Full references</summary>
      <ul>
        <li><strong>Investigation</strong><small>{report.investigation_id}</small></li>
        {[...citations].map(ref => <li key={ref}><small>{ref}</small></li>)}
      </ul>
    </details>
  </details>;
}

function PlanDetail({ record, item, requestedPlan, requestedVersion, checkingEvidence = false }) {
  const { report, stale } = item;
  const evidenceStatus = freshness(stale, checkingEvidence);
  const caseId = report.case_id;
  const reportId = report.investigation_id;
  const [versions, setVersions] = useState([]);
  const [communications, setCommunications] = useState([]);
  const [workflowError, setWorkflowError] = useState('');
  const [communicationRevision, setCommunicationRevision] = useState(0);
  const [selectedVersion, setSelectedVersion] = useState(null);
  useEffect(() => {
    let current = true;
    Promise.all([readResolutionVersions(caseId, reportId), readCommunicationBundle(caseId, reportId)])
      .then(([plans, communicationBundle]) => {
        if (!current) return;
        setVersions(plans); setCommunications(communicationBundle.communications || []);
        setCommunicationRevision(communicationBundle.contextRevision || 0);
        setSelectedVersion(plans.find(version => version.planId === requestedPlan && String(version.version) === requestedVersion)?.version ?? null);
      })
      .catch(error => { if (current) setWorkflowError(error.message); });
    return () => { current = false; };
  }, [caseId, reportId, requestedPlan, requestedVersion]);
  const currentPlan = versions.at(-1);
  const plan = versions.find(item => item.version === selectedVersion) || currentPlan;
  const responses = customerResponses(communications);
  const pending = hasNewCommunicationContext(currentPlan, communicationRevision);
  const reportLink = reportDestination(caseId, report);
  const assessment = report.financial_execution_assessment;
  const communicationTo = toContext(workspace + '/communication', caseId, reportId);
  const policyTo = workspace + '/policy' + resolutionPolicySearch(toContext('', caseId, reportId), plan);
  const generation = useResolutionGeneration({ report, plan, current: currentPlan, pending, responses,
    onGenerated: nextVersions => { setVersions(nextVersions); setSelectedVersion(null); } });
  const generating = generation.stage !== null;
  const historical = Boolean(plan && plan !== currentPlan);
  const nextLabel = generating ? (plan ? 'Reassessing…' : 'Generating…') :
    !plan ? 'Generate AI Resolution Plan' : historical ? 'Return to Current Plan' :
      pending ? 'Reassess AI Resolution' : 'Continue to Policy Assessment';
  const nextDescription = !plan ? 'Generate and persist a plan from the saved investigation.' :
    historical ? 'Return to the latest plan to continue this case.' :
      pending ? 'Update the plan with the latest customer response before policy handoff.' :
        'Open the Policy Assessment preview with the current plan and its customer snapshot.';
  return <>
    <Header caseId={caseId} report={report} record={record}/>
    <div className="rp-case-context">
      <div><span>Case ID</span><strong>{caseId}</strong></div>
      <div><span>Exception type</span><strong>{record?.exceptionType || humanize(report.exception_type || 'EXCEPTION_TYPE_UNAVAILABLE')}</strong></div>
      <div><span>Case status</span><CaseStatus value={record.status}/></div>
      <div><span>Evidence status</span><div role="status"><EvidenceStatus status={evidenceStatus}/></div></div>
    </div>
    {!isOpenCase(record) && <Notice error title="Case is no longer open">This report is available for reference.</Notice>}
    {evidenceStatus === 'Stale' && <Notice error title="Evidence stale">Source records have changed since the investigation. Refresh the investigation evidence before submitting a proposal.</Notice>}
    {evidenceStatus === 'Unavailable' && <Notice error title="Evidence freshness unavailable">Current source evidence could not be compared with this report.</Notice>}
    <section className="rp-hero" aria-labelledby="rp-recommendation-title">
      <div>
        <div className="rp-hero-label">
          <Bot size={19} aria-hidden="true"/><h2 id="rp-recommendation-title">AI Investigation Findings</h2>
        </div>
        <dl className="rp-investigation-facts">
          <div><dt>{report.root_cause_status === 'MODEL_HYPOTHESIS' ? 'Root-cause hypothesis' : 'Root-cause summary'}</dt>
            <dd>{report.root_cause_title || 'Root cause not established'}</dd></div>
          <div><dt>Investigation status</dt><dd>{report.prototype === false ? humanize(report.validation_status || 'COMPLETED') : 'Simulated'}</dd></div>
          <div><dt>{report.prototype === false ? 'Saved financial classification' : 'Simulated financial classification'}</dt>
            <dd>{assessment?.classification ? humanize(assessment.classification) : 'Unavailable'}</dd></div>
        </dl>
      </div>
      <Link className="rp-inline" to={reportLink}>View Full Investigation<ArrowRight size={16} aria-hidden="true"/></Link>
    </section>
    <FinancialImpact {...{ report, evidenceStatus }}/>
    {workflowError && <Notice error title="Resolution workflow unavailable">{workflowError}</Notice>}
    <ResolutionPlanner {...{ report, communicationTo, plan, versions, pending, responses, generation }} hasFinancials={financialMetrics(report).some(([, value]) => value !== null)}
      onSelect={setSelectedVersion}/>
    <section className="rp-panel rp-next" aria-labelledby="rp-next-title">
      <div><h2 id="rp-next-title">Next actions</h2><p>{nextDescription}</p></div>
      <div className="rp-actions">
        <Link className="rp-button" to={plan ? communicationTo : reportLink}>{plan ? 'View Customer Communication' : 'View AI Investigation'}</Link>
        {plan && !historical && !pending && !generating
          ? <Link className="rp-button rp-primary" to={policyTo}>{nextLabel}<ArrowRight size={16} aria-hidden="true"/></Link>
          : <button className="rp-button rp-primary" type="button" disabled={generating || (!historical && !generation.supported)}
            onClick={historical ? () => setSelectedVersion(null) : generation.generate}>{nextLabel}<ArrowRight size={16} aria-hidden="true"/></button>}
      </div>
    </section>
    <SupportingEvidence {...{ report, evidenceStatus }}/>
  </>;
}

function SelectedCase({ caseId, reportId, localCase, queueItem, requestedPlan, requestedVersion }) {
  const { data, error, loading, retry } = useResolutionRead(JSON.stringify([caseId, reportId, localCase?.id]), () =>
    readResolutionCase(caseId, reportId, localCase)
  );
  const preview = loading && resolutionPreview(localCase, caseId, reportId, queueItem);
  if (preview) return <PlanDetail {...preview} {...{ requestedPlan, requestedVersion }} checkingEvidence/>;
  if (data?.record && data.item && !reportId) return <Navigate replace to={toContext(workspace + '/plans', caseId, data.item.report.investigation_id)}/>;
  if (data?.record && data.item) return <PlanDetail {...data} {...{ requestedPlan, requestedVersion }}/>;
  const investigate = <Link className="rp-button" to={toContext(investigation, caseId)}>Open AI Investigation<ArrowRight size={16} aria-hidden="true"/></Link>;
  const queue = <Link className="rp-button" to={workspace + '/plans'}>Browse Resolution Plans</Link>;
  return <>
    <Header caseId={caseId} record={data?.record}/>
    {loading ? <Loading>Loading case and investigation evidence…</Loading> :
      error && error.status !== 404 ? <Notice title="Resolution details unavailable" error action={<><button className="rp-button" type="button" onClick={retry}>Retry</button>{queue}</>}>{error.message}</Notice> :
      !data?.record ? <Notice title="Case unavailable" action={queue}>This case could not be found in the current dataset.</Notice> :
      !isInvestigable(data.record) ? <Notice title="Exception type unavailable for resolution planning" action={queue}>This exception type does not yet have a backend evidence collector.</Notice> :
      <Notice title={reportId ? 'Saved investigation unavailable' : 'Accepted investigation required'} action={<>{investigate}{queue}</>}>
        {reportId ? 'The specified report could not be found for this case.' : 'Review an accepted investigation report before preparing a resolution.'}
      </Notice>}
  </>;
}

export default function ResolutionPlans() {
  const [params] = useSearchParams();
  const queueSelection = useRef(null);
  const records = useBankingRecords().exception_cases || [];
  const caseId = params.get('case');
  const reportId = params.get('investigation');
  const requestedPlan = params.get('plan');
  const requestedVersion = params.get('version');
  return <div className="rp-workspace">
    {caseId ? <SelectedCase key={JSON.stringify([caseId, reportId, requestedPlan, requestedVersion])} {...{ caseId, reportId, requestedPlan, requestedVersion }} queueItem={queueSelection.current} localCase={records.find(record => record.id === caseId)}/> : <>
      <Header/>
      {reportId ? <Notice title="Case context required" action={<Link className="rp-button" to={workspace + '/plans'}>Browse Resolution Plans</Link>}>Open a case to view its saved investigation.</Notice> : <Queue records={records} rememberSelection={item => { queueSelection.current = item; }}/>}
    </>}
  </div>;
}
