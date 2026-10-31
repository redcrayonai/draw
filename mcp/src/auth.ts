/**
 * Who is calling /mcp (spec §2, Client to Worker). This Worker only checks
 * tokens; an identity provider signs users in. A `VerifyBearer` turns a bearer
 * token into a user: worker.ts wires `apiKeys` (MCP_API_KEYS) and `oidc` (a JWT
 * from OIDC_ISSUER with our resource as its audience); a private entry can wire
 * its own. Never accepted: the provider's browser session tokens (no audience
 * of ours, so they would skip consent and scopes), our own JWTs, a token in the
 * query string or a cookie. OAuth/static verdicts are cached for 60 s (D12).
 * Managed workspace keys are checked on every request so revocation is immediate.
 */
import { oidcVerifier } from '../../shared/oidc-verify';
import { origins, type Env } from './env';

export const SCOPES = ['board:read', 'board:write'] as const;

export type Principal = {
  userId: string;
  clientId: string;
  via: 'oauth' | 'service';
  scopes: string[];
  machine?: { keyId: string; serviceAccountId: string; workspaceId: string; name: string };
};

export type Verdict = { ok: true; principal: Principal } | { ok: false; status: 401 | 429 | 503 };

/**
 * The user behind `Authorization: Bearer <token>`, or null when the token is
 * not one this verifier accepts. Throw when the verifier cannot tell (its
 * provider is down): the caller answers 503 instead of signing the client out.
 */
export type VerifyBearer = (authorization: string) => Promise<Principal | null>;

export type UserInfo = { name: string; plan: string };
export type UserLookup = (userId: string) => Promise<UserInfo>;

/** Without a user directory, a user is named by its id. */
export const selfHostedUsers: UserLookup = async userId => ({ name: userId, plan: 'self-hosted' });

const CACHE_MS = 60_000;
const VERIFY_TIMEOUT_MS = 3_000;
const USER_CACHE_MS = 10 * 60_000;

// A refused token is remembered too (principal undefined), so replaying junk costs the verifier nothing.
const verdicts = new Map<string, { principal?: Principal; until: number }>();
const users = new Map<string, { info: UserInfo; until: number }>();

/** An isolate's hard bound per cache; a swept-then-cleared cache only costs the next call a lookup. */
export const CACHE_MAX = 10_000;

/**
 * An expired entry is ignored on read and then overwritten, but one whose key
 * never returns stays. Every refused token leaves one (junk is cached on
 * purpose), so a flood of distinct tokens would grow the map until the isolate
 * is killed for exceeding memory. Drop the expired ones when the map gets big,
 * and if they were all live, drop the lot: re-asking the verifier is only slower.
 */
function sweep<T extends { until: number }>(map: Map<string, T>, now: number): void {
  if (map.size < CACHE_MAX) return;
  for (const [key, entry] of map) if (now >= entry.until) map.delete(key);
  if (map.size >= CACHE_MAX) map.clear();
}

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([promise, new Promise<T>((_, reject) => (timer = setTimeout(() => reject(new Error('timeout')), ms)))]).finally(() =>
    clearTimeout(timer)
  );
}

const isLocalhost = (url: URL) => url.hostname === 'localhost' || url.hostname === '127.0.0.1';

/** `DEV_AUTH=1` maps every localhost request to user_dev, and nothing else (spec §9 Local dev). */
export const devAuth = (env: Env, url: URL) => env.DEV_AUTH === '1' && isLocalhost(url);

const bearer = (authorization: string) => authorization.replace(/^Bearer /i, '');
export const isManagedBearer = (authorization: string) => bearer(authorization).startsWith('rcak_');

export type ManagedKey = {
  keyId: string; keyHash: string; workspaceId: bigint; serviceAccountId: bigint;
  name: string; role: string; expiresAt?: { microsSinceUnixEpoch: bigint };
};

/** The service-only auth view supplies current account/key policy, never the key's secret. */
export function managedApiKeys(lookup: (hash: string) => Promise<ManagedKey | undefined>, now = Date.now): VerifyBearer {
  return async authorization => {
    const token = bearer(authorization);
    const keyId = /^rcak_([0-9a-f]{32})_[0-9a-f]{64}$/.exec(token)?.[1];
    if (!keyId) return null;
    const hash = await sha256(token);
    const key = await lookup(hash);
    if (!key || key.keyId !== keyId || key.keyHash !== hash || !['viewer', 'editor'].includes(key.role)) return null;
    if (key.expiresAt && key.expiresAt.microsSinceUnixEpoch <= BigInt(now()) * 1000n) return null;
    return {
      userId: `machine:${key.serviceAccountId}`, clientId: `api_key:${keyId}`, via: 'service',
      scopes: key.role === 'editor' ? [...SCOPES] : ['board:read'],
      machine: { keyId, serviceAccountId: String(key.serviceAccountId), workspaceId: String(key.workspaceId), name: key.name },
    };
  };
}

