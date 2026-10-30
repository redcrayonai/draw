/**
 * Links from a code ref into a local editor. Everything here is defensive:
 * the href lands in an <a>, so the path and repo root are validated and every
 * segment is percent-encoded before any string concatenation.
 */

export const EDITOR_SCHEMES = ['vscode', 'cursor', 'zed'] as const;
export type EditorScheme = (typeof EDITOR_SCHEMES)[number];

const STORAGE_KEY = 'redcrayon-editor';

/** How each editor names itself, for titles and the command palette. */
export const EDITOR_LABEL: Record<EditorScheme, string> = { vscode: 'VS Code', cursor: 'Cursor', zed: 'Zed' };

// repo-relative: no leading slash, no `..` segment, no ':' or '\' anywhere, and no
// control characters or Unicode line separators (a line break would hide a `..`
// segment from a `.`-based lookahead). `[\s\S]` so the lookahead sees every character.
const PATH_RE = /^(?!\/)(?![\s\S]*(^|\/)\.\.(\/|$))[^:\\\x00-\x1f\x7f\u2028\u2029]+$/;

export function sanitizeRefPath(path: string): string | null {
  return PATH_RE.test(path) ? path : null;
}

function isScheme(s: string): s is EditorScheme {
  return (EDITOR_SCHEMES as readonly string[]).includes(s);
}

/** The editor's own name for a scheme; an unknown scheme shows as is. */
export function editorLabel(scheme: string): string {
  return isScheme(scheme) ? EDITOR_LABEL[scheme] : scheme;
}

/** `${scheme}://file/<abs path, each segment encoded>:<line>`, or null when any part is unsafe. */
export function buildEditorHref(scheme: string, repoRoot: string, path: string, line: number): string | null {
  if (!isScheme(scheme)) {
    return null;
  }
  const rel = sanitizeRefPath(path);
  if (rel === null) {
    return null;
  }
  if (!repoRoot.startsWith('/') || /[:\\\x00-\x1f\x7f\u2028\u2029]/.test(repoRoot)) {
    return null;
  }
  const abs = `${repoRoot.replace(/\/+$/, '')}/${rel}`;
  return `${scheme}://file${abs.split('/').map(encodeURIComponent).join('/')}:${Math.max(1, Math.floor(line))}`;
}

// In-memory copy so a storage that throws (private mode, quota) still cycles.
let current: EditorScheme | null = null;

export function readEditorScheme(): string {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    current = stored !== null && isScheme(stored) ? stored : 'vscode';
  } catch {
    current = current ?? 'vscode';
  }
  return current;
}

/** The scheme after `cur` in EDITOR_SCHEMES; an unknown value steps to `cursor`. Pure. */
export function nextEditorScheme(cur: string): string {
  const i = (EDITOR_SCHEMES as readonly string[]).indexOf(cur);
  // unknown (-1) steps to index 1 (`cursor`), not back to the default
  return i < 0 ? EDITOR_SCHEMES[1] : EDITOR_SCHEMES[(i + 1) % EDITOR_SCHEMES.length];
}

/** Advance to the next scheme, persist best-effort, return the new one. */
export function cycleEditorScheme(): string {
  const next = nextEditorScheme(current ?? readEditorScheme());
  current = next as EditorScheme;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // storage is a cache; the in-memory value is the truth for this page
  }
  return next;
}

/** Append a repo path with a break opportunity after each '/', so a narrow
 *  column wraps between segments, never inside a file name. */
export function appendPathText(target: HTMLElement, text: string): void {
  text.split('/').forEach((part, i, all) => {
    const last = i === all.length - 1;
    target.append(last ? part : `${part}/`);
    if (!last) {
      target.append(document.createElement('wbr'));
    }
  });
}
