// Traffic dots along the drawn edges, source to target. Density encodes rate
// (every dot moves at SPEED); accent dots are errors. Edges idle by activity.ts draw nothing.
import { liveActivity } from './activity';
import { el } from './render';
import { reducedMotion } from './route-play';

/** World units per ms, the same for every dot. */
const SPEED = 0.12;
export const MAX_IN_FLIGHT = 12;

/** Time between dots on an edge carrying `rps` requests a second. */
export const spawnMs = (rps: number): number => Math.min(2000, Math.max(80, 1000 / rps));

/** Path sample spacing, world units: dots interpolate between samples instead of measuring the path every frame. */
const STEP = 2;

type Lane = { path: SVGPathElement; d: string; len: number; pts: Float32Array; dots: { c: SVGCircleElement; born: number }[]; next: number; errDebt: number };

/**
 * One requestAnimationFrame loop for every edge. Call sync() after each render
 * and each setActivity: it picks up redrawn paths and wakes the loop, which
 * sleeps once no edge is live and no dot is in flight. Hidden tab or reduced
 * motion: no loop, no dots.
 */
export function edgeFlow(world: SVGGElement): { sync(): void } {
  const layer = el('g', { class: 'layer-flow' });
  const lanes = new Map<bigint, Lane>();
  let paths = new Map<bigint, SVGPathElement>();
  let raf = 0;

  const halt = () => {
    cancelAnimationFrame(raf);
    raf = 0;
    lanes.clear();
    layer.replaceChildren();
  };

  const frame = (now: number) => {
    raf = 0;
    const wall = Date.now();
    // Reads (path geometry) first, DOM writes after: interleaving them forces a layout per edge.
    const fresh: SVGCircleElement[] = [];
    const landed: SVGCircleElement[] = [];
    const moves: { c: SVGCircleElement; x: number; y: number }[] = [];
    for (const [id, path] of paths) {
      const a = liveActivity(id, wall);
      let lane = lanes.get(id);
      if (a === undefined && lane === undefined) continue;
      if (lane === undefined || lane.path !== path) {
        lane?.dots.forEach(d => d.c.remove());
        lane = { path, d: '', len: 0, pts: new Float32Array(0), dots: [], next: now, errDebt: 0 };
        lanes.set(id, lane);
      }
      const d = path.getAttribute('d') ?? '';
      if (d !== lane.d) {
        lane.d = d;
        lane.len = path.getTotalLength();
        lane.pts = new Float32Array(2 * (Math.ceil(lane.len / STEP) + 1));
        for (let i = 0; i < lane.pts.length / 2; i++) {
          const p = path.getPointAtLength(Math.min(i * STEP, lane.len));
          lane.pts[2 * i] = p.x;
          lane.pts[2 * i + 1] = p.y;
        }
      }
      while (lane.dots.length > 0 && (now - lane.dots[0].born) * SPEED >= lane.len) landed.push(lane.dots.shift()!.c);
      if (a !== undefined && now >= lane.next) {
        if (lane.dots.length < MAX_IN_FLIGHT) {
          // Error dots by running debt, not dice: exactly errRate of the dots, deterministically.
          lane.errDebt += a.errRate;
          const err = lane.errDebt >= 1;
          if (err) lane.errDebt -= 1;
          const c = el('circle', { class: err ? 'flow-dot err' : 'flow-dot', r: '2' });
          fresh.push(c);
          lane.dots.push({ c, born: now });
        }
        lane.next = now + spawnMs(a.rps);
      }
      for (const dot of lane.dots) {
        const at = ((now - dot.born) * SPEED) / STEP;
        const i = Math.floor(at);
        const f = at - i;
        const pts = lane.pts;
        moves.push({ c: dot.c, x: pts[2 * i] + (pts[2 * i + 2] - pts[2 * i]) * f, y: pts[2 * i + 1] + (pts[2 * i + 3] - pts[2 * i + 1]) * f });
      }
      if (a === undefined && lane.dots.length === 0) lanes.delete(id);
    }
    landed.forEach(c => c.remove());
    layer.append(...fresh);
    for (const m of moves) {
      m.c.setAttribute('cx', m.x.toFixed(1));
      m.c.setAttribute('cy', m.y.toFixed(1));
    }
    if (lanes.size > 0) raf = requestAnimationFrame(frame);
  };

  const sync = () => {
    if (document.hidden || reducedMotion()) return halt();
    // Above the edge lines, under the nodes; a board switch rebuilds the world without it.
    if (!layer.isConnected) world.querySelector('.layer-edges')?.after(layer);
    paths = new Map(
      [...world.querySelectorAll<SVGPathElement>('.layer-edges .edge-hit[data-edge-id]')].map(p => [BigInt(p.dataset.edgeId!), p])
    );
    for (const [id, lane] of lanes) {
      if (paths.has(id)) continue;
      lane.dots.forEach(d => d.c.remove());
      lanes.delete(id);
    }
    if (raf === 0) raf = requestAnimationFrame(frame);
  };

  document.addEventListener('visibilitychange', sync);
  return { sync };
}
