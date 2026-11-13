import React from 'react';
import { ArrowRight, CheckCircle2, ChevronRight, CircleHelp, Clock3, FileSearch, GitBranch, Layers3, Link2, ListTree, ShieldCheck, TriangleAlert, Wallet } from 'lucide-react';
import { amount, displayTime, humanize, PaymentComparison, SourceLink, Section } from './ReportSections.jsx';
import { actionPresentation, conclusionPresentation, causalEvents, eventContext, eventLabel, paymentPath, resultSummary } from './presentation.js';

const shortTime = value => value && Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat('en-SG', { timeStyle: 'medium', timeZone: 'Asia/Singapore' }).format(new Date(value)) : 'Time unavailable';
const person = (accounts, ref) => accounts.find(a => a.id === ref)?.customer || ref || 'Unavailable';
const toneIcon = tone => tone === 'positive' ? CheckCircle2 : tone === 'danger' ? TriangleAlert : tone === 'caution' ? CircleHelp : Layers3;

export function ReadyInvestigation({ original, duplicate, accounts, fixture, onStart }) {
  return <>
    <section className="cc-ready" aria-labelledby="cc-detected"><div className="cc-section-heading"><div><p className="inv-kicker">Detected by the rule engine</p><h2 id="cc-detected">Two requests. One payment?</h2></div><span className="cc-tag">Potential duplicate</span></div><p>Two payment requests share potential duplicate indicators. Their relationship and financial impact need investigation.</p>
      <div className="cc-request-pair">{[original, duplicate].map((p, i) => <article key={i} className={`cc-request ${i ? 'cc-repeated' : ''}`}><div className="cc-request-label"><span>{i ? '02 / Suspected duplicate' : '01 / Original request'}</span><span>{p?.status || 'Unavailable'}</span></div><h3><SourceLink reference={p?.id} fixture={fixture}/></h3><div className="cc-parties"><span>{person(accounts, p?.senderId)}</span><ArrowRight size={15}/><span>{person(accounts, p?.receiverId)}</span></div><strong className="cc-payment-amount">{amount(p)}</strong></article>)}</div>
    </section>
    <section className="cc-objectives" aria-labelledby="cc-objectives-title"><h2 id="cc-objectives-title">What AI will investigate</h2><div className="cc-objective-grid">{[
      [Link2, 'Payment Relationship', 'Are both requests part of the same intended payment?'],
      [GitBranch, 'Duplicate Origin', 'What caused the second request to be generated?'],
      [Wallet, 'Financial Impact', 'Did money move once, twice, or is execution unverified?'],
    ].map(([Icon, title, text], i) => <article key={title}><span className="cc-objective-icon"><Icon size={20}/></span><small>0{i + 1}</small><h3>{title}</h3><p>{text}</p></article>)}</div></section>
    <div className="cc-start"><div><strong>Follow the evidence, beyond the alert.</strong><p>Analyze instructions, processing events, retry history and ledger evidence.</p></div><button className="inv-button inv-primary" onClick={onStart}><FileSearch size={17}/>Start AI Investigation<ArrowRight size={16}/></button></div>
  </>;
}

