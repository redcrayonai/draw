import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { get } from 'svelte/store';
import { Identity, Timestamp } from 'spacetimedb';
import { myBoard } from './test-rows';

const h = vi.hoisted(() => ({
  config: {
    spacetimeUri: 'ws://127.0.0.1:3100',
    spacetimeDb: 'redcrayon-test',
    canvasUrl: 'http://localhost:5173',
    accounts: undefined as string | undefined,
  },
}));
vi.mock('./config', () => ({ config: h.config }));

import {
  ANON_TOKEN_KEY,
  apiToken,
  connectAs,
  disconnect,
  getConn,
  identityHex,
  joinAs,
  myAgentGrants,
  myAgentLinks,
  myBoards,
  myCodeConsent,
  myActivity,
  myArchitectureHistories,
  architectureVersions,
  boardSlugs,
  clearCachedRows,
  stdbState,
  type TokenSource,
} from './stdb';

type Cb = (...args: any[]) => void;

class FakeTable {
  rows: unknown[] = [];
  cbs = { insert: [] as Cb[], delete: [] as Cb[], update: [] as Cb[] };
  iter() {
    return this.rows[Symbol.iterator]();
  }
  onInsert(cb: Cb) {
    this.cbs.insert.push(cb);
  }
  onDelete(cb: Cb) {
    this.cbs.delete.push(cb);
  }
  onUpdate(cb: Cb) {
    this.cbs.update.push(cb);
  }
  /** the server changed rows: replace the cache, fire one kind of callback */
  emit(kind: 'insert' | 'delete' | 'update', rows: unknown[]) {
    this.rows = rows;
    for (const cb of this.cbs[kind]) cb();
  }
}

class FakeConn {
  db = { myBoards: new FakeTable(), myAgentLinks: new FakeTable(), myAgentGrants: new FakeTable(), myArchitectureHistories: new FakeTable(), visibleArchitectureVersion: new FakeTable(), myBoardSlugs: new FakeTable(), myCodeConsent: new FakeTable(), myActivity: new FakeTable() };
  queries: string[] = [];
  applied?: Cb;
  subError?: Cb;
  /** every subscription; queries/applied/subError above hold the last one (the boards) */
  subs: { queries: string[]; applied?: Cb; error?: Cb }[] = [];
  disconnect = vi.fn();
  reducers = { joinBoard: vi.fn(async (_: { displayName: string; kind: string }) => {}) };
  subscriptionBuilder() {
    return new FakeSub(this);
  }
}

class FakeSub {
  private applied?: Cb;
  private error?: Cb;
  constructor(private c: FakeConn) {}
  onApplied(cb: Cb) {
    this.applied = cb;
    return this;
  }
  onError(cb: Cb) {
    this.error = cb;
    return this;
  }
  subscribe(q: string[]) {
    this.c.subs.push({ queries: q, applied: this.applied, error: this.error });
    this.c.queries = q;
    this.c.applied = this.applied;
    this.c.subError = this.error;
    return {};
  }
}

class FakeBuilder {
  conn = new FakeConn();
  uri = '';
  db = '';
  token?: string;
  cb: Record<'connect' | 'connectError' | 'disconnect', Cb> = {
    connect: () => {},
    connectError: () => {},
    disconnect: () => {},
  };
  withUri(u: string) {
    this.uri = u;
    return this;
  }
  withDatabaseName(d: string) {
    this.db = d;
    return this;
  }
  withToken(t: string) {
    this.token = t;
    return this;
  }
  onConnect(f: Cb) {
    this.cb.connect = f;
    return this;
  }
  onConnectError(f: Cb) {
    this.cb.connectError = f;
    return this;
  }
  onDisconnect(f: Cb) {
    this.cb.disconnect = f;
    return this;
  }
  build() {
    return this.conn;
  }
  /** the server accepted the socket and the subscription applied */
  goLive(hex = 'c200aa', issued = 'issued-token') {
    this.cb.connect(this.conn, { toHexString: () => hex }, issued);
    this.conn.applied?.();
  }
}

let builders: FakeBuilder[] = [];
let cookies = new Map<string, string>();
const cookieKey = `rc_guest_${encodeURIComponent(ANON_TOKEN_KEY)}`;
const deps = {
  builder: () => {
    const b = new FakeBuilder();
    builders.push(b);
    return b as never;
  },
};
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

