import test from 'node:test';
import assert from 'node:assert/strict';
import { hasNewCommunicationContext, pendingResolutionResponses, supportsResolutionPlan } from './resolutionBackendService.js';

const accepted = overrides => ({
  prototype: false,
  persistence: 'BACKEND_DATABASE',
  run_status: 'COMPLETED',
  exception_type: 'DUPLICATE_TRANSACTION',
  diagnosis_classification: 'CONFIRMED_DUPLICATE_REQUEST',
  recommended_action_code: 'CLOSE_HELD_DUPLICATE',
  financial_execution_assessment: { classification: 'SINGLE_POSTING_CONFIRMED' },
  financial_impact: { confirmedPostedJournalCount: 1 },
  ...overrides,
});

test('planner supports accepted duplicate, amount mismatch, and missing posting findings', () => {
  assert.equal(supportsResolutionPlan(accepted({})), true);
  assert.equal(supportsResolutionPlan(accepted({
    exception_type: 'AMOUNT_MISMATCH',
    diagnosis_classification: 'CONFIRMED_AMOUNT_MISMATCH',
    recommended_action_code: 'REVIEW_SHORTFALL_ADJUSTMENT',
    financial_execution_assessment: { classification: 'UNDERPOSTING_CONFIRMED' },
  })), true);
  assert.equal(supportsResolutionPlan(accepted({
    exception_type: 'MISSING_LEDGER_POSTING',
    diagnosis_classification: 'CONFIRMED_MISSING_POSTING',
    recommended_action_code: 'REVIEW_MISSING_POSTING_REMEDIATION',
    financial_execution_assessment: { classification: 'NO_POSTING_RECORD_CONFIRMED' },
    financial_impact: { confirmedPostedJournalCount: 0 },
  })), true);
});

test('planner rejects inconsistent or non-accepted report shapes', () => {
  assert.equal(supportsResolutionPlan(accepted({ prototype: true })), false);
  assert.equal(supportsResolutionPlan(accepted({ persistence: 'BROWSER_SESSION_ONLY' })), false);
  assert.equal(supportsResolutionPlan(accepted({ run_status: 'FAILED' })), false);
  assert.equal(supportsResolutionPlan(accepted({
    exception_type: 'AMOUNT_MISMATCH',
    diagnosis_classification: 'CONFIRMED_AMOUNT_MISMATCH',
    recommended_action_code: 'REVIEW_SHORTFALL_ADJUSTMENT',
    financial_execution_assessment: { classification: 'OVERPOSTING_CONFIRMED' },
  })), false);
});

test('planner supports guarded operational and ledger exception findings', () => {
  const examples = [
    ['PAYMENT_PROCESSING_FAILURE', 'CONFIRMED_PROCESSING_FAILURE', 'REVIEW_PROCESSING_FAILURE_RECOVERY'],
    ['UNMATCHED_TRANSACTION', 'CONFIRMED_UNMATCHED_TRANSACTION', 'REVIEW_UNMATCHED_TRANSACTION_RECONCILIATION'],
    ['INVALID_LEDGER_POSTING', 'CONFIRMED_INVALID_LEDGER_POSTING', 'REVIEW_INVALID_LEDGER_REMEDIATION'],
    ['LEDGER_ACCOUNT_MISMATCH', 'CONFIRMED_LEDGER_ACCOUNT_MISMATCH', 'REVIEW_ACCOUNT_MISMATCH_REMEDIATION'],
    ['LEDGER_CURRENCY_MISMATCH', 'CONFIRMED_LEDGER_CURRENCY_MISMATCH', 'REVIEW_CURRENCY_MISMATCH_REMEDIATION'],
    ['PROCESSING_TIMEOUT', 'CONFIRMED_PROCESSING_TIMEOUT', 'REVIEW_PROCESSING_TIMEOUT_RECOVERY'],
  ];
  for (const [exception_type, diagnosis_classification, recommended_action_code] of examples) {
    assert.equal(supportsResolutionPlan(accepted({ exception_type, diagnosis_classification,
      recommended_action_code, financial_execution_assessment: { classification: 'EXECUTION_OUTCOME_UNKNOWN' },
      financial_impact: { confirmedPostedJournalCount: 0 } })), true);
  }
});

test('persisted plan snapshots identify newly recorded responses', () => {
  const plan = { customerSnapshot: { responses: [{ id: 'response-1' }] } };
  assert.deepEqual(pendingResolutionResponses(plan, [{ id: 'response-1' }, { id: 'response-2' }]), [{ id: 'response-2' }]);
});

test('any persisted communication revision makes an older plan pending reassessment', () => {
  const plan = { customerSnapshot: { revision: 0, responses: [] } };
  assert.equal(hasNewCommunicationContext(plan, 0), false);
  assert.equal(hasNewCommunicationContext(plan, 1), true);
  assert.equal(hasNewCommunicationContext(null, 1), false);
});
