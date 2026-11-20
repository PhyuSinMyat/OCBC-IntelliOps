import React, { useEffect, useRef, useState } from 'react';
import CaseStatus from '../../../shared/components/CaseStatus.jsx';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Building2, ChevronDown, ChevronRight, ChevronUp, Eye, FileText, LockKeyhole, MessagesSquare, ShieldCheck, UserRound } from 'lucide-react';
import { contextSearch } from '../../../app/navigation.js';
import { useBankingRecords } from '../../../shared/data/bankingRecords.js';
import { displayTime, humanize } from '../investigation/ReportSections.jsx';
import { cachedResolutionCase, readResolutionCase } from './resolutionData.js';
import { getSessionResolutionPlan, pendingResolutionResponses, resolutionPolicySearch } from './resolutionPlannerService.js';
import {
  clearSimulatedCommunications, communicationContext, communicationTypes, defaultMessage, readCommunications, recordSimulatedResponse,
  recordSimulatedSend, resolutionCustomerResponses, responseText, responseTypes, validateDraft,
} from './communicationService.js';
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
      <p>Manage simulated customer notifications and responses for operational exceptions.</p>
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
      <div><dt>Case status</dt><dd><CaseStatus value={record.status}/></dd></div>
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
      {plan && <p className="cm-impact-note"><strong>Session-only resolution proposal V{plan.version}</strong> {plan.resolutionTitle}</p>}
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
  const canSend = Boolean(context.customerId && context.customerName);
  function change(field, value) {
    setEditedDraft({ ...message, [field]: value });
    setError('');
    onDraftChange(true);
  }
  function validate() {
    const validation = validateDraft(message.subject, message.body, recipientEmail);
    setError(validation);
    return !validation;
  }
  return <section className="cm-panel cm-composer" aria-labelledby="cm-compose-title">
    <div className="cm-section-heading"><h2 id="cm-compose-title">Message composer</h2><span className="cm-chip"><LockKeyhole size={13} aria-hidden="true"/>Simulated secure message</span></div>
    <form onSubmit={event => {
      event.preventDefault();
      if (!validate()) return;
      try { onRecord({ type, ...message, recipientEmail }); }
      catch (failure) { setError(failure.message); }
    }} noValidate>
      <label>Recipient<input readOnly value={context.customerName || unavailableCustomer}/></label>
      <label>Recipient email (optional)<input type="email" value={recipientEmail} maxLength={254} onChange={event => {
        setRecipientEmail(event.target.value); setError(''); onDraftChange(true);
      }}/></label>
      <label><span id="cm-channel-label">Communication type</span><select aria-labelledby="cm-channel-label" value={type} onChange={event => {
        setType(event.target.value); setEditedDraft(null); setError(''); onDraftChange(true);
      }}>{options(communicationTypes)}</select></label>
      <label>Subject<input value={message.subject} onChange={event => change('subject', event.target.value)} maxLength={160} required/></label>
      <label><span id="cm-message-label">Message</span><textarea aria-labelledby="cm-message-label" value={message.body} onChange={event => change('body', event.target.value)} maxLength={3500} rows={8} required/></label>
      {!canSend && <p className="cm-advisory">A linked customer is required to record a simulated send.</p>}
      {error && <p className="cm-error" role="alert">{error}</p>}
      {feedback && <p className="cm-feedback" role="status">{feedback}</p>}
      <div className="cm-actions cm-composer-actions">
        <button className="cm-button" type="button" aria-haspopup="dialog" aria-controls="cm-preview"
          onClick={() => { if (validate()) previewRef.current.showModal(); }}><Eye size={16} aria-hidden="true"/>Preview Message</button>
        <button className="cm-button cm-primary" type="submit" disabled={!canSend}>Record Simulated Send</button>
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

