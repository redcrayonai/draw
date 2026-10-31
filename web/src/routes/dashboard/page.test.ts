import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';
import type { Writable } from 'svelte/store';

const h = vi.hoisted(() => ({
  url: new URL('http://localhost/dashboard'),
  navigate: vi.fn(),
  config: {
    accounts: undefined as string | undefined,
    spacetimeUri: 'ws://127.0.0.1:3100',
    spacetimeDb: 'redcrayon-test',
    canvasUrl: 'http://localhost:5173',
  },
}));
vi.mock('$lib/config', () => ({ config: h.config }));
vi.mock('$app/state', () => ({ page: { get url() { return h.url; } } }));
vi.mock('$lib/stdb', async () => {
  const { writable } = await import('svelte/store');
  return {
    stdbState: writable({ status: 'live' }),
    myBoards: writable([]),
    myArchitectureHistories: writable([]),
    architectureVersions: writable([]),
    myAgentLinks: writable([]),
    myAgentGrants: writable([]),
    identityHex: writable('aa'.repeat(32)),
    // every board id has a link id here, as my_board_slugs gives one for each of my_boards
    boardSlugs: writable(new (class extends Map<bigint, string> { get = (id: bigint) => id.toString(16).padStart(20, '0'); })()),
    myActivity: writable(null),
    getConn: vi.fn(),
    disconnect: vi.fn(),
  };
});

import Page from './+page.svelte';
import * as stdb from '$lib/stdb';
import type { StdbState } from '$lib/stdb';
import { session } from '$lib/session';
import { myWorkspaces, boardPermissions, resetWorkspaces } from '$lib/workspaces';
import type { AgentGrantRow, AgentLinkRow, MyBoard } from '$lib/boards';
import type { ActivityResult } from '$lib/activity';
import { DEMO, activityEvent, agentGrantRow, agentLink, myBoard, slugOf } from '$lib/test-rows';
import { Timestamp, type Identity } from 'spacetimedb';

const boards = stdb.myBoards as unknown as Writable<MyBoard[]>;
const state = stdb.stdbState as unknown as Writable<StdbState>;
const ident = stdb.identityHex as unknown as Writable<string>;
const histories = stdb.myArchitectureHistories as unknown as Writable<unknown[]>;
const versions = stdb.architectureVersions as unknown as Writable<unknown[]>;
const links = stdb.myAgentLinks as unknown as Writable<AgentLinkRow[]>;
const grants = stdb.myAgentGrants as unknown as Writable<AgentGrantRow[]>;
const feed = stdb.myActivity as unknown as Writable<ActivityResult | null>;
const PAYMENTS = myBoard({ boardId: 2n, name: 'payments', access: 'owner' });

type CreationArgs = { name: string; orgId: string; requestKey: string };
function creationConnection(run: (args: CreationArgs, publish: (boardId: bigint) => void) => Promise<void>, autoApply = true) {
  const listeners = new Set<() => void>();
  const rows: { requestKey: string; boardId: bigint }[] = [];
  const publish = (requestKey: string, boardId: bigint) => {
    rows.push({ requestKey, boardId });
    for (const listener of listeners) listener();
  };
  const createRequestedBoard = vi.fn((args: CreationArgs) => run(args, (boardId) => publish(args.requestKey, boardId)));
  const unsubscribe = vi.fn();
  let applied = () => {};
  let subscriptionError = () => {};
  const subscribe = vi.fn((_sql: string[]) => {
    if (autoApply) void Promise.resolve().then(() => applied());
    return { unsubscribe, isEnded: () => false };
  });
  const builder = {
    onApplied(cb: () => void) { applied = cb; return builder; },
    onError(cb: () => void) { subscriptionError = cb; return builder; },
    subscribe,
  };
  const conn = {
    db: { myBoardCreations: { iter: () => rows.values(), onInsert: (cb: () => void) => listeners.add(cb), removeOnInsert: (cb: () => void) => listeners.delete(cb) } },
    subscriptionBuilder: () => builder,
    reducers: { createRequestedBoard },
  };
  vi.mocked(stdb.getConn).mockReturnValue(conn as never);
  return { createRequestedBoard, publish, unsubscribe, subscribe, listeners, apply: () => applied(), failSubscription: () => subscriptionError() };
}

