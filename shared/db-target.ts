/** Default home database for links when the destination's VITE_SPACETIME_DB / DB_NAME is unknown to the writer. */
export const DEFAULT_DB = 'redcrayon';

/**
 * Names `db` in a link to the canvas or dashboard, unless it is `home`: the
 * database the deployment that opens the link serves (its VITE_SPACETIME_DB / DB_NAME).
 * Every such link sets ?db= only through here (scripts/db-link-grep.sh checks).
 */
export function setDb(url: URL, db: string, home = DEFAULT_DB): URL {
  if (db !== home) url.searchParams.set('db', db);
  return url;
}

/**
 * The database a page connects to. `?db=` may only name a database the build
 * allows (comma-separated): an open override would send the visitor's session
 * token, and every edit, to whatever database a crafted link names.
 */
export function pickDb(search: string, fallback: string, allowed: unknown): string {
  const wanted = new URLSearchParams(search).get('db');
  const list = typeof allowed === 'string' ? allowed.split(',').map(name => name.trim()) : [];
  return wanted && list.includes(wanted) ? wanted : fallback;
}
