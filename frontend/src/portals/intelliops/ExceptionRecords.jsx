import React, { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import RecordDrawer from '../../shared/components/RecordDrawer.jsx';
import { addExceptionNote, backendConnected, closeException, fetchExceptionCase, postingTime,
  remediateException, runPaymentDetection, useBankingRecords } from '../../shared/data/bankingRecords.js';

const actionLabels = {
  'Missing Ledger Posting': 'Post Missing Ledger Journal',
  'Amount Mismatch': 'Post Shortfall Adjustment',
  'Duplicate Transaction': 'Reject Duplicate Transaction',
  'Payment Processing Failure': 'Retry Failed Payment',
};

export default function ExceptionRecords({ investigation = false, audit = false }) {
  const records = useBankingRecords();
  const [params, setParams] = useSearchParams();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [detail, setDetail] = useState(null);
  const [note, setNote] = useState('');
  const cases = records.exception_cases || [];
  const summary = cases.find(c => c.id === params.get('case'));
  const selected = detail?.id === params.get('case') ? detail : summary;
  const title = audit ? 'Audit Trail' : investigation ? 'AI Investigation' : 'Exception Center';

  useEffect(() => {
    const id = params.get('case');
    setDetail(null); setNote('');
    if (!id) return;
    let current = true;
    fetchExceptionCase(id).then(value => { if (current) setDetail(value); })
      .catch(error => { if (current) setNotice(error.message); });
    return () => { current = false; };
  }, [params]);

  async function perform(action, success) {
    if (!selected) return;
    setBusy(true); setNotice('');
    try { const value = await action(selected.id, note.trim()); setDetail(value); setNote(''); setNotice(success); }
    catch (error) { setNotice(error.message); }
    finally { setBusy(false); }
  }
  async function detect() {
    setBusy(true); setNotice('');
    try { const count = await runPaymentDetection(backendConnected ? records.role : sessionStorage.getItem('payment-demo-role') || 'ANALYST'); setNotice(`Detection completed: ${count} new cases. Cases awaiting their reconciliation cutoff are not created early.`); }
    catch (error) { setNotice(error.message); }
    finally { setBusy(false); }
  }

  return <>
    <div className="page-heading"><p className="eyebrow">Operations command center</p><h1>{title}</h1><p>{audit ? 'Recorded simulation and detection actions.' : 'Investigate and resolve exceptions detected from payment and ledger source evidence.'}</p></div>
    <p className="account-demo">{backendConnected ? `Connected synthetic database · Authenticated ${records.role}` : 'Browser-only synthetic simulation'}{investigation ? ' · Deterministic evidence review and controlled resolution.' : ''}</p>
    {!audit && <button className="simulation-button" disabled={busy} onClick={detect}>{busy ? 'Running detection…' : 'Run Detection'}</button>}{notice && <p className="payment-feedback" role="status">{notice}</p>}
    <section className="accounts-panel"><div className="account-table-scroll"><table className="account-table"><thead><tr>{(audit ? ['Reference', 'Action', 'Actor', 'Occurred at (SGT)'] : ['Case reference', 'Transaction', 'Exception type', 'Severity', 'Lifecycle status']).map(text => <th key={text}>{text}</th>)}</tr></thead><tbody>{audit ? (records.audit_events || []).map(e => <tr key={e.id}><td>{e.reference}</td><td>{e.action}</td><td>{e.actor}</td><td>{postingTime(e.createdAt)}</td></tr>) : cases.map(c => <tr key={c.id}><td><button className="account-link" onClick={() => setParams({ case: c.id })}>{c.id}</button></td><td><Link className="account-link" to={'/payments/transactions?transaction=' + encodeURIComponent(c.transactionId)}>{c.transactionId}</Link></td><td>{c.exceptionType}</td><td>{c.severity}</td><td>{c.status}</td></tr>)}</tbody></table></div>{!(audit ? records.audit_events?.length : cases.length) && <div className="account-empty"><h3>{audit ? 'No audit events yet' : 'No detected exceptions'}</h3><p>{audit ? 'Simulation actions and detection runs will appear here.' : 'Create source scenarios in Payment Processing, wait for the matching cutoff, then run detection.'}</p></div>}</section>
    {!audit && <RecordDrawer open={!!params.get('case')} title={selected?.id || 'Case unavailable'} onClose={() => setParams({}, { replace: true })}>{selected ? <>
      <h3 className="drawer-section-title">{selected.exceptionType}</h3><dl className="account-facts">{[['Transaction', selected.transactionId], ['Severity', selected.severity], ['Lifecycle status', selected.status], ['Detected at', postingTime(selected.createdAt)]].map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>
      <h3 className="drawer-section-title">Source evidence</h3><dl className="account-facts evidence-facts">{Object.entries(selected.evidence || {}).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{typeof value === 'object' ? JSON.stringify(value) : String(value)}</dd></div>)}</dl>
      {selected.resolutionSummary && <><h3 className="drawer-section-title">Resolution</h3><p>{selected.resolutionSummary}</p>{selected.remediation?.journalReference && <p><Link className="account-link" to={'/core-banking/journals?journal=' + encodeURIComponent(selected.remediation.journalReference)}>Open Corrective Journal</Link></p>}</>}
      {selected.timeline?.length > 0 && <><h3 className="drawer-section-title">Case timeline</h3><ol className="case-timeline">{selected.timeline.map(item => <li key={item.id}><strong>{item.actionType.replaceAll('_', ' ')}</strong><span>{item.actor} · {postingTime(item.createdAt)}</span>{item.details?.note && <p>{item.details.note}</p>}</li>)}</ol></>}
      <p><Link className="account-link" to={'/payments/transactions?transaction=' + encodeURIComponent(selected.transactionId)}>Open Payment Transaction</Link></p>
      {selected.evidence?.journalReference && records.ledger_journals.some(j => j.id === selected.evidence.journalReference) && <p><Link className="account-link" to={'/core-banking/journals?journal=' + encodeURIComponent(selected.evidence.journalReference)}>Open Ledger Journal</Link></p>}
      {!investigation && <p><Link className="account-link" to={'/intelliops/investigation?case=' + encodeURIComponent(selected.id)}>Investigate Evidence</Link></p>}
      {backendConnected && ['OPEN', 'IN_REVIEW'].includes(selected.status) && <section className="case-actions" aria-label="Case actions">
        <h3 className="drawer-section-title">Controlled action</h3>
        <label htmlFor="case-note">Review note</label><textarea id="case-note" value={note} onChange={event => setNote(event.target.value)} maxLength={1000} placeholder="Record evidence reviewed or an approval note." disabled={busy}/>
        <div><button className="account-link" disabled={busy || !note.trim()} onClick={() => perform(addExceptionNote, 'Review note added.')}>Add Review Note</button>
        {records.role === 'ADMIN' && actionLabels[selected.exceptionType] && <button className="simulation-button" disabled={busy} onClick={() => perform(remediateException, 'Resolution completed and source records refreshed.')}>{actionLabels[selected.exceptionType]}</button>}</div>
      </section>}
      {backendConnected && selected.status === 'RESOLVED' && <button className="simulation-button" disabled={busy} onClick={() => perform(closeException, 'Case closed.')}>Close Resolved Case</button>}
      {!backendConnected && <p className="history-caption">Connect to the backend with an ADMIN token to execute controlled resolutions.</p>}
    </> : <p>This case is unavailable in the current source dataset.</p>}</RecordDrawer>}
  </>;
}