function TimelineMessage({ entry, context, related, responded }) {
  const [expanded, setExpanded] = useState(false);
  const incoming = entry.direction === 'INCOMING';
  const observation = entry.direction === 'SYSTEM';
  const Icon = observation ? FileText : incoming ? UserRound : Building2;
  const sender = incoming ? context.customerName || unavailableCustomer : observation ? 'Operations observation' : 'Bank Operations';
  const status = entry.status === 'SENT_SIMULATED'
    ? responded ? 'Responded' : entry.communicationType === 'INCIDENT_NOTIFICATION' ? 'Awaiting response' : 'Simulated send recorded'
    : observation ? 'No response recorded' : 'Response recorded';
  const bodyId = `cm-timeline-message-${entry.id}`;
  const ToggleIcon = expanded ? ChevronUp : ChevronDown;

  return <li className={`cm-event cm-event-${entry.direction.toLowerCase()}`}>
    <span className="cm-event-icon"><Icon size={16} aria-hidden="true"/></span>
    <article>
      <div className="cm-event-heading"><strong>{sender}</strong><span className="cm-chip">Simulated</span></div>
      <p className="cm-event-meta">{communicationTypes[entry.communicationType] || responseTypes[entry.communicationType]}</p>
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

function Timeline({ history, context }) {
  if (!history.length) return <div className="cm-timeline-empty">
    <span className="cm-icon"><MessagesSquare size={21} aria-hidden="true"/></span>
    <h3>No communication recorded yet</h3><p>Prepare and record an incident notification to begin the simulated conversation.</p>
  </div>;

  const ordered = [...history].sort((a, b) => (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0));
  const byId = new Map(history.map(entry => [entry.id, entry]));
  const repliedTo = new Set(history.filter(entry => entry.direction === 'INCOMING').map(entry => entry.relatedCommunicationId));
  return <ol className="cm-timeline" aria-label="Recorded communications, oldest first">{ordered.map(entry =>
    <TimelineMessage key={entry.id} {...{ entry, context }} related={byId.get(entry.relatedCommunicationId)} responded={repliedTo.has(entry.id)}/>
  )}</ol>;
}

function ResponseSimulator({ notification, hasResponse, context, onRecord }) {
  const [type, setType] = useState('REQUEST_CORRECTION');
  const [custom, setCustom] = useState('');
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState('');
  return <section className="cm-response" aria-labelledby="cm-response-title">
    <h3 id="cm-response-title">Customer response simulator</h3>
    {!notification ? <p>Record a simulated incident notification to enable customer responses.</p> :
      <form onSubmit={event => {
        event.preventDefault();
        setFeedback('');
        try { onRecord(type, custom, notification.id); setError(''); setCustom(''); setFeedback(type === 'NO_RESPONSE' ? 'No-response observation recorded.' : 'Simulated customer response recorded.'); }
        catch (failure) { setError(failure.message); }
      }}>
        <p>Linked notification <strong>{notification.subject}</strong></p>
        <fieldset className="cm-response-options"><legend>Response type</legend><div>
          {Object.entries(responseTypes).map(([value, label]) => <label key={value}>
            <input type="radio" name="cm-response-type" value={value} checked={type === value} disabled={value === 'NO_RESPONSE' && hasResponse}
              onChange={() => { setType(value); setError(''); setFeedback(''); }}/>
            {value === 'CUSTOM_RESPONSE' ? 'Custom Response' : label}
          </label>)}
        </div></fieldset>
        {type === 'CUSTOM_RESPONSE' ? <label><span id="cm-custom-response-label">Custom simulated reply</span><textarea aria-labelledby="cm-custom-response-label" rows={3} value={custom} maxLength={2000} onChange={event => setCustom(event.target.value)}/></label>
          : <p className="cm-response-preview">{responseText(type, context)}</p>}
        {error && <p className="cm-error" role="alert">{error}</p>}
        {feedback && <p className="cm-feedback" role="status">{feedback}</p>}
        <button className="cm-button" type="submit">{type === 'NO_RESPONSE' ? 'Record No Response' : 'Record Simulated Response'}</button>
      </form>}
  </section>;
}

function CommunicationWorkspace({ record, item, banking, refreshStatus, onRetry }) {
  const { report, stale } = item;
  const context = communicationContext(record, report, banking.payment_transactions || []);
  const [useDemoRecipient, setUseDemoRecipient] = useState(false);
  const demoActive = useDemoRecipient && !context.customerName;
  const recipientContext = demoActive
    ? { ...context, customerId: 'DEMO_RECIPIENT', customerName: 'Demo recipient' }
    : context;
  return <CaseConversation key={JSON.stringify([context.caseId, context.investigationId, recipientContext.customerId, demoActive])}
    {...{ context, recipientContext, record, refreshStatus, onRetry, demoActive }}
    onToggleDemo={() => setUseDemoRecipient(value => !value)}
    evidenceCurrent={stale === false} role={banking.role}/>;
}

function CaseConversation({ context, recipientContext, record, evidenceCurrent, role, refreshStatus, onRetry, demoActive, onToggleDemo }) {
  const [history, setHistory] = useState(() => readCommunications(recipientContext));
  const [draft, setDraft] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [resetCount, setResetCount] = useState(0);
  const [resetError, setResetError] = useState('');
  const messageCount = history.filter(item => item.direction !== 'SYSTEM').length;
  function clearTimeline() {
    if (!window.confirm(`Clear the simulated conversation timeline for ${context.caseId}? Recorded audit metadata stays in this browser session.`)) return;
    try {
      clearSimulatedCommunications(context.caseId, recipientContext.customerId);
      setHistory([]);
      setDraft(false);
      setFeedback('');
      setResetError('');
      setResetCount(count => count + 1);
    } catch {
      setResetError('The browser could not clear this timeline.');
    }
  }
  const notification = history.findLast(item => item.communicationType === 'INCIDENT_NOTIFICATION' && item.direction === 'OUTGOING');
  const latestReply = notification && history.findLast(item => item.relatedCommunicationId === notification.id);
  const hasResponse = Boolean(notification && history.some(item => item.relatedCommunicationId === notification.id && item.direction === 'INCOMING'));
  const status = draft ? 'Draft' : hasResponse ? 'Response recorded' : latestReply ? 'No response recorded' :
    notification ? 'Awaiting response' : history.length ? 'Simulated send recorded' : 'No communication recorded';
  const search = contextSearch(new URLSearchParams({ case: context.caseId, investigation: context.investigationId }));
  const plan = getSessionResolutionPlan(context.caseId, context.investigationId);
  const needsReassessment = Boolean(plan && pendingResolutionResponses(plan, resolutionCustomerResponses(context.caseId, context.investigationId)).length);
  const policySearch = resolutionPolicySearch(search, plan, needsReassessment ? 'reassessment-required' : 'current');
  const nextCopy = context.recommendation === 'recommended' && !notification
    ? 'Communication is recommended. No incident notification has been recorded. You can continue to policy review.'
    : context.recommendation === 'optional' || context.recommendation === 'unnecessary'
      ? 'Customer communication is not required for this case. Continue to policy review when ready.'
      : 'Review the policy requirements for this case. Simulated customer statements do not verify a payment or authorise a correction.';
  return <>
    <PageHeader caseId={context.caseId} search={search}/>
    <WorkflowProgress {...{ search, policySearch }}/>
    {needsReassessment && <p className="cm-reassessment" role="status"><strong>Proposal needs reassessment.</strong> V{plan.version} has unreviewed simulated customer input. <Link className="cm-link" to={workspace + '/plans' + search}>Reassess in Resolution Plans</Link></p>}
    {refreshStatus === 'checking' && <p className="cm-advisory" role="status">Showing the saved investigation while current evidence is checked.</p>}
    {refreshStatus === 'timeout' && <div className="cm-actions">
      <p className="cm-advisory" role="status">The evidence check timed out. The saved investigation remains visible.</p>
      <button className="cm-button" type="button" onClick={onRetry}>Retry evidence check</button>
    </div>}
    <ImpactSummary {...{ context, record, plan, status, evidenceCurrent }}/>
    {!context.customerName && <div className="cm-actions">
      <button className="cm-button" type="button" aria-pressed={demoActive} onClick={onToggleDemo}>
        {demoActive ? 'Stop using demo recipient' : 'Use demo recipient'}
      </button>
      <p className="cm-advisory">{demoActive ? 'Demo recipient active. This timeline contains test messages.' : 'Use a demo recipient to test the composer and response timeline.'}</p>
    </div>}
    <p className="cm-session"><ShieldCheck size={16} aria-hidden="true"/>Simulated records stay in this browser session. Drafts are cleared on refresh.</p>
    <div className="cm-grid">
      <MessageComposer key={resetCount} context={recipientContext} {...{ evidenceCurrent, feedback }} onDraftChange={value => { setDraft(value); setFeedback(''); }}
        onRecord={message => { setHistory(recordSimulatedSend(recipientContext, message, role)); setDraft(false); setFeedback('Simulated message recorded in the timeline.'); }}/>
      <section className="cm-panel cm-conversation" aria-labelledby="cm-conversation-title">
        <div className="cm-section-heading cm-timeline-heading">
          <div><h2 id="cm-conversation-title">Conversation Timeline</h2><span className="cm-chip">{messageCount} {messageCount === 1 ? 'message' : 'messages'}</span></div>
          {history.length > 0 && <button className="cm-clear-timeline" type="button" onClick={clearTimeline}>Clear timeline</button>}
        </div>
        {resetError && <p className="cm-error" role="alert">{resetError}</p>}
        <Timeline history={history} context={recipientContext}/>
        <ResponseSimulator key={notification?.id || 'no-notification'} context={recipientContext} {...{ notification, hasResponse }}
          onRecord={(type, custom, notificationId) => setHistory(recordSimulatedResponse(recipientContext, type, custom, notificationId, role))}/>
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
      </>}>Choose a case with an accepted investigation to review customer impact and record simulated communication.</StatePanel>
    </>}
  </div>;
}