export function DiagnosisHero({ report, onTrace }) {
  const [title, explanation] = conclusionPresentation(report);
  const v = resultSummary(report);
  const label = report.prototype === false && report.root_cause_status === 'MODEL_HYPOTHESIS' ? 'Root-cause hypothesis' : v.identified ? 'Root cause identified' : 'Root cause undetermined';
  return <section className={`cc-hero ${v.identified ? 'cc-identified' : 'cc-undetermined'}`} aria-labelledby="cc-diagnosis-title"><div className="cc-hero-top"><span className="cc-hero-label">{v.identified ? <ShieldCheck size={17}/> : <CircleHelp size={17}/>} {label}</span><span className="cc-completed" role="status"><CheckCircle2 size={15}/>Investigation Completed</span></div><h2 className="sr-only">Root Cause Analysis</h2><h3 id="cc-diagnosis-title">{title}</h3><p className="cc-hero-explanation">{explanation}</p><div className="cc-hero-footer"><span><Layers3 size={14}/>{report.evidence_strength}</span><span><Clock3 size={14}/>{displayTime(report.completed_at)}</span><button className="cc-text-button" onClick={onTrace}>View Full Investigation Trace<ArrowRight size={14}/></button></div>
      <div className="cc-classification">{humanize(report.diagnosis_classification)}</div><details className="cc-diagnosis-details"><summary>Classification and uncertainty{report.unresolved_questions.length > 0 && <span>{report.unresolved_questions.length} evidence gaps</span>}</summary><p className="inv-kicker">{report.diagnosis_classification}</p>{report.unresolved_questions.length ? <ul>{report.unresolved_questions.map(q => <li key={q}>{q}</li>)}</ul> : <p>The recorded snapshot supports this finding. Recheck current state before resolution.</p>}<p className="inv-muted">Snapshot: {displayTime(report.evidence_snapshot_at)} · {report.prototype === false ? 'Backend AI analysis with verified source checks. Historical snapshots require current-state review.' : 'Deterministic prototype analysis.'}</p></details>
    </section>;
}
export function KeyResults({ report }) {
  const v = resultSummary(report);
  return <section className="cc-result-grid" aria-label="Key investigation results">{[[Link2, 'Payment Relationship', v.relationship], [GitBranch, 'Root Cause', v.cause], [Wallet, 'Financial Outcome', v.financial]].map(([Icon, label, [title, text, tone]]) => <article key={label} className={`cc-result cc-tone-${tone}`}><div className="cc-result-label"><Icon size={17}/>{label}</div><h3>{title}</h3><p>{text}</p></article>)}</section>;
}

export function ExecutionPaths({ report, onInspect }) {
  const s = report.supporting_evidence, summary = resultSummary(report);
  return <section className="cc-execution" aria-labelledby="cc-execution-title"><div className="cc-section-heading"><div><p className="inv-kicker">From request to financial outcome</p><h2 id="cc-execution-title">Payment Execution</h2></div><span className="cc-inspect-hint">Select a stage to inspect evidence</span></div><div className="cc-path-grid">{['original', 'duplicate'].map((side, i) => {
    const { payment, nodes, assessment } = paymentPath(report, side);
    return <article key={side} className={`cc-path ${i ? 'cc-path-second' : ''}`} aria-label={i ? 'Suspected duplicate execution path' : 'Original payment execution path'}><div className="cc-path-header"><div><p className="inv-kicker">{i ? summary.separate ? '02 / Separate instruction' : '02 / Suspected duplicate' : '01 / Original payment'}</p><h3><SourceLink reference={payment?.id} fixture={s.fixture}/></h3></div><span className={`cc-tag cc-tone-${assessment.execution === 'Unknown' ? 'caution' : assessment.execution === 'Not Started' ? 'caution' : 'positive'}`}>{assessment.execution === 'Not Started' ? 'Held before execution' : assessment.execution === 'Posted' ? 'Posted' : 'Unverified'}</span></div><div className="cc-path-instruction"><span>{payment?.businessReference || 'Instruction reference unavailable'}</span><strong>{amount(payment)}</strong></div>
      <ol className="cc-path-nodes">{nodes.map(node => {
        const Icon = toneIcon(node.tone);
        return <li key={node.id}><button className={`cc-node cc-tone-${node.tone}`} onClick={() => onInspect({ node, payment, report })} aria-label={`Inspect ${node.title} for ${payment?.id || 'unavailable payment'}`}><span className="cc-node-marker"><Icon size={16}/></span><span className="cc-node-content"><strong>{node.title}</strong><small>{node.kind === 'assessment' ? 'Deterministic execution check' : node.kind === 'journal' ? 'Ledger source record' : shortTime(node.at)}{node.journalRefs.length > 0 && ` · ${node.journalRefs.join(', ')}`}</small></span><ChevronRight size={15}/></button></li>;
      })}</ol><p className="cc-path-footnote">{assessment.execution === 'Unknown' ? 'A missing journal is not proof that execution did not occur.' : assessment.execution === 'Not Started' ? 'Hold supported by processing evidence in this snapshot.' : 'Posted entries checked against amount, currency and parties.'}</p>
    </article>;
  })}</div></section>;
}

