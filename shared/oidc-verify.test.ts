import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { oidcVerifier } from './oidc-verify';

// Audience and refusal cases are covered through mcp/src/auth.test.ts (oidc).
const ISSUER = 'https://auth.example.test';
const { privateKey, publicKey } = await generateKeyPair('ES256');
const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'ES256' };
const sign = (claims: Record<string, unknown>) =>
  new SignJWT(claims).setProtectedHeader({ alg: 'ES256', kid: 'k1' }).setIssuer(ISSUER).setSubject('user_1').setExpirationTime('5m').sign(privateKey);

beforeEach(() => {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === `${ISSUER}/.well-known/openid-configuration`) return Response.json({ issuer: ISSUER, jwks_uri: `${ISSUER}/keys` });
    if (url === `${ISSUER}/keys`) return Response.json({ keys: [jwk] });
    return new Response('not found', { status: 404 });
  });
});
afterEach(() => vi.unstubAllGlobals());

it('without an audience, accepts a session token that has none', async () => {
  expect(await oidcVerifier({ issuer: ISSUER })(await sign({ sid: 's1' }))).toMatchObject({ sub: 'user_1', sid: 's1' });
});

it('with authorized parties, accepts only a listed azp', async () => {
  const verify = oidcVerifier({ issuer: ISSUER, authorizedParties: ['https://dash.example.test'] });
  expect(await verify(await sign({ azp: 'https://dash.example.test' }))).toMatchObject({ sub: 'user_1' });
  expect(await verify(await sign({ azp: 'https://elsewhere.test' }))).toBeNull();
  expect(await verify(await sign({}))).toBeNull();
});

it('a discovery that never answers does not hold the checks after it', async () => {
  // On Workers a fetch dies with the request that started it: its promise never settles.
  const real = fetch;
  let hang = true;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => (hang ? new Promise<Response>(() => {}) : real(input, init)));
  const verify = oidcVerifier({ issuer: ISSUER });
  const token = await sign({});
  const settled = (p: Promise<unknown>) => Promise.race([p.then(() => 'settled'), new Promise(r => setTimeout(() => r('pending'), 200))]);
  expect(await settled(verify(token))).toBe('pending'); // the cut-off request
  hang = false;
  expect(await settled(verify(token))).toBe('settled');
  expect(await verify(token)).toMatchObject({ sub: 'user_1' });
});
