import { describe, it, expect, vi, beforeEach } from 'vitest';

const { createHighlighterCore, loadLanguage, loaded } = vi.hoisted(() => {
  const loaded = new Set<string>();
  const loadLanguage = vi.fn(async (...langs: unknown[]) => {
    for (const l of langs) {
      const mod = (await l) as { default: Array<{ name: string }> };
      for (const reg of mod.default) {
        loaded.add(reg.name);
      }
    }
  });
  const createHighlighterCore = vi.fn(async (opts: { langs: unknown[] }) => {
    for (const l of opts.langs) {
      const mod = (await l) as { default: Array<{ name: string }> };
      for (const reg of mod.default) {
        loaded.add(reg.name);
      }
    }
    return { loadLanguage, getLoadedLanguages: () => [...loaded], codeToTokens: vi.fn() };
  });
  return { createHighlighterCore, loadLanguage, loaded };
});

vi.mock('shiki/core', () => ({ createHighlighterCore }));
vi.mock('shiki/engine/javascript', () => ({ createJavaScriptRegexEngine: () => ({}) }));

beforeEach(() => {
  vi.resetModules();
  loaded.clear();
  createHighlighterCore.mockClear();
  loadLanguage.mockClear();
});

describe('highlighter loader (G52)', () => {
  it('ships the eleven grammars eagerly and keeps svelte and jsonc out of the first build', async () => {
    const { SHIKI_LANGS, LAZY_LANGS, loadHighlighter } = await import('./highlighter-loader');
    expect(SHIKI_LANGS).toHaveLength(11);
    expect(SHIKI_LANGS).not.toContain('svelte');
    expect(SHIKI_LANGS).not.toContain('jsonc');
    expect(LAZY_LANGS).toEqual(['svelte', 'jsonc']);
    await loadHighlighter('typescript');
    expect(createHighlighterCore).toHaveBeenCalledTimes(1);
    expect(loaded.has('svelte')).toBe(false);
    expect(loaded.has('jsonc')).toBe(false);
    expect(loadLanguage).not.toHaveBeenCalled();
  });

  it('loads a lazy grammar once, on the first ref that needs it', async () => {
    const { loadHighlighter } = await import('./highlighter-loader');
    await Promise.all([loadHighlighter('svelte'), loadHighlighter('svelte')]);
    await loadHighlighter('svelte');
    expect(loadLanguage).toHaveBeenCalledTimes(1);
    expect(loaded.has('svelte')).toBe(true);
    await loadHighlighter('jsonc');
    expect(loadLanguage).toHaveBeenCalledTimes(2);
    expect(loaded.has('jsonc')).toBe(true);
    expect(createHighlighterCore).toHaveBeenCalledTimes(1);
  });

  it('a failed grammar load is retried on the next expand', async () => {
    const { loadHighlighter } = await import('./highlighter-loader');
    loadLanguage.mockRejectedValueOnce(new Error('chunk failed'));
    await expect(loadHighlighter('jsonc')).rejects.toThrow('chunk failed');
    await loadHighlighter('jsonc');
    expect(loadLanguage).toHaveBeenCalledTimes(2);
    expect(loaded.has('jsonc')).toBe(true);
  });
});