beforeEach(() => {
  h.config.accounts = undefined;
  cookies = new Map();
  vi.spyOn(document, 'cookie', 'get').mockImplementation(() => [...cookies].map(([key, value]) => `${key}=${value}`).join('; '));
  vi.spyOn(document, 'cookie', 'set').mockImplementation((value) => {
    const [pair] = value.split(';');
    const index = pair.indexOf('=');
    const key = pair.slice(0, index);
    if (value.includes('Max-Age=0')) cookies.delete(key);
    else cookies.set(key, pair.slice(index + 1));
  });
  builders = [];
  localStorage.clear();
  disconnect();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('stdb connection store', () => {
  it('uses the shared local guest cookie before a token stored by another port', async () => {
    localStorage.setItem(ANON_TOKEN_KEY, 'old-local-token');
    cookies.set(cookieKey, encodeURIComponent('shared-local-token'));
    connectAs('anon', async () => undefined, deps);
    await flush();
    expect(builders[0].token).toBe('shared-local-token');
    expect(await apiToken()).toBe('shared-local-token');
    builders[0].goLive('aa', 'updated-token');
    expect(localStorage.getItem(ANON_TOKEN_KEY)).toBe('updated-token');
    expect(cookies.get(cookieKey)).toBe('updated-token');
  });

  it.each(['remote host', 'accounts configured', 'production'])('does not share anonymous tokens when %s', async (mode) => {
    if (mode === 'remote host') vi.stubGlobal('location', { ...window.location, hostname: 'redcrayon.example' });
    if (mode === 'accounts configured') h.config.accounts = 'issuer_configured';
    if (mode === 'production') vi.stubEnv('DEV', false);
    cookies.set(cookieKey, 'shared-local-token');
    localStorage.setItem(ANON_TOKEN_KEY, 'local-token');
    connectAs('anon', async () => undefined, deps);
    await flush();
    expect(builders[0].token).toBe('local-token');
    builders[0].goLive('aa', 'updated-token');
    expect(localStorage.getItem(ANON_TOKEN_KEY)).toBe('updated-token');
    expect(cookies.get(cookieKey)).toBe('shared-local-token');
  });

  it('clears a stale shared guest cookie after two verification failures', async () => {
    vi.useFakeTimers();
    cookies.set(cookieKey, 'stale-token');
    connectAs('anon', async () => undefined, deps);
    await flush();
    expect(builders[0].token).toBe('stale-token');
    builders[0].cb.connectError(builders[0].conn, new Error('Failed to verify token'));
    expect(cookies.get(cookieKey)).toBe('stale-token');
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    builders[1].cb.connectError(builders[1].conn, new Error('Failed to verify token'));
    expect(cookies.has(cookieKey)).toBe(false);
    expect(localStorage.getItem(ANON_TOKEN_KEY)).toBeNull();
  });

  it('connects with a fresh token, subscribes only to caller views, and goes live', async () => {
    const tokens = vi.fn<TokenSource>(async () => 'account-1');
    connectAs('account:u1', tokens, deps);
    expect(get(stdbState).status).toBe('connecting');
    await flush();
    const b = builders[0];
    expect(b.uri).toBe('ws://127.0.0.1:3100');
    expect(b.db).toBe('redcrayon-test');
    expect(b.token).toBe('account-1');
    b.conn.db.myBoards.rows = [{ boardId: 1n, name: 'Demo' }];
    b.goLive('c200aa');
    expect(b.conn.queries).toEqual(['SELECT * FROM my_boards', 'SELECT * FROM my_agent_links', 'SELECT * FROM my_agent_grants', 'SELECT * FROM my_architecture_histories', 'SELECT * FROM visible_architecture_version', 'SELECT * FROM my_board_slugs', 'SELECT * FROM my_code_consent']);
    expect(get(stdbState)).toEqual({ status: 'live' });
    expect(get(identityHex)).toBe('c200aa');
    expect(get(myBoards)).toEqual([{ boardId: 1n, name: 'Demo' }]);
    expect(getConn()).toBe(b.conn);
  });

  it('keeps the socket when connectAs repeats the same account key', async () => {
    connectAs('account:u1', async () => 't', deps);
    connectAs('account:u1', async () => 't', deps);
    await flush();
    expect(builders).toHaveLength(1);
  });

  it('resyncs both stores on insert, update and delete', async () => {
    connectAs('anon', async () => undefined, deps);
    await flush();
    const b = builders[0];
    b.goLive();
    b.conn.db.myBoards.emit('insert', [{ boardId: 1n, nodes: 0 }]);
    await flush();
    expect(get(myBoards)).toEqual([{ boardId: 1n, nodes: 0 }]);
    b.conn.db.myBoards.emit('update', [{ boardId: 1n, nodes: 3 }]);
    await flush();
    expect(get(myBoards)).toEqual([{ boardId: 1n, nodes: 3 }]);
    b.conn.db.myAgentLinks.emit('insert', [{ agent: 'a' }]);
    await flush();
    expect(get(myAgentLinks)).toEqual([{ agent: 'a' }]);
    b.conn.db.myBoards.emit('delete', []);
    await flush();
    expect(get(myBoards)).toEqual([]);
  });

  it('rebuilds once for a burst of row callbacks in one transaction', async () => {
    connectAs('anon', async () => undefined, deps);
    await flush();
    const b = builders[0];
    b.goLive();
    const iter = vi.spyOn(b.conn.db.myBoards, 'iter');
    for (let i = 1; i <= 100; i++) b.conn.db.myBoards.emit('insert', Array.from({ length: i }, (_, n) => ({ boardId: BigInt(n) })));
    expect(iter).not.toHaveBeenCalled();
    await flush();
    expect(iter).toHaveBeenCalledTimes(1);
    expect(get(myBoards)).toHaveLength(100);
  });

  it('subscribes to the grants of the caller and clears them on account change', async () => {
    connectAs('account:a', async () => 't', deps);
    await flush();
    const b = builders[0];
    b.goLive();
    expect(b.conn.queries).toContain('SELECT * FROM my_agent_grants');
    b.conn.db.myAgentGrants.emit('insert', [{ id: 1n, boardId: 2n }]);
    await flush();
    expect(get(myAgentGrants)).toEqual([{ id: 1n, boardId: 2n }]);
    disconnect();
    expect(get(myAgentGrants)).toEqual([]);
  });

  it('keeps each board\'s link id from my_board_slugs, and clears them on account change', async () => {
    connectAs('account:a', async () => 't', deps);
    await flush();
    const b = builders[0];
    b.goLive();
    b.conn.db.myBoardSlugs.emit('insert', [{ boardId: 3n, slug: 'c4bb879c7355360696d9' }]);
    await flush();
    expect(get(boardSlugs)).toEqual(new Map([[3n, 'c4bb879c7355360696d9']]));
    disconnect();
    expect(get(boardSlugs)).toEqual(new Map());
  });

  it('keeps the caller\'s code consent from my_code_consent, and clears it on account change', async () => {
    connectAs('account:a', async () => 't', deps);
    await flush();
    const b = builders[0];
    b.conn.db.myCodeConsent.rows = [{ storeCode: false, boardsWithCode: 0 }];
    b.goLive();
    expect(get(myCodeConsent)).toEqual({ storeCode: false, boardsWithCode: 0 });
    b.conn.db.myCodeConsent.emit('update', [{ storeCode: true, boardsWithCode: 3 }]);
    await flush();
    expect(get(myCodeConsent)).toEqual({ storeCode: true, boardsWithCode: 3 });
    b.conn.db.myCodeConsent.emit('delete', []);
    await flush();
    expect(get(myCodeConsent)).toBeNull();
    b.conn.db.myCodeConsent.emit('insert', [{ storeCode: true, boardsWithCode: 1 }]);
    await flush();
    disconnect();
    expect(get(myCodeConsent)).toBeNull();
  });

  it('keeps the live activity feed from my_activity, newest first, and clears it on account change', async () => {
    const row = (id: number, minute: number, payload = '{"label":"API"}') => ({
      id: BigInt(id), boardId: 7n, type: 'node.created', actor: new Identity('ab'.repeat(32)), actorName: 'maya', actorKind: 'human',
      at: new Timestamp(BigInt(minute) * 60_000_000n), lastAt: new Timestamp(BigInt(minute) * 60_000_000n), count: 1, payload,
    });
    connectAs('account:a', async () => 't', deps);
    await flush();
    const b = builders[0];
    b.goLive();
    const feed = b.conn.subs.find((s) => s.queries.includes('SELECT * FROM my_activity'))!;
    expect(b.conn.queries).not.toContain('SELECT * FROM my_activity'); // its own subscription
    expect(get(myActivity)).toBeNull();
    b.conn.db.myActivity.rows = [row(1, 10), row(2, 30, 'not json')];
    feed.applied!();
    expect(get(myActivity)).toEqual({ events: [
      expect.objectContaining({ id: '2', boardId: '7', actor: 'ab'.repeat(32), payload: {} }),
      expect.objectContaining({ id: '1', payload: { label: 'API' }, lastAt: new Date(10 * 60_000).toISOString() }),
    ] });
    b.conn.db.myActivity.emit('update', [row(1, 50), row(2, 30)]); // a burst on row 1 moved it forward
    await flush();
    expect((get(myActivity) as { events: { id: string }[] }).events.map((e) => e.id)).toEqual(['1', '2']);
    disconnect();
    expect(get(myActivity)).toBeNull();
  });

  it('says activity needs a newer board server when my_activity is missing, and keeps the boards live', async () => {
    connectAs('account:a', async () => 't', deps);
    await flush();
    const b = builders[0];
    b.goLive();
    b.conn.subs.find((s) => s.queries.includes('SELECT * FROM my_activity'))!.error!();
    expect(get(myActivity)).toEqual({ error: 'Activity needs the latest board server. Update the server and reload.' });
    expect(get(stdbState)).toEqual({ status: 'live' });
  });

  it('subscribes to import progress and assertion modes, then clears them on account change', async () => {
    connectAs('account:a', async () => 't', deps);
    await flush();
    const b = builders[0];
    b.goLive();
    b.conn.db.myArchitectureHistories.emit('insert', [{ id: 7n, status: 'running' }]);
    b.conn.db.visibleArchitectureVersion.emit('insert', [{ boardId: 3n, assertionMode: 'intent' }]);
    await flush();
    expect(get(myArchitectureHistories)).toEqual([{ id: 7n, status: 'running' }]);
    expect(get(architectureVersions)).toEqual([{ boardId: 3n, assertionMode: 'intent' }]);
    connectAs('account:b', async () => 'other', deps);
    expect(get(myArchitectureHistories)).toEqual([]);
    expect(get(architectureVersions)).toEqual([]);
    b.conn.db.myArchitectureHistories.emit('update', [{ id: 7n, status: 'ready' }]);
    await flush();
    expect(get(myArchitectureHistories)).toEqual([]);
  });

  it('ignores every callback from a replaced connection', async () => {
    connectAs('account:a', async () => 'ta', deps);
    await flush();
    const old = builders[0];
    connectAs('account:b', async () => 'tb', deps);
    await flush();
    expect(old.conn.disconnect).toHaveBeenCalledTimes(1);
    old.conn.db.myBoards.rows = [{ boardId: 9n }];
    old.goLive('aaaaaa'); // late onConnect from A's socket
    expect(old.conn.disconnect).toHaveBeenCalledTimes(2);
    expect(get(myBoards)).toEqual([]);
    expect(get(identityHex)).toBe('');
    builders[1].goLive('bbbbbb');
    expect(get(identityHex)).toBe('bbbbbb');
  });

  it('drops a token that resolves after the account changed', async () => {
    let release!: (t: string) => void;
    connectAs('account:a', () => new Promise<string>((r) => (release = r)), deps);
    connectAs('account:b', async () => 'tb', deps);
    await flush();
    release('ta');
    await flush();
    expect(builders.map((b) => b.token)).toEqual(['tb']);
  });

  it('disconnect clears rows and state synchronously', async () => {
    connectAs('anon', async () => undefined, deps);
    await flush();
    builders[0].conn.db.myBoards.rows = [{ boardId: 1n }];
    builders[0].goLive();
    disconnect();
    expect(get(myBoards)).toEqual([]);
    expect(get(stdbState)).toEqual({ status: 'idle' });
    expect(getConn()).toBeNull();
    expect(builders[0].conn.disconnect).toHaveBeenCalled();
  });

  it('a null token (signed out) never builds a connection', async () => {
    connectAs('account:a', async () => null, deps);
    await flush();
    expect(builders).toHaveLength(0);
    expect(get(stdbState)).toEqual({ status: 'idle' });
  });

  it('anonymous mode saves the issued token under the canvas key shape and reuses it', async () => {
    expect(ANON_TOKEN_KEY).toBe('stdb_token:ws://127.0.0.1:3100/redcrayon-test');
    connectAs('anon', async () => undefined, deps);
    await flush();
    expect(builders[0].token).toBeUndefined();
    builders[0].goLive('aaaaaa', 'anon-issued');
    expect(localStorage.getItem(ANON_TOKEN_KEY)).toBe('anon-issued');
    disconnect();
    connectAs('anon', async () => undefined, deps);
    await flush();
    expect(builders[1].token).toBe('anon-issued');
  });

  it('never persists a token for an account connection', async () => {
    connectAs('account:a', async () => 'account-tok', deps);
    await flush();
    builders[0].goLive('aa', 'server-issued');
    const stored = Object.keys(localStorage).map((k) => `${k}=${localStorage.getItem(k)}`).join('\n');
    expect(stored).not.toContain('account-tok');
    expect(stored).not.toContain('server-issued');
  });

  it("paints an account's last rows before its next socket is live, and only for that account", async () => {
    const board = myBoard({ boardId: 7n, name: 'Cached', updatedAt: new Timestamp(1_700_000_000_000_000n) });
    const link = { agent: new Identity(7n), owner: new Identity(8n), linkedAt: new Timestamp(5n) };
    connectAs('account:u1', async () => 't', deps);
    await flush();
    builders[0].conn.db.myBoards.rows = [board];
    builders[0].conn.db.myAgentLinks.rows = [link];
    builders[0].goLive();
    disconnect();

    connectAs('account:u2', async () => 't', deps);
    expect(get(myBoards)).toEqual([]);

    connectAs('account:u1', async () => 't', deps);
    expect(get(stdbState).status).toBe('connecting');
    const [cached] = get(myBoards);
    expect(cached).toEqual(board);
    expect(cached.updatedAt).toBeInstanceOf(Timestamp);
    expect(cached.updatedAt.toDate()).toEqual(board.updatedAt.toDate());
    expect(get(myAgentLinks)[0].agent.toHexString()).toBe(link.agent.toHexString());

    clearCachedRows();
    disconnect();
    connectAs('account:u1', async () => 't', deps);
    expect(get(myBoards)).toEqual([]);
  });

  it('reconnects with backoff and a fresh token, ignoring the twin error callback', async () => {
    vi.useFakeTimers();
    let n = 0;
    connectAs('account:a', async () => `t${++n}`, deps);
    await flush();
    const first = builders[0];
    first.goLive();
    first.cb.disconnect(first.conn, new Error('socket closed'));
    first.cb.connectError(first.conn, new Error('twin'));
    expect(get(stdbState)).toEqual({ status: 'reconnecting', error: 'socket closed' });
    expect(get(identityHex)).toBe('c200aa'); // rows kept while retrying: same identity
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(builders).toHaveLength(2);
    expect(builders[1].token).toBe('t2');
    builders[1].cb.connectError(builders[1].conn, new Error('refused'));
    expect(get(stdbState)).toEqual({ status: 'reconnecting', error: 'refused' });
    builders[1].goLive(); // its connection was already given up: must not go live
    expect(get(stdbState).status).toBe('reconnecting');
  });

  it('backs off min(1000·2^n, 30 s) between failed attempts', async () => {
    vi.useFakeTimers();
    connectAs('account:a', async () => 't', deps);
    await flush();
    for (const ms of [1000, 2000, 4000, 8000, 16_000, 30_000, 30_000]) {
      const n = builders.length;
      builders[n - 1].cb.connectError(builders[n - 1].conn, new Error('refused'));
      await vi.advanceTimersByTimeAsync(ms - 1);
      await flush();
      expect(builders).toHaveLength(n);
      await vi.advanceTimersByTimeAsync(1);
      await flush();
      expect(builders).toHaveLength(n + 1);
    }
  });

  it('turns a WebSocket Event, a fetch TypeError and a verify failure into sentences', async () => {
    vi.useFakeTimers();
    connectAs('account:a', async () => 't', deps);
    await flush();
    const cases: [unknown, string][] = [
      [new Event('error'), 'Cannot reach the board server. Check your connection.'],
      [new TypeError('Failed to fetch'), 'Cannot reach the board server. Check your connection.'],
      [new Error('Failed to verify token: '), 'The board server could not verify your sign-in. Sign in again.'],
    ];
    for (const [i, [err, sentence]] of cases.entries()) {
      builders[i].cb.connectError(builders[i].conn, err);
      expect(get(stdbState)).toEqual({ status: 'reconnecting', error: sentence });
      await vi.advanceTimersByTimeAsync(30_000);
      await flush();
    }
  });

  it('drops a stored anonymous token only after two consecutive verify failures', async () => {
    vi.useFakeTimers();
    localStorage.setItem(ANON_TOKEN_KEY, 'stale');
    connectAs('anon', async () => undefined, deps);
    await flush();
    expect(builders[0].token).toBe('stale');
    builders[0].cb.connectError(builders[0].conn, new Error('Failed to verify token'));
    expect(localStorage.getItem(ANON_TOKEN_KEY)).toBe('stale');
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    builders[1].cb.connectError(builders[1].conn, new Error('Failed to verify token'));
    expect(localStorage.getItem(ANON_TOKEN_KEY)).toBeNull();
  });

  it('maps a missing view (old module) to the deploy sentence, naming no vendor or address', async () => {
    connectAs('anon', async () => undefined, deps);
    await flush();
    const b = builders[0];
    b.cb.connect(b.conn, { toHexString: () => 'aa' }, 'x');
    b.conn.subError?.({
      event: new Error('no such table: `my_boards`. If the table exists, it may be marked private.'),
    });
    expect(get(stdbState)).toEqual({
      status: 'error',
      error: 'The board server is older than this dashboard. Deploy the latest server, then reload.',
    });
  });

  it('logs any other subscription failure and shows a neutral sentence', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    connectAs('anon', async () => undefined, deps);
    await flush();
    const b = builders[0];
    b.cb.connect(b.conn, { toHexString: () => 'aa' }, 'x');
    b.conn.subError?.({ event: new Error('SpacetimeDB internal error at ws://10.0.0.1') });
    expect(get(stdbState)).toEqual({
      status: 'error',
      error: 'The board server could not load your boards. Reload, or try again shortly.',
    });
    expect(log).toHaveBeenCalledWith('my_boards subscription failed:', 'SpacetimeDB internal error at ws://10.0.0.1');
    log.mockRestore();
  });

  it('apiToken: a fresh account token per call, the stored anonymous token, or null', async () => {
    expect(await apiToken()).toBeNull();
    let n = 0;
    connectAs('account:a', async () => `fresh-${++n}`, deps);
    expect(await apiToken()).toBe('fresh-2');
    disconnect();
    localStorage.setItem(ANON_TOKEN_KEY, 'anon-tok');
    connectAs('anon', async () => undefined, deps);
    expect(await apiToken()).toBe('anon-tok');
  });

  it('joinAs names the live account once per connection and name, and never a stale one', async () => {
    vi.useFakeTimers();
    connectAs('account:a', async () => 't', deps);
    await flush();
    joinAs('account:a', 'Maya'); // not live yet
    builders[0].goLive();
    joinAs('account:b', 'Bob'); // the socket still belongs to account a
    joinAs('account:a', '');
    joinAs('account:a', 'Maya');
    joinAs('account:a', 'Maya');
    joinAs('account:a', 'Maya L');
    expect(builders[0].conn.reducers.joinBoard.mock.calls).toEqual([
      [{ displayName: 'Maya', kind: 'human' }],
      [{ displayName: 'Maya L', kind: 'human' }],
    ]);
    builders[0].cb.disconnect(builders[0].conn, new Error('closed'));
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    builders[1].goLive();
    joinAs('account:a', 'Maya L'); // a new connection gets the name again
    expect(builders[1].conn.reducers.joinBoard).toHaveBeenCalledWith({ displayName: 'Maya L', kind: 'human' });
  });
});
