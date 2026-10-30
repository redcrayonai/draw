import { decodeJwt } from 'jose';
import { identityFromClaims } from '$shared/identity';
import { hexOf } from '$shared/db-http';
import { env } from '$env/dynamic/private';
import { fail, notConfigured } from './http';
import { callAs, sqlAs, DbError, type DbRow } from './board-db';
import { validateGraph as validateArchitectureGraph } from '../../../../module/src/architecture';
import { log } from './log';

export type PinnedRef = { ref: string; sha: string };
export class ImportError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export const configured = () => notConfigured(
  'The import runner is not configured. Ask the deployment owner to set up repository imports.',
  ['IMPORT_RUNNER_URL', 'IMPORT_RUNNER_SECRET', 'IMPORT_CALLBACK_URL', 'SPACETIMEDB_URL', 'SPACETIMEDB_DB', 'SPACETIMEDB_SERVICE_TOKEN']
);

export function assertDatabase(url: URL): void {
  const db = url.searchParams.get('db');
  if (db && db !== env.SPACETIMEDB_DB) throw new ImportError(400, 'This deployment imports into one database only. Open the dashboard from its usual address.');
}

export function repositoryUrl(value: unknown): string {
  let url: URL;
  try { url = new URL(typeof value === 'string' ? value.trim() : ''); }
  catch { throw new ImportError(400, 'Enter a public GitHub repository URL, such as https://github.com/owner/repo.'); }
  const path = url.pathname.replace(/\/$/, '').replace(/\.git$/, '');
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash || !/^\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(path) || path.split('/').some((p) => p === '.' || p === '..')) {
    throw new ImportError(400, 'Only public GitHub repository URLs are supported. Use https://github.com/owner/repo.');
  }
  return `https://github.com${path}`;
}

export function refNames(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10 || value.some((r) => typeof r !== 'string' || !r.trim() || r.length > 250)) {
    throw new ImportError(400, 'Select between one and ten refs in snapshot order.');
  }
  const refs = value.map((r: string) => r.trim());
  if (new Set(refs).size !== refs.length) throw new ImportError(400, 'Choose each ref once.');
  return refs;
}

export const githubPath = (repository: string) => repository.replace('https://github.com/', '/repos/');
export async function github(path: string): Promise<unknown> {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'redcrayon-imports', 'x-github-api-version': '2022-11-28' },
    signal: AbortSignal.timeout(15_000)
  });
  if (response.status === 404 || response.status === 422) throw new ImportError(400, 'GitHub could not find this public repository or ref. Check the URL and selected refs.');
  if (response.status === 403 || response.status === 429) throw new ImportError(429, 'GitHub is limiting repository requests. Try again shortly.');
  if (!response.ok) throw new ImportError(502, 'GitHub could not load the repository right now. Try again shortly.');
  return response.json();
}

export async function publicRepository(repository: string): Promise<{ default_branch: string }> {
  const metadata = await github(githubPath(repository)) as { private?: boolean; default_branch?: string };
  if (metadata.private !== false) throw new ImportError(400, 'This release imports public GitHub repositories only.');
  return { default_branch: metadata.default_branch ?? 'main' };
}

/** Native workspace destinations arrive as strings so large u64 ids stay exact. */
export function workspaceId(value: unknown): bigint {
  if (typeof value !== 'string' || !/^[1-9]\d{0,19}$/.test(value) || BigInt(value) > 18446744073709551615n) throw new ImportError(400, 'workspaceId must be a decimal workspace id.');
  return BigInt(value);
}

export function historyId(value: unknown): bigint {
  if (typeof value !== 'string' || !/^[1-9]\d{0,19}$/.test(value) || BigInt(value) > 18446744073709551615n) throw new ImportError(400, 'historyId must be a decimal history id.');
  return BigInt(value);
}

export function pinnedRefs(history: DbRow): PinnedRef[] {
  const refs = JSON.parse(String(history.refs_json)) as PinnedRef[];
  refNames(refs.map((r) => r.ref));
  if (refs.some((r) => !/^[a-f0-9]{40}$/.test(r.sha))) throw new Error('History contains invalid pinned commits.');
  return refs;
}

