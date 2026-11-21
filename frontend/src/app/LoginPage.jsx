import React, { useState } from 'react';
import { ArrowRight, Bot, CheckCircle2, Eye, EyeOff, LockKeyhole, ShieldCheck, Sparkles, UserRoundCheck } from 'lucide-react';
import './login.css';

const profiles = {
  ANALYST: {
    name: 'Analyst', initials: 'AN', icon: Bot,
    description: 'Investigate exceptions, prepare resolutions, and monitor approval status.',
  },
  ADMIN: {
    name: 'Administrator', initials: 'AD', icon: UserRoundCheck,
    description: 'Review operational records and make controlled approval decisions.',
  },
};

export default function LoginPage({ onSignIn, initialError = '' }) {
  const [role, setRole] = useState('ANALYST');
  const [password, setPassword] = useState('');
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError);
  async function submit(event) {
    event.preventDefault();
    if (!password || busy) return;
    setBusy(true); setError('');
    try { await onSignIn({ role, password }); }
    catch (failure) { setError(failure.message); setPassword(''); }
    finally { setBusy(false); }
  }
  return <main className="login-shell">
    <section className="login-hero" aria-labelledby="login-product-title">
      <div className="login-brand"><span><Sparkles size={24}/></span><div><strong>OCBC IntelliOps</strong><small>AI-assisted banking operations</small></div></div>
      <div className="login-hero-copy"><p className="login-eyebrow"><Sparkles size={15}/>Controlled operations intelligence</p>
        <h1 id="login-product-title">Investigate exceptions.<br/>Resolve with confidence.</h1>
        <p>Connect verified payment and ledger evidence to a controlled human review workflow.</p>
        <div className="login-benefits">{[
          [Bot, 'Evidence-led analysis', 'Investigate using persisted source records'],
          [ShieldCheck, 'Role-based controls', 'Separate preparation from approval'],
          [CheckCircle2, 'Durable workflow', 'Track decisions and audit history'],
        ].map(([Icon, title, copy]) => <article key={title}><Icon size={21}/><strong>{title}</strong><small>{copy}</small></article>)}</div>
      </div>
      <p className="login-environment">Synthetic demonstration environment · No production banking data</p>
    </section>
    <section className="login-panel" aria-labelledby="login-title"><div className="login-form-wrap">
      <header><p className="login-eyebrow">Secure workspace</p><h2 id="login-title">Welcome back</h2><p>Select your staff role and enter its configured backend access password.</p></header>
      <div className="login-profiles" role="radiogroup" aria-label="Staff role">{Object.entries(profiles).map(([code, profile]) => {
        const Icon = profile.icon;
        return <button type="button" key={code} role="radio" aria-checked={role === code} className={role === code ? 'selected' : ''}
          onClick={() => { setRole(code); setPassword(''); setError(''); }}>
          <span className="login-profile-icon"><Icon size={18}/></span><span><strong>{profile.name}</strong><small>{profile.description}</small></span>
          <span className="login-radio" aria-hidden="true"/>
        </button>;
      })}</div>
      <form className="login-form" onSubmit={submit} noValidate>
        <label>Staff role<input value={profiles[role].name} readOnly aria-readonly="true"/></label>
        <label>Access password<span className="login-password"><LockKeyhole size={17}/><input type={visible ? 'text' : 'password'} value={password}
          onChange={event => setPassword(event.target.value)} required autoComplete="current-password" autoFocus placeholder={`Enter ${profiles[role].name.toLowerCase()} password`}/>
          <button type="button" aria-label={visible ? 'Hide password' : 'Show password'} onClick={() => setVisible(value => !value)}>{visible ? <EyeOff size={17}/> : <Eye size={17}/>}</button></span></label>
        {error && <p className="login-error" role="alert">{error}</p>}
        <button className="login-submit" type="submit" disabled={busy || !password}>{busy ? 'Signing in…' : <>Sign in as {profiles[role].name}<ArrowRight size={18}/></>}</button>
      </form>
      <p className="login-help">Access is validated by FastAPI. Choosing a role does not change backend permissions.</p>
    </div></section>
  </main>;
}
