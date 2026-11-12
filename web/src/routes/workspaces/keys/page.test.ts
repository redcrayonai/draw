import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import { Timestamp } from 'spacetimedb';
import { myWorkspaces, workspaceState, resetWorkspaces } from '$lib/workspaces';
const h = vi.hoisted(() => ({ url: new URL('http://localhost/workspaces/keys') }));
vi.mock('$app/state', () => ({ page: { get url() { return h.url; } } }));
vi.mock('$lib/stdb', async () => {
  const { writable } = await import('svelte/store');
  return { stdbState: writable({ status: 'live' }), identityHex: writable('aa'.repeat(32)), myBoards: writable([]), getConn: () => ({ reducers: {} }) };
});
import Page from './+page.svelte';
const ws = (personal: boolean, role: string) => ({ id: 1n, name: personal ? 'Personal' : 'Acme', personal, role, createdAt: new Timestamp(1n) });
beforeEach(() => {
  resetWorkspaces();
  workspaceState.set('live');
});
describe('service accounts and keys', () => {
  it('lets a personal workspace owner manage service accounts', () => {
    myWorkspaces.set([ws(true, 'owner')]);
    render(Page);
    expect(screen.getByRole('heading', { name: 'Service accounts' })).toBeInTheDocument();
    expect(screen.queryByText(/employees/)).toBeNull();
  });
  it('turns away a member who does not manage the workspace', () => {
    myWorkspaces.set([ws(false, 'member')]);
    render(Page);
    expect(screen.queryByRole('heading', { name: 'Service accounts' })).toBeNull();
    expect(screen.getByText('Owners and admins of a workspace manage its service accounts.')).toBeInTheDocument();
  });
});
