import type { TapSpan } from './tap-otlp';

/** `.redcrayon/tap.json`: which board, and which node each service is drawn as. */
export interface TapMapping {
  board: string;
  services: Record<string, string>;
}

/** One node-to-node hop over one window. The canvas finds the edge between the two nodes. */
export interface EdgeSummary {
  from: string;
  to: string;
  count: number;
  errors: number;
  p50: number;
  p95: number;
  max: number;
}

export interface TapWindow {
  t: number;
  window_ms: number;
  edges: EdgeSummary[];
  unmapped: number;
}

/** A parent may arrive in a later export batch than its child: the child waits this long. */
const PARENT_WAIT_MS = 5_000;
/** Span ids remembered for parent lookups, and the cap that bounds memory. */
const SEEN_MS = 30_000;
const SEEN_MAX = 50_000;
export const MAX_EDGES = 500;

const round = (ms: number) => Math.round(ms * 10) / 10;
const pct = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];

/**
 * Turns spans into per-edge samples: a span whose parent ran in another
 * service is one call from the parent's service to the span's. Its duration
 * is the call's latency as the callee saw it.
 */
export class Aggregator {
  private seen = new Map<string, { service: string; at: number }>();
  private pending = new Map<string, { span: TapSpan; at: number }[]>();
  private samples = new Map<string, { from: string; to: string; ms: number[]; errors: number }>();
  private unmapped = 0;
  /** Service names seen without a node, for the periodic hint. */
  readonly unmappedServices = new Set<string>();
  private windowStart: number;

  constructor(private mapping: () => TapMapping, private now: () => number = Date.now) {
    this.windowStart = now();
  }

  add(spans: readonly TapSpan[]): void {
    const at = this.now();
    for (const s of spans) this.remember(s.spanId, s.service, at);
    for (const s of spans) {
      const waiting = this.pending.get(s.spanId);
      if (waiting) {
        this.pending.delete(s.spanId);
        for (const w of waiting) this.sample(s.service, w.span);
      }
      if (s.parentSpanId === null) continue;
      const parent = this.seen.get(s.parentSpanId);
      if (parent) {
        this.sample(parent.service, s);
      } else {
        const list = this.pending.get(s.parentSpanId) ?? [];
        list.push({ span: s, at });
        this.pending.set(s.parentSpanId, list);
      }
    }
  }

  private remember(spanId: string, service: string, at: number): void {
    this.seen.delete(spanId);
    this.seen.set(spanId, { service, at });
    while (this.seen.size > SEEN_MAX) this.seen.delete(this.seen.keys().next().value!);
  }

  private sample(parentService: string, child: TapSpan): void {
    if (parentService === child.service) return;
    const services = this.mapping().services;
    const from = services[parentService];
    const to = services[child.service];
    if (from === undefined || to === undefined) {
      this.unmapped++;
      if (from === undefined) this.unmappedServices.add(parentService);
      if (to === undefined) this.unmappedServices.add(child.service);
      return;
    }
    if (from === to) return;
    const key = `${from}>${to}`;
    const s = this.samples.get(key) ?? { from, to, ms: [], errors: 0 };
    s.ms.push(child.ms);
    if (child.error) s.errors++;
    this.samples.set(key, s);
  }

  /** Close the current window: its summary (null when nothing happened), then start the next one. */
  flush(): TapWindow | null {
    const now = this.now();
    for (const [id, list] of this.pending) {
      const live = list.filter(w => now - w.at < PARENT_WAIT_MS);
      if (live.length === 0) this.pending.delete(id);
      else this.pending.set(id, live);
    }
    for (const [id, s] of this.seen) {
      if (now - s.at < SEEN_MS) break; // insertion order is age order
      this.seen.delete(id);
    }
    const edges: EdgeSummary[] = [...this.samples.values()]
      .sort((a, b) => b.ms.length - a.ms.length)
      .slice(0, MAX_EDGES)
      .map(s => {
        const sorted = [...s.ms].sort((a, b) => a - b);
        return { from: s.from, to: s.to, count: sorted.length, errors: s.errors, p50: round(pct(sorted, 0.5)), p95: round(pct(sorted, 0.95)), max: round(sorted[sorted.length - 1]) };
      });
    const window: TapWindow = { t: Math.floor(now / 1000), window_ms: now - this.windowStart, edges, unmapped: this.unmapped };
    this.samples.clear();
    this.unmapped = 0;
    this.windowStart = now;
    return edges.length === 0 && window.unmapped === 0 ? null : window;
  }
}
