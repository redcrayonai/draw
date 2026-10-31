/** The auth lifecycle used by both the canvas and the dashboard. Each app
 * imports its implementation as `$auth`, the module VITE_AUTH_PROVIDER names
 * (see the apps' vite.config.ts and AuthProvider below). */
export interface BrowserAuth {
  hasSession(): boolean;
  ensureSignedIn(dismissible?: boolean): Promise<boolean>;
  /** Fetch fresh on every connect; never persist an account token. */
  freshToken(): Promise<string>;
  displayName(): string;
  signOut(): Promise<void>;
  onSignedOut(cb: () => void): void;
  /** Carry the provider's session to the other app; most providers return href. */
  authenticatedHref(href: string): string;
  /** The account's stable id at the provider, null when signed out. */
  userId(): string | null;
  /** Primary email address, '' when unknown. */
  email(): string;
  /** Fires on registration and whenever the signed-in user changes
   * (sign-in, sign-out, direct account switch A → B). */
  onUserChange(cb: (userId: string | null) => void): void;
}

/** What a VITE_AUTH_PROVIDER module exports. */
export interface AuthProvider {
  /** Names the account system (an issuer, a key); undefined: no sign-in, guests only. */
  accounts: string | undefined;
  /** Restores any session. Called only when `accounts` is set. */
  initAuth(): Promise<BrowserAuth>;
}

export class SignedOutError extends Error {
  constructor() { super('signed out'); }
}
