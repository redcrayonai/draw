import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import type { ActivityResponse } from '$lib/api-types';
import { drain, listActivity } from '$lib/server/activity';
import { connect } from '$lib/server/db';
import { bearer, fail, notConfigured } from '$lib/server/http';
import { DbError, sqlAs } from '$lib/server/board-db';
import { log } from '$lib/server/log';
import type { RequestHandler } from './$types';

// The cron (worker.js) drains every 5 minutes; a read drains too so the feed is
// fresh, but at most once per DRAIN_EVERY_MS per isolate however many dashboards poll.
const DRAIN_EVERY_MS = 10_000;
let drainedAt = -Infinity;

// GET /api/activity?db=&limit=&actor=&board= with the caller's SpacetimeDB token.
export const GET: RequestHandler = async ({ request, url, platform }) => {
  const off = notConfigured('Activity is not set up on this deployment yet.', [
    'DATABASE_URL',
    'SPACETIMEDB_URL',
    'SPACETIMEDB_DB',
    'SPACETIMEDB_SERVICE_TOKEN'
  ]);
  if (off) return off;
  const token = bearer(request);
  if (!token) return fail(401, 'Sign in again: this request had no session token.');
  // Activity is drained from SPACETIMEDB_DB only; a dashboard opened on ?db=<other> must not show it as its own.
  const db = url.searchParams.get('db');
  if (db && db !== env.SPACETIMEDB_DB) {
    return fail(
      400,
      'This deployment records activity for one database only; open the dashboard from its usual address.'
    );
  }

  const actor = url.searchParams.get('actor')?.toLowerCase().replace(/^0x/, '') || undefined;
  if (actor && !/^[0-9a-f]{64}$/.test(actor)) return fail(400, 'actor must be a 64-character identity hex.');
  const board = url.searchParams.get('board');
  if (board && !/^\d+$/.test(board)) return fail(400, 'board must be a decimal board id.');
  const limit = Math.min(100, Math.max(1, Math.trunc(Number(url.searchParams.get('limit'))) || 50));

  const sql = connect(platform);
  // The drain and the caller's board read are independent, so they overlap
  // instead of costing two round trips to the board server in a row.
  let draining: Promise<unknown> | undefined;
  if (Date.now() - drainedAt >= DRAIN_EVERY_MS) {
    drainedAt = Date.now();
    draining = drain(sql, env).catch((e) => log('error', 'activity.drain_failed', { entryPoint: 'activity_read' }, e));
  }
  try {
    // The caller's own my_boards view decides whose activity they may read.
    let boardIds: string[];
    try {
      boardIds = (await sqlAs(token, 'SELECT board_id FROM my_boards')).map((r) => String(r.board_id));
    } catch (e) {
      if (e instanceof DbError && e.status === 401) {
        return fail(401, 'Your session expired. Reload the page or sign in again.');
      }
      log('error', 'activity.boards_failed', {}, e);
      return fail(502, 'Could not read your boards right now. Try again shortly.');
    }
    if (board) {
      if (!boardIds.includes(board)) return fail(403, `Board ${board} is not on your dashboard.`);
      boardIds = [board];
    }
    await draining; // so the feed includes what the drain just moved
    const events = await listActivity(sql, { db: env.SPACETIMEDB_DB!, boardIds, actor, limit });
    return json({ events } satisfies ActivityResponse);
  } catch (e) {
    log('error', 'activity.query_failed', {}, e);
    return fail(502, 'Activity storage is unreachable; try again shortly.');
  } finally {
    await draining;
    await sql.end({ timeout: 5 });
  }
};
