import { fitText, textW } from './scale';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Create an SVG element with string attributes and optional text. */
export function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  text?: string,
): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    e.setAttribute(k, v);
  }
  if (text !== undefined) {
    e.textContent = text;
  }
  return e;
}

/** A coordinate for an attribute: at most two decimals, never '-0'. */
export function num(v: number): string {
  const r = Math.round(v * 100) / 100;
  return String(r === 0 ? 0 : r);
}

/** The series slot class for the i-th series (0-based), in fixed order. */
export function seriesClass(i: number): string {
  return `series-${(i % 5) + 1}`;
}

/** A text mark. Size, anchor and tabular figures are attributes, so Export SVG keeps them. */
export function txt(
  x: number,
  y: number,
  s: string,
  cls: string,
  size: number,
  anchor: 'start' | 'middle' | 'end' = 'start',
  tabular = false,
): SVGTextElement {
  const attrs: Record<string, string> = {
    x: num(x),
    y: num(y),
    class: cls,
    'font-size': String(size),
    'text-anchor': anchor,
  };
  if (tabular) {
    attrs['font-variant-numeric'] = 'tabular-nums';
  }
  return svgEl('text', attrs, s);
}

/** A 2 px line with round joins and caps (attributes, not CSS: the export drops CSS-only linejoin). */
export function lineAttrs(cls: string, width = 2): Record<string, string> {
  return {
    class: cls,
    fill: 'none',
    'stroke-width': String(width),
    'stroke-linejoin': 'round',
    'stroke-linecap': 'round',
  };
}

/**
 * A bar from pBase to pEnd along the value axis and from a to a + w across it.
 * The data end (pEnd) is rounded with radius r; the base stays square. Only
 * absolute M, L, A and Z commands are used.
 */
export function barPath(vertical: boolean, a: number, w: number, pBase: number, pEnd: number, r: number): string {
  const s = pEnd >= pBase ? 1 : -1;
  const rr = Math.max(0, Math.min(r, w / 2, Math.abs(pEnd - pBase)));
  const pt = (c: number, u: number) => (vertical ? `${num(c)} ${num(u)}` : `${num(u)} ${num(c)}`);
  if (rr === 0) {
    return `M${pt(a, pBase)} L${pt(a, pEnd)} L${pt(a + w, pEnd)} L${pt(a + w, pBase)} Z`;
  }
  const sweep = vertical === s < 0 ? 1 : 0;
  const arc = (c: number, u: number) => `A${num(rr)} ${num(rr)} 0 0 ${sweep} ${pt(c, u)}`;
  return `M${pt(a, pBase)} L${pt(a, pEnd - s * rr)} ${arc(a + rr, pEnd)} L${pt(a + w - rr, pEnd)} ${arc(a + w, pEnd - s * rr)} L${pt(a + w, pBase)} Z`;
}

/** Least air between two labels on one axis. */
const LABEL_AIR = 6;

/**
 * Tick labels along a horizontal axis with their baseline at y. Each is
 * centred on its x; one that would leave [x0, x1] is anchored at that edge
 * instead, still over its tick. Labels left to right; one that would come
 * within 6 px of the label before it is dropped, except the last, which drops
 * that neighbour instead. The first label always stays.
 */
export function axisLabels(items: { x: number; text: string }[], y: number, x0: number, x1: number, size: number): SVGTextElement[] {
  const placed = items.map(({ x, text }) => {
    const w = textW(text, size);
    const anchor: 'start' | 'middle' | 'end' = x - w / 2 < x0 ? 'start' : x + w / 2 > x1 ? 'end' : 'middle';
    const at = anchor === 'start' ? x0 : anchor === 'end' ? x1 : x;
    const left = anchor === 'start' ? x0 : anchor === 'end' ? x1 - w : x - w / 2;
    return { text, anchor, at, left, right: left + w };
  });
  const kept: typeof placed = [];
  placed.forEach((p, i) => {
    while (kept.length > 0 && p.left < kept[kept.length - 1].right + LABEL_AIR) {
      if (i < placed.length - 1 || kept.length === 1) {
        return;
      }
      kept.pop();
    }
    kept.push(p);
  });
  return kept.map(p => txt(p.at, y, p.text, 'chart-tick chart-faint', size, p.anchor, true));
}

export interface LegendItem {
  name: string;
  /** Swatch class: a series slot (`series-2`) or `chart-other`. */
  cls: string;
}

/** Height a legend row needs, including the 4 px above it. */
export const LEGEND_H = 20;
const LEGEND_PX = 11;
/** Swatch plus its gap to the name, and the gap between items. */
const SWATCH_W = 12;
const ITEM_GAP = 12;

/**
 * One legend row: an 8 px swatch and the name for each item, left to right,
 * with its text baseline at y. Items that do not fit in maxW collapse into a
 * '+N' count. Text never takes a series colour; only the swatch does.
 */
export function legend(items: LegendItem[], x: number, y: number, maxW: number): SVGGElement {
  const g = svgEl('g', { class: 'chart-legend' });
  let cx = x;
  for (const [i, item] of items.entries()) {
    const rest = items.length - i;
    const tail = rest > 1 ? textW(`+${rest - 1}`, LEGEND_PX) + 8 : 0;
    const room = x + maxW - cx - SWATCH_W - tail;
    const name = fitText(item.name, room, LEGEND_PX);
    if (name === '' || (i > 0 && name !== item.name)) {
      g.append(txt(cx, y, `+${rest}`, 'chart-legend-text chart-faint', LEGEND_PX));
      break;
    }
    g.append(
      svgEl('rect', { x: num(cx), y: num(y - 8), width: '8', height: '8', rx: '2', class: `chart-swatch ${item.cls}` }),
      txt(cx + SWATCH_W, y, name, 'chart-legend-text chart-muted', LEGEND_PX),
    );
    cx += SWATCH_W + textW(name, LEGEND_PX) + ITEM_GAP;
  }
  return g;
}
