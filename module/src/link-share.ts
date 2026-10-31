// Rules for anyone-with-the-link sharing.
// Pure, so module/src/link-share.test.mjs can pin them; index.ts wires them in.

export type LinkMode = 'view' | 'edit';

export const isLinkMode = (v: unknown): v is LinkMode => v === 'view' || v === 'edit';

/** 16 bytes as lowercase hex. The owner's browser makes it: ctx.random is timestamp-seeded. */
export const isShareToken = (v: unknown): boolean => typeof v === 'string' && /^[0-9a-f]{32}$/.test(v);

type Jwt = { issuer: string; audience: readonly string[]; fullPayload: Record<string, unknown> } | null | undefined;

/** A signed-in person: a token of the browser issuer that carries its session claim, if one is set. */
export function isAccountSender(jwt: Jwt, issuers: { browser: string; sessionClaim: string; variant: string }): boolean {
  // Only the local variant (local and test databases, published without a browser
  // issuer) falls back to counting every sender, as every issuer is accepted there
  // until RC-529. Staging, production and none fail closed when it is unset.
  if (issuers.browser === '') return issuers.variant === 'local';
  if (!jwt || jwt.issuer !== issuers.browser) return false;
  if (issuers.sessionClaim === '') return true;
  const claim = jwt.fullPayload[issuers.sessionClaim];
  return typeof claim === 'string' && claim !== '';
}

/**
 * A browser session token issued to one of our apps: an account token whose `azp`
 * is an app origin (the hosted service) or an OIDC client id (Keycloak and most
 * providers), or, from a provider that sends no `azp`, whose `aud` names a client id.
 */
export function isBrowserSession(
  jwt: Jwt,
  issuers: { browser: string; sessionClaim: string; appOrigins: string[]; browserClientIds: string[]; variant: string },
): boolean {
  if (issuers.browser === '' || !jwt || !isAccountSender(jwt, issuers)) return false;
  const azp = jwt.fullPayload.azp;
  if (azp === undefined) return jwt.audience.some(aud => issuers.browserClientIds.includes(aud));
  return typeof azp === 'string' && (issuers.appOrigins.includes(azp) || issuers.browserClientIds.includes(azp));
}
