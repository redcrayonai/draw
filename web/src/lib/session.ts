import { writable } from 'svelte/store';
import { config } from './config';
import { clearCachedRows, disconnect } from './stdb';
import { initAuth, SignedOutError, type Auth } from './auth';

export type SessionState = {
  status: 'loading' | 'signed-in' | 'signed-out';
  displayName?: string;
  email?: string;
  userId?: string;
  /** Auth or its UI failed to load; another sign-in attempt can retry. */
  error?: string;
};

export const SIGNED_OUT: SessionState = { status: 'signed-out' };
export const session = writable<SessionState>({ status: 'loading' });

/** The one account label for Profile and Settings. Empty while auth loads, so a
 * signed-in user never flashes "Signed out". */
export function accountLabel(s: SessionState): string {
  if (s.status === 'loading') return '';
  if (s.status === 'signed-in') return s.displayName ?? '';
  return config.accounts ? 'Signed out' : 'Guest';
}

let auth: Auth | null = null;
let initialization: Promise<void> | null = null;

function refresh(a: Auth): void {
  const userId = a.userId();
  if (!userId) {
    clearCachedRows(); // also a sign-out in another tab or an expired session
    session.set(SIGNED_OUT);
    return;
  }
  session.set({
    status: 'signed-in',
    displayName: a.displayName(),
    email: a.email(),
    userId,
  });
}

export function initSession(): Promise<void> {
  return initialization ??= loadSession();
}

async function loadSession(): Promise<void> {
  // Dual-mode: no accounts → anonymous/dev, usable, treated as signed-out.
  if (!config.accounts) {
    session.set(SIGNED_OUT);
    return;
  }
  session.set({ status: 'loading' });
  let a: Auth;
  try {
    a = await initAuth();
  } catch (e) {
    console.error('Sign-in failed to load:', e);
    initialization = null;
    session.set({ ...SIGNED_OUT, error: 'Sign-in could not load; check your connection and try again.' });
    return;
  }
  auth = a;
  // onUserChange fires once on registration, which sets the initial state;
  // later it catches sign-out elsewhere and direct account switches (A → B).
  a.onUserChange(() => refresh(a));
}

/** Opens sign-in; `dismissible: false` is the layout's sign-in gate. */
export async function signIn(dismissible = true): Promise<void> {
  await initSession();
  if (!auth) return;
  session.update(s => ({ ...s, error: undefined }));
  try {
    if (await auth.ensureSignedIn(dismissible)) refresh(auth);
  } catch (e) {
    session.update(s => ({ ...s, error: e instanceof Error ? e.message : 'Sign-in could not load. Please try again.' }));
  }
}

/** Call only for the configured canvas URL, never links to external sites. */
export function authenticatedHref(href: string): string {
  return auth?.authenticatedHref(href) ?? href;
}

export async function signOut(): Promise<void> {
  disconnect(); // drop this account's rows before the provider's round trip
  clearCachedRows();
  // Flip the store only after the provider removes the session: SIGNED_OUT opens the
  // layout's sign-in gate, which must not run against a half-removed session.
  try {
    if (auth) await auth.signOut();
  } catch (e) {
    // The provider already dropped its local session, so there is no account to stay
    // signed in as; the error keeps the gate from auto-opening the card.
    session.set({ ...SIGNED_OUT, error: `Sign-out failed: ${e instanceof Error ? e.message : String(e)}` });
    return;
  }
  session.set(SIGNED_OUT);
}

/** TokenSource for the stdb store: a fresh account token, null when signed out.
 * Transient failures throw so the store retries. */
export async function freshToken(): Promise<string | null> {
  if (!auth?.hasSession()) return null;
  try {
    return await auth.freshToken();
  } catch (e) {
    if (e instanceof SignedOutError) return null;
    throw e;
  }
}
