import React, { useEffect, useRef, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Bell, ChevronRight, CircleDot, Menu, ShieldCheck, X } from 'lucide-react';
import { portals } from './portals.js';
import PortalPage from './PortalPage.jsx';
import { backendConnected, refreshBackend, useBankingRecords } from '../shared/data/bankingRecords.js';

export default function App() {
  const location = useLocation();
  const records = useBankingRecords();
  useEffect(() => {
    if (backendConnected) refreshBackend().catch(() => {});
  }, [location.pathname]);
  useEffect(() => {
    if (!backendConnected) return;
    const refresh = () => {
      if (document.visibilityState !== 'hidden') refreshBackend().catch(() => {});
    };
    const timer = setInterval(refresh, 10000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, []);
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
      {backendConnected && records.connectionError && <div className="payment-feedback" role="alert">Unable to refresh database records: {records.connectionError} Last retrieved records remain visible. <button className="account-link" onClick={() => refreshBackend().catch(() => {})}>Retry database connection</button></div>}
      <Routes><Route path="/" element={<Navigate to="/intelliops/overview" replace/>}/>{portals.flatMap(p => p.sections.flatMap(s => s.items.map(([path]) => <Route key={`${p.id}/${path}`} path={`/${p.id}/${path}`} element={<PortalPage portal={portal} title={title}/>}/>)))}<Route path="*" element={<Navigate to="/intelliops/overview" replace/>}/></Routes>
    </main>
  </div>;
}
