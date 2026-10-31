/**
 * VITE_PRIVACY_URL, the hosted privacy policy the canvas and the dashboard link
 * to: an http(s) URL, or undefined (unset, or anything else) to show no link.
 * Self-hosted builds leave it unset.
 */
export function readPrivacyUrl(v: unknown): string | undefined {
  if (typeof v !== 'string' || v.trim() === '') return undefined;
  try {
    const u = new URL(v.trim());
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : undefined;
  } catch {
    return undefined;
  }
}
