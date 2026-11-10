// Isolated development evidence. Never merged into the banking record store.
export const fixtureOptions = {
  prevented: 'A · Retry held before posting',
  double: 'B · Both payments posted',
  legitimate: 'C · Separate verified instructions',
  uncertain: 'D · Execution evidence unavailable',
};

export function developmentFixture(name) {
  if (!Object.hasOwn(fixtureOptions, name)) return null;
  const original = 'DEV-PAY-1001', duplicate = 'DEV-PAY-1002';
  const time = seconds => `2026-11-09T02:00:${String(seconds).padStart(2, '0')}Z`;
  const payment = (id, second) => ({ id, senderId: 'DEV-SENDER', receiverId: 'DEV-RECEIVER', amountCents: 500000,
    currency: 'SGD', status: second && name === 'prevented' ? 'Pending' : 'Completed', createdAt: time(second ? 4 : 0),
    businessReference: second && name === 'legitimate' ? 'DEV-INS-5002' : 'DEV-INS-5001', instructionVerified: true,
    originalPaymentId: second && name !== 'legitimate' ? original : null });
  const event = (id, paymentId, eventType, second, description, extra = {}) => ({ id, paymentId, eventType, occurredAt: time(second), description, ...extra });
  const events = [event('DEV-E1', original, 'PAYMENT_CREATED', 0, 'Original instruction received.'),
    event('DEV-E2', duplicate, 'PAYMENT_CREATED', 4, 'Second instruction received.')];
  if (name === 'prevented') events.push(
    event('DEV-E3', original, 'ACK_TIMEOUT', 3, 'Client acknowledgement timed out.', { correlationId: 'DEV-CORR-1' }),
    event('DEV-E4', duplicate, 'RETRY_SUBMITTED', 4, 'Client resubmitted the original instruction.', { correlationId: 'DEV-CORR-1' }),
    event('DEV-E5', duplicate, 'DUPLICATE_BLOCKED', 5, 'Request held before financial execution.', { status: 'PENDING' }));
  const postedRefs = name === 'uncertain' ? [] : name === 'prevented' ? [original] : [original, duplicate];
  const journals = postedRefs.map((ref, i) => ({ id: `DEV-JRN-${i + 1}`, paymentId: ref, sourcePaymentId: ref,
    status: 'Posted', currency: 'SGD', postedAt: time(i ? 6 : 2) }));
  const entries = journals.flatMap(j => ['Debit', 'Credit'].map(side => ({ id: `${j.id}-${side}`, journalId: j.id,
    accountId: side === 'Debit' ? 'DEV-SENDER' : 'DEV-RECEIVER', side, amountCents: 500000, currency: 'SGD', posted: true })));
  journals.forEach(j => events.push(event(`${j.id}-event`, j.paymentId, 'LEDGER_POSTED', j.paymentId === original ? 2 : 6, `Posted journal ${j.id}.`)));
  const caseRecord = { id: `DEV-CASE-${name.toUpperCase()}`, transactionId: duplicate, exceptionType: 'Duplicate Transaction',
    severity: 'HIGH', status: 'OPEN', createdAt: time(7), evidence: { originalReference: original,
      businessReference: 'DEV-INS-5001', observedAt: time(7) } };
  return { fixture: name, caseRecord, accounts: [{ id: 'DEV-SENDER', customer: 'Development Trading', currency: 'SGD' },
    { id: 'DEV-RECEIVER', customer: 'Development Supplier', currency: 'SGD' }],
    records: { payment_transactions: [payment(original, false), payment(duplicate, true)], processing_events: events,
      ledger_journals: journals, ledger_entries: entries } };
}
