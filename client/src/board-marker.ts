// A marker drawn on a board node: a ring with a glyph, keyed like the route marker so a patch pass
// rebuilds it only when its spec changes. The threat marker is the first user.
import { worstThreat } from '../../module/src/threats';
import type { ThreatView } from './threats-view';

export type MarkerTone = 'red' | 'amber' | 'muted';
export interface MarkerSpec { glyph: 'hazard'; tone: MarkerTone; pulse: boolean; count: number; label: string /* aria-label */ }

const NS = 'http://www.w3.org/2000/svg';
function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, text?: string): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  return e;
}

export const markerKey = (m: MarkerSpec): string => `${m.glyph}|${m.tone}|${m.pulse}|${m.count}|${m.label}`;

/** A square of side 2r with corner radius r is a circle; brutal sets rx 0 so the same shape squares off. */
const disc = (cls: string, r: number) => svg('rect', { class: cls, x: String(-r), y: String(-r), width: String(2 * r), height: String(2 * r), rx: String(r) });

/** The ring every marker shares, centred on (0,0): halo, focus ring, then the ring itself. */
function ring(pulse: boolean): SVGElement[] {
  const out = [disc('board-marker-focus', 17), disc('board-marker-ring', 12)];
  if (pulse) out.unshift(disc('board-marker-halo', 13));
  return out;
}

export function makeMarker(m: MarkerSpec): SVGGElement {
  const g = svg('g', { class: `board-marker tone-${m.tone}${m.pulse ? ' pulse' : ''}`, role: 'button', tabindex: '0', 'aria-label': m.label });
  g.append(
    svg('title', {}, m.label),
    ...ring(m.pulse),
    svg('path', { class: 'board-marker-glyph', d: 'M0 -8.7 L8.7 6.4 H-8.7 Z', 'stroke-linejoin': 'round' }),
    svg('rect', { class: 'board-marker-cut', x: '-1', y: '-3.6', width: '2', height: '5.3', rx: '1' }),
    svg('circle', { class: 'board-marker-cut', cx: '0', cy: '3.8', r: '1.2' }),
  );
  if (m.count >= 2) g.append(svg('text', { class: 'board-marker-count', x: '15', y: '-9' }, String(m.count)));
  return g;
}

/** Open compromised: red and pulsing. Open vulnerable: red for critical or high, else amber. All contained: muted. */
export function threatMarker(threats: ThreatView[], anchorLabel: string): MarkerSpec {
  const w = worstThreat(threats)!;
  const tone: MarkerTone = w.contained ? 'muted' : w.stage === 'compromised' || w.severity === 'critical' || w.severity === 'high' ? 'red' : 'amber';
  const more = threats.length > 1 ? `, and ${threats.length - 1} more` : '';
  return {
    glyph: 'hazard', tone, pulse: !w.contained && w.stage === 'compromised', count: threats.length,
    label: `Threat on ${anchorLabel}: ${w.title}, ${w.severity}, ${w.contained ? 'contained' : w.stage}${more}`,
  };
}

/** The amber number on a node the blast reaches: the marker's ring with the hop as text, dashed from hop 2 on. Not interactive. */
export function makeHopBadge(hop: number): SVGGElement {
  const g = svg('g', { class: `board-marker hop-badge tone-amber${hop >= 2 ? ' hop-n' : ''}` });
  const ringOnly = ring(false).slice(1); // the focus ring is for interactive markers
  const inner = svg('g', { transform: 'scale(0.75)' });
  inner.append(...ringOnly, svg('text', { class: 'hop-badge-text', x: '0', y: '4' }, String(hop)));
  g.append(inner);
  return g;
}
