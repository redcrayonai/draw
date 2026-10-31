// Versions plugin, server side (PLUGINS.md): moves bundles between the database and the
// operator's object store. The module decides who may do what and checks every bundle; this
// file stores, fetches and verifies bytes, and keeps the storage keys to itself.
import { env } from '$env/dynamic/private';
import { callAs, procedureAs, sqlAs, DbError } from './board-db';
import { getObject, machineCredentials, putNew, sha256Hex, StoreError, type StoreConfig } from './object-store';
import { log } from './log';
import { notConfigured } from './http';

/** The storage Versions needs: the plugin is offered only with all three. Keys are optional, both or neither: without them the server signs with its machine's role. */
export const STORAGE_VARS = ['VERSIONS_S3_ENDPOINT', 'VERSIONS_S3_BUCKET', 'VERSIONS_S3_REGION'];
const set = (k: string) => Boolean(env[k]?.trim());
export const versionsConfigured = () => STORAGE_VARS.every(set) && set('VERSIONS_S3_ACCESS_KEY_ID') === set('VERSIONS_S3_SECRET_ACCESS_KEY');
/** The rest of the server's setup a save or restore needs; the routes answer UNAVAILABLE and log the names when one is missing. */
export const serverReady = () => notConfigured('UNAVAILABLE: this server is not set up to save or restore versions. Ask the deployment operator.', ['SPACETIMEDB_URL', 'SPACETIMEDB_DB', 'SPACETIMEDB_SERVICE_TOKEN']);

const store = async (): Promise<StoreConfig> => ({
  endpoint: env.VERSIONS_S3_ENDPOINT!, bucket: env.VERSIONS_S3_BUCKET!, region: env.VERSIONS_S3_REGION!,
  ...(env.VERSIONS_S3_ACCESS_KEY_ID ? { accessKeyId: env.VERSIONS_S3_ACCESS_KEY_ID, secretAccessKey: env.VERSIONS_S3_SECRET_ACCESS_KEY! } : await machineCredentials(env))
});

export class VersionError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const STORE_DOWN = 'UNAVAILABLE: version storage is not answering. Nothing was saved or restored; try again in a minute.';
const STORE_REFUSED = 'UNAVAILABLE: version storage refused this server. Nothing was saved or restored; ask the deployment operator to check its storage settings.';
// Below the database's 2 MiB call limit at 3 UTF-8 bytes per UTF-16 unit (a bundle is JSON: no raw control characters).
const PIECE = 600_000;
export const REQUEST_KEY = /^[A-Za-z0-9_-]{32,128}$/;

/** A store call, retried with backoff when the store or the network fails (never on a refusal). */
async function retried<T>(event: string, f: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try { return await f(); }
    catch (e) {
      const transient = !(e instanceof StoreError) || e.status >= 500;
      log('warn', event, { attempt: i, transient }, e);
      if (e instanceof StoreError && e.status === 413) throw new VersionError(502, 'UNAVAILABLE: the stored version is larger than its list entry says, so it was not used. No board was created.');
      if (!transient) throw new VersionError(503, STORE_REFUSED);
      if (i >= attempts) throw new VersionError(503, STORE_DOWN);
      await new Promise((r) => setTimeout(r, 250 * 2 ** i));
    }
  }
}

/** A database refusal as the caller's sentence; anything else as unavailable. */
function dbFailure(e: unknown): VersionError {
  if (e instanceof VersionError) return e;
  if (e instanceof DbError && e.status === 530) return new VersionError(403, `REJECTED: ${e.message}`);
  if (e instanceof DbError && e.status === 401) return new VersionError(401, 'REJECTED: your session expired. Reload the page or sign in again.');
  log('error', 'version.db_failed', {}, e);
  return new VersionError(503, 'UNAVAILABLE: the board server is not answering. Nothing was changed; try again shortly.');
}

type Charged<T> = (T & { error?: undefined }) | { error: string; refused: boolean };
/** A charged procedure's JSON (module/src/versions.ts): its result, or a refusal (REJECTED) or failure (UNAVAILABLE). */
async function procedure<T>(token: string, name: string, args: unknown[]): Promise<T> {
  const out = JSON.parse(JSON.parse(await procedureAs(token, name, args))) as Charged<T>;
  if (out.error === undefined) return out as T;
  if (out.refused) throw new VersionError(403, `REJECTED: ${out.error}`);
  log('error', 'version.procedure_failed', { procedure: name, error: out.error });
  throw new VersionError(503, 'UNAVAILABLE: the board server could not finish this. Nothing was changed; try again shortly.');
}

/**
 * Save: the module captures the board in one transaction and names a fresh object key; the object
 * is written only where nothing exists; only then is the version published to the list.
 */
