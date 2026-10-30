// Shared by the chart renderer tests only.
import type { Box } from './scale';

/** Wrap renderer output in a <g> so tests can query it and read its outerHTML. */
export function group(els: SVGElement[]): SVGGElement {
  const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  g.append(...els);
  return g;
}

/** Inline colour of any kind: hex, rgb()/hsl() or a style attribute. Renderers use classes only. */
export const INLINE_COLOR = /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|style=/;

/** Every point a path built from absolute M, L, A and Z commands passes through. */
export function pathPoints(d: string): [number, number][] {
  const tokens = d.match(/[MLAZ]|-?\d+(?:\.\d+)?(?:e-?\d+)?/g) ?? [];
  const pts: [number, number][] = [];
  let i = 0;
  while (i < tokens.length) {
    const cmd = tokens[i++];
    if (cmd === 'M' || cmd === 'L') {
      pts.push([Number(tokens[i]), Number(tokens[i + 1])]);
      i += 2;
    } else if (cmd === 'A') {
      pts.push([Number(tokens[i + 5]), Number(tokens[i + 6])]);
      i += 7;
    } else if (cmd !== 'Z') {
      throw new Error(`unexpected path token ${cmd} in ${d}`);
    }
  }
  return pts;
}

/** Bounding box of such a path (exact for bars: arc end points are the extremes). */
export function pathBox(d: string): Box {
  const pts = pathPoints(d);
  const xs = pts.map(p => p[0]);
  const ys = pts.map(p => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

export const attr = (e: Element, name: string) => Number(e.getAttribute(name));
