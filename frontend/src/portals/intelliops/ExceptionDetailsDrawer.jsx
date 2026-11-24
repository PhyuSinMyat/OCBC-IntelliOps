import React, { useEffect, useState } from 'react';
import { ArrowRight, ClipboardList, ExternalLink, FileText, ShieldCheck } from 'lucide-react';
import { Link } from 'react-router-dom';
import RecordDrawer from '../../shared/components/RecordDrawer.jsx';
import CaseStatus, { canonicalCaseStatus } from '../../shared/components/CaseStatus.jsx';
import { TableBadge } from '../../shared/components/TablePresentation.jsx';
import { exceptionRequest } from '../../shared/api/banking.js';
import { addExceptionNote, backendConnected, closeException, remediateException } from '../../shared/data/bankingRecords.js';
import { casePresentation, caseTime, paymentAmount, readable, unavailable } from './exceptionDetailData.js';
import './exception-details.css';

const actions = {
  'Missing Ledger Posting': ['Post Missing Ledger Journal', 'Posts a balanced corrective journal if the posting is still missing.'],
  'Amount Mismatch': ['Post Shortfall Adjustment', 'Posts a corrective journal only if a verified posting shortfall remains.'],
  'Duplicate Transaction': ['Reject Duplicate Transaction', 'Rejects the verified held payment and resolves the case. The original posting stays in place.'],
  'Payment Processing Failure': ['Retry Failed Payment', 'Retries the instruction after validating the current payment and account records. A successful retry posts a journal.'],
};
const eventTitles = {
  DETECTED: 'Exception detected', SEVERITY_RECALCULATED: 'Severity reassessed',
  REVIEW_NOTE_ADDED: 'Review note added', DUPLICATE_REJECTED: 'Held payment rejected',
  RESOLVED: 'Case resolved', CLOSED: 'Case closed',
};
const approvalStatuses = ['PENDING_APPROVAL', 'APPROVED_AWAITING_ACTION', 'REJECTED_NEEDS_REVISION'];
const internalEvidence = /scenario|root.?cause|investigation|idempotencykey(?!smatch)/i;
const identifiers = /(?:id|ids|reference|references|fingerprint)$/i;

function TechnicalFields({ fields }) {
  return <dl className="case-detail-fields">
    {Object.entries(fields).filter(([key]) => !internalEvidence.test(key)).map(([key, value]) => <div key={key}>
      <dt>{readable(key)}</dt>
      <dd>{Array.isArray(value) ? value.length ? <ul>{value.map((item, index) => <li key={index}>
        <TechnicalValue name={key} value={item}/>
      </li>)}</ul> : 'None recorded' : <TechnicalValue name={key} value={value}/>}</dd>
    </div>)}
  </dl>;
}

function TechnicalValue({ name, value }) {
  if (value && typeof value === 'object') return <TechnicalFields fields={value}/>;
  if (value == null || value === '') return unavailable;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return identifiers.test(name) ? <code>{value}</code> : String(value);
}

function useInvestigationHistory(id) {
  const [history, setHistory] = useState(null);
  useEffect(() => {
    if (!backendConnected || !id) return;
    const controller = new AbortController();
    exceptionRequest('/api/exceptions/' + encodeURIComponent(id) + '/investigations?limit=20&offset=0', { signal: controller.signal })
      .then(data => { if (!controller.signal.aborted) setHistory({ id, rows: data.investigations || [] }); })
      .catch(() => { if (!controller.signal.aborted) setHistory({ id, failed: true, rows: [] }); });
    return () => controller.abort();
  }, [id]);
  return history?.id === id ? history : null;
}

function CaseActivity({ record, records, history, detailLoading, detailError }) {
  const caseEvents = record.timeline || records.audit_events
    .filter(row => row.reference === record.id && row.action === 'EXCEPTION_DETECTED')
    .map(row => ({ ...row, actionType: 'DETECTED' }));
  const runs = (history?.rows || []).flatMap(item => {
    const start = item.report?.started_at || item.created_at;
    const end = item.report?.completed_at;
    return [
      ...(start ? [{ id: item.request_id + '-start', title: 'Investigation started', createdAt: start }] : []),
      ...(end ? [{ id: item.request_id + '-end', title: 'Investigation completed', createdAt: end }] : []),
    ];
  });
  const events = [...caseEvents, ...runs].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return <section className="case-detail-section">
    <h3>Case Activity</h3>
    {events.length > 0 && <ol className="case-detail-activity">{events.map(event => <li key={event.id}>
      <strong>{event.title || eventTitles[event.actionType] || readable(event.actionType)}</strong>
      <div>{event.actor && <span>{readable(event.actor)} · </span>}<time dateTime={event.createdAt}>{caseTime(event.createdAt)}</time></div>
      {(event.details?.note || event.details?.summary) && <p>{event.details.note || event.details.summary}</p>}
    </li>)}</ol>}
    {detailLoading || (backendConnected && !history) ? <p role="status">Loading case activity…</p> :
      detailError || history?.failed ? <p>Some case activity is unavailable.</p> :
      events.every(event => event.actionType === 'DETECTED') && <p>No additional case activity has been recorded.</p>}
  </section>;
}

