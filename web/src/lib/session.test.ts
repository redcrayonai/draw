import { describe, it, expect, vi, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import type { Auth } from './auth';

const h = vi.hoisted(() => ({
  config: {
    accounts: undefined as string | undefined,
    spacetimeUri: 'ws://127.0.0.1:3100',
    spacetimeDb: 'redcrayon-test',
    canvasUrl: 'http://localhost:5173',
  },
  calls: [] as string[],
}));
vi.mock('./config', () => ({ config: h.config }));
vi.mock('./stdb', () => ({ disconnect: () => h.calls.push('disconnect'), clearCachedRows: () => h.calls.push('clearCachedRows') }));
vi.mock('./auth', () => ({
  SignedOutError: class SignedOutError extends Error {},
  initAuth: vi.fn(),
}));

function fakeAuth() {
  let user: string | null = null;
  const onUser: ((id: string | null) => void)[] = [];
  const auth: Auth = {
    hasSession: () => user !== null,
    ensureSignedIn: async () => true,
    freshToken: vi.fn(async () => 'account-token'),
    displayName: () => 'Maya Kessler',
    signOut: vi.fn(async () => {
      h.calls.push('provider.signOut');
    }),
    onSignedOut: () => {},
    userId: () => user,
    email: () => 'maya@example.com',
    onUserChange: (cb) => {
      onUser.push(cb);
      cb(user);
    },
    authenticatedHref: vi.fn(href => href),
  };
  return {
    auth,
    signInAs(id: string | null) {
      user = id;
      onUser.forEach((cb) => cb(id));
    },
  };
}

async function setup() {
  vi.resetModules();
  const fake = fakeAuth();
  vi.mocked((await import('./auth')).initAuth).mockResolvedValue(fake.auth);
  const s = await import('./session');
  await s.initSession();
  return { s, fake };
}

beforeEach(() => {
  h.config.accounts = 'issuer_x';
  h.calls.length = 0;
});

describe('session store', () => {
  it('starts in loading state', async () => {
    vi.resetModules();
    const { session } = await import('./session');
    expect(get(session).status).toBe('loading');
  });

  it('accountLabel is empty while loading, never "Signed out"', async () => {
    vi.resetModules();
    const { accountLabel } = await import('./session');
    expect(accountLabel({ status: 'loading' })).toBe('');
    expect(accountLabel({ status: 'signed-in', displayName: 'Maya Kessler' })).toBe('Maya Kessler');
    expect(accountLabel({ status: 'signed-out' })).toBe('Signed out');
    h.config.accounts = undefined;
    expect(accountLabel({ status: 'signed-out' })).toBe('Guest');
  });

  it('without accounts is anonymous dev mode: signed out', async () => {
    h.config.accounts = undefined;
    const { s } = await setup();
    expect(get(s.session)).toEqual({ status: 'signed-out' });
  });

  it('a sign-in load failure is logged and leaves a sentence, not a dead sign-in button', async () => {
    vi.resetModules();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked((await import('./auth')).initAuth).mockRejectedValue(new Error('failed to load sign-in'));
    const s = await import('./session');
    await s.initSession();
    expect(get(s.session)).toEqual({
      status: 'signed-out',
      error: 'Sign-in could not load; check your connection and try again.',
    });
    expect(error).toHaveBeenCalledWith('Sign-in failed to load:', expect.any(Error));
    error.mockRestore();
  });

  it('waits for auth when sign-in is clicked during initialization', async () => {
    vi.resetModules();
    const fake = fakeAuth();
    const openSignIn = vi.spyOn(fake.auth, 'ensureSignedIn');
    let finishLoading!: (auth: Auth) => void;
    const initAuth = vi.mocked((await import('./auth')).initAuth);
    initAuth.mockClear();
    initAuth.mockReturnValue(new Promise(resolve => { finishLoading = resolve; }));
    const s = await import('./session');
    const loading = s.initSession();
    const signingIn = s.signIn();
    await vi.waitFor(() => expect(initAuth).toHaveBeenCalledTimes(1));
    expect(openSignIn).not.toHaveBeenCalled();
    finishLoading(fake.auth);
    await Promise.all([loading, signingIn]);
    expect(openSignIn).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('retries auth initialization from the sign-in button after a connection failure', async () => {
    vi.resetModules();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fake = fakeAuth();
    const openSignIn = vi.spyOn(fake.auth, 'ensureSignedIn');
    const init = vi.mocked((await import('./auth')).initAuth);
    init.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(fake.auth);
    const s = await import('./session');
    await s.initSession();
    expect(get(s.session).error).toBeDefined();
    await s.signIn();
    expect(openSignIn).toHaveBeenCalledExactlyOnceWith(true);
    expect(get(s.session).error).toBeUndefined();
    log.mockRestore();
  });

  it('reports a failed sign-in UI download and lets the next click retry', async () => {
    const { s, fake } = await setup();
    const openSignIn = vi.spyOn(fake.auth, 'ensureSignedIn');
    openSignIn.mockRejectedValueOnce(new Error('Sign-in took too long to load. Please try again.'));
    await s.signIn();
    expect(get(s.session)).toMatchObject({ status: 'signed-out', error: 'Sign-in took too long to load. Please try again.' });
    await s.signIn();
    expect(get(s.session).error).toBeUndefined();
    expect(openSignIn).toHaveBeenCalledTimes(2);
  });

  it('reads the signed-in account and follows direct account switches and sign-out', async () => {
    const { s, fake } = await setup();
    expect(get(s.session)).toEqual({ status: 'signed-out' });
    fake.signInAs('user_1');
    expect(get(s.session)).toEqual({
      status: 'signed-in',
      displayName: 'Maya Kessler',
      email: 'maya@example.com',
      userId: 'user_1',
    });
    fake.signInAs('user_2');
    expect(get(s.session).userId).toBe('user_2');
    h.calls.length = 0;
    fake.signInAs(null);
    expect(get(s.session)).toEqual({ status: 'signed-out' });
    expect(h.calls).toEqual(['clearCachedRows']);
  });

  it('signs out by disconnecting the store before the provider round trip', async () => {
    const { s, fake } = await setup();
    fake.signInAs('user_1');
    h.calls.length = 0;
    let finish!: () => void;
    vi.mocked(fake.auth.signOut).mockImplementationOnce(() => {
      h.calls.push('provider.signOut');
      return new Promise<void>(r => { finish = r; });
    });
    const out = s.signOut();
    expect(h.calls).toEqual(['disconnect', 'clearCachedRows', 'provider.signOut']);
    // The sign-in gate must not open while the provider is still removing the session.
    expect(get(s.session).status).toBe('signed-in');
    finish();
    await out;
    expect(get(s.session)).toEqual({ status: 'signed-out' });
  });

  it('signs out and reports the error when provider sign-out fails', async () => {
    const { s, fake } = await setup();
    fake.signInAs('user_1');
    vi.mocked(fake.auth.signOut).mockRejectedValueOnce(new Error('server error'));
    await s.signOut();
    expect(get(s.session)).toEqual({ status: 'signed-out', error: 'Sign-out failed: server error' });
  });

  it('freshToken: an account token, null when signed out, transient errors rethrown', async () => {
    const { s, fake } = await setup();
    expect(await s.freshToken()).toBeNull();
    fake.signInAs('user_1');
    expect(await s.freshToken()).toBe('account-token');
    const { SignedOutError } = await import('./auth');
    vi.mocked(fake.auth.freshToken).mockRejectedValueOnce(new SignedOutError());
    expect(await s.freshToken()).toBeNull();
    vi.mocked(fake.auth.freshToken).mockRejectedValueOnce(new Error('network down'));
    await expect(s.freshToken()).rejects.toThrow('network down');
  });
});
