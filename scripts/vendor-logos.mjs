#!/usr/bin/env node
// Writes the logo drawings of the library's AI logos and Cloud logos from
// each brand's own SVG files: client/src/logos/<id>.ts, one module per logo, and
// client/src/node-logos.ts, their loaders (each logo is its own chunk, fetched
// when a board shows it or the library opens). Nothing is redrawn: each file is
// parsed, reduced to an allow-list of shape elements and attributes (class styles
// are inlined first; editor metadata is dropped), its ids are namespaced, and it is
// written out as element trees, so the client never parses markup.
//
//   node scripts/vendor-logos.mjs <sources.json>
//
// sources.json: { "<id>": { "light": "<file.svg>", "dark": "<file.svg>" | null, "fit": <number>?,
//                           "source": "<package or kit, version>", "url": "<where it came from>" } }
// Paths are relative to sources.json. `light` shows on light themes and `dark`
// (the brand's dark-background file) on dark ones; with no `dark`, `light`
// shows on both. `fit` (default 1) draws the whole file that many times the icon
// box, centred, for files whose mark sits inside a wide transparent margin.
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { ICONS } from '../module/src/node-icons.ts';

const require = createRequire(new URL('../client/package.json', import.meta.url));
const { JSDOM } = require('jsdom');

const SVG_NS = 'http://www.w3.org/2000/svg';
const ELEMENTS = new Set(['g', 'path', 'circle', 'ellipse', 'rect', 'polygon', 'polyline', 'line', 'defs', 'linearGradient', 'radialGradient', 'stop', 'clipPath', 'mask']);
const DROPPED = new Set(['title', 'desc', 'metadata', 'style']);
const GEOMETRY = ['d', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'width', 'height', 'points', 'transform', 'offset', 'fx', 'fy', 'gradientUnits', 'gradientTransform', 'spreadMethod', 'clipPathUnits', 'maskUnits', 'maskContentUnits'];
const PAINT = ['fill', 'fill-rule', 'fill-opacity', 'clip-rule', 'clip-path', 'mask', 'opacity', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-opacity', 'stroke-dasharray', 'stop-color', 'stop-opacity'];
const ATTRS = new Set([...GEOMETRY, ...PAINT, 'id']);

const fail = msg => {
  throw new Error(msg);
};

/** `.a{fill:#fff}.b,.c{opacity:.5}` → Map(class → [[prop, value]]). Anything else is refused. */
function classRules(css) {
  const rules = new Map();
  const body = css.replace(/\/\*[^]*?\*\//g, '');
  for (const m of body.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const decls = m[2].split(';').map(d => d.trim()).filter(Boolean).map(d => d.split(':').map(s => s.trim()));
    for (const sel of m[1].split(',').map(s => s.trim())) {
      if (!/^\.[\w-]+$/.test(sel)) fail(`unsupported <style> selector '${sel}'`);
      rules.set(sel.slice(1), [...(rules.get(sel.slice(1)) ?? []), ...decls]);
    }
  }
  return rules;
}

/** One file as { viewBox, tree }; ids become `${prefix}-<n>` and references follow. */
function vendor(file, prefix) {
  const text = readFileSync(file, 'utf8');
  if (/<script|<foreignObject|<image|javascript:|\son\w+=/i.test(text)) fail(`${file}: scripts, foreign content and images are not vendored`);
  const doc = new JSDOM(text, { contentType: 'image/svg+xml' }).window.document;
  const root = doc.documentElement;
  if (root.localName !== 'svg') fail(`${file}: not an svg`);
  const viewBox = root.getAttribute('viewBox') ?? fail(`${file}: no viewBox`);
  const styles = new Map();
  for (const s of root.querySelectorAll('style')) for (const [k, v] of classRules(s.textContent)) styles.set(k, [...(styles.get(k) ?? []), ...v]);

  // Ids that something references survive (renamed); the rest are dropped.
  const used = new Set();
  for (const m of text.matchAll(/url\(\s*['"]?#([^'")\s]+)['"]?\s*\)|href="#([^"]+)"/g)) used.add(m[1] ?? m[2]);
  const ids = new Map([...used].map((id, i) => [id, `${prefix}-${i}`]));
  const rename = value => value.replace(/url\(\s*['"]?#([^'")\s]+)['"]?\s*\)/g, (_m, id) => (ids.has(id) ? `url(#${ids.get(id)})` : fail(`${file}: dangling reference #${id}`)));

  // Root presentation attributes (Lobe's fill="currentColor" fill-rule="evenodd") move onto the tree's top group.
  const rootPaint = {};
  for (const name of PAINT) if (root.hasAttribute(name)) rootPaint[name] = root.getAttribute(name);

  const walk = el => {
    const tag = el.localName;
    // Editor metadata (Inkscape's sodipodi:namedview and the like) is not artwork.
    if (el.namespaceURI !== SVG_NS || DROPPED.has(tag)) return null;
    if (!ELEMENTS.has(tag)) fail(`${file}: <${tag}> is not vendored`);
    const attrs = {};
    for (const cls of (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean)) {
      for (const [k, v] of styles.get(cls) ?? []) if (PAINT.includes(k)) attrs[k] = v;
    }
    for (const d of (el.getAttribute('style') ?? '').split(';').map(s => s.split(':').map(t => t.trim()))) {
      if (d.length === 2 && PAINT.includes(d[0])) attrs[d[0]] = d[1];
    }
    for (const { name, value } of el.attributes) {
      if (name === 'id') {
        if (ids.has(value)) attrs.id = ids.get(value);
      } else if (ATTRS.has(name)) {
        attrs[name] = rename(value);
      }
    }
    const kids = [...el.children].map(walk).filter(Boolean);
    // A <defs>, clip or gradient nobody references is noise (Lobe's OpenClaw carries five).
    if (['defs', 'linearGradient', 'radialGradient', 'clipPath', 'mask'].includes(tag) && tag !== 'defs' && !attrs.id) return null;
    if (tag === 'defs' && kids.length === 0) return null;
    return kids.length ? [tag, attrs, kids] : [tag, attrs];
  };
  const kids = [...root.children].map(walk).filter(Boolean);
  if (kids.length === 0) fail(`${file}: nothing to draw`);
  return { viewBox, tree: ['g', rootPaint, kids] };
}

const sourcesPath = resolve(process.argv[2] ?? fail('usage: node scripts/vendor-logos.mjs <sources.json>'));
const sources = JSON.parse(readFileSync(sourcesPath, 'utf8'));
const base = dirname(sourcesPath);
const logoIds = ICONS.filter(i => i.section === 'ai' || i.section === 'cloud').map(i => i.id);
const missing = logoIds.filter(id => !sources[id]);
const extra = Object.keys(sources).filter(id => !logoIds.includes(id));
if (extra.length) fail(`not logo ids in module/src/node-icons.ts: ${extra.join(', ')}`);

const logosDir = new URL('../client/src/logos/', import.meta.url);
rmSync(logosDir, { recursive: true, force: true });
mkdirSync(logosDir, { recursive: true });
const credits = new Set();
const loaders = [];
for (const id of logoIds.filter(id => sources[id])) {
  const s = sources[id];
  const fit = s.fit ?? 1;
  if (!(fit >= 1 && fit <= 4)) fail(`${id}: fit must be between 1 and 4`);
  const light = vendor(resolve(base, s.light), `rcl-${id}-l`);
  const dark = s.dark ? vendor(resolve(base, s.dark), `rcl-${id}-d`) : null;
  credits.add(s.source);
  writeFileSync(
    new URL(`${id}.ts`, logosDir),
    `// GENERATED by scripts/vendor-logos.mjs from ${s.source} (${s.url}). Do not edit.\n` +
      `// The mark belongs to its owner; see THIRD_PARTY_NOTICES.md.\n` +
      `import type { LogoDrawing } from '../node-logos';\n\n` +
      `export const LOGO: LogoDrawing = ${JSON.stringify({ fit, light, dark })};\n`
  );
  loaders.push(`  '${id}': () => import('./logos/${id}').then(m => m.LOGO),`);
}

const body = `// GENERATED by scripts/vendor-logos.mjs from each brand's own SVG files. Do not edit.
// Sources: ${[...credits].sort().join('; ')}.
// The marks belong to their owners; see THIRD_PARTY_NOTICES.md.

/** [tag, attributes, children?]: an SVG element, built by the client with createElementNS. */
export type LogoNode = [string, Record<string, string>, LogoNode[]?];
export interface LogoArt {
  viewBox: string;
  tree: LogoNode;
}
/** A brand's own artwork, in its own colours: \`light\` on light themes, \`dark\` (its
 *  dark-background file) on dark ones, or \`light\` on both. \`fit\` draws the whole file
 *  that many times the icon box, for a mark inside a wide transparent margin. */
export interface LogoDrawing {
  fit: number;
  light: LogoArt;
  dark: LogoArt | null;
}

/** One chunk per logo: a board fetches only the logos it shows. */
export const LOGO_LOADERS: Readonly<Record<string, () => Promise<LogoDrawing>>> = {
${loaders.join('\n')}
};
`;
writeFileSync(new URL('../client/src/node-logos.ts', import.meta.url), body);
console.log(`client/src/logos: ${loaders.length} logos${missing.length ? `; not sourced: ${missing.join(', ')}` : ''}`);
