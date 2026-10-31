// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { env } from '$env/dynamic/private';
import { drain, listActivity } from './activity';
import { connect, type Sql } from './db';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const DB = `vitest-${crypto.randomUUID()}`; // isolates these rows from dev data and parallel runs
const MAYA = 'c200ba442d4987321578a3376323c5fdee07128c22a273ca119f80a80452c038';
const AGENT = `c200${'a'.repeat(60)}`;
const T0 = 1_791_000_000_000_000; // microseconds since the Unix epoch
const iso = (seconds: number) => new Date((T0 + seconds * 1_000_000) / 1000).toISOString();

const COLUMNS = ['id', 'board_id', 'type', 'actor', 'actor_name', 'actor_kind', 'at', 'last_at', 'count', 'payload'];

/** One service_outbox row as SpacetimeDB's HTTP SQL encodes it; odd ids use the array cell forms. */
function outboxRow(
  id: number,
  boardId: number,
  type: string,
  o: { actor?: string; actorName?: string; count?: number; lastS?: number; payload?: string } = {}
): unknown[] {
  const actor = `0x${o.actor ?? MAYA}`;
  const at = T0 + id * 1_000_000;
  const lastAt = T0 + (o.lastS ?? id) * 1_000_000;
  return [
    id,
    boardId,
    type,
    id % 2 ? [actor] : { __identity__: actor },
    o.actorName ?? (o.actor === AGENT ? 'claude' : 'Maya'),
    o.actor === AGENT ? 'agent' : 'human',
    id % 2 ? [at] : { __timestamp_micros_since_unix_epoch__: at },
    [lastAt],
    o.count ?? 1,
    o.payload ?? JSON.stringify({ label: `n${id}` })
  ];
}

/** Serve these service_outbox batches in order (then empty ones); return the ack_activity bodies. */
function serveOutbox(batches: unknown[][][]): unknown[] {
  const acks: unknown[] = [];
  fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
    if (url.endsWith('/sql')) {
      const rows = batches.shift() ?? [];
      return new Response(
        JSON.stringify([{ schema: { elements: COLUMNS.map((c) => ({ name: { some: c } })) }, rows }])
      );
    }
    acks.push(JSON.parse(String(init.body)));
    return new Response(null, { status: 200 });
  });
  return acks;
}

