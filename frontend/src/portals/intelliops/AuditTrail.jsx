import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Activity, ArrowRight, Banknote, CheckCircle2, ChevronLeft, ChevronRight, ClipboardList, Clock3, Copy, FileSearch, Folder, ListFilter, MessagesSquare, ShieldCheck, TriangleAlert } from 'lucide-react';
import RecordDrawer from '../../shared/components/RecordDrawer.jsx';
import { backendConnected, refreshBackend, useBankingRecords } from '../../shared/data/bankingRecords.js';
import { displayTime } from './investigation/ReportSections.jsx';
import { investigationRevision, subscribeInvestigations } from './investigation/service.js';
import { auditActor, auditLabel, BACKEND, normalizeAuditEvents, readCaseAuditHistory, SESSION, SIMULATION } from './auditTrailData.js';
import './audit-trail.css';

const base = '/intelliops';
const dateInSingapore = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit' });
const pageSize = 12;
const tabs = [['timeline', 'Case Timeline'], ['events', 'All Events']];
const categoryIcons = { Exception: TriangleAlert, Investigation: FileSearch, Resolution: ClipboardList,
  Communication: MessagesSquare, Policy: ShieldCheck, Approval: CheckCircle2, Financial: Banknote };
const referenceLabels = { sourceReference: 'Source reference', request: 'Request ID', investigation: 'Investigation ID',
  plan: 'Plan ID', version: 'Plan version', snapshot: 'Snapshot reference', assessment: 'Assessment ID',
  approval: 'Approval request ID', communication: 'Communication ID', relatedCommunication: 'Related communication ID',
  transaction: 'Transaction reference', journal: 'Journal reference' };
const query = values => '?' + new URLSearchParams(Object.entries(values).filter(([, value]) => value != null));
const timestamp = event => Number.isFinite(Date.parse(event.occurredAt)) ? Date.parse(event.occurredAt) : null;
const sortEvents = (list, newestFirst) => [...list].sort((a, b) => {
  const first = timestamp(a), second = timestamp(b);
  if (first === null || second === null) return first === second ? 0 : first === null ? 1 : -1;
  return newestFirst ? second - first : first - second;
});

function SourceBadge({ source }) {
  return <span className={`at-source ${source === BACKEND ? 'at-source-backend' : source === SIMULATION ? 'at-source-sim' : ''}`}>{source}</span>;
}

function EventTime({ event }) {
  return timestamp(event) !== null ? <time dateTime={event.occurredAt}>{displayTime(event.occurredAt)}</time> : <span>Time unavailable</span>;
}

function Empty({ title, children }) {
  return <div className="at-empty"><ListFilter size={24} aria-hidden="true"/><h3>{title}</h3><p>{children}</p></div>;
}

function useCaseAudit(caseId, shouldRead) {
  const [histories, setHistories] = useState({});
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!shouldRead) return;
    let active = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException('History request timed out', 'TimeoutError')), 12000);
    readCaseAuditHistory(caseId, controller.signal)
      .then(result => { if (active) setHistories(previous => ({ ...previous, [caseId]: { ...result, attempt } })); })
      .catch(() => { if (active) setHistories(previous => ({ ...previous,
        [caseId]: { ...previous[caseId], caseId, attempt, errors: ['Case history unavailable.'] } })); })
      .finally(() => clearTimeout(timer));
    return () => { active = false; clearTimeout(timer); controller.abort(); };
  }, [caseId, shouldRead, attempt]);
  const history = shouldRead && histories[caseId]?.attempt === attempt ? histories[caseId] : null;
  return { history, histories, loading: shouldRead && !history, retry: () => setAttempt(value => value + 1) };
}

