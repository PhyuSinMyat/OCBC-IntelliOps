import React, { useEffect, useRef, useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Building2, ChevronDown, ChevronRight, ChevronUp, Eye, FileText, LockKeyhole, MessagesSquare, RefreshCw, ShieldCheck, UserRound } from 'lucide-react';
import { contextSearch } from '../../../app/navigation.js';
import { useBankingRecords } from '../../../shared/data/bankingRecords.js';
import { displayTime, humanize } from '../investigation/ReportSections.jsx';
import { cachedResolutionCase, readResolutionCase } from './resolutionData.js';
import { hasNewCommunicationContext, readResolutionVersions, resolutionPolicySearch } from './resolutionBackendService.js';
import {
  communicationContext, communicationTypes, defaultMessage, responseTypes, validateDraft,
} from './communicationService.js';
import { readCommunicationBundle, retryCustomerEmail, sendCustomerEmail, syncCustomerInbox } from './communicationBackendService.js';
import './customer-communication.css';

const workspace = '/intelliops/workflows';
const exceptions = '/intelliops/exceptions';
const investigation = '/intelliops/investigation';
const options = values => Object.entries(values).map(([value, label]) => <option key={value} value={value}>{label}</option>);
const unavailableCustomer = 'Customer identity unavailable';

function WorkflowProgress({ search, policySearch }) {
  return <nav className="cm-progress" aria-label="Resolution progress"><ol>
    <li><Link to={workspace + '/plans' + search}>Resolution Plan</Link></li>
    <li aria-current="step">Communication</li>
    <li><Link to={workspace + '/policy' + policySearch}>Policy Assessment</Link></li>
  </ol></nav>;
}

function PageHeader({ caseId, search }) {
  return <header className="cm-header">
    <div className="page-heading">
      <p className="eyebrow">Resolution Workspace</p><h1>Customer Communication</h1>
      <p>Send customer email and import linked replies from the backend Gmail mailbox.</p>
    </div>
    {caseId && <div className="cm-actions">
      <Link className="cm-button" to={workspace + '/plans' + search}><ArrowLeft size={16} aria-hidden="true"/>Back to Resolution Plan</Link>
      <Link className="cm-button" to={exceptions + '?case=' + encodeURIComponent(caseId)}>View Case Details<ChevronRight size={16} aria-hidden="true"/></Link>
    </div>}
  </header>;
}

function StatePanel({ title, children, action, error = false }) {
  return <section className="cm-panel cm-state" role={error ? 'alert' : undefined}>
    <div className="cm-icon"><MessagesSquare size={22} aria-hidden="true"/></div>
    <div><h2>{title}</h2><p>{children}</p>{action && <div className="cm-actions">{action}</div>}</div>
  </section>;
}

const recommendationText = {
  recommended: 'Recommended', optional: 'Optional', unnecessary: 'Not required', undetermined: 'Review needed',
};

