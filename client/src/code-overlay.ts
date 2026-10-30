/**
 * The code overlay is session chrome (G42): it exists only on a board with a
 * session row, starts on when that board has code refs, and remembers the
 * reader's explicit toggle per board.
 */
import type { Command } from './palette';
import { editorLabel, nextEditorScheme } from './editor-link';

/** localStorage key: `{ [boardName]: boolean }`, most recently toggled last. */
export const OVERLAY_KEY = 'redcrayon-overlay';
/** Boards remembered at most; the least recently toggled go first. */
export const OVERLAY_BOARDS_MAX = 50;

function readMap(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(OVERLAY_KEY);
    if (raw === null) {
      return {};
    }
    const v: unknown = JSON.parse(raw);
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      return {};
    }
    const out: Record<string, boolean> = {};
    for (const [k, b] of Object.entries(v)) {
      if (typeof b === 'boolean') {
        out[k] = b;
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** The reader's last explicit toggle on `board`, or null when there is none. */
export function readOverlayPref(board: string): boolean | null {
  const v = readMap()[board];
  return v === undefined ? null : v;
}

/** Remember an explicit toggle. Re-inserting moves the board to the end, so
 *  trimming from the front drops the least recently toggled. (A board name
 *  that is an integer string sorts first in a JSON object, so it is the first
 *  to go: harmless, it only forgets a default.) */
export function writeOverlayPref(board: string, on: boolean): void {
  const map = readMap();
  delete map[board];
  map[board] = on;
  const names = Object.keys(map);
  for (const name of names.slice(0, Math.max(0, names.length - OVERLAY_BOARDS_MAX))) {
    delete map[name];
  }
  try {
    localStorage.setItem(OVERLAY_KEY, JSON.stringify(map));
  } catch {
    // private mode or a full store: the toggle still holds for this page
  }
}

/** Off on a plain board; on a session board the explicit toggle, else on
 *  exactly when the board has at least one code ref. */
export function resolveCodeOverlay(s: { hasSession: boolean; refCount: number; pref: boolean | null }): boolean {
  if (!s.hasSession) {
    return false;
  }
  return s.pref ?? s.refCount > 0;
}

/**
 * Show or hide the code-overlay switch and the ⌥C / inspector rows in ?.
 * Hidden, never removed: the Editor and the chrome contract hold the ids.
 */
export function syncSessionChrome(hasSession: boolean): void {
  const row = document.getElementById('code-overlay-row');
  if (row !== null) {
    row.hidden = !hasSession;
  }
  for (const tr of document.querySelectorAll<HTMLElement>('#shortcuts [data-session-only]')) {
    tr.hidden = !hasSession;
  }
}

/** The ⌘K code commands; none on a board without a session. */
export function codeCommands(d: {
  hasSession: boolean;
  editorScheme: string;
  toggleCodeOverlay: () => void;
  cycleEditorScheme: () => void;
}): Command[] {
  if (!d.hasSession) {
    return [];
  }
  return [
    {
      id: 'code-overlay',
      group: 'Code',
      title: 'Toggle code overlay',
      hint: 'ref badges on nodes and edges',
      keys: '⌥C',
      run: d.toggleCodeOverlay,
    },
    {
      id: 'editor-scheme',
      group: 'Code',
      // A setting, not an action on code: name what it switches to (G46).
      title: `Editor for code links: ${editorLabel(nextEditorScheme(d.editorScheme))}`,
      hint: `currently ${editorLabel(d.editorScheme)}`,
      keywords: ['editor', 'vscode', 'cursor', 'zed', 'open in editor'],
      run: d.cycleEditorScheme,
    },
  ];
}
