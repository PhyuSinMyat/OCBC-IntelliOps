import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './app/App.jsx';
import LoginPage from './app/LoginPage.jsx';
import './styles.css';
import { fetchBankingSnapshot } from './shared/api/banking.js';
import { loadBackendSnapshot } from './shared/data/bankingRecords.js';
import { bankingApiUrl } from './shared/api/config.js';

const root = createRoot(document.getElementById('root'));
function renderApp() {
  root.render(<React.StrictMode><BrowserRouter><App/></BrowserRouter></React.StrictMode>);
}

function renderLogin(initialError = '') {
  root.render(<React.StrictMode><LoginPage initialError={initialError} onSignIn={async ({ role, password }) => {
    sessionStorage.setItem('intelliops-api-token', password);
    try {
      const snapshot = await fetchBankingSnapshot(bankingApiUrl);
      if (snapshot.role !== role) throw new Error(`This password belongs to the ${snapshot.role === 'ADMIN' ? 'Administrator' : 'Analyst'} role. Select the matching staff profile.`);
      loadBackendSnapshot(snapshot);
      renderApp();
    } catch (error) {
      sessionStorage.removeItem('intelliops-api-token');
      throw error;
    }
  }}/></React.StrictMode>);
}

async function start() {
  const baseUrl = bankingApiUrl;
  if (baseUrl) {
    if (!sessionStorage.getItem('intelliops-api-token')) { renderLogin(); return; }
    root.render(<p role="status">Loading banking records…</p>);
    try { loadBackendSnapshot(await fetchBankingSnapshot(baseUrl)); }
    catch (error) {
      if (error.status === 401) {
        sessionStorage.removeItem('intelliops-api-token');
        renderLogin('Your session is invalid or expired. Sign in again.');
      } else root.render(<main className="account-empty"><h1>Banking records unavailable</h1><p role="alert">{error.message}</p><button className="simulation-button" onClick={() => start()}>Retry connection</button></main>);
      return;
    }
  }
  renderApp();
}
start();
