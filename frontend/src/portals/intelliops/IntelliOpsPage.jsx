import React from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { ArrowLeftRight, Building2, ChevronRight, ShieldCheck, TriangleAlert } from 'lucide-react';

export default function IntelliOpsPage({ portal, title }) {
  const { pathname } = useLocation();
  const Icon = portal.icon;
  const descriptions = {
    Overview: 'A clear view of your operations, from the first signal to a verified outcome.',
    'Exception Center': 'Find the cases that need your attention and examine the evidence behind each one.',
    'AI Investigation': 'Bring source evidence together to understand what happened and decide what comes next.',
    'Resolution Workflows': 'Follow each corrective action through policy checks, execution and verification.',
    'Approval Center': 'Review proposed actions and record a clear decision before execution.',
    'Audit Trail': 'Trace the decisions, actors and outcomes behind every case.',
    Analytics: 'Understand operational workload, resolution time and verified outcomes.',
    Settings: 'Manage the rules and controls that guide your operations workspace.',
    Transactions: 'Inspect synthetic transfers and follow their processing history.',
    Accounts: 'Explore fictional accounts and their journal-backed balances.',
    'Ledger Journals': 'Inspect accounting entries and compare them with related payments.',
  };
  return <><div className="page-heading"><p className="eyebrow">{portal.id === 'intelliops' ? 'Operations command center' : portal.id === 'payments' ? 'Transaction operations' : 'Accounting records'}</p><h1>{title}</h1><p>{portal.id === 'intelliops' ? 'Monitor, investigate and resolve operational exceptions end to end.' : portal.id === 'payments' ? 'Explore synthetic payments and their processing history.' : 'Explore fictional accounts and ledger journals.'}</p></div>
    <section className="welcome-panel"><div className="panel-icon"><Icon size={27}/></div><span className="preview-label">YOUR OPERATIONS WORKSPACE</span><h2>{title === 'Overview' ? 'Every exception. A clear next step.' : title}</h2><p>{descriptions[title]}</p><div className="panel-note"><ShieldCheck size={16}/><span>Interface preview · Operational data is not connected yet</span></div></section>
    <section className="workspace-shortcuts" aria-label="Explore workspace"><div className="section-heading"><div><h2>{title === 'Overview' ? 'Start with what matters' : 'Continue your work'}</h2><p>Move between source records, investigation and oversight.</p></div><span>QUICK ACCESS</span></div><div className="shortcut-grid">{[
      { to: '/intelliops/exceptions', icon: TriangleAlert, label: 'Review exceptions', text: 'Find issues and inspect their supporting evidence.', tone: 'red' },
      { to: '/payments/transactions', icon: ArrowLeftRight, label: 'Explore payments', text: 'Follow a transfer through its processing history.', tone: 'blue' },
      { to: '/core-banking/journals', icon: Building2, label: 'Inspect the ledger', text: 'Compare payment records with accounting entries.', tone: 'green' },
    ].filter(item => item.to !== pathname).map(item => <NavLink className="shortcut-card" to={item.to} key={item.to}><span className={`shortcut-icon ${item.tone}`}><item.icon size={21}/></span><h3>{item.label}</h3><p>{item.text}</p><span className="shortcut-action">Open workspace <ChevronRight size={15}/></span></NavLink>)}</div></section>
    <div className="workspace-footer"><span><ShieldCheck size={14}/> Synthetic data. Controlled actions. Verified outcomes.</span><span>IntelliOps · Student concept prototype</span></div>
  </>;
}
