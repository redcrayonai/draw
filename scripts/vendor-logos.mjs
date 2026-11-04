#!/usr/bin/env node
// Adds and replaces the logo drawings of the library's logos (every section but
// agents and systems) from each brand's own SVG files, and never removes one:
// client/src/logos/<id>.ts, one module per logo, and
// client/src/node-logos.ts, the loaders of every logo file there (each logo is its own chunk, fetched
// when a board shows it or the library opens). Nothing is redrawn: each file is
// parsed, reduced to an allow-list of shape elements and attributes (class styles
// are inlined first; editor metadata is dropped), its ids are namespaced, and it is
// written out as element trees, so the client never parses markup.
//
//   node scripts/vendor-logos.mjs <sources.json>
//
// sources.json lists only the logos to add or replace: { "<id>": { "light": "<file.svg>", "dark": "<file.svg>" | null, "fit": <number>?,
//                           "source": "<package or kit, version>", "url": "<where it came from>" } }
// Paths are relative to sources.json. `light` shows on light themes and `dark`
// (the brand's dark-background file) on dark ones; with no `dark`, `light`
// shows on both. `fit` (default 1) draws the whole file that many times the icon
// box, centred, for files whose mark sits inside a wide transparent margin.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
      // Illustrator's enable-background on the root paints nothing.
      if (sel === 'svg' && decls.every(([k]) => k === 'enable-background')) continue;
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

  // The client resolves url(#id) only, so what a file shares by href or filter is written out here.
  const hrefTarget = el => {
    const id = (el.getAttribute('href') ?? el.getAttribute('xlink:href') ?? '').replace(/^#/, '');
    const found = [...root.querySelectorAll('*')].find(e => e.getAttribute('id') === id);
    return found ?? fail(`${file}: <${el.localName}> has no local target`);
  };
  // A gradient inherits its stops and the attributes it does not set.
  for (const g of root.querySelectorAll('linearGradient, radialGradient')) {
    if (!g.hasAttribute('href') && !g.hasAttribute('xlink:href')) continue;
    const from = hrefTarget(g);
    if (from.hasAttribute('href') || from.hasAttribute('xlink:href')) fail(`${file}: chained gradient #${g.getAttribute('id')}`);
    for (const { name, value } of from.attributes) if (name !== 'id' && !g.hasAttribute(name)) g.setAttribute(name, value);
    if (g.children.length === 0) g.append(...[...from.children].map(c => c.cloneNode(true)));
  }
  // A bare <use> is a copy of its target.
  for (const u of root.querySelectorAll('use')) {
    if ([...u.attributes].some(a => a.name !== 'href' && a.name !== 'xlink:href')) fail(`${file}: <use> with its own attributes is not vendored`);
    const copy = hrefTarget(u).cloneNode(true);
    copy.removeAttribute('id');
    u.replaceWith(copy);
  }
  // Illustrator's mask filter (a flood with the source over it) paints the same as a flood-coloured rect behind the source.
  for (const f of root.querySelectorAll('filter')) {
    const [flood, blend, more] = f.children;
    const plain = flood?.localName === 'feFlood' && blend?.localName === 'feBlend' && !more && blend.getAttribute('in') === 'SourceGraphic' && blend.getAttribute('in2') === flood.getAttribute('result') && !blend.hasAttribute('mode');
    if (!plain) fail(`${file}: <filter> is not vendored`);
    const ref = `url(#${f.getAttribute('id')})`;
    for (const el of root.querySelectorAll('*')) {
      const viaClass = (el.getAttribute('class') ?? '').split(/\s+/).some(c => (styles.get(c) ?? []).some(([k, v]) => k === 'filter' && v === ref));
      if (!viaClass && el.getAttribute('filter') !== ref) continue;
      const rect = doc.createElementNS(SVG_NS, 'rect');
      for (const a of ['x', 'y', 'width', 'height']) rect.setAttribute(a, f.getAttribute(a) ?? fail(`${file}: <filter> without ${a}`));
      rect.setAttribute('fill', flood.getAttribute('flood-color') ?? fail(`${file}: feFlood without a colour`));
      el.before(rect);
    }
    f.remove();
  }

  // Ids that something references survive (renamed); the rest are dropped.
  const used = new Set();
  for (const m of text.matchAll(/url\(\s*['"]?#([^'")\s]+)['"]?\s*\)|href="#([^"]+)"/g)) used.add(m[1] ?? m[2]);
  const ids = new Map([...used].map((id, i) => [id, `${prefix}-${i}`]));
  // A value may refer only to this file: no other url(), image function or CSS escape (which could spell either).
  const rename = value => {
    if (/\\|(?:image|image-set|cross-fade|element|src)\(/i.test(value)) fail(`${file}: external reference in '${value}'`);
    return value.replace(/url\(([^)]*)\)?/gi, (m, inner) => {
      const target = inner.trim().replace(/^['"]|['"]$/g, '');
      if (!target.startsWith('#')) fail(`${file}: external reference in '${m}'`);
      return ids.has(target.slice(1)) ? `url(#${ids.get(target.slice(1))})` : fail(`${file}: dangling reference ${target}`);
    });
  };

  // Root presentation attributes (Lobe's fill="currentColor" fill-rule="evenodd") move onto the tree's top group.
  const rootPaint = {};
  for (const name of PAINT) if (root.hasAttribute(name)) rootPaint[name] = rename(root.getAttribute(name));
  // A shape with no fill is black in its own file; written out, so a parent's fill cannot change it.
  rootPaint.fill ??= '#000';

  const walk = el => {
    // An <a> with no link is Inkscape's group.
    const tag = el.localName === 'a' && !el.hasAttribute('href') && !el.hasAttribute('xlink:href') ? 'g' : el.localName;
    // Editor metadata (Inkscape's sodipodi:namedview and the like) is not artwork.
    if (el.namespaceURI !== SVG_NS || DROPPED.has(tag)) return null;
    if (!ELEMENTS.has(tag)) fail(`${file}: <${tag}> is not vendored`);
    const attrs = {};
    for (const cls of (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean)) {
      for (const [k, v] of styles.get(cls) ?? []) if (PAINT.includes(k)) attrs[k] = rename(v);
    }
    for (const d of (el.getAttribute('style') ?? '').split(';').map(s => s.split(':').map(t => t.trim()))) {
      if (d.length === 2 && PAINT.includes(d[0])) attrs[d[0]] = rename(d[1]);
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
const logoIds = ICONS.filter(i => i.section !== 'agents' && i.section !== 'systems').map(i => i.id);
const extra = Object.keys(sources).filter(id => !logoIds.includes(id));
if (extra.length) fail(`not logo ids in module/src/node-icons.ts: ${extra.join(', ')}`);

const logosDir = new URL('../client/src/logos/', import.meta.url);
mkdirSync(logosDir, { recursive: true });
for (const id of logoIds.filter(id => sources[id])) {
  const s = sources[id];
  const fit = s.fit ?? 1;
  if (!(fit >= 1 && fit <= 4)) fail(`${id}: fit must be between 1 and 4`);
  const light = vendor(resolve(base, s.light), `rcl-${id}-l`);
  const dark = s.dark ? vendor(resolve(base, s.dark), `rcl-${id}-d`) : null;
  writeFileSync(
    new URL(`${id}.ts`, logosDir),
    `// GENERATED by scripts/vendor-logos.mjs from ${s.source} (${s.url}). Do not edit.\n` +
      `// The mark belongs to its owner; see THIRD_PARTY_NOTICES.md.\n` +
      `import type { LogoDrawing } from '../node-logos';\n\n` +
      `export const LOGO: LogoDrawing = ${JSON.stringify({ fit, light, dark })};\n`
  );
}

// Loaders and credits cover every logo file, not only this run's, in registry order.
const credit = /^\/\/ GENERATED by scripts\/vendor-logos\.mjs from (.*) \([^()]*\)\. Do not edit\.$/;
const credits = new Set();
const loaders = [];
const missing = [];
for (const id of logoIds) {
  const file = new URL(`${id}.ts`, logosDir);
  if (!existsSync(file)) {
    missing.push(id);
    continue;
  }
  const first = readFileSync(file, 'utf8').split('\n', 1)[0];
  credits.add(first.match(credit)?.[1] ?? fail(`client/src/logos/${id}.ts: first line is not a vendor-logos header`));
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
