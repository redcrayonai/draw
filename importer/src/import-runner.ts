import { execFile } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { extractGraph, repositoryEnvironment, type Graph } from './extract-graph';

const exec = promisify(execFile);
/** One ref's budget: shallow fetch (120s) plus `go list` (180s) plus parsing. */
const REF_TIMEOUT_MS = 10 * 60 * 1000;
export interface PinnedRef { ref: string; sha: string; index: number }
export interface ImportJob { historyId: string; repository: string; refs: PinnedRef[]; callbackUrl: string }
interface RunnerConfig {
  secret: string;
  callbackUrl: string;
  fetch?: typeof fetch;
  importCommit?: (repository: string, sha: string, signal: AbortSignal) => Promise<Graph>;
}
interface ServerConfig extends RunnerConfig {
  verifyRepository?: (repository: string) => Promise<void>;
  runJob?: (job: ImportJob) => Promise<void>;
}

function githubRepository(value: unknown): string {
  if (typeof value !== 'string' || !/^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value)) throw new Error('Repository must be a public https://github.com/owner/repo URL');
  return value.replace(/\.git$/, '');
}

function validateJob(value: unknown, callbackUrl: string): ImportJob {
  if (!value || typeof value !== 'object') throw new Error('Import request must be an object');
  const job = value as Record<string, unknown>;
  if (typeof job.historyId !== 'string' || !job.historyId.trim() || job.historyId.length > 128) throw new Error('Invalid historyId');
  if (job.callbackUrl !== callbackUrl) throw new Error('callbackUrl must match configured IMPORT_CALLBACK_URL');
  const repository = githubRepository(job.repository);
  if (!Array.isArray(job.refs) || job.refs.length < 1 || job.refs.length > 10) throw new Error('An import requires one to ten refs');
  const indexes = new Set<number>();
  const refs = job.refs.map((value: unknown) => {
    if (!value || typeof value !== 'object') throw new Error('Invalid pinned ref');
    const pinned = value as Record<string, unknown>;
    if (typeof pinned.ref !== 'string' || !pinned.ref.trim() || pinned.ref.length > 256) throw new Error('Invalid ref');
    if (typeof pinned.sha !== 'string' || !/^[a-fA-F0-9]{40}$/.test(pinned.sha)) throw new Error('Every ref requires a pinned 40-character SHA');
    if (!Number.isInteger(pinned.index) || Number(pinned.index) < 0 || Number(pinned.index) > 9 || indexes.has(Number(pinned.index))) throw new Error('Ref indexes must be unique integers from zero to nine');
    indexes.add(Number(pinned.index));
    return { ref: pinned.ref, sha: pinned.sha.toLowerCase(), index: Number(pinned.index) };
  }).sort((a, b) => a.index - b.index);
  return { historyId: job.historyId, repository, refs, callbackUrl };
}

/**
 * The largest repository (GitHub's size, in MB) the runner fetches, with REDCRAYON_LIMITS=on:
 * IMPORT_MAX_REPO_MB, default 500 (0 = none). Checkout and module downloads are otherwise bounded only by time.
 */
export function maxRepositoryMb(env: Record<string, string | undefined> = process.env): number {
  if (env.REDCRAYON_LIMITS !== 'on') return 0;
  const mb = Number(env.IMPORT_MAX_REPO_MB || 500);
  if (!Number.isFinite(mb) || mb < 0) throw new Error('IMPORT_MAX_REPO_MB must be a number of megabytes');
  return mb;
}

export async function verifyPublicRepository(repository: string, request: typeof fetch = fetch, maxMb = 0): Promise<void> {
  const path = new URL(githubRepository(repository)).pathname;
  const response = await request(`https://api.github.com/repos${path}`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'redcrayon-import-runner', 'x-github-api-version': '2022-11-28' },
    signal: AbortSignal.timeout(15000), redirect: 'error',
  });
  if (!response.ok) throw new Error(`GitHub repository lookup failed (${response.status})`);
  const metadata = await response.json() as { private?: boolean; size?: number };
  if (metadata.private !== false) throw new Error('Only public GitHub repositories are supported');
  // GitHub reports size in KB.
  if (maxMb && (metadata.size ?? 0) > maxMb * 1024) throw new Error(`Repository is larger than the ${maxMb} MB import limit`);
}

async function importPublicCommit(repository: string, sha: string, signal: AbortSignal): Promise<Graph> {
  const temporary = await mkdtemp(join(tmpdir(), 'architecture-import-'));
  const gitDirectory = join(temporary, 'repository.git');
  const worktree = join(temporary, 'worktree');
  const home = join(temporary, 'home');
  await mkdir(home);
  const env = repositoryEnvironment(home);
  const git = (args: string[]) => exec('git', [
    '-c', 'credential.helper=', '-c', 'core.hooksPath=/dev/null', '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', ...args,
  ], { env, signal, timeout: 120000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024 });
  try {
    await git(['init', '--bare', '--template=', gitDirectory]);
    await git(['--git-dir', gitDirectory, 'remote', 'add', 'origin', `${githubRepository(repository)}.git`]);
    await git(['--git-dir', gitDirectory, 'fetch', '--depth=1', '--no-tags', 'origin', sha]);
    const { stdout: fetched } = await git(['--git-dir', gitDirectory, 'rev-parse', 'FETCH_HEAD']);
    if (fetched.trim().toLowerCase() !== sha) throw new Error('Fetched commit does not match pinned SHA');
    await git(['--git-dir', gitDirectory, 'worktree', 'add', '--detach', worktree, sha]);
    return await extractGraph(worktree, { env, signal });
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2000);
}

