export const defaultFilters = { query: '', customerType: '', accountType: '', currency: '', status: '', sort: 'reference' };
export const typeLabel = value => value === 'INDIVIDUAL' ? 'Individual' : value === 'BUSINESS' ? 'Business' : value === 'SAVINGS' ? 'Savings' : value === 'CURRENT' ? 'Current' : value;

export function selectAccounts(accounts, balances, filters) {
  const query = filters.query.trim().toLocaleLowerCase();
  const rows = accounts.filter(a => `${a.reference} ${a.customer} ${a.customerRef}`.toLocaleLowerCase().includes(query) &&
    ['customerType', 'accountType', 'currency', 'status'].every(key => !filters[key] || a[key] === filters[key]));
  const compare = {
    reference: (a, b) => a.reference.localeCompare(b.reference),
    'customer-asc': (a, b) => a.customer.localeCompare(b.customer),
    'customer-desc': (a, b) => b.customer.localeCompare(a.customer),
    'balance-asc': (a, b) => balances[a.id].current - balances[b.id].current,
    'balance-desc': (a, b) => balances[b.id].current - balances[a.id].current,
    'created-asc': (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
    'created-desc': (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
  }[filters.sort] || ((a, b) => a.reference.localeCompare(b.reference));
  return rows.sort((a, b) => compare(a, b) || a.id.localeCompare(b.id));
}
