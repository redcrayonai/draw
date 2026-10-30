import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import type { Writable } from 'svelte/store';

const h = vi.hoisted(() => ({
  config: {
    accounts: 'issuer_x' as string | undefined,
    spacetimeUri: 'ws://127.0.0.1:3100',
    spacetimeDb: 'redcrayon-test',
    canvasUrl: 'http://localhost:5173',
    mcpUrl: undefined as string | undefined,
    privacyUrl: undefined as string | undefined,
  },
}));
vi.mock('$lib/config', () => ({ config: h.config }));
vi.mock('$lib/stdb', async () => {
  const { writable } = await import('svelte/store');
  return { stdbState: writable({ status: 'live' }), myAgentLinks: writable([]), myCodeConsent: writable(null), identityHex: writable(''), getConn: vi.fn() };
});
vi.mock('$lib/session', async () => {
  const { writable } = await import('svelte/store');
  const { accountLabel } = await vi.importActual<typeof import('$lib/session')>('$lib/session');
  return {
    accountLabel,
    session: writable({ status: 'loading' }),
    signOut: vi.fn(),
  };
});

import Page from './+page.svelte';
import * as stdb from '$lib/stdb';
import * as sess from '$lib/session';
import type { AgentLinkRow } from '$lib/boards';
import type { StdbState } from '$lib/stdb';
import { agentLink } from '$lib/test-rows';
import { identityFromClaims } from '$shared/identity';
import { workspaceState } from '$lib/workspaces';

const ME = 'aa'.repeat(32);
const AGENT = 'bb'.repeat(32);
const OTHER = 'cc'.repeat(32);
const links = stdb.myAgentLinks as unknown as Writable<AgentLinkRow[]>;
const me = stdb.identityHex as unknown as Writable<string>;
const consent = stdb.myCodeConsent as unknown as Writable<{ storeCode: boolean; boardsWithCode: number } | null>;
const state = stdb.stdbState as unknown as Writable<StdbState>;

beforeEach(() => {
  h.config.accounts = 'issuer_x';
  h.config.mcpUrl = undefined;
  h.config.privacyUrl = undefined;
  sess.session.set({ status: 'signed-in', displayName: 'Maya Kessler', userId: 'user_1' });
  links.set([]);
  consent.set({ storeCode: false, boardsWithCode: 0 });
  me.set(ME);
  state.set({ status: 'live' });
  vi.mocked(stdb.getConn).mockReset();
  workspaceState.set('live');
});

