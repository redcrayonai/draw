const cookieName = (key: string) => `rc_guest_${encodeURIComponent(key)}`;
const shareCookie = (shared: boolean) => shared && ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(location.hostname);

/** Local development ports share a guest identity. Other deployments use local storage. */
export function readAnonymousToken(key: string, shared: boolean): string | null {
  if (shareCookie(shared)) {
    try {
      const prefix = `${cookieName(key)}=`;
      const row = document.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(prefix));
      if (row) {
        const token = decodeURIComponent(row.slice(prefix.length));
        if (token) return token;
      }
    } catch { /* Fall back to this port's existing token. */ }
  }
  try { return localStorage.getItem(key); } catch { return null; }
}

export function saveAnonymousToken(key: string, token: string, shared: boolean): void {
  try { localStorage.setItem(key, token); } catch { /* The shared cookie can still keep this identity. */ }
  if (shareCookie(shared)) {
    try { document.cookie = `${cookieName(key)}=${encodeURIComponent(token)}; Path=/; SameSite=Strict; Max-Age=31536000`; } catch { /* Local storage remains available. */ }
  }
}

export function clearAnonymousToken(key: string, shared: boolean): void {
  try { localStorage.removeItem(key); } catch { /* Clear the cookie independently. */ }
  if (shareCookie(shared)) {
    try { document.cookie = `${cookieName(key)}=; Path=/; SameSite=Strict; Max-Age=0`; } catch { /* Storage is unavailable. */ }
  }
}
