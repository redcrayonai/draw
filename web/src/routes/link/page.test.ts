import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import type { Writable } from 'svelte/store';

const h = vi.hoisted(() => ({
  config: {
    accounts: undefined as string | undefined,
    spacetimeUri: 'ws://127.0.0.1:3100',
    spacetimeDb: 'redcrayon-test',
    canvasUrl: 'http://localhost:5173',
  },
}));
vi.mock('$lib/config', () => ({ config: h.config }));
vi.mock('$lib/stdb', async () => {
  const { writable } = await import('svelte/store');
  return { stdbState: writable({ status: 'live' }), getConn: vi.fn(), disconnect: vi.fn() };
});

import Page from './+page.svelte';
import { DEFAULT_DB } from '$shared/db-target';
import * as stdb from '$lib/stdb';
import type { StdbState } from '$lib/stdb';
import { session } from '$lib/session';

const CODE = 'a'.repeat(43);
const state = stdb.stdbState as unknown as Writable<StdbState>;

beforeEach(() => {
  history.replaceState(null, '', `/link?code=${CODE}&db=redcrayon-test`);
  h.config.accounts = undefined;
  h.config.spacetimeDb = 'redcrayon-test';
  state.set({ status: 'live' });
  session.set({ status: 'signed-out' });
  vi.mocked(stdb.getConn).mockReset();
});

describe('/link', () => {
  it('redeems the code, says so and links back to boards', async () => {
    const redeemAgentLink = vi.fn(async (_a: { code: string }) => {});
    vi.mocked(stdb.getConn).mockReturnValue({ reducers: { redeemAgentLink } } as never);
    render(Page);
    await fireEvent.click(screen.getByRole('button', { name: 'Link this agent to your dashboard' }));
    expect(redeemAgentLink).toHaveBeenCalledWith({ code: CODE });
    expect(await screen.findByRole('status')).toHaveTextContent('Agent linked.');
    expect(screen.getByRole('status')).toHaveTextContent('The boards it makes are yours, and it keeps editing them.');
    expect(screen.getByRole('link', { name: 'back to boards' })).toHaveAttribute(
      'href',
      '/dashboard?db=redcrayon-test'
    );
  });

  it('refuses a link for a database this dashboard does not serve, without redeeming', () => {
    history.replaceState(null, '', `/link?code=${CODE}&db=attacker`);
    render(Page);
    expect(screen.getByRole('alert')).toHaveTextContent('This link is for a database this dashboard does not serve.');
    expect(screen.queryByRole('button', { name: 'Link this agent to your dashboard' })).toBeNull();
  });

  // setDb leaves the default database out, so a link with no ?db= names DEFAULT_DB, not ours.
  it('refuses a link with no ?db= when this dashboard is not on the default database', () => {
    history.replaceState(null, '', `/link?code=${CODE}`);
    render(Page);
    expect(screen.getByRole('alert')).toHaveTextContent('This link is for a database this dashboard does not serve.');
    expect(screen.queryByRole('button', { name: 'Link this agent to your dashboard' })).toBeNull();
  });

  it('accepts a link with no ?db= when this dashboard is on the default database', () => {
    h.config.spacetimeDb = DEFAULT_DB;
    history.replaceState(null, '', `/link?code=${CODE}`);
    render(Page);
    expect(screen.getByRole('button', { name: 'Link this agent to your dashboard' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says what a link allows before the click', () => {
    render(Page);
    expect(screen.getByText(/only the boards of yours that you share with it/)).toBeInTheDocument();
    expect(screen.getByText(/Only open links from agents you run/)).toBeInTheDocument();
    expect(screen.queryByText(/session boards/)).toBeNull();
  });

  it('shows the reducer error verbatim', async () => {
    const redeemAgentLink = vi.fn(async (_a: { code: string }) => {
      throw new Error('link code is invalid or expired');
    });
    vi.mocked(stdb.getConn).mockReturnValue({ reducers: { redeemAgentLink } } as never);
    render(Page);
    await fireEvent.click(screen.getByRole('button', { name: 'Link this agent to your dashboard' }));
    expect(await screen.findByText('link code is invalid or expired')).toBeInTheDocument();
  });

  it('gives up after 15 s when the database never answers, and lets the user retry', async () => {
    vi.useFakeTimers();
    const redeemAgentLink = vi.fn((_a: { code: string }) => new Promise<void>(() => {}));
    vi.mocked(stdb.getConn).mockReturnValue({ reducers: { redeemAgentLink } } as never);
    render(Page);
    const button = screen.getByRole('button', { name: 'Link this agent to your dashboard' });
    await fireEvent.click(button);
    expect(button).toBeDisabled();
    await vi.advanceTimersByTimeAsync(15_000);
    vi.useRealTimers();
    expect(
      await screen.findByText('The database did not answer in 15 seconds. Check your connection and try again.')
    ).toBeInTheDocument();
    expect(button).toBeEnabled();
  });

  it('explains a link without a code', () => {
    history.replaceState(null, '', '/link');
    render(Page);
    expect(screen.getByText(/This link has no code/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('waits for a live connection', () => {
    state.set({ status: 'connecting' });
    render(Page);
    expect(screen.getByText('Connecting…')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('asks a signed-out account user to sign in first', () => {
    h.config.accounts = 'issuer_x';
    state.set({ status: 'idle' });
    render(Page);
    expect(screen.getByText(/Sign in first/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'sign in' })).toBeInTheDocument();
  });
});
