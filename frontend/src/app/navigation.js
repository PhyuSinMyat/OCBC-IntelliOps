// Pure helpers for the sidebar navigation model.
//
// A nav item is either a flat tuple [path, label, Icon] or an expandable
// group { path, label, icon, children: [[path, label, Icon], ...] }.
// These helpers are intentionally free of React/DOM so they can run under
// `node --test` alongside the rest of the frontend unit suite.

export const isGroup = item =>
  item != null && typeof item === 'object' && !Array.isArray(item) && Array.isArray(item.children);

export const itemPath = item => (isGroup(item) ? item.path : item[0]);
export const itemLabel = item => (isGroup(item) ? item.label : item[1]);
export const itemIcon = item => (isGroup(item) ? item.icon : item[2]);
export const childrenOf = item => (isGroup(item) ? item.children : []);

const route = (portalId, path) => `/${portalId}/${path}`;

// Flatten a portal's sections + items (including group children) into [path, label] pairs.
export const flattenItems = sections =>
  sections.flatMap(section =>
    section.items.flatMap(item =>
      isGroup(item)
        ? [[item.path, item.label], ...item.children.map(([p, l]) => [p, l])]
        : [[item[0], item[1]]]
    )
  );

// All { portalId, path } route pairs for the whole app, including group parents and children.
export const flattenRoutes = portals =>
  portals.flatMap(p =>
    p.sections.flatMap(section =>
      section.items.flatMap(item =>
        isGroup(item)
          ? [{ portalId: p.id, path: item.path }, ...item.children.map(([cp]) => ({ portalId: p.id, path: cp }))]
          : [{ portalId: p.id, path: item[0] }]
      )
    )
  );

// Resolve the active page label for a portal at the given pathname.
export const findCurrent = (portal, pathname) =>
  flattenItems(portal.sections).find(([path]) => route(portal.id, path) === pathname)?.[1];

// A group is "active" when the browser is on the group's own route or any child route.
export const groupIsActive = (portal, group, pathname) => {
  if (route(portal.id, group.path) === pathname) return true;
  return group.children.some(([childPath]) => route(portal.id, childPath) === pathname);
};

export const childIsActive = (portal, childPath, pathname) =>
  route(portal.id, childPath) === pathname;

// Find an expandable group by portal id + path (single source of truth for page cross-links).
export const findGroup = (portals, portalId, path) =>
  portals
    .find(p => p.id === portalId)
    ?.sections.flatMap(s => s.items)
    .find(item => isGroup(item) && item.path === path);

// Build a query string that preserves case + investigation context across section switches.
// Accepts a URLSearchParams (or any { get(name) } source). Returns '' when no context is present.
export const contextSearch = params => {
  const out = [];
  const caseId = params?.get?.('case');
  const investigationId = params?.get?.('investigation');
  if (caseId) out.push(`case=${encodeURIComponent(caseId)}`);
  if (investigationId) out.push(`investigation=${encodeURIComponent(investigationId)}`);
  return out.length ? `?${out.join('&')}` : '';
};