function AuditOverview({ events }) {
  const sources = new Set(events.map(event => event.source));
  const indicator = sources.size > 1 ? 'Mixed sources' : sources.has(BACKEND) ? 'Backend records' :
    sources.has(SIMULATION) ? 'Frontend simulation' : sources.has(SESSION) ? 'Frontend session records' : 'No recorded events';
  const latest = sortEvents(events, true).find(event => timestamp(event) !== null);
  return <>
    <header className="at-header">
      <div className="page-heading"><p className="eyebrow">Operations command center</p><h1>Audit Trail</h1>
        <p>Trace investigation, customer communication, policy and approval decisions.</p></div>
      <span className={`at-source ${sources.size === 1 && sources.has(BACKEND) ? 'at-source-backend' : sources.size === 1 && sources.has(SIMULATION) ? 'at-source-sim' : ''}`}>
        <ShieldCheck size={15} aria-hidden="true"/>{indicator}</span>
    </header>
    <div className="at-overview" aria-label="Audit overview">
      <div><Activity size={20} aria-hidden="true"/><div><span>Recorded Events</span><strong>{events.length}</strong></div></div>
      <div><Folder size={20} aria-hidden="true"/><div><span>Cases Tracked</span><strong>{new Set(events.map(event => event.caseId).filter(Boolean)).size}</strong></div></div>
      <div><Clock3 size={20} aria-hidden="true"/><div><span>Latest Activity</span><strong>{latest ? <EventTime event={latest}/> : 'Unavailable'}</strong></div></div>
    </div>
  </>;
}

function CaseSelector({ cases, caseId, onSelect, searchable }) {
  const [search, setSearch] = useState('');
  const term = search.trim().toLowerCase();
  const options = cases.filter(([id, title]) => id === caseId || [id, title].some(value => value?.toLowerCase().includes(term)));
  return <div className="at-case-picker">
    {searchable && <label>Find a case<input type="search" placeholder="Case ID or exception type" value={search} onChange={event => setSearch(event.target.value)}/></label>}
    <label>Case<select value={caseId || ''} onChange={event => onSelect(event.target.value)}>
      <option value="">{searchable ? 'Select a case' : 'All cases'}</option>
      {caseId && !cases.some(([id]) => id === caseId) && <option value={caseId}>{caseId}</option>}
      {options.map(([id, title]) => <option key={id} value={id}>{title ? id + ' · ' + title : id}</option>)}
    </select></label>
    {searchable && term && !options.length && <p role="status">No cases match that search.</p>}
  </div>;
}

function Timeline({ events, caseId, loading, unavailable, onOpen }) {
  if (!caseId) return <Empty title="Choose a case">Select a case to see its recorded timeline.</Empty>;
  if (!events.length) return loading ? null : <Empty title={unavailable ? 'Case history unavailable' : 'No recorded events for this case'}>
    {unavailable ? 'Retry the history request or browse the available records in All Events.' : 'Try another case or browse All Events.'}</Empty>;
  return <ol className="at-timeline">{sortEvents(events, false).map(event => {
    const Icon = categoryIcons[event.category] || Activity;
    return <li key={event.key}>
      <span className={`at-timeline-icon at-category-${event.category.toLowerCase()}`}><Icon size={18} aria-hidden="true"/></span>
      <div className="at-timeline-main">
        <div className="at-event-heading"><h3>{event.title}</h3><EventTime event={event}/></div>
        <p>{event.summary}</p>
        <div className="at-event-meta"><SourceBadge source={event.source}/><span>{event.category}</span><span>{auditActor(event.actor)}</span>
          {event.outcome && <span className="at-outcome">{auditLabel(event.outcome)}</span>}</div>
      </div>
      <button type="button" className="rp-button at-details-action" aria-label={`View details for ${event.title}`} onClick={() => onOpen(event)}>Details<ArrowRight size={14} aria-hidden="true"/></button>
    </li>;
  })}</ol>;
}

const fields = [
  ['category', 'Category'], ['actorSource', 'Actor or source'], ['outcome', 'Outcome'],
];

