import React, { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import RecordDrawer from './RecordDrawer';
import { accounts, money, postingTime, postTransfer, useBankingRecords, validJournal } from './bankingRecords.js';

export default function BankingRecords({ payments = false }) {
  const state = useBankingRecords();
  const [params, setParams] = useSearchParams();
  const key = payments ? 'transaction' : 'journal';
  const id = params.get(key);
  const rows = payments ? state.payment_transactions : state.ledger_journals;
  const selected = rows.find(r => r.id === id);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const close = () => { const next = new URLSearchParams(params); next.delete(key); setParams(next, { replace: true }); };
  function submit(event) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const text = values.get('amount');
    if (!/^\d+(\.\d{1,2})?$/.test(text)) { setError('Enter a positive amount with at most two decimal places.'); return; }
    try {
      postTransfer({ senderId: values.get('sender'), receiverId: values.get('receiver'), amountCents: Math.round(Number(text) * 100), postedAt: new Date().toISOString() });
      setError(''); setCreating(false);
    } catch (e) { setError(e.message); }
  }
  return <><div className="page-heading"><p className="eyebrow">{payments ? 'Transaction operations' : 'Accounting records'}</p><h1>{payments ? 'Transactions' : 'Ledger Journals'}</h1><p>Shared synthetic records linked to account balances.</p></div><p className="account-demo">Local simulation only · Records persist while this app is open and reset on refresh.</p>
    {!payments && <button className="simulation-button" onClick={() => setCreating(!creating)}>Create synthetic transfer</button>}
    {creating && <form className="transfer-form" onSubmit={submit}><h2>Create synthetic transfer</h2><p>Post a balanced transfer between two active accounts in the same currency.</p>{['sender', 'receiver'].map(name => <label key={name}>{name === 'sender' ? 'Sending account' : 'Receiving account'}<select name={name} required defaultValue={name === 'sender' ? 'ACC-100003' : 'ACC-100001'}>{accounts.filter(a => a.status === 'Active').map(a => <option key={a.id} value={a.id}>{a.id} · {a.customer} · {a.currency}</option>)}</select></label>)}<label>Amount<input name="amount" inputMode="decimal" required placeholder="0.00"/></label>{error && <p role="alert" className="movement-out">{error}</p>}<button className="simulation-button" type="submit">Post synthetic transfer</button><button type="button" className="account-link" onClick={() => { setCreating(false); setError(''); }}>Cancel</button></form>}
    <section className="accounts-panel"><div className="account-table-scroll"><table className="account-table"><thead><tr><th>Reference</th><th>{payments ? 'Amount' : 'Payment reference'}</th><th>Status</th><th>{payments ? 'Created at (SGT)' : 'Posted at (SGT)'}</th></tr></thead><tbody>{rows.map(row => <tr key={row.id}><td><button className="account-link" onClick={() => setParams({ [key]: row.id })}>{row.id}</button></td><td>{payments ? money(row.amountCents, row.currency) : state.payment_transactions.some(p => p.id === row.paymentId) ? <Link className="account-link" to={'/payments/transactions?transaction=' + row.paymentId}>{row.paymentId}</Link> : 'Payment unavailable'}</td><td>{row.status}</td><td>{row.postedAt || row.createdAt ? postingTime(row.postedAt || row.createdAt) : 'Not posted'}</td></tr>)}</tbody></table></div></section>
    <RecordDrawer open={!!id} title={selected?.id || 'Record unavailable'} onClose={close}>{!selected ? <p>This record is unavailable in the shared simulation dataset.</p> : payments ? <><dl className="account-facts">{[['Status', selected.status], ['Amount', money(selected.amountCents, selected.currency)], ['Sending account', selected.senderId], ['Receiving account', selected.receiverId], ['Created at (SGT)', postingTime(selected.createdAt)]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl><h3 className="drawer-section-title">Linked journals</h3>{state.ledger_journals.some(j => j.paymentId === selected.id) ? state.ledger_journals.filter(j => j.paymentId === selected.id).map(j => <p key={j.id}><Link className="account-link" to={'/core-banking/journals?journal=' + j.id}>{j.id}</Link> · {j.status}</p>) : <p>No ledger posting available. This payment does not affect account balances.</p>}</> : <><p>{selected.status} · {selected.currency}</p><p>{selected.postedAt ? postingTime(selected.postedAt) + ' SGT' : 'Not posted'}</p><p>{state.payment_transactions.some(p => p.id === selected.paymentId) ? <Link className="account-link" to={'/payments/transactions?transaction=' + selected.paymentId}>{selected.paymentId}</Link> : 'Payment unavailable'}</p><h3 className="drawer-section-title">Journal entries</h3>{state.ledger_entries.filter(e => e.journalId === selected.id).map(e => <article className="posted-entry" key={e.id}><p>{e.description}</p><div className="posted-entry-top"><span>{e.accountId}</span><strong>{e.side}: {money(e.amountCents, e.currency)}</strong></div></article>)}<dl className="account-facts">{['Debit', 'Credit'].map(side => <div key={side}><dt>Total {side.toLowerCase()}s</dt><dd>{money(state.ledger_entries.filter(e => e.journalId === selected.id && e.side === side).reduce((sum, e) => sum + e.amountCents, 0), selected.currency)}</dd></div>)}</dl><p>{validJournal(state, selected) ? 'Balanced · Included in account balances' : 'Excluded from account balances'}</p></>}</RecordDrawer>
  </>;
}
