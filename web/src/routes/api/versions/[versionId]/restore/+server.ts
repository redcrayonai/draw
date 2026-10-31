import { json } from '@sveltejs/kit';
import { bearer, fail } from '$lib/server/http';
import { available } from '$lib/server/plugins';
import { env } from '$env/dynamic/private';
import { REQUEST_KEY, restoreVersion, serverReady, VersionError } from '$lib/server/versions';
import type { RequestHandler } from './$types';

/** Restore a version into a new private board: { requestKey, name? }. Retrying with the same requestKey returns the same board. */
export const POST: RequestHandler = async ({ request, params, url }) => {
  if (!available('versions')) return fail(503, 'UNAVAILABLE: this deployment does not offer Versions. Ask its operator to configure version storage.');
  const unready = serverReady();
  if (unready) return unready;
  const db = url.searchParams.get('db');
  if (db && db !== env.SPACETIMEDB_DB) return fail(400, 'REJECTED: this dashboard server keeps versions for its own database only. Open the dashboard from its usual address.');
  const token = bearer(request);
  if (!token) return fail(401, 'REJECTED: sign in again; this request had no session token.');
  if (!/^[1-9]\d{0,19}$/.test(params.versionId)) return fail(400, 'REJECTED: the version id must be a decimal id.');
  const body = await request.json().catch(() => null);
  if (typeof body?.requestKey !== 'string' || !REQUEST_KEY.test(body.requestKey)) return fail(400, 'REJECTED: send a requestKey of 32–128 URL-safe characters.');
  if (body.name !== undefined && (typeof body.name !== 'string' || body.name.length > 100)) return fail(400, 'REJECTED: a board name has at most 100 characters.');
  try {
    return json(await restoreVersion(token, BigInt(params.versionId), body.requestKey, body.name ?? ''), { status: 201 });
  } catch (e) {
    if (e instanceof VersionError) return fail(e.status, e.message);
    throw e;
  }
};
