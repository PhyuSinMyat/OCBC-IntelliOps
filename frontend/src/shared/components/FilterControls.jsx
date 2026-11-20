import React from 'react';
import { ChevronDown, RotateCcw, Search } from 'lucide-react';

export function FilterSearch({ className = '', ...inputProps }) {
  return <label className={`filter-search ${className}`}>
    <Search size={17} aria-hidden="true"/>
    <input type="search" {...inputProps}/>
  </label>;
}

export function FilterSelect({ active, children, ...props }) {
  return <span className="filter-select-wrap">
    <select className="filter-select" data-active={active || undefined} {...props}>
      <button type="button" className="filter-select-display"><selectedcontent/></button>
      {children}
    </select>
    <ChevronDown className="filter-select-chevron" size={16} strokeWidth={1.8} aria-hidden="true"/>
  </span>;
}

export function FilterReset({ children, ...props }) {
  return <button type="button" className="filter-reset" {...props}>
    <RotateCcw size={15} aria-hidden="true"/>{children}
  </button>;
}
