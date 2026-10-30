import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CACHE_MAX, anyOf, apiKeys, authCacheSizes, authenticate, managedApiKeys, oidc, resetAuthCaches, sha256, type VerifyBearer } from './auth';
import { testEnv } from './test/env';

const req = (url: string, token?: string) => new Request(url, { method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {} });
const MCP = 'https://mcp.redcrayon.test/mcp';

// A verifier as a lookup table: one oauth token, and everything else unknown (session tokens, our JWTs, other issuers).
const known: VerifyBearer = async auth => {
  const token = auth.replace('Bearer ', '');
  if (token === 'tok_ok') return { userId: 'user_1', clientId: 'client_a', via: 'oauth', scopes: ['board:read', 'board:write'] };
  return null;
};

describe('token matrix at /mcp', () => {
  beforeEach(() => resetAuthCaches());

  it.each([
    ['no token', undefined, 401],
    ['a browser session token', 'sess_jwt', 401],
    ['an agent JWT we minted', 'eyJ.agent.jwt', 401],
    ['a token of another issuer', 'eyJ.other', 401],
  ])('%s is rejected', async (_name, token, status) => {
    expect(await authenticate(await testEnv(), req(MCP, token), known)).toEqual({ ok: false, status });
  });

  it('accepts what the verifier accepts, with its scopes and client', async () => {
    expect(await authenticate(await testEnv(), req(MCP, 'tok_ok'), known)).toEqual({
      ok: true,
      principal: { userId: 'user_1', clientId: 'client_a', via: 'oauth', scopes: ['board:read', 'board:write'] },
    });
  });

  it('never reads a token from the query string', async () => {
    expect(await authenticate(await testEnv(), req(`${MCP}?access_token=tok_ok`), known)).toEqual({ ok: false, status: 401 });
  });

  it('caches a verdict for 60 s, so a ban reaches the next call within 60 s', async () => {
    const check = vi.fn(known);
    const env = await testEnv();
    await authenticate(env, req(MCP, 'tok_ok'), check, 1_000);
    await authenticate(env, req(MCP, 'tok_ok'), check, 60_999);
    expect(check).toHaveBeenCalledTimes(1);
    await authenticate(env, req(MCP, 'tok_ok'), check, 61_001);
    expect(check).toHaveBeenCalledTimes(2);
  });

  it('a refused token is remembered: replaying it costs the verifier nothing for 60 s', async () => {
    const check = vi.fn(known);
    const env = await testEnv();
    await authenticate(env, req(MCP, 'tok_junk'), check, 1_000);
    expect(await authenticate(env, req(MCP, 'tok_junk'), check, 2_000)).toEqual({ ok: false, status: 401 });
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('the verdict cache is bounded: a flood of distinct junk tokens cannot grow it without limit', async () => {
    const env = await testEnv();
    // Each refused token leaves an entry, so without a sweep this is unbounded.
    for (let i = 0; i <= CACHE_MAX; i++) await authenticate(env, req(MCP, `junk_${i}`), known, 1_000);
    expect(authCacheSizes().verdicts).toBeLessThanOrEqual(CACHE_MAX);
    // All CACHE_MAX were still live, so the sweep dropped the lot: the earliest is re-asked.
    const check = vi.fn(known);
    expect(await authenticate(env, req(MCP, 'junk_0'), check, 1_000)).toEqual({ ok: false, status: 401 });
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('the sweep drops the expired entries and keeps the live ones', async () => {
    const env = await testEnv();
    // One under the cap, all expiring at 61 s, so nothing is swept yet.
    for (let i = 0; i < CACHE_MAX - 1; i++) await authenticate(env, req(MCP, `junk_${i}`), known, 1_000);
    await authenticate(env, req(MCP, 'tok_ok'), known, 62_000);
    expect(authCacheSizes().verdicts).toBe(CACHE_MAX);
    // At the cap now: this write sweeps the expired junk and leaves tok_ok alone.
    await authenticate(env, req(MCP, 'junk_last'), known, 62_100);
    expect(authCacheSizes().verdicts).toBe(2);
    const check = vi.fn(known);
    await authenticate(env, req(MCP, 'tok_ok'), check, 62_500);
    expect(check).not.toHaveBeenCalled();
  });

  it('the IP limit is spent only when the verifier would be asked', async () => {
    const env = await testEnv();
    const limited = vi.fn(async () => true);
    expect(await authenticate(env, req(MCP, 'tok_ok'), known, 1_000, limited)).toEqual({ ok: false, status: 429 });
    expect(await authenticate(env, req(MCP), known, 1_000, limited)).toEqual({ ok: false, status: 429 });
    const open = vi.fn(async () => false);
    await authenticate(env, req(MCP, 'tok_ok'), known, 1_000, open);
    await authenticate(env, req(MCP, 'tok_ok'), known, 2_000, open); // cached: no limit spent
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('the verifier down is 503, not a sign-out', async () => {
    const down: VerifyBearer = () => Promise.reject(new Error('econnreset'));
    expect(await authenticate(await testEnv(), req(MCP, 'tok_ok'), down)).toEqual({ ok: false, status: 503 });
  });

  it('DEV_AUTH maps localhost to user_dev, and only localhost', async () => {
    const env = await testEnv({ DEV_AUTH: '1' });
    expect(await authenticate(env, req('http://localhost:8788/mcp'), known)).toMatchObject({ ok: true, principal: { userId: 'user_dev' } });
    expect(await authenticate(env, req(MCP), known)).toEqual({ ok: false, status: 401 });
  });
});

describe('apiKeys (MCP_API_KEYS)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('accepts a configured key as a service with every scope, by its hash only', async () => {
    const env = await testEnv({ MCP_API_KEYS: ` ${await sha256('rk_canary')}:user_canary , ${await sha256('rk_e2e')}:user_e2e` });
    const verify = apiKeys(env);
    expect(await verify('Bearer rk_canary')).toEqual({ userId: 'user_canary', clientId: 'api_key', via: 'service', scopes: ['board:read', 'board:write'] });
    expect(await verify('Bearer rk_e2e')).toMatchObject({ userId: 'user_e2e' });
    expect(await verify('Bearer rk_other')).toBeNull();
    // The hash itself is not a key.
    expect(await verify(`Bearer ${await sha256('rk_canary')}`)).toBeNull();
  });

  it('ignores a malformed entry without logging it, and accepts nothing when unset', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const verify = apiKeys(await testEnv({ MCP_API_KEYS: 'rk_plaintext:user_x,abc:user_y' }));
    expect(await verify('Bearer rk_plaintext')).toBeNull();
    expect(error).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(error.mock.calls)).not.toContain('rk_plaintext');
    expect(await apiKeys(await testEnv())('Bearer anything')).toBeNull();
  });

  it('anyOf: the first verifier that accepts wins', async () => {
    const env = await testEnv({ MCP_API_KEYS: `${await sha256('rk_canary')}:user_canary` });
    const verify = anyOf(apiKeys(env), known);
    expect(await verify('Bearer rk_canary')).toMatchObject({ userId: 'user_canary', via: 'service' });
    expect(await verify('Bearer tok_ok')).toMatchObject({ userId: 'user_1', via: 'oauth' });
    expect(await verify('Bearer junk')).toBeNull();
  });
});

describe('managed workspace API keys', () => {
  beforeEach(() => resetAuthCaches());
  const keyId = 'a'.repeat(32);
  const token = `rcak_${keyId}_${'b'.repeat(64)}`;
  const row = async (role = 'editor') => ({ keyId, keyHash: await sha256(token), workspaceId: 12n, serviceAccountId: 3n, name: 'Build bot', role });

  it('verifies the whole secret and carries the individual key identity and narrowed scopes', async () => {
    const record = await row('viewer');
    const lookup = vi.fn(async () => record);
    const verify = managedApiKeys(lookup);
    expect(await verify(`Bearer ${token}`)).toEqual({
      userId: 'machine:3', clientId: `api_key:${keyId}`, via: 'service', scopes: ['board:read'],
      machine: { keyId, serviceAccountId: '3', workspaceId: '12', name: 'Build bot' },
    });
    expect(lookup).toHaveBeenLastCalledWith(await sha256(token));
    expect(await verify(`Bearer rcak_${'c'.repeat(32)}_${'b'.repeat(64)}`)).toBeNull();
    expect(await verify(`Bearer rcak_${keyId}_${'c'.repeat(64)}`)).toBeNull();
    expect(await verify(`Bearer ${record.keyHash}`)).toBeNull();
  });

  it('rejects expired, unknown, malformed, and non-board roles', async () => {
    const record = await row();
    const lookup = vi.fn(async () => ({ ...record, expiresAt: { microsSinceUnixEpoch: 1_000_000n } }));
    expect(await managedApiKeys(lookup, () => 1000)(`Bearer ${token}`)).toBeNull();
    expect(await managedApiKeys(async () => undefined)(`Bearer ${token}`)).toBeNull();
    expect(await managedApiKeys(async () => ({ ...record, role: 'manager' }))(`Bearer ${token}`)).toBeNull();
    lookup.mockClear();
    expect(await managedApiKeys(lookup)('Bearer rcak_bad')).toBeNull();
    expect(lookup).not.toHaveBeenCalled();
    await expect(managedApiKeys(async () => { throw new Error('database down'); })(`Bearer ${token}`)).rejects.toThrow('database down');
  });

  it('rechecks revocation and narrowing on the next request despite the normal verdict cache', async () => {
    let record: Awaited<ReturnType<typeof row>> | undefined = await row();
    const lookup = vi.fn(async () => record);
    const verify = managedApiKeys(lookup);
    const env = await testEnv();
    expect(await authenticate(env, req(MCP, token), verify, 1000)).toMatchObject({ ok: true, principal: { scopes: ['board:read', 'board:write'] } });
    record = await row('viewer');
    expect(await authenticate(env, req(MCP, token), verify, 1001)).toMatchObject({ ok: true, principal: { scopes: ['board:read'] } });
    record = undefined;
    expect(await authenticate(env, req(MCP, token), verify, 1002)).toEqual({ ok: false, status: 401 });
    expect(lookup).toHaveBeenCalledTimes(3);
    expect(authCacheSizes().verdicts).toBe(0);
  });

  it('keeps managed key permissions on the local dev stack instead of replacing them with user_dev', async () => {
    const record = await row('viewer');
    const verify = managedApiKeys(async () => record);
    expect(await authenticate(await testEnv({ DEV_AUTH: '1' }), req('http://localhost:8788/mcp', token), verify)).toMatchObject({
      ok: true, principal: { userId: 'machine:3', scopes: ['board:read'] },
    });
  });
});

describe('oidc (OIDC_ISSUER)', async () => {
  const ISSUER = 'https://auth.redcrayon.test';
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'ES256' };
  const sign = (claims: Record<string, unknown>, over: { iss?: string; aud?: string; exp?: string } = {}) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
      .setIssuer(over.iss ?? ISSUER)
      .setAudience(over.aud ?? MCP)
      .setSubject('user_1')
      .setIssuedAt()
      .setExpirationTime(over.exp ?? '5m')
      .sign(privateKey);
  let up = true;
  const fetches = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!up) throw new TypeError('fetch failed');
    if (url === `${ISSUER}/.well-known/openid-configuration`) return Response.json({ issuer: ISSUER, jwks_uri: `${ISSUER}/keys` });
    if (url === `${ISSUER}/keys`) return Response.json({ keys: [jwk] });
    return new Response('not found', { status: 404 });
  });
  beforeEach(() => {
    up = true;
    fetches.mockClear();
    vi.stubGlobal('fetch', fetches);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('accepts a JWT from the issuer for our resource, with its scopes and client', async () => {
    const verify = oidc(await testEnv());
    expect(await verify(`Bearer ${await sign({ scope: 'board:read board:write', client_id: 'client_a' })}`)).toEqual({
      userId: 'user_1',
      clientId: 'client_a',
      via: 'oauth',
      scopes: ['board:read', 'board:write'],
    });
    expect(await verify(`Bearer ${await sign({ scp: ['board:read'], azp: 'client_b' })}`)).toMatchObject({ clientId: 'client_b', scopes: ['board:read'] });
  });

  it.each([
    ['another audience (a browser session token)', { aud: 'https://app.redcrayon.test' }],
    ['another issuer', { iss: 'https://evil.test' }],
    ['an expired token', { exp: '-1m' }],
  ])('refuses %s', async (_name, over) => {
    expect(await oidc(await testEnv())(`Bearer ${await sign({ scope: 'board:read' }, over)}`)).toBeNull();
  });

  it('refuses a token signed by another key, and never fetches for a token that is not a JWT', async () => {
    const other = await generateKeyPair('ES256');
    const forged = await new SignJWT({}).setProtectedHeader({ alg: 'ES256', kid: 'k1' }).setIssuer(ISSUER).setAudience(MCP).setSubject('user_1').setExpirationTime('5m').sign(other.privateKey);
    const verify = oidc(await testEnv());
    expect(await verify('Bearer rk_canary')).toBeNull();
    expect(fetches).not.toHaveBeenCalled();
    expect(await verify(`Bearer ${forged}`)).toBeNull();
  });

  it('the issuer unreachable throws (a 503), and the next call discovers again', async () => {
    const verify = oidc(await testEnv());
    up = false;
    await expect(verify(`Bearer ${await sign({})}`)).rejects.toThrow();
    up = true;
    expect(await verify(`Bearer ${await sign({ scope: 'board:read' })}`)).toMatchObject({ userId: 'user_1' });
  });
});
