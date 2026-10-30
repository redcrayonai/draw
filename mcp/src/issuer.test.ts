import { describe, expect, it } from 'vitest';
import { identityFromClaims } from '../../shared/identity';
import { AUDIENCE, TOKEN_TTL_S, discovery, jwks, mint, principalSubject } from './issuer';
import { newJwk, testEnv } from './test/env';

const decode = (part: string) => JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));

describe('our issuer', () => {
  it('keeps managed keys distinct from human agents and from each other', () => {
    const person = { userId: 'user_1' };
    expect(principalSubject(person as never)).toBe('agent:user_1');
    expect(principalSubject({ ...person, machine: { keyId: 'key_a' } } as never)).toBe('machine:key_a');
    expect(principalSubject({ ...person, machine: { keyId: 'key_b' } } as never)).toBe('machine:key_b');
  });
  it('signs ES256 JWTs the published JWKS verifies, with the agent claims', async () => {
    const env = await testEnv();
    const now = Date.UTC(2026, 9, 10);
    const token = await mint(env, 'agent:user_1', now);
    const [h, p, s] = token.split('.');
    expect(decode(h)).toEqual({ alg: 'ES256', typ: 'JWT', kid: 'k1' });
    expect(decode(p)).toEqual({ iss: 'https://mcp.redcrayon.test/agent-id', aud: AUDIENCE, sub: 'agent:user_1', iat: now / 1000, exp: now / 1000 + TOKEN_TTL_S });
    const [pub] = jwks(env).keys;
    expect(pub).not.toHaveProperty('d');
    const key = await crypto.subtle.importKey('jwk', pub, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const sig = Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, new TextEncoder().encode(`${h}.${p}`))).toBe(true);
  });

  it('reuses a token until 60 s before it expires', async () => {
    const env = await testEnv();
    const t0 = Date.UTC(2026, 9, 11);
    const a = await mint(env, 'agent:user_2', t0);
    expect(await mint(env, 'agent:user_2', t0 + (TOKEN_TTL_S - 61) * 1000)).toBe(a);
    expect(await mint(env, 'agent:user_2', t0 + (TOKEN_TTL_S - 59) * 1000)).not.toBe(a);
  });

  it('publishes NEXT and PREV but signs only with AGENT_JWK; identities do not depend on the key', async () => {
    const env = await testEnv({ AGENT_JWK_NEXT: await newJwk('k2'), AGENT_JWK_PREV: await newJwk('k0') });
    expect(jwks(env).keys.map(k => k.kid)).toEqual(['k1', 'k2', 'k0']);
    const token = await mint(env, 'service:mcp');
    expect(decode(token.split('.')[0]).kid).toBe('k1');
    expect(identityFromClaims('https://mcp.redcrayon.test/agent-id', 'agent:user_1')).not.toBe(identityFromClaims('https://auth.redcrayon.test', 'user_1'));
  });

  it('a mistyped NEXT or PREV drops only itself, so the signing key stays published', async () => {
    // Step 4 of the rotation pastes PREV by hand and has no check after it; a
    // JWKS that throws would leave the database with no key for any agent.
    for (const bad of ['{"kty":"EC","crv":"P-256","x":"a","y":"b"', 'oops', '{"kty":"RSA","kid":"z"}', '{"kty":"EC","crv":"P-256","x":"a","y":"b"}']) {
      expect(jwks(await testEnv({ AGENT_JWK_PREV: bad })).keys.map(k => k.kid)).toEqual(['k1']);
      expect(jwks(await testEnv({ AGENT_JWK_NEXT: bad, AGENT_JWK_PREV: await newJwk('k0') })).keys.map(k => k.kid)).toEqual(['k1', 'k0']);
    }
    // The signing key is different: a bad one means minting is broken, so it still throws.
    const noSigningKey = { ...(await testEnv()), AGENT_JWK: 'oops' };
    expect(() => jwks(noSigningKey)).toThrow();
  });

  it('discovery points the database at the JWKS', async () => {
    expect(discovery(await testEnv())).toMatchObject({ issuer: 'https://mcp.redcrayon.test/agent-id', jwks_uri: 'https://mcp.redcrayon.test/agent-id/jwks.json' });
  });
});