export async function saveVersion(token: string, boardId: bigint): Promise<{ versionId: string }> {
  let captured: { versionId: string; objectKey: string; sha256: string; bytes: number; bundle: string };
  try { captured = await procedure(token, 'capture_board_version', [boardId]); }
  catch (e) { throw dbFailure(e); }
  const body = new TextEncoder().encode(captured.bundle);
  if (body.length !== captured.bytes || (await sha256Hex(body)) !== captured.sha256) throw new VersionError(502, 'UNAVAILABLE: the version arrived damaged. Nothing was saved; try again.');
  const outcome = await retried('version.store_failed', async () => putNew(await store(), captured.objectKey, body));
  if (outcome === 'exists') {
    // Only an earlier try of this same write can hold this key: accept it if it is byte-identical, never overwrite.
    const there = await retried('version.store_failed', async () => getObject(await store(), captured.objectKey, body.length));
    if (!there || (await sha256Hex(there)) !== captured.sha256) {
      log('error', 'version.key_taken', { versionId: captured.versionId });
      throw new VersionError(409, 'UNAVAILABLE: storage already holds different data under this version\'s key. Nothing was overwritten or listed; save again.');
    }
  }
  try { await callAs(env.SPACETIMEDB_SERVICE_TOKEN!, 'publish_board_version', [BigInt(captured.versionId), captured.sha256]); }
  catch (e) {
    if (e instanceof DbError && e.status === 530) throw new VersionError(403, `REJECTED: ${e.message}. The stored copy stays unlisted.`);
    log('error', 'version.publish_failed', { versionId: captured.versionId }, e);
    throw new VersionError(503, 'UNAVAILABLE: the version was stored but could not be added to the list. Save again.');
  }
  log('info', 'version.saved', { versionId: captured.versionId, bytes: body.length });
  return { versionId: captured.versionId };
}

/**
 * Restore: fetch the stored bundle, check it against the index, hand it to the module in pieces,
 * and let one module transaction build the new private board. Retrying with the same requestKey
 * returns the board the first try made.
 */
export async function restoreVersion(token: string, versionId: bigint, requestKey: string, name: string): Promise<{ boardId: string; slug: string }> {
  if (!REQUEST_KEY.test(requestKey)) throw new VersionError(400, 'REJECTED: send a requestKey of 32–128 URL-safe characters.'); // it goes into SQL below
  try {
    const made = async () => {
      const [creation] = await sqlAs(token, `SELECT board_id FROM my_board_creations WHERE request_key = '${requestKey}'`);
      if (!creation) return undefined;
      const [row] = await sqlAs(token, `SELECT slug FROM my_board_slugs WHERE board_id = ${creation.board_id}`);
      return { boardId: String(creation.board_id), slug: String(row?.slug ?? '') };
    };
    const done = await made();
    if (done) return done;
    const [s] = await sqlAs(token, `SELECT object_key, sha256, bytes FROM my_board_versions WHERE id = ${versionId}`);
    if (!s) throw new VersionError(404, 'REJECTED: this version is unavailable to you. Its workspace may have turned Versions off, or your access changed.');
    // An empty first piece asks the module whether this caller may restore, before any download (a viewer may not).
    await callAs(token, 'stage_board_version_chunk', [versionId, requestKey, 0, '']);
    const size = Number(s.bytes);
    // size is the module's, which never indexes a bundle over its limit
    const bytes = await retried('version.fetch_failed', async () => getObject(await store(), String(s.object_key), size));
    if (!bytes) throw new VersionError(502, 'UNAVAILABLE: this version is missing from storage. No board was created.');
    if (bytes.length !== size || (await sha256Hex(bytes)) !== s.sha256) {
      log('error', 'version.corrupt', { versionId: String(versionId) });
      throw new VersionError(502, 'UNAVAILABLE: the stored version does not match its checksum, so it was not restored. No board was created.');
    }
    const text = new TextDecoder().decode(bytes);
    for (let i = 0, at = 0; at < text.length || i === 0; i++) {
      let end = Math.min(at + PIECE, text.length);
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--; // never split a surrogate pair
      await callAs(token, 'stage_board_version_chunk', [versionId, requestKey, i, text.slice(at, end)]);
      at = end;
    }
    try {
      await procedure(token, 'restore_board_version', [versionId, requestKey, name]);
    } catch (e) {
      if (e instanceof VersionError && e.status === 403) throw e;
      // The board may exist though the answer was lost: report it, never a second one.
      const after = await made().catch(() => undefined);
      if (after) return after;
      log('error', 'version.restore_unconfirmed', { versionId: String(versionId) }, e);
      throw new VersionError(503, 'UNCONFIRMED: the board server did not confirm the restore. Reload the dashboard and check your boards before retrying.');
    }
    const restored = await made();
    if (!restored) throw new VersionError(503, 'UNCONFIRMED: the restore finished but its board could not be read back. Reload the dashboard before retrying.');
    log('info', 'version.restored', { versionId: String(versionId), boardId: restored.boardId });
    return restored;
  } catch (e) {
    throw dbFailure(e);
  }
}
