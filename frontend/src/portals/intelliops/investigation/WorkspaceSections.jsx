import React, { useState } from 'react';
import { ArrowRight, Clock3, ShieldCheck, TriangleAlert, GitBranch, Search, CheckCircle2, PauseCircle } from 'lucide-react';
import { amount, displayTime, humanize } from './ReportSections.jsx';
import { actionPresentation, causalEvents, eventContext, eventLabel, resultSummary } from './presentation.js';

export function FinancialOverview({ report }) {
  const f = report.financial_impact;
  const money = (movement, side) => movement?.currency && movement[side] != null ? `${movement.currency} ${movement[side]}` : 'Not established';
  const metrics = f ? [
    ['Posted journals', f.confirmedPostedJournalCount ?? 'Not established', 'Deterministically verified'],
    ['Sender debit', money(f.senderFinancialMovement, 'debit'), 'Outgoing accounting side'],
    ['Receiver credit', money(f.receiverFinancialMovement, 'credit'), 'Incoming accounting side'],
  ] : [['Payment amount', amount(report.supporting_evidence.original), 'Source payment record'], ['Original execution', report.financial_execution_assessment.original.execution, 'Snapshot assessment'], ['Repeated request', report.financial_execution_assessment.duplicate.execution === 'Not Started' ? 'Held' : report.financial_execution_assessment.duplicate.execution, 'Snapshot assessment']];
  const summary = resultSummary(report);
  return <section className="iw-financial" aria-labelledby="iw-financial-title"><div className="iw-section-line"><h2 id="iw-financial-title">Financial impact</h2><span><ShieldCheck size={14}/>Source verified</span></div><div className="iw-metrics">{metrics.map(([label, value, note]) => <div key={label}><span>{label}</span><strong>{value}</strong><small>{note}</small></div>)}</div><p className={`iw-outcome iw-outcome-${summary.financial[2]}`}>{summary.financial[0]} <span>· {summary.financial[1]}</span></p><small className="inv-muted">Excess amount is not established by these totals alone. Debit and credit are separate accounting sides.</small></section>;
}

export function AnalystAttention({ report, viewed }) {
  const flags = [...(report.review_flags || []).map(f => ['Analyst review', f.message]), ...(report.unresolved_questions || []).map(q => ['Uncertainty', q]), ...(report.validation_notes || []).map(n => ['Validation note', typeof n === 'string' ? n : n.message])].filter(([, text]) => text);
  if (viewed.stale === true) flags.unshift(['Stale investigation', 'Current source evidence has changed. Revalidate before action.']);
  if (viewed.durable && viewed.stale == null) flags.unshift(['Freshness unknown', 'Current source comparison is unavailable.']);
  if (!flags.length) return null;
  const urgent = flags.filter(([label]) => ['Stale investigation', 'Freshness unknown', 'Analyst review'].includes(label));
  const routine = flags.filter(f => !urgent.includes(f));
  const previews = routine.slice(0, 2).map(([, text]) => text.length > 125 ? text.slice(0, 122) + '…' : text);
  return <section className="iw-attention"><div className="iw-section-line"><h2><TriangleAlert size={18}/>Needs analyst attention</h2><span>{flags.length} review items</span></div>{urgent.length > 0 && <ul className="iw-important-notes">{urgent.map(([label, text], i) => <li key={i}><strong>{label}</strong><span>{text}</span></li>)}</ul>}{routine.length > 0 && <><div className="iw-attention-preview">{previews.map((text, i) => <p key={i}>{text}</p>)}</div><details className="iw-review-details"><summary><span>{routine.filter(([label]) => label === 'Uncertainty').length} uncertainties · {routine.filter(([label]) => label === 'Validation note').length} validation notes</span><span>Review details</span></summary><ul>{routine.map(([label, text], i) => <li key={i}><strong>{label}</strong><span>{text}</span></li>)}</ul></details></>}</section>;
}

