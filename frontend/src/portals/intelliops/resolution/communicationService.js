import { accounts, customers } from '../../../shared/data/bankingRecords.js';
import { financialMetrics } from './resolutionData.js';

export const communicationTypes = {
  INCIDENT_NOTIFICATION: 'Incident Notification',
  RESOLUTION_STATUS_UPDATE: 'Resolution Status Update',
};
export const responseTypes = {
  REQUEST_CORRECTION: 'Request Correction',
  REQUEST_ASSISTANCE: 'Request Assistance',
  NO_RESPONSE: 'No Response',
  CUSTOM_RESPONSE: 'Custom Simulated Response',
};

const histories = new Map();
const historyPrefix = 'intelliops-communication-demo-v1:';
const keyFor = caseId => historyPrefix + JSON.stringify(caseId);
const usableName = value => {
  const name = typeof value === 'string' ? value.trim() : '';
  return name && !/^(?:synthetic|test|fixture|demo)\b.*\b(?:verification|fixture|test|backend)\b|^(?:unknown|unavailable|not available)$/i.test(name.normalize('NFKC')) ? name : null;
};

export function communicationContext(record, report, payments) {
  const evidence = report.supporting_evidence;
  const source = [evidence?.original, evidence?.duplicate].find(payment => payment?.id === record.transactionId);
  const payment = payments.find(item => item.id === record.transactionId);
  const savedSender = source?.senderId;
  const savedAccount = accounts.find(item => item.id === savedSender);
  const currentAccount = accounts.find(item => item.id === payment?.senderId);
  const conflictingAccounts = savedAccount && currentAccount && savedAccount.id !== currentAccount.id;
  const senderRef = conflictingAccounts ? null : (savedAccount || currentAccount)?.id;
  const account = accounts.find(item => item.id === senderRef);
  const customer = customers.find(item => item.id === account?.customerRef);
  const customerId = customer?.id || account?.customerRef || null;
  const customerName = usableName(customer?.name) || usableName(account?.customer);
  const action = report.recommended_action_code;
  const confirmedDuplicate = report.financial_execution_assessment?.classification === 'DOUBLE_POSTING_CONFIRMED' &&
    report.diagnosis_classification === 'CONFIRMED_DUPLICATE_REQUEST';
  const recommendation = confirmedDuplicate ? 'recommended' :
    action === 'CLOSE_HELD_DUPLICATE' ? 'optional' :
    action === 'REVIEW_FALSE_POSITIVE_CLOSURE' ? 'unnecessary' : 'undetermined';
  return {
    caseId: record.id, investigationId: report.investigation_id,
    transactionId: record.transactionId || null, customerId, customerName,
    maskedAccount: account ? '••••' + account.id.slice(-Math.min(4, Math.max(0, account.id.length - 1))) : null,
    recommendation,
    metrics: financialMetrics(report),
  };
}

export function defaultMessage(type, context, evidenceCurrent) {
  if (type === 'RESOLUTION_STATUS_UPDATE') return {
    subject: 'Status Update Regarding Your Recent Payment',
    body: 'Dear Customer,\n\nOur operations team is continuing to review your recent payment. We will provide a further update when the review is complete. No further payment action is required from you while the review is in progress.\n\nKind regards,\nBank Operations Team',
  };
  const intended = context.metrics.find(([label]) => label === 'Intended transfer')?.[1];
  const excess = context.metrics.find(([label]) => label === 'Apparent duplicate excess')?.[1];
  const incident = evidenceCurrent && context.recommendation === 'recommended' && intended && excess
    ? `We identified a processing issue affecting your recent ${intended} transfer. Our records show that the transfer posted twice, resulting in an additional ${excess} transfer.`
    : 'Our operations team is reviewing a processing issue involving your recent payment.';
  return {
    subject: 'Important Update Regarding Your Recent Payment',
    body: `Dear Customer,\n\n${incident}\n\nWe apologise for the inconvenience. Our operations team is reviewing the issue and the appropriate next steps. You may request assistance or share your preference.\n\nNo further payment action is required from you while our review is in progress.\n\nKind regards,\nBank Operations Team`,
  };
}

export function responseText(type, context) {
  const intended = context.metrics.find(([label]) => label === 'Intended transfer')?.[1];
  const excess = context.metrics.find(([label]) => label === 'Apparent duplicate excess')?.[1];
  switch (type) {
    case 'REQUEST_CORRECTION':
      return intended && excess && context.recommendation === 'recommended'
        ? `I intended to transfer ${intended} only once. Please review how the additional ${excess} can be returned.`
        : 'Please review the payment and explain what correction may be available.';
    case 'REQUEST_ASSISTANCE': return 'I would like someone to explain what happened and what the next steps will be.';
    case 'NO_RESPONSE': return 'No response has been received.';
    default: return '';
  }
}

function readHistory(caseId) {
  if (histories.has(caseId)) return histories.get(caseId);
  try {
    const items = JSON.parse(globalThis.sessionStorage.getItem(keyFor(caseId)));
    if (Array.isArray(items)) return items.filter(item => item?.caseId === caseId && item.simulated === true);
  } catch {
    // The active page can still work when browser storage is unavailable.
  }
  return [];
}

export function readCommunications(context) {
  return readHistory(context.caseId).filter(item => item.customerId === context.customerId);
}

