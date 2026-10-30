/**
 * Node icon drawings (spec 2026-10-18, RC-687), keyed by the ids in
 * module/src/node-icons.ts. Two paints:
 *  - stroke: the authored Agents and Systems icons, in the strokeIcon family
 *    (16-unit grid, stroke 1.3, round caps and joins, currentColor). They take
 *    the node's ink, colour or focal accent.
 *  - brand: AI and Cloud logos, each brand's own artwork in its own colours,
 *    with its dark-background file on dark themes when it has one (D17, D18).
 *    Never tinted by the theme or the node.
 * Logo artwork is generated into logos/<id>.ts by scripts/vendor-logos.mjs, one
 * chunk per logo (node-logos.ts LOGO_LOADERS): the main bundle carries only the
 * authored icons, a board fetches the logos it shows, and a logo draws once its
 * chunk has arrived (setLogoListener redraws then).
 */
import { ICONS, iconSpec, type IconSpec } from '../../module/src/node-icons';
import { LOGO_LOADERS, type LogoArt, type LogoDrawing, type LogoNode } from './node-logos';
import { svgEl } from './charts/svg';

const logos = new Map<string, LogoDrawing>();
const pending = new Map<string, Promise<void>>();
let listener: (() => void) | null = null;

/** Called whenever a logo's artwork arrives (main.ts redraws the board). */
export function setLogoListener(cb: (() => void) | null): void {
  listener = cb;
}

/** Fetch one logo's artwork once; resolves when it can draw (at once for an id with no logo). */
export function loadLogo(id: string): Promise<void> {
  const load = Object.prototype.hasOwnProperty.call(LOGO_LOADERS, id) ? LOGO_LOADERS[id] : undefined;
  if (load === undefined || logos.has(id)) return Promise.resolve();
  let p = pending.get(id);
  if (p === undefined) {
    p = load().then(art => {
      logos.set(id, art);
      listener?.();
    });
    pending.set(id, p);
  }
  return p;
}

/** Fetch every logo (the library popover shows them all). */
export function loadLogos(): Promise<void> {
  return Promise.all(Object.keys(LOGO_LOADERS).map(loadLogo)).then(() => {});
}

/** Whether every logo's artwork has arrived. */
export function logosReady(): boolean {
  return Object.keys(LOGO_LOADERS).every(id => logos.has(id));
}

type Stroke = { d: string; dots?: ReadonlyArray<readonly [number, number, number]> };