describe('settings page', () => {
  it('links to the agent quickstart in the active database', () => {
    render(Page);
    expect(screen.getByRole('link', { name: 'agent setup guide' })).toHaveAttribute('href', '/settings/agent?db=redcrayon-test');
  });
  it('shows the display name read-only (the sign-in provider owns it)', () => {
    render(Page);
    expect(screen.getByText('Maya Kessler')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('switches the theme from a select grouped by scheme', async () => {
    render(Page);
    const select = screen.getByRole('combobox', { name: 'Theme' }) as HTMLSelectElement;
    expect([...select.querySelectorAll('optgroup')].map((g) => g.label)).toEqual(['redcrayon', 'Dark', 'Light']);
    expect(screen.getByRole('option', { name: 'Nord' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Neo-brutalism' })).toBeNull();
    await fireEvent.change(select, { target: { value: 'one-light' } });
    expect(document.documentElement.dataset.theme).toBe('one-light');
    expect(select.value).toBe('one-light');
    await fireEvent.change(select, { target: { value: 'dark' } });
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('lists a linked agent by its identity tail', () => {
    links.set([agentLink(AGENT, ME)]);
    render(Page);
    expect(screen.getByText('agent …bbbbbbbb')).toHaveAttribute('title', AGENT);
    expect(screen.getByText('linked 1h ago')).toBeInTheDocument();
  });

  it('links to native workspace management', () => {
    render(Page);
    expect(screen.getByRole('link', { name: 'manage workspaces' })).toHaveAttribute('href', '/workspaces?db=redcrayon-test');
  });

  it('hides workspace management while native workspaces are unavailable', () => {
    workspaceState.set('unavailable');
    render(Page);
    expect(screen.queryByRole('link', { name: 'manage workspaces' })).toBeNull();
    expect(screen.getByRole('button', { name: 'sign out' })).toBeInTheDocument();
  });

  it('hides workspace management and sign out without accounts', () => {
    h.config.accounts = undefined;
    sess.session.set({ status: 'signed-out' });
    render(Page);
    expect(screen.getByText('Guest')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'manage workspaces' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'sign out' })).toBeNull();
  });

  it('lists the agents I linked and unlinks them, showing reducer errors verbatim', async () => {
    links.set([agentLink(AGENT, ME), agentLink(ME, OTHER)]);
    const unlinkAgent = vi.fn(async (_a: { agent: AgentLinkRow['agent'] }) => {});
    vi.mocked(stdb.getConn).mockReturnValue({ reducers: { unlinkAgent } } as never);
    render(Page);
    expect(screen.getAllByRole('button', { name: 'unlink' })).toHaveLength(1);
    await fireEvent.click(screen.getByRole('button', { name: 'unlink' }));
    expect(unlinkAgent.mock.calls[0][0].agent.toHexString()).toBe(AGENT);
    unlinkAgent.mockRejectedValueOnce(new Error(`agent ${AGENT} is not linked to you`));
    await fireEvent.click(screen.getByRole('button', { name: 'unlink' }));
    expect(await screen.findByText(`agent ${AGENT} is not linked to you`)).toBeInTheDocument();
  });

  it("offers no unlink for the MCP server's own agent, which links itself again on its next call", () => {
    h.config.mcpUrl = 'https://mcp.example.com/mcp';
    links.set([agentLink(identityFromClaims('https://mcp.example.com/agent-id', 'agent:user_1'), ME), agentLink(AGENT, ME)]);
    render(Page);
    expect(screen.getAllByRole('button', { name: 'unlink' })).toHaveLength(1);
    expect(screen.getByText('Signs in as you. To stop it, remove the MCP server from your agent.')).toBeInTheDocument();
  });

  it('says "No agents linked" only from live rows, never while signed out or connecting', () => {
    sess.session.set({ status: 'signed-out' });
    state.set({ status: 'idle' });
    me.set('');
    const { unmount } = render(Page);
    expect(screen.getByText('Sign in to see your linked agents.')).toBeInTheDocument();
    expect(screen.queryByText(/No agents linked/)).toBeNull();
    unmount();
    sess.session.set({ status: 'signed-in', displayName: 'Maya Kessler', userId: 'user_1' });
    state.set({ status: 'connecting' });
    const second = render(Page);
    expect(screen.getByText('Connecting…')).toBeInTheDocument();
    expect(screen.queryByText(/No agents linked/)).toBeNull();
    second.unmount();
    state.set({ status: 'live' });
    render(Page);
    expect(screen.getByText(/No agents linked/)).toBeInTheDocument();
  });

  it('does not call a signed-out account deployment anonymous', () => {
    sess.session.set({ status: 'signed-out' });
    render(Page);
    expect(screen.getByText('Signed out')).toBeInTheDocument();
    expect(screen.queryByText('Guest')).toBeNull();
  });

  it('shows no account label while auth loads', () => {
    sess.session.set({ status: 'loading' });
    render(Page);
    expect(screen.queryByText('Signed out')).toBeNull();
  });

  describe('code snippet consent', () => {
    const BOX = 'Store code snippets on my boards';
    const setCodeConsent = vi.fn(async (_a: { storeCode: boolean }) => {});
    beforeEach(() => {
      setCodeConsent.mockReset();
      vi.mocked(stdb.getConn).mockReturnValue({ reducers: { setCodeConsent } } as never);
    });

    it('shows an unchecked box with its help line', () => {
      render(Page);
      expect(screen.getByRole('heading', { name: 'Code' })).toBeInTheDocument();
      expect(screen.getByRole('checkbox', { name: BOX })).not.toBeChecked();
      expect(screen.getByText('Without this, boards keep file paths and line numbers and link to the code on GitHub.')).toBeInTheDocument();
    });

    it('explains the setting in a tooltip on an info button that does not toggle it', async () => {
      render(Page);
      const info = screen.getByRole('button', { name: 'What this setting does' });
      const tip = screen.getByRole('tooltip');
      expect(tip).toHaveTextContent('Enabling this will store code references to the database.');
      expect(info).toHaveAttribute('aria-describedby', tip.id);
      await fireEvent.click(info);
      expect(screen.getByRole('checkbox', { name: BOX })).not.toBeChecked();
      expect(setCodeConsent).not.toHaveBeenCalled();
    });

    it('links the privacy policy only when the build names one', () => {
      render(Page);
      expect(screen.queryByRole('link', { name: 'Privacy policy' })).toBeNull();
    });

    it('links the privacy policy under the help line', () => {
      h.config.privacyUrl = 'https://example.com/privacy';
      render(Page);
      const link = screen.getByRole('link', { name: 'Privacy policy' });
      expect(link).toHaveAttribute('href', 'https://example.com/privacy');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    });

    it('turns on at once', async () => {
      render(Page);
      await fireEvent.click(screen.getByRole('checkbox', { name: BOX }));
      expect(setCodeConsent).toHaveBeenCalledWith({ storeCode: true });
    });

    it('asks before deleting snippets, and only "delete snippets" turns it off', async () => {
      consent.set({ storeCode: true, boardsWithCode: 3 });
      render(Page);
      const box = screen.getByRole('checkbox', { name: BOX });
      expect(box).toBeChecked();
      await fireEvent.click(box);
      expect(screen.getByText('This deletes the stored code snippets on 3 boards. It cannot be undone.')).toBeInTheDocument();
      expect(box).toBeChecked();
      await fireEvent.click(screen.getByRole('button', { name: 'cancel' }));
      expect(setCodeConsent).not.toHaveBeenCalled();
      expect(screen.queryByText(/This deletes the stored code snippets/)).toBeNull();
      await fireEvent.click(box);
      await fireEvent.click(screen.getByRole('button', { name: 'delete snippets' }));
      expect(setCodeConsent).toHaveBeenCalledExactlyOnceWith({ storeCode: false });
      await vi.waitFor(() => expect(screen.queryByText(/This deletes the stored code snippets/)).toBeNull());
    });

    it('turns off at once when no board holds a snippet', async () => {
      consent.set({ storeCode: true, boardsWithCode: 0 });
      render(Page);
      await fireEvent.click(screen.getByRole('checkbox', { name: BOX }));
      expect(setCodeConsent).toHaveBeenCalledWith({ storeCode: false });
      expect(screen.queryByText(/This deletes/)).toBeNull();
    });

    it('shows the refusal verbatim and puts the box back', async () => {
      setCodeConsent.mockRejectedValueOnce(new Error('Agents cannot change this setting.'));
      render(Page);
      const box = screen.getByRole('checkbox', { name: BOX });
      await fireEvent.click(box);
      expect(await screen.findByRole('alert')).toHaveTextContent('Agents cannot change this setting.');
      expect(box).not.toBeChecked();
    });
  });
});
