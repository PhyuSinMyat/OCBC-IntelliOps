import test from 'node:test';
import assert from 'node:assert/strict';
import { developmentFixture } from './fixtures.js';
import { analyzeSnapshot, evidenceSnapshot } from './analysis.js';
import { causalEvents, eventContext, paymentPath, resultSummary } from './presentation.js';

function snapshot(name = 'prevented') {
  const f = developmentFixture(name);
  return evidenceSnapshot(f.caseRecord, f.records, f.accounts, f.fixture);
}
test('held duplicate requires verified posting and correlated events to diagnose acknowledgment retry', () => {
  const s = snapshot(), report = analyzeSnapshot(s);
  assert.equal(report.root_cause_code, 'CLIENT_RETRY_ACK_TIMEOUT');
  assert.equal(report.financial_execution_assessment.classification, 'SINGLE_POSTING_CONFIRMED');
  assert.equal(report.recommended_action_code, 'CLOSE_HELD_DUPLICATE');
  s.events = s.events.filter(e => e.eventType !== 'ACK_TIMEOUT');
  assert.equal(analyzeSnapshot(s).root_cause_code, 'CAUSE_NOT_ESTABLISHED');
});
test('two postings for one instruction require escalation, never automatic reversal', () => {
  const r = analyzeSnapshot(snapshot('double'));
  assert.equal(r.diagnosis_classification, 'CONFIRMED_DUPLICATE_REQUEST');
  assert.equal(r.financial_execution_assessment.classification, 'DOUBLE_POSTING_CONFIRMED');
  assert.equal(r.recommended_action_code, 'ESCALATE_DUPLICATE_FINANCIAL_EXECUTION');
});
test('separate verified instructions produce a closure review rather than duplicate-execution escalation', () => {
  const r = analyzeSnapshot(snapshot('legitimate'));
  assert.equal(r.diagnosis_classification, 'LEGITIMATE_SEPARATE_INSTRUCTIONS');
  assert.equal(r.recommended_action_code, 'REVIEW_FALSE_POSITIVE_CLOSURE');
});
test('missing journals do not prove non-execution, and no hold event means unknown', () => {
  const r = analyzeSnapshot(snapshot('uncertain'));
  assert.equal(r.financial_execution_assessment.classification, 'EXECUTION_OUTCOME_UNKNOWN');
  assert.equal(r.recommended_action_code, 'ESCALATE_FOR_PAYMENT_VERIFICATION');
  const s = snapshot();
  s.events = s.events.filter(e => e.eventType !== 'DUPLICATE_BLOCKED');
  assert.equal(analyzeSnapshot(s).financial_execution_assessment.duplicate.execution, 'Unknown');
});
test('wrong parties, invalid posted state or an additional invalid journal prevent a confirmed single posting', () => {
  for (const change of [s => { s.entries[0].accountId = 'DEV-RECEIVER'; }, s => { s.entries[0].posted = false; },
    s => { s.journals.push({ ...s.journals[0], id: 'INVALID-EXTRA' }); }]) {
    const s = snapshot(); change(s);
    assert.equal(analyzeSnapshot(s).financial_execution_assessment.classification, 'EXECUTION_OUTCOME_UNKNOWN');
  }
});
test('matching attributes without source instruction links cannot establish duplicate intent', () => {
  const s = snapshot();
  delete s.original.businessReference; delete s.duplicate.businessReference; delete s.duplicate.originalPaymentId;
  assert.equal(analyzeSnapshot(s).diagnosis_classification, 'SUSPECTED_DUPLICATE');
});
test('conflicting original-payment references do not confirm a duplicate', () => {
  const f = developmentFixture('prevented');
  f.records.payment_transactions.push({ ...f.records.payment_transactions[0], id: 'CONFLICTING-ORIGINAL' });
  f.caseRecord.evidence.originalReference = 'CONFLICTING-ORIGINAL';
  const r = analyzeSnapshot(evidenceSnapshot(f.caseRecord, f.records, f.accounts));
  assert.equal(r.diagnosis_classification, 'SUSPECTED_DUPLICATE');
});
test('analysis does not consume injected scenario labels or mutate source records', () => {
  const f = developmentFixture('prevented');
  f.records.payment_transactions[1].scenarioCode = 'INVENTED_TIMEOUT';
  const before = JSON.stringify(f);
  const s = evidenceSnapshot(f.caseRecord, f.records, f.accounts);
  assert.equal(Object.hasOwn(s.duplicate, 'scenarioCode'), false);
  analyzeSnapshot(s);
  assert.equal(JSON.stringify(f), before);
});

test('two verified postings do not become an invented idempotency root cause in the command center', () => {
  const report = analyzeSnapshot(snapshot('double'));
  assert.equal(resultSummary(report).identified, false);
  assert.equal(resultSummary(report).cause[0], 'Root cause unknown');
  assert.equal(resultSummary(report).financial[2], 'danger');
});
test('unknown execution paths do not fabricate completed or validated processing stages', () => {
  const report = analyzeSnapshot(snapshot('uncertain'));
  const path = paymentPath(report, 'duplicate');
  assert.equal(path.nodes.some(n => n.title === 'Payment completed' || n.title === 'Validation passed'), false);
  assert.equal(path.nodes.at(-1).tone, 'caution');
  assert.equal(resultSummary(report).financial[2], 'caution');
});
test('journal-only evidence is shown as a ledger record, not an invented processing event', () => {
  const s = snapshot(); s.events = s.events.filter(e => e.eventType !== 'LEDGER_POSTED');
  const path = paymentPath(analyzeSnapshot(s), 'original');
  assert.equal(path.nodes.filter(n => n.kind === 'journal').length, 1);
  assert.equal(path.nodes.some(n => n.event?.eventType === 'LEDGER_POSTED'), false);
});
test('compact causal sequence retains source references and ledger event details link the correct journal', () => {
  const report = analyzeSnapshot(snapshot());
  assert.equal(causalEvents(report).length, 5);
  const e = report.investigation_trace.find(e => e.eventType === 'LEDGER_POSTED');
  assert.deepEqual(eventContext(report, e).node.journalRefs, ['DEV-JRN-1']);
});
