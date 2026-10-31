// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { restoreVersion, saveVersion, STORAGE_VARS } from './versions';
import { machineCredentials } from './object-store';
import { POST as SAVE } from '../../routes/api/versions/+server';
import { POST as RESTORE } from '../../routes/api/versions/[versionId]/restore/+server';
import { GET as PLUGINS } from '../../routes/api/plugins/+server';

// A fake database (the calls this plugin makes) and a fake object store that honors If-None-Match.
const sha = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');
const BUNDLE = '{"format":"draw.board-bundle","version":1,"sha256":"x","board":{"name":"é ✓ 𝄞"}}';
const KEY = 'versions/w1/b2/0190-uuid.json';
const REQUEST = 'r'.repeat(40);
let objects: Map<string, Uint8Array>;
let calls: { path: string; token: string; args: unknown }[];
let storeFails: number; // the next N store requests answer 503
let captured: Record<string, unknown>;
let creations: Record<string, unknown>[];
let versions: Record<string, unknown>[];
let refuse: Record<string, string>;
let restoreAnswer: () => Response; // what the database answers restore_board_version
let metadata: Record<string, () => Response>; // '<METHOD> <url>' of a machine's credential endpoints
let signed: Record<string, string>[]; // headers of every store request
const table = (rows: Record<string, unknown>[]) => {
  const columns = Object.keys(rows[0] ?? {});
  return new Response(JSON.stringify([{ schema: { elements: columns.map((name) => ({ name: { some: name } })) }, rows: rows.map((r) => columns.map((c) => r[c])) }]));
};
vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init: RequestInit = {}) => {
  const url = new URL(String(input));
  const token = String((init.headers as Record<string, string>)?.authorization ?? '').replace('Bearer ', '');
  if (url.hostname.startsWith('169.254.')) {
    const answer = metadata[`${init.method ?? 'GET'} ${url.href}`];
    if (!answer) throw new TypeError('fetch failed'); // nothing listens: not on this cloud
    return answer();
  }
  if (url.host === 'store.test') {
    if (storeFails > 0) { storeFails--; return new Response('busy', { status: 503 }); }
    signed.push(init.headers as Record<string, string>);
    expect((init.headers as Record<string, string>).authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=[\w-]+\/\d{8}\/test-1\/s3\/aws4_request, SignedHeaders=[a-z0-9;-]+, Signature=[0-9a-f]{64}$/);
    const key = decodeURIComponent(url.pathname.replace('/bucket/', ''));
    if (init.method === 'PUT') {
      const body = init.body as Uint8Array;
      expect((init.headers as Record<string, string>)['x-amz-content-sha256']).toBe(sha(body));
      expect((init.headers as Record<string, string>)['if-none-match']).toBe('*');
      if (objects.has(key)) return new Response('', { status: 412 });
      objects.set(key, body);
      return new Response('', { status: 200 });
    }
    const body = objects.get(key);
    return body ? new Response(body, { headers: { 'content-length': String(body.length) } }) : new Response('', { status: 404 });
  }
  const path = url.pathname.replace('/v1/database/dash/', '');
  if (path === 'sql') {
    const q = String(init.body);
    if (q.includes('my_board_creations')) return table(creations.filter((c) => q.includes(`'${c.request_key}'`)));
    if (q.includes('my_board_slugs')) return table([{ slug: 'new-slug' }]);
    if (q.includes('my_board_versions')) return table(versions);
  }
  const args = JSON.parse(String(init.body));
  calls.push({ path, token, args });
  const reducer = path.replace('call/', '');
  if (refuse[reducer]) return new Response(refuse[reducer], { status: 530 });
  if (reducer === 'capture_board_version') return new Response(JSON.stringify(JSON.stringify(captured)));
  if (reducer === 'restore_board_version') return restoreAnswer();
  return new Response('');
}));

