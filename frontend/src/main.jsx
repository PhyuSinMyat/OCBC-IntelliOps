import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { ArrowLeftRight, Bell, Bot, Building2, ChartNoAxesCombined, ChevronRight, CircleDot, FileClock, FileText, LayoutDashboard, Menu, Settings, ShieldCheck, TriangleAlert, UserCheck, Workflow, X } from 'lucide-react';
import './styles.css';
import Accounts from './Accounts';
import BankingRecords from './BankingRecords.jsx';

const portals = [
  { id: 'intelliops', label: 'IntelliOps', description: 'Operations intelligence', icon: Bot, home: '/intelliops/overview', sections: [
    { label: 'Workspace', items: [['overview', 'Overview', LayoutDashboard], ['exceptions', 'Exception Center', TriangleAlert], ['investigation', 'AI Investigation', Bot], ['workflows', 'Resolution Workflows', Workflow], ['approvals', 'Approval Center', UserCheck], ['audit', 'Audit Trail', FileClock]] },
    { label: 'Management', items: [['analytics', 'Analytics', ChartNoAxesCombined], ['settings', 'Settings', Settings]] },
  ] },
  { id: 'payments', label: 'Payment Processing', description: 'Transaction operations', icon: ArrowLeftRight, home: '/payments/transactions', sections: [{ label: 'Workspace', items: [['transactions', 'Transactions', ArrowLeftRight]] }] },
  { id: 'core-banking', label: 'Core Banking / Ledger', description: 'Accounting records', icon: Building2, home: '/core-banking/accounts', sections: [{ label: 'Workspace', items: [['accounts', 'Accounts', Building2], ['journals', 'Ledger Journals', FileText]] }] },
];

