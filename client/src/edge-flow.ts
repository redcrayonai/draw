// Traffic dots along the drawn edges, source to target. Density encodes rate
// (every dot on an edge moves at one speed); accent dots are errors. An edge
// with neither live activity (activity.ts) nor a dots or threat motion draws nothing.
import { liveActivity } from './activity';
import { el, type EdgeMotion } from './render';
import { reducedMotion } from './route-play';

/** World units per ms at normal speed; an edge's motion speed scales it. */
const SPEED = 0.12;
const SPEEDS: Record<string, number> = { slow: 0.5, normal: 1, fast: 2 };
/** The rate a dots or threat edge shows without live activity. */
const STEADY_RPS = 3;
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
 * motion: no loop, no dots. The layer joins the world with its first dot.
 */
export function edgeFlow(world: SVGGElement, motionOf: (edgeId: bigint) => EdgeMotion | undefined = () => undefined): { sync(): void } {
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
      const motion = motionOf(id);
      const kind = motion?.motion;
      const a = liveActivity(id, wall);
      // A dash edge flows in CSS (render.ts); dots and threat run at live traffic's rate, else a steady one.
      const rps = kind === 'dash' ? undefined : a?.rps ?? (kind === 'dots' || kind === 'threat' ? STEADY_RPS : undefined);
      const v = SPEED * (SPEEDS[motion?.speed ?? 'normal'] ?? 1);
      let lane = lanes.get(id);
      if (rps === undefined && lane === undefined) continue;
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
      while (lane.dots.length > 0 && (now - lane.dots[0].born) * v >= lane.len) landed.push(lane.dots.shift()!.c);
      if (rps !== undefined && now >= lane.next) {
        if (lane.dots.length < MAX_IN_FLIGHT) {
          // Error dots by running debt, not dice: exactly errRate of the dots, deterministically.
          lane.errDebt += a?.errRate ?? 0;
          const err = lane.errDebt >= 1;
          if (err) lane.errDebt -= 1;
          const c = el('circle', { class: err ? 'flow-dot err' : kind === 'threat' ? 'flow-dot threat' : 'flow-dot', r: '2' });
          fresh.push(c);
          lane.dots.push({ c, born: now });
        }
        lane.next = now + spawnMs(rps);
      }
      for (const dot of lane.dots) {
        const at = ((now - dot.born) * v) / STEP;
        const i = Math.floor(at);
        const f = at - i;
        const pts = lane.pts;
        moves.push({ c: dot.c, x: pts[2 * i] + (pts[2 * i + 2] - pts[2 * i]) * f, y: pts[2 * i + 1] + (pts[2 * i + 3] - pts[2 * i + 1]) * f });
      }
      if (rps === undefined && lane.dots.length === 0) lanes.delete(id);
    }
    landed.forEach(c => c.remove());
    // Above the edge lines, under the nodes. Only once there is a dot: a board without traffic keeps today's DOM.
    if (fresh.length > 0 && !layer.isConnected) world.querySelector('.layer-edges')?.after(layer);
    layer.append(...fresh);
    for (const m of moves) {
      m.c.setAttribute('cx', m.x.toFixed(1));
      m.c.setAttribute('cy', m.y.toFixed(1));
    }
    if (lanes.size > 0) raf = requestAnimationFrame(frame);
  };

  const sync = () => {
    // A board switch rebuilds the world without the layer: its dots went with it.
    if (document.hidden || reducedMotion() || !layer.isConnected) halt();
    if (document.hidden || reducedMotion()) return;
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
