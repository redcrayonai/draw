import { SignedOutError, type BrowserAuth } from './browser-auth';

// The default VITE_AUTH_PROVIDER: no accounts. Everyone is a guest holding a
// server-issued token, and nothing offers or requires sign-in.
export const accounts: string | undefined = undefined;

export async function initAuth(): Promise<BrowserAuth> {
  return {
    hasSession: () => false,
    ensureSignedIn: async () => false,
    freshToken: () => Promise.reject(new SignedOutError()),
    displayName: () => 'guest',
    signOut: async () => {},
    onSignedOut: () => {},
    authenticatedHref: href => href,
    userId: () => null,
    email: () => '',
    onUserChange: cb => cb(null),
  };
}
