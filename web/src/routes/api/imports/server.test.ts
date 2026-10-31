// @vitest-environment node
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { identityFromClaims } from '$shared/identity';
import { env } from '$env/dynamic/private';
import { POST } from './+server';
import { GET } from './refs/+server';
import { POST as RETRY } from './[historyId]/retry/+server';
import { POST as COMPLETE } from './complete/+server';

const ISS = 'https://auth.example.test';
const { privateKey, publicKey } = await generateKeyPair('ES256');
const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'ES256' };
const session = (over: { iss?: string; azp?: string } = {}) =>
  new SignJWT({ azp: over.azp ?? 'https://dash.test' }).setProtectedHeader({ alg: 'ES256', kid: 'k1' }).setIssuer(over.iss ?? ISS).setSubject('user_1').setExpirationTime('5m').sign(privateKey);
const USER = await session();
const OWNER = identityFromClaims(ISS, 'user_1');
const COWORKER = identityFromClaims(ISS, 'user_2');
const fetchMock = vi.fn();
let issuerUp = true;
// The issuer's discovery and keys answer outside fetchMock, so session tokens verify for real.
vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith(ISS) && !issuerUp) throw new TypeError('fetch failed');
  if (url === `${ISS}/.well-known/openid-configuration`) return Response.json({ issuer: ISS, jwks_uri: `${ISS}/keys` });
  if (url === `${ISS}/keys`) return Response.json({ keys: [jwk] });
  return fetchMock(input, init);
});
const SHA = 'a'.repeat(40);
const NEXT = 'b'.repeat(40);
const REPO = 'https://github.com/acme/payments';
const table = (rows: Record<string, unknown>[]) => {
  const columns = Object.keys(rows[0] ?? {});
  return new Response(JSON.stringify([{ schema: { elements: columns.map((name) => ({ name: { some: name } })) }, rows: rows.map((r) => columns.map((c) => r[c])) }]));
};
const pinned = [{ ref: 'main', sha: SHA }, { ref: 'v1', sha: NEXT }];
let histories: Record<string, unknown>[];
let completed: Record<string, unknown>[];
let runnerStatus: number;
let publishOnDispatch: boolean;
let createdHistory: Record<string, unknown>;
let readableHistories: Record<string, unknown>[];
const history = () => ({ id: 7, owner: { __identity__: `0x${OWNER}` }, name: 'payments', repository: REPO, refs_json: JSON.stringify(pinned), request_key: 'request-1', status: 'failed' });

beforeEach(() => {
  Object.assign(env, { SPACETIMEDB_URL: 'http://stdb.test', SPACETIMEDB_DB: 'dash', SPACETIMEDB_SERVICE_TOKEN: 'service-token', IMPORT_RUNNER_URL: 'http://runner.test', IMPORT_RUNNER_SECRET: 'runner-secret', IMPORT_CALLBACK_URL: 'https://dash.test/api/imports/complete', OIDC_ISSUER: ISS, OIDC_AUTHORIZED_PARTIES: 'https://dash.test', IMPORTS_ANONYMOUS: '' });
  issuerUp = true;
  histories = [history()];
  createdHistory = history();
  readableHistories = [];
  completed = [];
  runnerStatus = 202;
  publishOnDispatch = false;
  fetchMock.mockReset().mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === 'https://api.github.com/repos/acme/payments') return Response.json({ private: false, default_branch: 'main' });
    if (url.includes('/commits/')) return Response.json({ sha: url.endsWith('/main') ? SHA : NEXT });
    if (url.includes('/branches?')) return Response.json([{ name: 'main', commit: { sha: SHA } }]);
    if (url.includes('/tags?')) return Response.json([{ name: 'v1', commit: { sha: NEXT } }]);
    if (url === 'http://runner.test/imports') {
      if (publishOnDispatch) completed = pinned.map((_, index) => ({ index, assertion_mode: 'fact' }));
      return new Response(null, { status: runnerStatus });
    }
    if (url.endsWith('/sql')) {
      if (String(init?.body).includes('my_architecture_histories')) return table(histories);
      if (String(init?.body).includes('visible_architecture_history')) return table(readableHistories.length ? readableHistories : histories);
      if (String(init?.body).includes('visible_architecture_version')) return table(completed);
    }
    if (url.endsWith('/call/create_architecture_history') || url.endsWith('/call/create_workspace_architecture_history')) {
      histories = [...histories, createdHistory];
      return new Response(null, { status: 200 });
    }
    if (url.includes('/call/')) return new Response(null, { status: 200 });
    throw new Error(`Unexpected URL: ${url}`);
  });
});

