import type { Edge } from './module_bindings/types';
import { el } from './render';

/** One hop of a played route: the drawn edge joining two waypoints, if any. */
export interface Leg {
  from: bigint;
  to: bigint;
  edgeId: bigint | null;
  /** The edge points from `to` to `from`: walk its path backwards. */
  reverse: boolean;
  /** The edge's latency, when known: the leg plays it in slow motion. */
  latencyMs: number | null;
}

export type XY = { x: number; y: number };

/** World units per ms the dot travels, and the pause on each waypoint. */
const SPEED = 0.22;
const DWELL_MS = 380;
/** A leg with a known latency plays at 20x slow motion, kept watchable. */
const SLOW_MOTION = 20;
const LEG_MS = { min: 450, max: 4000 };

/**
 * How long a leg plays: its latency in slow motion when known, else its length
 * at SPEED. A latency never rushes a long leg past twice SPEED.
 */
export function legMs(leg: Pick<Leg, 'latencyMs'>, length: number): number {
  const byLength = length / SPEED;
  const ms = leg.latencyMs === null ? byLength : Math.max(leg.latencyMs * SLOW_MOTION, byLength / 2);
  return Math.min(LEG_MS.max, Math.max(LEG_MS.min, ms));
}

/** Consecutive waypoints joined by a visible edge where one exists (either direction). */
export function routeLegs(nodeIds: readonly bigint[], edges: readonly Pick<Edge, 'id' | 'fromNode' | 'toNode' | 'latencyMs'>[]): Leg[] {
  const legs: Leg[] = [];
  for (let i = 1; i < nodeIds.length; i++) {
    const from = nodeIds[i - 1];
    const to = nodeIds[i];
    const fwd = edges.find(e => e.fromNode === from && e.toNode === to);
    const back = fwd ? undefined : edges.find(e => e.fromNode === to && e.toNode === from);
    const edge = fwd ?? back;
    legs.push({ from, to, edgeId: edge?.id ?? null, reverse: back !== undefined, latencyMs: edge && edge.latencyMs >= 0 ? edge.latencyMs : null });
  }
  return legs;
}

/** The dot eases out of a node and settles into the next. Sine, not cubic: its peak is about 1.6x the average speed, not 3x. */
export const easeInOut = (t: number): number => (1 - Math.cos(Math.PI * t)) / 2;

/** Trail samples kept, and how many of them draw a tail circle (every other one). */
const TRAIL = 10;

/**
 * A dot with a short fading tail. It samples its target every frame on its own
 * loop, so a fast stretch reads as one stroke and the tail draws itself in when
 * the dot rests. Fades in on creation and out on removal.
 */
