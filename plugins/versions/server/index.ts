import { json, bearer, fail, env, type PluginRequest } from '@draw/server';
import { isId, saveReady, saveVersion, REQUEST_KEY, restoreReady, restoreVersion, VersionError } from './versions';
export { versionsConfigured as configured } from './versions';

export async function handle(event: PluginRequest): Promise<Response> {
  if (event.request.method === 'POST') {
    if (event.path.length === 0) return save(event);
    if (event.path.length === 2 && event.path[1] === 'restore') return restore(event);
  }
  return fail(404, 'REJECTED: no such plugin action.');
}

/** Save a version of { boardId }. The module checks the caller (a signed-in editor) and the workspace's plugin switch. */
async function save({ request, url }: PluginRequest) {
  const unready = saveReady();
  if (unready) return unready;
  const db = url.searchParams.get('db');
  if (db && db !== env.SPACETIMEDB_DB) return fail(400, 'REJECTED: this dashboard server keeps versions for its own database only. Open the dashboard from its usual address.');
  const token = bearer(request);
  if (!token) return fail(401, 'REJECTED: sign in again; this request had no session token.');
  const body = await request.json().catch(() => null);
  if (typeof body?.boardId !== 'string' || !isId(body.boardId)) return fail(400, 'REJECTED: send boardId as a decimal board id.');
  try {
    return json(await saveVersion(token, BigInt(body.boardId)), { status: 201 });
  } catch (e) {
    if (e instanceof VersionError) return fail(e.status, e.message);
    throw e;
  }
}

/** Restore a version into a new private board: { requestKey, name? }. Retrying with the same requestKey returns the same board. */
async function restore({ request, path, url }: PluginRequest) {
  const unready = restoreReady();
  if (unready) return unready;
  const db = url.searchParams.get('db');
  if (db && db !== env.SPACETIMEDB_DB) return fail(400, 'REJECTED: this dashboard server keeps versions for its own database only. Open the dashboard from its usual address.');
  const token = bearer(request);
  if (!token) return fail(401, 'REJECTED: sign in again; this request had no session token.');
  if (!isId(path[0])) return fail(400, 'REJECTED: the version id must be a decimal id.');
  const body = await request.json().catch(() => null);
  if (typeof body?.requestKey !== 'string' || !REQUEST_KEY.test(body.requestKey)) return fail(400, 'REJECTED: send a requestKey of 32–128 URL-safe characters.');
  if (body.name !== undefined && (typeof body.name !== 'string' || body.name.length > 100)) return fail(400, 'REJECTED: a board name has at most 100 characters.');
  try {
    return json(await restoreVersion(token, BigInt(path[0]), body.requestKey, body.name ?? ''), { status: 201 });
  } catch (e) {
    if (e instanceof VersionError) return fail(e.status, e.message);
    throw e;
  }
}