function App() {
  const location = useLocation();
  const portal = portals.find(p => location.pathname.startsWith(`/${p.id}/`)) || portals[0];
  const [menuOpen, setMenuOpen] = useState(false);
  const [popover, setPopover] = useState(null);
  const headerRef = useRef(null);
  const menuRef = useRef(null);
  const menuButtonRef = useRef(null);
  const lastPages = useRef({});
  useEffect(() => {
    lastPages.current[portal.id] = location.pathname;
    document.title = `${title} · OCBC IntelliOps`;
    setMenuOpen(false);
    setPopover(null);
  }, [location.pathname]);
  useEffect(() => {
    if (menuOpen) menuRef.current?.querySelector('a')?.focus();
    const dismiss = event => {
      if (event.key === 'Escape') {
        setPopover(null);
        if (menuOpen) { setMenuOpen(false); menuButtonRef.current?.focus(); }
      }
      if (event.type === 'pointerdown' && !headerRef.current?.contains(event.target)) setPopover(null);
      if (event.key === 'Tab' && menuOpen && window.matchMedia('(max-width: 800px)').matches) {
        const controls = [menuButtonRef.current, ...menuRef.current.querySelectorAll('a')];
        const index = controls.indexOf(document.activeElement);
        const next = (index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length;
        event.preventDefault();
        controls[next]?.focus();
      }
    };
    document.addEventListener('keydown', dismiss);
    document.addEventListener('pointerdown', dismiss);
    return () => { document.removeEventListener('keydown', dismiss); document.removeEventListener('pointerdown', dismiss); };
  }, [menuOpen]);
  const PortalIcon = portal.icon;
  const current = portal.sections.flatMap(s => s.items).find(([path]) => location.pathname === `/${portal.id}/${path}`);
  const title = current?.[1] || 'Overview';
  return <div className="app-shell">
    <a className="skip-link" href="#main-content">Skip to workspace</a>
    <header className="global-header" ref={headerRef}>
      <div className="brand-area">
        <button ref={menuButtonRef} className="icon-button mobile-menu" aria-controls="workspace-navigation" aria-label={menuOpen ? 'Close navigation' : 'Open navigation'} aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}>{menuOpen ? <X size={21}/> : <Menu size={21}/>}</button>
        <NavLink className="brand" to="/intelliops/overview" onClick={() => setMenuOpen(false)}><span className="brand-mark" aria-hidden="true"><span/></span><span><strong>OCBC Operations Platform</strong><small>Demo Environment</small></span></NavLink>
      </div>
      <nav className="portal-switcher" aria-label="Portals">{portals.map(p => <NavLink key={p.id} to={lastPages.current[p.id] || p.home} className={`portal-tab ${portal.id === p.id ? 'selected' : ''}`} aria-current={portal.id === p.id ? 'page' : undefined} onClick={() => { setMenuOpen(false); setPopover(null); }}><p.icon size={15}/><span>{p.label}</span></NavLink>)}</nav>
      <div className="header-actions">
        <span className="demo-badge"><CircleDot size={12}/> Demo · Synthetic Data</span>
        <div className="popover-anchor"><button className="icon-button" aria-label="Notifications" aria-expanded={popover === 'notifications'} onClick={() => setPopover(popover === 'notifications' ? null : 'notifications')}><Bell size={21}/></button>{popover === 'notifications' && <div className="popover"><strong>Notifications</strong><p>No notifications yet.</p><small>Case updates will appear here once connected.</small></div>}</div>
        <div className="popover-anchor"><button className="avatar" aria-label="Demo user account" aria-expanded={popover === 'account'} onClick={() => setPopover(popover === 'account' ? null : 'account')}>SL</button>{popover === 'account' && <div className="popover"><strong>Demo user</strong><p>Frontend preview</p><small>Account authentication is not connected.</small></div>}</div>
      </div>
    </header>
    {menuOpen && <button className="sidebar-backdrop" aria-label="Close navigation" onClick={() => setMenuOpen(false)}/>}
    <aside id="workspace-navigation" ref={menuRef} className={`sidebar ${menuOpen ? 'is-open' : ''}`} aria-label={`${portal.label} navigation`}>
      <div className="portal-identity"><span className="portal-icon"><PortalIcon size={21}/></span><div><strong>{portal.label}</strong><small>{portal.description}</small></div></div>
      <div className="environment-label"><CircleDot size={14}/><span>{portal.id === 'intelliops' ? 'Intelligent operations' : 'Synthetic banking simulation'}</span></div>
      <nav className="sidebar-nav" aria-label="Workspace">{portal.sections.map(section => <div className="nav-section" key={section.label}><p className="section-label">{section.label}</p>{section.items.map(([path, label, Icon]) => <NavLink key={path} to={`/${portal.id}/${path}`} className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`} onClick={() => { setMenuOpen(false); setPopover(null); }}><Icon size={20}/><span>{label}</span></NavLink>)}</div>)}</nav>
      <div className="simulation-status"><strong><span className="status-dot"/>Local simulation active</strong><small>No connection to banking services</small></div>
    </aside>
    <main id="main-content" tabIndex={-1} className="main-content" inert={menuOpen ? true : undefined} onClick={() => popover && setPopover(null)}>
      <div className="workspace-topline"><div className="workspace-context"><span>Workspace</span><ChevronRight size={14}/><span>{portal.label}</span><ChevronRight size={14}/><strong>{title}</strong></div><span className="workspace-mode"><ShieldCheck size={13}/>Demo environment</span></div>
      <Routes><Route path="/" element={<Navigate to="/intelliops/overview" replace/>}/>{portals.flatMap(p => p.sections.flatMap(s => s.items.map(([path]) => <Route key={`${p.id}/${path}`} path={`/${p.id}/${path}`} element={<Page portal={portal} title={title}/>}/>)))}<Route path="*" element={<Navigate to="/intelliops/overview" replace/>}/></Routes>
    </main>
  </div>;
}

function Page({ portal, title }) {
  const { pathname } = useLocation();
  if (pathname === '/core-banking/accounts') return <Accounts/>;
  if (pathname === '/core-banking/journals') return <BankingRecords key="journals"/>;
  if (pathname === '/payments/transactions') return <BankingRecords key="payments" payments/>;
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

createRoot(document.getElementById('root')).render(<React.StrictMode><BrowserRouter><App/></BrowserRouter></React.StrictMode>);
