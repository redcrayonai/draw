import { describe, it, expect, beforeAll } from 'vitest';
import { ICONS, ICON_IDS, ICON_SECTIONS, ICON_NODE_KINDS, isIconId, iconSpec } from '../../module/src/node-icons';
import { THEMES } from '../../shared/themes';
import { LOGO_LOADERS, type LogoDrawing, type LogoNode } from './node-logos';
import { drawableIcon, drawableIcons, iconGroup, iconPaint, iconSvg, loadLogo, loadLogos, logosReady, setLogoListener } from './node-icons';

/** Every logo's drawing, read straight from its chunk. */
const LOGOS: Record<string, LogoDrawing> = {};
beforeAll(async () => {
  await Promise.all(Object.entries(LOGO_LOADERS).map(async ([id, load]) => {
    LOGOS[id] = await load();
  }));
});

// Vitest stubs CSS imports, so read the stylesheets themselves (as themes.test.ts does).
let css = '';
beforeAll(async () => {
  const fsModule = 'node:fs';
  const { readFileSync } = (await import(/* @vite-ignore */ fsModule)) as { readFileSync(path: string, encoding: 'utf8'): string };
  const cwd = (globalThis as unknown as { process: { cwd(): string } }).process.cwd();
  css = readFileSync(`${cwd}/src/style.css`, 'utf8') + readFileSync(`${cwd}/src/themes.css`, 'utf8');
});

