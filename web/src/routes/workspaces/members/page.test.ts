import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import { Identity, Timestamp } from 'spacetimedb';
import { myWorkspaces, workspaceMembers, workspaceTeams, workspaceTeamMembers, workspaceState, resetWorkspaces } from '$lib/workspaces';
const h = vi.hoisted(() => ({ url: new URL('http://localhost/workspaces/members'), reducers: { setWorkspaceMember: vi.fn(async (_: unknown) => {}) } }));
vi.mock('$app/state', () => ({ page: { get url() { return h.url; } } }));
vi.mock('$lib/stdb', async () => {
  const { writable } = await import('svelte/store');
  return { stdbState: writable({ status: 'live' }), identityHex: writable('aa'.repeat(32)), myBoards: writable([]), getConn: () => ({ reducers: h.reducers }) };
});
import Page from './+page.svelte';
const ME = new Identity('aa'.repeat(32));
const MAYA = new Identity('bb'.repeat(32));
beforeEach(() => {
  vi.clearAllMocks();
  resetWorkspaces();
  h.url = new URL('http://localhost/workspaces/members');
  workspaceState.set('live');
  workspaceMembers.set([
    { id: 1n, workspaceId: 2n, member: ME, role: 'owner', name: 'Alan' },
    { id: 2n, workspaceId: 2n, member: MAYA, role: 'member', name: 'Maya' },
  ]);
  workspaceTeams.set([{ id: 9n, workspaceId: 2n, name: 'Platform' }] as never);
  workspaceTeamMembers.set([{ id: 1n, teamId: 9n, member: MAYA }] as never);
});
describe('members and access', () => {
  it('lists members in a table with their teams and edits a role', async () => {
    myWorkspaces.set([{ id: 2n, name: 'Acme', personal: false, role: 'owner', createdAt: new Timestamp(1n) }]);
    h.url = new URL('http://localhost/workspaces/members?workspace=2');
    render(Page);
    expect(screen.getByRole('tab', { name: /Members/, selected: true })).toBeInTheDocument();
    const maya = screen.getByRole('row', { name: /Maya/ });
    expect(maya).toHaveTextContent('Platform');
    expect(screen.getByRole('row', { name: /Alan \(you\)/ })).toBeInTheDocument();
    await fireEvent.change(screen.getByRole('combobox', { name: 'Role for Maya' }), { target: { value: 'admin' } });
    expect(h.reducers.setWorkspaceMember).toHaveBeenCalledWith({ workspaceId: 2n, member: MAYA, role: 'admin' });
  });
  it('filters members by name', async () => {
    myWorkspaces.set([{ id: 2n, name: 'Acme', personal: false, role: 'owner', createdAt: new Timestamp(1n) }]);
    h.url = new URL('http://localhost/workspaces/members?workspace=2');
    render(Page);
    await fireEvent.input(screen.getByRole('searchbox', { name: 'Search members' }), { target: { value: 'may' } });
    expect(screen.queryByRole('row', { name: /Alan/ })).toBeNull();
    expect(screen.getByRole('row', { name: /Maya/ })).toBeInTheDocument();
  });
  it('opens the tab its link names, and the invite button moves to invitations', async () => {
    myWorkspaces.set([{ id: 2n, name: 'Acme', personal: false, role: 'owner', createdAt: new Timestamp(1n) }]);
    h.url = new URL('http://localhost/workspaces/members?workspace=2&tab=teams');
    render(Page);
    expect(screen.getByRole('tab', { name: /Teams/, selected: true })).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('tab', { name: /Members/ }));
    await fireEvent.click(screen.getByRole('button', { name: 'invite members' }));
    expect(screen.getByRole('tab', { name: /Invitations/, selected: true })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'create invitation' })).toBeInTheDocument();
  });
  it('does not offer invitations or role edits to an ordinary member', () => {
    myWorkspaces.set([{ id: 2n, name: 'Acme', personal: false, role: 'member', createdAt: new Timestamp(1n) }]);
    h.url = new URL('http://localhost/workspaces/members?workspace=2');
    render(Page);
    expect(screen.queryByRole('tab', { name: /Invitations/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'invite members' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Role for Maya' })).toBeNull();
  });
  it('says so when the linked workspace is not one of yours', () => {
    myWorkspaces.set([{ id: 2n, name: 'Acme', personal: false, role: 'owner', createdAt: new Timestamp(1n) }]);
    h.url = new URL('http://localhost/workspaces/members?workspace=7');
    render(Page);
    expect(screen.getByText('This workspace is not available to you. Choose another one in the sidebar.')).toBeInTheDocument();
  });
});
