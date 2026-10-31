import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import { createRawSnippet, tick } from 'svelte';
import type { Writable } from 'svelte/store';
import type { StdbState } from '$lib/stdb';

const h = vi.hoisted(() => ({
  config: { accounts: 'issuer_x' as string | undefined, spacetimeDb: 'test' },
  ensurePersonalWorkspace: vi.fn(async () => {}),
}));
vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/dashboard') } }));
vi.mock('$lib/config', () => ({ config: h.config }));
vi.mock('$lib/session', async () => {
  const { writable } = await import('svelte/store');
  return { session: writable({ status: 'loading' }), initSession: vi.fn(), signIn: vi.fn(), freshToken: vi.fn() };
});
vi.mock('$lib/stdb', async () => {
  const { writable } = await import('svelte/store');
  return { stdbState: writable({ status: 'idle' }), identityHex: writable(''), myBoards: writable([]), getConn: () => ({ reducers: { ensurePersonalWorkspace: h.ensurePersonalWorkspace } }), connectAs: vi.fn(), disconnect: vi.fn(), joinAs: vi.fn() };
});

import Layout from './+layout.svelte';
import { session, freshToken, signIn } from '$lib/session';
import { connectAs, disconnect, identityHex, stdbState } from '$lib/stdb';
import { workspaceState } from '$lib/workspaces';

const identity = identityHex as unknown as Writable<string>;
const connectionState = stdbState as unknown as Writable<StdbState>;

function mount() {
  render(Layout, { children: createRawSnippet(() => ({ render: () => '<p>Workspace content</p>' })) });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.config.accounts = 'issuer_x';
  session.set({ status: 'loading' });
  connectionState.set({ status: 'idle' });
  workspaceState.set('idle');
  identity.set('');
});

describe('layout auth boundary', () => {
  it('waits for the session, then renders routes only while signed in', async () => {
    mount();
    expect(screen.getByRole('status')).toHaveTextContent('Restoring your session');
    expect(screen.queryByRole('button', { name: /sign in/i })).toBeNull();
    expect(screen.queryByText('Workspace content')).toBeNull();
    expect(connectAs).not.toHaveBeenCalled();
    session.set({ status: 'signed-in', userId: 'user_a', displayName: 'Maya' });
    await tick();
    expect(screen.getByText('Workspace content')).toBeInTheDocument();
    expect(screen.getByTestId('account-chip')).toHaveTextContent('Maya');
    expect(connectAs).toHaveBeenCalledWith('account:user_a', freshToken);
    session.set({ status: 'signed-in', userId: 'user_b', displayName: 'Alex' });
    await tick();
    expect(connectAs).toHaveBeenLastCalledWith('account:user_b', freshToken);
    session.set({ status: 'signed-out' });
    await tick();
    expect(disconnect).toHaveBeenCalled();
    expect(screen.queryByText('Workspace content')).toBeNull();
  });

  it('sets up the personal workspace once per connected signed-in identity', async () => {
    mount();
    session.set({ status: 'signed-in', userId: 'user_a', displayName: 'Maya' });
    identity.set('aa'.repeat(32));
    connectionState.set({ status: 'live' });
    await tick();
    expect(h.ensurePersonalWorkspace).not.toHaveBeenCalled();
    workspaceState.set('live');
    await tick();
    expect(h.ensurePersonalWorkspace).toHaveBeenCalledExactlyOnceWith({});
    session.set({ status: 'signed-in', userId: 'user_a', displayName: 'Maya renamed' });
    await tick();
    expect(h.ensurePersonalWorkspace).toHaveBeenCalledTimes(1);
    session.set({ status: 'signed-in', userId: 'user_b', displayName: 'Alex' });
    identity.set('bb'.repeat(32));
    await tick();
    expect(h.ensurePersonalWorkspace).toHaveBeenCalledTimes(2);
    session.set({ status: 'signed-out' });
    await tick();
    expect(h.ensurePersonalWorkspace).toHaveBeenCalledTimes(2);
  });

  it('opens the sign-in card without a close button when the provider reports signed out', async () => {
    mount();
    expect(signIn).not.toHaveBeenCalled();
    session.set({ status: 'signed-out' });
    await tick();
    expect(signIn).toHaveBeenCalledExactlyOnceWith(false);
    expect(screen.queryByText('Workspace content')).toBeNull();
    expect(screen.getByRole('button', { name: 'sign in to continue' })).toBeInTheDocument();
  });

  it('waits for the retry button after sign-in fails to load', async () => {
    session.set({ status: 'signed-out', error: 'Sign-in could not load; check your connection and try again.' });
    mount();
    await tick();
    expect(signIn).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'sign in to continue' })).toBeInTheDocument();
  });

  it('keeps local guest routes available without accounts', async () => {
    h.config.accounts = undefined;
    session.set({ status: 'signed-out' });
    mount();
    await tick();
    expect(screen.getByText('Workspace content')).toBeInTheDocument();
    expect(connectAs).toHaveBeenCalledWith('anon', expect.any(Function));
    expect(screen.queryByRole('button', { name: /sign in/i })).toBeNull();
    expect(signIn).not.toHaveBeenCalled();
  });
});
