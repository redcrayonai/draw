import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  EDITOR_SCHEMES,
  sanitizeRefPath,
  buildEditorHref,
  readEditorScheme,
  nextEditorScheme,
  cycleEditorScheme,
  editorLabel,
} from './editor-link';

describe('editorLabel (G28)', () => {
  it('names each editor as its makers do; an unknown scheme shows as is', () => {
    expect(editorLabel('vscode')).toBe('VS Code');
    expect(editorLabel('cursor')).toBe('Cursor');
    expect(editorLabel('zed')).toBe('Zed');
    expect(editorLabel('emacs')).toBe('emacs');
  });
});

describe('sanitizeRefPath', () => {
  it('accepts repo-relative paths', () => {
    expect(sanitizeRefPath('client/src/render.ts')).toBe('client/src/render.ts');
    expect(sanitizeRefPath('a/.hidden/b..c.ts')).toBe('a/.hidden/b..c.ts');
    expect(sanitizeRefPath('docs/with space.md')).toBe('docs/with space.md');
  });

  it('rejects traversal, absolute paths, colons and backslashes', () => {
    for (const bad of ['../x', 'a/../b', 'a/..', '..', '/etc/passwd', 'a:b', 'a\\b', '']) {
      expect(sanitizeRefPath(bad), bad).toBeNull();
    }
  });
});

describe('sanitizeRefPath control characters', () => {
  it('rejects traversal hidden behind a line break or other control char', () => {
    for (const bad of ['a\n/../../etc', 'a\n/..', 'a\r/../x', 'a\u2028/../x', 'a\u2029/..', 'a\0b', 'a\tb', 'a\x7fb', 'a\nb']) {
      expect(sanitizeRefPath(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('buildEditorHref', () => {
  it('encodes every path segment and appends :<line>', () => {
    expect(buildEditorHref('vscode', '/Users/alan/my repo', 'client/src/a b.ts', 12)).toBe(
      'vscode://file/Users/alan/my%20repo/client/src/a%20b.ts:12'
    );
    expect(buildEditorHref('zed', '/r/', 'x.ts', 1)).toBe('zed://file/r/x.ts:1');
  });

  it('encodes a space and non-ASCII characters inside a file name, segment by segment', () => {
    expect(buildEditorHref('vscode', '/Users/alan/repo', 'client/src/my file.ts', 3)).toBe(
      'vscode://file/Users/alan/repo/client/src/my%20file.ts:3'
    );
    expect(buildEditorHref('cursor', '/Users/alan/repo', 'docs/ünï cödé.ts', 1)).toBe(
      'cursor://file/Users/alan/repo/docs/%C3%BCn%C3%AF%20c%C3%B6d%C3%A9.ts:1'
    );
    // the slash between segments is the only unencoded separator
    expect(buildEditorHref('vscode', '/r', 'a b/c d.ts', 1)).toBe('vscode://file/r/a%20b/c%20d.ts:1');
  });

  it('allow-lists the scheme', () => {
    expect(buildEditorHref('file', '/r', 'x.ts', 1)).toBeNull();
    expect(buildEditorHref('javascript', '/r', 'x.ts', 1)).toBeNull();
    for (const s of EDITOR_SCHEMES) {
      expect(buildEditorHref(s, '/r', 'x.ts', 1)).toBe(`${s}://file/r/x.ts:1`);
    }
  });

  it('rejects a bad repo root or path', () => {
    expect(buildEditorHref('vscode', 'relative/root', 'x.ts', 1)).toBeNull();
    expect(buildEditorHref('vscode', '/r:x', 'x.ts', 1)).toBeNull();
    expect(buildEditorHref('vscode', '/r\\x', 'x.ts', 1)).toBeNull();
    expect(buildEditorHref('vscode', '/r', '../x.ts', 1)).toBeNull();
    expect(buildEditorHref('vscode', '/r', 'a\n/../../etc', 1)).toBeNull();
    expect(buildEditorHref('vscode', '/r\n/x', 'x.ts', 1)).toBeNull();
  });
});

describe('editor scheme persistence', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    readEditorScheme();
  });

  it('defaults to vscode and ignores junk in storage', () => {
    expect(readEditorScheme()).toBe('vscode');
    localStorage.setItem('redcrayon-editor', 'emacs');
    expect(readEditorScheme()).toBe('vscode');
    localStorage.setItem('redcrayon-editor', 'zed');
    expect(readEditorScheme()).toBe('zed');
  });

  it('cycles vscode → cursor → zed → vscode and persists', () => {
    expect(nextEditorScheme('vscode')).toBe('cursor');
    expect(nextEditorScheme('zed')).toBe('vscode');
    expect(nextEditorScheme('junk')).toBe('cursor');
    localStorage.setItem('redcrayon-editor', 'vscode');
    expect(cycleEditorScheme()).toBe('cursor');
    expect(localStorage.getItem('redcrayon-editor')).toBe('cursor');
    expect(cycleEditorScheme()).toBe('zed');
    expect(cycleEditorScheme()).toBe('vscode');
  });

  it('keeps cycling when storage throws', () => {
    localStorage.setItem('redcrayon-editor', 'vscode');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('private mode');
    });
    const a = cycleEditorScheme();
    const b = cycleEditorScheme();
    expect(a).not.toBe(b);
    expect(EDITOR_SCHEMES).toContain(a);
    expect(EDITOR_SCHEMES).toContain(b);
  });

  it('keeps cycling when reads succeed but writes hit the storage quota', () => {
    localStorage.setItem('redcrayon-editor', 'vscode');
    readEditorScheme();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    expect(cycleEditorScheme()).toBe('cursor');
    expect(cycleEditorScheme()).toBe('zed');
    expect(cycleEditorScheme()).toBe('vscode');
  });
});
