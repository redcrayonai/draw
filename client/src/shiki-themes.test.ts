import { describe, it, expect, beforeAll } from 'vitest';
import { highlightSnippet } from './highlight';
import { REDCRAYON_DARK, REDCRAYON_LIGHT } from './shiki-themes';

// Vitest stubs CSS imports (even ?raw) to '', so read the file itself. The
// client ships no @types/node; the specifier is a variable so tsc types the
// import as any instead of resolving it.
let css = '';
beforeAll(async () => {
  const fsModule = 'node:fs';
  const { readFileSync } = (await import(/* @vite-ignore */ fsModule)) as {
    readFileSync(path: string, encoding: 'utf8'): string;
  };
  // jsdom gives import.meta.url an http: scheme; vitest runs from client/.
  const cwd = (globalThis as unknown as { process: { cwd(): string } }).process.cwd();
  css = readFileSync(`${cwd}/src/style.css`, 'utf8');
});

/** Custom property values of one theme block in style.css. */
function tokens(selector: string): Record<string, string> {
  const start = css.indexOf(selector);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/--([\w-]+):\s*([^;]+);/g)) {
    out[m[1]] = m[2].trim().toLowerCase();
  }
  return out;
}

function rgb(hex: string): string {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
  return `rgb(${r}, ${g}, ${b})`;
}

const SNIPPET = [
  '/** Token bucket. */',
  'export class Limiter {',
  '  private tokens = 10;',
  '  allow(cost: number, key = "default"): boolean {',
  '    const left = this.tokens - cost; // remaining',
  '    return left >= 0 && key.length > 0;',
  '  }',
  '}',
].join('\n');

describe('Shiki themes mapped onto the app palette (F21)', () => {
  const cases = [
    ['dark', ":root[data-theme='dark']", REDCRAYON_DARK],
    ['light', ":root[data-theme='light']", REDCRAYON_LIGHT],
  ] as const;

  it.each(cases)('%s: built from --ink/--muted/--faint/--inset, never --accent', (_, selector, theme) => {
    const t = tokens(selector);
    const all = JSON.stringify(theme).toLowerCase();
    expect(theme.fg.toLowerCase()).toBe(t.ink);
    expect(theme.bg.toLowerCase()).toBe(t.inset);
    expect(all).toContain(t.muted);
    expect(all).toContain(t.faint);
    expect(all).not.toContain(t.accent);
  });

  it.each(cases)('%s: a highlighted TS snippet uses no accent colour on any token', async (name, selector, theme) => {
    const t = tokens(selector);
    const block = await highlightSnippet(SNIPPET, 'typescript', name, 1, 'Limiter.allow');
    expect(block.dataset.lang).toBe('typescript');
    const colours = new Set(
      [...block.querySelectorAll<HTMLElement>('.code-text [style]')].map(s => s.style.color).filter(c => c !== '')
    );
    // Real highlighting happened: keywords, strings and comments differ from plain ink.
    expect(colours.size).toBeGreaterThanOrEqual(3);
    // Accent is reserved for focal nodes: neither theme's accent appears.
    expect(colours.has(rgb(tokens(":root[data-theme='dark']").accent))).toBe(false);
    expect(colours.has(rgb(tokens(":root[data-theme='light']").accent))).toBe(false);
    // Every token colour comes from the theme's own small palette.
    const palette = new Set(theme.palette.map(rgb));
    for (const c of colours) {
      expect(palette.has(c), `${c} not in the ${name} palette`).toBe(true);
    }
    expect(colours.has(rgb(t.faint))).toBe(true); // the comment
  });
});