async function invoke<T>(handler: (event: T) => Response | Promise<Response>, path: string, body?: unknown, token: string | null = USER) {
  const url = new URL(`https://dash.test${path}`);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const request = new Request(url, { method: body === undefined ? 'GET' : 'POST', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const response = await handler({ request, url, params: { historyId: '7' } } as unknown as T);
  return { status: response.status, body: await response.json() };
}
const calls = (suffix: string) => fetchMock.mock.calls.filter(([url]) => String(url).endsWith(suffix));

describe('GitHub imports', () => {
  it('pins ordered refs before caller-owned creation and dispatches only the runner secret', async () => {
    histories = [];
    expect(await invoke(POST, '/api/imports', { repository: `${REPO}.git/`, refs: ['main', 'v1'], requestKey: 'request-1' })).toEqual({ status: 202, body: { historyId: '7' } });
    const [, create] = calls('/call/create_architecture_history')[0];
    expect(create.headers.authorization).toBe(`Bearer ${USER}`);
    expect(JSON.parse(create.body)).toEqual(['payments', REPO, JSON.stringify(pinned), 'request-1']);
    const [, dispatch] = calls('/imports')[0];
    expect(dispatch.headers.authorization).toBe('Bearer runner-secret');
    expect(JSON.parse(dispatch.body)).toEqual({ historyId: '7', repository: REPO, refs: pinned.map((r, index) => ({ ...r, index })), callbackUrl: env.IMPORT_CALLBACK_URL });
    expect(dispatch.body).not.toContain(USER);
  });

  it('lists public branches and tags and refuses private repositories', async () => {
    expect(await invoke(GET, `/api/imports/refs?repository=${encodeURIComponent(REPO)}`)).toEqual({ status: 200, body: { repository: REPO, refs: [pinned[0], { ...pinned[1], ref: 'refs/tags/v1' }], defaultRef: 'main' } });
    fetchMock.mockResolvedValueOnce(Response.json({ private: true }));
    expect((await invoke(GET, `/api/imports/refs?repository=${encodeURIComponent(REPO)}`)).status).toBe(400);
  });

  it('needs a session token on every route, so reads cannot spend the GitHub budget anonymously', async () => {
    expect(await invoke(GET, `/api/imports/refs?repository=${encodeURIComponent(REPO)}`, undefined, null))
      .toEqual({ status: 401, body: { error: 'Sign in again: this request had no session token.' } });
    expect((await invoke(POST, '/api/imports', { repository: REPO, refs: ['main'], requestKey: 'r' }, null)).status).toBe(401);
    expect((await invoke(RETRY, '/api/imports/7/retry', {}, null)).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses tokens that are not the issuer's session for this dashboard, such as anonymous DB tokens", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await invoke(GET, `/api/imports/refs?repository=${encodeURIComponent(REPO)}`, undefined, 'x')).status).toBe(401);
    expect((await invoke(POST, '/api/imports', { repository: REPO, refs: ['main'], requestKey: 'r' }, 'anonymous-db-token')).status).toBe(401);
    expect((await invoke(RETRY, '/api/imports/7/retry', {}, 'anonymous-db-token')).status).toBe(401);
    expect((await invoke(GET, `/api/imports/refs?repository=${encodeURIComponent(REPO)}`, undefined, await session({ iss: 'https://other.example.test' }))).status).toBe(401);
    expect((await invoke(GET, `/api/imports/refs?repository=${encodeURIComponent(REPO)}`, undefined, await session({ azp: 'https://elsewhere.test' })))).toEqual({
      status: 401,
      body: { error: 'Your session expired. Reload the page or sign in again.' }
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers 503, not 401, when the issuer cannot be reached', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    env.OIDC_ISSUER = `${ISS}/`; // a new verifier, so it has to discover the keys again
    issuerUp = false;
    expect(await invoke(GET, `/api/imports/refs?repository=${encodeURIComponent(REPO)}`)).toEqual({
      status: 503,
      body: { error: 'Sign-in could not be checked right now. Try again shortly.' }
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses every user route on a deployment without accounts unless anonymous imports are on', async () => {
    env.OIDC_ISSUER = '';
    const refused = { status: 403, body: { error: 'Repository imports need sign-in on this deployment. Ask the deployment owner to set it up.' } };
    expect(await invoke(GET, `/api/imports/refs?repository=${encodeURIComponent(REPO)}`, undefined, 'x')).toEqual(refused);
    expect(await invoke(POST, '/api/imports', { repository: REPO, refs: ['main', 'v1'], requestKey: 'request-1' }, 'anonymous-db-token')).toEqual(refused);
    expect(await invoke(RETRY, '/api/imports/7/retry', {}, 'anonymous-db-token')).toEqual(refused);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('takes any token with IMPORTS_ANONYMOUS=1 on a deployment without accounts: the database checks it', async () => {
    env.OIDC_ISSUER = '';
    env.IMPORTS_ANONYMOUS = '1';
    const anonymous = await new SignJWT({}).setProtectedHeader({ alg: 'ES256', kid: 'k1' }).setIssuer('localhost').setSubject('anonymous').setExpirationTime('5m').sign(privateKey);
    histories[0].owner = { __identity__: `0x${identityFromClaims('localhost', 'anonymous')}` };
    expect((await invoke(GET, `/api/imports/refs?repository=${encodeURIComponent(REPO)}`, undefined, anonymous)).status).toBe(200);
    expect((await invoke(POST, '/api/imports', { repository: REPO, refs: ['main', 'v1'], requestKey: 'request-1' }, anonymous)).status).toBe(202);
    expect(calls('/sql')[0][1].headers.authorization).toBe(`Bearer ${anonymous}`);
  });

  it('answers 503 on every user route before checking the session when the runner is not configured', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    env.IMPORT_RUNNER_URL = '';
    expect((await invoke(GET, `/api/imports/refs?repository=${encodeURIComponent(REPO)}`, undefined, null)).status).toBe(503);
    expect((await invoke(POST, '/api/imports', { repository: REPO, refs: ['main'], requestKey: 'r' }, null)).status).toBe(503);
    expect((await invoke(RETRY, '/api/imports/7/retry', {}, null)).status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports GitHub 422 for a missing ref as an input error without creating a job', async () => {
    fetchMock.mockResolvedValueOnce(table([]))
      .mockResolvedValueOnce(Response.json({ private: false, default_branch: 'main' }))
      .mockResolvedValueOnce(Response.json({ message: 'No commit found for SHA: missing-ref' }, { status: 422 }));
    expect(await invoke(POST, '/api/imports', { repository: REPO, refs: ['missing-ref'], requestKey: 'missing' })).toEqual({
      status: 400,
      body: { error: 'GitHub could not find this public repository or ref. Check the URL and selected refs.' }
    });
    expect(calls('/call/create_architecture_history')).toHaveLength(0);
    expect(calls('/imports')).toHaveLength(0);
  });

  it('rejects non-GitHub URLs and more than ten refs before network work', async () => {
    expect((await invoke(POST, '/api/imports', { repository: 'https://example.test/acme/payments', refs: ['main'], requestKey: 'r' })).status).toBe(400);
    expect((await invoke(POST, '/api/imports', { repository: REPO, refs: Array.from({ length: 11 }, (_, n) => `r${n}`), requestKey: 'r' })).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses dashboard database overrides before reading or creating jobs', async () => {
    expect((await invoke(POST, '/api/imports?db=another-db', { repository: REPO, refs: ['main'], requestKey: 'r' })).status).toBe(400);
    expect((await invoke(RETRY, '/api/imports/7/retry?db=another-db', {})).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps pinned commits for a repeated request but rejects reused keys with different inputs', async () => {
    expect((await invoke(POST, '/api/imports', { repository: REPO, refs: ['main', 'v1'], requestKey: 'request-1' })).status).toBe(202);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('github.com'))).toBe(false);
    expect((await invoke(POST, '/api/imports', { repository: REPO, refs: ['new-ref'], requestKey: 'request-1' })).status).toBe(409);
  });

  it('fails with actionable setup guidance before creating when the runner is missing', async () => {
    env.IMPORT_RUNNER_URL = '';
    const result = await invoke(POST, '/api/imports', { repository: REPO, refs: ['main'], requestKey: 'r' });
    expect(result.status).toBe(503);
    expect(result.body.error).toMatch(/import runner/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('persists failed dispatch on the history job', async () => {
    runnerStatus = 503;
    expect((await invoke(POST, '/api/imports', { repository: REPO, refs: ['main', 'v1'], requestKey: 'request-1' })).status).toBe(502);
    const [, status] = calls('/call/set_architecture_import_status').at(-1)!;
    expect(status.headers.authorization).toBe('Bearer service-token');
    expect(JSON.parse(status.body)).toEqual([7, 'failed', expect.stringMatching(/runner/i)]);
  });

  it('keeps ready when all snapshots publish before a dispatch error arrives', async () => {
    runnerStatus = 503;
    publishOnDispatch = true;
    expect((await invoke(RETRY, '/api/imports/7/retry', {})).status).toBe(202);
    expect(JSON.parse(calls('/call/set_architecture_import_status').at(-1)![1].body)).toEqual([7, 'ready', '']);
  });

  it('retries only unfinished pinned refs without consulting GitHub', async () => {
    completed = [{ index: 0, assertion_mode: 'fact' }];
    expect(await invoke(RETRY, '/api/imports/7/retry', {})).toEqual({ status: 202, body: { historyId: '7' } });
    const [, dispatch] = calls('/imports')[0];
    expect(JSON.parse(dispatch.body).refs).toEqual([{ ref: 'v1', sha: NEXT, index: 1 }]);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('github.com'))).toBe(false);
  });

  it('allows recovering a running job after the runner restarts', async () => {
    histories[0].status = 'running';
    completed = [{ index: 0, assertion_mode: 'fact' }];
    expect((await invoke(RETRY, '/api/imports/7/retry', {})).status).toBe(202);
    expect(JSON.parse(calls('/imports')[0][1].body).refs).toEqual([{ ref: 'v1', sha: NEXT, index: 1 }]);
  });

  it('refuses a retry when the owner-filtered view does not include the job', async () => {
    histories = [];
    expect((await invoke(RETRY, '/api/imports/7/retry', {})).status).toBe(403);
    expect(calls('/imports')).toHaveLength(0);
  });

  it('accepts valid callbacks as the service and rejects mismatched commits', async () => {
    const graph = { nodes: [{ key: 'js:a.ts', label: 'a', sublabel: '', kind: 'service' }], edges: [], files: ['a.ts'] };
    expect(await invoke(COMPLETE, '/api/imports/complete', { historyId: '7', index: 0, ref: 'main', sha: SHA, graph }, 'runner-secret')).toEqual({ status: 200, body: { ok: true } });
    const [, publish] = calls('/call/publish_architecture_snapshot')[0];
    expect(publish.headers.authorization).toBe('Bearer service-token');
    expect(JSON.parse(publish.body)).toEqual([7, 0, 'main', SHA, JSON.stringify(graph)]);
    expect((await invoke(COMPLETE, '/api/imports/complete', { historyId: '7', index: 0, ref: 'main', sha: NEXT, graph }, 'runner-secret')).status).toBe(400);
    expect(calls('/call/publish_architecture_snapshot')).toHaveLength(1);
  });

  it('requires callback credentials and validates graphs before publishing', async () => {
    const body = { historyId: '7', index: 0, ref: 'main', sha: SHA, graph: { nodes: [], edges: [{ from: 'absent', to: 'absent', label: '', relation: 'imports', evidence: 'import' }], files: [] } };
    expect((await invoke(COMPLETE, '/api/imports/complete', body)).status).toBe(401);
    expect((await invoke(COMPLETE, '/api/imports/complete', body, 'runner-secreT')).status).toBe(401);
    expect((await invoke(COMPLETE, '/api/imports/complete', body, 'runner-secret')).status).toBe(400);
    expect(calls('/call/publish_architecture_snapshot')).toHaveLength(0);
  });

  it('records final runner status using service credentials', async () => {
    expect(await invoke(COMPLETE, '/api/imports/complete', { historyId: '7', status: 'failed', error: 'v1 could not be parsed' }, 'runner-secret')).toEqual({ status: 200, body: { ok: true } });
    const [, status] = calls('/call/set_architecture_import_status')[0];
    expect(status.headers.authorization).toBe('Bearer service-token');
    expect(JSON.parse(status.body)).toEqual([7, 'failed', 'v1 could not be parsed']);
  });

  it('marks a failed job partial when snapshots exist and refuses premature ready callbacks', async () => {
    completed = [{ index: 0, assertion_mode: 'fact' }];
    expect((await invoke(COMPLETE, '/api/imports/complete', { historyId: '7', status: 'failed', error: 'v1 failed' }, 'runner-secret')).status).toBe(200);
    expect(JSON.parse(calls('/call/set_architecture_import_status')[0][1].body)).toEqual([7, 'partial', 'v1 failed']);
    expect((await invoke(COMPLETE, '/api/imports/complete', { historyId: '7', status: 'ready', error: '' }, 'runner-secret')).status).toBe(400);
  });

  it('keeps fully published histories ready when stale failure callbacks arrive', async () => {
    histories[0].status = 'ready';
    completed = pinned.map((_, index) => ({ index, assertion_mode: 'fact' }));
    expect((await invoke(COMPLETE, '/api/imports/complete', { historyId: '7', status: 'failed', error: 'The callback response was lost.' }, 'runner-secret')).status).toBe(200);
    expect((await invoke(COMPLETE, '/api/imports/complete', { historyId: '7', index: 0, ref: 'main', sha: SHA, error: 'The callback response was lost.' }, 'runner-secret')).status).toBe(200);
    expect(calls('/call/set_architecture_import_status').map(([, init]) => JSON.parse(init.body))).toEqual([[7, 'ready', ''], [7, 'ready', '']]);
  });

  it('ignores a stale ref failure when that snapshot is already published', async () => {
    histories[0].status = 'running';
    completed = [{ index: 0, assertion_mode: 'fact' }];
    expect((await invoke(COMPLETE, '/api/imports/complete', { historyId: '7', index: 0, ref: 'main', sha: SHA, error: 'Response lost after commit.' }, 'runner-secret')).status).toBe(200);
    expect(calls('/call/set_architecture_import_status')).toHaveLength(0);
  });
});


describe('workspace import destinations', () => {
  it('creates the import directly in its workspace using an exact u64 id', async () => {
    histories = [];
    const result = await invoke(POST, '/api/imports', { repository: REPO, refs: ['main', 'v1'], requestKey: 'request-1', workspaceId: '18446744073709551615' });
    expect(result.status).toBe(202);
    expect(calls('/call/create_architecture_history')).toHaveLength(0);
    const [, create] = calls('/call/create_workspace_architecture_history')[0];
    expect(create.body).toBe(`[18446744073709551615,"payments","${REPO}",${JSON.stringify(JSON.stringify(pinned))},"request-1"]`);
    expect(create.headers.authorization).toBe(`Bearer ${USER}`);
  });
  it('rejects malformed workspace ids before reading jobs or calling GitHub', async () => {
    for (const workspaceId of ['0', '-1', '1.5', '18446744073709551616', 4]) {
      expect((await invoke(POST, '/api/imports', { repository: REPO, refs: ['main'], requestKey: 'request-1', workspaceId })).status).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('asks the core to verify the workspace on a repeated request without re-pinning refs', async () => {
    const result = await invoke(POST, '/api/imports', { repository: REPO, refs: ['main', 'v1'], requestKey: 'request-1', workspaceId: '4' });
    expect(result.status).toBe(202);
    expect(calls('/call/create_workspace_architecture_history')).toHaveLength(1);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('github.com'))).toBe(false);
  });
});


describe('import creation authority', () => {
  it.each([undefined, '4'])('keeps request-key collisions creator-scoped for destination %s', async workspaceId => {
    histories = [{ ...history(), owner: { __identity__: `0x${COWORKER}` } }];
    createdHistory = { ...history(), id: 8 };
    const result = await invoke(POST, '/api/imports', { repository: REPO, refs: ['main', 'v1'], requestKey: 'request-1', ...(workspaceId ? { workspaceId } : {}) });
    expect(result).toEqual({ status: 202, body: { historyId: '8' } });
    expect(calls(`/call/${workspaceId ? 'create_workspace_architecture_history' : 'create_architecture_history'}`)).toHaveLength(1);
    expect(JSON.parse(calls('/imports')[0][1].body).historyId).toBe('8');
  });
  it('does not reject a reused key because a coworker supplied different import inputs', async () => {
    histories = [{ ...history(), name: 'Coworker import', owner: { __identity__: `0x${COWORKER}` } }];
    createdHistory = { ...history(), id: 8 };
    expect(await invoke(POST, '/api/imports', { repository: REPO, refs: ['main', 'v1'], requestKey: 'request-1', workspaceId: '4' })).toEqual({ status: 202, body: { historyId: '8' } });
  });
  it('reuses only the caller history when a coworker matching key appears first', async () => {
    histories = [{ ...history(), id: 8, name: 'Coworker import', owner: { __identity__: `0x${COWORKER}` } }, history()];
    expect(await invoke(POST, '/api/imports', { repository: REPO, refs: ['main', 'v1'], requestKey: 'request-1' })).toEqual({ status: 202, body: { historyId: '7' } });
    expect(calls('/call/create_architecture_history')).toHaveLength(0);
    expect(JSON.parse(calls('/imports')[0][1].body).historyId).toBe('7');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('github.com'))).toBe(false);
  });
  it('allows a manager to retry a coworker history returned by the management view', async () => {
    histories = [{ ...history(), owner: { __identity__: `0x${COWORKER}` } }];
    expect(await invoke(RETRY, '/api/imports/7/retry', {})).toEqual({ status: 202, body: { historyId: '7' } });
    expect(JSON.parse(calls('/imports')[0][1].body).historyId).toBe('7');
  });
  it('does not dispatch a readable history absent from the management view', async () => {
    histories = [];
    readableHistories = [history()];
    expect((await invoke(RETRY, '/api/imports/7/retry', {})).status).toBe(403);
    expect(calls('/imports')).toHaveLength(0);
    expect(calls('/call/set_architecture_import_status')).toHaveLength(0);
    expect(fetchMock.mock.calls.filter(([, init]) => String(init?.body).includes('visible_architecture_history'))).toHaveLength(0);
  });
});