/** The authored icons. Every id in the Agents and Systems sections has one (node-icons.test.ts). */
const STROKES: Readonly<Record<string, Stroke>> = {
  // The presence avatar's bot head (chrome.ts botIcon): an agent looks the same everywhere.
  agent: { d: 'M8 2.5v2.5M3.5 5h9a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1ZM6 8.5v1M10 8.5v1' },
  orchestrator: {
    d:
      'M5.5 1.5h5a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1v-2a1 1 0 0 1 1-1ZM8 5.5v6M3 11.5v-3h10v3' +
      'M2 11.5h2a.5.5 0 0 1 .5.5v1.5a.5.5 0 0 1-.5.5H2a.5.5 0 0 1-.5-.5V12a.5.5 0 0 1 .5-.5Z' +
      'M7 11.5h2a.5.5 0 0 1 .5.5v1.5a.5.5 0 0 1-.5.5H7a.5.5 0 0 1-.5-.5V12a.5.5 0 0 1 .5-.5Z' +
      'M12 11.5h2a.5.5 0 0 1 .5.5v1.5a.5.5 0 0 1-.5.5h-2a.5.5 0 0 1-.5-.5V12a.5.5 0 0 1 .5-.5Z',
  },
  subagent: { d: 'M2 1.5v6a1 1 0 0 0 1 1h3.5M10.5 4v2.5M7.5 6.5h6a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-6a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1ZM9 9.5v1M12 9.5v1' },
  model: { d: 'M7 3.5c.45 3.1 1.4 4.05 4.5 4.5-3.1.45-4.05 1.4-4.5 4.5-.45-3.1-1.4-4.05-4.5-4.5 3.1-.45 4.05-1.4 4.5-4.5ZM12.5 1.5v3M11 3h3' },
  tool: { d: 'M10.2 2a3.6 3.6 0 0 0-3.3 4.9l-4.6 4.6a1.5 1.5 0 0 0 2.1 2.1l4.6-4.6A3.6 3.6 0 0 0 14 5.8l-2.1 2.1-2.1-.4-.4-2.1L11.5 3.3A3.6 3.6 0 0 0 10.2 2Z' },
  'mcp-server': { d: 'M6 1.5v3M10 1.5v3M4 4.5h8v2.5a4 4 0 0 1-8 0ZM8 11v3.5' },
  memory: { d: 'M2.5 4h11a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1ZM4 11v2M6.5 11v2M9.5 11v2M12 11v2M4.5 6.5h2.5v2H4.5ZM9 6.5h2.5v2H9Z' },
  'knowledge-base': { d: 'M8 4.5C6.5 3.3 4.5 3 1.5 3v9.5c3 0 5 .3 6.5 1.5 1.5-1.2 3.5-1.5 6.5-1.5V3c-3 0-5 .3-6.5 1.5ZM8 4.5V14' },
  prompt: { d: 'M4 1.5h5.5l3.5 3.5v8.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1ZM9.5 1.5V5H13M5.5 8l2 1.75-2 1.75M9 11.5h2' },
  human: { d: 'M8 1.75a2.75 2.75 0 1 0 0 5.5 2.75 2.75 0 0 0 0-5.5ZM2.5 14.5a5.5 5.5 0 0 1 11 0' },
  guardrail: { d: 'M8 1.5 13 3.5v4c0 3-2 5.5-5 7-3-1.5-5-4-5-7v-4ZM5.75 8l1.5 1.5 3-3' },
  evaluator: { d: 'M1.5 12a6.5 6.5 0 0 1 13 0M8 12l3-3.5M3.9 7.4l.9.7M8 5.5v1M12.1 7.4l-.9.7', dots: [[8, 12, 1.1]] },
  queue: {
    d:
      'M2.25 4.5h1.5a.75.75 0 0 1 .75.75v5.5a.75.75 0 0 1-.75.75h-1.5a.75.75 0 0 1-.75-.75v-5.5a.75.75 0 0 1 .75-.75Z' +
      'M6.25 4.5h1.5a.75.75 0 0 1 .75.75v5.5a.75.75 0 0 1-.75.75h-1.5a.75.75 0 0 1-.75-.75v-5.5a.75.75 0 0 1 .75-.75Z' +
      'M10.5 8h4M12.75 5.75 15 8l-2.25 2.25',
  },
  cache: { d: 'M9 1.5 3.5 9H8l-1 5.5L12.5 7H8Z' },
  scheduler: { d: 'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM8 4.5V8l2.5 1.5' },
  event: { d: 'M5.5 5.5a3.5 3.5 0 0 0 0 5M10.5 5.5a3.5 3.5 0 0 1 0 5M3.4 3.4a6.5 6.5 0 0 0 0 9.2M12.6 3.4a6.5 6.5 0 0 1 0 9.2', dots: [[8, 8, 1.25]] },
  gateway: {
    d: 'M1.5 8h3.75M8.75 8h4.75M8.4 6.6l4.1-3.1M8.4 9.4l4.1 3.1M7 6.25a1.75 1.75 0 1 0 0 3.5 1.75 1.75 0 0 0 0-3.5Z',
    dots: [[13.25, 3, 1.1], [14, 8, 1.1], [13.25, 13, 1.1]],
  },
  function: { d: 'M3.5 2.5h1.5l6.5 11M8.25 7.6 4 13.5M11.5 13.5h1.5' },
  browser: { d: 'M3 2.5h10a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5H3A1.5 1.5 0 0 1 1.5 12V4A1.5 1.5 0 0 1 3 2.5ZM1.5 5.5h13M3.75 4h.01M5.5 4h.01' },
  sandbox: { d: 'M3 2.5h10a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5H3A1.5 1.5 0 0 1 1.5 12V4A1.5 1.5 0 0 1 3 2.5ZM4.5 6l2.25 2-2.25 2M8.5 10.5h3' },
};

export type IconPaint = 'stroke' | 'brand';

