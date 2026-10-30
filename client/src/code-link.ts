import { sanitizeRefPath } from './editor-link';

const GITHUB = /^(?:(?:https|ssh):\/\/(?:[^/@]+@)?github\.com\/|git@github\.com:)(\w[\w.-]*)\/([\w.-]+?)(?:\.git)?\/?$/i;

/** `https://github.com/<owner>/<repo>` for any github.com remote form git prints, else null. */
export function githubRepoUrl(remoteUrl: string): string | null {
  const m = GITHUB.exec(remoteUrl.trim());
  return m === null ? null : `https://github.com/${m[1]}/${m[2]}`;
}

/** The ref's lines at a pushed commit, or null when the remote is not on github.com or the commit or path is unusable. */
export function githubBlobUrl(remoteUrl: string, sha: string, path: string, start: number, end: number): string | null {
  const repo = githubRepoUrl(remoteUrl);
  const rel = sanitizeRefPath(path);
  if (repo === null || rel === null || sha === '') {
    return null;
  }
  const from = Math.max(1, Math.floor(start));
  const to = Math.max(from, Math.floor(end));
  return `${repo}/blob/${encodeURIComponent(sha)}/${rel.split('/').map(encodeURIComponent).join('/')}#L${from}-L${to}`;
}
