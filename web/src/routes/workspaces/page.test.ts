import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/svelte';
import { Timestamp } from 'spacetimedb';
import { myWorkspaces, workspaceState, resetWorkspaces, rememberInvite } from '$lib/workspaces';
const h = vi.hoisted(() => ({
  url: new URL('http://localhost/workspaces'), reducers: { renameWorkspace: vi.fn(async (_: unknown) => {}), acceptWorkspaceInvite: vi.fn(async (_: unknown) => {}), setWorkspaceMember: vi.fn(async (_: unknown) => {}) } }));
vi.mock('$app/state', () => ({ page: { get url() { return h.url; } } }));
vi.mock('$lib/stdb', async () => {
  const { writable } = await import('svelte/store');
  return { stdbState: writable({ status: 'live' }), identityHex: writable('aa'.repeat(32)), myBoards: writable([]), getConn: () => ({ reducers: h.reducers }) };
});
import { session } from '$lib/session';
import Page from './+page.svelte';
beforeEach(() => {
  vi.clearAllMocks();
  h.url = new URL('http://localhost/workspaces');
  resetWorkspaces();
  sessionStorage.clear();
  session.set({ status: 'signed-in', userId: 'self-hosted-user', displayName: 'Alan' });
  workspaceState.set('live');
  window.history.replaceState({}, '', '/workspaces');
});
describe('native workspace management', () => {
  it('redeems a saved invitation once after sign-in and clears the handoff', async () => {
    rememberInvite('ab'.repeat(16));
    render(Page);
    await waitFor(() => expect(h.reducers.acceptWorkspaceInvite).toHaveBeenCalledWith({ token: 'ab'.repeat(16) }));
    expect(h.reducers.acceptWorkspaceInvite).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(sessionStorage.getItem('redcrayon:workspace-invite')).toBeNull());
    expect(await screen.findByText(/Invitation accepted. Your access is ready/)).toBeInTheDocument();
  });
  it('keeps a failed invitation available to retry and reports the server reason', async () => {
    h.reducers.acceptWorkspaceInvite.mockRejectedValueOnce(new Error('This invitation expired.'));
    window.history.replaceState({}, '', `/workspaces?invite=${'ab'.repeat(16)}`);
    render(Page);
    expect(await screen.findByRole('alert')).toHaveTextContent('This invitation expired.');
    expect(screen.getByRole('button', { name: 'retry invitation' })).toBeEnabled();
  });
  it('does not offer administrative controls to an ordinary member', () => {
    myWorkspaces.set([{ id: 1n, name: 'Acme', personal: false, role: 'member', createdAt: new Timestamp(1n) }]);
      render(Page);
    expect(screen.getByText('Acme', { selector: '.value' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'rename workspace' })).toBeNull();
    expect(screen.queryByRole('link', { name: /Pending invitations/ })).toBeNull();
  });
  it('renames the workspace its link names', async () => {
    myWorkspaces.set([
      { id: 1n, name: 'Personal', personal: true, role: 'owner', createdAt: new Timestamp(1n) },
      { id: 2n, name: 'Acme', personal: false, role: 'admin', createdAt: new Timestamp(1n) },
    ]);
    h.url = new URL('http://localhost/workspaces?workspace=2');
    h.reducers.renameWorkspace = vi.fn(async (_: unknown) => {});
    render(Page);
    expect(screen.getByText('Acme › Settings')).toBeInTheDocument();
    await fireEvent.input(screen.getByLabelText('Workspace name'), { target: { value: ' Acme Inc ' } });
    await fireEvent.click(screen.getByRole('button', { name: 'rename workspace' }));
    expect(h.reducers.renameWorkspace).toHaveBeenCalledWith({ workspaceId: 2n, name: 'Acme Inc' });
  });
});
