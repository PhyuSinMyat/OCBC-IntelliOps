import { exceptionRequest } from '../../../shared/api/banking.js';
import { backendConnected, fetchExceptionCase } from '../../../shared/data/bankingRecords.js';
import { isInvestigable } from '../investigation/analysis.js';
import { developmentFixture } from '../investigation/fixtures.js';
import { actionPresentation } from '../investigation/presentation.js';
import { getHandoff, readInvestigation } from '../investigation/service.js';

export const isOpenCase = record => !['CLOSED', 'RESOLVED'].includes(record.status?.toUpperCase());
const pageSize = 20;
const accepted = (item, caseId, id = item?.investigation_id) =>
  item?.status === 'ACCEPTED' && item.report?.run_status === 'COMPLETED' &&
  item.report.case_id === caseId && Boolean(id) && item.report.investigation_id === id;
const acceptedReports = new Map();
const reportKey = (caseId, investigationId) => JSON.stringify([caseId, investigationId]);

function rememberAccepted(caseId, item) {
  const key = reportKey(caseId, item.investigation_id);
  acceptedReports.delete(key);
  acceptedReports.set(key, item.report);
  if (acceptedReports.size > 12) acceptedReports.delete(acceptedReports.keys().next().value);
}

export function cachedResolutionCase(record, investigationId) {
  if (!backendConnected || !isInvestigable(record) || !investigationId) return null;
  const report = acceptedReports.get(reportKey(record.id, investigationId));
  return report?.prototype === false ? { record, item: { report, stale: null } } : null;
}

async function latestAccepted(caseId, options) {
  for (let offset = 0; ; offset += pageSize) {
    const { investigations } = await exceptionRequest(
      `/api/exceptions/${encodeURIComponent(caseId)}/investigations?limit=${pageSize}&offset=${offset}`, options
    );
    const match = investigations.find(item => accepted(item, caseId));
    if (match) {
      rememberAccepted(caseId, match);
      return match;
    }
    if (investigations.length < pageSize) return null;
  }
}

export async function readResolutionQueue(caseIds) {
  const reports = [];
  let failed = 0;
  for (let index = 0; index < caseIds.length; index += 4) {
    const batch = await Promise.allSettled(caseIds.slice(index, index + 4).map(latestAccepted));
    for (const result of batch) {
      if (result.status === 'rejected') failed++;
      else if (result.value) reports.push(result.value);
    }
  }
  return { reports, failed };
}

export async function readResolutionCase(caseId, investigationId, localCase, options) {
  if (!backendConnected) {
    const handoff = investigationId && getHandoff(investigationId);
    const report = handoff?.case_id === caseId && handoff.investigation_id === investigationId ? handoff : null;
    const record = report?.fixture ? developmentFixture(report.fixture)?.caseRecord : localCase;
    return { record, item: report ? { report, stale: null } : null };
  }

  if (!investigationId) {
    const record = await fetchExceptionCase(caseId, options);
    return { record, item: isInvestigable(record) ? await latestAccepted(caseId, options) : null };
  }
  const [record, item] = await Promise.all([
    fetchExceptionCase(caseId, options),
    readExactReport(caseId, investigationId, options),
  ]);
  return { record, item: isInvestigable(record) ? item : null };
}

async function readExactReport(caseId, investigationId, options) {
  const key = reportKey(caseId, investigationId);
  try {
    const { investigations } = await readInvestigation(caseId, investigationId, options);
    const item = investigations.find(item => accepted(item, caseId, investigationId));
    if (item) rememberAccepted(caseId, item);
    else acceptedReports.delete(key);
    return item || null;
  } catch (error) {
    if (error.status === 404) {
      acceptedReports.delete(key);
      return null;
    }
    throw error;
  }
}

export function resolutionPreview(record, caseId, investigationId, queueItem) {
  if (!backendConnected || !isInvestigable(record) || !investigationId) return null;
  const report = accepted(queueItem, caseId, investigationId) ? queueItem.report : getHandoff(investigationId);
  if (report?.prototype !== false || report.run_status !== 'COMPLETED' ||
      report.case_id !== caseId || report.investigation_id !== investigationId) return null;
  return { record, item: { report, stale: null } };
}

export function actionTitle(report) {
  if (report.recommended_action_code === 'ESCALATE_DUPLICATE_FINANCIAL_EXECUTION') {
    return 'Escalate for Financial Correction Review';
  }
  return actionPresentation[report.recommended_action_code]?.[0] || 'Review the investigation recommendation';
}

