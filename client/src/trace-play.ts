import type { Edge } from './module_bindings/types';
import type { TraceSpan } from '../../module/src/trace';
import { comet, easeInOut, legSampler, reducedMotion, routeLegs, type XY } from './route-play';

/** A trace plays in about this long however long it ran, never faster than real time. */
const TARGET_MS = 9000;
const MAX_SLOWDOWN = 300;
/** A hop's travel time: long enough to follow by eye. At play time a long edge stretches it to HOP_SPEED (world units per ms). */
const HOP_MS = { min: 320, max: 720 };
const HOP_SPEED = 0.55;
const HOP_MAX_MS = 1100;

export interface TraceStep {
  span: TraceSpan;
  /** The parent span's node, when the call crosses to another node. */
  from: bigint | null;
  node: bigint;
  /** Scaled ms from the start of playback. */
  start: number;
  end: number;
  hopMs: number;
}

/** When each span plays, slowed so the whole trace lasts about TARGET_MS. */
export function traceSchedule(spans: readonly TraceSpan[]): { slowdown: number; totalMs: number; steps: TraceStep[] } {
  const totalMs = Math.max(0, ...spans.map(s => s.startMs + s.durationMs));
  const slowdown = totalMs === 0 ? 1 : Math.min(MAX_SLOWDOWN, Math.max(1, TARGET_MS / totalMs));
  const byId = new Map(spans.map(s => [s.id, s]));
  const steps = [...spans]
    .sort((a, b) => a.startMs - b.startMs)
    .map(span => {
      const parent = span.parent === null ? undefined : byId.get(span.parent);
      const from = parent && parent.node !== span.node ? BigInt(parent.node) : null;
      const start = span.startMs * slowdown;
      const end = (span.startMs + span.durationMs) * slowdown;
      const hopMs = from === null ? 0 : Math.min(HOP_MS.max, Math.max(HOP_MS.min, (end - start) / 3));
      return { span, from, node: BigInt(span.node), start, end, hopMs };
    });
  return { slowdown, totalMs, steps };
}

let stopCurrent: (() => void) | null = null;

/**
 * Replay a trace: each cross-node call sends a dot from the parent span's node
 * to its own along the drawn edge, then the node stays lit while its span runs
 * (red for an error). Reduced motion: no dots, nodes light in order.
 * A new replay stops the last one.
 */
export function playTrace(
  world: SVGGElement,
  spans: readonly TraceSpan[],
  edges: readonly Pick<Edge, 'id' | 'fromNode' | 'toNode' | 'latencyMs'>[],
  center: (id: bigint) => XY | null
): void {
  stopCurrent?.();
  const reduce = reducedMotion();
  const { steps } = traceSchedule(spans);
  const timers: ReturnType<typeof setTimeout>[] = [];
  const frames = new Set<number>();
  const dots = new Set<ReturnType<typeof comet>>();
  const lit = new Map<bigint, number>();
  const light = (id: bigint, on: boolean, error: boolean) => {
    const g = world.querySelector(`.node[data-id="${id}"]`);
    const n = (lit.get(id) ?? 0) + (on ? 1 : -1);
    lit.set(id, n);
    g?.classList.toggle('trace-active', n > 0);
    if (on && error) g?.classList.add('trace-error');
    if (n <= 0) g?.classList.remove('trace-error');
  };
  const stop = () => {
    for (const t of timers) clearTimeout(t);
    for (const f of frames) cancelAnimationFrame(f);
    for (const d of dots) d.remove();
    for (const id of lit.keys()) world.querySelector(`.node[data-id="${id}"]`)?.classList.remove('trace-active', 'trace-error');
    // Leave the fade-out transitions in place until the last node has dimmed.
    timers.push(setTimeout(() => stopCurrent === null && world.classList.remove('trace-playing'), 500));
    if (stopCurrent === stop) stopCurrent = null;
  };
  stopCurrent = stop;
  world.classList.add('trace-playing');

  const hop = (step: TraceStep, done: (ms: number) => void) => {
    const leg = routeLegs([step.from!, step.node], edges)[0];
    const s = legSampler(world, leg, center);
    const ms = Math.min(HOP_MAX_MS, Math.max(step.hopMs, s.length / HOP_SPEED));
    const dot = comet(world, step.span.status === 'error' ? 'trace-dot error' : 'trace-dot');
    dots.add(dot);
    const t0 = performance.now();
    const frame = (now: number) => {
      const t = Math.min(1, (now - t0) / ms);
      dot.to(s.at(easeInOut(t)));
      if (t < 1) {
        const f = requestAnimationFrame(frame);
        frames.add(f);
        return;
      }
      dot.remove();
      dots.delete(dot);
      done(ms);
    };
    frames.add(requestAnimationFrame(frame));
  };

  for (const step of steps) {
    timers.push(setTimeout(() => {
      const arrive = (hopMs = 0) => {
        light(step.node, true, step.span.status === 'error');
        timers.push(setTimeout(() => light(step.node, false, false), Math.max(320, step.end - step.start - hopMs)));
      };
      if (step.from === null || reduce) arrive();
      else hop(step, arrive);
    }, step.start));
  }
  const last = Math.max(0, ...steps.map(s => s.end));
  timers.push(setTimeout(stop, last + HOP_MAX_MS + 600));
}