describe('the icon registry (module/src/node-icons.ts)', () => {
  it('has unique, stable kebab-case ids, a name, a placeable kind and search terms', () => {
    expect(new Set(ICON_IDS).size).toBe(ICON_IDS.length);
    for (const i of ICONS) {
      expect(i.id, i.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(i.name.length, i.id).toBeGreaterThan(0);
      expect(['service', 'datastore', 'external'], i.id).toContain(i.kind);
      expect(i.terms.every(t => t === t.toLowerCase()), i.id).toBe(true);
      expect(isIconId(i.id)).toBe(true);
      expect(iconSpec(i.id)).toBe(i);
    }
    expect(isIconId('clippy')).toBe(false);
    expect(isIconId('constructor')).toBe(false);
    expect(ICON_NODE_KINDS).toEqual(['service', 'datastore', 'external', 'boundary']);
  });

  it('holds the agreed inventory: 12 agents, 8 systems, and the AI and cloud logos whose brand rules allow it', () => {
    const count = (s: string) => ICONS.filter(i => i.section === s).length;
    expect(ICON_SECTIONS.map(s => s.title)).toEqual(['Agents', 'Systems', 'AI logos', 'Cloud logos']);
    expect([count('agents'), count('systems')]).toEqual([12, 8]);
    expect(ICONS.filter(i => i.section === 'ai').map(i => i.id)).toEqual([
      'claude', 'claude-code', 'openai', 'grok', 'mistral', 'hugging-face', 'openrouter', 'cursor', 'github-copilot', 'windsurf', 'devin', 'openclaw', 'hermes-agent', 'opencode',
    ]);
    expect(ICONS.filter(i => i.section === 'cloud').map(i => i.id)).toEqual(['aws', 'azure', 'vercel', 'supabase', 'firebase', 'neon', 'kubernetes']);
    // AWS and Azure take the names their brand rules ask for
    expect(iconSpec('aws')?.name).toBe('AWS Cloud');
    expect(iconSpec('azure')?.name).toBe('Microsoft Azure');
    // every logo is a product outside the repo
    expect(ICONS.filter(i => i.section === 'ai' || i.section === 'cloud').every(i => i.kind === 'external')).toBe(true);
  });
});

describe('logo artwork loads one chunk per logo', () => {
  it('a logo draws nothing until its chunk arrives, then tells the listener; authored icons draw at once', async () => {
    let calls = 0;
    setLogoListener(() => calls++);
    expect(logosReady()).toBe(false);
    expect(iconPaint('grok')).toBe('brand');
    expect(iconGroup('agent', 28)).not.toBeNull();
    // asking for the drawing starts the load
    expect(iconGroup('grok', 28)).toBeNull();
    const once = loadLogo('grok');
    expect(loadLogo('grok')).toBe(once);
    await once;
    expect(calls).toBe(1);
    expect(iconGroup('grok', 28)).not.toBeNull();
    expect(logosReady()).toBe(false); // only Grok's chunk has arrived
    await loadLogos();
    expect(logosReady()).toBe(true);
    await loadLogo('clippy'); // no such logo: resolves at once
    setLogoListener(null);
  });
});

describe('the drawings', () => {
  beforeAll(() => loadLogos());

  it('every registry id has one: stroke for agents and systems, the brand\'s own artwork for logos', () => {
    const paint = { agents: 'stroke', systems: 'stroke', ai: 'brand', cloud: 'brand' } as const;
    for (const i of ICONS) expect(iconPaint(i.id), i.id).toBe(paint[i.section]);
    expect(drawableIcons()).toEqual([...ICONS]);
    expect(Object.keys(LOGO_LOADERS).sort()).toEqual(ICONS.filter(i => i.section === 'ai' || i.section === 'cloud').map(i => i.id).sort());
  });

  it('an unknown or withdrawn id draws nothing', () => {
    expect(iconPaint('clippy')).toBeNull();
    expect(iconPaint('gemini')).toBeNull();
    expect(iconGroup('clippy', 28)).toBeNull();
    expect(iconSvg('clippy', 20)).toBeNull();
    expect(drawableIcon('clippy')).toBeUndefined();
    expect(drawableIcon(undefined)).toBeUndefined();
    expect(drawableIcon('agent')?.name).toBe('Agent');
  });

  it('authored icons stroke in currentColor on the 16-unit grid, scaled to the size asked for', () => {
    const g = iconGroup('orchestrator', 28)!;
    expect(g.getAttribute('class')).toBe('node-icon node-icon-stroke');
    const inner = g.firstElementChild!;
    expect(inner.getAttribute('transform')).toBe('scale(1.75)');
    expect(inner.getAttribute('stroke')).toBe('currentColor');
    expect(inner.getAttribute('stroke-width')).toBe('1.3');
    expect(inner.getAttribute('fill')).toBe('none');
    // dots are filled with the same colour
    const dots = iconGroup('gateway', 16)!.querySelectorAll('circle');
    expect(dots).toHaveLength(3);
    for (const d of dots) expect(d.getAttribute('fill')).toBe('currentColor');
  });

  it('the agent icon is the presence avatar\'s bot head', () => {
    const path = iconGroup('agent', 16)!.querySelector('path')!.getAttribute('d');
    expect(path).toBe('M8 2.5v2.5M3.5 5h9a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1ZM6 8.5v1M10 8.5v1');
  });

  it('a logo with a dark-background file carries both, one per scheme; one without draws its file on both', () => {
    for (const id of ['aws', 'grok', 'github-copilot']) {
      const g = iconGroup(id, 28)!;
      expect(g.getAttribute('class'), id).toBe('node-icon node-icon-brand');
      expect([...g.children].map(c => c.getAttribute('class')), id).toEqual(['logo-art logo-on-light', 'logo-art logo-on-dark']);
    }
    for (const id of ['azure', 'mistral', 'openclaw']) {
      expect([...iconGroup(id, 28)!.children].map(c => c.getAttribute('class')), id).toEqual(['logo-art']);
    }
  });

  it('fits non-square artwork centred in the box', () => {
    // Vercel's triangle is 1155 × 1000: as wide as the box, centred vertically.
    const art = iconGroup('vercel', 28)!.firstElementChild!;
    const [, tx, ty, s] = art.getAttribute('transform')!.match(/translate\(([-\d.]+) ([-\d.]+)\) scale\(([\d.]+)\)/)!.map(Number);
    expect(tx).toBe(0);
    expect(s * 1155).toBeCloseTo(28, 1);
    expect(ty).toBeCloseTo((28 - 1000 * s) / 2, 1);
  });

  it('draws a file with a wide transparent margin larger, about the same centre, never cropped', () => {
    expect(LOGOS.windsurf.fit).toBeGreaterThan(1);
    const art = iconGroup('windsurf', 28)!.firstElementChild!;
    const [, tx, ty, s] = art.getAttribute('transform')!.match(/translate\(([-\d.]+) ([-\d.]+)\) scale\(([\d.]+)\)/)!.map(Number);
    expect(s * 1024).toBeCloseTo(28 * LOGOS.windsurf.fit, 1);
    expect(tx + (1024 * s) / 2).toBeCloseTo(14, 1);
    expect(ty + (1024 * s) / 2).toBeCloseTo(14, 1);
    expect(LOGOS.devin.fit).toBe(1); // its square is part of the file: drawn whole, inside the box
  });

  it('chrome tiles keep the dock icons\' 16-unit grid for authored icons', () => {
    expect(iconSvg('agent', 20)!.getAttribute('viewBox')).toBe('0 0 16 16');
    expect(iconSvg('grok', 20)!.getAttribute('viewBox')).toBe('0 0 20 20');
    expect(iconSvg('agent', 20)!.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('vendored logo artwork (scripts/vendor-logos.mjs)', () => {
  const SHAPES = new Set(['g', 'path', 'circle', 'ellipse', 'rect', 'polygon', 'polyline', 'line', 'defs', 'linearGradient', 'radialGradient', 'stop', 'clipPath', 'mask']);
  const walk = (n: LogoNode, f: (n: LogoNode) => void) => {
    f(n);
    for (const k of n[2] ?? []) walk(k, f);
  };

  it('holds shapes only: no scripts, images, text, styles or event handlers', () => {
    for (const [id, logo] of Object.entries(LOGOS)) {
      for (const art of [logo.light, logo.dark]) {
        if (art === null) continue;
        expect(art.viewBox, id).toMatch(/^-?[\d.]+[\s,]+-?[\d.]+[\s,]+[\d.]+[\s,]+[\d.]+$/);
        walk(art.tree, ([tag, attrs]) => {
          expect(SHAPES.has(tag), `${id} <${tag}>`).toBe(true);
          for (const [k, v] of Object.entries(attrs)) {
            expect(k.startsWith('on'), `${id} ${k}`).toBe(false);
            expect(v, `${id} ${k}`).not.toMatch(/javascript:|https?:/i);
          }
        });
      }
    }
  });

  it('namespaces every id per logo and variant, and every reference resolves inside the same file', () => {
    for (const [id, logo] of Object.entries(LOGOS)) {
      for (const [variant, art] of [['l', logo.light], ['d', logo.dark]] as const) {
        if (art === null) continue;
        const ids = new Set<string>();
        const refs: string[] = [];
        walk(art.tree, ([, attrs]) => {
          if (attrs.id) ids.add(attrs.id);
          for (const v of Object.values(attrs)) for (const m of v.matchAll(/url\(#([^)]+)\)/g)) refs.push(m[1]);
        });
        for (const i of ids) expect(i, id).toMatch(new RegExp(`^rcl-${id}-${variant}-\\d+$`));
        for (const r of refs) expect(ids.has(r), `${id} #${r}`).toBe(true);
      }
    }
  });

  it('keeps each brand\'s own colours: no logo paints with the theme\'s currentColor', () => {
    for (const [id, logo] of Object.entries(LOGOS)) {
      for (const art of [logo.light, logo.dark]) {
        if (art === null) continue;
        const paints = new Set<string>();
        walk(art.tree, ([, attrs]) => {
          for (const k of ['fill', 'stroke', 'stop-color']) if (attrs[k] && attrs[k] !== 'none') paints.add(attrs[k].toLowerCase());
        });
        expect(paints.size, id).toBeGreaterThan(0);
        expect(paints.has('currentcolor'), id).toBe(false);
      }
    }
  });
});

describe('icon colours in every theme', () => {
  it('the stylesheet\'s light-theme list is exactly the light themes in shared/themes.ts', () => {
    for (const cls of ['.logo-on-light { display: inline; }', '.logo-on-dark { display: none; }']) {
      const line = css.split('\n').find(l => l.includes(cls) && l.startsWith(':root:is('));
      expect(line, cls).toBeDefined();
      const ids = [...line!.matchAll(/\[data-theme='([\w-]+)'\]/g)].map(m => m[1]).sort();
      expect(ids, cls).toEqual(THEMES.filter(t => t.scheme === 'light').map(t => t.id).sort());
    }
  });

  /** Every custom property a theme sets (themes.test.ts tokens()). */
  const tokens = (id: string): Record<string, string> => {
    const selector = `:root[data-theme='${id}']`;
    const t: Record<string, string> = {};
    for (let at = css.indexOf(selector); at >= 0; at = css.indexOf(selector, at + 1)) {
      const open = css.indexOf('{', at);
      if (css.slice(at, open).includes('}') || /[.#]/.test(css.slice(at + selector.length, open))) continue;
      for (const m of css.slice(open + 1, css.indexOf('}', open)).matchAll(/--([\w-]+):\s*([^;]+);/g)) t[m[1]] = m[2].trim().toLowerCase();
    }
    return t;
  };
  const luminance = (hex: string) => {
    const h = hex.replace('#', '');
    const [r, g, b] = [0, 2, 4].map(i => {
      const c = parseInt(h.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a: string, b: string) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const hex = (v: string | undefined) => (v && /^#[0-9a-f]{6}$/.test(v) ? v : undefined);

  // WCAG 1.4.11: graphical objects need 3:1 against what they sit on. Boxes fill
  // with --panel (or the colour's fill); externals are unfilled, so the icon sits on --paper.
  it.each(THEMES.map(t => t.id))('%s: authored icons hold 3:1 on every fill they can sit on', id => {
    const t = tokens(id);
    const surfaces = (fill: string) => [t[fill], t.paper].map(hex).filter((v): v is string => v !== undefined);
    const pairs: Array<[string, string, string]> = [];
    for (const bg of surfaces('panel')) pairs.push(['--ink', t.ink, bg]);
    for (const c of ['blue', 'red', 'green', 'purple', 'gray', 'ink']) {
      for (const bg of surfaces(`c-${c}-fill`)) pairs.push([`--c-${c}`, t[`c-${c}`], bg]);
    }
    for (const bg of surfaces('accent-soft')) pairs.push(['--accent', t.accent, bg]);
    const checked = pairs.filter(([, fg]) => hex(fg) !== undefined);
    expect(checked.length).toBeGreaterThan(12);
    for (const [name, fg, bg] of checked) expect(contrast(fg, bg), `${id}: ${name} on ${bg}`).toBeGreaterThanOrEqual(3);
  });
});
