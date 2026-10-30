import html from '../index.html?raw';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  OVERLAY_KEY,
  OVERLAY_BOARDS_MAX,
  readOverlayPref,
  writeOverlayPref,
  resolveCodeOverlay,
  syncSessionChrome,
  codeCommands,
} from './code-overlay';

const shown = (el: Element | null) => el !== null && el.closest('[hidden]') === null;

const commandDeps = (hasSession: boolean) => ({
  hasSession,
  editorScheme: 'vscode',
  toggleCodeOverlay: vi.fn(),
  cycleEditorScheme: vi.fn(),
});

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = html;
});

describe('code overlay chrome follows the session row (G42)', () => {
  it('no session → overlay row hidden, palette lacks code commands', () => {
    syncSessionChrome(false);
    expect(shown(document.getElementById('code-overlay-row'))).toBe(false);
    // the evidence overlay is board chrome, not session chrome: the session never touches it
    expect(document.getElementById('overlay-row')?.hidden).toBe(true);
    const keys = [...document.querySelectorAll<HTMLElement>('#shortcuts tr')].filter(tr => !tr.hidden).map(tr => tr.querySelector('td')?.textContent?.trim());
    expect(keys).not.toContain('⌥C');
    for (const k of ['↑ / ↓ (inspector)', '↵ (inspector)', 'o (inspector)', 'c (inspector)', '⌥-click open in editor']) {
      expect(keys).not.toContain(k);
    }
    expect(keys).toContain('⌥E');
    expect(codeCommands(commandDeps(false))).toEqual([]);
  });

  it('the row and the ? rows come back live when a session row arrives', () => {
    syncSessionChrome(false);
    syncSessionChrome(true);
    expect(shown(document.getElementById('code-overlay-row'))).toBe(true);
    const keys = [...document.querySelectorAll<HTMLElement>('#shortcuts tr')].filter(tr => !tr.hidden).map(tr => tr.querySelector('td')?.textContent?.trim());
    expect(keys).toContain('⌥C');
    expect(keys).toContain('o (inspector)');
    expect(codeCommands(commandDeps(true)).map(c => c.id)).toEqual(['code-overlay', 'editor-scheme']);
  });

  it('session commands keep their titles and run their actions', () => {
    const deps = commandDeps(true);
    const [toggle, scheme] = codeCommands(deps);
    expect(toggle.title).toBe('Toggle code overlay');
    expect(toggle.hint).toBe('ref badges on nodes and edges');
    expect(toggle.keys).toBe('⌥C');
    expect(scheme.title).toBe('Editor for code links: Cursor');
    expect(scheme.hint).toBe('currently VS Code');
    void toggle.run();
    void scheme.run();
    expect(deps.toggleCodeOverlay).toHaveBeenCalledOnce();
    expect(deps.cycleEditorScheme).toHaveBeenCalledOnce();
  });
});

describe('code overlay default and per-board memory (G42)', () => {
  it('session board with refs → overlay on at load', () => {
    expect(resolveCodeOverlay({ hasSession: true, refCount: 3, pref: null })).toBe(true);
    expect(resolveCodeOverlay({ hasSession: true, refCount: 0, pref: null })).toBe(false);
    // plain boards: off, whatever was stored
    expect(resolveCodeOverlay({ hasSession: false, refCount: 0, pref: true })).toBe(false);
    // an explicit toggle wins over the default
    expect(resolveCodeOverlay({ hasSession: true, refCount: 3, pref: false })).toBe(false);
    expect(resolveCodeOverlay({ hasSession: true, refCount: 0, pref: true })).toBe(true);
  });

  it('remembers the toggle per board under redcrayon-overlay', () => {
    expect(readOverlayPref('qa-visual-1')).toBeNull();
    writeOverlayPref('qa-visual-1', false);
    writeOverlayPref('accept-r2', true);
    expect(readOverlayPref('qa-visual-1')).toBe(false);
    expect(readOverlayPref('accept-r2')).toBe(true);
    expect(readOverlayPref('Demo')).toBeNull();
    expect(JSON.parse(localStorage.getItem(OVERLAY_KEY)!)).toEqual({ 'qa-visual-1': false, 'accept-r2': true });
  });

  it('keeps only the 50 most recently toggled boards', () => {
    expect(OVERLAY_BOARDS_MAX).toBe(50);
    for (let i = 0; i < 50; i++) {
      writeOverlayPref(`board-${i}`, true);
    }
    // re-toggling board-0 makes it the most recent, so board-1 is the oldest
    writeOverlayPref('board-0', false);
    writeOverlayPref('board-50', true);
    const map = JSON.parse(localStorage.getItem(OVERLAY_KEY)!) as Record<string, boolean>;
    expect(Object.keys(map)).toHaveLength(50);
    expect(readOverlayPref('board-1')).toBeNull();
    expect(readOverlayPref('board-0')).toBe(false);
    expect(readOverlayPref('board-50')).toBe(true);
  });

  it('a malformed value or a throwing store reads as "no preference" and never throws', () => {
    localStorage.setItem(OVERLAY_KEY, '{nope');
    expect(readOverlayPref('qa-visual-1')).toBeNull();
    localStorage.setItem(OVERLAY_KEY, JSON.stringify({ 'qa-visual-1': 'yes' }));
    expect(readOverlayPref('qa-visual-1')).toBeNull();
    // a malformed store is replaced, not merged into
    writeOverlayPref('qa-visual-1', true);
    expect(readOverlayPref('qa-visual-1')).toBe(true);
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    try {
      expect(readOverlayPref('qa-visual-1')).toBeNull();
      expect(() => writeOverlayPref('qa-visual-1', false)).not.toThrow();
    } finally {
      get.mockRestore();
      set.mockRestore();
    }
  });
});