export function CausalTimeline({ report, onTrace, onInspect }) {
  const events = causalEvents(report);
  return <section className="cc-causal" aria-labelledby="cc-causal-title"><div className="cc-section-heading"><div><h2 id="cc-causal-title">How the Issue Happened</h2><p>{report.root_cause_code === 'CLIENT_RETRY_ACK_TIMEOUT' ? 'The recorded sequence behind the repeated request.' : 'Key recorded events. The sequence alone does not establish causation.'}</p></div><button className="cc-text-button" onClick={onTrace}><ListTree size={16}/>View Full Investigation Trace</button></div><ol className="cc-causal-events">{events.map(e => <li className={e.eventType === 'ACK_TIMEOUT' && report.root_cause_code === 'CLIENT_RETRY_ACK_TIMEOUT' ? 'cc-causal-trigger' : ''} key={e.id}><button onClick={() => onInspect(eventContext(report, e))}><time>{shortTime(e.occurredAt)}</time><span className="cc-causal-dot"/><strong>{eventLabel(e.eventType)}</strong><small>{e.paymentId}</small><small className="cc-causal-ref">{e.id}</small></button></li>)}</ol>{!events.length && <p className="inv-muted">No key processing events are available. Open the trace to inspect the evidence gaps.</p>}</section>;
}

export function FinancialImpact({ report }) {
  const f = report.financial_execution_assessment, s = report.supporting_evidence, v = resultSummary(report);
  const Icon = toneIcon(v.financial[2]);
  return <section className={`cc-financial cc-tone-${v.financial[2]}`} aria-labelledby="cc-financial-title"><div className="cc-financial-heading"><Icon size={23}/><div><h2 id="cc-financial-title">Financial Impact</h2><h3>{v.financial[0]}</h3></div></div><div className="cc-financial-rows inv-payment-pair">{[f.original, f.duplicate].map((p, i) => <div key={i}><span>{i ? 'Repeated request' : 'Original payment'}</span><SourceLink reference={p.payment_ref} fixture={s.fixture}/><strong>{p.execution === 'Not Started' ? 'Held · No posting started' : p.execution === 'Unknown' ? 'Execution unknown' : 'Posted'}</strong><span>{p.journals.length ? p.journals.map(ref => <SourceLink key={ref} kind="journal" reference={ref} fixture={s.fixture}/>) : p.execution === 'Not Started' ? 'Hold event verified' : 'No journal found in snapshot'}</span></div>)}</div><p>{v.financial[2] === 'danger' ? 'Duplicate financial execution requires authorized human review. No automatic reversal.' : v.financial[1]}</p><details><summary>Verification classification</summary><p className="inv-kicker">{f.classification}</p><p>{f.original.reason}</p><p>{f.duplicate.reason}</p></details></section>;
}