describe.skipIf(!env.DATABASE_URL)('activity store (local Postgres)', () => {
  let sql: Sql;

  beforeAll(() => {
    Object.assign(env, {
      SPACETIMEDB_URL: 'http://stdb.test',
      SPACETIMEDB_DB: DB,
      SPACETIMEDB_SERVICE_TOKEN: 'svc'
    });
    sql = connect();
  });
  beforeEach(async () => {
    fetchMock.mockReset();
    await sql`delete from activity_event where db = ${DB}`;
  });
  afterAll(async () => {
    await sql`delete from activity_event where db = ${DB}`;
    await sql.end();
  });

  it('drains the outbox as the service, acks ids with counts, and lists newest first without board.stats', async () => {
    const acks = serveOutbox([
      [
        outboxRow(1, 7, 'board.created', { payload: '{"name":"Plan","via":"manual"}' }),
        outboxRow(2, 7, 'node.created', { count: 4, lastS: 9 }),
        outboxRow(3, 7, 'board.stats', { payload: '{"nodes":1}' }),
        outboxRow(4, 8, 'edge.created', { actor: AGENT, payload: 'not json' })
      ]
    ]);

    expect(await drain(sql, env)).toBe(4);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`http://stdb.test/v1/database/${DB}/sql`);
    expect(init).toMatchObject({ headers: { authorization: 'Bearer svc' }, body: 'SELECT * FROM service_outbox' });
    expect(acks).toEqual([[[1, 2, 3, 4], [1, 4, 1, 1]]]);

    const events = await listActivity(sql, { db: DB, boardIds: ['7', '8'], limit: 50 });
    expect(events.map((e) => e.type)).toEqual(['node.created', 'edge.created', 'board.created']);
    expect(events[0]).toEqual({
      id: expect.stringMatching(/^\d+$/),
      boardId: '7',
      type: 'node.created',
      actor: MAYA,
      actorName: 'Maya',
      actorKind: 'human',
      at: iso(2),
      lastAt: iso(9),
      count: 4,
      payload: { label: 'n2' }
    });
    expect(events[1]).toMatchObject({ boardId: '8', actor: AGENT, actorKind: 'agent', payload: {} });
    expect(events[2].payload).toEqual({ name: 'Plan', via: 'manual' });
  });

  it('updates a burst in place when it is drained again after merging', async () => {
    serveOutbox([
      [outboxRow(1, 7, 'node.created')],
      [outboxRow(1, 7, 'node.created', { count: 3, lastS: 5, payload: '{"label":"latest"}' })]
    ]);
    await drain(sql, env);
    await drain(sql, env);

    const events = await listActivity(sql, { db: DB, boardIds: ['7'], limit: 50 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ count: 3, at: iso(1), lastAt: iso(5), payload: { label: 'latest' } });
  });

  it('keeps the newer burst when a slow drain lands a stale read after it', async () => {
    serveOutbox([
      [outboxRow(1, 7, 'node.created', { count: 3, lastS: 5, payload: '{"label":"newer"}' })],
      [outboxRow(1, 7, 'node.created', { count: 2, lastS: 3, payload: '{"label":"older"}' })]
    ]);
    await drain(sql, env);
    await drain(sql, env);

    const events = await listActivity(sql, { db: DB, boardIds: ['7'], limit: 50 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ count: 3, lastAt: iso(5), payload: { label: 'newer' } });
  });

  it('keeps draining while batches are full, at most five batches per call', async () => {
    const full = (n: number) => Array.from({ length: 500 }, (_, i) => outboxRow(n * 500 + i + 1, 7, 'node.created'));
    const acks = serveOutbox([0, 1, 2, 3, 4, 5].map(full));

    expect(await drain(sql, env)).toBe(2500);
    expect(acks).toHaveLength(5);
  });

  it('strips NUL and lone surrogates, which Postgres rejects, so those rows still land and are acked', async () => {
    const acks = serveOutbox([
      [
        outboxRow(1, 7, 'node.created', { actorName: 'M\u0000aya', payload: JSON.stringify({ label: 'a\u0000b' }) }),
        outboxRow(2, 7, 'node.created', { actorName: 'Ma\ud800ya', payload: JSON.stringify({ label: 'c\udc00d', n: [1] }) })
      ]
    ]);

    expect(await drain(sql, env)).toBe(2);
    expect(acks).toEqual([[[1, 2], [1, 1]]]);
    const events = await listActivity(sql, { db: DB, boardIds: ['7'], limit: 50 });
    expect(events.map((e) => [e.actorName, e.payload])).toEqual([
      ['Ma\ufffdya', { label: 'c\ufffdd', n: [1] }],
      ['Maya', { label: 'ab' }]
    ]);
  });

  it('skips and acks a row Postgres still rejects, landing the rest of its batch', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const acks = serveOutbox([
      [outboxRow(1, 7, 'node.created'), outboxRow(2, 7, 'node.created', { count: 2 ** 31 }), outboxRow(3, 7, 'node.created')]
    ]);

    expect(await drain(sql, env)).toBe(3);
    expect(acks).toEqual([[[1, 2, 3], [1, 2 ** 31, 1]]]);
    expect((await listActivity(sql, { db: DB, boardIds: ['7'], limit: 50 })).map((e) => e.payload)).toEqual([
      { label: 'n3' },
      { label: 'n1' }
    ]);
    expect(error).toHaveBeenCalledOnce();
    expect(JSON.parse(error.mock.calls[0][0])).toEqual({
      event: 'activity.row_dropped',
      outboxId: '2',
      error: expect.stringContaining('out of range'),
      code: '22003'
    });
    error.mockRestore();
  });

  it('acks nothing when Postgres is unreachable, so the next drain retries the batch', async () => {
    const acks = serveOutbox([[outboxRow(1, 7, 'node.created')]]);
    const down = postgres('postgres://postgres@localhost:1/none', { max: 1, connect_timeout: 1 });

    await expect(drain(down, env)).rejects.toThrow();
    expect(acks).toEqual([]);
    await down.end();
  });

  it('filters by board set, actor and limit', async () => {
    serveOutbox([
      [outboxRow(1, 7, 'node.created'), outboxRow(2, 7, 'node.created', { actor: AGENT }), outboxRow(3, 9, 'node.created')]
    ]);
    await drain(sql, env);

    const mine = await listActivity(sql, { db: DB, boardIds: ['7'], limit: 50 });
    expect(mine.map((e) => e.boardId)).toEqual(['7', '7']);
    const agent = await listActivity(sql, { db: DB, boardIds: ['7', '9'], actor: AGENT, limit: 50 });
    expect(agent.map((e) => e.actor)).toEqual([AGENT]);
    expect(await listActivity(sql, { db: DB, boardIds: ['7', '9'], limit: 1 })).toHaveLength(1);
    expect(await listActivity(sql, { db: DB, boardIds: [], limit: 50 })).toEqual([]);
    expect(await listActivity(sql, { db: 'another-db', boardIds: ['7'], limit: 50 })).toEqual([]);
  });
});
