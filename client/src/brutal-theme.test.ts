import { describe, it, expect, beforeAll } from 'vitest';
import { REDCRAYON_LIGHT } from './shiki-themes';

// Vitest stubs CSS imports (even ?raw) to '', so read the files themselves.
// The client ships no @types/node; the specifier is a variable so tsc types
// the import as any instead of resolving it.
let css = '';
let render = '';
beforeAll(async () => {
  const fsModule = 'node:fs';
  const { readFileSync } = (await import(/* @vite-ignore */ fsModule)) as {
    readFileSync(path: string, encoding: 'utf8'): string;
  };
  const cwd = (globalThis as unknown as { process: { cwd(): string } }).process.cwd();
  css = readFileSync(`${cwd}/src/style.css`, 'utf8');
  render = readFileSync(`${cwd}/src/render.ts`, 'utf8');
});

/** Custom properties of every block whose selector list includes `selector`, in file order. */
function blocks(selector: string): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  for (let at = css.indexOf(selector); at >= 0; at = css.indexOf(selector, at + 1)) {
    const open = css.indexOf('{', at);
    // Only a block's own selector list: no rule body between the match and its brace.
    if (css.slice(at, open).includes('}') || /[.#]/.test(css.slice(at + selector.length, open))) continue;
    const body = css.slice(open + 1, css.indexOf('}', open));
    const t: Record<string, string> = {};
    for (const m of body.matchAll(/--([\w-]+):\s*([^;]+);/g)) t[m[1]] = m[2].trim().toLowerCase();
    out.push(t);
  }
  return out;
}

const DARK = ":root[data-theme='dark']";
const BRUTAL = ":root[data-theme='brutal']";

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

describe('neo-brutalism theme tokens', () => {
  it('defines every palette and freeform-colour token the dark theme does', () => {
    // :root is dark, so a token brutal forgets silently renders dark.
    const dark = blocks(DARK);
    const brutal = blocks(BRUTAL);
    expect(dark).toHaveLength(2);
    for (const [i, block] of dark.entries()) {
      const missing = Object.keys(block).filter(k => brutal.every(b => !(k in b)));
      expect(missing, `dark block ${i + 1}`).toEqual([]);
    }
  });

  it('keeps every text pairing at WCAG AA or better', () => {
    const t = Object.assign({}, ...blocks(BRUTAL)) as Record<string, string>;
    const pairs: [string, string, number][] = [
      ['ink', 'paper', 7],
      ['ink', 'panel', 7],
      ['ink', 'app', 7],
      ['muted', 'panel', 4.5],
      ['faint', 'panel-2', 4.5],
      ['faint', 'app', 4.5],
      ['accent', 'paper', 4.5], // focal labels
      ['accent', 'panel', 4.5], // rail hint, delete hover
      ['accent', 'accent-soft', 4.5], // active toolbar button
      ['on-accent', 'accent', 4.5],
      ['c-blue', 'paper', 4.5], // freeform note text
      ['c-red', 'paper', 4.5],
      ['c-green', 'paper', 4.5],
      ['c-purple', 'paper', 4.5],
      ['c-gray', 'paper', 4.5],
    ];
    for (const [fg, bg, min] of pairs) {
      expect(contrast(t[fg], t[bg]), `--${fg} on --${bg}`).toBeGreaterThanOrEqual(min);
    }
    expect(contrast('#ffffff', t['sel-strong']), 'white on --sel-strong').toBeGreaterThanOrEqual(4.5);
  });

  it('reads code in the light palette on its own code surface', () => {
    const inset = Object.assign({}, ...blocks(BRUTAL))['inset'] as string;
    for (const c of [REDCRAYON_LIGHT.fg!, ...REDCRAYON_LIGHT.palette]) {
      expect(contrast(c, inset), `${c} on --inset`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('draws square corners and hard, unblurred shadows', () => {
    const t = Object.assign({}, ...blocks(BRUTAL)) as Record<string, string>;
    for (const r of ['r-sm', 'r-md', 'r-lg', 'r-xl']) expect(t[r], `--${r}`).toBe('0');
    for (const s of ['shadow', 'shadow-lg']) expect(t[s], `--${s}`).toMatch(/^\d+px \d+px 0 /);
  });

  it("squares the renderer's rect corners by named shape, never by rx", () => {
    expect(render).toContain("e.rect.setAttribute('data-shape', shape)");
    expect(css).toContain(`${BRUTAL} .node-rect[data-shape='rect']`);
    expect(css).not.toContain(".node-rect[rx='10']");
  });

  it('squares selection and presence rings around the square boxes', () => {
    expect(css).toMatch(/:root\[data-theme='brutal'\] :is\(#presence > rect, \.selection-outline\) \{ rx: 0; ry: 0; \}/);
  });

  it('squares the small chips through --r-xs, which the other themes keep at 5px', () => {
    const shared = blocks(':root {').length; // the radii live in a bare :root block
    expect(shared).toBeGreaterThan(0);
    expect(css).toMatch(/--r-xs: 5px;/);
    expect(Object.assign({}, ...blocks(BRUTAL))['r-xs']).toBe('0');
    expect(css).not.toMatch(/border-radius: 5px;/);
  });

  it('keeps board text and edges legible: no weight change, no shadow over arrowheads', () => {
    // node-text.ts measures labels at 500; a heavier draw would overflow the box
    const brutalRules = css.split('}').filter(r => r.includes(BRUTAL));
    expect(brutalRules.filter(r => /\.node-label[^{]*\{[^}]*font-weight/.test(r))).toEqual([]);
    // a box shadow paints over arrowheads that enter from the bottom or right
    expect(brutalRules.filter(r => /\.node-rect[^{]*\{[^}]*filter/.test(r))).toEqual([]);
  });

  it('widens the datastore rule so it reads past the 2px border', () => {
    expect(css).toMatch(/:root\[data-theme='brutal'\] \.node-rule \{ width: 8px; \}/);
  });

  it('declares the chrome heights its 2px borders produce, and the legend reads them', () => {
    const t = Object.assign({}, ...blocks(BRUTAL)) as Record<string, string>;
    // each is the 1px-border height plus 2px
    expect([t['dock-h'], t['zoom-h'], t['shortcuts-h']]).toEqual(['60px', '42px', '40px']);
    expect(css).toContain('bottom: calc(var(--space-5) + var(--zoom-h) + 6px);');
    // the centred shortcuts panel stops short of the dock, hard shadow included
    expect(css).toContain('max-height: min(80%, calc(100% - 2 * (var(--space-5) + var(--dock-h) + var(--space-3))));');
  });
});

describe('neo-brutalism contrast on composited surfaces', () => {
  function blend(fg: string, alpha: number, bg: string): string {
    const c = (h: string, i: number) => parseInt(h.replace('#', '').slice(i, i + 2), 16);
    return '#' + [0, 2, 4].map(i => Math.round(c(fg, i) * alpha + c(bg, i) * (1 - alpha)).toString(16).padStart(2, '0')).join('');
  }

  it('focal accent labels stay AA on every freeform fill', () => {
    const t = Object.assign({}, ...blocks(BRUTAL)) as Record<string, string>;
    for (const f of ['blue', 'red', 'green', 'purple', 'gray']) {
      expect(contrast(t['accent-ink'], t[`c-${f}-fill`]), `--accent-ink on --c-${f}-fill`).toBeGreaterThanOrEqual(4.5);
    }
    expect(css).toContain('.node-label.token-accent { fill: var(--accent-ink); }');
  });

  it('the ⌘K context chip (--sel on --sel-soft over --panel-2) stays AA', () => {
    const t = Object.assign({}, ...blocks(BRUTAL)) as Record<string, string>;
    const m = t['sel-soft'].match(/rgba\((\d+), (\d+), (\d+), ([\d.]+)\)/)!;
    const hex = '#' + [m[1], m[2], m[3]].map(n => Number(n).toString(16).padStart(2, '0')).join('');
    expect(contrast(t.sel, blend(hex, Number(m[4]), t['panel-2']))).toBeGreaterThanOrEqual(4.5);
  });

  it('ink and grey stay distinguishable (≥3:1) and grey text stays AA on paper', () => {
    const t = Object.assign({}, ...blocks(BRUTAL)) as Record<string, string>;
    expect(contrast(t['c-ink'], t['c-gray'])).toBeGreaterThanOrEqual(3);
    expect(contrast(t['c-gray'], t.paper)).toBeGreaterThanOrEqual(4.5);
  });
});