function ImpactSummary({ context, record, plan, status, evidenceCurrent }) {
  return <>
    <dl className="cm-context-strip">
      <div><dt>Case ID</dt><dd>{record.id}</dd></div>
      <div><dt>Exception type</dt><dd>{record.exceptionType}</dd></div>
      <div><dt>Communication status</dt><dd role="status">{status}</dd></div>
      <div><dt>Customer communication</dt><dd><span className={`cm-chip${context.recommendation === 'recommended' ? ' cm-chip-accent' : ''}`}>{recommendationText[context.recommendation]}</span></dd></div>
    </dl>
    <section className="cm-impact" aria-labelledby="cm-impact-title">
      <div className="cm-section-heading"><h2 id="cm-impact-title">Customer impact</h2><span className="cm-chip">{evidenceCurrent ? 'Current source evidence' : 'Saved investigation snapshot'}</span></div>
      <dl className="cm-customer">
        <div><dt>Affected customer</dt><dd>{context.customerName || unavailableCustomer}</dd>
          <p className="cm-identity-status">{context.customerName ? 'Linked to the debit account' : 'Identity unverified'}</p></div>
        <div><dt>Debit account</dt><dd>{context.maskedAccount || 'Not available'}</dd></div>
        <div><dt>Related transaction</dt><dd>{context.transactionId
          ? <Link className="cm-link" to={'/payments/transactions?transaction=' + encodeURIComponent(context.transactionId)}>{context.transactionId}<ChevronRight size={14} aria-hidden="true"/></Link>
          : 'Not available'}</dd></div>
      </dl>
      {context.metrics.length > 0 ? <dl className="cm-metrics">{context.metrics.map(([label, value, , warning]) =>
        <div key={label} className={warning ? 'cm-amount-warning' : undefined}><dt>{label}</dt><dd>{value || 'Not available'}</dd></div>
      )}</dl> : <p>Verified financial amounts are not available for this investigation.</p>}
      <p className="cm-impact-note"><ShieldCheck size={15} aria-hidden="true"/>No correction has been executed through this workspace.</p>
      {plan && <p className="cm-impact-note"><strong>Persisted resolution proposal V{plan.version}</strong> {plan.resolutionTitle}</p>}
    </section>
  </>;
}

function MessageComposer({ context, evidenceCurrent, onRecord, feedback, onDraftChange }) {
  const [type, setType] = useState('INCIDENT_NOTIFICATION');
  const [editedDraft, setEditedDraft] = useState(null);
  const [recipientEmail, setRecipientEmail] = useState('');
  const message = editedDraft || defaultMessage(type, context, evidenceCurrent);
  const previewRef = useRef(null);
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const canSend = Boolean(context.customerId && context.customerName);
  const validDraft = Boolean(recipientEmail.trim()) && !validateDraft(message.subject, message.body, recipientEmail);
  function change(field, value) {
    setEditedDraft({ ...message, [field]: value });
    setError('');
    onDraftChange(true);
  }
  function validate() {
    const validation = recipientEmail.trim() ? validateDraft(message.subject, message.body, recipientEmail) : 'Enter the customer email address.';
    setError(validation);
    return !validation;
  }
  return <section className="cm-panel cm-composer" aria-labelledby="cm-compose-title">
    <div className="cm-section-heading"><h2 id="cm-compose-title">Message composer</h2><span className="cm-chip"><LockKeyhole size={13} aria-hidden="true"/>Backend email</span></div>
    <form onSubmit={async event => {
      event.preventDefault();
      if (sending || !validate()) return;
      setSending(true);
      try { await onRecord({ type, ...message, recipientEmail }); }
      catch (failure) { setError(failure.message); }
      finally { setSending(false); }
    }} noValidate>
      <label>Recipient<input readOnly value={context.customerName || unavailableCustomer}/></label>
      <label>Recipient email<input type="email" value={recipientEmail} maxLength={254} required autoComplete="email" onChange={event => {
        setRecipientEmail(event.target.value); setError(''); onDraftChange(true);
      }}/></label>
      <label><span id="cm-channel-label">Communication type</span><select aria-labelledby="cm-channel-label" value={type} onChange={event => {
        setType(event.target.value); setEditedDraft(null); setError(''); onDraftChange(true);
      }}>{options(communicationTypes)}</select></label>
      <label>Subject<input value={message.subject} onChange={event => change('subject', event.target.value)} maxLength={160} required/></label>
      <label><span id="cm-message-label">Message</span><textarea aria-labelledby="cm-message-label" value={message.body} onChange={event => change('body', event.target.value)} maxLength={3500} rows={8} required/></label>
      {!canSend && <p className="cm-advisory">A linked customer is required to send email.</p>}
      {error && <p className="cm-error" role="alert">{error}</p>}
      {feedback && <p className="cm-feedback" role="status">{feedback}</p>}
      <div className="cm-actions cm-composer-actions">
        <button className="cm-button" type="button" aria-haspopup="dialog" aria-controls="cm-preview"
          onClick={() => { if (validate()) previewRef.current.showModal(); }}><Eye size={16} aria-hidden="true"/>Preview Message</button>
        <button className="cm-button cm-primary" type="submit" disabled={!canSend || !validDraft || sending}>
          {sending ? 'Sending Email…' : 'Send Customer Email'}
        </button>
      </div>
    </form>
    <dialog id="cm-preview" ref={previewRef} className="cm-preview" aria-labelledby="cm-preview-title">
      <div className="cm-section-heading"><h3 id="cm-preview-title">Message preview</h3>
        <form method="dialog"><button autoFocus className="cm-button">Close Preview</button></form>
      </div>
      <p>To {context.customerName || unavailableCustomer}{recipientEmail.trim() && <> · {recipientEmail.trim()}</>}</p>
      <strong>{message.subject}</strong><p className="cm-message-body">{message.body}</p>
    </dialog>
  </section>;
}