function currencyAmount(currency, amount) {
  if (!/^[A-Z]{3}$/.test(currency || '') || !/^-?\d+(\.\d{1,2})?$/.test(String(amount))) return null;
  const [whole, fraction = ''] = String(amount).split('.');
  const formatted = whole === '-0' ? whole : BigInt(whole).toLocaleString('en-SG');
  return `${currency} ${formatted}.${fraction.padEnd(2, '0')}`;
}

function asDecimal(cents) {
  return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
}

function confirmedDuplicateAmounts(report, data) {
  const assessment = report.financial_execution_assessment?.classification;
  const postingCount = { SINGLE_POSTING_CONFIRMED: 1, DOUBLE_POSTING_CONFIRMED: 2 }[assessment];
  const instruction = report.supporting_evidence?.original;
  const rawDebit = String(data.validDebitTotals?.[instruction?.currency]);
  if (report.diagnosis_classification !== 'CONFIRMED_DUPLICATE_REQUEST' || !postingCount ||
      data.requestHistoryComplete !== true || data.confirmedPostedJournalCount !== postingCount ||
      !Number.isSafeInteger(instruction?.amountCents) || instruction.amountCents <= 0 ||
      !/^\d+(\.\d{1,2})?$/.test(rawDebit)) return null;

  const [whole, fraction = ''] = rawDebit.split('.');
  const debit = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  const intended = BigInt(instruction.amountCents);
  if (debit !== intended * BigInt(postingCount)) return null;
  return { currency: instruction.currency, intended: asDecimal(intended), actual: asDecimal(debit), excess: asDecimal(debit - intended) };
}

export function postingDiscrepancy(report) {
  if (report.prototype !== false || report.exception_type !== 'AMOUNT_MISMATCH') return null;
  const currency = report.supporting_evidence?.original?.currency;
  const difference = report.financial_impact?.difference;
  const signed = currencyAmount(currency, difference);
  if (!signed) return null;
  const direction = Math.sign(Number(difference));
  if (!direction) return { label: 'No posting difference', value: currencyAmount(currency, '0.00'), signed, warning: false };
  return {
    label: direction < 0 ? 'Posting shortfall' : 'Amount overposted',
    value: currencyAmount(currency, String(difference).replace(/^-/, '')),
    signed,
    warning: true,
  };
}

export function financialMetrics(report) {
  const data = report.financial_impact;
  if (report.prototype !== false || !data) return [];
  const currency = report.supporting_evidence?.original?.currency;
  const count = value => Number.isInteger(value) && value >= 0 ? String(value) : null;

  if (report.exception_type === 'AMOUNT_MISMATCH') {
    const difference = postingDiscrepancy(report);
    return [
      ['Instructed amount', currencyAmount(currency, data.expectedAmount), 'Source payment instruction'],
      ['Posted amount', currencyAmount(currency, data.postedAmount), 'Aligned ledger journal in the saved report'],
      [difference?.label || 'Posting discrepancy', difference?.value ?? null, 'Compared with the instructed amount', difference?.warning],
    ];
  }
  if (report.exception_type === 'MISSING_LEDGER_POSTING') return [
    ['Expected payment', currencyAmount(currency, data.expectedAmount), 'Source payment instruction'],
    ['Linked journals', count(data.linkedJournalCount), 'Modern ledger records'],
    ['Legacy records', count(data.legacyRecordCount), 'Legacy ledger lookup'],
  ];

  const duplicate = confirmedDuplicateAmounts(report, data);
  if (duplicate) return [
    ['Intended transfer', currencyAmount(duplicate.currency, duplicate.intended), 'One verified instruction'],
    ['Posted transfer movement', currencyAmount(duplicate.currency, duplicate.actual), 'Debit side in the saved report'],
    ['Apparent duplicate excess', currencyAmount(duplicate.currency, duplicate.excess), 'Posted amount above the intended transfer', duplicate.excess !== '0.00'],
  ];

  const debitTotals = Object.entries(data.validDebitTotals || {});
  const debits = debitTotals.map(([code, value]) => currencyAmount(code, value)).filter(Boolean);
  return [
    ['Verified posted journals', count(data.confirmedPostedJournalCount), 'Validated journal count'],
    ['Verified debit totals', debits.join(' / ') || null, 'Outgoing accounting side, by currency'],
  ];
}