function AuditTable({ events, cases, caseId, onSelect, onOpen, loading }) {
  const [filters, setFilters] = useState({ search: '', category: '', actorSource: '', outcome: '', from: '', to: '' });
  const [newest, setNewest] = useState(true);
  const [page, setPage] = useState(0);
  function filter(name, value) { setFilters(previous => ({ ...previous, [name]: value })); setPage(0); }
  const values = {
    category: [...new Set(events.map(event => event.category))].sort().map(value => [value, value]),
    actorSource: [
      ...[...new Set(events.map(event => event.source))].sort().map(value => ['source:' + value, value]),
      ...[...new Set(events.filter(event => event.actor).map(event => auditActor(event.actor)))].sort().map(value => ['actor:' + value, value]),
    ],
    outcome: [...new Set(events.map(event => auditLabel(event.outcome)).filter(Boolean))].sort().map(value => [value, value]),
  };
  const term = filters.search.trim().toLowerCase();
  const invalidDates = Boolean(filters.from && filters.to && filters.from > filters.to);
  const visible = invalidDates ? [] : sortEvents(events.filter(event => {
    const time = timestamp(event);
    const date = time === null ? '' : dateInSingapore.format(time);
    return (!caseId || event.caseId === caseId) && (!filters.category || event.category === filters.category) &&
      (!filters.actorSource || filters.actorSource === 'source:' + event.source || filters.actorSource === 'actor:' + auditActor(event.actor)) &&
      (!filters.outcome || auditLabel(event.outcome) === filters.outcome) &&
      (!filters.from || date && date >= filters.from) && (!filters.to || date && date <= filters.to) &&
      (!term || [event.title, event.id, event.caseId, event.actor, event.summary, ...Object.values(event.references)]
        .some(value => String(value ?? '').toLowerCase().includes(term)));
  }), newest);
  const pages = Math.max(1, Math.ceil(visible.length / pageSize));
  const current = Math.min(page, pages - 1);

  return <>
    <div className="at-filters">
      <label className="at-search">Search events<input type="search" placeholder="Event, case or reference" value={filters.search} onChange={event => filter('search', event.target.value)}/></label>
      <CaseSelector {...{ cases, caseId }} onSelect={value => { setPage(0); onSelect(value); }}/>
      {fields.map(([name, label]) => <label key={name}>{label}<select value={filters[name]} onChange={event => filter(name, event.target.value)}>
        <option value="">All</option>{values[name].map(([value, text]) => <option key={value} value={value}>{text}</option>)}
      </select></label>)}
      <label>From (SGT)<input type="date" value={filters.from} onChange={event => filter('from', event.target.value)}/></label>
      <label>To (SGT)<input type="date" value={filters.to} onChange={event => filter('to', event.target.value)}/></label>
    </div>
    <div className="at-table-toolbar"><p role="status">{visible.length} {visible.length === 1 ? 'event' : 'events'}</p>
      <label>Sort<select value={newest ? 'newest' : 'oldest'} onChange={event => { setNewest(event.target.value === 'newest'); setPage(0); }}>
        <option value="newest">Newest first</option><option value="oldest">Oldest first</option>
      </select></label></div>
    {invalidDates ? <p role="alert">Choose an end date on or after the start date.</p> :
      visible.length ? <>
        <table className="at-table">
          <thead><tr>{['Timestamp', 'Event', 'Case', 'Actor / Source', 'Category', 'Outcome', 'Details'].map(label => <th scope="col" key={label}>{label}</th>)}</tr></thead>
          <tbody>{visible.slice(current * pageSize, (current + 1) * pageSize).map(event => <tr key={event.key}>
            <td data-label="Timestamp"><EventTime event={event}/></td>
            <td data-label="Event"><strong>{event.title}</strong></td>
            <td data-label="Case">{event.caseId || 'Unavailable'}</td>
            <td data-label="Actor / Source"><span>{auditActor(event.actor)}</span><SourceBadge source={event.source}/></td>
            <td data-label="Category">{event.category}</td>
            <td data-label="Outcome">{event.outcome ? auditLabel(event.outcome) : 'Unavailable'}</td>
            <td data-label="Details"><button className="rp-button at-details-action" type="button" aria-label={`View details for ${event.title}`} onClick={() => onOpen(event)}>View</button></td>
          </tr>)}</tbody>
        </table>
        {pages > 1 && <nav className="at-paging" aria-label="Event pages">
          <button className="rp-button" type="button" disabled={current === 0} onClick={() => setPage(current - 1)}><ChevronLeft size={15} aria-hidden="true"/>Previous</button>
          <span>Page {current + 1} of {pages}</span>
          <button className="rp-button" type="button" disabled={current + 1 === pages} onClick={() => setPage(current + 1)}>Next<ChevronRight size={15} aria-hidden="true"/></button>
        </nav>}
      </> : loading ? null : <Empty title={events.length ? 'No events match your filters' : 'No audit events available'}>
        {events.length ? 'Change the filters or search terms to see more records.' : 'Recorded events will appear as they become available.'}
      </Empty>}
  </>;
}