/** Creation request keys are scoped to their creator, even when managers see coworkers' jobs. */
export async function callerRequestHistory(token: string, requestKey: string): Promise<DbRow | undefined> {
  let owner: string;
  try {
    // verifyBearer already checks account tokens. Anonymous tokens are checked by SQL below.
    // Decoded claims only select a row; they never authorize a service operation themselves.
    const { iss, sub } = decodeJwt(token);
    if (typeof iss !== 'string' || typeof sub !== 'string' || !sub) throw new Error('missing identity claims');
    owner = identityFromClaims(iss, sub);
  } catch {
    throw new ImportError(401, 'Your session expired. Reload the page or sign in again.');
  }
  return (await sqlAs(token, 'SELECT * FROM my_architecture_histories'))
    .find(history => history.request_key === requestKey && hexOf(history.owner) === owner);
}

export async function ownedHistory(token: string, id: bigint): Promise<DbRow> {
  const history = (await sqlAs(token, 'SELECT * FROM my_architecture_histories')).find((r) => String(r.id) === id.toString());
  if (!history) throw new ImportError(403, 'This import is not on your dashboard.');
  return history;
}

export async function completedIndexes(id: bigint): Promise<Set<number>> {
  return new Set((await sqlAs(env.SPACETIMEDB_SERVICE_TOKEN!, `SELECT * FROM visible_architecture_version WHERE history_id = ${id} AND assertion_mode = 'fact'`)).map((r) => Number(r.index)));
}

export async function dispatch(history: DbRow): Promise<void> {
  const id = historyId(String(history.id));
  const completed = await completedIndexes(id);
  const pinned = pinnedRefs(history);
  const refs = pinned.map((r, index) => ({ ...r, index })).filter((r) => !completed.has(r.index));
  const service = env.SPACETIMEDB_SERVICE_TOKEN!;
  if (!refs.length) {
    await callAs(service, 'set_architecture_import_status', [id, 'ready', '']);
    return;
  }
  await callAs(service, 'set_architecture_import_status', [id, 'running', '']);
  try {
    const response = await fetch(`${env.IMPORT_RUNNER_URL!.replace(/\/$/, '')}/imports`, {
      method: 'POST', headers: { authorization: `Bearer ${env.IMPORT_RUNNER_SECRET}`, 'content-type': 'application/json' },
      body: JSON.stringify({ historyId: id.toString(), repository: repositoryUrl(history.repository), refs, callbackUrl: env.IMPORT_CALLBACK_URL }),
      signal: AbortSignal.timeout(15_000)
    });
    if (response.status !== 202) throw new Error(`Import runner answered HTTP ${response.status}.`);
  } catch {
    const latest = await completedIndexes(id);
    if (latest.size === pinned.length) {
      await callAs(service, 'set_architecture_import_status', [id, 'ready', '']);
      return;
    }
    const message = 'The import runner could not start this job. Retry the import, or ask the deployment owner to check the runner.';
    await callAs(service, 'set_architecture_import_status', [id, latest.size ? 'partial' : 'failed', message]);
    throw new ImportError(502, message);
  }
}

export function importFailure(error: unknown): Response {
  if (error instanceof ImportError) return fail(error.status, error.message);
  if (error instanceof DbError && error.status === 401) return fail(401, 'Your session expired. Reload the page or sign in again.');
  if (error instanceof DbError && error.status === 530) return fail(400, error.message);
  log('error', 'import.failed', {}, error);
  return fail(502, 'Could not complete the repository import request. Try again shortly.');
}

export async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  const body: unknown = await request.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ImportError(400, 'Send a JSON object.');
  return body as Record<string, unknown>;
}

export function validateGraph(value: unknown): void {
  try { validateArchitectureGraph(value); }
  catch (error) { throw new ImportError(400, error instanceof Error ? error.message : 'The imported graph is invalid.'); }
}
