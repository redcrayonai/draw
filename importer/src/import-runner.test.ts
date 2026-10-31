import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import * as runner from './import-runner';
import { repositoryEnvironment } from './extract-graph';

const callbackUrl = 'https://dashboard.example/api/imports/complete';
const sha = 'a'.repeat(40);
const job = { historyId: '42', repository: 'https://github.com/owner/repo', refs: [{ ref: 'main', sha, index: 0 }], callbackUrl };

test('HTTP runner authenticates and accepts only pinned public GitHub jobs', async () => {
  assert.equal(typeof runner.createImportServer, 'function');
  const accepted: unknown[] = [];
  const checked: string[] = [];
  const server = runner.createImportServer({ secret: 'test-secret', callbackUrl,
    verifyRepository: async repository => { checked.push(repository); },
    runJob: async request => { accepted.push(request); },
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/imports`;
  const post = (body: unknown, token = 'test-secret') => fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    assert.equal((await post(job, 'wrong')).status, 401);
    for (const invalid of [
      { ...job, repository: 'https://github.com.evil.test/owner/repo' },
      { ...job, repository: 'https://user:password@github.com/owner/repo' },
      { ...job, repository: 'https://github.com/owner/repo?evil=1' },
      { ...job, callbackUrl: 'http://localhost/internal' },
      { ...job, refs: [{ ref: 'main', sha: '--upload-pack=evil', index: 0 }] },
      { ...job, refs: [{ ref: 'main', sha, index: 0 }, { ref: 'again', sha, index: 0 }] },
      { ...job, refs: Array.from({ length: 11 }, (_, index) => ({ ref: 'main', sha, index })) },
    ]) assert.equal((await post(invalid)).status, 400);
    assert.deepEqual(checked, []);
    assert.equal((await post(job)).status, 202);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(accepted, [job]);
    assert.deepEqual(checked, [job.repository]);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test('public repository validation rejects private repositories and failed GitHub lookups', async () => {
  assert.equal(typeof runner.verifyPublicRepository, 'function');
  await assert.rejects(runner.verifyPublicRepository(job.repository, async () => Response.json({ private: true }) as never), /public/);
  await assert.rejects(runner.verifyPublicRepository(job.repository, async () => new Response('', { status: 404 }) as never), /GitHub/);
  const requests: string[] = [];
  await runner.verifyPublicRepository(job.repository, async input => { requests.push(String(input)); return Response.json({ private: false }); });
  assert.deepEqual(requests, ['https://api.github.com/repos/owner/repo']);
});

test('repositories over the size limit are refused before any fetch; the limit can be lifted', async () => {
  const sized = (size: number) => async () => Response.json({ private: false, size }) as never;
  await assert.rejects(runner.verifyPublicRepository(job.repository, sized(500 * 1024 + 1), 500), /larger than the 500 MB import limit/);
  await runner.verifyPublicRepository(job.repository, sized(500 * 1024), 500);
  await runner.verifyPublicRepository(job.repository, sized(10_000_000), 0);
  assert.equal(runner.maxRepositoryMb({}), 0, 'off unless REDCRAYON_LIMITS=on');
  assert.equal(runner.maxRepositoryMb({ REDCRAYON_LIMITS: 'on' }), 500);
  assert.equal(runner.maxRepositoryMb({ REDCRAYON_LIMITS: 'on', IMPORT_MAX_REPO_MB: '50' }), 50);
  assert.equal(runner.maxRepositoryMb({ REDCRAYON_LIMITS: 'off', IMPORT_MAX_REPO_MB: '50' }), 0);
  assert.throws(() => runner.maxRepositoryMb({ REDCRAYON_LIMITS: 'on', IMPORT_MAX_REPO_MB: 'lots' }), /megabytes/);
  Object.assign(process.env, { REDCRAYON_LIMITS: 'on', IMPORT_MAX_REPO_MB: 'lots' });
  try { assert.throws(() => runner.createImportServer({ secret: 'test-secret', callbackUrl }), /megabytes/, 'a typo stops the runner at start'); }
  finally { delete process.env.REDCRAYON_LIMITS; delete process.env.IMPORT_MAX_REPO_MB; }
});

test('a history already queued or running is not queued twice', async () => {
  let release!: () => void;
  const started: string[] = [];
  const server = runner.createImportServer({ secret: 'test-secret', callbackUrl,
    verifyRepository: async () => {},
    runJob: async request => { started.push(request.historyId); await new Promise<void>(resolve => { release = resolve; }); },
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/imports`;
  const post = (body: unknown) => fetch(url, { method: 'POST', headers: { authorization: 'Bearer test-secret', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    for (let i = 0; i < 25; i++) assert.equal((await post(job)).status, 202, 'repeats are accepted, not queued');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(started, ['42']);
    release();
    await new Promise<void>(resolve => setTimeout(resolve, 10));
    assert.equal((await post(job)).status, 202);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(started, ['42', '42'], 'a finished history can be retried');
    release();
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test('ref processing callbacks preserve sparse retry indexes and report complete failure state', async () => {
  assert.equal(typeof runner.runImportJob, 'function');
  const callbacks: unknown[] = [];
  const imports: string[] = [];
  const graph = { nodes: [{ key: 'js:index.ts', label: 'index.ts', sublabel: 'index.ts', kind: 'service' as const }], edges: [], files: ['index.ts'] };
  await runner.runImportJob({ ...job, refs: [{ ref: 'v1', sha, index: 2 }, { ref: 'v2', sha: 'b'.repeat(40), index: 7 }] }, {
    secret: 'test-secret', callbackUrl,
    importCommit: async (_repository, commit) => { imports.push(commit); if (commit !== sha) throw new Error('Unresolved local import ./missing'); return graph; },
    fetch: async (input, init) => {
      assert.equal(String(input), callbackUrl);
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer test-secret');
      callbacks.push(JSON.parse(String(init?.body)));
      return Response.json({ ok: true });
    },
  });
  assert.deepEqual(imports, [sha, 'b'.repeat(40)]);
  assert.deepEqual(callbacks, [
    { historyId: '42', index: 2, ref: 'v1', sha, graph },
    { historyId: '42', index: 7, ref: 'v2', sha: 'b'.repeat(40), error: 'Unresolved local import ./missing' },
    { historyId: '42', status: 'failed', error: 'v2: Unresolved local import ./missing' },
  ]);
});

test('every ref carries its own deadline, so one slow ref cannot abort the refs behind it', async () => {
  const signals: AbortSignal[] = [];
  const graph = { nodes: [], edges: [], files: [] };
  await runner.runImportJob({ ...job, refs: [{ ref: 'v1', sha, index: 0 }, { ref: 'v2', sha: 'b'.repeat(40), index: 1 }] }, {
    secret: 'test-secret', callbackUrl,
    importCommit: async (_repository, _commit, signal) => { assert.equal(signal.aborted, false); signals.push(signal); return graph; },
    fetch: async () => Response.json({ ok: true }),
  });
  assert.equal(signals.length, 2);
  // A single job-wide signal would hand the same object to both refs, and the
  // second ref would inherit whatever the first one had already spent.
  assert.notStrictEqual(signals[0], signals[1]);
});

test('callback failure does not report a ready job', async () => {
  assert.equal(typeof runner.runImportJob, 'function');
  const callbacks: Record<string, unknown>[] = [];
  await runner.runImportJob(job, { secret: 'test-secret', callbackUrl,
    importCommit: async () => ({ nodes: [], edges: [], files: [] }),
    fetch: async (_input, init) => { const body = JSON.parse(String(init?.body)); callbacks.push(body); return new Response('', { status: body.status ? 200 : 500 }); },
  });
  assert.equal(callbacks[callbacks.length - 1]?.status, 'failed');
  assert.match(String(callbacks[callbacks.length - 1]?.error), /callback/i);
});

test('repository child environment never includes runner or dashboard credentials', () => {
  const old = process.env.IMPORT_RUNNER_SECRET;
  process.env.IMPORT_RUNNER_SECRET = 'must-not-leak';
  try {
    const env = repositoryEnvironment('/tmp/job-home');
    assert.equal(env.IMPORT_RUNNER_SECRET, undefined);
    assert.equal(env.IMPORT_CALLBACK_URL, undefined);
    assert.equal(env.SPACETIME_TOKEN, undefined);
    assert.equal(env.HOME, '/tmp/job-home');
    assert.equal(env.GOAUTH, 'off');
    assert.equal(env.GOOS, 'linux');
    assert.equal(env.GOARCH, 'amd64');
    assert.equal(env.CGO_ENABLED, '0');
    assert.equal(env.GOFLAGS, '');
  } finally {
    if (old === undefined) delete process.env.IMPORT_RUNNER_SECRET;
    else process.env.IMPORT_RUNNER_SECRET = old;
  }
});
