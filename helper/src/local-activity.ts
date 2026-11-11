import { LOCAL_ACTIVITY_LIMITS as LIMITS, localInteraction, type LocalTrafficWindow } from '../../shared/local-activity';
import type { LocalBoard } from '../../shared/local';

type Bucket = { edge: string; reverse: boolean; count: number; errors: number; durations: number[] };
export class LocalActivity {
  private buckets = new Map<string, Bucket>();
  private began: number;
  private last = 0;
  private rateStart = 0;
  private rateCount = 0;
  private latest: LocalTrafficWindow;
  constructor(private publish: (window: LocalTrafficWindow) => void, now = Date.now()) {
    this.began = now; this.latest = { at: now, duration: 0, stale: true, traffic: [] };
  }
  snapshot() { return this.latest; }
  accept(board: LocalBoard, mapping: unknown, events: unknown[], now = Date.now()) {
    if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping) || Object.keys(mapping).length > 5000 || Object.values(mapping).some(v => typeof v !== 'string') || !Array.isArray(events) || events.length > LIMITS.batch) throw new Error('REJECTED: invalid activity mapping or batch');
    if (now - this.rateStart >= 1000) { this.rateCount = 0; this.rateStart = now; }
    const services = mapping as Record<string, string>;
    let accepted = 0; const rejected: Record<string, number> = {};
    for (const input of events) {
      try {
        const event = localInteraction(input);
        if (this.rateCount >= LIMITS.eventsPerSecond) throw new Error('event rate limit');
        const from = Object.hasOwn(services, event.from) ? services[event.from] : undefined, to = Object.hasOwn(services, event.to) ? services[event.to] : undefined;
        if (!from || !to || !board.nodes.some(n => n.id === from) || !board.nodes.some(n => n.id === to)) throw new Error('unmapped or deleted service');
        const edges = board.edges.filter(e => (e.from === from && e.to === to) || (e.from === to && e.to === from));
        if (edges.length !== 1) throw new Error(edges.length ? 'ambiguous connection' : 'missing connection');
        const edge = edges[0], reverse = edge.from !== from, key = `${edge.id}:${reverse}`;
        let bucket = this.buckets.get(key);
        if (!bucket) {
          if (this.buckets.size >= LIMITS.edges) throw new Error('edge window limit');
          bucket = { edge: edge.id, reverse, count: 0, errors: 0, durations: [] }; this.buckets.set(key, bucket);
        }
        if (event.duration_ms !== undefined && bucket.durations.length >= LIMITS.samplesPerEdge) throw new Error('latency sample limit');
        bucket.count++; bucket.errors += Number(event.error);
        if (event.duration_ms !== undefined) bucket.durations.push(event.duration_ms);
        accepted++; this.rateCount++; this.last = now;
      } catch (error) { const message = error instanceof Error ? error.message : 'invalid event'; rejected[message] = (rejected[message] ?? 0) + 1; }
    }
    return { accepted, rejected };
  }
  flush(now = Date.now()) {
    if (this.buckets.size) {
      this.latest = { at: now, duration: Math.max(1, now - this.began), stale: false, traffic: [...this.buckets.values()].map(b => {
        b.durations.sort((a, b) => a - b);
        const percentile = (p: number) => b.durations.length ? b.durations[Math.ceil(p * b.durations.length) - 1] : null;
        return { edge: b.edge, reverse: b.reverse, count: b.count, errors: b.errors, samples: b.durations.length, p50: percentile(.5), p95: percentile(.95) };
      }) };
      this.buckets.clear(); this.publish(this.latest);
    } else if (!this.latest.stale && now - this.last >= LIMITS.staleMs) { this.latest = { ...this.latest, stale: true }; this.publish(this.latest); }
    this.began = now;
  }
}