function TimelineMessage({ entry, context, related, responded, onRetry }) {
  const [expanded, setExpanded] = useState(false);
  const incoming = entry.direction === 'INCOMING';
  const observation = entry.direction === 'SYSTEM';
  const Icon = observation ? FileText : incoming ? UserRound : Building2;
  const sender = incoming ? context.customerName || unavailableCustomer : observation ? 'Operations observation' : 'Bank Operations';
  const status = entry.status === 'SENT'
    ? responded ? 'Responded' : entry.communicationType === 'INCIDENT_NOTIFICATION' ? 'Sent · awaiting response' : 'Email sent'
    : entry.status === 'FAILED' ? 'Email delivery failed'
    : entry.status === 'UNKNOWN' ? 'Delivery outcome uncertain'
    : entry.status === 'PENDING' || entry.status === 'SENDING' ? 'Email delivery in progress'
    : observation ? 'No response recorded' : 'Customer email reply';
  const bodyId = `cm-timeline-message-${entry.id}`;
  const ToggleIcon = expanded ? ChevronUp : ChevronDown;

  return <li className={`cm-event cm-event-${entry.direction.toLowerCase()}`}>
    <span className="cm-event-icon"><Icon size={16} aria-hidden="true"/></span>
    <article>
      <div className="cm-event-heading"><strong>{sender}</strong><span className="cm-chip">{entry.simulated ? 'Simulated' : 'Email'}</span></div>
      <p className="cm-event-meta">{communicationTypes[entry.communicationType] || responseTypes[entry.communicationType] || 'Customer Email Reply'}</p>
      {entry.subject && <h3 className={expanded ? undefined : 'cm-event-subject-preview'}>{entry.subject}</h3>}
      {observation ? <p className="cm-message-body">{entry.body}</p> : <>
        {!expanded && <p className="cm-event-preview">{entry.body.replace(/\s+/g, ' ').trim()}</p>}
        <div id={bodyId} className="cm-event-full" hidden={!expanded}><p className="cm-message-body">{entry.body}</p></div>
      </>}
      <div className="cm-event-footer">
        <time dateTime={entry.createdAt}>{displayTime(entry.createdAt)}</time>
        <span className="cm-chip">{status}</span>
      </div>
      {!observation && <button className="cm-event-toggle" type="button" aria-expanded={expanded} aria-controls={bodyId} onClick={() => setExpanded(value => !value)}>
        {expanded ? 'Show less' : 'View full message'}<ToggleIcon size={15} aria-hidden="true"/>
      </button>}
      {entry.status === 'FAILED' && <button className="cm-button" type="button" onClick={() => onRetry(entry.id)}>Retry Email Delivery</button>}
      {(related || entry.recordedBy || entry.recipientEmail) && <details className="cm-event-foot">
        <summary>Audit details</summary>
        {entry.recipientEmail && <p>Recipient email: {entry.recipientEmail}</p>}
        {related && <p>Linked to {related.subject}.</p>}
        {entry.recordedBy && <p>Recorded by {humanize(entry.recordedBy)}.</p>}
        <p>Message ID: {entry.id}</p>
      </details>}
    </article>
  </li>;
}

