/**
 * Our token issuer for Worker-to-database connections. The Worker never
 * forwards a client's token: it signs its own 15-minute ES256 JWTs,
 * `agent:<user id>` for a person's agent, `machine:<key id>` for a workspace key,
 * and `service:mcp` for itself. It publishes the
 * OIDC discovery document and JWKS the database fetches to verify them.
 * The identity the database derives is blake3(iss|sub): stable per user and
 * independent of the signing key, so keys rotate without changing identities.
 */
import { createLocalJWKSet, jwtVerify } from 'jose';
import type { Env } from './env';
import type { Principal } from './auth';
import { origins } from './env';

export const AUDIENCE = 'redcrayon-db';
export const TOKEN_TTL_S = 15 * 60;

type Jwk = JsonWebKey & { kid: string };

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const utf8 = new TextEncoder();

function parseJwk(text: string | undefined, name: string): Jwk | undefined {
  if (!text) return undefined;
  const jwk = JSON.parse(text) as Jwk;
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.kid) throw new Error(`${name} must be a P-256 JWK with a kid`);
  return jwk;
}

const publicPart = ({ kty, crv, x, y, kid }: Jwk) => ({ kty, crv, x, y, kid, alg: 'ES256', use: 'sig' });

/**
 * NEXT and PREV are configured separately during a signing-key rotation, so a
 * typo in one must not throw the whole JWKS away: the database would then fetch
 * no key at all and refuse every agent token, signing key included. Log the
 * name and drop that one key. Never the error's message: it can quote the paste.
 */
function extraJwk(text: string | undefined, name: string): Jwk | undefined {
  try {
    return parseJwk(text, name);
  } catch {
    console.error(JSON.stringify({ event: 'jwks.invalid_key', jwks: `${name} is not a P-256 JWK with a kid; it is not published` }));
    return undefined;
  }
}

/** The JWKS: the public part of every key present (the signing key, then NEXT and PREV during a rotation). */
export function jwks(env: Env) {
  const keys = [parseJwk(env.AGENT_JWK, 'AGENT_JWK'), extraJwk(env.AGENT_JWK_NEXT, 'AGENT_JWK_NEXT'), extraJwk(env.AGENT_JWK_PREV, 'AGENT_JWK_PREV')];
  return { keys: keys.filter((k): k is Jwk => k !== undefined).map(publicPart) };
}

export function discovery(env: Env) {
  const issuer = origins(env).issuer;
  return {
    issuer,
    jwks_uri: `${issuer}/jwks.json`,
    response_types_supported: ['id_token'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['ES256'],
  };
}

// Per isolate: the imported signing key, and each subject's token until 60 s before it expires.
let signer: { source: string; kid: string; key: CryptoKey } | undefined;
const tokens = new Map<string, { token: string; refreshAt: number }>();

async function signingKey(env: Env) {
  if (signer?.source !== env.AGENT_JWK) {
    const jwk = parseJwk(env.AGENT_JWK, 'AGENT_JWK');
    if (!jwk) throw new Error('AGENT_JWK is not set');
    const key = await crypto.subtle.importKey('jwk', { ...jwk, key_ops: ['sign'] }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    signer = { source: env.AGENT_JWK, kid: jwk.kid, key };
  }
  return signer;
}

/** A JWT for `sub` signed by AGENT_JWK; WebCrypto's ECDSA output is already JWS's r||s form. */
export async function mint(env: Env, sub: string, now = Date.now()): Promise<string> {
  const { kid, key } = await signingKey(env);
  const cacheKey = `${kid}|${origins(env).issuer}|${sub}`;
  const cached = tokens.get(cacheKey);
  if (cached && now < cached.refreshAt) return cached.token;
  const iat = Math.floor(now / 1000);
  const header = b64url(utf8.encode(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid })));
  const payload = b64url(utf8.encode(JSON.stringify({ iss: origins(env).issuer, aud: AUDIENCE, sub, iat, exp: iat + TOKEN_TTL_S })));
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, utf8.encode(`${header}.${payload}`)));
  const token = `${header}.${payload}.${b64url(signature)}`;
  tokens.set(cacheKey, { token, refreshAt: now + (TOKEN_TTL_S - 60) * 1000 });
  return token;
}

