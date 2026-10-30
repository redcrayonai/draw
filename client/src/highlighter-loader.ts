import type { HighlighterCore } from 'shiki/core';

/** Grammars this repo needs; nothing else ships in the bundle. */
export const SHIKI_LANGS = [
  'typescript',
  'tsx',
  'javascript',
  'go',
  'json',
  'css',
  'html',
  'markdown',
  'yaml',
  'toml',
  'shellscript',
] as const;
export type ShikiLang = (typeof SHIKI_LANGS)[number];

/** Grammars this repo has a few files in (G52): each is its own chunk, loaded
 *  into the highlighter on the first expanded ref that needs it. Svelte
 *  embeds the typescript, javascript and css grammars already shipped. */
export const LAZY_LANGS = ['svelte', 'jsonc'] as const;
export type LazyLang = (typeof LAZY_LANGS)[number];

/**
 * One highlighter per page, built on the first expanded ref and cached for
 * the session, with `lang`'s grammar loaded when it is a lazy one. The build
 * lives in its own chunk (highlighter-build.ts), so the main chunk carries
 * only this call.
 */
export function loadHighlighter(lang?: string): Promise<HighlighterCore> {
  return import('./highlighter-build').then(m => m.buildHighlighter(lang));
}