export function comet(world: SVGGElement, cls = ''): { to(p: XY | null): void; remove(): void } {
  const g = el('g', { class: 'route-comet' });
  const tail = Array.from({ length: TRAIL / 2 }, (_, i) =>
    el('circle', { class: 'route-tail', r: String(3.6 - i * 0.5), opacity: String(0.42 - i * 0.075) })
  );
  const head = el('circle', { class: `route-dot ${cls}`.trim(), r: '5' });
  g.append(...[...tail].reverse(), head);
  g.style.visibility = 'hidden';
  world.append(g);
  const fade = (from: number, to: number, ms: number) =>
    typeof g.animate === 'function' && !reducedMotion() ? g.animate([{ opacity: from }, { opacity: to }], { duration: ms, easing: 'cubic-bezier(0.16, 1, 0.3, 1)', fill: 'forwards' }) : null;
  fade(0, 1, 180);
  let target: XY | null = null;
  const trail: XY[] = [];
  let raf = 0;
  const put = (c: SVGCircleElement, p: XY) => {
    c.setAttribute('cx', p.x.toFixed(1));
    c.setAttribute('cy', p.y.toFixed(1));
  };
  const frame = () => {
    if (target) {
      trail.unshift(target);
      trail.length = Math.min(trail.length, TRAIL + 1);
      put(head, target);
      tail.forEach((c, i) => put(c, trail[Math.min(trail.length - 1, (i + 1) * 2)]));
      g.style.visibility = '';
    }
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  return {
    to(p) {
      if (p) target = p;
    },
    remove() {
      cancelAnimationFrame(raf);
      const out = fade(1, 0, 260);
      if (out) out.onfinish = () => g.remove();
      else g.remove();
    },
  };
}

const dist = (a: XY, b: XY) => Math.hypot(b.x - a.x, b.y - a.y);
const lerp = (a: XY, b: XY, t: number): XY => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

export const reducedMotion = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Where a dot is at t in [0, 1] along a leg: centre -> edge start -> along the
 * drawn edge -> edge end -> centre, one continuous stroke; a straight line
 * where no edge joins them. Paths are measured when the leg starts.
 */
export function legSampler(world: SVGGElement, leg: Leg, center: (id: bigint) => XY | null): { at: (t: number) => XY | null; length: number } {
  const a = center(leg.from);
  const b = center(leg.to);
  if (!a || !b) return { length: 0, at: () => b ?? a };
  const path = leg.edgeId === null ? null : world.querySelector<SVGPathElement>(`.edge-hit[data-edge-id="${leg.edgeId}"]`);
  if (!path || typeof path.getTotalLength !== 'function') {
    return { length: dist(a, b), at: t => lerp(a, b, t) };
  }
  const pl = path.getTotalLength();
  const onPath = (d: number): XY => {
    const p = path.getPointAtLength(leg.reverse ? pl - d : d);
    return { x: p.x, y: p.y };
  };
  const p0 = onPath(0);
  const p1 = onPath(pl);
  const l0 = dist(a, p0);
  const l2 = dist(p1, b);
  const length = l0 + pl + l2;
  return {
    length,
    at: t => {
      const d = t * length;
      if (d <= l0) return lerp(a, p0, l0 === 0 ? 1 : d / l0);
      if (d <= l0 + pl) return onPath(d - l0);
      return lerp(p1, b, l2 === 0 ? 1 : (d - l0 - pl) / l2);
    },
  };
}

let stopCurrent: (() => void) | null = null;

/**
 * Send a dot along the route, leg by leg (legSampler).
 * Reduced motion: the dot hops waypoint to waypoint. Replays stop the last one.
 */
export function playRoute(world: SVGGElement, nodeIds: readonly bigint[], legs: readonly Leg[], center: (id: bigint) => XY | null): void {
  stopCurrent?.();
  if (nodeIds.length === 0) return;
  const reduce = reducedMotion();
  const dot = comet(world);
  const place = (p: XY | null) => dot.to(p);
  const hit = (id: bigint) => {
    const g = world.querySelector(`.node[data-id="${id}"]`);
    if (!g) return;
    // Off, then on next frame: a repeat hit restarts the pulse.
    g.classList.remove('route-hit');
    requestAnimationFrame(() => g.classList.add('route-hit'));
    setTimeout(() => g.classList.remove('route-hit'), 900);
  };
  let raf = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    cancelAnimationFrame(raf);
    clearTimeout(timer);
    dot.remove();
    if (stopCurrent === stop) stopCurrent = null;
  };
  stopCurrent = stop;

  const runLeg = (i: number) => {
    if (i >= legs.length) {
      timer = setTimeout(stop, DWELL_MS);
      return;
    }
    const s = legSampler(world, legs[i], center);
    const ms = reduce ? 0 : legMs(legs[i], s.length);
    const start = performance.now();
    const frame = (now: number) => {
      const t = ms === 0 ? 1 : Math.min(1, (now - start) / ms);
      place(s.at(easeInOut(t)));
      if (t < 1) {
        raf = requestAnimationFrame(frame);
        return;
      }
      hit(legs[i].to);
      timer = setTimeout(() => runLeg(i + 1), reduce ? DWELL_MS * 2 : DWELL_MS);
    };
    raf = requestAnimationFrame(frame);
  };

  place(center(nodeIds[0]));
  hit(nodeIds[0]);
  timer = setTimeout(() => runLeg(0), DWELL_MS);
}
