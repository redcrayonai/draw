import type { HighlighterCore, LanguageRegistration } from 'shiki/core';
import { CODE_THEMES } from './shiki-themes';
// Type-only: a runtime import back into the loader would be a cycle.
import type { LazyLang } from './highlighter-loader';

const LAZY_IMPORTS: Record<LazyLang, () => Promise<{ default: LanguageRegistration[] }>> = {
  svelte: () => import('@shikijs/langs/svelte'),
  jsonc: () => import('@shikijs/langs/jsonc'),
};

function isLazy(lang: string): lang is LazyLang {
  return Object.prototype.hasOwnProperty.call(LAZY_IMPORTS, lang);
}

let pending: Promise<HighlighterCore> | null = null;
/** One load per lazy grammar; a failed load is dropped so the next expand retries. */
const lazyPending = new Map<LazyLang, Promise<void>>();

/**
 * The highlighter (see loadHighlighter), plus `lang`'s grammar when it is a
 * lazy one. JavaScript regex engine: no wasm, no network. A failed build or
 * grammar load clears its cache so the next expand retries instead of
 * staying broken.
 */
export function buildHighlighter(lang?: string): Promise<HighlighterCore> {
  const core = loadCore();
  if (lang === undefined || !isLazy(lang)) {
    return core;
  }
  let grammar = lazyPending.get(lang);
  if (grammar === undefined) {
    grammar = core
      .then(hl => hl.loadLanguage(LAZY_IMPORTS[lang]()))
      .catch((err: unknown) => {
        lazyPending.delete(lang);
        throw err;
      });
    lazyPending.set(lang, grammar);
  }
  return grammar.then(() => core);
}

function loadCore(): Promise<HighlighterCore> {
  if (pending === null) {
    pending = (async () => {
      const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
        import('shiki/core'),
        import('shiki/engine/javascript'),
      ]);
      return createHighlighterCore({
        // Palette-mapped themes (shiki-themes.ts), not GitHub's: each is a
        // handful of colours checked against its theme's code surface.
        themes: Object.values(CODE_THEMES),
        langs: [
          import('@shikijs/langs/typescript'),
          import('@shikijs/langs/tsx'),
          import('@shikijs/langs/javascript'),
          import('@shikijs/langs/go'),
          import('@shikijs/langs/json'),
          import('@shikijs/langs/css'),
          import('@shikijs/langs/html'),
          import('@shikijs/langs/markdown'),
          import('@shikijs/langs/yaml'),
          import('@shikijs/langs/toml'),
          import('@shikijs/langs/shellscript'),
        ],
        engine: createJavaScriptRegexEngine(),
      });
    })().catch((err: unknown) => {
      pending = null;
      throw err;
    });
  }
  return pending;
}
