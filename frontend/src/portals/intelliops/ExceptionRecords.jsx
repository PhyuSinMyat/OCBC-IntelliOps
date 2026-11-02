import React, { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import RecordDrawer from '../../shared/components/RecordDrawer.jsx';
import { backendConnected, postingTime, runPaymentDetection, useBankingRecords } from '../../shared/data/bankingRecords.js';

export default function ExceptionRecords({ investigation = false, audit = false }) {
  const records = useBankingRecords();
  const [params, setParams] = useSearchParams();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const cases = records.exception_cases || [];
  const selected = cases.find(c => c.id === params.get('case'));
  const title = audit ? 'Audit Trail' : investigation ? 'AI Investigation' : 'Exception Center';
  async function detect() {
    setBusy(true);
    try { const count = await runPaymentDetection(backendConnected ? records.role : sessionStorage.getItem('payment-demo-role') || 'ANALYST'); setNotice(`Detection completed: ${count} new cases. Cases awaiting their reconciliation cutoff are not created early.`); }
    catch (error) { setNotice(error.message); }
    finally { setBusy(false); }
  }
  return <>
    <div className="page-heading"><p className="eyebrow">Operations command center</p><h1>{title}</h1><p>{audit ? 'Recorded simulation and detection actions.' : 'Investigate exceptions detected from payment and ledger source evidence.'}</p></div>
    <p className="account-demo">{backendConnected ? 'Connected synthetic database' : 'Browser-only synthetic simulation'}{investigation ? ' · Evidence review is available; AI orchestration is not connected.' : ''}</p>
    {!audit && <button className="simulation-button" disabled={busy} onClick={detect}>{busy ? 'Running detection…' : 'Run Detection'}</button>}{notice && <p role="status">{notice}</p>}
    <section className="accounts-panel"><div className="account-table-scroll"><table className="account-table"><thead><tr>{(audit ? ['Reference', 'Action', 'Actor', 'Occurred at (SGT)'] : ['Case reference', 'Transaction', 'Exception type', 'Severity', 'Lifecycle status']).map(text => <th key={text}>{text}</th>)}</tr></thead><tbody>{audit ? (records.audit_events || []).map(e => <tr key={e.id}><td>{e.reference}</td><td>{e.action}</td><td>{e.actor}</td><td>{postingTime(e.createdAt)}</td></tr>) : cases.map(c => <tr key={c.id}><td><button className="account-link" onClick={() => setParams({ case: c.id })}>{c.id}</button></td><td><Link className="account-link" to={'/payments/transactions?transaction=' + encodeURIComponent(c.transactionId)}>{c.transactionId}</Link></td><td>{c.exceptionType}</td><td>{c.severity}</td><td>{c.status}</td></tr>)}</tbody></table></div>{!(audit ? records.audit_events?.length : cases.length) && <div className="account-empty"><h3>{audit ? 'No audit events yet' : 'No detected exceptions'}</h3><p>{audit ? 'Simulation actions and detection runs will appear here.' : 'Create source scenarios in Payment Processing, wait for the matching cutoff, then run detection.'}</p></div>}</section>
    {!audit && <RecordDrawer open={!!params.get('case')} title={selected?.id || 'Case unavailable'} onClose={() => setParams({}, { replace: true })}>{selected ? <>
      <h3 className="drawer-section-title">{selected.exceptionType}</h3><dl className="account-facts">{[['Transaction', selected.transactionId], ['Severity', selected.severity], ['Lifecycle status', selected.status], ['Detected at', postingTime(selected.createdAt)]].map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>
      <h3 className="drawer-section-title">Source evidence</h3><dl className="account-facts evidence-facts">{Object.entries(selected.evidence).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{typeof value === 'object' ? JSON.stringify(value) : String(value)}</dd></div>)}</dl>
      <p><Link className="account-link" to={'/payments/transactions?transaction=' + encodeURIComponent(selected.transactionId)}>Open Payment Transaction</Link></p>
      {selected.evidence.journalReference && records.ledger_journals.some(j => j.id === selected.evidence.journalReference) && <p><Link className="account-link" to={'/core-banking/journals?journal=' + encodeURIComponent(selected.evidence.journalReference)}>Open Ledger Journal</Link></p>}
      {!investigation && <p><Link className="account-link" to={'/intelliops/investigation?case=' + encodeURIComponent(selected.id)}>Investigate Evidence</Link></p>}
      <p className="history-caption">This case remains open. Detection does not execute a correction or mark it resolved.</p>
    </> : <p>This case is unavailable in the current source dataset.</p>}</RecordDrawer>}
  </>;
}