export default function ExceptionDetailsDrawer({
  caseId, record, records, detailLoading, detailError, onClose, onUpdate, from, investigation, busy, setBusy,
}) {
  const [note, setNote] = useState('');
  const [feedback, setFeedback] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [closing, setClosing] = useState(false);
  useEffect(() => {
    if (!closing) return;
    const timer = setTimeout(onClose, 180);
    return () => clearTimeout(timer);
  }, [closing, onClose]);
  const history = useInvestigationHistory(caseId);
  const report = history?.rows.find(row => row.investigation_id && row.report);
  const status = canonicalCaseStatus(record?.status);
  const reviewable = backendConnected && ['OPEN', 'IN_PROGRESS'].includes(status);
  const isAnalyst = backendConnected && records.role === 'ANALYST';
  const evidence = record?.evidence || {};
  const action = isAnalyst && reviewable && actions[record?.exceptionType];
  // The live endpoint revalidates all records. Suppress rejection when detection already
  // proves that both payments posted or explicitly rules out an original instruction link.
  const canRemediate = action && !(record.exceptionType === 'Duplicate Transaction' &&
    (evidence.financialAssessment === 'TWO_POSTINGS_CONFIRMED' || evidence.originalInstructionLinked === false));
  const closeable = backendConnected && status === 'RESOLVED';
  const view = record && casePresentation(record, records);
  const severityChange = record?.timeline?.findLast(item => item.actionType === 'SEVERITY_RECALCULATED');
  const assessment = severityChange?.details?.severityAssessment ?? evidence.severityAssessment;

  async function perform(operation, success) {
    if (busy || closing) return;
    setBusy(true);
    setFeedback(null);
    try {
      onUpdate(await operation(record.id, note.trim()));
      setConfirming(false);
      setNote('');
      setFeedback({ message: success });
    } catch (error) {
      setFeedback({ error: true, message: error.message });
    } finally {
      setBusy(false);
    }
  }

  const investigationPath = '/intelliops/investigation?case=' + encodeURIComponent(caseId || '') +
    (report ? '&investigation=' + encodeURIComponent(report.investigation_id) : '');
  const resolutionAvailable = report?.stale === false && ['OPEN', 'IN_PROGRESS'].includes(status);
  const resolutionPath = resolutionAvailable && investigationPath.replace('/investigation?', '/workflows/plans?');
  const investigationLabel = report ? 'View Investigation' : 'Open AI Investigation';
  function requestClose() {
    if (busy || closing) return;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) onClose();
    else setClosing(true);
  }

  return <RecordDrawer open={Boolean(caseId)} title={record?.exceptionType || (detailLoading ? 'Loading exception' : 'Case unavailable')}
    onClose={requestClose} lockScroll className={closing ? 'case-detail-dialog is-closing' : 'case-detail-dialog'}
    header={(title, close) => <header className="case-detail-header">
      <div><p className="case-detail-reference">Exception Details{caseId && ' · ' + caseId}</p>
        {title}
        {record && <div className="case-detail-meta"><TableBadge value={record.severity}/><CaseStatus value={record.status}/>
          <span>Detected <time dateTime={record.createdAt}>{caseTime(record.createdAt)}</time></span></div>}
      </div>{close}
    </header>}
    footer={record && !investigation && <footer className="case-detail-footer">
      {approvalStatuses.includes(status) && <span>Approval details are unavailable from the case record.</span>}
      {resolutionAvailable && <Link className="case-detail-secondary" state={{ from }} to={investigationPath}>{investigationLabel}</Link>}
      <Link className="simulation-button case-detail-primary" state={{ from }} to={resolutionPath || investigationPath}>
        {resolutionAvailable ? 'Open Resolution Plans' : investigationLabel}<ArrowRight size={16} aria-hidden="true"/>
      </Link>
    </footer>}>
    <div className="case-detail-body">
      {detailError && <p role="alert" className="case-detail-feedback">Unable to load the latest case details.</p>}
      {!record && <p role={detailLoading ? 'status' : undefined}>{detailLoading ? 'Retrieving case details…' : 'This case is unavailable in the current source dataset.'}</p>}
      {view && <>
        <section className="case-detail-section case-detail-summary">
          <ClipboardList size={19} aria-hidden="true"/><div><h3>Exception Summary</h3><p>{view.summary}</p></div>
        </section>
        <section className="case-detail-section">
          <h3>Financial Overview</h3>
          <dl className="case-detail-metrics">{view.metrics.map(([label, value, description]) => <div key={label}>
            <dt>{label}</dt><dd>{value}{description && <small>{description}</small>}</dd>
          </div>)}</dl>
        </section>
        <section className="case-detail-section">
          <h3>Detection Evidence</h3>
          {view.facts.length ? <ul className="case-detail-findings">{view.facts.map(({ title, detail }) => <li key={title}>
            <FileText size={16} aria-hidden="true"/><div><strong>{title}</strong><p>{detail}</p></div>
          </li>)}</ul> : <p>Verification required. The available case details do not include specific detection observations.</p>}
          {assessment?.severity === record.severity && assessment?.reason && <p className="case-detail-assessment"><strong>Severity assessment</strong> {assessment.reason}</p>}
          <details className="case-detail-technical">
            <summary>View Technical Evidence</summary>
            {Object.keys(evidence).length ? <TechnicalFields fields={evidence}/> : <p>No technical evidence is available.</p>}
          </details>
        </section>
        <section className="case-detail-section">
          <h3>Related Transactions</h3>
          <div className="case-detail-related">{view.payments.map(({ id, label, payment }) => <article key={id}>
            <div><strong>{label}</strong><code>{id}</code><p>{payment ? paymentAmount(payment) + ' · ' + readable(payment.status) : unavailable}</p></div>
            {payment && <Link className="case-detail-secondary" to={'/payments/transactions?transaction=' + encodeURIComponent(id)}>
              View Payment <ExternalLink size={14} aria-hidden="true"/>
            </Link>}
          </article>)}</div>
          {!view.payments.length && <p>No related payment references are available.</p>}
          {view.journals.length > 0 && <><h4>Related Journals</h4><div className="case-detail-related">
            {view.journals.map(({ id, journal }) => <article key={id}>
              <div><strong>{id === record.remediation?.journalReference ? 'Corrective Journal' : 'Ledger Journal'}</strong><code>{id}</code>
                {!journal && <p>{unavailable}</p>}</div>
              {journal && <Link className="case-detail-secondary" to={'/core-banking/journals?journal=' + encodeURIComponent(id)}>
                View Journal <ExternalLink size={14} aria-hidden="true"/>
              </Link>}
            </article>)}</div></>}
        </section>
        {record.resolutionSummary && <section className="case-detail-section"><h3>Resolution</h3><p>{record.resolutionSummary}</p></section>}
        <CaseActivity {...{ record, records, history, detailLoading, detailError }}/>
        {(reviewable || closeable) && <section className="case-detail-section">
          {reviewable && <form onSubmit={event => { event.preventDefault(); if (note.trim()) perform(addExceptionNote, 'Review note added.'); }}>
            <h3>Review Note</h3>
            <label htmlFor="case-note">Evidence reviewed or approval note</label>
            <textarea id="case-note" value={note} onChange={event => setNote(event.target.value)} maxLength={1000} disabled={busy}/>
            <button className="case-detail-secondary" disabled={busy || !note.trim()}>Add Review Note</button>
          </form>}
          {(canRemediate || closeable) && <div className="case-detail-controlled">
            <h3><ShieldCheck size={17} aria-hidden="true"/> Controlled Action</h3>
            <p>{closeable ? 'Closes the resolved case and records the lifecycle change.' : action[1]}</p>
            {confirming ? <div className="case-detail-control-buttons">
              <button type="button" autoFocus className="case-detail-secondary" disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>
              <button type="button" className="case-detail-secondary case-detail-sensitive" disabled={busy}
                onClick={() => closeable ? perform(closeException, 'Case closed.') : perform(remediateException, 'Resolution completed and source records refreshed.')}>
                {busy ? 'Submitting…' : 'Confirm ' + (closeable ? 'Case Closure' : action[0])}
              </button>
            </div> : <button type="button" className="case-detail-secondary" disabled={busy} onClick={() => setConfirming(true)}>
              {closeable ? 'Close Resolved Case' : action[0]}
            </button>}
          </div>}
        </section>}
        {feedback && <p className="case-detail-feedback" role={feedback.error ? 'alert' : 'status'}>{feedback.message}</p>}
      </>}
    </div>
  </RecordDrawer>;
}