function EventRecords({ events, report, onInspect }) {
  return <div className="cc-event-records">{events.map(e => <button key={e.id} className="cc-event-record" onClick={() => onInspect(eventContext(report, e))}><span><strong>{eventLabel(e.eventType)}</strong><small>{e.paymentId} · {shortTime(e.occurredAt)}</small></span><span>{e.id}<ChevronRight size={14}/></span></button>)}{!events.length && <p className="inv-muted">No corresponding records are available in this snapshot.</p>}</div>;
}
function EvidenceGroup({ title, count, description, Icon, children }) {
  return <details className="cc-evidence-group"><summary><span className="cc-evidence-icon"><Icon size={18}/></span><span><strong>{title}</strong><small>{description}</small></span><span className="cc-evidence-count">{count} {count === 1 ? 'record' : 'records'}</span><ChevronRight className="cc-expand" size={17}/></summary><div className="cc-evidence-body">{children}</div></details>;
}
export function EvidenceExplorer({ report, onInspect }) {
  const s = report.supporting_evidence;
  const payments = [s.original, s.duplicate].filter(Boolean);
  const diagnostic = s.events.filter(e => ['ACK_TIMEOUT', 'RETRY_SUBMITTED', 'DUPLICATE_BLOCKED'].includes(e.eventType) || e.errorCode);
  return <section className="cc-evidence" aria-labelledby="cc-evidence-title"><div className="cc-section-heading"><div><h2 id="cc-evidence-title">Evidence Explorer</h2><p>Source records behind the findings. Expand only what you need.</p></div><span className="cc-inspect-hint"><Layers3 size={15}/>{payments.length + s.events.length + s.journals.length + s.entries.length} source records</span></div>
    <EvidenceGroup title="Payment Records" count={payments.length} description="Compare instructions, parties and processing status" Icon={Link2}><PaymentComparison report={report}/>{payments.map(p => <dl key={p.id} className="inv-detail-list"><div><dt>Payment / request ID</dt><dd>{p.id} / {p.paymentId || 'Unavailable'}</dd></div><div><dt>Business instruction</dt><dd>{p.businessReference || 'Unavailable'}</dd></div></dl>)}<p className="inv-muted">Idempotency keys are not exposed by the current shared snapshot.</p></EvidenceGroup>
    <EvidenceGroup title="Instruction and Retry Evidence" count={diagnostic.length} description="Recorded holds, retries, timeouts and correlation identifiers" Icon={GitBranch}><EventRecords events={diagnostic} report={report} onInspect={onInspect}/></EvidenceGroup>
    <EvidenceGroup title="Processing Events" count={s.events.length} description="Chronological source events and error details" Icon={ListTree}><EventRecords events={s.events} report={report} onInspect={onInspect}/></EvidenceGroup>
    <EvidenceGroup title="Ledger Journals and Entries" count={s.journals.length + s.entries.length} description={`${s.journals.length} linked journals · ${s.entries.length} ledger entries`} Icon={Wallet}>{!s.journals.length && <p>No linked journals found. Financial non-execution cannot be inferred from this alone.</p>}{s.journals.map(j => <div className="cc-journal-record" key={j.id}><div><SourceLink kind="journal" reference={j.id} fixture={s.fixture}/><span>{j.status} · {displayTime(j.postedAt)}</span></div><div className="inv-table-scroll" role="region" aria-label={`Entries for ${j.id}`} tabIndex={0}><table className="inv-table"><thead><tr><th>Entry</th><th>Account</th><th>Side</th><th>Amount</th><th>Posted</th></tr></thead><tbody>{s.entries.filter(e => e.journalId === j.id).map(e => <tr key={e.id}><td>{e.id}</td><td>{e.accountId}</td><td>{e.side}</td><td>{amount(e)}</td><td>{e.posted === false ? 'No' : 'Yes'}</td></tr>)}</tbody></table></div></div>)}</EvidenceGroup>
  </section>;
}

export function NextBestAction({ report, historical, running, onSend, onRun }) {
  const [title, meaning] = actionPresentation[report.recommended_action_code] || ['Review proposal', 'Verify the proposed action with an authorized reviewer.'];
  return <section className="cc-next" aria-labelledby="cc-next-title"><div className="cc-next-label"><ArrowRight size={18}/>Recommended next step<span>Proposal · Policy review required</span></div><div className="cc-next-main"><div><h2 id="cc-next-title">{title}</h2><p>{meaning}</p></div>{!historical && <button className="inv-button inv-primary" onClick={onSend}>Review resolution proposal<ArrowRight size={16}/></button>}</div><p className="cc-risk-note"><ShieldCheck size={15}/>{report.recommended_action_code === 'CLOSE_HELD_DUPLICATE' ? 'Confirm the repeated request remains held before closure.' : 'Verify current processing and ledger state before any action.'}</p><div className="cc-next-footer"><details><summary>Action details and supporting rationale</summary><p>{report.recommendation_reason}</p><code>{report.recommended_action_code}</code><p>{meaning}</p><p>{report.risk_consideration}</p></details>{!historical && <button className="cc-text-button" disabled={running} onClick={onRun}>Run new investigation</button>}</div><p className="inv-muted">Starting a new backend investigation may invoke a paid AI model.</p><p className="inv-muted">Resolution owns policy, approval and execution. This handoff does not approve or perform a correction.</p></section>;
}

