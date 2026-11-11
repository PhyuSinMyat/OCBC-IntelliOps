import React, { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import RecordDrawer from './RecordDrawer';
import { accounts, backendConnected, money, postingTime, postTransfer, refreshBackend, useBankingRecords, validJournal } from '../data/bankingRecords.js';

export default function BankingRecords({ payments = false }) {
  const state = useBankingRecords();
  const [params, setParams] = useSearchParams();
  const key = payments ? 'transaction' : 'journal';
  const id = params.get(key);
  const rows = [...(payments ? state.payment_transactions : state.ledger_journals)].sort((a, b) => (Date.parse(b.postedAt || b.createdAt) || 0) - (Date.parse(a.postedAt || a.createdAt) || 0) || b.id.localeCompare(a.id));
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
  return <><div className="page-heading"><p className="eyebrow">{payments ? 'Transaction operations' : 'Accounting records'}</p><h1>{payments ? 'Transactions' : 'Ledger Journals'}</h1><p>Shared synthetic records linked to account balances.</p></div><p className="account-demo">{backendConnected ? 'Connected synthetic database - Balances and journals reflect persisted ledger postings.' : 'Local simulation - Records are saved in this browser across portal navigation and refresh.'}</p>
    {!payments && !backendConnected && <button className="simulation-button" onClick={() => setCreating(!creating)}>Create synthetic transfer</button>}
    {creating && <form className="transfer-form" onSubmit={submit}><h2>Create synthetic transfer</h2><p>Post a balanced transfer between two active accounts in the same currency.</p>{['sender', 'receiver'].map(name => <label key={name}>{name === 'sender' ? 'Sending account' : 'Receiving account'}<select name={name} required defaultValue={name === 'sender' ? 'ACC-100003' : 'ACC-100001'}>{accounts.filter(a => a.status === 'Active').map(a => <option key={a.id} value={a.id}>{a.id} Â· {a.customer} Â· {a.currency}</option>)}</select></label>)}<label>Amount<input name="amount" inputMode="decimal" required placeholder="0.00"/></label>{error && <p role="alert" className="movement-out">{error}</p>}<button className="simulation-button" type="submit">Post synthetic transfer</button><button type="button" className="account-link" onClick={() => { setCreating(false); setError(''); }}>Cancel</button></form>}
    {backendConnected && error && <p role="alert">{error}</p>}
    <section className="accounts-panel"><div className="account-table-scroll"><table className="account-table"><thead><tr><th>Reference</th><th>{payments ? 'Amount' : 'Payment reference'}</th><th>Status</th><th>{payments ? 'Created at (SGT)' : 'Posted at (SGT)'}</th></tr></thead><tbody>{rows.map(row => <tr key={row.id}><td><button className="account-link" onClick={() => setParams({ [key]: row.id })}>{row.id}</button></td><td>{payments ? money(row.amountCents, row.currency) : state.payment_transactions.some(p => p.id === row.paymentId) ? <Link className="account-link" to={'/payments/transactions?transaction=' + row.paymentId}>{row.paymentId}</Link> : 'Payment unavailable'}</td><td>{row.status}</td><td>{row.postedAt || row.createdAt ? postingTime(row.postedAt || row.createdAt) : 'Not posted'}</td></tr>)}</tbody></table></div></section>
    <RecordDrawer open={!!id} title={selected?.id || 'Record unavailable'} onClose={close}>{!selected ? <p>This record is unavailable in the shared simulation dataset.</p> : payments ? <><dl className="account-facts">{[['Status', selected.status], ['Amount', money(selected.amountCents, selected.currency)], ['Sending account', selected.senderId], ['Receiving account', selected.receiverId], ['Created at (SGT)', postingTime(selected.createdAt)]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl><h3 className="drawer-section-title">Linked journals</h3>{state.ledger_journals.some(j => j.paymentId === selected.id) ? state.ledger_journals.filter(j => j.paymentId === selected.id).map(j => <p key={j.id}><Link className="account-link" to={'/core-banking/journals?journal=' + j.id}>{j.id}</Link> Â· {j.status}</p>) : <p>No ledger posting available. This payment does not affect account balances.</p>}</> : <><section className="account-balance" aria-label="Journal posting summary"><span>Ledger journal</span><strong>{selected.id}</strong><span className={'account-status ' + (selected.status === 'Posted' ? 'active' : 'frozen')}><i/>{selected.status}</span><small>{selected.currency} / {state.ledger_entries.filter(e => e.journalId === selected.id).length} accounting entries</small></section><p>{selected.postedAt ? postingTime(selected.postedAt) + ' SGT' : 'Not posted'}</p><p>{state.payment_transactions.some(p => p.id === selected.paymentId) ? <Link className="account-link" to={'/payments/transactions?transaction=' + selected.paymentId}>Open Payment Transaction</Link> : 'Payment unavailable'}</p><h3 className="drawer-section-title">Journal entries</h3><p className="history-caption">Deposit accounts: debit = money out; credit = money in</p>{state.ledger_entries.filter(e => e.journalId === selected.id).map(e => <article className="posted-entry" key={e.id}><p>{e.description}</p><div className="posted-entry-top"><span>{e.accountId}</span><strong>{e.side}: {money(e.amountCents, e.currency)}</strong></div></article>)}<dl className="account-facts">{['Debit', 'Credit'].map(side => <div key={side}><dt>Total {side.toLowerCase()}s</dt><dd>{money(state.ledger_entries.filter(e => e.journalId === selected.id && e.side === side).reduce((sum, e) => sum + e.amountCents, 0), selected.currency)}</dd></div>)}</dl><p>{validJournal(state, selected) ? 'Balanced Â· Included in account balances' : 'Excluded from account balances'}</p></>}</RecordDrawer>
  </>;
}
