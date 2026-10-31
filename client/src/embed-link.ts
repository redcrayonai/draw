import { setDb } from '../../shared/db-target';

export type EmbedTheme = 'auto' | 'light' | 'dark';
export const EMBED_GONE = 'This chart is no longer embedded. Ask the owner for a new link.';

export function embedToken(hash: string): string | null {
  const token = new URLSearchParams(hash.replace(/^#/, '')).get('e');
  return token && /^[0-9a-f]{32}$/.test(token) ? token : null;
}

export function embedHref(base: string, db: string, token: string, theme: EmbedTheme = 'auto', home?: string, kind: 'chart' | 'board' = 'chart'): string {
  const url = new URL('embed.html', base);
  url.search = '';
  setDb(url, db, home);
  if (kind === 'board') url.searchParams.set('kind', 'board');
  if (theme !== 'auto') url.searchParams.set('theme', theme);
  url.hash = `e=${token}`;
  return url.href;
}

export function embedSnippet(href: string, title: string): string {
  const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<iframe src="${escape(href)}" title="${escape(title)}" width="100%" height="360" style="border:0" loading="lazy" referrerpolicy="no-referrer"></iframe>`;
}
