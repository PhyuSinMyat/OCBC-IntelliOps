import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './app/App.jsx';
import './styles.css';
import { fetchBankingSnapshot } from './shared/api/banking.js';
import { loadBackendSnapshot } from './shared/data/bankingRecords.js';
import { bankingApiUrl } from './shared/api/config.js';

const root = createRoot(document.getElementById('root'));
async function start() {
  const baseUrl = bankingApiUrl;
  if (baseUrl) {
    root.render(<p role="status">Loading banking records…</p>);
    try { loadBackendSnapshot(await fetchBankingSnapshot(baseUrl)); }
    catch (error) {
      root.render(<main className="account-empty"><h1>Banking records unavailable</h1><p role="alert">{error.message}</p>{error.status === 401 && <form className="transfer-form" onSubmit={e => { e.preventDefault(); sessionStorage.setItem('intelliops-api-token', new FormData(e.currentTarget).get('token')); start(); }}><label>Synthetic demo access token<input type="password" name="token" required autoComplete="off"/></label><button className="simulation-button" type="submit">Connect to Demo Backend</button></form>}<button className="simulation-button" onClick={() => start()}>Retry connection</button></main>);
      return;
    }
  }
  root.render(<React.StrictMode><BrowserRouter><App/></BrowserRouter></React.StrictMode>);
}
start();
