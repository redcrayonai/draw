import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { drain } from '$lib/server/activity';
import { connect } from '$lib/server/db';
import { bearer, fail, notConfigured } from '$lib/server/http';
import { log } from '$lib/server/log';
import type { RequestHandler } from './$types';

// POST /api/activity/drain, called by the Worker's cron (worker.js) with the service token,
// so the outbox empties even when nobody opens the dashboard.
export const POST: RequestHandler = async ({ request, url, platform }) => {
  const off = notConfigured('Activity is not set up on this deployment yet.', [
    'DATABASE_URL',
    'SPACETIMEDB_URL',
    'SPACETIMEDB_DB',
    'SPACETIMEDB_SERVICE_TOKEN'
  ]);
  if (off) return off;
  if (bearer(request) !== env.SPACETIMEDB_SERVICE_TOKEN) return fail(401, 'Invalid drain credentials.');
  // worker.js's cron posts to cron.invalid; anything else is a manual call with the token
  const entryPoint = url.hostname === 'cron.invalid' ? 'cron' : 'manual';
  const sql = connect(platform);
  try {
    const drained = await drain(sql, env);
    log('info', 'activity.drained', { entryPoint, drained });
    return json({ drained });
  } catch (e) {
    log('error', 'activity.drain_failed', { entryPoint }, e);
    return fail(502, 'Activity storage is unreachable; try again shortly.');
  } finally {
    await sql.end({ timeout: 5 });
  }
};
