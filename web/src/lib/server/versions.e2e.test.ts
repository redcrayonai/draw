// @vitest-environment node
// Versions end to end: this server's code against a real database and a real S3-compatible store,
// configured with the self-host variables (SELF_HOSTING.md "Versions"). Skipped unless
// scripts/verify-versions-store-local.sh runs it with VERSIONS_E2E=1 and a store to use.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { env } from '$env/dynamic/private';
import { identityFromClaims } from '$shared/identity';
import { restoreVersion, saveVersion } from './versions';
import { getObject, putNew, signedRequest, type StoreConfig } from './object-store';

const E = process.env;
describe.skipIf(!E.VERSIONS_E2E)('versions against a real database and object store', () => {
  const BASE = E.STDB_URL!, DB = E.STDB_DB!, OWNER = E.STDB_OWNER_TOKEN!;
  const RUN = randomBytes(4).toString('hex');
  let issuer: Server;
  let store: StoreConfig;
  const b64u = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const key = () => randomBytes(24).toString('hex');
  const as = (iss: string, sub: string, claims: Record<string, unknown> = {}) => {
    const now = Math.floor(Date.now() / 1000);
    const input = `${b64u({ alg: 'ES256', typ: 'JWT', kid: 'test-issuer' })}.${b64u({ iat: now, exp: now + 900, iss, sub, ...claims })}`;
    const sig = sign('sha256', Buffer.from(input), { key: createPrivateKey(readFileSync(E.STDB_TEST_ISSUER_KEY!)), dsaEncoding: 'ieee-p1363' }).toString('base64url');
    return { token: `${input}.${sig}`, identity: identityFromClaims(iss, sub) };
  };
  const call = async (token: string, reducer: string, args: unknown[]) => {
    const r = await fetch(`${BASE}/v1/database/${DB}/call/${reducer}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(args) });
    expect(r.status, `${reducer}: ${await r.clone().text()}`).toBe(200);
  };
  const sql = async (token: string, q: string) => {
    const r = await fetch(`${BASE}/v1/database/${DB}/sql`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: q });
    const [res] = await r.json();
    const cols = res.schema.elements.map((e: { name: { some: string } }) => e.name.some);
    return res.rows.map((row: unknown[]) => Object.fromEntries(cols.map((c: string, i: number) => [c, row[i]])));
  };
  const person = () => as(E.BROWSER_ISSUER!, `user_${randomUUID()}`, { sid: `sess_${randomUUID()}`, azp: E.APP_ORIGINS!.split(',')[0] });
  const NONE = { none: [] };
  let O: { token: string; identity: string }, W: number, B: number;

  beforeAll(async () => {
    // The verify suites keep this key; a fresh test root has none yet.
    if (!existsSync(E.STDB_TEST_ISSUER_KEY!)) writeFileSync(E.STDB_TEST_ISSUER_KEY!, generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
    const jwk = { ...createPublicKey(createPrivateKey(readFileSync(E.STDB_TEST_ISSUER_KEY!))).export({ format: 'jwk' }), kid: 'test-issuer', alg: 'ES256', use: 'sig' };
    issuer = createServer((req, res) => {
      const path = new URL(req.url!, E.MCP_ORIGIN).pathname;
      const iss = E.MCP_ORIGIN + path.replace(/\/(\.well-known\/openid-configuration|jwks\.json)$/, '');
      const body = path.endsWith('openid-configuration') ? { issuer: iss, jwks_uri: `${iss}/jwks.json` } : path.endsWith('jwks.json') ? { keys: [jwk] } : null;
      res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    }).listen(Number(new URL(E.MCP_ORIGIN!).port), '127.0.0.1');
    await once(issuer, 'listening');
    const service = as(`${E.MCP_ORIGIN}/agent-id`, `service:version-e2e-${RUN}`, { aud: 'redcrayon-db' });
    await sql(OWNER, `INSERT INTO service_account (identity, label) VALUES (0x${service.identity}, 'version-e2e')`);
    Object.assign(env, {
      SPACETIMEDB_URL: BASE, SPACETIMEDB_DB: DB, SPACETIMEDB_SERVICE_TOKEN: service.token,
      VERSIONS_S3_ENDPOINT: E.VERSIONS_S3_ENDPOINT, VERSIONS_S3_BUCKET: E.VERSIONS_S3_BUCKET, VERSIONS_S3_REGION: E.VERSIONS_S3_REGION,
      VERSIONS_S3_ACCESS_KEY_ID: E.VERSIONS_S3_ACCESS_KEY_ID, VERSIONS_S3_SECRET_ACCESS_KEY: E.VERSIONS_S3_SECRET_ACCESS_KEY
    });
    store = { endpoint: env.VERSIONS_S3_ENDPOINT!, bucket: env.VERSIONS_S3_BUCKET!, region: env.VERSIONS_S3_REGION!, accessKeyId: env.VERSIONS_S3_ACCESS_KEY_ID!, secretAccessKey: env.VERSIONS_S3_SECRET_ACCESS_KEY! };
    O = person();
    await call(O.token, 'create_workspace', [`e2e-${RUN}`]);
    W = (await sql(O.token, 'SELECT * FROM my_workspaces')).find((w: { name: string }) => w.name === `e2e-${RUN}`).id;
    await call(O.token, 'set_workspace_plugin', [W, 'versions', true]);
    await call(O.token, 'create_workspace_board', [W, `board-${RUN}`, key()]);
    B = (await sql(O.token, 'SELECT * FROM my_boards')).find((b: { name: string }) => b.name === `board-${RUN}`).board_id;
    await call(O.token, 'create_node', [B, 'api', '', 0, 0, 160, 80, 'ink', false, NONE, NONE, NONE, NONE, NONE, NONE, NONE]);
    await call(O.token, 'create_chart', [B, 'p99', '', 0, 160, 352, 224, 'timeseries', 'time,p99\n10:00,40\n10:05,44\n', NONE, NONE]);
  }, 60_000);
  afterAll(() => issuer?.close());

  const labels = async (board: number | string) => (await sql(OWNER, `SELECT label FROM node WHERE board_id = ${board}`)).map((n: { label: string }) => n.label).sort();
  const boards = async () => (await sql(OWNER, 'SELECT id FROM board')).length;

  it('saves to the store, lists, and restores a new private board', async () => {
    const { versionId } = await saveVersion(O.token, BigInt(B));
    const [row] = await sql(O.token, `SELECT * FROM my_board_versions WHERE id = ${versionId}`);
    const stored = await getObject(store, row.object_key, 1 << 24);
    expect(new TextDecoder().decode(stored)).toMatch(/^\{"format":"draw.board-bundle","version":1,/);
    const restored = await restoreVersion(O.token, BigInt(versionId), key(), '');
    expect(restored.slug).not.toBe('');
    expect(await labels(restored.boardId)).toEqual(await labels(B));
    expect((await sql(OWNER, `SELECT * FROM chart WHERE board_id = ${restored.boardId}`))[0].csv).toBe('time,p99\n10:00,40\n10:05,44\n');
    expect((await sql(OWNER, `SELECT default_role FROM board_workspace WHERE board_id = ${restored.boardId}`))[0].default_role).toBe('none');
  });

  it('the store refuses a second write to a key, and the first object stays', async () => {
    const k = `versions/e2e/${RUN}/once.json`;
    expect(await putNew(store, k, new TextEncoder().encode('first'))).toBe('stored');
    expect(await putNew(store, k, new TextEncoder().encode('second'))).toBe('exists');
    expect(new TextDecoder().decode(await getObject(store, k, 100))).toBe('first');
  });

  it('a stored version corrupted at rest is refused, and no board is made', async () => {
    const { versionId } = await saveVersion(O.token, BigInt(B));
    const [row] = await sql(O.token, `SELECT * FROM my_board_versions WHERE id = ${versionId}`);
    // Bypass the guarded write, as damage at rest would.
    const body = new TextEncoder().encode(new TextDecoder().decode(await getObject(store, row.object_key, 1 << 24)).replace('"api"', '"xyz"'));
    const { url, headers } = await signedRequest(store, 'PUT', row.object_key, { body });
    expect((await fetch(url, { method: 'PUT', headers, body })).ok).toBe(true);
    const before = await boards();
    await expect(restoreVersion(O.token, BigInt(versionId), key(), '')).rejects.toMatchObject({ status: 502, message: expect.stringContaining('checksum') });
    expect(await boards()).toBe(before);
  });

  it('a store that is down saves nothing to the list', async () => {
    const listed = (await sql(O.token, 'SELECT id FROM my_board_versions')).length;
    const endpoint = env.VERSIONS_S3_ENDPOINT;
    env.VERSIONS_S3_ENDPOINT = 'http://127.0.0.1:9'; // discard port: nothing answers
    try {
      await expect(saveVersion(O.token, BigInt(B))).rejects.toMatchObject({ status: 503 });
    } finally { env.VERSIONS_S3_ENDPOINT = endpoint; }
    expect((await sql(O.token, 'SELECT id FROM my_board_versions')).length).toBe(listed);
  }, 30_000);

  it('wrong store credentials are refused by the store and list nothing', async () => {
    const secret = env.VERSIONS_S3_SECRET_ACCESS_KEY;
    env.VERSIONS_S3_SECRET_ACCESS_KEY = 'wrong-secret';
    try {
      await expect(saveVersion(O.token, BigInt(B))).rejects.toMatchObject({ status: 503 });
    } finally { env.VERSIONS_S3_SECRET_ACCESS_KEY = secret; }
  });

  it('a workspace that turned Versions off is refused before storage', async () => {
    await call(O.token, 'set_workspace_plugin', [W, 'versions', false]);
    await expect(saveVersion(O.token, BigInt(B))).rejects.toMatchObject({ status: 403, message: expect.stringContaining('plugin is off') });
    await call(O.token, 'set_workspace_plugin', [W, 'versions', true]);
  });
});
