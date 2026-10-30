// The peek a threat marker shows on hover or focus: what it is and how far it reaches, on the side of
// the node the blast does not travel. It never takes focus and never catches the pointer.
import type { ThreatView } from './threats-view';
import { threatMarker } from './board-marker';

export interface PeekModel {
  threat: ThreatView; total: number;
  /** Nodes the blast reaches at the panel's default options, the deepest hop, and how many look like PII. */
  reach: { nodes: number; hops: number; pii: number };
}
interface Box { x: number; y: number; w: number; h: number }
interface Bounds { left: number; top: number; right: number; bottom: number }

const GAP = 12;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function renderThreatPeek(m: PeekModel): HTMLElement {
  const t = m.threat;
  const root = h('div', `tp tone-${threatMarker([t], '').tone}`);
  const top = h('div', 'tp-top');
  const sev = h('span', 'tp-sev', `${t.severity} · ${t.contained ? 'contained' : t.stage}`);
  top.append(sev);
  if (m.total > 1) top.append(h('span', 'tp-more', `1 of ${m.total}`));
  root.append(top, h('div', 'tp-title', t.title), h('p', 'tp-summary', t.summary));
  const { nodes, hops, pii } = m.reach;
  const reach = h('div', 'tp-reach', nodes === 0 ? 'Reaches nothing on the drawn edges' : `Reaches ${nodes} node${nodes === 1 ? '' : 's'} in ${hops === 1 ? '1 hop' : `${hops} hops`}`);
  if (pii > 0) reach.append(h('span', 'tc-pii', `${pii} PII`));
  root.append(reach);
  const hint = h('div', 'tp-hint');
  hint.append(h('kbd', 'tc-kbd', '↵'), document.createTextNode(' open'));
  root.append(hint);
  return root;
}

type Side = 'below' | 'right' | 'left' | 'above';
const SIDES: Side[] = ['below', 'right', 'left', 'above'];

/**
 * Where the peek goes, in screen pixels: the side (below, right, left, above) that fits and covers
 * the fewest nodes the blast reaches, then the one with the fewest of them in its direction, so the
 * spread stays visible. With no side that fits, the least-bad one is clamped into the bounds.
 */
export function peekPosition(anchor: Box, neighbours: Box[], size: { w: number; h: number }, b: Bounds): { x: number; y: number } {
  const cx = anchor.x + anchor.w / 2, cy = anchor.y + anchor.h / 2;
  const sideOf = (r: Box): Side => {
    const dx = r.x + r.w / 2 - cx, dy = r.y + r.h / 2 - cy;
    return Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 'right' : 'left') : dy >= 0 ? 'below' : 'above';
  };
  const at: Record<Side, { x: number; y: number }> = {
    below: { x: anchor.x, y: anchor.y + anchor.h + GAP },
    right: { x: anchor.x + anchor.w + GAP, y: anchor.y },
    left: { x: anchor.x - GAP - size.w, y: anchor.y },
    above: { x: anchor.x, y: anchor.y - GAP - size.h },
  };
  const fits = (p: { x: number; y: number }) => p.x >= b.left && p.y >= b.top && p.x + size.w <= b.right && p.y + size.h <= b.bottom;
  const covers = (p: { x: number; y: number }, r: Box) => p.x < r.x + r.w && r.x < p.x + size.w && p.y < r.y + r.h && r.y < p.y + size.h;
  const score = (s: Side) => (fits(at[s]) ? 0 : 1000) + 10 * neighbours.filter(r => covers(at[s], r)).length + neighbours.filter(r => sideOf(r) === s).length;
  const best = SIDES.reduce((x, y) => (score(y) < score(x) ? y : x));
  const p = at[best];
  return {
    x: Math.max(b.left, Math.min(p.x, b.right - size.w)),
    y: Math.max(b.top, Math.min(p.y, b.bottom - size.h)),
  };
}
