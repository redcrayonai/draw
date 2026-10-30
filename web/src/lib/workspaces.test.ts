import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { Identity, Timestamp } from 'spacetimedb';
import { attachWorkspaces, resetWorkspaces, myWorkspaces, boardPermissions, workspaceState, inviteHref, pendingInvite, rememberInvite, clearInvite, workspaceServiceAccounts, workspaceApiKeys, serviceAccountState } from './workspaces';

class Table {
  rows: unknown[] = [];
  listeners: (() => void)[] = [];
  iter() { return this.rows.values(); }
  onInsert(cb: () => void) { this.listeners.push(cb); }
  onUpdate(cb: () => void) { this.listeners.push(cb); }
  onDelete(cb: () => void) { this.listeners.push(cb); }
  emit() { for (const cb of this.listeners) cb(); }
}
function connection() {
  const names = ['myWorkspaces', 'myWorkspaceMembers', 'myWorkspaceTeams', 'myWorkspaceTeamMembers', 'myBoardPermissions', 'myWorkspaceBoardGrants', 'myWorkspaceTeamGrants', 'myWorkspaceInvites', 'myWorkspaceServiceAccounts', 'myWorkspaceApiKeys'];
  const db = Object.fromEntries(names.map(name => [name, new Table()]));
  const subscriptions: { applied: () => void; error: () => void }[] = [];
  const subscribe = vi.fn();
  const subscriptionBuilder = () => {
    const callbacks = { applied: () => {}, error: () => {} };
    subscriptions.push(callbacks);
    const builder = { onApplied(cb: () => void) { callbacks.applied = cb; return builder; }, onError(cb: () => void) { callbacks.error = cb; return builder; }, subscribe };
    return builder;
  };
  return { db, subscriptionBuilder, subscribe, apply: (index = 0) => subscriptions[index].applied(), fail: (index = 0) => subscriptions[index].error() };
}
beforeEach(() => { resetWorkspaces(); sessionStorage.clear(); });
describe('native workspace subscription', () => {
  it('reads native memberships and permissions without provider organizations', () => {
    const conn = connection();
    attachWorkspaces(conn as never, () => false);
    conn.db.myWorkspaces.rows = [{ id: 4n, name: 'Acme', personal: false, role: 'owner', createdAt: new Timestamp(1n) }];
    conn.db.myBoardPermissions.rows = [{ boardId: 2n, workspaceId: 4n, role: 'viewer', defaultRole: 'none', canEdit: false, canManage: false }];
    conn.apply();
    expect(get(myWorkspaces)[0].name).toBe('Acme');
    expect(get(boardPermissions).get(2n)?.canEdit).toBe(false);
    expect(get(workspaceState)).toBe('live');
    expect(conn.subscribe).toHaveBeenCalledWith(expect.arrayContaining(['SELECT * FROM my_workspaces', 'SELECT * FROM my_board_permissions']));
  });
  it('ignores late callbacks from a disconnected identity', () => {
    const conn = connection();
    let stale = false;
    attachWorkspaces(conn as never, () => stale);
    stale = true;
    resetWorkspaces();
    conn.db.myWorkspaces.rows = [{ id: 9n }];
    conn.apply();
    expect(get(myWorkspaces)).toEqual([]);
  });
  it('keeps old servers usable when optional native views are absent', () => {
    const conn = connection();
    attachWorkspaces(conn as never, () => false);
    conn.fail();
    expect(get(workspaceState)).toBe('unavailable');
    expect(get(myWorkspaces)).toEqual([]);
  });
  it('keeps service-account metadata isolated and clears it on disconnect', () => {
    const conn = connection();
    attachWorkspaces(conn as never, () => false);
    conn.db.myWorkspaceServiceAccounts.rows = [{ id: 7n, name: 'CI' }];
    conn.db.myWorkspaceApiKeys.rows = [{ id: 'ab'.repeat(16), name: 'Build key' }];
    conn.apply(1);
    expect(get(workspaceServiceAccounts)[0].name).toBe('CI');
    expect(get(workspaceApiKeys)[0].name).toBe('Build key');
    expect(get(serviceAccountState)).toBe('live');
    resetWorkspaces();
    expect(get(workspaceServiceAccounts)).toEqual([]);
    expect(get(workspaceApiKeys)).toEqual([]);
  });
  it('keeps workspaces usable when an older server cannot serve service accounts', () => {
    const conn = connection();
    attachWorkspaces(conn as never, () => false);
    conn.db.myWorkspaces.rows = [{ id: 4n, name: 'Acme' }];
    conn.apply();
    conn.fail(1);
    expect(get(serviceAccountState)).toBe('unavailable');
    expect(get(workspaceState)).toBe('live');
    expect(get(myWorkspaces)[0].name).toBe('Acme');
  });
  it('ignores service-account metadata arriving after an identity change', () => {
    const conn = connection();
    let stale = false;
    attachWorkspaces(conn as never, () => stale);
    stale = true;
    resetWorkspaces();
    conn.db.myWorkspaceServiceAccounts.rows = [{ id: 7n, name: 'Secret CI' }];
    conn.apply(1);
    expect(get(workspaceServiceAccounts)).toEqual([]);
    expect(get(serviceAccountState)).toBe('idle');
  });
});
describe('invitation handoff', () => {
  const token = 'ab'.repeat(16);
  it('preserves a valid invitation across sign-in and clears it after acceptance', () => {
    rememberInvite(token);
    expect(pendingInvite('')).toBe(token);
    expect(inviteHref(token, 'https://boards.example')).toBe(`https://boards.example/workspaces?invite=${token}`);
    clearInvite();
    expect(pendingInvite('')).toBe('');
  });
  it('keeps the selected database in copied invitation links', () => {
    expect(inviteHref(token, 'https://boards.example', 'staging')).toBe(`https://boards.example/workspaces?db=staging&invite=${token}`);
  });
  it('omits the configured default database from invitation links', () => {
    expect(inviteHref(token, 'https://boards.example', import.meta.env.VITE_SPACETIME_DB)).toBe(`https://boards.example/workspaces?invite=${token}`);
  });
  it('preserves the invitation token when encoding a named database', () => {
    const url = new URL(inviteHref(token, 'https://boards.example', 'staging & review'));
    expect(url.searchParams.get('db')).toBe('staging & review');
    expect(url.searchParams.get('invite')).toBe(token);
    expect([...url.searchParams.keys()]).toEqual(['db', 'invite']);
  });
  it('rejects malformed tokens instead of putting them in the sign-in handoff', () => {
    rememberInvite('<script>');
    expect(pendingInvite('')).toBe('');
    expect(pendingInvite('?invite=invalid')).toBe('');
  });
});
