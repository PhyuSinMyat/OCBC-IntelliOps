export function tableMoney(cents, currency) {
  if (cents === null) return 'Unavailable';
  const value = typeof cents === 'bigint' ? cents : Number.isSafeInteger(cents) ? BigInt(cents) : null;
  if (value === null) return 'Unavailable';
  const amount = value < 0n ? -value : value;
  return `${currency} ${value < 0n ? '-' : ''}${(amount / 100n).toLocaleString('en-SG')}.${String(amount % 100n).padStart(2, '0')}`;
}
