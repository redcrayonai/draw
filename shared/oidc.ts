import { SignedOutError, type AuthProvider, type BrowserAuth } from './browser-auth';

// Generic OpenID Connect sign-in: authorization code + PKCE for a public client
// (no secret). Tokens stay in memory. A reload restores the account with a silent
// (prompt=none) round trip to the issuer rather than a stored token, so none is
// ever persisted; localStorage only remembers that this origin is signed in.
// The ID token is what reaches the database, and its iss|sub is the identity.

type Pending = { state: string; verifier: string; nonce: string; back: string };
type Claims = {
  iss: string; sub: string; aud: string | string[]; exp: number; iat?: number;
  nonce?: string; name?: string; preferred_username?: string; email?: string;
};
/** Times on this browser's clock: `expiresAt` is the token's lifetime from receipt. */
type Session = { idToken: string; refreshToken?: string; claims: Claims; receivedAt: number; expiresAt: number };
type Metadata = { issuer: string; authorization_endpoint: string; token_endpoint: string };

const PENDING = 'oidc_pending';
const SCOPE = 'openid profile email';

class TokenError extends Error {
  constructor(readonly status: number, error: string) { super(`sign-in failed: ${error}`); }
}

/** A refresh answered without a new ID token, which OIDC Core 12.2 allows: not a refusal. */
class NoIdToken extends Error {}

/** The issuer said no (a used code, a revoked refresh token, a wrong token), as
 * opposed to a network error, an outage or rate limiting, which a retry may fix. */
const refused = (error: unknown) => error instanceof TokenError && (error.status === 400 || error.status === 401);