function Timeline({ history, context, onRetry }) {
  if (!history.length) return <div className="cm-timeline-empty">
    <span className="cm-icon"><MessagesSquare size={21} aria-hidden="true"/></span>
    <h3>No communication recorded yet</h3><p>Prepare and send an incident notification to begin the conversation.</p>
  </div>;

  const ordered = [...history].sort((a, b) => (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0));
  const byId = new Map(history.map(entry => [entry.id, entry]));
  const repliedTo = new Set(history.filter(entry => entry.direction === 'INCOMING').map(entry => entry.relatedCommunicationId));
  return <ol className="cm-timeline" aria-label="Recorded communications, oldest first">{ordered.map(entry =>
    <TimelineMessage key={entry.id} {...{ entry, context, onRetry }} related={byId.get(entry.relatedCommunicationId)} responded={repliedTo.has(entry.id)}/>
  )}</ol>;
}

function CommunicationWorkspace({ record, item, banking, refreshStatus, onRetry }) {
  const { report, stale } = item;
  const context = communicationContext(record, report, banking.payment_transactions || []);
  return <CaseConversation key={JSON.stringify([context.caseId, context.investigationId, context.customerId])}
    context={context} recipientContext={context} {...{ record, refreshStatus, onRetry }} evidenceCurrent={stale === false}/>;
}

