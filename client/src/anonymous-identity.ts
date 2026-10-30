const loopback = () => ['localhost', '127.0.0.1', '[::1]', '::1'].includes(location.hostname);
const cookieName = (key: string) => `rc_guest_${encodeURIComponent(key)}`;

/** Ports have separate storage. Share only unauthenticated loopback development sessions. */
export function readAnonymousToken(key: string, shared: boolean): string | undefined {
  if (shared && loopback()) {
    const prefix = cookieName(key) + '=';
    const cookie = document.cookie.split(';').map(value => value.trim()).find(value => value.startsWith(prefix));
    if (cookie) {
      try { return decodeURIComponent(cookie.slice(prefix.length)); } catch { /* use local storage */ }
    }
  }
  return localStorage.getItem(key) ?? undefined;
}

export function saveAnonymousToken(key: string, token: string, shared: boolean): void {
  localStorage.setItem(key, token);
  if (shared && loopback()) document.cookie = `${cookieName(key)}=${encodeURIComponent(token)}; Path=/; SameSite=Strict; Max-Age=31536000`;
}

export function clearAnonymousToken(key: string, shared: boolean): void {
  localStorage.removeItem(key);
  if (shared && loopback()) document.cookie = `${cookieName(key)}=; Path=/; SameSite=Strict; Max-Age=0`;
}
