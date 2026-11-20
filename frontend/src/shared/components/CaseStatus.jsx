import React from 'react';

const styles = {
  OPEN: ['Open', 'info'],
  IN_PROGRESS: ['In Progress', 'progress'],
  PENDING_APPROVAL: ['Pending Approval', 'warning'],
  APPROVED_AWAITING_ACTION: ['Approved \u2014 Awaiting Action', 'success'],
  REJECTED_NEEDS_REVISION: ['Rejected \u2014 Needs Revision', 'danger'],
  RESOLVED: ['Resolved', 'success'],
  CLOSED: ['Closed', 'neutral'],
};

export const caseStatuses = Object.keys(styles);
export const canonicalCaseStatus = value => value === 'IN_REVIEW' ? 'IN_PROGRESS' : value;
export const caseStatusLabel = value => styles[canonicalCaseStatus(value)]?.[0] || value || 'Unavailable';

export default function CaseStatus({ value }) {
  return <span className={'table-badge table-badge--' + (styles[canonicalCaseStatus(value)]?.[1] || 'neutral')}>
    {caseStatusLabel(value)}
  </span>;
}
