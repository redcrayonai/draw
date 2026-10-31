import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';
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
  return {
    stdbState: writable({ status: 'live' }),
    myBoards: writable([]),
    myAgentLinks: writable([]),
    identityHex: writable(''),
    boardSlugs: writable(new Map([[2n, 'c4bb879c7355360696d9']])),
    myActivity: writable(null),
    getConn: vi.fn(),
    disconnect: vi.fn(),
  };
});

import Page from './+page.svelte';
import * as stdb from '$lib/stdb';
import type { ActivityResult } from '$lib/activity';
import { session } from '$lib/session';
import type { AgentLinkRow, MyBoard } from '$lib/boards';
import { DEMO, activityEvent, agentLink, myBoard } from '$lib/test-rows';

const ME = 'aa'.repeat(32);
const boards = stdb.myBoards as unknown as Writable<MyBoard[]>;
const links = stdb.myAgentLinks as unknown as Writable<AgentLinkRow[]>;
const me = stdb.identityHex as unknown as Writable<string>;
const feed = stdb.myActivity as unknown as Writable<ActivityResult | null>;

beforeEach(() => {
  h.config.accounts = undefined;
  session.set({ status: 'signed-out' });
  boards.set([]);
  links.set([]);
  me.set('');
  feed.set({ events: [] });
});

describe('profile page', () => {
  it('shows the account identity, board counts by access, linked agents and my own activity', async () => {
    h.config.accounts = 'issuer_x';
    session.set({ status: 'signed-in', displayName: 'Maya Kessler', email: 'maya@example.com', userId: 'user_1' });
    me.set(ME);
    boards.set([DEMO, myBoard({ boardId: 2n, name: 'payments' }), myBoard({ boardId: 3n }), myBoard({ boardId: 4n, access: 'agent' })]);
    links.set([agentLink('bb'.repeat(32), ME)]);
    feed.set({ events: [activityEvent({ boardId: '2', actor: ME, type: 'board.created' }), activityEvent({ id: '2', boardId: '2', actor: 'bb'.repeat(32) })] });
    render(Page);
    expect(screen.getByText('Maya Kessler')).toBeInTheDocument();
    expect(screen.getByText('maya@example.com')).toBeInTheDocument();
    expect(screen.getByText('your boards').previousElementSibling).toHaveTextContent('2');
    expect(screen.getByText('agent boards').previousElementSibling).toHaveTextContent('1');
    expect(screen.getByText('public boards').previousElementSibling).toHaveTextContent('1');
    expect(screen.getByText('linked agents').previousElementSibling).toHaveTextContent('1');
    expect((await screen.findByText(/created/)).closest('p')).toHaveTextContent('you created payments');
    expect(screen.getByRole('link', { name: 'payments' })).toHaveAttribute('href', expect.stringMatching(/#b=c4bb879c7355360696d9$/));
    expect(screen.queryByText(/API Gateway/)).toBeNull(); // someone else's event on the same board
  });

  it('anonymous dev mode says so and shows no fabricated stats', () => {
    render(Page);
    expect(screen.getByText('Guest')).toBeInTheDocument();
    expect(screen.queryByText('citations added')).toBeNull();
    expect(screen.queryByText('nodes placed')).toBeNull();
  });

  it('shows the activity sentence in place', () => {
    me.set(ME);
    feed.set({ error: 'Activity needs the latest board server. Update the server and reload.' });
    render(Page);
    expect(screen.getByText('Activity needs the latest board server. Update the server and reload.')).toBeInTheDocument();
  });

  it('shows the identity tail, keeps the full hex in the title and copies it', async () => {
    const id = `c200${'0'.repeat(52)}1a2b3c4d`;
    me.set(id);
    const writeText = vi.fn(async (_t: string) => {});
    Object.assign(navigator, { clipboard: { writeText } });
    render(Page);
    expect(screen.getByText('identity …1a2b3c4d')).toHaveAttribute('title', id);
    await fireEvent.click(screen.getByRole('button', { name: 'copy' }));
    expect(writeText).toHaveBeenCalledWith(id);
    expect(await screen.findByText('Copied')).toHaveAttribute('role', 'status');
  });

  it('shows only the current identity\'s own events, at most ten', async () => {
    me.set(ME);
    feed.set({ events: Array.from({ length: 12 }, (_, i) => activityEvent({ id: String(i), boardId: '2', actor: ME, type: 'board.created' })) });
    render(Page);
    await fireEvent.click(screen.getByRole('button', { name: /show all/i }));
    expect(screen.getAllByText(/created/)).toHaveLength(10);
    me.set('dd'.repeat(32));
    await tick();
    expect(screen.getByText('No activity yet.')).toBeInTheDocument();
  });
});