/** The first verifier that accepts the token wins; one that throws makes the whole check throw. */
export const anyOf =
  (...verifiers: VerifyBearer[]): VerifyBearer =>
  async authorization => {
    for (const verify of verifiers) {
      const principal = await verify(authorization);
      if (principal) return principal;
    }
    return null;
  };

/**
 * Static keys from MCP_API_KEYS, `<sha256 hex of key>:<user id>` pairs, for the
 * canary, e2e and self-hosters with no OAuth server. Only hashes are configured,
 * so the config never holds a usable key. A key is a service: every scope.
 */
export function apiKeys(env: Env): VerifyBearer {
  const users = new Map<string, string>();
  for (const pair of (env.MCP_API_KEYS ?? '').split(',').map(p => p.trim()).filter(Boolean)) {
    const at = pair.indexOf(':');
    const hash = pair.slice(0, at).toLowerCase();
    const userId = pair.slice(at + 1).trim();
    // Never log the entry: a key pasted unhashed would land in the logs.
    if (at < 0 || !/^[0-9a-f]{64}$/.test(hash) || !userId) console.error(JSON.stringify({ event: 'auth.invalid_api_key', auth: 'an MCP_API_KEYS entry is not <sha256 hex>:<user id>; it is ignored' }));
    else users.set(hash, userId);
  }
  return async authorization => {
    const userId = users.size > 0 ? users.get(await sha256(bearer(authorization))) : undefined;
    return userId ? { userId, clientId: 'api_key', via: 'service', scopes: [...SCOPES] } : null;
  };
}

/**
 * An OAuth access token that is a JWT from OIDC_ISSUER (shared/oidc-verify.ts),
 * issued for our resource. Scopes come from `scope` (space-separated) or `scp`
 * (a list). A token the issuer did not sign, for another audience, or expired
 * is null; the issuer unreachable throws.
 */
export function oidc(env: Env): VerifyBearer {
  const verify = oidcVerifier({ issuer: env.OIDC_ISSUER, audience: origins(env).resource });
  return async authorization => {
    const payload = await verify(bearer(authorization));
    if (!payload) return null;
    const scopes = typeof payload.scope === 'string' ? payload.scope.split(' ').filter(Boolean) : Array.isArray(payload.scp) ? payload.scp.map(String) : [];
    const clientId = [payload.client_id, payload.azp].find((c): c is string => typeof c === 'string') ?? 'oauth';
    return { userId: payload.sub, clientId, via: 'oauth', scopes };
  };
}

/** `limited`: the per-IP limit, spent only when the verifier has to be asked (a verdict not cached). */
export async function authenticate(env: Env, request: Request, verify: VerifyBearer, now = Date.now(), limited?: () => Promise<boolean>): Promise<Verdict> {
  const url = new URL(request.url);
  const authorization = request.headers.get('authorization') ?? '';
  if (devAuth(env, url) && !isManagedBearer(authorization)) return { ok: true, principal: { userId: 'user_dev', clientId: 'dev', via: 'oauth', scopes: [...SCOPES] } };
  const token = /^Bearer ([^\s]+)$/i.exec(authorization)?.[1];
  if (!token) return limited && (await limited()) ? { ok: false, status: 429 } : { ok: false, status: 401 };
  const key = await sha256(token);
  const managed = isManagedBearer(token);
  const hit = managed ? undefined : verdicts.get(key);
  if (hit && now < hit.until) return hit.principal ? { ok: true, principal: hit.principal } : { ok: false, status: 401 };
  if (limited && (await limited())) return { ok: false, status: 429 };
  let principal: Principal | null;
  try {
    principal = await withTimeout(verify(`Bearer ${token}`), VERIFY_TIMEOUT_MS);
  } catch {
    // The provider down is not "signed out": a 401 would send every client back through sign-in.
    return { ok: false, status: 503 };
  }
  if (managed) return principal ? { ok: true, principal } : { ok: false, status: 401 };
  sweep(verdicts, now);
  if (!principal) {
    verdicts.set(key, { until: now + CACHE_MS });
    return { ok: false, status: 401 };
  }
  verdicts.set(key, { principal, until: now + CACHE_MS });
  return { ok: true, principal };
}

/** One user lookup per user per 10 minutes per isolate; a failed lookup falls back without caching. */
export async function userInfo(lookup: UserLookup, userId: string, now = Date.now()): Promise<UserInfo> {
  const hit = users.get(userId);
  if (hit && now < hit.until) return hit.info;
  try {
    const info = await lookup(userId);
    sweep(users, now);
    users.set(userId, { info, until: now + USER_CACHE_MS });
    return info;
  } catch {
    return { name: 'someone', plan: 'free' };
  }
}

/** Tests only: forget cached verdicts and users. */
export function resetAuthCaches() {
  verdicts.clear();
  users.clear();
}

/** Tests only: how many entries each cache holds. */
export const authCacheSizes = () => ({ verdicts: verdicts.size, users: users.size });