/** `issuer` must equal the tokens' `iss` exactly: it is half of every identity. */
export function createOidcProvider(
  issuer: string,
  clientId: string,
  // A silent round trip replaces this history entry, so Back never lands on a page that redirects again.
  go = (url: string, silent: boolean) => (silent ? location.replace(url) : location.assign(url)),
): AuthProvider {
  const accounts = `${issuer}|${clientId}`;
  const hint = `oidc_signed_in:${accounts}`;
  const redirectUri = `${location.origin}/`;
  let returned = takeCallback();
  let metadata: Promise<Metadata> | undefined;
  let session: Session | undefined;
  let leaving: Promise<never> | undefined;
  let refreshing: Promise<void> | undefined;
  const userListeners: ((userId: string | null) => void)[] = [];
  const outListeners: (() => void)[] = [];

  function discover(): Promise<Metadata> {
    return metadata ??= fetch(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`).then(res => {
      if (!res.ok) throw new Error(`sign-in is unavailable (HTTP ${res.status})`);
      return res.json() as Promise<Metadata>;
    }).then(found => {
      if (found.issuer !== issuer) throw new Error(`sign-in is misconfigured: the server names itself ${found.issuer}`);
      return found;
    }).catch(error => {
      metadata = undefined;
      throw error;
    });
  }

  function redirect(silent: boolean): Promise<never> {
    return leaving ??= navigate(silent).catch(error => {
      leaving = undefined;
      throw error;
    });
  }

  async function navigate(silent: boolean): Promise<never> {
    const { authorization_endpoint } = await discover();
    const pending: Pending = { state: random(), verifier: random(), nonce: random(), back: location.href };
    const url = new URL(authorization_endpoint);
    const params = {
      response_type: 'code', client_id: clientId, redirect_uri: redirectUri, scope: SCOPE,
      state: pending.state, nonce: pending.nonce,
      code_challenge: await challenge(pending.verifier), code_challenge_method: 'S256',
      ...(silent ? { prompt: 'none' } : {}),
    };
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    sessionStorage.setItem(PENDING, JSON.stringify(pending));
    go(url.href, silent);
    return new Promise<never>(() => {}); // this page is leaving
  }

  // Back from the issuer's page into a cached copy of this one: its sign-in
  // promise never settles, so load it fresh.
  addEventListener('pageshow', event => {
    if (event.persisted && sessionStorage.getItem(PENDING)) location.reload();
  });

  async function token(params: Record<string, string>, nonce?: string): Promise<Session> {
    const { token_endpoint } = await discover();
    const res = await fetch(token_endpoint, { method: 'POST', body: new URLSearchParams({ client_id: clientId, ...params }) });
    const body = (await res.json().catch(() => ({}))) as { id_token?: unknown; refresh_token?: unknown; error?: unknown };
    if (!res.ok) throw new TokenError(res.status, String(body.error ?? `HTTP ${res.status}`));
    if (typeof body.id_token !== 'string') {
      throw params.grant_type === 'refresh_token' ? new NoIdToken() : new TokenError(400, 'the server returned no ID token');
    }
    const claims = decode(body.id_token);
    // Straight from the token endpoint over TLS: the signature is the
    // database's to check (OIDC Core 3.1.3.7), the audience and nonce ours.
    if (claims.iss !== issuer || ![claims.aud].flat().includes(clientId) || (nonce !== undefined && claims.nonce !== nonce)) {
      throw new TokenError(400, 'the token was not issued for this app');
    }
    const refreshToken = typeof body.refresh_token === 'string' ? body.refresh_token : session?.refreshToken;
    const receivedAt = Date.now();
    const expiresAt = claims.iat === undefined ? claims.exp * 1000 : receivedAt + (claims.exp - claims.iat) * 1000;
    return { idToken: body.id_token, refreshToken, claims, receivedAt, expiresAt };
  }

  async function refresh(refreshToken: string): Promise<void> {
    try {
      start(await token({ grant_type: 'refresh_token', refresh_token: refreshToken }));
    } catch (error) {
      // This issuer refreshes access tokens only: from now on the session renews like one without a refresh token.
      if (error instanceof NoIdToken) {
        if (session) session.refreshToken = undefined;
        return;
      }
      if (refused(error)) {
        end();
        throw new SignedOutError();
      }
      throw error;
    }
  }

  function start(next: Session): void {
    const was = session?.claims.sub;
    session = next;
    localStorage.setItem(hint, '1');
    if (next.claims.sub !== was) for (const cb of userListeners) cb(next.claims.sub);
  }

  function end(): void {
    localStorage.removeItem(hint);
    if (!session) return;
    session = undefined;
    for (const cb of userListeners) cb(null);
    for (const cb of outListeners) cb();
  }

  // Signed out in another tab.
  addEventListener('storage', event => {
    if ((event.key === hint || event.key === null) && !localStorage.getItem(hint)) end();
  });

  function showGate(): void {
    const gate = document.getElementById('auth-gate') as HTMLDivElement;
    const card = document.getElementById('auth-card') as HTMLDivElement;
    const box = document.createElement('div');
    box.className = 'auth-oidc';
    const text = document.createElement('p');
    text.textContent = `Sign in with ${new URL(issuer).host} to continue.`;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ctl';
    button.textContent = 'Sign in';
    button.addEventListener('click', () => {
      button.disabled = true;
      redirect(false).catch(error => {
        button.disabled = false;
        text.textContent = error instanceof Error ? error.message : String(error);
      });
    });
    box.append(text, button);
    card.replaceChildren(box);
    gate.hidden = false;
    button.focus();
  }

  const auth: BrowserAuth = {
    hasSession: () => session !== undefined,
    ensureSignedIn(dismissible = false): Promise<boolean> {
      if (session) return Promise.resolve(true);
      // Asked for (a sign-in button): straight to the issuer. The required gate
      // waits for a click, so signing out never bounces silently back in.
      if (dismissible) return redirect(false);
      showGate();
      return new Promise<boolean>(() => {}); // resolved by the page coming back signed in
    },
    async freshToken(): Promise<string> {
      if (!session) throw new SignedOutError();
      const now = Date.now();
      // The database checks exp only at connect, so any token with a minute left will do.
      if (session.expiresAt - now > 60_000) return session.idToken;
      if (session.refreshToken) {
        // One refresh for every caller: a rotated refresh token works only once.
        await (refreshing ??= refresh(session.refreshToken).finally(() => { refreshing = undefined; }));
        if (session!.refreshToken) return session!.idToken;
      }
      // Without a refresh token (no offline_access), or one that brings no ID token: use
      // the token while it lasts, then a silent round trip, never twice in a row for a short-lived token.
      if (now < session!.expiresAt) return session!.idToken;
      if (now - session!.receivedAt < 60_000) throw new Error('sign-in returned an expired token; will retry');
      return redirect(true); // the page comes back with a new one
    },
    displayName(): string {
      const c = session?.claims;
      return c?.name || c?.preferred_username || c?.email?.split('@')[0] || 'user';
    },
    // shortcut: ends this app's session only, not the issuer's; add RP-initiated logout (end_session_endpoint) when shared machines need it.
    signOut: async () => end(),
    onSignedOut: cb => { outListeners.push(cb); },
    authenticatedHref: href => href,
    userId: () => session?.claims.sub ?? null,
    email: () => session?.claims.email ?? '',
    onUserChange(cb) {
      userListeners.push(cb);
      cb(session?.claims.sub ?? null);
    },
  };

  async function initAuth(): Promise<BrowserAuth> {
    const back = returned;
    returned = undefined;
    if (back?.params.get('code')) {
      try {
        start(await token({
          grant_type: 'authorization_code', code: back.params.get('code')!,
          redirect_uri: redirectUri, code_verifier: back.pending.verifier,
        }, back.pending.nonce));
      } catch (error) {
        // Only a refusal ends the session (and every tab's); an outage retries.
        if (refused(error)) localStorage.removeItem(hint);
        throw error;
      }
    } else if (back) {
      // login_required after a silent attempt, or the user cancelled: signed out.
      localStorage.removeItem(hint);
    } else if (localStorage.getItem(hint)) {
      await redirect(true);
    }
    return auth;
  }

  return { accounts, initAuth };
}

/** The issuer sends the browser back to `<origin>/?code=…&state=…`. Take that off
 * the URL before the app reads it (board links, routes) and restore the URL sign-in
 * started from. A state this tab never sent is not ours: `/link?code=` is an agent's. */
function takeCallback(): { params: URLSearchParams; pending: Pending } | undefined {
  const params = new URLSearchParams(location.search);
  const raw = sessionStorage.getItem(PENDING);
  const pending = raw ? (JSON.parse(raw) as Pending) : undefined;
  if (!pending || params.get('state') !== pending.state) return;
  sessionStorage.removeItem(PENDING);
  history.replaceState(history.state, '', pending.back);
  return { params, pending };
}

function decode(jwt: string): Claims {
  const part = (jwt.split('.')[1] ?? '').replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(part), c => c.charCodeAt(0))));
}

const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const random = () => base64url(crypto.getRandomValues(new Uint8Array(32)));
const challenge = async (verifier: string) =>
  base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
