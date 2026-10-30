// Plays a blast over the drawn edges: dots that loop outward from the source (the open card),
// and a one-shot spread, hop by hop. Reuses the route comet and its leg sampler.
import type { Edge } from './module_bindings/types';
import type { Blast } from './blast';
import { comet, easeInOut, legMs, legSampler, reducedMotion, type Leg, type XY } from './route-play';

export const MAX_DOTS = 40;
const LOOP_MS = 1600;
const WARM_DELAY_MS = 800;

/** The edges that animate (dots and dash flow), oriented away from the source, hop then edge id, first MAX_DOTS. */
function animated(blast: Blast, edges: readonly Pick<Edge, 'id' | 'fromNode' | 'toNode'>[]): Leg[] {
  const hopOf = (id: bigint) => (id === blast.source ? 0 : blast.nodes.get(id)?.hop);
  const out: { leg: Leg; hop: number }[] = [];
  for (const e of edges) {
    const hop = blast.edges.get(e.id);
    const a = hopOf(e.fromNode);
    const b = hopOf(e.toNode);
    if (hop === undefined || a === undefined || b === undefined) continue;
    const reverse = a > b;
    out.push({ hop, leg: { from: reverse ? e.toNode : e.fromNode, to: reverse ? e.fromNode : e.toNode, edgeId: e.id, reverse, latencyMs: null } });
  }
  out.sort((x, y) => x.hop - y.hop || (x.leg.edgeId! < y.leg.edgeId! ? -1 : 1));
  return out.slice(0, MAX_DOTS).map(x => x.leg);
}

/** Legs oriented away from the source (smaller hop to larger), hop then edge id, capped at MAX_DOTS. */
export const blastLegs = animated;

/** Ids of the edges that animate: the same capped selection as blastLegs; the rest of the blast stays a static dash. */
export const blastEdgeIds = (blast: Blast, edges: readonly Pick<Edge, 'id' | 'fromNode' | 'toNode'>[]): Set<bigint> =>
  new Set(animated(blast, edges).map(l => l.edgeId!));

/** Each leg's hop: one more than the hop of the node it leaves (a node no leg reaches is the source, hop 0). Legs come in hop order. */
function legHops(legs: readonly Leg[]): number[] {
  const nodeHop = new Map<bigint, number>();
  return legs.map(l => {
    const hop = (nodeHop.get(l.from) ?? 0) + 1;
    if (!nodeHop.has(l.to)) nodeHop.set(l.to, hop);
    return hop;
  });
}

/** One looping dot per leg. Hop 2 and beyond start half a loop late and run amber. */
export function loopBlast(world: SVGGElement, legs: Leg[], center: (id: bigint) => XY | null): { stop(): void } {
  if (reducedMotion() || legs.length === 0) return { stop() {} };
  const hops = legHops(legs);
  const dots = legs.map((leg, i) => ({
    dot: comet(world, hops[i] >= 2 ? 'blast-dot warm' : 'blast-dot'),
    s: legSampler(world, leg, center),
    delay: hops[i] >= 2 ? WARM_DELAY_MS : 0,
  }));
  const start = performance.now();
  let raf = 0;
  const frame = (now: number) => {
    for (const d of dots) {
      const t = now - start - d.delay;
      if (t >= 0) d.dot.to(d.s.at((t % LOOP_MS) / LOOP_MS));
    }
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  return {
    stop() {
      cancelAnimationFrame(raf);
      dots.forEach(d => d.dot.remove());
    },
  };
}

/** Plays hop 1 legs together, then hop 2, and so on. Resolves when the last dot lands. */
export function playSpread(world: SVGGElement, legs: Leg[], center: (id: bigint) => XY | null): Promise<void> {
  if (reducedMotion() || legs.length === 0) return Promise.resolve();
  const hops = legHops(legs);
  const levels = [...new Set(hops)].sort((a, b) => a - b);
  return new Promise(resolve => {
    const runLevel = (li: number) => {
      if (li >= levels.length) return resolve();
      const runs = legs
        .filter((_, i) => hops[i] === levels[li])
        .map(leg => {
          const s = legSampler(world, leg, center);
          return { s, ms: legMs(leg, s.length), dot: comet(world, levels[li] >= 2 ? 'blast-dot warm' : 'blast-dot') };
        });
      const total = Math.max(...runs.map(r => r.ms));
      const start = performance.now();
      const frame = (now: number) => {
        for (const r of runs) r.dot.to(r.s.at(easeInOut(Math.min(1, (now - start) / r.ms))));
        if (now - start < total) {
          requestAnimationFrame(frame);
          return;
        }
        runs.forEach(r => r.dot.remove());
        runLevel(li + 1);
      };
      requestAnimationFrame(frame);
    };
    runLevel(0);
  });
}
