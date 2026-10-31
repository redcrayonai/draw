import type { JSONValue } from 'postgres';
import type { ActivityEvent } from '../api-types';
import type { Sql } from './db';
import { dateOf, dbHttp, hexOf } from '$shared/db-http';
import { log } from './log';

const BATCH = 500; // service_outbox returns at most this many rows, oldest first
const MAX_BATCHES = 5;

// Postgres text and jsonb reject NUL and lone surrogates, and reducers accept any label or name.
const clean = (s: string) => s.toWellFormed().replaceAll('\u0000', '');

// shortcut: a malformed payload becomes {} so one bad row never blocks the drain, and its details are lost; log the row id once an event is reported with no details.
function payloadOf(cell: unknown): JSONValue {
  try {
    const value: JSONValue = JSON.parse(String(cell), (_k, v) => (typeof v === 'string' ? clean(v) : v));
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

/**
 * Move outbox rows into activity_event, then ack them. Safe to run concurrently:
 * the upsert is idempotent, only moves a burst forward (the module only ever adds
 * to count, so a lower count is a stale read and is ignored), and ack_activity only
 * deletes rows whose count still matches, so a burst merged after the read is
 * drained again next time.
 */
export async function drain(sql: Sql, env: Record<string, string | undefined>): Promise<number> {
  const token = env.SPACETIMEDB_SERVICE_TOKEN!;
  const { sqlAs, callAs } = dbHttp(env.SPACETIMEDB_URL!, env.SPACETIMEDB_DB!);
  let drained = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const rows = await sqlAs(token, 'SELECT * FROM service_outbox');
    if (rows.length === 0) break;
    const events = rows.map((r) => ({
      outbox_id: String(r.id),
      board_id: String(r.board_id),
      type: String(r.type),
      actor: hexOf(r.actor),
      actor_name: clean(String(r.actor_name)),
      actor_kind: String(r.actor_kind),
      at: dateOf(r.at).toISOString(),
      last_at: dateOf(r.last_at).toISOString(),
      count: Number(r.count),
      payload: payloadOf(r.payload)
    }));
    const insert = (batch: typeof events) => sql`
      insert into activity_event
        (db, outbox_id, board_id, type, actor, actor_name, actor_kind, at, last_at, count, payload)
      select ${env.SPACETIMEDB_DB!}::text, r.*
      from jsonb_to_recordset(${sql.json(batch)}) as r(
        outbox_id bigint, board_id bigint, type text, actor text, actor_name text,
        actor_kind text, at timestamptz, last_at timestamptz, count integer, payload jsonb)
      on conflict (db, outbox_id, at) do update
        set count = excluded.count, last_at = excluded.last_at, payload = excluded.payload
        where activity_event.count <= excluded.count`;
    try {
      await insert(events);
    } catch {
      // Find the row Postgres rejects. A data error (SQLSTATE class 22/23) belongs to that row:
      // log it and ack it anyway so it can never wedge the feed. Anything else (connection
      // trouble) acks nothing, and the next drain retries the whole batch.
      for (const e of events) {
        await insert([e]).catch((err) => {
          if (!/^2[23]/.test(err?.code ?? '')) throw err;
          log('error', 'activity.row_dropped', { outboxId: e.outbox_id }, err);
        });
      }
    }
    await callAs(token, 'ack_activity', [rows.map((r) => BigInt(String(r.id))), rows.map((r) => r.count)]);
    drained += rows.length;
    if (rows.length < BATCH) break;
  }
  return drained;
}

/** The feed for these boards (decimal ids), newest burst first, without board.stats snapshots. */
export async function listActivity(
  sql: Sql,
  q: { db: string; boardIds: string[]; actor?: string; limit: number }
): Promise<ActivityEvent[]> {
  if (q.boardIds.length === 0) return [];
  const rows = await sql`
    select id::text, board_id::text, type, actor, actor_name, actor_kind, at, last_at, count, payload
    from activity_event
    where db = ${q.db}
      and board_id = any(${`{${q.boardIds.join(',')}}`}::bigint[])
      and type <> 'board.stats'
      ${q.actor ? sql`and actor = ${q.actor}` : sql``}
    order by last_at desc, id desc
    limit ${q.limit}`;
  return rows.map((r) => ({
    id: r.id,
    boardId: r.board_id,
    type: r.type,
    actor: r.actor,
    actorName: r.actor_name,
    actorKind: r.actor_kind === 'agent' ? 'agent' : 'human',
    at: r.at.toISOString(),
    lastAt: r.last_at.toISOString(),
    count: r.count,
    payload: r.payload
  }));
}
