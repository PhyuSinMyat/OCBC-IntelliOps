import { exceptionRequest } from '../../../shared/api/banking.js';

export async function listApprovalRequests(options = {}) {
  const result = await exceptionRequest('/api/approval-requests', options);
  return result.requests || [];
}

export function readApprovalRequest(requestId, options = {}) {
  return exceptionRequest(`/api/approval-requests/${encodeURIComponent(requestId)}`, options);
}

export function submitApprovalRequest(assessmentId, options = {}) {
  return exceptionRequest('/api/approval-requests', {
    method: 'POST', signal: options.signal, body: { assessment_id: assessmentId },
  });
}

export function submitApprovalDecision(requestId, decision, reason, options = {}) {
  return exceptionRequest(`/api/approval-requests/${encodeURIComponent(requestId)}/decision`, {
    method: 'POST', signal: options.signal, body: { decision, reason },
  });
}