function CaseConversation({ context, recipientContext, record, evidenceCurrent, refreshStatus, onRetry }) {
  const [history, setHistory] = useState([]);
  const [resolvedContext, setResolvedContext] = useState(recipientContext);
  const [plan, setPlan] = useState(null);
  const [contextRevision, setContextRevision] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [draft, setDraft] = useState(false);
  const [feedback, setFeedback] = useState('');
  useEffect(() => {
    let current = true;
    Promise.all([readCommunicationBundle(context.caseId, context.investigationId), readResolutionVersions(context.caseId, context.investigationId)])
      .then(([bundle, plans]) => { if (current) {
        setHistory(bundle.communications || []); setContextRevision(bundle.contextRevision || 0); setPlan(plans.at(-1) || null);
        if (bundle.recipient) setResolvedContext(previous => ({ ...previous,
          customerId: bundle.recipient.customerId, customerName: bundle.recipient.customerName,
          transactionId: bundle.recipient.transactionId,
          maskedAccount: bundle.recipient.accountId ? '••••' + bundle.recipient.accountId.slice(-4) : previous.maskedAccount,
        }));
      } })
      .catch(error => { if (current) setLoadError(error.message); });
    return () => { current = false; };
  }, [context.caseId, context.investigationId]);
  const messageCount = history.filter(item => item.direction !== 'SYSTEM').length;
  const notification = history.findLast(item => item.communicationType === 'INCIDENT_NOTIFICATION' && item.direction === 'OUTGOING'
    && item.status === 'SENT');
  const latestReply = notification && history.findLast(item => item.relatedCommunicationId === notification.id);
  const hasResponse = Boolean(notification && history.some(item => item.relatedCommunicationId === notification.id && item.direction === 'INCOMING'));
  const latestOutgoing = history.findLast(item => item.direction === 'OUTGOING');
  const status = draft ? 'Draft' : hasResponse ? 'Response recorded' : latestReply ? 'No response recorded' :
    notification ? 'Awaiting response' : latestOutgoing?.status === 'FAILED' ? 'Email delivery failed' :
    latestOutgoing?.status === 'UNKNOWN' ? 'Delivery outcome uncertain' : history.length ? 'Communication recorded' : 'No communication recorded';
  const search = contextSearch(new URLSearchParams({ case: context.caseId, investigation: context.investigationId }));
  const needsReassessment = hasNewCommunicationContext(plan, contextRevision);
  const policySearch = resolutionPolicySearch(search, plan, needsReassessment ? 'reassessment-required' : 'current');
  const nextCopy = context.recommendation === 'recommended' && !notification
    ? 'Communication is recommended. No incident notification has been recorded. You can continue to policy review.'
    : context.recommendation === 'optional' || context.recommendation === 'unnecessary'
      ? 'Customer communication is not required for this case. Continue to policy review when ready.'
      : 'Review the policy requirements for this case. Customer email does not verify a payment or authorise a correction.';
  return <>
    <PageHeader caseId={context.caseId} search={search}/>
    <WorkflowProgress {...{ search, policySearch }}/>
    {needsReassessment && <p className="cm-reassessment" role="status"><strong>Proposal needs reassessment.</strong> V{plan.version} omits newer customer communication. <Link className="cm-link" to={workspace + '/plans' + search}>Reassess in Resolution Plans</Link></p>}
    {refreshStatus === 'checking' && <p className="cm-advisory" role="status">Showing the saved investigation while current evidence is checked.</p>}
    {refreshStatus === 'timeout' && <div className="cm-actions">
      <p className="cm-advisory" role="status">The evidence check timed out. The saved investigation remains visible.</p>
      <button className="cm-button" type="button" onClick={onRetry}>Retry evidence check</button>
    </div>}
    <ImpactSummary context={resolvedContext} {...{ record, plan, status, evidenceCurrent }}/>
    {loadError && <p className="cm-error" role="alert">{loadError}</p>}
    <p className="cm-session"><ShieldCheck size={16} aria-hidden="true"/>Outbound email is delivered by the backend. Customer replies are imported from the configured Gmail inbox.</p>
    <div className="cm-grid">
      <MessageComposer context={resolvedContext} {...{ evidenceCurrent, feedback }} onDraftChange={value => { setDraft(value); setFeedback(''); }}
        onRecord={async message => { const updated = await sendCustomerEmail(resolvedContext, message); setHistory(updated); setContextRevision(updated.length); setDraft(false); const sent = updated.at(-1); setFeedback(sent?.status === 'SENT' ? 'Customer email sent and persisted.' : sent?.status === 'FAILED' ? 'Email was saved, but SMTP delivery failed. You can retry from the timeline.' : 'Email was saved; delivery outcome requires review.'); }}/>
      <section className="cm-panel cm-conversation" aria-labelledby="cm-conversation-title">
        <div className="cm-section-heading cm-timeline-heading">
          <div><h2 id="cm-conversation-title">Conversation Timeline</h2><span className="cm-chip">{messageCount} {messageCount === 1 ? 'message' : 'messages'}</span></div>
          <button className="cm-button" type="button" disabled={syncing || !notification} onClick={async () => {
            setSyncing(true); setLoadError('');
            try {
              const bundle = await syncCustomerInbox(context.caseId, context.investigationId);
              setHistory(bundle.communications || []); setContextRevision(bundle.contextRevision || 0);
              setFeedback(bundle.importedCount ? `${bundle.importedCount} customer ${bundle.importedCount === 1 ? 'reply' : 'replies'} imported from Gmail.` : 'No new linked customer replies were found.');
            } catch (failure) { setLoadError(failure.message); }
            finally { setSyncing(false); }
          }}><RefreshCw size={15} aria-hidden="true"/>{syncing ? 'Checking Gmail...' : 'Check Gmail Replies'}</button>
        </div>
        <Timeline history={history} context={resolvedContext} onRetry={async communicationId => {
          try { const updated = await retryCustomerEmail(resolvedContext, communicationId); setHistory(updated); setContextRevision(updated.length); setFeedback(updated.find(item => item.id === communicationId)?.status === 'SENT' ? 'Customer email sent.' : 'Email retry failed; review the delivery status.'); }
          catch (failure) { setLoadError(failure.message); }
        }}/>
      </section>
    </div>
    <section className="cm-panel cm-next" aria-labelledby="cm-next-title">
      <div><h2 id="cm-next-title">Next actions</h2><p>{nextCopy}</p></div>
      <div className="cm-actions">
        <Link className="cm-button" to={workspace + '/plans' + search}>Back to Resolution Plan</Link>
        {needsReassessment ? <button className="cm-button cm-primary" type="button" disabled>Continue to Policy Assessment<ArrowRight size={16} aria-hidden="true"/></button> :
          <Link className="cm-button cm-primary" to={workspace + '/policy' + policySearch}>Continue to Policy Assessment<ArrowRight size={16} aria-hidden="true"/></Link>}
      </div>
    </section>
  </>;
}

