import { describe, it, expect, beforeAll } from 'vitest';
import { THEMES } from '$lib/theme';

// Read the sources themselves: a CSS import is not the file's text under vitest.
// No @types/node here; the specifier is a variable so tsc types the import as any.
let tokens = '';
let button = '';
let card = '';
beforeAll(async () => {
  const fsModule = 'node:fs';
  const { readFileSync } = (await import(/* @vite-ignore */ fsModule)) as {
    readFileSync(path: string, encoding: 'utf8'): string;
  };
  const cwd = (globalThis as unknown as { process: { cwd(): string } }).process.cwd();
  tokens = readFileSync(`${cwd}/src/lib/styles/tokens.css`, 'utf8');
  button = readFileSync(`${cwd}/src/lib/components/Button.svelte`, 'utf8');
  card = readFileSync(`${cwd}/src/lib/components/BoardTile.svelte`, 'utf8');
});

/** The --rc-* values of a theme's block, var(--rc-x) resolved within it. */
function theme(id: string): Record<string, string> {
  const at = tokens.indexOf(`:root[data-theme='${id}']`);
  const body = tokens.slice(tokens.indexOf('{', at) + 1, tokens.indexOf('}', at));
  const t: Record<string, string> = {};
  for (const m of body.matchAll(/--rc-([\w-]+):\s*([^;]+);/g)) t[m[1]] = m[2].trim().toLowerCase();
  for (const [k, v] of Object.entries(t)) t[k] = v.replace(/^var\(--rc-([\w-]+)\)$/, (_, ref: string) => t[ref]);
  return t;
}

const channels = (hex: string) => [0, 2, 4].map((i) => parseInt(hex.replace('#', '').slice(i, i + 2), 16));

function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** color-mix(in srgb, a p, b) */
function mixed(a: string, p: number, b: string): string {
  const [x, y] = [channels(a), channels(b)];
  return '#' + x.map((v, i) => Math.round(v * p + y[i] * (1 - p)).toString(16).padStart(2, '0')).join('');
}

/** An rgba() value flattened onto a solid surface. */
function over(rgba: string, bg: string): string {
  const m = rgba.match(/rgba\((\d+), (\d+), (\d+), ([\d.]+)\)/)!;
  const hex = '#' + [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('');
  return mixed(hex, Number(m[4]), bg);
}

describe('dashboard theme tokens', () => {
  it.each(THEMES.map((t) => t.id))('%s keeps text at WCAG AA at rest, on hover and pressed', (id) => {
    const t = theme(id);
    const cardHover = mixed(t.card, 0.94, t.tint);
    const pairs: [string, string, string][] = [
      ...['page', 'paper', 'card', 'raised'].flatMap((bg) =>
        ['ink', 'muted', 'faint'].map((fg): [string, string, string] => [`--rc-${fg} on --rc-${bg}`, t[fg], t[bg]])
      ),
      ['--rc-ink on --rc-hover (nav, secondary buttons)', t.ink, t.hover],
      ['--rc-ink on a primary button hover', t.ink, mixed(t.hover, 0.8, t.tint)],
      ['--rc-ink on a board card hover', t.ink, cardHover],
      ['--rc-muted on a board card hover', t.muted, cardHover],
      ['--rc-ink on a pressed segment', t.ink, over(t['sel-soft'], t.raised)],
      ['--rc-accent on --rc-paper', t.accent, t.paper],
    ];
    for (const [what, fg, bg] of pairs) expect(contrast(fg, bg), what).toBeGreaterThanOrEqual(4.5);
  });

  it('builds hover fills from --rc-tint, and board tiles keep their fill on hover', () => {
    expect(button).toContain('color-mix(in srgb, var(--rc-hover) 80%, var(--rc-tint))');
    // --rc-faint is under 4.5:1 on a tinted card, so a tile's hover changes only its border
    expect(card).toMatch(/\.tile:hover \{ border-color: var\(--rc-border\); \}/);
    expect(button + card).not.toMatch(/color-mix\([^)]*var\(--rc-ink\)\)/);
  });
});
