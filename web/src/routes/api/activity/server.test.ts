// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '$env/dynamic/private';
import { connect, type Sql } from '$lib/server/db';
import { GET } from './+server';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const DB = `vitest-${crypto.randomUUID()}`;
const MAYA = 'c200ba442d4987321578a3376323c5fdee07128c22a273ca119f80a80452c038';
const T0 = 1_791_000_000_000_000;
const COLUMNS = ['id', 'board_id', 'type', 'actor', 'actor_name', 'actor_kind', 'at', 'last_at', 'count', 'payload'];
const table = (columns: string[], rows: unknown[][]) =>
  new Response(JSON.stringify([{ schema: { elements: columns.map((c) => ({ name: { some: c } })) }, rows }]));
const outboxRow = (id: number, boardId: number, type = 'node.created') =>
  [id, boardId, type, [`0x${MAYA}`], 'Maya', 'human', [T0 + id * 1_000_000], [T0 + id * 1_000_000], 1, '{}'];

/**
 * Fake SpacetimeDB: my_boards answers for the caller's token (or 401),
 * service_outbox serves `outbox` once (or fails when 'down'), acks succeed.
 */
function stdb(myBoards: number[] | 401, outbox: unknown[][] | 'down' = []) {
  fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
    const auth = (init.headers as Record<string, string>).authorization;
    if (init.body === 'SELECT board_id FROM my_boards') {
      if (auth !== 'Bearer user-tok' || myBoards === 401) return new Response('', { status: 401 });
      return table(['board_id'], myBoards.map((b) => [b]));
    }
    if (auth !== 'Bearer svc' || outbox === 'down') return new Response('boom', { status: 500 });
    if (url.endsWith('/sql')) {
      const rows = outbox;
      outbox = [];
      return table(COLUMNS, rows);
    }
    return new Response(null, { status: 200 });
  });
}

async function get(query = '', token: string | null = 'user-tok') {
  const url = new URL(`http://dash.test/api/activity${query}`);
  const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
  const res = await GET({ request: new Request(url, { headers }), url } as unknown as Parameters<typeof GET>[0]);
  return { status: res.status, body: await res.json() };
}

it('answers 503 with a plain sentence and logs each missing setting for the operator', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const keys = ['DATABASE_URL', 'SPACETIMEDB_URL', 'SPACETIMEDB_DB', 'SPACETIMEDB_SERVICE_TOKEN'];
  const saved = keys.map((k) => env[k]);
  Object.assign(env, { DATABASE_URL: '', SPACETIMEDB_URL: 'http://stdb.test', SPACETIMEDB_DB: 'dash', SPACETIMEDB_SERVICE_TOKEN: '' });
  expect(await get()).toEqual({
    status: 503,
    body: { error: 'Activity is not set up on this deployment yet.' }
  });
  expect(log).toHaveBeenCalledWith(
    JSON.stringify({ event: 'config.missing', missing: ['DATABASE_URL', 'SPACETIMEDB_SERVICE_TOKEN'] })
  );
  log.mockRestore();
  keys.forEach((k, i) => (env[k] = saved[i]));
});

describe.skipIf(!env.DATABASE_URL)('GET /api/activity (local Postgres)', () => {
  let sql: Sql;

  beforeAll(() => {
    sql = connect();
    vi.useFakeTimers({ toFake: ['Date'] });
  });
  beforeEach(async () => {
    vi.setSystemTime(Date.now() + 60_000); // past the read drain throttle
    Object.assign(env, { SPACETIMEDB_URL: 'http://stdb.test', SPACETIMEDB_DB: DB, SPACETIMEDB_SERVICE_TOKEN: 'svc' });
    fetchMock.mockReset();
    await sql`delete from activity_event where db = ${DB}`;
  });
  afterAll(async () => {
    vi.useRealTimers();
    await sql`delete from activity_event where db = ${DB}`;
    await sql.end();
  });

  it('answers 401 without a bearer token', async () => {
    expect(await get('', null)).toEqual({
      status: 401,
      body: { error: 'Sign in again: this request had no session token.' }
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers 400 for a database this deployment does not record, before asking SpacetimeDB', async () => {
    expect(await get('?db=redcrayon')).toEqual({
      status: 400,
      body: {
        error: 'This deployment records activity for one database only; open the dashboard from its usual address.'
      }
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers 401 when SpacetimeDB rejects the caller's token", async () => {
    stdb(401);
    expect(await get()).toEqual({
      status: 401,
      body: { error: 'Your session expired. Reload the page or sign in again.' }
    });
  });

  it("drains, then returns only the caller's boards' events, newest first", async () => {
    stdb([7, 8], [outboxRow(1, 7), outboxRow(2, 9), outboxRow(3, 8), outboxRow(4, 7, 'board.stats')]);
    const { status, body } = await get(`?db=${DB}`);
    expect(status).toBe(200);
    expect(body.events.map((e: { boardId: string }) => e.boardId)).toEqual(['8', '7']);
    expect(body.events[0]).toMatchObject({ type: 'node.created', actor: MAYA, actorKind: 'human', count: 1 });
  });

  it("overlaps the drain with the caller's board read", async () => {
    stdb([7], [outboxRow(1, 7)]);
    const real = fetchMock.getMockImplementation()!;
    // each request answers only once the other has been sent: a serial handler would hang
    let seen = { boards: () => {}, outbox: () => {} };
    const sent = { boards: new Promise<void>((r) => (seen.boards = r)), outbox: new Promise<void>((r) => (seen.outbox = r)) };
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (init.body === 'SELECT board_id FROM my_boards') {
        seen.boards();
        await sent.outbox;
      } else if (init.body === 'SELECT * FROM service_outbox') {
        seen.outbox();
        await sent.boards;
      }
      return real(url, init);
    });
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body.events.map((e: { boardId: string }) => e.boardId)).toEqual(['7']);
  });

  it('narrows to one allowed board and refuses boards that are not on the dashboard', async () => {
    stdb([7, 8], [outboxRow(1, 7), outboxRow(2, 8)]);
    expect((await get('?board=7')).body.events.map((e: { boardId: string }) => e.boardId)).toEqual(['7']);
    stdb([7, 8]);
    expect(await get('?board=9')).toEqual({ status: 403, body: { error: 'Board 9 is not on your dashboard.' } });
  });

  it('still answers from Postgres when the drain fails', async () => {
    stdb([7], [outboxRow(1, 7)]);
    await get();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    stdb([7], 'down');
    vi.setSystemTime(Date.now() + 60_000);
    const { status, body } = await get('?limit=5');
    expect(status).toBe(200);
    expect(body.events).toHaveLength(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"event":"activity.drain_failed","entryPoint":"activity_read"'));
    log.mockRestore();
  });

  it('drains on read at most once per 10 s, however many reads arrive', async () => {
    // reads of service_outbox since the last call
    const outboxReads = () => {
      const n = fetchMock.mock.calls.filter(([, init]) => init.body === 'SELECT * FROM service_outbox').length;
      fetchMock.mockClear();
      return n;
    };
    stdb([7], [outboxRow(1, 7)]);
    await get();
    expect(outboxReads()).toBeGreaterThan(0);
    stdb([7], [outboxRow(2, 7)]);
    expect((await get()).body.events).toHaveLength(1);
    expect(outboxReads()).toBe(0);
    vi.setSystemTime(Date.now() + 10_000);
    expect((await get()).body.events).toHaveLength(2);
    expect(outboxReads()).toBeGreaterThan(0);
  });
});
