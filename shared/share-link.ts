// Anyone-with-the-link URLs (docs/superpowers/specs/2026-10-15-link-sharing-design.md).
import { setDb } from './db-target';

// The token rides in the fragment, which browsers never send to a server.

/** `base` with only ?db= in the query (board ids are per database; setDb drops `base`'s home) and #s=<token>. */
export function shareHref(base: string, db: string, token: string, home?: string): string {
  const url = new URL(base);
  url.search = '';
  url.hash = `s=${token}`;
  return setDb(url, db, home).toString();
}

/** 16 random bytes as lowercase hex: the module's isShareToken format. */
export function newShareToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
}

/** The token of a `#s=<token>` fragment, or null when there is none. */
export function shareTokenOf(hash: string): string | null {
  return new URLSearchParams(hash.replace(/^#/, '')).get('s');
}
