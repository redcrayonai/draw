import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import { Timestamp } from 'spacetimedb';
import { myWorkspaces, workspaceState, resetWorkspaces } from '$lib/workspaces';
const h = vi.hoisted(() => ({ reducers: { createWorkspace: vi.fn(async (_: unknown) => {}) } }));
vi.mock('$lib/stdb', async () => {
  const { writable } = await import('svelte/store');
  return { stdbState: writable({ status: 'live' }), identityHex: writable('aa'.repeat(32)), getConn: () => ({ reducers: h.reducers }) };
});
import { session } from '$lib/session';
import Page from './+page.svelte';
beforeEach(() => {
  vi.clearAllMocks();
  resetWorkspaces();
  session.set({ status: 'signed-in', userId: 'self-hosted-user', displayName: 'Alan' });
  workspaceState.set('live');
});
describe('new workspace', () => {
  it('creates a company workspace and links to inviting people once it arrives', async () => {
    myWorkspaces.set([{ id: 1n, name: 'Personal', personal: true, role: 'owner', createdAt: new Timestamp(1n) }]);
    render(Page);
    await fireEvent.input(screen.getByLabelText('New workspace name'), { target: { value: '  Acme  ' } });
    await fireEvent.click(screen.getByRole('button', { name: 'create workspace' }));
    expect(h.reducers.createWorkspace).toHaveBeenCalledWith({ name: 'Acme' });
    expect(await screen.findByText(/Workspace created\./)).toBeInTheDocument();
    myWorkspaces.update(rows => [...rows, { id: 5n, name: 'Acme', personal: false, role: 'owner', createdAt: new Timestamp(2n) }]);
    expect(await screen.findByRole('link', { name: 'Invite people to Acme' })).toHaveAttribute('href', expect.stringContaining('/workspaces/members?workspace=5&tab=invitations'));
  });
});
