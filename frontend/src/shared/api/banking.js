export async function fetchBankingSnapshot(baseUrl) {
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/banking-snapshot`, { headers: authHeaders() });
  if (!response.ok) {
    const error = new Error(`Banking API returned ${response.status}. Check your demo token, database migrations and seed data.`);
    error.status = response.status;
    throw error;
  }
  const data = await response.json();
  for (const key of ['customers', 'accounts', 'payment_transactions', 'ledger_journals', 'ledger_entries']) {
    if (!Array.isArray(data[key])) throw new Error('Banking API returned an invalid snapshot.');
  }
  if (!data.accounts.length) throw new Error('No backend accounts found. Run the explicit Core Banking seed.');
  return data;
}

export function authHeaders() {
  const token = globalThis.sessionStorage?.getItem('intelliops-api-token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}
export async function paymentRequest(path, body) {
  const base = import.meta.env.VITE_BANKING_API_URL;
  const response = await fetch(`${base.replace(/\/$/, '')}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : data.detail?.map(e => `${e.loc.at(-1)}: ${e.msg}`).join('; ') || 'Payment request failed.');
  return data;
}