export const agentSubject = (userId: string) => `agent:${userId}`;
export const principalSubject = (principal: Principal) => principal.machine ? `machine:${principal.machine.keyId}` : agentSubject(principal.userId);
export const SERVICE_SUBJECT = 'service:mcp';

// ---- live tap publish tokens ----
// Signed with the same key, but under their own issuer and audience: the
// database fetches keys only for origins(env).issuer, so a tap token can never
// open a database connection, and a database token is never a tap token.
export const TAP_AUDIENCE = 'redcrayon-tap';
export const TAP_TTL_S = 12 * 60 * 60;
const tapIssuer = (env: Env) => `${origins(env).mcp}/tap`;

/** A token that lets the tap publish to one board's live channel for 12 hours. */
export async function mintTap(env: Env, sub: string, board: bigint, now = Date.now()): Promise<string> {
  const { kid, key } = await signingKey(env);
  const iat = Math.floor(now / 1000);
  const header = b64url(utf8.encode(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid })));
  const payload = b64url(utf8.encode(JSON.stringify({ iss: tapIssuer(env), aud: TAP_AUDIENCE, sub, board: board.toString(), iat, exp: iat + TAP_TTL_S })));
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, utf8.encode(`${header}.${payload}`)));
  return `${header}.${payload}.${b64url(signature)}`;
}

/** The tap token's subject, board and expiry (seconds), or null for anything not minted by mintTap and still valid. */
export async function verifyTap(env: Env, token: string, now = Date.now()): Promise<{ sub: string; board: bigint; exp: number } | null> {
  try {
    const { payload, protectedHeader } = await jwtVerify(token, createLocalJWKSet(jwks(env)), {
      issuer: tapIssuer(env),
      audience: TAP_AUDIENCE,
      algorithms: ['ES256'],
      requiredClaims: ['exp'],
      currentDate: new Date(now),
    });
    // mintTap always names its key; jose would otherwise try the only key that fits.
    if (!protectedHeader.kid || typeof payload.sub !== 'string') return null;
    if (typeof payload.board !== 'string' || !/^\d{1,20}$/.test(payload.board)) return null;
    // requiredClaims guarantees exp
    return { sub: payload.sub, board: BigInt(payload.board), exp: payload.exp! };
  } catch {
    return null;
  }
}

// ---- red crayon watcher tokens (spec 2026-10-19 D18): the helper's `marks` command waits with one ----
// Own issuer and audience, as for tap tokens: a marks token is neither a tap token nor a database token.
export const MARKS_AUDIENCE = 'redcrayon-marks';
export const MARKS_TTL_S = 12 * 60 * 60;
const marksIssuer = (env: Env) => `${origins(env).mcp}/marks`;

/** A token that lets the watcher claim marks for one seat on one board for 12 hours. */
export async function mintMarks(env: Env, sub: string, board: bigint, seat: string, now = Date.now()): Promise<string> {
  const { kid, key } = await signingKey(env);
  const iat = Math.floor(now / 1000);
  const header = b64url(utf8.encode(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid })));
  const payload = b64url(utf8.encode(JSON.stringify({ iss: marksIssuer(env), aud: MARKS_AUDIENCE, sub, board: board.toString(), seat, iat, exp: iat + MARKS_TTL_S })));
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, utf8.encode(`${header}.${payload}`)));
  return `${header}.${payload}.${b64url(signature)}`;
}

/** The marks token's subject, board and seat, or null for anything not minted by mintMarks and still valid. */
export async function verifyMarks(env: Env, token: string, now = Date.now()): Promise<{ sub: string; board: bigint; seat: string } | null> {
  try {
    const { payload, protectedHeader } = await jwtVerify(token, createLocalJWKSet(jwks(env)), {
      issuer: marksIssuer(env),
      audience: MARKS_AUDIENCE,
      algorithms: ['ES256'],
      requiredClaims: ['exp'],
      currentDate: new Date(now),
    });
    if (!protectedHeader.kid || typeof payload.sub !== 'string') return null;
    if (typeof payload.board !== 'string' || !/^\d{1,20}$/.test(payload.board)) return null;
    if (typeof payload.seat !== 'string' || !/^[A-Za-z0-9]{16}$/.test(payload.seat)) return null;
    return { sub: payload.sub, board: BigInt(payload.board), seat: payload.seat };
  } catch {
    return null;
  }
}
