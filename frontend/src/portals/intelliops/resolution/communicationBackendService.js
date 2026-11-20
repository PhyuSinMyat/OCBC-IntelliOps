import { exceptionRequest } from '../../../shared/api/banking.js';
import { validateMessage } from './communicationService.js';

const queryFor = investigationId => investigationId ? '?' + new URLSearchParams({ investigation_id: investigationId }) : '';
export const readCommunicationBundle = (caseId, investigationId, options) =>
  exceptionRequest(`/api/exceptions/${encodeURIComponent(caseId)}/communications${queryFor(investigationId)}`, options);
export async function readCommunications(caseId, investigationId, options) {
  const result = await readCommunicationBundle(caseId, investigationId, options);
  return result.communications || [];
}
export const customerResponses = history => (history || []).filter(item => item.direction === 'INCOMING')
  .map(({ id, createdAt, communicationType, body }) => ({ id, createdAt, communicationType, body }))
  .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
export const incidentNotifications = history => (history || []).filter(item =>
  item.direction === 'OUTGOING' && item.communicationType === 'INCIDENT_NOTIFICATION').map(item => item.id);

async function append(context, payload, options) {
  const result = await exceptionRequest(`/api/exceptions/${encodeURIComponent(context.caseId)}/communications`, {
    method: 'POST', signal: options?.signal, body: {
      investigation_id: context.investigationId, customer_id: context.customerId,
      related_transaction_id: context.transactionId || null, ...payload,
    },
  });
  return result.communications || [];
}
export function sendCustomerEmail(context, { type, subject, body, recipientEmail = '' }, options) {
  if (!recipientEmail.trim()) throw new Error('Enter the customer email address.');
  const error = validateMessage(context, subject, body, recipientEmail);
  if (error) throw new Error(error);
  return append(context, { direction: 'OUTGOING', communication_type: type, subject: subject.trim(),
    body: body.trim(), recipient_email: recipientEmail.trim() || null, related_communication_id: null,
    delivery_mode: 'EMAIL' }, options);
}
export async function retryCustomerEmail(context, communicationId, options) {
  const result = await exceptionRequest(`/api/exceptions/${encodeURIComponent(context.caseId)}/communications/${encodeURIComponent(communicationId)}/retry-email`, {
    method: 'POST', signal: options?.signal,
  });
  return result.communications || [];
}
export const syncCustomerInbox = (caseId, investigationId, options) => {
  const query = new URLSearchParams({ investigation_id: investigationId });
  return exceptionRequest(`/api/exceptions/${encodeURIComponent(caseId)}/communications/sync-inbox?${query}`, {
    method: 'POST', signal: options?.signal,
  });
};
