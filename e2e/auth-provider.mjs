// Test build only (VITE_AUTH_PROVIDER, via vite.config.mjs): real signed
// account tokens from the test issuer, without a sign-in UI. The fixtures keep
// each browser context's session in node behind the __e2eAuth binding
// (fixtures.ts signIn, signOut, signInOnRequest, providerDown); a context made
// without them only sets window.__e2eAccountToken.
const remote = op => window.__e2eAuth?.(op) ?? Promise.resolve({ token: window.__e2eAccountToken });

export const accounts = 'e2e';

export async function initAuth() {
  const state = await remote('init');
  if (state.down) throw new Error('sign-in provider unreachable');
  let token = state.token;
  const userListeners = [];
  const outListeners = [];
  const userId = () => (token ? JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).sub : null);
  // As shared/oidc.ts: a changed user fires onUserChange, an ended session onSignedOut.
  const set = next => {
    const was = userId();
    token = next;
    if (userId() !== was) for (const cb of userListeners) cb(userId());
    if (was && !next) for (const cb of outListeners) cb();
  };
  window.__e2eAuthSet = set;
  // Dashboard cases also exercise provider callbacks without the context binding.
  window.addEventListener('e2e-account-change', () => set(window.__e2eAccountToken));
  return {
    hasSession: () => Boolean(token),
    // No session: the token signInOnRequest queued, else a cancelled sign-in.
    ensureSignedIn: async () => {
      if (!token) set((await remote('request')).token);
      return Boolean(token);
    },
    freshToken: async () => token,
    displayName: () => 'Test account',
    signOut: async () => {
      await remote('signOut');
      window.__e2eAccountToken = undefined;
      set(undefined);
    },
    onSignedOut(cb) { outListeners.push(cb); },
    authenticatedHref: href => href,
    userId,
    email: () => '',
    onUserChange(cb) {
      userListeners.push(cb);
      cb(userId());
    },
  };
}
