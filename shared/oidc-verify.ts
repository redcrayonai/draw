/**
 * Server-side check of a JWT an OIDC issuer signed, with the keys its discovery
 * document's jwks_uri names. The mcp Worker checks OAuth access tokens with it
 * (audience: its resource); the dashboard's /api/* checks browser session
 * tokens (authorized parties: the dashboard's origins). A token the issuer did
 * not sign, for another audience or party, or expired is null; the issuer
 * unreachable throws, so the caller answers 503 instead of signing users out.
 */
import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';

// What jose throws for a bad token, as opposed to an unreachable or broken key set.
const REFUSED = new Set([
  'ERR_JWT_INVALID',
  'ERR_JWS_INVALID',
  'ERR_JWT_EXPIRED',
  'ERR_JWT_CLAIM_VALIDATION_FAILED',
  'ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
  'ERR_JWKS_NO_MATCHING_KEY',
  'ERR_JWKS_MULTIPLE_MATCHING_KEYS',
  'ERR_JOSE_ALG_NOT_ALLOWED',
  'ERR_JOSE_NOT_SUPPORTED',
]);

export type OidcCheck = {
  /** exactly the `iss` of the tokens; identities are blake3(iss|sub) */
  issuer: string;
  /** when set, `aud` must contain it */
  audience?: string;
  /** when set, `azp` must be one of these */
  authorizedParties?: string[];
};

export type OidcClaims = JWTPayload & { sub: string };

/** The verified claims of a token (`sub` always set), or null when the check refuses it. */
export function oidcVerifier({ issuer, audience, authorizedParties }: OidcCheck): (token: string) => Promise<OidcClaims | null> {
  let keys: JWTVerifyGetKey | undefined;
  const keySet = async () => {
    const res = await fetch(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) throw new Error(`oidc discovery: HTTP ${res.status}`);
    const { jwks_uri } = (await res.json()) as { jwks_uri?: unknown };
    if (typeof jwks_uri !== 'string') throw new Error('oidc discovery: no jwks_uri');
    return createRemoteJWKSet(new URL(jwks_uri));
  };
  return async token => {
    // Not a JWT (an opaque token, a static key): not ours to ask the issuer about.
    if (!/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token)) return null;
    // Keep the keys, never a discovery in flight: on Workers a fetch dies with the request that
    // started it, and a shared promise that never settles would hold every later check (jose's
    // createRemoteJWKSet drops its pending fetch on Workers for this reason). A failed one is not kept.
    const getKey = (keys ??= await keySet());
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, getKey, { issuer, audience, algorithms: ['RS256', 'ES256', 'EdDSA'] }));
    } catch (err) {
      if (err instanceof errors.JOSEError && REFUSED.has(err.code)) return null;
      throw err; // the keys could not be fetched: the issuer is down, not the token bad
    }
    if (typeof payload.sub !== 'string' || !payload.sub) return null;
    if (authorizedParties && !authorizedParties.includes(payload.azp as string)) return null;
    return payload as OidcClaims;
  };
}