/** How `id` is drawn; null when this client has no drawing for it (a newer or a withdrawn id). */
export function iconPaint(id: string): IconPaint | null {
  if (Object.prototype.hasOwnProperty.call(STROKES, id)) return 'stroke';
  return Object.prototype.hasOwnProperty.call(LOGO_LOADERS, id) ? 'brand' : null;
}

/** The registry entry, only when this client can draw it. */
export function drawableIcon(id: string | undefined): IconSpec | undefined {
  return id !== undefined && iconPaint(id) !== null ? iconSpec(id) : undefined;
}

/** Every icon this client can draw, in registry order. */
export function drawableIcons(): IconSpec[] {
  return ICONS.filter(i => iconPaint(i.id) !== null);
}

function buildLogo(node: LogoNode): SVGElement {
  const [tag, attrs, kids] = node;
  const e = svgEl(tag as keyof SVGElementTagNameMap, attrs);
  for (const k of kids ?? []) e.append(buildLogo(k));
  return e;
}

/** A logo's whole artwork fitted, centred, into a size × size box at 0,0; with
 *  `fit` > 1 the file is drawn that many times larger about the same centre, so a
 *  mark inside a wide transparent margin reads at the size of the others. */
function placeArt(art: LogoArt, size: number, fit: number, cls: string): SVGGElement {
  const [minX, minY, vw, vh] = art.viewBox.split(/[\s,]+/).map(Number);
  const box = size * fit;
  const s = box / Math.max(vw, vh);
  const dx = (size - vw * s) / 2 - minX * s;
  const dy = (size - vh * s) / 2 - minY * s;
  const g = svgEl('g', { class: cls, transform: `translate(${round(dx)} ${round(dy)}) scale(${round(s, 4)})` });
  g.append(buildLogo(art.tree));
  return g;
}

function round(v: number, places = 2): string {
  const f = 10 ** places;
  const r = Math.round(v * f) / f;
  return String(r === 0 ? 0 : r);
}

/**
 * The drawing for `id` in a fresh <g class="node-icon …">, size × size with its
 * top-left at 0,0 (the caller translates it). Null when there is no drawing, or
 * while a logo's artwork is still loading (this starts the load).
 */
export function iconGroup(id: string, size: number): SVGGElement | null {
  const paint = iconPaint(id);
  if (paint === null) return null;
  const logo = paint === 'stroke' ? undefined : logos.get(id);
  if (paint === 'brand' && logo === undefined) {
    void loadLogo(id);
    return null;
  }
  const g = svgEl('g', { class: `node-icon node-icon-${paint}` });
  if (paint === 'stroke') {
    const art = STROKES[id];
    const s = svgEl('g', {
      transform: `scale(${round(size / 16, 4)})`,
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': '1.3',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    });
    s.append(svgEl('path', { d: art.d }));
    for (const [cx, cy, r] of art.dots ?? []) {
      s.append(svgEl('circle', { cx: String(cx), cy: String(cy), r: String(r), fill: 'currentColor', stroke: 'none' }));
    }
    g.append(s);
    return g;
  }
  const { light, dark, fit } = logo!;
  if (dark === null) {
    g.append(placeArt(light, size, fit, 'logo-art'));
  } else {
    // Both files ride along; the theme's scheme shows one (style.css), and
    // Export SVG drops the hidden one with everything else display: none.
    g.append(placeArt(light, size, fit, 'logo-art logo-on-light'), placeArt(dark, size, fit, 'logo-art logo-on-dark'));
  }
  return g;
}

/** A standalone <svg> of `id` for chrome (library tiles), hidden from assistive tech: the tile names it. */
export function iconSvg(id: string, size: number): SVGSVGElement | null {
  // Authored icons keep the 16-unit viewBox, so style.css gives them the chrome
  // icons' 1.3 px non-scaling stroke, as the dock's kind icons have.
  const box = iconPaint(id) === 'stroke' ? 16 : size;
  const g = iconGroup(id, box);
  if (g === null) return null;
  const svg = svgEl('svg', { class: 'lib-node-icon', width: String(size), height: String(size), viewBox: `0 0 ${box} ${box}`, 'aria-hidden': 'true' });
  svg.append(g);
  return svg;
}
