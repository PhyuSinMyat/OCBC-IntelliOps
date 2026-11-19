import React, { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { recordSimulatedSend } from './communicationService.js';
import { generateResolutionPlan, resolutionPolicySearch, saveSessionResolutionPlan } from './resolutionPlannerService.js';

const prefix = 'DEMO-APPROVAL-CASE-';
const investigationFor = caseId => 'DEMO-INV-' + caseId.slice(prefix.length);
const action = 'ESCALATE_DUPLICATE_FINANCIAL_EXECUTION';

export function approvalWalkthroughEvidence(caseId, investigationId) {
  if (!caseId?.startsWith(prefix) || !/^[a-f0-9-]{32,36}$/.test(caseId.slice(prefix.length)) ||
      investigationId !== investigationFor(caseId)) return null;
  return {
    isWalkthrough: true,
    record: { id: caseId, exceptionType: 'Duplicate Transaction', status: 'OPEN' },
    item: {
      stale: false,
      report: {
        case_id: caseId, investigation_id: investigationId, run_status: 'COMPLETED', prototype: false,
        exception_type: 'DUPLICATE_TRANSACTION', recommended_action_code: action,
        evidence_snapshot_at: '2026-01-01T00:00:00Z', diagnosis_classification: 'CONFIRMED_DUPLICATE_REQUEST',
        financial_execution_assessment: { classification: 'DOUBLE_POSTING_CONFIRMED' },
        financial_impact: { confirmedPostedJournalCount: 2, validDebitTotals: { SGD: '20.00' }, requestHistoryComplete: true },
        supporting_evidence: { original: { currency: 'SGD', amountCents: 1000 } },
      },
    },
  };
}

export default function ApprovalWalkthroughButton() {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const starting = useRef(false);
  async function start() {
    if (starting.current) return;
    starting.current = true;
    setBusy(true);
    setError('');
    try {
      const suffix = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
      const caseId = prefix + suffix;
      const investigationId = investigationFor(caseId);
      const { item } = approvalWalkthroughEvidence(caseId, investigationId);
      const proposal = await generateResolutionPlan(caseId, investigationId, {
        report: item.report, signal: new AbortController().signal, onStage: () => {},
      });
      recordSimulatedSend({ caseId, investigationId, customerId: 'DEMO_RECIPIENT', customerName: 'Demo recipient' }, {
        type: 'INCIDENT_NOTIFICATION', subject: 'Demo payment review',
        body: 'This training notification records that the simulated payment is under review.',
      }, 'ANALYST');
      const [plan] = saveSessionResolutionPlan(caseId, investigationId, proposal, [], 0);
      const query = resolutionPolicySearch(new URLSearchParams({ case: caseId, investigation: investigationId }), plan);
      navigate('/intelliops/workflows/policy' + query);
    } catch (failure) {
      setError(failure.message || 'The approval walkthrough could not be started.');
    } finally {
      starting.current = false;
      setBusy(false);
    }
  }
  return <>
    <button className="rp-button" type="button" disabled={busy} onClick={start}>{busy ? 'Preparing demo…' : 'Start approval workflow demo'}</button>
    {error && <p className="pa-error" role="alert">{error}</p>}
  </>;
}
