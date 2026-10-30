import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import type { ApiError } from '$lib/api-types';
import { oidcVerifier, type OidcClaims } from '$shared/oidc-verify';
import { log } from './log';

export const fail = (status: number, error: string) => json({ error } satisfies ApiError, { status });

/** A 503 with `sentence` when a variable is unset, or undefined when all are set. The
 * Worker log names the unset variables (names only, never values); users never see them. */
export function notConfigured(sentence: string, names: string[]): Response | undefined {
  const missing = names.filter((k) => !env[k]);
  if (missing.length) {
    log('error', 'config.missing', { missing });
    return fail(503, sentence);
  }
}

/** The token from an `Authorization: Bearer <token>` header, or undefined. */
export const bearer = (request: Request) => request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];

let check: { key: string; verify: (token: string) => Promise<OidcClaims | null> } | undefined;

/**
 * The request's bearer token once it may act for an account, or the error Response
 * to return. With OIDC_ISSUER set it must be a session token that issuer signed (with
 * an `azp` from OIDC_AUTHORIZED_PARTIES when set), so anonymous database tokens get
 * 401. Without it the deployment has no accounts: any token passes only when
 * IMPORTS_ANONYMOUS is '1' (anyone can get an anonymous one, so asking the database
 * about it would stop no one), and otherwise every request gets 403.
 */
export async function verifyBearer(request: Request): Promise<string | Response> {
  const token = bearer(request);
  if (!token) return fail(401, 'Sign in again: this request had no session token.');
  if (!env.OIDC_ISSUER) {
    return env.IMPORTS_ANONYMOUS === '1' ? token : fail(403, 'Repository imports need sign-in on this deployment. Ask the deployment owner to set it up.');
  }
  const parties = env.OIDC_AUTHORIZED_PARTIES?.split(',').map((p) => p.trim()).filter(Boolean) ?? [];
  // env is per request (and per test); the verifier keeps the issuer's keys while it stays the same
  const key = `${env.OIDC_ISSUER}|${parties}`;
  if (check?.key !== key) check = { key, verify: oidcVerifier({ issuer: env.OIDC_ISSUER, authorizedParties: parties.length ? parties : undefined }) };
  try {
    if (await check.verify(token)) return token;
  } catch (e) {
    log('error', 'auth.issuer_unreachable', {}, e);
    return fail(503, 'Sign-in could not be checked right now. Try again shortly.');
  }
  // also what a deploy misconfig (wrong issuer or parties) looks like, so log it
  log('warn', 'auth.token_refused');
  return fail(401, 'Your session expired. Reload the page or sign in again.');
}
