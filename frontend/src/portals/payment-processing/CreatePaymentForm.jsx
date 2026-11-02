import React, { useRef, useState } from 'react';
import RecordDrawer from '../../shared/components/RecordDrawer.jsx';
import { accounts, backendConnected, createSyntheticPayment, useBankingRecords } from '../../shared/data/bankingRecords.js';
import { parseAmount, scenarios } from '../../shared/data/paymentSimulation.js';

export default function CreatePaymentForm({ open, onClose, onCreated, role }) {
  const records = useBankingRecords();
  const [values, setValues] = useState({ senderId: '', receiverId: '', amount: '', scenario: 'NORMAL' });
  const [search, setSearch] = useState({ senderId: '', receiverId: '' });
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const key = useRef(crypto.randomUUID());
  const sender = accounts.find(a => a.id === values.senderId), receiver = accounts.find(a => a.id === values.receiverId);
  const change = (name, value) => {
    setValues(previous => ({ ...previous, [name]: value }));
    setErrors({});
    key.current = crypto.randomUUID();
  };
  async function submit(event) {
    event.preventDefault();
    if (lock.current) return;
    const nextErrors = {};
    if (!sender) nextErrors.senderId = 'Choose a sending account.';
    if (!receiver) nextErrors.receiverId = 'Choose a receiving account.';
    if (sender && sender.status !== 'Active') nextErrors.senderId = 'Sender must be Active.';
    if (receiver && receiver.status !== 'Active') nextErrors.receiverId = 'Receiver must be Active.';
    if (sender && receiver && sender.id === receiver.id) nextErrors.receiverId = 'Sender and receiver must differ.';
    if (sender && receiver && sender.currency !== receiver.currency) nextErrors.receiverId = 'Choose an account in the same currency as the sender.';
    try { parseAmount(values.amount); } catch (error) { nextErrors.amount = error.message; }
    if (Object.keys(nextErrors).length) { setErrors(nextErrors); return; }
    lock.current = true;
    setBusy(true);
    try {
      const payment = await createSyntheticPayment({ ...values, scenario: role === 'ADMIN' ? values.scenario : 'NORMAL', idempotencyKey: key.current }, role);
      onCreated(payment);
    } catch (error) { setErrors({ [/funds|amount/i.test(error.message) ? 'amount' : /currency|receiver/i.test(error.message) ? 'receiverId' : 'submit']: error.message }); }
    finally { lock.current = false; setBusy(false); }
  }
  return <RecordDrawer open={open} title="Create Synthetic Payment" onClose={() => !busy && onClose()}><form className="payment-form" onSubmit={submit} noValidate>
    <p className="history-caption">{backendConnected ? 'Validated and posted atomically by the synthetic backend.' : 'Browser-only simulation. Records are saved locally, not to PostgreSQL.'}</p>
    {['senderId', 'receiverId'].map(name => <fieldset key={name} disabled={busy}><legend>{name === 'senderId' ? 'Sender Account' : 'Receiver Account'}</legend>
      <label className="filter-label" htmlFor={`${name}-search`}>Find account</label><input id={`${name}-search`} aria-label={name === 'senderId' ? 'Search sender accounts' : 'Search receiver accounts'} placeholder="Account reference or customer name" value={search[name]} onChange={e => setSearch(previous => ({ ...previous, [name]: e.target.value }))}/>
      <label className="filter-label" htmlFor={name}>{name === 'senderId' ? 'Sender account' : 'Receiver account'}</label><select id={name} value={values[name]} onChange={e => change(name, e.target.value)} aria-invalid={!!errors[name]} aria-describedby={errors[name] ? `${name}-error` : undefined}>
        <option value="">Select account</option>{accounts.filter(a => a.id === values[name] || `${a.reference} ${a.customer}`.toLowerCase().includes(search[name].toLowerCase())).map(a => <option key={a.id} value={a.id}>{a.reference} · {a.customer} · {a.type} · {a.currency} · {a.status}</option>)}
      </select>{errors[name] && <p id={`${name}-error`} role="alert" className="movement-out">{errors[name]}</p>}
    </fieldset>)}
    <label htmlFor="payment-amount">Amount</label><input id="payment-amount" inputMode="decimal" placeholder="0.00" value={values.amount} onChange={e => change('amount', e.target.value)} disabled={busy} aria-invalid={!!errors.amount} aria-describedby={errors.amount ? 'amount-error' : undefined}/>{errors.amount && <p id="amount-error" role="alert" className="movement-out">{errors.amount}</p>}
    <p className="payment-currency">Currency: <strong>{sender && receiver && sender.currency === receiver.currency ? sender.currency : 'Select compatible accounts'}</strong></p>
    <details className="payment-advanced"><summary>Advanced Simulation Options</summary>{role === 'ADMIN' ? <label>Simulation Scenario<select value={values.scenario} onChange={e => change('scenario', e.target.value)} disabled={busy}>{Object.entries(scenarios).map(([code, label]) => <option value={code} key={code}>{label}</option>)}</select></label> : <p>Exception injection is restricted to the ADMIN {backendConnected ? 'role' : 'local demo role'}.</p>}<p className="history-caption">Scenarios generate source evidence. Run detection separately. Reconciliation uses a {records.reconciliationSeconds || 60}-second cutoff.</p></details>
    {errors.submit && <p role="alert" className="movement-out">{errors.submit}</p>}
    <div className="payment-form-actions"><button className="simulation-button" disabled={busy} type="submit">{busy ? 'Submitting payment…' : 'Submit Synthetic Payment'}</button><button type="button" className="account-link" disabled={busy} onClick={onClose}>Cancel</button></div>
  </form></RecordDrawer>;
}
