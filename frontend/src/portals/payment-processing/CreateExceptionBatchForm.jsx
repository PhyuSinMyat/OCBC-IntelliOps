import React, { useState } from 'react';
import RecordDrawer from '../../shared/components/RecordDrawer.jsx';
import { createExceptionBatch } from '../../shared/data/bankingRecords.js';

const types = [
  ['MISSING_LEDGER', 'Missing Ledger Posting', 'Completed payments without ledger journals.'],
  ['AMOUNT_MISMATCH', 'Amount Mismatch', 'Journals posted one cent below the payment amount.'],
  ['DUPLICATE', 'Duplicate Transaction', 'Original payments followed by blocked duplicates.'],
  ['PROCESSING_FAILURE', 'Payment Processing Failure', 'Processor failures with no financial posting.'],
];

export default function CreateExceptionBatchForm({ open, onClose, onCreated }) {
  const [selected, setSelected] = useState(types.map(([code]) => code));
  const [count, setCount] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const toggle = code => setSelected(current => current.includes(code)
    ? current.filter(value => value !== code) : [...current, code]);
  async function submit(event) {
    event.preventDefault();
    if (!selected.length) { setError('Select at least one exception type.'); return; }
    setBusy(true); setError('');
    try { onCreated(await createExceptionBatch(selected, Number(count))); }
    catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }
  const total = (selected.length + Number(selected.includes('DUPLICATE'))) * count;
  return <RecordDrawer open={open} title="Generate Exception Batch" onClose={() => !busy && onClose()}>
    <form className="payment-form exception-batch-form" onSubmit={submit}>
      <p className="history-caption">Choose only the exception types you need. Accounts, currencies, safe amounts, references and idempotency keys are generated automatically.</p>
      <fieldset><legend>Exception types</legend><div className="exception-batch-options">
        {types.map(([code, label, description]) => <label key={code}>
          <input type="checkbox" checked={selected.includes(code)} onChange={() => toggle(code)} disabled={busy}/>
          <span><strong>{label}</strong><small>{description}</small></span>
        </label>)}
      </div></fieldset>
      <label htmlFor="batch-count">Payments per selected type</label>
      <input id="batch-count" type="number" min="1" max="10" value={count} onChange={event => setCount(Math.max(1, Math.min(10, Number(event.target.value) || 1)))} disabled={busy}/>
      <p className="payment-feedback">This batch will create <strong>{total}</strong> exception payment{total === 1 ? '' : 's'} across {selected.length} selected type{selected.length === 1 ? '' : 's'}.</p>
      {error && <p className="movement-out" role="alert">{error}</p>}
      <div className="payment-form-actions"><button className="simulation-button" type="submit" disabled={busy || !selected.length}>{busy ? 'Generating batch…' : 'Generate Exception Batch'}</button><button className="account-link" type="button" disabled={busy} onClick={onClose}>Cancel</button></div>
    </form>
  </RecordDrawer>;
}