function SelectedCommunication({ caseId, investigationId, search, banking }) {
  const [load, setLoad] = useState(null);
  const [retry, setRetry] = useState(0);
  const localCase = (banking.exception_cases || []).find(record => record.id === caseId);
  function retryLoad() {
    setLoad(null);
    setRetry(value => value + 1);
  }
  useEffect(() => {
    let current = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(
      new DOMException('The case evidence check took too long. Retry to load the investigation.', 'TimeoutError')
    ), 12000);
    readResolutionCase(caseId, investigationId, localCase, { signal: controller.signal })
      .then(data => { if (current) setLoad({ data }); })
      .catch(error => { if (current) setLoad({ error }); })
      .finally(() => clearTimeout(timer));
    return () => { current = false; clearTimeout(timer); controller.abort(); };
  }, [caseId, investigationId, retry]);

  const refreshStatus = !load ? 'checking' : load.error?.name === 'TimeoutError' ? 'timeout' : undefined;
  const { record, item } = load?.data || (refreshStatus && cachedResolutionCase(localCase, investigationId)) || {};
  if (record?.id === caseId && item?.report?.prototype === false) {
    if (!investigationId) return <Navigate replace to={workspace + '/communication' + contextSearch(
      new URLSearchParams({ case: caseId, investigation: item.report.investigation_id })
    )}/>;
    return <CommunicationWorkspace {...{ record, item, banking, refreshStatus }} onRetry={retryLoad}/>;
  }
  const queue = <Link className="cm-button" to={workspace + '/plans'}>Browse Resolution Plans<ArrowRight size={16} aria-hidden="true"/></Link>;
  const openInvestigation = <Link className="cm-button" to={investigation + '?case=' + encodeURIComponent(caseId)}>Open AI Investigation<ArrowRight size={16} aria-hidden="true"/></Link>;
  return <>
    <PageHeader {...{ caseId, search }}/>
    {!load ? <section className="cm-panel cm-loading" role="status"><p>Loading case and investigation context…</p><div aria-hidden="true"/><div aria-hidden="true"/></section>
      : load.error && load.error.status !== 404
        ? <StatePanel title="Case context unavailable" error action={<><button className="cm-button" onClick={retryLoad}>Retry</button>{queue}</>}>{load.error.message}</StatePanel>
        : !record ? <StatePanel title="Case unavailable" action={queue}>The selected case could not be found.</StatePanel>
        : <StatePanel title="Accepted investigation required" action={<>{openInvestigation}{queue}</>}>Open the case in AI Investigation and review an accepted report before recording customer communications.</StatePanel>}
  </>;
}

export default function CustomerCommunication() {
  const [params] = useSearchParams();
  const banking = useBankingRecords();
  const caseId = params.get('case');
  const investigationId = params.get('investigation');
  return <div className="cm-workspace">
    {caseId ? <SelectedCommunication key={JSON.stringify([caseId, investigationId])} {...{ caseId, investigationId, banking }} search={contextSearch(params)}/> : <>
      <PageHeader/>
      <StatePanel title="Select an exception case" action={<>
        <Link className="cm-button cm-primary" to={workspace + '/plans'}>Browse Resolution Plans<ArrowRight size={16} aria-hidden="true"/></Link>
        <Link className="cm-button" to={exceptions}>Browse Exception Center</Link>
      </>}>Choose a case with an accepted investigation to review customer impact and send customer email.</StatePanel>
    </>}
  </div>;
}