export function StageDetails({ context }) {
  if (!context) return null;
  const { node, payment, report } = context, s = report.supporting_evidence;
  const e = node.event, j = node.journal;
  const assessment = node.assessment;
  return <div className="cc-stage-details"><p className="inv-kicker">{node.kind === 'assessment' ? 'Deterministic diagnostic check' : node.kind === 'journal' ? 'Ledger evidence' : 'Source processing event'}</p><h3>{node.title}</h3><SourceLink reference={payment?.id} fixture={s.fixture}/><p>{e?.description || assessment?.reason || 'Posted journal validated against its ledger entries.'}</p><dl className="inv-detail-list">{[
    ['Event type', e?.eventType || 'Not a processing event'], ['Timestamp', node.at ? displayTime(node.at) : `Snapshot ${displayTime(report.evidence_snapshot_at)}`],
    ['Processing stage', e?.status || payment?.status || 'Unavailable'], ['Source event ID', e?.id || 'Not applicable'],
    ['Error code', e?.errorCode || 'None recorded'], ['Correlation ID', e?.correlationId || 'Unavailable'],
  ].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>{(j || node.journalRefs?.length > 0) && <div><h3>Linked journal evidence</h3>{(j ? [j.id] : node.journalRefs).map(ref => <p key={ref}><SourceLink kind="journal" reference={ref} fixture={s.fixture}/></p>)}</div>}<p className="inv-muted">Evidence snapshot: {displayTime(report.evidence_snapshot_at)}</p></div>;
}

export function ModelFindings({ report }) {
  if (!report.llm_analysis) return null;
  const usage = report.provider_metadata?.usage;
  return <Section title="AI Evidence Analysis"><p>Model: {report.model}. Accounting facts are verified by the backend; causal hypotheses require analyst review.</p>
    {usage && <details className="iw-provider-details"><summary>Model processing metadata</summary><p className="inv-muted">Provider tokens: {usage.input_tokens ?? 'Unavailable'} input / {usage.output_tokens ?? 'Unavailable'} output. Latency: {report.provider_metadata.latency_seconds ?? 'Unavailable'} seconds.</p></details>}
    {report.financial_impact && <details><summary>Verified financial totals</summary><p>{report.financial_impact.confirmedPostedJournalCount} confirmed posted journals.</p>{Object.entries(report.financial_impact.validDebitTotals || {}).map(([currency, value]) => <p key={currency}>Debit: {currency} {value} / Credit: {currency} {report.financial_impact.validCreditTotals?.[currency] ?? 'Unavailable'}</p>)}</details>}
    <p className="inv-muted">Citation IDs are validated. Semantic support for every statement requires human review.</p>
    {report.review_flags?.length > 0 && <div className="inv-notice" role="status"><strong>Analyst review required</strong>{report.review_flags.map(flag => <p key={flag.code}>{flag.message}</p>)}</div>}
    {[['Supported findings', report.llm_analysis.facts], ['Unconfirmed hypotheses', report.llm_analysis.hypotheses]].map(([title, claims]) => <details className="iw-claim-group" key={title}><summary>{title}<span>{claims.length} findings</span></summary>{claims.length ? claims.map((claim, i) => <article key={i}><p>{claim.statement}</p><details className="iw-claim-citations"><summary>{claim.evidence_refs.length} supporting citations</summary><p>{claim.evidence_refs.map(ref => <code key={ref}>{ref} </code>)}</p></details></article>) : <p>No additional hypotheses returned.</p>}</details>)}</Section>;
}
