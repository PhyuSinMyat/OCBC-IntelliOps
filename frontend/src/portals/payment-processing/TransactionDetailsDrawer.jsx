import React, { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import RecordDrawer from '../../shared/components/RecordDrawer.jsx';
import { accounts, money, postingTime, useBankingRecords } from '../../shared/data/bankingRecords.js';
import { typeLabel } from '../core-banking/accountFilters.js';

export const timestamp = value => value && Number.isFinite(Date.parse(value)) ? postingTime(value) : '—';
export const StatusBadge = ({ status }) => <span className={`payment-status ${['Completed', 'Failed', 'Pending', 'Processing', 'Held'].includes(status) ? status.toLowerCase() : 'other'}`}>{status}</span>;

export default function TransactionDetailsDrawer({ id, onClose }) {
  const records = useBankingRecords();
  const payment = records.payment_transactions.find(p => p.id === id);
  const [tab, setTab] = useState('Overview');
  const refs = useRef([]);
  const tabs = ['Overview', 'Processing History', 'Related Records'];
  const journals = records.ledger_journals.filter(j => j.paymentId === id || j.sourcePaymentId === id);
  const cases = (records.exception_cases || []).filter(c => c.transactionId === id || c.relatedTransactionId === id);
  const related = new Set(payment?.relatedPaymentReferences || []);
  cases.forEach(c => { related.add(c.transactionId); related.add(c.relatedTransactionId); });
  related.delete(id); related.delete(null); related.delete(undefined);
  const events = (records.processing_events || []).filter(e => e.paymentId === id).sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
  const facts = rows => <dl className="account-facts">{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value || 'Unavailable'}</dd></div>)}</dl>;
  const partyFacts = (name, accountId) => {
    const account = accounts.find(a => a.id === accountId);
    return <section><h3 className="drawer-section-title">{name}</h3>{facts([['Customer name', account?.customer], ['Account reference', account?.reference], ['Customer type', typeLabel(account?.customerType)], ['Account type', typeLabel(account?.accountType)]])}</section>;
  };
  return <RecordDrawer open={!!id} title={payment?.id || 'Record unavailable'} onClose={onClose}>{!payment ? <p>This record is unavailable in the shared simulation dataset.</p> : <>
    <div className="payment-detail-tabs" role="tablist" aria-label="Transaction details">{tabs.map((label, index) => <button key={label} ref={node => { refs.current[index] = node; }} role="tab" id={`payment-tab-${index}`} aria-selected={tab === label} aria-controls="payment-detail-panel" tabIndex={tab === label ? 0 : -1} onClick={() => setTab(label)} onKeyDown={e => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
      e.preventDefault();
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? 2 : (index + (e.key === 'ArrowRight' ? 1 : -1) + 3) % 3;
      setTab(tabs[next]); refs.current[next]?.focus();
    }}>{label}</button>)}</div>
    <div id="payment-detail-panel" role="tabpanel" aria-labelledby={`payment-tab-${tabs.indexOf(tab)}`} tabIndex={0}>
      {tab === 'Overview' && <>
        <section className="account-balance" aria-label="Payment amount"><span>Payment amount</span><strong>{money(payment.amountCents, payment.currency)}</strong><StatusBadge status={payment.status}/></section>
        <h3 className="drawer-section-title">Payment information</h3>{facts([['Transaction reference', payment.id], ['Processing status', payment.status], ['Currency', payment.currency], ['Initiated at', timestamp(payment.createdAt)], ['Completed at', timestamp(payment.completedAt)]])}
        {partyFacts('Sender', payment.senderId)}{partyFacts('Receiver', payment.receiverId)}
        {(payment.requests || []).map(r => <section key={r.requestId}><h3 className="drawer-section-title">Request evidence</h3>
          {facts([['Instruction reference', r.instructionReference], ['Request ID', r.requestId], ['Origin', r.origin],
            ['Retry of request', r.retryOfRequestId], ['Authorization reference', r.authorizationId], ['Received at', timestamp(r.receivedAt)]])}</section>)}
        {(payment.failureCode || payment.failureDescription) && <section className="payment-error"><h3>Processing error</h3>{facts([['Error code', payment.failureCode], ['Description', payment.failureDescription]])}</section>}
      </>}
      {tab === 'Processing History' && <section><h3 className="drawer-section-title">Processing history</h3><p className="history-caption">Actual recorded events · Chronological · Singapore time</p>{events.length ? <ol className="processing-timeline">{events.map(e => <li key={e.id}><strong>{e.eventType.replaceAll('_', ' ').toLowerCase().replace(/^./, c => c.toUpperCase())}</strong><time dateTime={e.occurredAt}>{timestamp(e.occurredAt)}</time><span className="customer-type-badge">{e.status || 'Status unavailable'}</span><p>{e.description}</p>{e.errorCode && <p className="movement-out">Error: {e.errorCode}</p>}</li>)}</ol> : <p className="account-empty">No processing events were recorded for this existing transaction.</p>}</section>}
      {tab === 'Related Records' && <>
        <h3 className="drawer-section-title">Related Payments</h3>{[...related].map(ref => <p key={ref}><Link className="account-link"
          to={'/payments/transactions?transaction=' + encodeURIComponent(ref)}>{ref}</Link></p>)}
        <h3 className="drawer-section-title">Linked Ledger Journal</h3>{journals.length ? journals.map(j => {
          const total = side => records.ledger_entries.filter(e => e.journalId === j.id && e.side === side).reduce((sum, e) => sum + e.amountCents, 0);
          return <article className="posted-entry" key={j.id}>{facts([['Journal reference', j.id], ['Status', j.status], ['Posting timestamp', timestamp(j.postedAt)], ['Payment reference', j.paymentId], ['Debit total', money(total('Debit'), j.currency)], ['Credit total', money(total('Credit'), j.currency)]])}<Link className="account-link" to={'/core-banking/journals?journal=' + encodeURIComponent(j.id)}>Open Ledger Journal</Link></article>;
        }) : <p className="account-empty">No corresponding ledger journal found.</p>}
        <h3 className="drawer-section-title">Linked IntelliOps Exceptions</h3>{cases.length ? cases.map(c => <article className="posted-entry" key={c.id}>{facts([['Case reference', c.id], ['Exception type', c.exceptionType], ['Severity', c.severity], ['Lifecycle status', c.status]])}<Link className="account-link" to={'/intelliops/exceptions?case=' + encodeURIComponent(c.id)}>Open IntelliOps Case</Link></article>) : <p className="account-empty">No linked exceptions.</p>}
      </>}
    </div>
  </>}</RecordDrawer>;
}
