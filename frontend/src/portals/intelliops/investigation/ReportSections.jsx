import React from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, CircleHelp, ChevronRight, FileText } from 'lucide-react';

export const humanize = value => (value || 'NOT_STARTED').replaceAll('_', ' ').toLowerCase().replace(/^./, c => c.toUpperCase());
export const displayTime = value => value && Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat('en-SG', { dateStyle: 'medium', timeStyle: 'medium', timeZone: 'Asia/Singapore' }).format(new Date(value)) + ' SGT' : 'Unavailable';
export const amount = p => p && Number.isSafeInteger(p.amountCents) && p.currency ? `${p.currency} ${(p.amountCents / 100).toLocaleString('en-SG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : 'Unavailable';
export function SourceLink({ kind = 'payment', reference, fixture }) {
  if (!reference) return <span className="inv-muted">Unavailable</span>;
  if (fixture) return <span>{reference} <small className="inv-muted">(fixture)</small></span>;
  const route = kind === 'payment' ? '/payments/transactions?transaction=' : '/core-banking/journals?journal=';
  return <Link className="inv-link" to={route + encodeURIComponent(reference)}>{reference}<ChevronRight size={13}/></Link>;
}
export function Section({ title, children, className = '', ...props }) {
  return <section className={`inv-section ${className}`} {...props}><h2>{title}</h2>{children}</section>;
}
export function PaymentComparison({ report }) {
  const s = report.supporting_evidence, payments = report.payment_comparison;
  const account = ref => s.accounts.find(a => a.id === ref)?.customer || ref || 'Unavailable';
  const rows = [
    ['Payment reference', (p) => <SourceLink reference={p?.id} fixture={s.fixture}/>],
    ['Business instruction reference', p => p?.businessReference || 'Unavailable'],
    ['Source original-payment link', p => p?.originalPaymentId || 'Unavailable'],
    ['Sender', p => account(p?.senderId)], ['Receiver', p => account(p?.receiverId)], ['Amount', p => amount(p)],
    ['Payment status', p => p?.status || 'Unavailable'],
    ['Ledger journals', (p, i) => report.financial_execution_assessment[i ? 'duplicate' : 'original'].journals.map(ref => <SourceLink key={ref} kind="journal" reference={ref} fixture={s.fixture}/>)],
    ['Execution assessment', (p, i) => report.financial_execution_assessment[i ? 'duplicate' : 'original'].execution],
  ];
  return <Section title="Payment Comparison"><p className="inv-muted">Matching attributes support correlation; they do not prove the same intended instruction on their own.</p><div className="inv-table-scroll" tabIndex={0} role="region" aria-label="Payment comparison"><table className="inv-table inv-comparison-table"><thead><tr><th>Field</th><th>Original payment</th><th>Suspected duplicate</th></tr></thead><tbody>{rows.map(([label, render]) => {
    const values = payments.map((p, i) => render(p, i));
    const matches = typeof values[0] === 'string' && values[0] !== 'Unavailable' && values[0] === values[1];
    return <tr key={label}><th scope="row">{label}</th>{values.map((value, i) => <td data-label={i ? 'Suspected duplicate' : 'Original payment'} className={matches ? 'inv-match' : ''} key={i}>{Array.isArray(value) && !value.length ? <span className="inv-muted">None found in snapshot</span> : value}{matches && i === 1 && <small className="inv-match-label">Matches original</small>}</td>)}</tr>;
  })}</tbody></table></div></Section>;
}
export function FinancialAssessment({ report }) {
  const f = report.financial_execution_assessment, s = report.supporting_evidence;
  return <Section title="Financial Execution Assessment"><p className="inv-kicker">{f.classification}</p><div className="inv-payment-pair">{[f.original, f.duplicate].map((p, i) => <div key={i}><h3>{i ? 'Suspected duplicate' : 'Original payment'}</h3><SourceLink reference={p.payment_ref} fixture={s.fixture}/><p><strong>{p.execution}</strong></p><p>{p.reason}</p>{p.journals.map(ref => <SourceLink key={ref} kind="journal" reference={ref} fixture={s.fixture}/>)}</div>)}</div><p className="inv-assessment">{f.explanation}</p>{f.classification === 'DOUBLE_POSTING_CONFIRMED' && report.diagnosis_classification !== 'LEGITIMATE_SEPARATE_INSTRUCTIONS' && <p className="inv-warning">Potential duplicate financial execution requires authorized human review. No automatic reversal is proposed.</p>}</Section>;
}
export function InvestigationTrace({ report }) {
  const s = report.supporting_evidence;
  return <Section title="Investigation Trace" id="investigation-trace"><p className="inv-muted">Source events and diagnostic checks, not an internal AI reasoning transcript.</p><ol className="inv-trace">{report.investigation_trace.map(e => <li key={e.id}><span className="inv-trace-dot"/><details><summary><span>{humanize(e.eventType)}</span><time>{displayTime(e.occurredAt)}</time></summary><p>{e.description || 'No event description recorded.'}</p><dl className="inv-detail-list"><div><dt>Source event</dt><dd>{e.id}</dd></div><div><dt>Payment</dt><dd><SourceLink reference={e.paymentId} fixture={s.fixture}/></dd></div><div><dt>Error / correlation</dt><dd>{e.errorCode || 'None recorded'} / {e.correlationId || 'Unavailable'}</dd></div></dl><details><summary>Complete event payload</summary><pre>{JSON.stringify(e, null, 2)}</pre></details></details></li>)}{!report.investigation_trace.length && <li>No processing events are available in this snapshot.</li>}</ol><div className="inv-checks"><h3>Diagnostic checks</h3><p>Instruction relationship: {humanize(report.diagnosis_classification)}</p><p>Ledger validation: {humanize(report.financial_execution_assessment.classification)}</p><p>Checks use snapshot {displayTime(report.evidence_snapshot_at)}.</p></div></Section>;
}
export function SupportingEvidence({ report }) {
  const s = report.supporting_evidence;
  return <Section title="Supporting Evidence"><details><summary>Payment Processing · {s.events.length} events</summary>{[s.original, s.duplicate].filter(Boolean).map(p => <div className="inv-evidence-record" key={p.id}><SourceLink reference={p.id} fixture={s.fixture}/><p>{amount(p)} · {p.status}</p><p>Business reference: {p.businessReference || 'Unavailable'} · Request ID: {p.paymentId || 'Unavailable'}</p><p>Idempotency key and submission-attempt logs are not exposed by the current shared snapshot.</p></div>)}</details><details><summary>Core Banking / Ledger · {s.journals.length} linked journals</summary>{!s.journals.length && <p>No linked journals found in this snapshot. This is not proof of non-execution.</p>}{s.journals.map(j => <div className="inv-evidence-record" key={j.id}><SourceLink kind="journal" reference={j.id} fixture={s.fixture}/><p>{j.status} · {displayTime(j.postedAt)}</p><div className="inv-table-scroll" role="region" aria-label={`Entries for ${j.id}`} tabIndex={0}><table className="inv-table"><thead><tr><th>Entry</th><th>Account</th><th>Side</th><th>Amount</th><th>Posted</th></tr></thead><tbody>{s.entries.filter(e => e.journalId === j.id).map(e => <tr key={e.id}><td>{e.id}</td><td>{e.accountId}</td><td>{e.side}</td><td>{amount(e)}</td><td>{e.posted === false ? 'No' : 'Yes'}</td></tr>)}</tbody></table></div></div>)}</details><details><summary>Diagnostic Evidence · holds, retries and errors</summary>{s.events.filter(e => e.errorCode || ['ACK_TIMEOUT', 'RETRY_SUBMITTED', 'DUPLICATE_BLOCKED'].includes(e.eventType)).map(e => <div key={e.id} className="inv-evidence-record"><strong>{humanize(e.eventType)}</strong><p>{e.description}</p><p>Event {e.id} · Correlation {e.correlationId || 'Unavailable'} · Error {e.errorCode || 'None recorded'}</p></div>)}<p className="inv-muted">Only explicitly recorded events are used. No timeout or retry cause is inferred from a duplicate alert.</p></details></Section>;
}
export function Diagnosis({ report }) {
  const strong = report.evidence_strength === 'Strong supporting evidence';
  const Icon = strong ? CheckCircle2 : CircleHelp;
  return <Section title="Root Cause Analysis" className={`inv-diagnosis ${strong ? 'inv-supported' : ''}`}><div className="inv-strength"><Icon size={17}/>{report.evidence_strength}</div><h3 className="inv-cause">{report.root_cause_title}</h3><p>{report.root_cause_explanation}</p><p className="inv-kicker">{report.diagnosis_classification}</p><h3>Uncertainty and evidence gaps</h3>{report.unresolved_questions.length ? <ul>{report.unresolved_questions.map(q => <li key={q}>{q}</li>)}</ul> : <p>The fixture supports this diagnosis within the recorded snapshot. Current operational state still requires verification before resolution.</p>}<p className="inv-muted"><FileText size={13}/> Diagnosis generated by deterministic prototype checks, not a live LLM.</p></Section>;
}
