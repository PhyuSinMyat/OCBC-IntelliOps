import test from 'node:test';
import assert from 'node:assert/strict';
import { portals } from './portals.js';
import { isGroup, itemPath, itemLabel, flattenItems, flattenRoutes, findCurrent, groupIsActive, childIsActive, findGroup, contextSearch } from './navigation.js';

const intelliOps = portals.find(p => p.id === 'intelliops');
const workflows = findGroup(portals, 'intelliops', 'workflows');

test('Resolution Workspace is an expandable group with three ordered children', () => {
  assert.ok(workflows, 'workflows group exists in the IntelliOps nav config');
  assert.equal(workflows.label, 'Resolution Workspace');
  assert.equal(isGroup(workflows), true);
  assert.deepEqual(
    workflows.children.map(([path, label]) => [path, label]),
    [
      ['workflows/plans', 'Resolution Plans'],
      ['workflows/communication', 'Customer Communication'],
      ['workflows/policy', 'Policy Assessment'],
    ]
  );
});

test('flat tuples are not groups and itemPath/itemLabel read them correctly', () => {
  assert.equal(isGroup(['overview', 'Overview', null]), false);
  assert.equal(itemPath(['exceptions', 'Exception Center', null]), 'exceptions');
  assert.equal(itemLabel(['exceptions', 'Exception Center', null]), 'Exception Center');
});

test('existing primary items are preserved alongside the new children', () => {
  const labels = flattenItems(intelliOps.sections).map(([, l]) => l);
  for (const expected of ['Overview', 'Exception Center', 'AI Investigation', 'Resolution Workspace', 'Approval Center', 'Audit Trail', 'Resolution Plans', 'Customer Communication', 'Policy Assessment']) {
    assert.ok(labels.includes(expected), `expected label ${expected} to remain in the nav`);
  }
});

test('flattenRoutes registers the group parent, children and every existing route', () => {
  const routes = flattenRoutes(portals).map(({ portalId, path }) => `/${portalId}/${path}`);
  for (const expected of [
    '/intelliops/workflows', '/intelliops/workflows/plans', '/intelliops/workflows/communication', '/intelliops/workflows/policy',
    '/intelliops/overview', '/intelliops/exceptions', '/intelliops/investigation', '/intelliops/approvals', '/intelliops/audit',
    '/payments/transactions', '/core-banking/accounts', '/core-banking/journals',
  ]) {
    assert.ok(routes.includes(expected), `expected route ${expected} to be registered`);
  }
  // 8 intelliops primary + 3 children + 1 payments + 2 core-banking
  assert.equal(routes.length, 14, 'total registered route count');
});

test('findCurrent resolves the active page label, including nested children', () => {
  assert.equal(findCurrent(intelliOps, '/intelliops/overview'), 'Overview');
  assert.equal(findCurrent(intelliOps, '/intelliops/workflows'), 'Resolution Workspace');
  assert.equal(findCurrent(intelliOps, '/intelliops/workflows/plans'), 'Resolution Plans');
  assert.equal(findCurrent(intelliOps, '/intelliops/workflows/communication'), 'Customer Communication');
  assert.equal(findCurrent(intelliOps, '/intelliops/workflows/policy'), 'Policy Assessment');
  assert.equal(findCurrent(intelliOps, '/intelliops/audit'), 'Audit Trail');
});

test('groupIsActive is true on the parent route and any child route, false elsewhere', () => {
  assert.equal(groupIsActive(intelliOps, workflows, '/intelliops/workflows'), true);
  assert.equal(groupIsActive(intelliOps, workflows, '/intelliops/workflows/plans'), true);
  assert.equal(groupIsActive(intelliOps, workflows, '/intelliops/workflows/policy'), true);
  assert.equal(groupIsActive(intelliOps, workflows, '/intelliops/overview'), false);
  assert.equal(groupIsActive(intelliOps, workflows, '/intelliops/exceptions'), false);
});

test('childIsActive matches only the exact child route', () => {
  assert.equal(childIsActive(intelliOps, 'workflows/plans', '/intelliops/workflows/plans'), true);
  assert.equal(childIsActive(intelliOps, 'workflows/plans', '/intelliops/workflows/communication'), false);
  assert.equal(childIsActive(intelliOps, 'workflows/plans', '/intelliops/workflows'), false);
});

test('contextSearch preserves case and investigation params and omits unrelated params', () => {
  assert.equal(contextSearch(new URLSearchParams('case=CASE-1&investigation=INV-9')), '?case=CASE-1&investigation=INV-9');
  assert.equal(contextSearch(new URLSearchParams('case=CASE-1')), '?case=CASE-1');
  assert.equal(contextSearch(new URLSearchParams('')), '');
  assert.equal(contextSearch(new URLSearchParams('foo=bar')), '');
});
