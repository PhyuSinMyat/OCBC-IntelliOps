import React, { useEffect, useRef, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Bell, ChevronRight, CircleDot, LogOut, Menu, ShieldCheck, X } from 'lucide-react';
import { portals } from './portals.js';
import { contextSearch, findCurrent, flattenRoutes, groupIsActive, isGroup } from './navigation.js';
import PortalPage from './PortalPage.jsx';
import ocbcLogo from './ocbc-logo.svg';
import { backendConnected, refreshBackend, useBankingRecords } from '../shared/data/bankingRecords.js';

export default function App() {
  const location = useLocation();
  const records = useBankingRecords();
  const adminOnly = records.role === 'ADMIN';
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
  const visiblePortals = adminOnly ? [portals[0]] : portals;
  const portal = visiblePortals.find(p => location.pathname.startsWith(`/${p.id}/`)) || visiblePortals[0];
  const visibleSections = adminOnly
    ? portal.sections.map(section => ({ ...section, hidden: false, items: section.items.filter(item => Array.isArray(item) && item[0] === 'approvals') })).filter(section => section.items.length)
    : portal.sections;
  const visibleRoutes = adminOnly ? [{ portalId: 'intelliops', path: 'approvals' }] : flattenRoutes(portals);
  const [menuOpen, setMenuOpen] = useState(false);
  const [popover, setPopover] = useState(null);
  const headerRef = useRef(null);
  const menuRef = useRef(null);
  const menuButtonRef = useRef(null);
  const lastPages = useRef({});
  const [openGroups, setOpenGroups] = useState(() => new Set());
  const groupToggleRef = useRef(null);
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
        const controls = [menuButtonRef.current, ...menuRef.current.querySelectorAll('a, button')]
          .filter(control => control && !control.closest('[inert]'));
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
  const toggleGroup = (group, controlsId) => {
    // An active group (its own route or a child route) stays expanded.
    if (groupIsActive(portal, group, location.pathname)) return;
    // If focus is inside the submenu we are collapsing, move it back to the toggle.
    const submenu = document.getElementById(controlsId);
    if (openGroups.has(group.path) && submenu?.contains(document.activeElement)) groupToggleRef.current?.focus();
    setOpenGroups(prev => {
      const next = new Set(prev);
      if (next.has(group.path)) next.delete(group.path);
      else next.add(group.path);
      return next;
    });
  };
  const PortalIcon = portal.icon;
  const current = findCurrent(portal, location.pathname);
  const title = current || 'Overview';
  const roleName = records.role === 'ADMIN' ? 'Administrator' : 'Analyst';
  const signOut = () => {
    sessionStorage.removeItem('intelliops-api-token');
    window.location.assign('/');
  };
  return <div className="app-shell">
    <a className="skip-link" href="#main-content">Skip to workspace</a>
    <header className="global-header" ref={headerRef}>
      <div className="brand-area">
        <button ref={menuButtonRef} className="icon-button mobile-menu" aria-controls="workspace-navigation" aria-label={menuOpen ? 'Close navigation' : 'Open navigation'} aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}>{menuOpen ? <X size={21}/> : <Menu size={21}/>}</button>
        <NavLink className="brand" to="/intelliops/overview" onClick={() => setMenuOpen(false)}><img className="brand-logo" src={ocbcLogo} alt="OCBC overview" width="126" height="36" /></NavLink>
      </div>
      <nav className="portal-switcher" aria-label="Portals">{visiblePortals.map(p => <NavLink key={p.id} to={adminOnly ? '/intelliops/approvals' : lastPages.current[p.id] || p.home} className={`portal-tab ${portal.id === p.id ? 'selected' : ''}`} aria-current={portal.id === p.id ? 'page' : undefined} onClick={() => { setMenuOpen(false); setPopover(null); }}><p.icon size={15}/><span>{p.label}</span></NavLink>)}</nav>
      <div className="header-actions">
        <span className="demo-badge"><CircleDot size={12}/> Demo · Synthetic Data</span>
        <div className="popover-anchor"><button className="icon-button" aria-label="Notifications" aria-expanded={popover === 'notifications'} onClick={() => setPopover(popover === 'notifications' ? null : 'notifications')}><Bell size={21}/></button>{popover === 'notifications' && <div className="popover"><strong>Notifications</strong><p>No notifications yet.</p><small>Case updates will appear here once connected.</small></div>}</div>
        <div className="popover-anchor"><button className="avatar" aria-label={`${roleName} account`} aria-expanded={popover === 'account'} onClick={() => setPopover(popover === 'account' ? null : 'account')}>{records.role === 'ADMIN' ? 'AD' : 'AN'}</button>{popover === 'account' && <div className="popover account-popover"><strong>{roleName}</strong><p>Authenticated backend role</p><small>{records.role === 'ADMIN' ? 'Approval decisions enabled.' : 'Approval records are read-only.'}</small><button className="account-signout" type="button" onClick={signOut}><LogOut size={15}/>Sign out</button></div>}</div>
      </div>
    </header>
    {menuOpen && <button className="sidebar-backdrop" aria-label="Close navigation" onClick={() => setMenuOpen(false)}/>}
    <aside id="workspace-navigation" ref={menuRef} className={`sidebar ${menuOpen ? 'is-open' : ''}`} aria-label={`${portal.label} navigation`}>
      <div className="portal-identity"><span className="portal-icon"><PortalIcon size={21}/></span><div><strong>{portal.label}</strong><small>{portal.description}</small></div></div>
      <div className="environment-label"><CircleDot size={14}/><span>{portal.id === 'intelliops' ? 'Intelligent operations' : 'Synthetic banking simulation'}</span></div>
      <nav className="sidebar-nav" aria-label="Workspace">{visibleSections.filter(section => !section.hidden).map(section => <div className="nav-section" key={section.label}><p className="section-label">{section.label}</p>{section.items.map(item => {
        if (isGroup(item)) {
          const GroupIcon = item.icon;
          const controlsId = `nav-group-${item.path}`;
          const active = groupIsActive(portal, item, location.pathname);
          const open = openGroups.has(item.path) || active;
          return <div className="nav-group" key={item.path}>
            <button type="button" ref={groupToggleRef} className={`sidebar-link nav-group-toggle${active ? ' is-parent-active' : ''}`} aria-expanded={open} aria-controls={controlsId} onClick={() => toggleGroup(item, controlsId)}>
              <GroupIcon className="nav-group-icon" size={20} aria-hidden="true" />
              <span>{item.label}</span>
              <ChevronRight className="nav-chevron" size={16} aria-hidden="true" />
            </button>
            <div id={controlsId} className={`nav-submenu${open ? ' is-open' : ''}`} role="group" aria-label={`${item.label} sections`} inert={open ? undefined : true}>
              <div className="nav-submenu-inner">
                <ul className="nav-submenu-list">
                  {item.children.map(([childPath, childLabel, ChildIcon]) => <li key={childPath}><NavLink to={{ pathname: `/${portal.id}/${childPath}`, search: active ? contextSearch(new URLSearchParams(location.search)) : '' }} className={({ isActive }) => `sidebar-link nav-submenu-link${isActive ? ' active' : ''}`} onClick={() => { setMenuOpen(false); setPopover(null); }}><ChildIcon size={16} aria-hidden="true" /><span>{childLabel}</span></NavLink></li>)}
                </ul>
              </div>
            </div>
          </div>;
        }
        const [path, label, Icon] = item;
        return <NavLink key={path} to={`/${portal.id}/${path}`} className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`} onClick={() => { setMenuOpen(false); setPopover(null); }}><Icon size={20}/><span>{label}</span></NavLink>;
      })}</div>)}</nav>
      <div className="simulation-status"><strong><span className="status-dot"/>Demo Environment · Synthetic Banking Data</strong></div>
    </aside>
    <main id="main-content" tabIndex={-1} className="main-content" inert={menuOpen ? true : undefined} onClick={() => popover && setPopover(null)}>
      <div className="workspace-topline"><div className="workspace-context"><span>Workspace</span><ChevronRight size={14}/><span>{portal.label}</span><ChevronRight size={14}/><strong>{title}</strong></div><span className="workspace-mode"><ShieldCheck size={13}/>Demo environment</span></div>
      {backendConnected && records.connectionError && <div className="payment-feedback" role="alert">Unable to refresh database records: {records.connectionError} Last retrieved records remain visible. <button className="account-link" onClick={() => refreshBackend().catch(() => {})}>Retry database connection</button></div>}
      <Routes><Route path="/" element={<Navigate to={adminOnly ? "/intelliops/approvals" : "/intelliops/overview"} replace/>}/>{visibleRoutes.map(({ portalId, path }) => <Route key={`${portalId}/${path}`} path={`/${portalId}/${path}`} element={<PortalPage portal={portal} title={title}/>}/>)}<Route path="*" element={<Navigate to={adminOnly ? "/intelliops/approvals" : "/intelliops/overview"} replace/>}/></Routes>
    </main>
  </div>;
}
