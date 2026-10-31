import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOidcProvider } from '../../shared/oidc';
import { SignedOutError } from '../../shared/browser-auth';

const ISSUER = 'https://id.example/realms/rc';
const CLIENT = 'canvas';
const HINT = `oidc_signed_in:${ISSUER}|${CLIENT}`;
const b64 = (value: unknown) => btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const now = () => Math.floor(Date.now() / 1000);
const jwt = (claims: Record<string, unknown>) =>
  `${b64({ alg: 'RS256' })}.${b64({ iss: ISSUER, aud: CLIENT, sub: 'user-1', iat: now(), exp: now() + 300, ...claims })}.sig`;

let fetchMock: ReturnType<typeof vi.fn>;
let tokenResponses: { status: number; body: unknown }[];

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  document.body.innerHTML = '<div id="auth-gate" hidden><div id="auth-card"></div></div>';
  tokenResponses = [];
  fetchMock = vi.fn(async (url: string) => {
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return Response.json({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/auth`, token_endpoint: `${ISSUER}/token` });
    }
    const next = tokenResponses.shift()!;
    return Response.json(next.body, { status: next.status });
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  history.replaceState(null, '', '/');
});

/** Starts a sign-in from `href` and returns the authorization URL it navigated to. */
async function signInFrom(href: string, silent = false): Promise<URL> {
  history.replaceState(null, '', href);
  if (silent) localStorage.setItem(HINT, '1');
  const go = vi.fn();
  const { initAuth } = createOidcProvider(ISSUER, CLIENT, go);
  if (silent) void initAuth();
  else void (await initAuth()).ensureSignedIn(true);
  await vi.waitFor(() => expect(go).toHaveBeenCalled());
  return new URL(go.mock.calls[0][0]);
}

/** The issuer sends the browser back with this code for the pending sign-in. */
function comeBack(authorize: URL, query = `code=the-code&state=${authorize.searchParams.get('state')}`) {
  history.replaceState(null, '', `/?${query}`);
}

describe('OIDC sign-in', () => {
  it('sends a PKCE (S256) authorization request back to the app root', async () => {
    const url = await signInFrom('/?db=preview#b=board-slug');
    expect(`${url.origin}${url.pathname}`).toBe(`${ISSUER}/auth`);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: 'code', client_id: CLIENT, redirect_uri: `${location.origin}/`,
      scope: 'openid profile email', code_challenge_method: 'S256',
    });
    expect(url.searchParams.get('code_challenge')).toMatch(/^[\w-]{43}$/);
    expect(url.searchParams.has('prompt')).toBe(false);
  });

  it('replaces the history entry for a silent round trip only, so Back never redirects again', async () => {
    const go = vi.fn();
    localStorage.setItem(HINT, '1');
    void createOidcProvider(ISSUER, CLIENT, go).initAuth();
    await vi.waitFor(() => expect(go).toHaveBeenCalledWith(expect.stringContaining('prompt=none'), true));
    localStorage.clear();
    const signIn = vi.fn();
    void (await createOidcProvider(ISSUER, CLIENT, signIn).initAuth()).ensureSignedIn(true);
    await vi.waitFor(() => expect(signIn).toHaveBeenCalledWith(expect.not.stringContaining('prompt='), false));
  });

  it('refuses an issuer whose discovery names another issuer', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ issuer: 'https://evil.example', authorization_endpoint: 'https://evil.example/auth', token_endpoint: 'https://evil.example/token' }));
    const auth = await createOidcProvider(ISSUER, CLIENT, vi.fn()).initAuth();
    await expect(auth.ensureSignedIn(true)).rejects.toThrow('misconfigured');
  });

  it('restores the starting URL before the app reads it, then exchanges the code once', async () => {
    const authorize = await signInFrom('/?db=preview#b=board-slug');
    comeBack(authorize);
    const { initAuth } = createOidcProvider(ISSUER, CLIENT, vi.fn());
    expect(`${location.pathname}${location.search}${location.hash}`).toBe('/?db=preview#b=board-slug');

    tokenResponses.push({ status: 200, body: { id_token: jwt({ nonce: authorize.searchParams.get('nonce'), name: 'Maya Kessler', email: 'maya@example.com' }) } });
    const auth = await initAuth();
    const exchange = fetchMock.mock.calls.find(([url]) => url === `${ISSUER}/token`)!;
    const form = exchange[1].body as URLSearchParams;
    expect(Object.fromEntries(form)).toMatchObject({ grant_type: 'authorization_code', code: 'the-code', client_id: CLIENT, redirect_uri: `${location.origin}/` });
    expect(form.get('code_verifier')).toMatch(/^[\w-]{43}$/);
    expect(auth.hasSession()).toBe(true);
    expect(auth.userId()).toBe('user-1');
    expect(auth.displayName()).toBe('Maya Kessler');
    expect(auth.email()).toBe('maya@example.com');
    expect(localStorage.getItem(HINT)).toBe('1');
    await expect(auth.freshToken()).resolves.toMatch(/\.sig$/);
    // In memory only: neither storage holds the token.
    expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain('.sig');
  });

  it("leaves another page's ?code= alone", () => {
    sessionStorage.setItem('oidc_pending', JSON.stringify({ state: 'mine', verifier: 'v', nonce: 'n', back: '/' }));
    history.replaceState(null, '', '/link?code=agent-code');
    createOidcProvider(ISSUER, CLIENT, vi.fn());
    expect(location.search).toBe('?code=agent-code');
  });

  it('refuses a token minted for someone else or another sign-in', async () => {
    const authorize = await signInFrom('/');
    comeBack(authorize);
    const { initAuth } = createOidcProvider(ISSUER, CLIENT, vi.fn());
    tokenResponses.push({ status: 200, body: { id_token: jwt({ nonce: 'replayed' }) } });
    await expect(initAuth()).rejects.toThrow('not issued for this app');
    expect(localStorage.getItem(HINT)).toBeNull();
  });

  it('keeps every tab signed in when the code exchange hits an outage', async () => {
    const authorize = await signInFrom('/', true);
    comeBack(authorize);
    const { initAuth } = createOidcProvider(ISSUER, CLIENT, vi.fn());
    tokenResponses.push({ status: 503, body: {} });
    await expect(initAuth()).rejects.toThrow('HTTP 503');
    expect(localStorage.getItem(HINT)).toBe('1');
  });

  it('restores a signed-in origin on reload with a silent round trip, not a stored token', async () => {
    const url = await signInFrom('/?boardId=7', true);
    expect(url.searchParams.get('prompt')).toBe('none');
  });

  it('lands signed out when the silent round trip needs a login', async () => {
    const authorize = await signInFrom('/', true);
    comeBack(authorize, `error=login_required&state=${authorize.searchParams.get('state')}`);
    const go = vi.fn();
    const auth = await createOidcProvider(ISSUER, CLIENT, go).initAuth();
    expect(auth.hasSession()).toBe(false);
    expect(localStorage.getItem(HINT)).toBeNull();
    expect(go).not.toHaveBeenCalled();
  });

  it('gates required sign-in behind a click, so signing out never bounces straight back', async () => {
    const go = vi.fn();
    const auth = await createOidcProvider(ISSUER, CLIENT, go).initAuth();
    void auth.ensureSignedIn();
    expect(document.getElementById('auth-gate')!.hidden).toBe(false);
    expect(go).not.toHaveBeenCalled();
    document.querySelector<HTMLButtonElement>('#auth-card button')!.click();
    await vi.waitFor(() => expect(go).toHaveBeenCalled());
  });

  describe('a signed-in session', () => {
    async function signedIn(claims: Record<string, unknown>, refresh?: string) {
      const authorize = await signInFrom('/');
      comeBack(authorize);
      const go = vi.fn();
      const provider = createOidcProvider(ISSUER, CLIENT, go);
      tokenResponses.push({ status: 200, body: { id_token: jwt({ nonce: authorize.searchParams.get('nonce'), ...claims }), refresh_token: refresh } });
      return { auth: await provider.initAuth(), go };
    }

    it('refreshes an expiring token once for every caller', async () => {
      const { auth } = await signedIn({ exp: now() + 30 }, 'refresh-1');
      tokenResponses.push({ status: 200, body: { id_token: jwt({ name: 'fresh' }) } });
      const [a, b] = await Promise.all([auth.freshToken(), auth.freshToken()]);
      expect(a).toBe(b);
      const refreshes = fetchMock.mock.calls.filter(([, init]) => (init?.body as URLSearchParams | undefined)?.get('grant_type') === 'refresh_token');
      expect(refreshes).toHaveLength(1);
      expect(Object.fromEntries(refreshes[0][1].body)).toMatchObject({ refresh_token: 'refresh-1' });
      expect(auth.displayName()).toBe('fresh');
    });

    it('judges expiry by the token lifetime, not this clock against exp', async () => {
      // A fast local clock: exp already looks past, but the token has five minutes to live.
      const { auth, go } = await signedIn({ iat: now() - 3600, exp: now() - 3300 });
      await expect(auth.freshToken()).resolves.toMatch(/\.sig$/);
      expect(go).not.toHaveBeenCalled();
    });

    it('uses a short-lived token without a refresh token instead of redirecting in a loop', async () => {
      const { auth, go } = await signedIn({ exp: now() + 30 });
      await expect(auth.freshToken()).resolves.toMatch(/\.sig$/);
      expect(go).not.toHaveBeenCalled();
    });

    it('signs out when the issuer refuses the refresh token', async () => {
      const { auth } = await signedIn({ exp: now() + 30 }, 'refresh-1');
      const out = vi.fn();
      const users: (string | null)[] = [];
      auth.onSignedOut(out);
      auth.onUserChange(id => users.push(id));
      tokenResponses.push({ status: 400, body: { error: 'invalid_grant' } });
      await expect(auth.freshToken()).rejects.toBeInstanceOf(SignedOutError);
      expect(out).toHaveBeenCalledTimes(1);
      expect(users).toEqual(['user-1', null]);
      expect(localStorage.getItem(HINT)).toBeNull();
    });

    it('keeps the session through a rate-limited refresh', async () => {
      const { auth } = await signedIn({ exp: now() + 30 }, 'refresh-1');
      tokenResponses.push({ status: 429, body: {} });
      await expect(auth.freshToken()).rejects.toThrow('HTTP 429');
      expect(auth.hasSession()).toBe(true);
    });

    // OIDC Core 12.2: a refresh response may omit id_token; that is not a refusal.
    it('keeps the session when a refresh brings no ID token, then renews with a silent round trip', async () => {
      const { auth, go } = await signedIn({ exp: now() + 30 }, 'refresh-1');
      const out = vi.fn();
      auth.onSignedOut(out);
      tokenResponses.push({ status: 200, body: { access_token: 'at', refresh_token: 'refresh-2' } });
      await expect(auth.freshToken()).resolves.toMatch(/\.sig$/);
      expect(auth.hasSession()).toBe(true);
      expect(localStorage.getItem(HINT)).toBe('1');
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 400_000);
      void auth.freshToken();
      await vi.waitFor(() => expect(go).toHaveBeenCalled());
      expect(new URL(go.mock.calls[0][0]).searchParams.get('prompt')).toBe('none');
      expect(out).not.toHaveBeenCalled();
      const refreshes = fetchMock.mock.calls.filter(([, init]) => (init?.body as URLSearchParams | undefined)?.get('grant_type') === 'refresh_token');
      expect(refreshes).toHaveLength(1);
    });

    it('fetches a new token with a silent round trip once one without a refresh token expires', async () => {
      const { auth, go } = await signedIn({});
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 400_000);
      void auth.freshToken();
      await vi.waitFor(() => expect(go).toHaveBeenCalled());
      expect(new URL(go.mock.calls[0][0]).searchParams.get('prompt')).toBe('none');
    });

    it('signs out without a silent sign-in on the next load', async () => {
      const { auth } = await signedIn({});
      await auth.signOut();
      expect(auth.hasSession()).toBe(false);
      expect(localStorage.getItem(HINT)).toBeNull();
      await expect(auth.freshToken()).rejects.toBeInstanceOf(SignedOutError);
    });
  });
});
