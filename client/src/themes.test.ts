import { describe, it, expect, beforeAll } from 'vitest';
import { THEMES } from '../../shared/themes';
import { CODE_THEMES } from './shiki-themes';
import { highlightSnippet } from './highlight';

// Vitest stubs CSS imports (even ?raw) to '', so read the files themselves.
// The client ships no @types/node; the specifier is a variable so tsc types
// the import as any instead of resolving it.
let css = '';
beforeAll(async () => {
  const fsModule = 'node:fs';
  const { readFileSync } = (await import(/* @vite-ignore */ fsModule)) as {
    readFileSync(path: string, encoding: 'utf8'): string;
  };
  const cwd = (globalThis as unknown as { process: { cwd(): string } }).process.cwd();
  css = readFileSync(`${cwd}/src/style.css`, 'utf8') + readFileSync(`${cwd}/src/themes.css`, 'utf8');
});

/** Every custom property a theme sets, across all of its blocks. */
function tokens(id: string): Record<string, string> {
  const selector = `:root[data-theme='${id}']`;
  const t: Record<string, string> = {};
  for (let at = css.indexOf(selector); at >= 0; at = css.indexOf(selector, at + 1)) {
    const open = css.indexOf('{', at);
    // Only a block's own selector list: no rule body between the match and its brace.
    if (css.slice(at, open).includes('}') || /[.#]/.test(css.slice(at + selector.length, open))) continue;
    for (const m of css.slice(open + 1, css.indexOf('}', open)).matchAll(/--([\w-]+):\s*([^;]+);/g)) {
      t[m[1]] = m[2].trim().toLowerCase();
    }
  }
  return t;
}

function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map(i => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** color-mix(in srgb, a p, b): the browser mixes the gamma-encoded channels. */
function mixed(a: string, p: number, b: string): string {
  const c = (h: string, i: number) => parseInt(h.replace('#', '').slice(i, i + 2), 16);
  return '#' + [0, 2, 4].map(i => Math.round(c(a, i) * p + c(b, i) * (1 - p)).toString(16).padStart(2, '0')).join('');
}

/** An rgba() token flattened onto a solid surface. */
function over(rgba: string, bg: string): string {
  const m = rgba.match(/rgba\((\d+), (\d+), (\d+), ([\d.]+)\)/)!;
  const a = Number(m[4]);
  const c = (h: string, i: number) => parseInt(h.replace('#', '').slice(i, i + 2), 16);
  return '#' + [1, 2, 3].map((k, i) => Math.round(Number(m[k]) * a + c(bg, i * 2) * (1 - a)).toString(16).padStart(2, '0')).join('');
}

/** OKLab ×100, the dataviz validator's space: Euclidean distance there is its ΔE. */
function oklab(hex: string): number[] {
  const [r, g, b] = [0, 2, 4].map(i => {
    const c = parseInt(hex.replace('#', '').slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ].map(v => v * 100);
}

const HOUSE = ['dark', 'light', 'brutal'];
const PORTED = THEMES.map(t => t.id).filter(id => !HOUSE.includes(id));
const FREEFORM = ['blue', 'red', 'green', 'purple', 'gray'];

describe('every theme', () => {
  it('has a token block in the CSS', () => {
    for (const { id } of THEMES) expect(Object.keys(tokens(id)).length, id).toBeGreaterThan(0);
  });

  it('defines every token the dark theme does', () => {
    // :root is dark, so a token a theme forgets silently renders dark.
    const want = Object.keys(tokens('dark'));
    for (const { id } of THEMES) {
      const t = tokens(id);
      expect(want.filter(k => !(k in t)), id).toEqual([]);
    }
  });

  it("declares the scheme its THEMES entry names", () => {
    for (const { id, scheme } of THEMES) {
      const at = css.indexOf(`:root[data-theme='${id}']`);
      expect(css.slice(at, css.indexOf('}', at)), id).toContain(`color-scheme: ${scheme};`);
    }
  });

  it.each(THEMES.map(t => t.id))('%s keeps text at WCAG AA on every surface it sits on', id => {
    const t = tokens(id);
    const pairs: [string, string][] = [
      ...['paper', 'panel', 'panel-2', 'app'].flatMap(bg => [['ink', bg], ['muted', bg], ['faint', bg]] as [string, string][]),
      ['accent', 'paper'], // focal labels
      ['accent', 'panel'],
      ['accent', 'accent-soft'], // active toolbar button
      ['on-accent', 'accent'],
      ['on-sel', 'sel-strong'], // the selection size badge
      ['ok', 'panel'],
      ...FREEFORM.map(f => [`c-${f}`, 'paper'] as [string, string]), // freeform note text
    ];
    for (const [fg, bg] of pairs) {
      expect(contrast(t[fg], t[bg]), `--${fg} on --${bg}`).toBeGreaterThanOrEqual(4.5);
    }
    // Focal labels sit on the freeform fills too; neo-brutalism's saturated fills take --accent-ink.
    const focal = t['accent-ink'] ?? t.accent;
    for (const f of FREEFORM) {
      expect(contrast(focal, t[`c-${f}-fill`]), `focal label on --c-${f}-fill`).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(t['c-amber'], t.panel), 'warn glyph on a chart card').toBeGreaterThanOrEqual(3);
  });

  it.each(THEMES.map(t => t.id))('%s keeps text at WCAG AA on hover and pressed fills', id => {
    const t = tokens(id);
    const tint = t.tint === 'var(--ink)' ? t.ink : t.tint;
    const pairs: [string, string, string][] = [
      ['--ink on --panel-hi (every hover fill)', t.ink, t['panel-hi']],
      ['--muted on --panel-hi (key hints, ref locations)', t.muted, t['panel-hi']],
      ['--ink on .btn-primary:hover', t.ink, mixed(t['panel-hi'], 0.8, tint)],
      ['--ink on a pressed control', t.ink, mixed(t['panel-hi'], 0.88, tint)],
      ['--on-accent on the empty-board buttons\' hover', t['on-accent'], mixed(t.accent, 0.88, t.ink)],
      ['--ink on .chip.active over --panel', t.ink, over(t['sel-soft'], t.panel)],
      ['--ink on .chip.active over --panel-2', t.ink, over(t['sel-soft'], t['panel-2'])],
    ];
    for (const [what, fg, bg] of pairs) expect(contrast(fg, bg), what).toBeGreaterThanOrEqual(4.5);
  });

  it('builds hover and pressed fills from --tint, and pressed text steps up to --ink', () => {
    const flat = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const decls = (sel: string) => flat.match(new RegExp(`(?:^|\\})\\s*${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
    expect(decls('.btn-primary:hover')).toContain('color-mix(in srgb, var(--panel-hi) 80%, var(--tint))');
    const pressed = decls('.ctl:active,\n.chip:active,\n.insp-ref-row:active,\n.rail-switch:active');
    expect(pressed).toContain('color-mix(in srgb, var(--panel-hi) 88%, var(--tint))');
    expect(pressed).toContain('color: var(--ink);');
    expect(decls('.insp-ref-row:active :is(.insp-ref-loc, .disc),\n.chip:active .disc,\n.rail-switch:active .overlay-key')).toContain('color: var(--ink);');
    // no other fill mixes toward ink: a dim ink (One Dark) would sink the text drawn on it
    expect(flat.match(/color-mix\(in srgb, var\(--panel-hi\) \d+%, var\(--ink\)\)/g)).toBeNull();
  });

  it.each(THEMES.map(t => t.id))('%s labels every treemap fill legibly', id => {
    const t = tokens(id);
    // House dark's white labels sit at 3.07–3.94:1; every editor theme picks the better of light or dark ink.
    const min = HOUSE.includes(id) ? 3 : 4.5;
    for (let n = 1; n <= 5; n++) {
      expect(contrast(t[`on-series-${n}`], t[`series-${n}`]), `on-series-${n}`).toBeGreaterThanOrEqual(min);
    }
    expect(contrast(t['on-other'], t['c-gray']), 'on-other').toBeGreaterThanOrEqual(min);
  });

  it('never makes the accent, red or green a chart series, nor one that passes for them', () => {
    const dE = (a: string, b: string) => Math.hypot(...oklab(a).map((v, k) => v - oklab(b)[k]));
    for (const { id } of THEMES) {
      const t = tokens(id);
      const series = [1, 2, 3, 4, 5].map(n => t[`series-${n}`]);
      expect(new Set(series).size, id).toBe(5);
      // house dark's amber sits 8.9 from its accent and its magenta 10 from its red; nothing comes closer
      for (const reserved of ['accent', 'c-red', 'c-green', 'ok']) {
        for (const [i, c] of series.entries()) expect(dE(c, t[reserved]), `${id} series-${i + 1} vs --${reserved}`).toBeGreaterThanOrEqual(8.9);
      }
    }
  });

  it('lets the picker paint any theme in its own tokens', () => {
    for (const { id } of THEMES) expect(css, id).toMatch(new RegExp(`\\[data-swatch='${id}'\\] \\{`));
  });
});

describe('editor themes', () => {
  it.each(PORTED)('%s: any two series stay apart, as a pie legend sets them side by side', id => {
    const t = tokens(id);
    const series = [1, 2, 3, 4, 5].map(n => oklab(t[`series-${n}`]));
    // no editor theme sets two series closer than house dark's closest pair (9.8)
    for (let i = 0; i < 5; i++) {
      for (let j = i + 1; j < 5; j++) {
        expect(Math.hypot(...series[i].map((v, k) => v - series[j][k])), `series-${i + 1} vs series-${j + 1}`).toBeGreaterThanOrEqual(9.8);
      }
    }
  });

  it.each(PORTED)('%s: the ⌘K context chip (--sel on --sel-soft over --panel-2) stays AA', id => {
    const t = tokens(id);
    expect(contrast(t.sel, over(t['sel-soft'], t['panel-2']))).toBeGreaterThanOrEqual(4.5);
  });

  it.each(PORTED)('%s: code is drawn on --inset in --ink, and every syntax colour is AA there', id => {
    const t = tokens(id);
    const theme = CODE_THEMES[id as keyof typeof CODE_THEMES];
    expect(theme.fg.toLowerCase()).toBe(t.ink);
    expect(theme.bg.toLowerCase()).toBe(t.inset);
    for (const c of theme.palette) expect(contrast(c, t.inset), c).toBeGreaterThanOrEqual(4.5);
  });

  it.each(PORTED)('%s: a TypeScript snippet draws in the theme\'s own syntax colours', async id => {
    const theme = CODE_THEMES[id as keyof typeof CODE_THEMES];
    const snippet = [
      '// Token bucket.',
      'export class Limiter extends Base {',
      '  allow(cost: number, key = "default"): boolean {',
      '    return this.tokens - cost >= 0 && key.length > 0;',
      '  }',
      '}',
    ].join('\n');
    const block = await highlightSnippet(snippet, 'typescript', id as keyof typeof CODE_THEMES, 1, '');
    const rgb = (hex: string) => {
      const [r, g, b] = [0, 2, 4].map(i => parseInt(hex.slice(1 + i, 3 + i), 16));
      return `rgb(${r}, ${g}, ${b})`;
    };
    const colours = new Set(
      [...block.querySelectorAll<HTMLElement>('.code-text [style]')].map(s => s.style.color).filter(c => c !== '')
    );
    // Comments, keywords, strings, numbers, functions and types at the least.
    expect(colours.size).toBeGreaterThanOrEqual(5);
    const palette = new Set(theme.palette.map(rgb));
    for (const c of colours) expect(palette.has(c), `${c} not in the ${id} palette`).toBe(true);
  });
});
