import { bankingApiUrl } from './config.js';

async function send(url, options) {
  try { return await fetch(url, options); }
  catch {
    throw new Error('Cannot reach FastAPI. Check that the backend is running, the configured API URL and CORS access. Connected mode has not switched to browser-only records.');
  }
}

async function responseData(response) {
  try { return await response.json(); } catch { return null; }
}

function apiError(response, data, fallback) {
  const message = typeof data?.detail === 'string' ? data.detail
    : Array.isArray(data?.detail) ? data.detail.map(e => `${e.loc.at(-1)}: ${e.msg}`).join('; ')
    : `${fallback} (HTTP ${response.status}). Check FastAPI and the database connection.`;
  const error = new Error(message);
  error.status = response.status;
  error.code = data?.code;
  return error;
}

export async function fetchBankingSnapshot(baseUrl) {
  const response = await send(`${baseUrl.replace(/\/$/, '')}/api/banking-snapshot`, { headers: authHeaders(), cache: 'no-store' });
  const data = await responseData(response);
  if (!response.ok) {
    throw apiError(response, data, 'Banking records unavailable');
  }
  for (const key of ['customers', 'accounts', 'payment_transactions', 'ledger_journals', 'ledger_entries']) {
    if (!Array.isArray(data?.[key])) throw new Error('Banking API returned an invalid snapshot.');
  }
  return data;
}

export function authHeaders() {
  const token = globalThis.sessionStorage?.getItem('intelliops-api-token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}
export async function paymentRequest(path, body) {
  if (!bankingApiUrl) throw new Error('The backend API URL is not configured.');
  const response = await send(`${bankingApiUrl}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(body),
  });
  const data = await responseData(response);
  if (!response.ok) throw apiError(response, data, 'Payment request failed');
  return data;
}

export async function exceptionRequest(path, { method = 'GET', body } = {}) {
  if (!bankingApiUrl) throw new Error('The backend API URL is not configured.');
  const response = await send(`${bankingApiUrl}${path}`, {
    method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...authHeaders() },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await responseData(response);
  if (!response.ok) throw apiError(response, data, 'Exception operation failed');
  return data;
}
