import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/svelte';
import { Timestamp } from 'spacetimedb';
import { myWorkspaces, boardPermissions, resetWorkspaces } from '$lib/workspaces';
import { myBoard } from '$lib/test-rows';
vi.mock('$lib/stdb', async () => {
  const { writable } = await import('svelte/store');
  return { myBoards: writable([]) };
});
import * as stdb from '$lib/stdb';
import type { Writable } from 'svelte/store';
import type { MyBoard } from '$lib/boards';
import Sidebar from './Sidebar.svelte';

const boards = stdb.myBoards as unknown as Writable<MyBoard[]>;
const ws = (id: bigint, name: string, role = 'owner', personal = false) => ({ id, name, personal, role, createdAt: new Timestamp(1n) });

beforeEach(() => {
  resetWorkspaces();
  boards.set([myBoard({ boardId: 1n }), myBoard({ boardId: 2n }), myBoard({ boardId: 3n })]);
  myWorkspaces.set([ws(1n, 'Personal', 'owner', true), ws(2n, 'Acme'), ws(3n, 'Client', 'guest')]);
  boardPermissions.set(new Map([[2n, { boardId: 2n, workspaceId: 2n, role: 'editor', defaultRole: 'none', canEdit: true, canManage: false }]]));
});

describe('Sidebar', () => {
  it('fires the theme toggle and names its action by scheme', async () => {
    const ontoggle = vi.fn();
    render(Sidebar, { props: { theme: 'nord', ontoggle } });
    await fireEvent.click(screen.getByRole('button', { name: 'Switch to light theme' }));
    expect(ontoggle).toHaveBeenCalled();
  });

  it('shows the account chip, or a sign-in button once the session has loaded signed out', async () => {
    const { unmount } = render(Sidebar, { props: { theme: 'dark', ontoggle: () => {}, account: 'maya.k' } });
    expect(screen.getByTestId('account-chip')).toHaveTextContent('maya.k');
    unmount();
    const onsignin = vi.fn();
    render(Sidebar, { props: { theme: 'dark', ontoggle: () => {}, canSignIn: true, loading: true, onsignin } });
    expect(screen.queryByRole('button', { name: /sign in/i })).toBeNull();
    render(Sidebar, { props: { theme: 'dark', ontoggle: () => {}, canSignIn: true, onsignin } });
    await fireEvent.click(screen.getByRole('button', { name: 'sign in' }));
    expect(onsignin).toHaveBeenCalled();
  });

  it('marks all boards current and counts boards per workspace', async () => {
    render(Sidebar, { props: { theme: 'dark', ontoggle: () => {}, path: '/dashboard' } });
    expect(screen.getByRole('link', { name: /All boards/ })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: /Outside workspaces 2/ })).toHaveAttribute('href', '/dashboard?workspace=0');
    await fireEvent.click(screen.getByRole('button', { name: /Acme/ }));
    expect(screen.getByRole('link', { name: /^Boards 1$/ })).toHaveAttribute('href', '/dashboard?workspace=2');
  });

  it('opens the shown workspace with its settings on a settings page, per role', async () => {
    render(Sidebar, { props: { theme: 'dark', ontoggle: () => {}, path: '/workspaces/members', workspace: '2' } });
    const nav = screen.getByRole('navigation', { name: 'Workspaces' });
    expect(within(nav).getByRole('button', { name: /Acme/ })).toHaveAttribute('aria-expanded', 'true');
    expect(within(nav).getByRole('link', { name: 'Members & access' })).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByRole('link', { name: 'Service accounts & keys' })).toHaveAttribute('href', '/workspaces/keys?workspace=2');
    expect(within(nav).getByRole('button', { name: /Personal/ })).toHaveAttribute('aria-expanded', 'false');
    await fireEvent.click(within(nav).getByRole('button', { name: /Client/ }));
    const settings = within(nav).getAllByRole('button', { name: 'Settings' });
    await fireEvent.click(settings[settings.length - 1]);
    expect(within(nav).getAllByRole('link', { name: 'Members & access' })).toHaveLength(2);
    expect(within(nav).getAllByRole('link', { name: 'Service accounts & keys' })).toHaveLength(1);
    expect(within(nav).getByRole('link', { name: 'New workspace' })).toHaveAttribute('href', '/workspaces/new');
  });
});