export function resolutionCustomerResponses(caseId, investigationId) {
  if (!caseId || !investigationId) return [];
  return readHistory(caseId)
    .filter(item => item.direction === 'INCOMING' && item.investigationId === investigationId)
    .map(({ id, createdAt, communicationType, body }) => ({ id, createdAt, communicationType, body }))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

export function resolutionIncidentNotifications(caseId, investigationId) {
  if (!caseId || !investigationId) return [];
  return readHistory(caseId).filter(item => item.investigationId === investigationId &&
    item.direction === 'OUTGOING' && item.communicationType === 'INCIDENT_NOTIFICATION').map(item => item.id);
}

export function clearSimulatedCommunications(caseId, customerId) {
  const history = readHistory(caseId);
  const remaining = history.filter(item => item.customerId !== customerId);
  if (remaining.length) globalThis.sessionStorage.setItem(keyFor(caseId), JSON.stringify(remaining));
  else globalThis.sessionStorage.removeItem(keyFor(caseId));
  histories.set(caseId, remaining);
}

export function validateDraft(subject, body, recipientEmail = '') {
  if (!subject.trim() || !body.trim()) return 'Enter both a subject and a message before continuing.';
  const email = recipientEmail.trim();
  if (email && (email.length > 254 || !/^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(email))) return 'Enter a valid recipient email address.';
  // The MVP accepts only review-in-progress wording around financial remedies.
  const text = (subject + ' ' + body).normalize('NFKC').replace(/[\u200b-\u200d\ufeff]/g, '');
  if (/\b(?:refund\w*|revers(?:e|ed|al|als|ing)|reimburs\w*|credited|corrected)\b|\b(?:returned|restored|paid back)\b.{0,35}\b(?:funds|money|amount|payment|transfer)\b|\b(?:funds|money|amount|payment|transfer)\b.{0,65}\b(?:returned|restored|paid back)\b|\b(?:correction|adjustment|remediation|issue)\b.{0,50}\b(?:completed|processed|applied|executed|resolved|fixed)\b|\b(?:completed|processed|applied|executed|resolved|fixed)\b.{0,35}\b(?:correction|adjustment|remediation|issue)\b/isu.test(text)) {
    return 'Use review-in-progress wording. This demo cannot include claims about refunds, reversals, or completed corrections.';
  }
  return '';
}

export function validateMessage(context, subject, body, recipientEmail = '') {
  if (!context.caseId || !context.customerName || !context.customerId) return 'A linked recipient is required to record a simulated send.';
  return validateDraft(subject, body, recipientEmail);
}

function append(context, entry, recordedBy) {
  const history = readHistory(context.caseId);
  const previous = history.filter(item => item.customerId === context.customerId).at(-1);
  if (previous && ['direction', 'communicationType', 'subject', 'body', 'relatedCommunicationId', 'recipientEmail'].every(field => (previous[field] ?? null) === (entry[field] ?? null))) {
    throw new Error('This simulated entry is already the latest item in the timeline.');
  }
  const item = {
    id: crypto.randomUUID?.() || Array.from(crypto.getRandomValues(new Uint32Array(4)), value => value.toString(16).padStart(8, '0')).join(''),
    caseId: context.caseId, investigationId: context.investigationId,
    customerId: context.customerId, relatedTransactionId: context.transactionId,
    simulated: true, recordedBy: recordedBy || null, createdAt: new Date().toISOString(), ...entry,
  };
  const updated = [...history, item];
  histories.set(context.caseId, updated);
  try {
    globalThis.sessionStorage.setItem(keyFor(context.caseId), JSON.stringify(updated));
  } catch {
    // Keep the simulation available in memory if session storage is restricted.
  }
  return readCommunications(context);
}

export function recordSimulatedSend(context, { type, subject, body, recipientEmail = '' }, recordedBy) {
  if (!Object.hasOwn(communicationTypes, type)) throw new Error('Select a supported communication type.');
  const error = validateMessage(context, subject, body, recipientEmail);
  if (error) throw new Error(error);
  return append(context, { direction: 'OUTGOING', communicationType: type,
    subject: subject.trim(), body: body.trim(), recipientEmail: recipientEmail.trim() || null,
    status: 'SENT_SIMULATED', relatedCommunicationId: null }, recordedBy);
}

export function recordSimulatedResponse(context, type, custom, notificationId, recordedBy) {
  const history = readCommunications(context);
  const notification = history.find(item => item.id === notificationId &&
    item.direction === 'OUTGOING' && item.communicationType === 'INCIDENT_NOTIFICATION');
  if (!notification) throw new Error('Record an incident notification before adding a simulated response.');
  if (!Object.hasOwn(responseTypes, type)) throw new Error('Select a supported response type.');
  if (type === 'NO_RESPONSE' && history.some(item => item.direction === 'INCOMING' && item.relatedCommunicationId === notificationId)) {
    throw new Error('A simulated customer response has already been recorded for this notification.');
  }
  const body = type === 'CUSTOM_RESPONSE' ? custom.trim() : responseText(type, context);
  if (!body) throw new Error('Enter a simulated customer reply.');
  const observation = type === 'NO_RESPONSE';
  return append(context, { direction: observation ? 'SYSTEM' : 'INCOMING', communicationType: type,
    subject: null, body, status: observation ? 'AWAITING_RESPONSE' : 'RESPONDED',
    relatedCommunicationId: notification.id }, recordedBy);
}