function CopyValue({ label, value }) {
  const [status, setStatus] = useState('');
  return <span className="at-copy"><button className="rp-button" type="button" aria-label={`Copy ${label}`} onClick={async () => {
    try { await navigator.clipboard.writeText(String(value)); setStatus('Copied'); }
    catch { setStatus('Clipboard unavailable'); }
  }}><Copy size={14} aria-hidden="true"/>Copy</button>{status && <small role="status">{status}</small>}</span>;
}

function EventDetails({ event, knownCase }) {
  const { caseId, references: ref } = event;
  return <div className="at-event-details">
    <SourceBadge source={event.source}/><p>{event.summary}</p>
    <dl className="account-facts">
      <div><dt>Event type</dt><dd>{event.type}</dd></div><div><dt>Case</dt><dd>{caseId || 'Unavailable'}</dd></div>
      <div><dt>Timestamp</dt><dd><EventTime event={event}/>{event.occurredAt && <small>{event.occurredAt}</small>}</dd></div>
      <div><dt>Actor</dt><dd>{auditActor(event.actor)}</dd></div>
      <div><dt>Role</dt><dd>{auditActor(event.actorRole)}</dd></div>
      <div><dt>Outcome</dt><dd>{event.outcome ? auditLabel(event.outcome) : 'Unavailable'}</dd></div>
    </dl>
    <h3>Recorded references</h3>
    <dl className="at-references">{[['Event ID', event.id], ...Object.entries(ref).filter(([, value]) => value != null && value !== '')
      .map(([name, value]) => [referenceLabels[name] || auditLabel(name), value])].map(([label, value]) =>
      <div key={label}><dt>{label}</dt><dd><code>{value}</code><CopyValue {...{ label, value }}/></dd></div>)}</dl>
    <div className="rp-actions">
      {knownCase && <Link className="rp-inline" to={base + '/exceptions' + query({ case: caseId })}>Open Exception Center</Link>}
      {knownCase && ref.investigation && <Link className="rp-inline" to={base + '/investigation' + query({ case: caseId, investigation: ref.investigation })}>Open AI Investigation</Link>}
      {knownCase && ref.plan && ref.investigation && <Link className="rp-inline" to={base + '/workflows/plans' + query({ case: caseId, investigation: ref.investigation, plan: ref.plan, version: ref.version })}>Open Resolution Plan</Link>}
      {knownCase && ref.communication && ref.investigation && <Link className="rp-inline" to={base + '/workflows/communication' + query({ case: caseId, investigation: ref.investigation })}>Open Customer Communication</Link>}
      {ref.approval && caseId && <Link className="rp-inline" to={base + '/approvals' + query({ case: caseId, request: ref.approval })}>Open Approval Center</Link>}
    </div>
    <details className="at-technical"><summary>Technical Details</summary><pre>{JSON.stringify(event.metadata, null, 2)}</pre></details>
  </div>;
}