export function PaymentRelationshipFlow({ report }) {
  const s = report.supporting_evidence;
  const paths = ['original', 'duplicate'].map(side => {
    const payment = s[side];
    const request = (s.requests || []).find(r => r.paymentReference === payment?.id || r.paymentId === payment?.paymentId);
    return { payment, request, assessment: report.financial_execution_assessment[side] };
  });
  const [a, b] = paths.map(p => p.request);
  const shared = a?.integrityValid === true && b?.integrityValid === true && a.businessInstructionId && a.businessInstructionId === b.businessInstructionId;
  const distinct = a?.authorizationValid === true && b?.authorizationValid === true && a.authorizationId && b.authorizationId && a.authorizationId !== b.authorizationId && a.businessInstructionId && b.businessInstructionId && a.businessInstructionId !== b.businessInstructionId;
  const retry = b?.retryValid === true && b.retryOfRequestId === a?.id;
  return <section className="iw-flow" aria-label="Payment relationship"><div className="iw-section-line"><div><p className="inv-kicker">Follow the instruction</p><h2>Payment relationship</h2></div><span><GitBranch size={16}/>{shared ? 'Shared business instruction' : distinct ? 'Distinct authorized instructions' : 'Relationship not established'}</span></div><div className="iw-flow-paths">{paths.map(({ payment, request, assessment }, i) => <article key={i} className={`iw-flow-path ${assessment.execution === 'Not Started' ? 'iw-flow-held' : ''}`}><div className="iw-flow-origin"><span className="iw-flow-number">0{i + 1}</span><div><strong>{i ? retry ? 'System retry' : distinct ? 'Second authorized request' : shared ? 'Repeated request' : 'Related request' : 'Original request'}</strong><span>{request?.origin ? humanize(request.origin) + ' origin' : 'Origin unavailable'}{request?.authorizationValid === true ? ' · Authorization verified' : ''}</span></div></div><div className="iw-flow-connector"><span/ ><ArrowRight size={16}/></div><div className="iw-flow-payment"><strong>{amount(payment)}</strong><span>{payment?.status || 'Status unavailable'}</span><details><summary>Payment identifiers</summary><code>{payment?.id || 'Unavailable'}</code><p>Instruction: {request?.businessInstructionId || 'Unavailable'}</p>{request?.authorizationId && <p>Authorization: {request.authorizationId}</p>}{retry && i === 1 && <p>Retry of: {b.retryOfRequestId}</p>}</details></div><div className="iw-flow-connector"><span/><ArrowRight size={16}/></div><div className="iw-flow-outcome">{assessment.execution === 'Not Started' ? <PauseCircle size={20}/> : assessment.execution === 'Posted' ? <CheckCircle2 size={20}/> : <TriangleAlert size={20}/>}<div><strong>{assessment.execution === 'Not Started' ? 'Held before execution' : assessment.execution === 'Posted' ? 'Posting verified' : 'Execution unverified'}</strong><span>{assessment.valid_journals?.length ? `${assessment.valid_journals.length} verified ${assessment.valid_journals.length === 1 ? 'journal' : 'journals'}` : 'No verified posting in snapshot'}</span><details><summary>Verification sources</summary><p>{assessment.reason}</p>{assessment.valid_journals?.map(ref => <p key={ref}><code>{ref}</code></p>)}</details></div></div></article>)}</div></section>;
}

export function EvidencePanel({ id, title, subtitle, children, open = false }) {
  return <details className="iw-evidence-panel" id={id} open={open || undefined}><summary><span><strong>{title}</strong><small>{subtitle}</small></span><span className="iw-disclose-icon">+</span></summary><div className="iw-evidence-content">{children}</div></details>;
}

export function InvestigationSkeleton() {
  return <div className="iw-skeleton" role="status" aria-label="Loading saved investigations"><span/><span/><div><span/><span/><span/></div><p>Loading saved investigations…</p></div>;
}

export function KeyTimeline({ report, onEvidence, onInspect }) {
  const chronology = causalEvents(report);
  const events = chronology.length > 6 ? [...chronology.slice(0, 5), chronology.at(-1)] : chronology;
  return <section className="iw-timeline"><div className="iw-section-line"><h2>What happened</h2><button className="cc-text-button" onClick={onEvidence}>View full timeline<ArrowRight size={14}/></button></div><ol>{events.map(e => <li key={e.id}><span className="iw-event-dot"/><button onClick={() => onInspect(eventContext(report, e))}><strong>{eventLabel(e.eventType)}</strong><time>{displayTime(e.occurredAt)}</time></button></li>)}</ol>{!events.length && <p className="inv-muted">No key source events are available.</p>}</section>;
}