beforeEach(() => {
  Object.assign(env, { SPACETIMEDB_URL: 'http://db.test', SPACETIMEDB_DB: 'dash', SPACETIMEDB_SERVICE_TOKEN: 'service-token',
    VERSIONS_S3_ENDPOINT: 'http://store.test', VERSIONS_S3_BUCKET: 'bucket', VERSIONS_S3_REGION: 'test-1', VERSIONS_S3_ACCESS_KEY_ID: 'key-id', VERSIONS_S3_SECRET_ACCESS_KEY: 'key-secret' });
  objects = new Map();
  calls = [];
  storeFails = 0;
  creations = [];
  refuse = {};
  metadata = {};
  signed = [];
  restoreAnswer = () => { creations.push({ request_key: REQUEST, board_id: 9 }); return new Response(JSON.stringify(JSON.stringify({ boardId: '9' }))); };
  const bytes = new TextEncoder().encode(BUNDLE);
  captured = { versionId: '5', objectKey: KEY, sha256: sha(bytes), bytes: bytes.length, bundle: BUNDLE };
  versions = [{ object_key: KEY, sha256: sha(bytes), bytes: bytes.length }];
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

const reducers = () => calls.map((c) => c.path.replace('call/', ''));

describe('save', () => {
  it('stores the captured bundle once, then publishes it as the service', async () => {
    expect(await saveVersion('user-token', 2n)).toEqual({ versionId: '5' });
    expect(new TextDecoder().decode(objects.get(KEY))).toBe(BUNDLE);
    expect(reducers()).toEqual(['capture_board_version', 'publish_board_version']);
    expect(calls[0].token).toBe('user-token');
    expect(calls[1]).toMatchObject({ token: 'service-token', args: [5, captured.sha256] });
  });

  it('retries a failing store, and lists nothing when storage stays down', async () => {
    storeFails = 2;
    await saveVersion('user-token', 2n);
    expect(objects.has(KEY)).toBe(true);
    objects.clear(); calls = []; storeFails = 99;
    await expect(saveVersion('user-token', 2n)).rejects.toMatchObject({ status: 503, message: expect.stringMatching(/^UNAVAILABLE: version storage/) });
    expect(reducers()).toEqual(['capture_board_version']);
  });

  it('never overwrites: a taken key is accepted only when it holds the same bytes', async () => {
    objects.set(KEY, new TextEncoder().encode(BUNDLE)); // an earlier try that landed
    await saveVersion('user-token', 2n);
    expect(reducers()).toContain('publish_board_version');
    calls = [];
    objects.set(KEY, new TextEncoder().encode('someone else'));
    await expect(saveVersion('user-token', 2n)).rejects.toMatchObject({ status: 409 });
    expect(new TextDecoder().decode(objects.get(KEY))).toBe('someone else');
    expect(reducers()).toEqual(['capture_board_version']);
  });

  it("passes the module's refusal on as REJECTED and stores nothing", async () => {
    captured = { error: 'version rule: the Versions plugin is off in this workspace', refused: true };
    await expect(saveVersion('user-token', 2n)).rejects.toMatchObject({ status: 403, message: 'REJECTED: version rule: the Versions plugin is off in this workspace' });
    expect(objects.size).toBe(0);
  });

  it('reports a failed capture as unavailable, not as a refusal', async () => {
    captured = { error: 'the transaction could not commit', refused: false };
    await expect(saveVersion('user-token', 2n)).rejects.toMatchObject({ status: 503, message: expect.stringMatching(/^UNAVAILABLE:/) });
  });

  it('says so when a stored version cannot be listed', async () => {
    refuse.publish_board_version = 'version rule: the person saving this version lost edit access before it was stored';
    await expect(saveVersion('user-token', 2n)).rejects.toMatchObject({ status: 403, message: expect.stringContaining('stays unlisted') });
  });

  it('refuses a damaged capture', async () => {
    captured = { ...captured, sha256: 'f'.repeat(64) };
    await expect(saveVersion('user-token', 2n)).rejects.toMatchObject({ status: 502 });
    expect(objects.size).toBe(0);
  });
});

describe('restore', () => {
  beforeEach(() => objects.set(KEY, new TextEncoder().encode(BUNDLE)));

  it('checks the stored bytes, stages them and restores as the caller', async () => {
    expect(await restoreVersion('user-token', 5n, REQUEST, '')).toEqual({ boardId: '9', slug: 'new-slug' });
    expect(reducers()).toEqual(['stage_board_version_chunk', 'stage_board_version_chunk', 'restore_board_version']);
    expect(calls.every((c) => c.token === 'user-token')).toBe(true);
    expect(calls[0].args).toEqual([5, REQUEST, 0, '']); // the rights check, before the download
    expect(calls[1].args).toEqual([5, REQUEST, 0, BUNDLE]);
  });

  it('a retry with the same request key returns the first board without staging again', async () => {
    creations.push({ request_key: REQUEST, board_id: 9 });
    expect(await restoreVersion('user-token', 5n, REQUEST, '')).toEqual({ boardId: '9', slug: 'new-slug' });
    expect(calls).toEqual([]);
  });

  it('refuses a corrupt, missing or hidden version before any board exists', async () => {
    objects.set(KEY, new TextEncoder().encode(BUNDLE.replace('é', 'e')));
    await expect(restoreVersion('user-token', 5n, REQUEST, '')).rejects.toMatchObject({ status: 502, message: expect.stringContaining('does not match its checksum') });
    objects.delete(KEY);
    await expect(restoreVersion('user-token', 5n, REQUEST, '')).rejects.toMatchObject({ status: 502, message: expect.stringContaining('missing from storage') });
    versions = [];
    await expect(restoreVersion('user-token', 5n, REQUEST, '')).rejects.toMatchObject({ status: 404 });
    expect(reducers()).not.toContain('restore_board_version');
    expect(calls.every((c) => (c.args as unknown[])[3] === '')).toBe(true);
  });

  it('sends a large bundle in pieces under the call limit without splitting a character', async () => {
    const big = `${'𝄞'.repeat(400_000)}x${'é'.repeat(300_000)}`;
    const bytes = new TextEncoder().encode(big);
    objects.set(KEY, bytes);
    versions = [{ object_key: KEY, sha256: sha(bytes), bytes: bytes.length }];
    await restoreVersion('user-token', 5n, REQUEST, 'Copy');
    const pieces = calls.filter((c) => c.path.endsWith('stage_board_version_chunk')).map((c) => (c.args as unknown[])[3] as string);
    expect(pieces.join('')).toBe(big);
    for (const p of pieces) {
      expect(new TextEncoder().encode(JSON.stringify(p)).length).toBeLessThan(2 * 1024 * 1024);
      expect(p.isWellFormed()).toBe(true);
    }
    expect(calls.at(-1)?.args).toEqual([5, REQUEST, 'Copy']);
  });

  it("refuses a caller without restore rights before downloading anything", async () => {
    refuse.stage_board_version_chunk = 'version rule: restoring needs edit access to the board';
    const fetched = vi.mocked(fetch).mock.calls.length;
    await expect(restoreVersion('user-token', 5n, REQUEST, '')).rejects.toMatchObject({ status: 403, message: 'REJECTED: version rule: restoring needs edit access to the board' });
    expect(vi.mocked(fetch).mock.calls.slice(fetched).some(([url]) => String(url).startsWith('http://store.test'))).toBe(false);
  });

  it('passes a refused restore on as REJECTED', async () => {
    restoreAnswer = () => new Response(JSON.stringify(JSON.stringify({ error: 'version rule: this version cannot be restored: bundle rule: x', refused: true })));
    await expect(restoreVersion('user-token', 5n, REQUEST, '')).rejects.toMatchObject({ status: 403, message: expect.stringContaining('cannot be restored') });
  });

  it('reports the board when the restore answer is lost, and UNCONFIRMED when there is none', async () => {
    restoreAnswer = () => { creations.push({ request_key: REQUEST, board_id: 9 }); return new Response('gateway timeout', { status: 504 }); };
    expect(await restoreVersion('user-token', 5n, REQUEST, '')).toEqual({ boardId: '9', slug: 'new-slug' });
    creations = [];
    restoreAnswer = () => new Response('gateway timeout', { status: 504 });
    await expect(restoreVersion('user-token', 5n, REQUEST, '')).rejects.toMatchObject({ status: 503, message: expect.stringMatching(/^UNCONFIRMED:/) });
  });
});

describe('a machine role instead of keys', () => {
  const role = (id: string, token: string) => () => Response.json({ AccessKeyId: id, SecretAccessKey: `${id}-secret`, Token: token, Expiration: new Date(Date.now() + 3_600_000).toISOString() });
  beforeEach(() => { env.VERSIONS_S3_ACCESS_KEY_ID = ''; env.VERSIONS_S3_SECRET_ACCESS_KEY = ''; });

  it('offers Versions with both keys or neither, never one', async () => {
    const offered = async () => (await (await PLUGINS({} as never)).json()).plugins[0].available;
    expect(await offered()).toBe(true);
    env.VERSIONS_S3_ACCESS_KEY_ID = 'key-id';
    expect(await offered()).toBe(false);
    env.VERSIONS_S3_ACCESS_KEY_ID = '  ';
    expect(await offered()).toBe(true); // blank is unset
  });

  it('refuses at once, naming the setup, when the machine has no role to give', async () => {
    await expect(saveVersion('user-token', 2n)).rejects.toMatchObject({ status: 503, message: expect.stringContaining('refused this server') });
    expect(vi.mocked(fetch).mock.calls.filter(([u]) => String(u).includes('169.254.')).length).toBe(1); // not retried as an outage
    expect(vi.mocked(console.warn).mock.calls.some(([line]) => String(line).includes('no machine role answered'))).toBe(true);
    expect(objects.size).toBe(0);
    expect(calls.map((c) => c.path)).not.toContain('call/publish_board_version');
  });

  it('signs with an ECS task role and its session token', async () => {
    env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI = '/v2/credentials/task';
    metadata['GET http://169.254.170.2/v2/credentials/task'] = role('ECS-ROLE', 'ecs-session');
    try { await saveVersion('user-token', 2n); } finally { env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI = ''; }
    expect(signed[0].authorization).toContain('Credential=ECS-ROLE/');
    expect(signed[0].authorization).toContain('x-amz-security-token');
    expect(signed[0]['x-amz-security-token']).toBe('ecs-session');
    expect(objects.has(KEY)).toBe(true);
  });

  it('reads an EC2 instance profile through IMDSv2 and keeps it until near expiry', async () => {
    const imds = 'http://169.254.169.254/latest';
    metadata[`PUT ${imds}/api/token`] = () => new Response('imds-token');
    metadata[`GET ${imds}/meta-data/iam/security-credentials/`] = () => new Response('draw-versions\n');
    metadata[`GET ${imds}/meta-data/iam/security-credentials/draw-versions`] = role('EC2-ROLE', 'ec2-session');
    const later = Date.now() + 2 * 3_600_000; // past the cached task role
    expect(await machineCredentials({}, later)).toEqual({ accessKeyId: 'EC2-ROLE', secretAccessKey: 'EC2-ROLE-secret', sessionToken: 'ec2-session' });
    const fetched = vi.mocked(fetch).mock.calls.length;
    metadata = {};
    expect((await machineCredentials({})).accessKeyId).toBe('EC2-ROLE');
    expect(vi.mocked(fetch).mock.calls.length).toBe(fetched);
  });
});

describe('routes', () => {
  const url = new URL('http://dash.test/api/versions');
  const post = (body: unknown, token = 'user-token') => new Request('http://dash.test/api/versions', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) });

  it('offer Versions only when the operator configured all of it', async () => {
    expect(await (await PLUGINS({} as never)).json()).toEqual({ plugins: [expect.objectContaining({ id: 'versions', available: true })] });
    for (const name of STORAGE_VARS) {
      const saved = env[name];
      env[name] = ' ';
      expect((await (await PLUGINS({} as never)).json()).plugins[0].available).toBe(false);
      const r = await SAVE({ request: post({ boardId: '2' }), url } as never);
      expect(r.status).toBe(503);
      expect(JSON.stringify(await r.json())).not.toMatch(/VERSIONS_|SPACETIME|secret/i);
      env[name] = saved;
    }
  });

  it('a server missing its database settings still offers Versions, refuses saves, and logs what is missing', async () => {
    env.SPACETIMEDB_SERVICE_TOKEN = '';
    expect((await (await PLUGINS({} as never)).json()).plugins[0].available).toBe(true);
    const r = await SAVE({ request: post({ boardId: '2' }), url } as never);
    expect(r.status).toBe(503);
    expect(JSON.stringify(await r.json())).not.toMatch(/SPACETIME|TOKEN/i);
    expect(vi.mocked(console.error).mock.calls.some(([line]) => String(line).includes('SPACETIMEDB_SERVICE_TOKEN'))).toBe(true);
  });

  it('save and restore validate their input', async () => {
    expect((await SAVE({ request: post({ boardId: 2 }), url } as never)).status).toBe(400);
    expect((await SAVE({ request: new Request('http://dash.test/api/versions', { method: 'POST', body: '{"boardId":"2"}' }), url } as never)).status).toBe(401);
    expect((await SAVE({ request: post({ boardId: '2' }), url } as never)).status).toBe(201);
    objects.clear();
    objects.set(KEY, new TextEncoder().encode(BUNDLE));
    expect((await RESTORE({ request: post({ requestKey: 'short' }), params: { versionId: '5' }, url } as never)).status).toBe(400);
    expect((await RESTORE({ request: post({ requestKey: REQUEST }), params: { versionId: 'x' }, url } as never)).status).toBe(400);
    expect((await SAVE({ request: post({ boardId: '2' }), url: new URL('http://dash.test/api/versions?db=other') } as never)).status).toBe(400);
    const r = await RESTORE({ request: post({ requestKey: REQUEST, name: 'Copy' }), params: { versionId: '5' }, url } as never);
    expect(r.status).toBe(201);
    expect(await r.json()).toEqual({ boardId: '9', slug: 'new-slug' });
  });
});
