import { json } from '@sveltejs/kit';
import { bearer, fail } from '$lib/server/http';
import { available } from '$lib/server/plugins';
import { env } from '$env/dynamic/private';
import { saveVersion, serverReady, VersionError } from '$lib/server/versions';
import type { RequestHandler } from './$types';

const ID = /^[1-9]\d{0,19}$/;

/** Save a version of { boardId }. The module checks the caller (a signed-in editor) and the workspace's plugin switch. */
export const POST: RequestHandler = async ({ request, url }) => {
  if (!available('versions')) return fail(503, 'UNAVAILABLE: this deployment does not offer Versions. Ask its operator to configure version storage.');
  const unready = serverReady();
  if (unready) return unready;
  const db = url.searchParams.get('db');
  if (db && db !== env.SPACETIMEDB_DB) return fail(400, 'REJECTED: this dashboard server keeps versions for its own database only. Open the dashboard from its usual address.');
  const token = bearer(request);
  if (!token) return fail(401, 'REJECTED: sign in again; this request had no session token.');
  const body = await request.json().catch(() => null);
  if (typeof body?.boardId !== 'string' || !ID.test(body.boardId)) return fail(400, 'REJECTED: send boardId as a decimal board id.');
  try {
    return json(await saveVersion(token, BigInt(body.boardId)), { status: 201 });
  } catch (e) {
    if (e instanceof VersionError) return fail(e.status, e.message);
    throw e;
  }
};
