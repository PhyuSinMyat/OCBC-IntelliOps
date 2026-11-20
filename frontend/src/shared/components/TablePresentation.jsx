import React from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';

const statusTones = {
  completed: 'success', posted: 'success', verified: 'success', resolved: 'success', active: 'success', low: 'success',
  pending: 'warning', held: 'warning', high: 'warning', frozen: 'warning',
  failed: 'danger', rejected: 'danger', critical: 'danger',
  open: 'info', processing: 'info', in_progress: 'info', medium: 'info',
};

export function TableBadge({ value }) {
  const tone = statusTones[String(value).toLowerCase()] || 'neutral';
  return <span className={`table-badge table-badge--${tone}`}>{value?.replaceAll('_', ' ') || 'Unavailable'}</span>;
}

export function ReferenceText({ value, compact = false }) {
  const prefix = compact ? 9 : 12;
  const suffix = compact ? 5 : 8;
  if (value.length <= (compact ? 18 : 24)) return value;
  const display = value.slice(0, prefix) + '\u2026' + value.slice(-suffix);
  return <span title={value}><span aria-hidden="true">{display}</span><span className="sr-only">{value}</span></span>;
}

export function TableHeading({ children, direction, className }) {
  const Icon = direction === 'descending' ? ArrowDown : ArrowUp;
  return <th scope="col" className={className} aria-sort={direction}>{children}
    {direction && <Icon className="table-sort-marker" size={14} aria-hidden="true"/>}
  </th>;
}
