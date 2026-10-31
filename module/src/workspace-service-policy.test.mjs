import test from 'node:test';
import assert from 'node:assert/strict';
import { machineScopeRole, scopeIsWithin, serviceScope, apiKeyIsActive } from './workspace-service-policy.ts';

const all = { role: 'editor', allBoards: true, boardIds: [] };
const selected = { role: 'editor', allBoards: false, boardIds: [7n, 8n] };

test('service account and key scopes intersect on every board', () => {
  assert.equal(machineScopeRole(all, { ...all, role: 'viewer' }, 7n), 'viewer');
  assert.equal(machineScopeRole({ ...selected, role: 'viewer' }, all, 7n), 'viewer');
  assert.equal(machineScopeRole(selected, all, 9n), '');
  assert.equal(machineScopeRole(all, selected, 9n), '');
  assert.equal(machineScopeRole(selected, { ...selected, boardIds: [8n, 9n] }, 8n), 'editor');
  assert.equal(machineScopeRole(selected, { ...selected, boardIds: [8n, 9n] }, 7n), '');
  assert.equal(machineScopeRole({ ...all, role: 'manager' }, all, 7n), '');
});

test('keys cannot be created with a wider role or board scope than their account', () => {
  assert.equal(scopeIsWithin(all, selected), true);
  assert.equal(scopeIsWithin(selected, all), true, 'all account boards follows the current account selection');
  assert.equal(machineScopeRole(selected, all, 7n), 'editor');
  assert.equal(machineScopeRole(selected, all, 9n), '');
  assert.equal(scopeIsWithin(selected, { ...selected, boardIds: [9n] }), false);
  assert.equal(scopeIsWithin({ ...all, role: 'viewer' }, selected), false);
  assert.equal(scopeIsWithin(selected, { ...selected, role: 'viewer', boardIds: [8n] }), true);
});

test('service scope validates roles, deduplicates boards and bounds input size', () => {
  assert.deepEqual(serviceScope('viewer', false, [8n, 7n, 8n]), { role: 'viewer', allBoards: false, boardIds: [8n, 7n] });
  assert.deepEqual(serviceScope('editor', true, []), all);
  for (const role of ['', 'owner', 'manager']) assert.throws(() => serviceScope(role, true, []));
  assert.throws(() => serviceScope('viewer', false, []));
  assert.throws(() => serviceScope('viewer', false, [0n]));
  assert.throws(() => serviceScope('viewer', false, Array.from({ length: 501 }, (_, i) => BigInt(i + 1))));
});

test('key expiry is strict at the boundary and revocation is independent of the clock', () => {
  const key = { revoked: false, expiresAt: { microsSinceUnixEpoch: 100n } };
  assert.equal(apiKeyIsActive(key, 99n), true);
  assert.equal(apiKeyIsActive(key, 100n), false);
  assert.equal(apiKeyIsActive(key, 101n), false);
  assert.equal(apiKeyIsActive({ ...key, revoked: true }, 1n), false);
  assert.equal(apiKeyIsActive({ revoked: false }, 100000n), true);
  assert.equal(apiKeyIsActive(undefined, 1n), false);
});
