// Per-record severity for the browser-only simulator. Systemic monitoring requires backend evidence.
export function assessSimulationSeverity(type, evidence) {
  const assessment = (severity, reasonCode, reason) =>
    ({ severity, reasonCode, reason, assessmentStage: 'DETECTION', ruleVersion: '1.0' });
  if (type === 'Missing Ledger Posting' && evidence.cutoff) {
    return assessment('HIGH', 'COMPLETED_PAYMENT_MISSING_LEDGER', 'The completed payment had no corresponding ledger record after the reconciliation cutoff.');
  }
  if (type === 'Amount Mismatch' && Number.isSafeInteger(evidence.expectedCents) &&
      Number.isSafeInteger(evidence.postedCents) && evidence.expectedCents !== evidence.postedCents || evidence.financialDiscrepancy) {
    return assessment('HIGH', 'VERIFIED_AMOUNT_MISMATCH', 'The verified posting total differs from the completed payment amount.');
  }
  if (evidence.financialAssessment === 'TWO_POSTINGS_CONFIRMED') {
    return assessment('HIGH', 'POTENTIAL_DOUBLE_EXECUTION', 'Two financial postings are confirmed. Independent payment intent has not been established.');
  }
  if (evidence.financialMovementObserved) {
    return assessment('HIGH', 'FINANCIAL_EXECUTION_REQUIRES_REVIEW', 'Observed financial movement requires review.');
  }
  if (evidence.financialAssessment === 'SINGLE_POSTING_CONFIRMED_DUPLICATE_HELD') {
    return assessment('LOW', 'DUPLICATE_SAFELY_HELD', 'The repeat request was held before execution and only one posting was verified.');
  }
  if (evidence.failureContained) {
    return assessment('LOW', 'FAILURE_SAFELY_CONTAINED', 'A terminal failure was recorded with no corresponding ledger records or posting activity.');
  }
  if (type === 'Unmatched Transaction') {
    return assessment('MEDIUM', 'UNRESOLVED_PAYMENT_REFERENCE', 'The payment reference could not be reconciled. A financial discrepancy has not been established.');
  }
  return assessment('MEDIUM', 'EXECUTION_REQUIRES_REVIEW', 'The available evidence does not establish financial exposure or safe containment.');
}