beforeEach(() => {
  h.url = new URL('http://localhost/dashboard');
  vi.stubGlobal('location', { ...window.location, assign: h.navigate });
  h.navigate.mockReset();
  resetWorkspaces();
  h.config.accounts = undefined;
  boards.set([DEMO, PAYMENTS]);
  histories.set([]);
  versions.set([]);
  links.set([]);
  grants.set([]);
  state.set({ status: 'live' });
  ident.set('aa'.repeat(32));
  session.set({ status: 'signed-out' });
  vi.mocked(stdb.getConn).mockReset();
  feed.set({ events: [] });
});
afterEach(() => vi.unstubAllGlobals());

describe('dashboard page', () => {
  it('keeps unfinished repository import actions out of the demo', () => {
    render(Page);
    expect(screen.queryByRole('button', { name: /import repository/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'new board' })).toBeEnabled();
  });

  it('shows existing architecture history progress without unfinished retry actions', async () => {
    histories.set([{ id: 7n, name: 'payments history', repository: 'https://github.com/acme/payments', refsJson: JSON.stringify([{ ref: 'main', sha: 'a'.repeat(40) }]), status: 'failed', error: 'The runner was unavailable.' }]);
    render(Page);
    expect(screen.getByText('payments history')).toBeInTheDocument();
    expect(screen.getByText('The runner was unavailable.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /retry/ })).toBeNull();
    histories.set([{ id: 7n, name: 'payments history', repository: 'https://github.com/acme/payments', refsJson: '[]', status: 'running', error: '' }]);
    expect(await screen.findByText('Importing…')).toBeInTheDocument();
  });

  it('labels proposals and excludes their evidence from factual health totals', () => {
    versions.set([{ boardId: 1n, historyId: 7n, index: 0, assertionMode: 'intent', ref: 'main', sha: 'a'.repeat(40), status: 'draft' }]);
    render(Page);
    expect(screen.getByText('intent')).toBeInTheDocument();
    expect(screen.queryByText(/proven/)).toBeNull();
  });

  it('lists live boards with real counts and canvas links without internal ticket language', () => {
    render(Page);
    expect(screen.getByRole('heading', { name: 'Boards' })).toBeInTheDocument();
    expect(screen.getByText('2 boards')).toBeInTheDocument();
    expect(screen.queryByText(/RC-529|not access control/)).toBeNull();
    expect(screen.getByRole('link', { name: 'Demo' })).toHaveAttribute(
      'href',
      `http://localhost:5173/?db=redcrayon-test#b=${slugOf(1n)}`
    );
    expect(screen.queryByText(/proven/)).toBeNull();
  });

  it('opens a board in the inspector, swaps the activity feed out, and closes on Escape', async () => {
    render(Page);
    expect(screen.getByRole('heading', { name: 'Activity' })).toBeInTheDocument();
    expect(screen.queryByTestId('board-card')).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Details for payments' }));
    expect(screen.getByRole('button', { name: 'Details for payments', pressed: true })).toBeInTheDocument();
    expect(screen.getByTestId('board-card')).toHaveTextContent('payments');
    expect(screen.queryByRole('heading', { name: 'Activity' })).toBeNull();
    await fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('board-card')).toBeNull();
  });

  it('opens a board in the canvas on double-click of its tile', async () => {
    render(Page);
    await fireEvent.dblClick(screen.getByRole('button', { name: 'Details for payments' }));
    expect(h.navigate).toHaveBeenCalledWith(`http://localhost:5173/?db=redcrayon-test#b=${slugOf(2n)}`);
  });

  it('keeps a chosen board open while the first identity arrives, and closes it for another account', async () => {
    ident.set('');
    render(Page);
    await fireEvent.click(screen.getByRole('button', { name: 'Details for payments' }));
    ident.set('aa'.repeat(32));
    await tick();
    expect(screen.getByTestId('board-card')).toHaveTextContent('payments');
    ident.set('bb'.repeat(32));
    await tick();
    expect(screen.queryByTestId('board-card')).toBeNull();
  });

  it('lists agent sessions checkpointed in the last hour above the gallery', () => {
    const now = BigInt(Date.now()) * 1000n;
    boards.set([
      myBoard({ boardId: 5n, name: 'agent work', isSession: true, sessionCheckpoint: 4, sessionUpdatedAt: new Timestamp(now - 120_000_000n) }),
      myBoard({ boardId: 6n, name: 'old session', isSession: true, sessionCheckpoint: 2, sessionUpdatedAt: new Timestamp(now - 7_200_000_000n) }),
    ]);
    render(Page);
    const sessions = screen.getByRole('region', { name: 'Agent sessions' });
    expect(sessions).toHaveTextContent('agent work');
    expect(sessions).toHaveTextContent('checkpoint 4 · 2m ago');
    expect(sessions).not.toHaveTextContent('old session');
  });

  it('drops a session from the strip once its last checkpoint passes an hour, without new data', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    const now = BigInt(Date.now()) * 1000n;
    boards.set([myBoard({ boardId: 5n, name: 'agent work', isSession: true, sessionCheckpoint: 4, sessionUpdatedAt: new Timestamp(now - 58n * 60_000_000n) })]);
    render(Page);
    expect(screen.getByRole('region', { name: 'Agent sessions' })).toHaveTextContent('agent work');
    vi.advanceTimersByTime(3 * 60_000);
    await tick();
    expect(screen.queryByRole('region', { name: 'Agent sessions' })).toBeNull();
    vi.useRealTimers();
  });

  it('exposes the active sort to assistive tech', async () => {
    render(Page);
    expect(screen.getByRole('button', { name: 'recent', pressed: true })).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'name', pressed: false }));
    expect(screen.getByRole('button', { name: 'name', pressed: true })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'recent', pressed: false })).toBeInTheDocument();
  });

  it('filters by search and by access chip', async () => {
    render(Page);
    await fireEvent.input(screen.getByRole('searchbox'), { target: { value: 'pay' } });
    expect(screen.queryByRole('link', { name: 'Demo' })).toBeNull();
    expect(screen.getByRole('link', { name: 'payments' })).toBeInTheDocument();
    await fireEvent.input(screen.getByRole('searchbox'), { target: { value: '' } });
    await fireEvent.click(screen.getByRole('button', { name: /^Public/ }));
    expect(screen.getByRole('link', { name: 'Demo' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'payments' })).toBeNull();
  });

  it('says connecting, then "No boards yet" with a new board button when live and empty', async () => {
    boards.set([]);
    state.set({ status: 'connecting' });
    const { unmount } = render(Page);
    expect(screen.getByText('Connecting…')).toBeInTheDocument();
    unmount();
    state.set({ status: 'live' });
    render(Page);
    expect(screen.getByText('No boards yet.')).toBeInTheDocument();
    const [, inline] = screen.getAllByRole('button', { name: 'new board' });
    await fireEvent.click(inline);
    expect(screen.getByRole('form', { name: 'New board' })).toBeInTheDocument();
  });

  it('keeps the last boards on a lost connection without showing the cause', () => {
    state.set({ status: 'reconnecting', error: 'socket closed' });
    render(Page);
    expect(screen.getByText('Connection lost. Showing the last boards received; retrying…')).toBeInTheDocument();
    expect(screen.queryByText(/socket closed/)).toBeNull();
    expect(screen.getByRole('link', { name: 'Demo' })).toBeInTheDocument();
  });

  it('names the search that matched nothing and clears it', async () => {
    render(Page);
    await fireEvent.input(screen.getByRole('searchbox'), { target: { value: 'zzz' } });
    expect(screen.getByText('No boards match “zzz”.')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'clear search' }));
    expect(screen.getByRole('link', { name: 'Demo' })).toBeInTheDocument();
  });

  it('shows the error sentence with a reload button', () => {
    state.set({
      status: 'error',
      error: 'The board server is older than this dashboard. Deploy the latest server, then reload.',
    });
    render(Page);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The board server is older than this dashboard. Deploy the latest server, then reload.'
    );
    expect(screen.getByRole('button', { name: 'reload' })).toBeInTheDocument();
  });

  it('asks a signed-out account user to sign in', () => {
    h.config.accounts = 'issuer_x';
    boards.set([]);
    state.set({ status: 'idle' });
    render(Page);
    expect(screen.getByText('Sign in to see your boards.')).toBeInTheDocument();
  });

  it('renders the live activity feed and follows it without a reload', async () => {
    feed.set({ events: [activityEvent({ boardId: '1', count: 3, actorName: 'redcrayon-agent', actorKind: 'agent' })] });
    render(Page);
    expect(screen.getByText(/added 3 nodes to/).closest('p')).toHaveTextContent('added 3 nodes to Demo');
    feed.set({ events: [activityEvent({ id: '2', boardId: '2', type: 'board.created' }), activityEvent({ boardId: '1', count: 3 })] });
    await tick();
    expect(screen.getByText(/created/).closest('p')).toHaveTextContent('maya created payments');
  });

  it('narrows the feed to the boards of the workspace the page shows', async () => {
    myWorkspaces.set([{ id: 4n, name: 'Acme', personal: false, role: 'member', createdAt: DEMO.updatedAt }]);
    boardPermissions.set(new Map([[2n, { boardId: 2n, workspaceId: 4n, role: 'editor', defaultRole: 'none', canEdit: true, canManage: false }]]));
    h.url = new URL('http://localhost/dashboard?workspace=4');
    feed.set({ events: [activityEvent({ id: '1', boardId: '1', payload: { label: 'Demo node' } }), activityEvent({ id: '2', boardId: '2', payload: { label: 'Payments node' } })] });
    render(Page);
    expect(screen.getByText(/Payments node/)).toBeInTheDocument();
    expect(screen.queryByText(/Demo node/)).toBeNull();
  });

  it('shows the activity sentence in place', () => {
    feed.set({ error: 'Activity needs the latest board server. Update the server and reload.' });
    render(Page);
    expect(screen.getByText('Activity needs the latest board server. Update the server and reload.')).toBeInTheDocument();
  });

  it('opens a created personal board in the configured canvas and database', async () => {
    const connection = creationConnection(async (_args, publish) => {
      boards.update((rows) => [...rows, myBoard({ boardId: 3n, name: 'fresh' })]);
      publish(3n);
    });
    render(Page);
    await fireEvent.click(screen.getByRole('button', { name: 'new board' }));
    await fireEvent.input(screen.getByLabelText('Name'), { target: { value: ' fresh ' } });
    await fireEvent.submit(screen.getByRole('form', { name: 'New board' }));
    expect(connection.createRequestedBoard).toHaveBeenCalledWith({ name: 'fresh', orgId: '', requestKey: expect.stringMatching(/^[a-f0-9-]{36}$/) });
    await vi.waitFor(() => expect(h.navigate).toHaveBeenCalledWith(`http://localhost:5173/?db=redcrayon-test#b=${slugOf(3n)}`));
    expect(await screen.findByRole('link', { name: 'Open in canvas' })).toHaveAttribute(
      'href',
      `http://localhost:5173/?db=redcrayon-test#b=${slugOf(3n)}`
    );
    expect(screen.getByRole('button', { name: 'Details for fresh' }).closest('article')).toHaveClass('highlight');
    const key = connection.createRequestedBoard.mock.calls[0][0].requestKey;
    expect(connection.subscribe).toHaveBeenCalledWith([`SELECT * FROM my_board_creations WHERE request_key = '${key}'`]);
    expect(connection.unsubscribe).toHaveBeenCalledOnce();
    expect(connection.listeners.size).toBe(0);
  });

  it('waits for its request record, even when another tab publishes a same-name board first', async () => {
    const connection = creationConnection(async () => {
      boards.update((rows) => [...rows, myBoard({ boardId: 3n, name: 'fresh' })]);
    });
    render(Page);
    await fireEvent.click(screen.getByRole('button', { name: 'new board' }));
    await fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'fresh' } });
    await fireEvent.submit(screen.getByRole('form', { name: 'New board' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.navigate).not.toHaveBeenCalled();
    const key = connection.createRequestedBoard.mock.calls[0][0].requestKey;
    connection.publish('another-request', 3n);
    await tick();
    expect(h.navigate).not.toHaveBeenCalled();
    connection.publish(key, 4n);
    await vi.waitFor(() => expect(h.navigate).toHaveBeenCalledWith(`http://localhost:5173/?db=redcrayon-test#b=${slugOf(4n)}`));
    expect(screen.queryByRole('link', { name: 'fresh' })).toHaveAttribute('href', `http://localhost:5173/?db=redcrayon-test#b=${slugOf(3n)}`);
    boards.update((rows) => rows.map((b) => ({ ...b, shownNodes: 1 })));
    await tick();
    expect(h.navigate).toHaveBeenCalledTimes(1);
  });

  it('opens the matching request id when two new owned boards have the same name', async () => {
    const connection = creationConnection(async (_args, publish) => {
      boards.update((rows) => [...rows,
        myBoard({ boardId: 3n, name: 'fresh', access: 'owner' }),
        myBoard({ boardId: 4n, name: 'fresh', access: 'owner' }),
      ]);
      publish(4n);
    });
    render(Page);
    await fireEvent.click(screen.getByRole('button', { name: 'new board' }));
    await fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'fresh' } });
    await fireEvent.submit(screen.getByRole('form', { name: 'New board' }));
    await vi.waitFor(() => expect(h.navigate).toHaveBeenCalledWith(`http://localhost:5173/?db=redcrayon-test#b=${slugOf(4n)}`));
    expect(connection.unsubscribe).toHaveBeenCalledOnce();
  });

  it('does not open a board after its creating account has changed', async () => {
    let finish!: () => void;
    const connection = creationConnection((_args, publish) => new Promise<void>((resolve) => {
      finish = () => { publish(3n); resolve(); };
    }));
    render(Page);
    await fireEvent.click(screen.getByRole('button', { name: 'new board' }));
    await fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'fresh' } });
    await fireEvent.submit(screen.getByRole('form', { name: 'New board' }));
    ident.set('bb'.repeat(32));
    boards.set([myBoard({ boardId: 3n, name: 'fresh' })]);
    await tick();
    finish();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.navigate).not.toHaveBeenCalled();
    expect(connection.unsubscribe).toHaveBeenCalledOnce();
  });

  it('renames and deletes an owned manual board through its reducers', async () => {
    const renameBoard = vi.fn(async () => {});
    const deleteBoard = vi.fn(async () => {});
    vi.mocked(stdb.getConn).mockReturnValue({ reducers: { renameBoard, deleteBoard } } as never);
    render(Page);
    await fireEvent.click(screen.getByRole('button', { name: 'Details for payments' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Rename payments' }));
    await fireEvent.input(screen.getByLabelText('Board name'), { target: { value: ' updated payments ' } });
    await fireEvent.submit(screen.getByRole('form', { name: 'Rename payments' }));
    expect(renameBoard).toHaveBeenCalledWith({ boardId: 2n, name: 'updated payments' });
    await fireEvent.click(screen.getByRole('button', { name: 'Delete payments' }));
    await fireEvent.input(screen.getByLabelText('Board name to confirm deletion'), { target: { value: 'payments' } });
    await fireEvent.submit(screen.getByRole('form', { name: 'Delete payments' }));
    expect(deleteBoard).toHaveBeenCalledWith({ boardId: 2n });
  });

  it('shows board creation reducer errors verbatim', async () => {
    session.set({ status: 'signed-in', displayName: 'Maya', userId: 'user_1' });
    const connection = creationConnection(async () => {
      throw new Error('This account cannot create a board.');
    });
    render(Page);
    await fireEvent.click(screen.getByRole('button', { name: 'new board' }));
    await fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'infra' } });
    await fireEvent.submit(screen.getByRole('form', { name: 'New board' }));
    expect(connection.createRequestedBoard).toHaveBeenCalledWith({ name: 'infra', orgId: '', requestKey: expect.stringMatching(/^[a-f0-9-]{36}$/) });
    expect(
      await screen.findByText('This account cannot create a board.')
    ).toBeInTheDocument();
    expect(connection.unsubscribe).toHaveBeenCalledOnce();
    expect(connection.listeners.size).toBe(0);
  });

  it('gives up on a create the database never answers after 15 s and frees the dialog', async () => {
    vi.useFakeTimers();
    const connection = creationConnection(() => new Promise<void>(() => {})); // socket dropped mid-call
    render(Page);
    await fireEvent.click(screen.getByRole('button', { name: 'new board' }));
    await fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'fresh' } });
    await fireEvent.submit(screen.getByRole('form', { name: 'New board' }));
    expect(screen.getByRole('button', { name: 'create' })).toBeDisabled();
    await vi.advanceTimersByTimeAsync(15_000);
    vi.useRealTimers();
    expect(
      await screen.findByText('The database did not answer in 15 seconds. Check your connection and try again.')
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'create' })).toBeEnabled();
    expect(connection.unsubscribe).toHaveBeenCalledOnce();
    expect(connection.listeners.size).toBe(0);
  });

  it('times out and cleans up when creation commits but its request row never arrives', async () => {
    vi.useFakeTimers();
    const connection = creationConnection(async () => {});
    render(Page);
    await fireEvent.click(screen.getByRole('button', { name: 'new board' }));
    await fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'fresh' } });
    await fireEvent.submit(screen.getByRole('form', { name: 'New board' }));
    await vi.advanceTimersByTimeAsync(15_000);
    vi.useRealTimers();
    expect(await screen.findByRole('alert')).toHaveTextContent('The database did not answer in 15 seconds.');
    expect(connection.unsubscribe).toHaveBeenCalledOnce();
    expect(connection.listeners.size).toBe(0);
    expect(h.navigate).not.toHaveBeenCalled();
  });

  it('never sends a create after a delayed subscription applies past the timeout', async () => {
    vi.useFakeTimers();
    const connection = creationConnection(async () => {}, false);
    render(Page);
    await fireEvent.click(screen.getByRole('button', { name: 'new board' }));
    await fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'fresh' } });
    await fireEvent.submit(screen.getByRole('form', { name: 'New board' }));
    await vi.advanceTimersByTimeAsync(15_000);
    connection.apply();
    vi.useRealTimers();
    expect(connection.createRequestedBoard).not.toHaveBeenCalled();
    expect(connection.unsubscribe).toHaveBeenCalledOnce();
    expect(connection.listeners.size).toBe(0);
  });

  it('waits for reducer commitment even when the matching row arrives first', async () => {
    let finish!: () => void;
    const connection = creationConnection((_args, publish) => new Promise<void>((resolve) => {
      publish(3n);
      finish = resolve;
    }));
    render(Page);
    await fireEvent.click(screen.getByRole('button', { name: 'new board' }));
    await fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'fresh' } });
    await fireEvent.submit(screen.getByRole('form', { name: 'New board' }));
    expect(h.navigate).not.toHaveBeenCalled();
    finish();
    await vi.waitFor(() => expect(h.navigate).toHaveBeenCalledWith(`http://localhost:5173/?db=redcrayon-test#b=${slugOf(3n)}`));
    expect(connection.unsubscribe).toHaveBeenCalledOnce();
  });

  it('lets owners remove an existing legacy organization share', async () => {
    boards.set([myBoard({ ...PAYMENTS, sharedWith: ['org_1'] })]);
    const unshareBoardFromTeam = vi.fn(async (_a: { boardId: bigint; orgId: string }) => {});
    vi.mocked(stdb.getConn).mockReturnValue({ reducers: { unshareBoardFromTeam } } as never);
    render(Page);
    await fireEvent.click(screen.getByRole('button', { name: 'Details for payments' }));
    await fireEvent.click(screen.getByText('unshare from team org_1'));
    expect(unshareBoardFromTeam).toHaveBeenCalledWith({ boardId: 2n, orgId: 'org_1' });
  });

  it('lets owners share a board by link with a fresh token, and stop', async () => {
    session.set({ status: 'signed-in', displayName: 'Maya', userId: 'user_1' });
    const setLinkShare = vi.fn(async (_a: { boardId: bigint; mode: string; token: string }) => {});
    const stopLinkShare = vi.fn(async (_a: { boardId: bigint }) => {});
    vi.mocked(stdb.getConn).mockReturnValue({ reducers: { setLinkShare, stopLinkShare } } as never);
    render(Page);
    await fireEvent.click(screen.getByRole('button', { name: 'Details for payments' }));
    await fireEvent.click(screen.getByText('turn on link sharing'));
    expect(setLinkShare).toHaveBeenCalledWith({ boardId: 2n, mode: 'view', token: expect.stringMatching(/^[0-9a-f]{32}$/) });
  });

  it('lets owners share a board with a linked agent and take it back', async () => {
    const AGENT = 'bb'.repeat(32);
    links.set([agentLink(AGENT, 'aa'.repeat(32))]);
    const grantAgentBoard = vi.fn(async (_a: { boardId: bigint; agent: Identity }) => {});
    const revokeAgentBoard = vi.fn(async (_a: { boardId: bigint; agent: Identity }) => {});
    vi.mocked(stdb.getConn).mockReturnValue({ reducers: { grantAgentBoard, revokeAgentBoard } } as never);
    render(Page);
    await fireEvent.click(screen.getByRole('button', { name: 'Details for payments' }));
    await fireEvent.click(screen.getByText(`let agent …${AGENT.slice(-8)} edit`));
    expect(grantAgentBoard).toHaveBeenCalledOnce();
    expect(grantAgentBoard.mock.calls[0][0].boardId).toBe(2n);
    expect(grantAgentBoard.mock.calls[0][0].agent.toHexString()).toBe(AGENT);
    grants.set([agentGrantRow(1n, 2n, AGENT)]);
    await fireEvent.click(await screen.findByText(`remove agent …${AGENT.slice(-8)}`));
    expect(revokeAgentBoard.mock.calls[0][0].boardId).toBe(2n);
  });

  it('shows no agent control when the owner has no linked agent', () => {
    render(Page);
    expect(screen.queryByText(/with an agent/)).toBeNull();
  });
});


it('filters by native workspace membership without provider organizations', async () => {
  myWorkspaces.set([{ id: 4n, name: 'Acme', personal: false, role: 'member', createdAt: DEMO.updatedAt }]);
  boardPermissions.set(new Map([[2n, { boardId: 2n, workspaceId: 4n, role: 'editor', defaultRole: 'none', canEdit: true, canManage: false }]]));
  h.url = new URL('http://localhost/dashboard?workspace=4');
  render(Page);
  expect(screen.getByText('1 board in Acme')).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Demo' })).toBeNull();
  expect(screen.getByRole('link', { name: 'payments' })).toBeInTheDocument();
  await fireEvent.click(screen.getByRole('button', { name: 'Details for payments' }));
  expect(screen.queryByRole('button', { name: 'Rename payments' })).toBeNull();
});