export default function AuditTrail() {
  const records = useBankingRecords();
  const revision = useSyncExternalStore(subscribeInvestigations, investigationRevision);
  const [params, setParams] = useSearchParams();
  const pendingParams = useRef(params);
  useEffect(() => { pendingParams.current = params; }, [params]);
  const refs = useRef([]);
  const tab = params.get('tab') === 'events' ? 'events' : 'timeline';
  const caseId = params.get('case') || '';
  const selectedId = params.get('event');
  const shouldRead = backendConnected && Boolean(caseId) &&
    (/^CASE-\d+$/.test(caseId) || (records.exception_cases || []).some(record => record.id === caseId));
  const { history, histories, loading, retry } = useCaseAudit(caseId, shouldRead);
  const events = useMemo(() => normalizeAuditEvents(records, Object.values(histories)), [records, histories, revision]);
  const cases = new Map((records.exception_cases || []).map(record => [record.id, record.exceptionType]));
  for (const event of events) if (event.caseId && !cases.has(event.caseId)) cases.set(event.caseId, '');
  const caseOptions = [...cases].sort(([a], [b]) => a.localeCompare(b));
  const selected = events.find(event => event.key === selectedId);
  const knownCase = (records.exception_cases || []).some(record => record.id === selected?.caseId) || Boolean(histories[selected?.caseId]?.caseRecord);
  const update = (key, value, replace = false) => {
    const next = new URLSearchParams(pendingParams.current);
    if (key !== 'tab' && tab === 'events') next.set('tab', 'events');
    if (value) next.set(key, value); else next.delete(key);
    pendingParams.current = next;
    setParams(next, { replace });
  };
  const selectCase = value => update('case', value);
  const openEvent = event => update('event', event.key);

  return <div className="rp-workspace at-workspace">
    <AuditOverview events={events}/>
    {records.connectionError && <div className="at-notice" role="alert">The backend audit snapshot could not refresh. Available records are shown below.
      <button type="button" className="rp-button" onClick={() => refreshBackend().catch(() => {})}>Retry backend refresh</button></div>}
    <section className="at-panel">
      <div className="at-tabs" role="tablist" aria-label="Audit views">
        {tabs.map(([key, title], index) => <button ref={node => { refs.current[index] = node; }} type="button" role="tab" key={key} tabIndex={tab === key ? 0 : -1}
          id={'audit-tab-' + key} aria-selected={tab === key} aria-controls={'audit-panel-' + key} onClick={() => update('tab', key)}
          onKeyDown={event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const target = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + 1) % tabs.length;
            update('tab', tabs[target][0]); refs.current[target]?.focus();
          }}>{title}</button>)}
      </div>
      <div id={'audit-panel-' + tab} role="tabpanel" aria-labelledby={'audit-tab-' + tab}>
        {tab === 'timeline' && <CaseSelector cases={caseOptions} {...{ caseId }} onSelect={selectCase} searchable/>}
        {loading && <p className="at-loading" role="status">Loading saved case records…</p>}
        {history?.errors?.length > 0 && <div className="at-notice" role="status">{history.errors.join(' ')}
          <button type="button" className="rp-button" onClick={retry}>Retry case history</button></div>}
        {history?.historyLimited && <p className="at-loading">The backend returned the latest 50 investigation requests for this case.</p>}
        {tab === 'timeline' ? <Timeline events={events.filter(event => event.caseId === caseId)} {...{ caseId, loading }}
          unavailable={Boolean(history?.errors?.length || records.connectionError)} onOpen={openEvent}/> :
          <AuditTable {...{ events, caseId, loading }} cases={caseOptions} onSelect={selectCase} onOpen={openEvent}/>}
      </div>
    </section>
    <RecordDrawer open={Boolean(selectedId)} title={selected?.title || 'Audit event details'} onClose={() => update('event', '', true)}>
      {selected ? <EventDetails key={selected.key} event={selected} {...{ knownCase }}/> : loading ? <p role="status">Looking up the event…</p> :
        <p role="status">This event reference is unavailable in the accessible audit records.</p>}
    </RecordDrawer>
  </div>;
}