export function SavedHistory({ runs, latest, viewed, onOpen, onRefresh, loading, hasMore, onMore, canRefresh = true }) {
  return <section className="iw-history"><div className="iw-section-line"><div><h2>Investigation history</h2><p className="inv-muted">Saved findings for this case. Opening a report does not run a new investigation.</p></div>{canRefresh && <button className="inv-button" disabled={loading} onClick={onRefresh}>Refresh saved history</button>}</div>{!runs.length && <div className="iw-history-empty"><Clock3 size={28}/><h3>No saved investigations yet</h3><p>Start an investigation from Summary when you are ready.</p></div>}{[...runs].reverse().map(r => <article key={r.investigation_id} className={`iw-history-row ${viewed?.investigation_id === r.investigation_id ? 'iw-history-selected' : ''}`}><div className="iw-history-icon"><Clock3 size={18}/></div><div><div className="iw-history-meta"><span>{displayTime(r.completed_at || r.started_at)}</span><span className="cc-tag">{humanize(r.run_status)}</span><span>{r.stale === true ? 'Stale' : r.stale === false ? 'Evidence matches' : 'Freshness unknown'}</span>{r === latest && <span>Latest record</span>}</div><h3>{r.report?.root_cause_title || 'No accepted report available'}</h3><p>{r.report?.model || 'Model unavailable'} · {actionPresentation[r.report?.recommended_action_code]?.[0] || 'No proposed action'}</p>{r.report?.review_flags?.map((f, i) => <p className="inv-warning" key={i}>{f.message}</p>)}{r.error && <p className="inv-error">{r.error}</p>}<details><summary>Report identifiers</summary><code>{r.investigation_id}</code></details></div>{r.report && <button className="inv-button" onClick={() => onOpen(r.investigation_id)}>Open saved report<ArrowRight size={14}/></button>}</article>)}{hasMore && <button className="inv-button" disabled={loading} onClick={onMore}>Load older investigations</button>}</section>;
}

export function CitationExplorer({ report }) {
  const [selected, setSelected] = useState(null), [copied, setCopied] = useState('');
  const [query, setQuery] = useState(''), [filter, setFilter] = useState('all');
  const s = report.supporting_evidence;
  const records = { payment: [s.original, s.duplicate].filter(Boolean), event: s.events, journal: s.journals, entry: s.entries, request: s.requests || [], instruction: s.instructions || [] };
  const refs = [...new Set([...(report.evidence_references || []), ...(report.root_cause_evidence_refs || []), ...[...(report.llm_analysis?.facts || []), ...(report.llm_analysis?.hypotheses || [])].flatMap(c => c.evidence_refs || [])])];
  const split = selected?.indexOf(':');
  const kind = selected?.slice(0, split), id = selected?.slice(split + 1);
  const source = selected && records[kind]?.find(r => String(r.id ?? r.requestId ?? r.instructionId) === id);
  const visible = refs.filter(ref => (filter === 'all' || ref.startsWith(filter + ':')) && ref.toLowerCase().includes(query.toLowerCase()));
  return <section className="inv-section iw-citations"><h2>Source evidence explorer</h2><p className="inv-muted">Select a citation to inspect its saved source record.</p><div className="iw-source-tools"><label><Search size={17}/><input aria-label="Search source citations" placeholder="Search source identifiers…" value={query} onChange={e => setQuery(e.target.value)}/></label><select aria-label="Source type" value={filter} onChange={e => setFilter(e.target.value)}><option value="all">All source types</option>{[...new Set(refs.map(ref => ref.split(':')[0]))].map(kind => <option key={kind} value={kind}>{humanize(kind)}</option>)}</select><span>{visible.length} sources</span></div><div className="iw-citation-list">{visible.map(ref => <button key={ref} aria-pressed={selected === ref} onClick={() => { setSelected(ref); setCopied(''); }}>{ref}</button>)}</div>{!visible.length && <p>No matching source references.</p>}{selected && <div className="iw-source"><strong>{selected}</strong><button className="cc-text-button" onClick={async () => { try { await navigator.clipboard.writeText(selected); setCopied('Copied'); } catch { setCopied('Copy unavailable. Select the identifier to copy manually.'); } }}>Copy identifier</button><span role="status">{copied}</span>{source ? <><dl className="inv-detail-list">{Object.entries(source).filter(([, v]) => v == null || typeof v !== 'object').map(([k, v]) => <div key={k}><dt>{humanize(k)}</dt><dd>{String(v ?? 'Unavailable')}</dd></div>)}</dl><details><summary>Complete source payload</summary><pre>{JSON.stringify(source, null, 2)}</pre></details></> : <p>Source unavailable. This citation cannot be resolved in the saved snapshot.</p>}</div>}</section>;
}
