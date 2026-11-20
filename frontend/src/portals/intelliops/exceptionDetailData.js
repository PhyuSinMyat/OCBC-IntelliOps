import { postingTime, validJournal } from '../../shared/data/bankingRecords.js';
import { tableMoney } from '../../shared/components/tableMoney.js';

export const unavailable = 'Not available';
export const readable = value => String(value).replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  .replaceAll('_', ' ').toLowerCase().replace(/^./, c => c.toUpperCase());
export const caseTime = value => Number.isFinite(Date.parse(value)) ? postingTime(value) + ' SGT' : unavailable;

function decimalCents(value) {
  if (typeof value !== 'string') return null;
  const parts = /^(-?)(\d+)(?:\.(\d{1,2})0*)?$/.exec(value);
  if (!parts) return null;
  const cents = BigInt(parts[2]) * 100n + BigInt((parts[3] || '').padEnd(2, '0'));
  return parts[1] ? -cents : cents;
}

const minorUnits = value => Number.isSafeInteger(value) ? BigInt(value) : null;
const money = (cents, currency) => cents === null || !currency ? unavailable : tableMoney(cents, currency);
export const paymentAmount = payment => money(minorUnits(payment?.amountCents), payment?.currency);

const postingClass = {
  SINGLE_POSTING_CONFIRMED_DUPLICATE_HELD: 'One verified posting and a held repeat',
  TWO_POSTINGS_CONFIRMED: 'Two verified postings. Payment intent requires verification.',
  EXECUTION_OUTCOME_UNKNOWN: 'Verification required',
};

export function casePresentation(record, records) {
  const e = record.evidence || {};
  const original = e.originalReference;
  const references = [...new Set([record.transactionId, record.relatedTransactionId, original].filter(Boolean))];
  const payments = references.map(id => ({
    id, payment: records.payment_transactions.find(row => row.id === id),
    label: original === id ? 'Original Payment' : references.length > 1 ? 'Related Payment' : 'Payment',
  })).sort((a, b) => Number(b.id === original) - Number(a.id === original));
  const payment = payments.find(row => row.id === record.transactionId)?.payment;
  const journalIds = [...new Set([record.remediation?.journalReference, e.journalReference,
    ...(e.journalReferences || []), ...(e.originalJournalReferences || []), ...(e.duplicateJournalReferences || []),
    ...records.ledger_journals.filter(row => references.includes(row.sourcePaymentId) ||
      references.includes(row.paymentId)).map(row => row.id)].filter(Boolean))];
  const journals = journalIds.map(id => ({ id, journal: records.ledger_journals.find(row => row.id === id) }));
  const facts = [];
  const metrics = [];
  const add = (title, detail) => facts.push({ title, detail });
  const expected = decimalCents(e.expectedAmount) ?? minorUnits(e.expectedCents);
  const posted = decimalCents(e.postedAmount) ?? minorUnits(e.postedCents);
  const currency = e.expectedCurrency || payment?.currency;
  const amount = paymentAmount(payment);
  const status = payment?.status ? readable(payment.status) : unavailable;
  let summary;

  switch (e.ruleCode || record.exceptionType.toUpperCase().replaceAll(' ', '_')) {
    case 'DUPLICATE_TRANSACTION': {
      if (original && references.length > 1) add('Related payment references', references.join(' · '));
      if (e.sharedReference === true) add('Shared business reference', e.businessReference || 'The requests share a business reference.');
      if (e.attributesMatch === true) add('Matching payment attributes', 'The source accounts, amount and currency match.');
      if (e.duplicateBlocked === true) add('Repeat request blocked', 'The processing records contain a duplicate-blocked event.');
      const classification = postingClass[e.financialAssessment];
      if (classification && e.financialAssessment !== 'EXECUTION_OUTCOME_UNKNOWN') add('Posting assessment', classification);
      metrics.push(...payments.map(row => [row.label, paymentAmount(row.payment), row.payment?.status && readable(row.payment.status)]));
      const verified = Array.isArray(e.originalJournalReferences) && Array.isArray(e.duplicateJournalReferences);
      metrics.push(['Verified journals at detection', verified ? String(new Set([...e.originalJournalReferences, ...e.duplicateJournalReferences]).size) : unavailable],
        ['Posting assessment', classification || 'Verification required']);
      if (original && references.length > 1) summary = 'Detection linked two payment references for duplicate review. Verify the intent behind the related payment.';
      break;
    }
    case 'MISSING_LEDGER_POSTING':
      if (e.cutoff && Array.isArray(e.journalReferences) && !e.journalReferences.length) {
        summary = 'Detection found no linked posting record after the reconciliation cutoff.';
        add('Posting record missing at detection', 'No linked journal was recorded at the cutoff.');
      }
      metrics.push(['Payment amount', amount], ['Current payment status', status],
        ['Posting at detection', summary ? 'No linked posting' : unavailable], ['Posting cutoff', caseTime(e.cutoff)]);
      break;
    case 'AMOUNT_MISMATCH': {
      const difference = decimalCents(e.difference) ?? (posted !== null && expected !== null ? posted - expected : null);
      metrics.push(['Expected payment amount', expected === null ? amount : money(expected, currency)],
        ['Posted amount at detection', money(posted, currency)], ['Difference (posted minus expected)', money(difference, currency)]);
      if (difference !== null && difference !== 0n) {
        summary = 'The amount observed in the ledger differed from the expected payment amount.';
        add('Amount variance', money(difference, currency) === unavailable ? 'Recorded amounts differ.' : money(difference, currency));
      }
      break;
    }
    case 'PAYMENT_PROCESSING_FAILURE': {
      const movement = typeof e.financialMovementObserved === 'boolean'
        ? e.financialMovementObserved ? 'Movement observed' : 'No movement observed at detection' : unavailable;
      metrics.push(['Requested amount', amount], ['Current payment status', status], ['Ledger movement', movement]);
      if (e.status?.toUpperCase() === 'FAILED' || e.failureContained === true) {
        summary = 'The payment was recorded as failed when the exception was detected.';
        add('Processing failure recorded', 'The source payment had a failed status at detection.');
      }
      if (movement !== unavailable) add('Ledger observation', movement);
      break;
    }
    case 'UNMATCHED_TRANSACTION': {
      const journal = journals.find(row => row.id === e.journalReference)?.journal;
      const conflict = e.expectedReference && e.actualReference && e.expectedReference !== e.actualReference;
      metrics.push(['Payment amount', amount],
        ['Journal balance', journal && validJournal(records, journal) ? 'Balanced in current ledger' : 'Verification required'],
        ['Reconciliation at detection', conflict ? 'Reference conflict' : unavailable]);
      if (conflict) {
        summary = 'Detection found a source reference conflict between the payment and its linked journal.';
        add('Reference conflict', 'Expected ' + e.expectedReference + ' · Recorded ' + e.actualReference);
      }
      break;
    }
    default:
      metrics.push(['Payment amount', amount], ['Current payment status', status]);
      if (e.classification) add('Recorded classification', readable(e.classification));
      if (e.lastActivityAt) add('Last recorded processing activity', caseTime(e.lastActivityAt));
  }
  if (e.cutoff) add('Reconciliation cutoff', caseTime(e.cutoff));
  if (e.failureCode) add('Recorded failure code', e.failureCode);
  return {
    payments, journals, metrics, facts: facts.slice(0, 5),
    summary: summary || (typeof e.detectionReason === 'string' && e.detectionReason.trim()) ||
      'Review the linked records to verify the conditions that triggered this exception.',
  };
}