export async function runImportJob(job: ImportJob, config: RunnerConfig): Promise<void> {
  const request = config.fetch ?? fetch;
  const importCommit = config.importCommit ?? importPublicCommit;
  const failures: string[] = [];
  const callback = async (body: unknown) => {
    const response = await request(config.callbackUrl, {
      method: 'POST', headers: { authorization: `Bearer ${config.secret}`, 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15000), redirect: 'error',
    });
    if (!response.ok) throw new Error(`Import callback failed (${response.status})`);
  };
  for (const pinned of job.refs) {
    const payload = { historyId: job.historyId, index: pinned.index, ref: pinned.ref, sha: pinned.sha };
    let graph: Graph;
    // A deadline per ref, not per job: a shared budget let the first large refs
    // spend it and reported every later ref as "The operation was aborted",
    // blaming refs that were never attempted.
    try { graph = await importCommit(job.repository, pinned.sha, AbortSignal.timeout(REF_TIMEOUT_MS)); }
    catch (error) {
      const message = errorMessage(error);
      failures.push(`${pinned.ref}: ${message}`);
      try { await callback({ ...payload, error: message }); }
      catch (callbackError) { failures.push(`${pinned.ref}: ${errorMessage(callbackError)}`); }
      continue;
    }
    try { await callback({ ...payload, graph }); }
    catch (error) { failures.push(`${pinned.ref}: ${errorMessage(error)}`); }
  }
  await callback({ historyId: job.historyId, status: failures.length ? 'failed' : 'ready', error: failures.join('; ').slice(0, 2000) });
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 64 * 1024) throw new Error('Request exceeds 64 KiB');
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function createImportServer(config: ServerConfig) {
  if (!config.secret) throw new Error('IMPORT_RUNNER_SECRET is required');
  const callback = new URL(config.callbackUrl);
  if (!['http:', 'https:'].includes(callback.protocol) || callback.username || callback.password) throw new Error('IMPORT_CALLBACK_URL must be an HTTP(S) URL without credentials');
  // Read once, so a bad IMPORT_MAX_REPO_MB stops the runner at start instead of failing each import.
  const maxMb = maxRepositoryMb();
  let pending = 0;
  // A history already queued or running is not queued twice: a repeated retry cannot fill the queue.
  const active = new Set<string>();
  // ponytail: one repository job at a time; use more runner instances if throughput requires it.
  let queue = Promise.resolve();
  return createServer((request, response) => {
    const send = (status: number, body: unknown) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); };
    void (async () => {
      if (request.method !== 'POST' || request.url !== '/imports') { send(404, { error: 'Not found' }); return; }
      const expected = Buffer.from(`Bearer ${config.secret}`);
      const supplied = Buffer.from(request.headers.authorization ?? '');
      if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) { send(401, { error: 'Unauthorized' }); return; }
      let job: ImportJob;
      try { job = validateJob(await readBody(request), config.callbackUrl); }
      catch (error) { send(400, { error: errorMessage(error) }); return; }
      if (active.has(job.historyId)) { send(202, { historyId: job.historyId, status: 'queued' }); return; }
      if (pending >= 20) { send(503, { error: 'Import queue is full; retry later' }); return; }
      try { await (config.verifyRepository ?? (repository => verifyPublicRepository(repository, fetch, maxMb)))(job.repository); }
      catch (error) { send(400, { error: errorMessage(error) }); return; }
      if (active.has(job.historyId)) { send(202, { historyId: job.historyId, status: 'queued' }); return; }
      if (pending >= 20) { send(503, { error: 'Import queue is full; retry later' }); return; }
      pending++;
      active.add(job.historyId);
      send(202, { historyId: job.historyId, status: 'queued' });
      queue = queue.then(() => (config.runJob ?? (job => runImportJob(job, config)))(job))
        .catch(error => console.error(`Import ${job.historyId} failed: ${errorMessage(error)}`))
        .finally(() => { pending--; active.delete(job.historyId); });
    })().catch(error => { if (!response.headersSent) send(500, { error: errorMessage(error) }); else response.end(); });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const secret = process.env.IMPORT_RUNNER_SECRET;
  const callbackUrl = process.env.IMPORT_CALLBACK_URL;
  if (!secret || !callbackUrl) throw new Error('IMPORT_RUNNER_SECRET and IMPORT_CALLBACK_URL are required');
  const port = Number(process.env.PORT ?? 8788);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535');
  createImportServer({ secret, callbackUrl }).listen(port, () => console.log(`Import runner listening on port ${port}`));
}
