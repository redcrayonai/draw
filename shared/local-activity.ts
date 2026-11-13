export const LOCAL_ACTIVITY_LIMITS = { lineBytes: 4096, batch: 250, eventsPerSecond: 10000, edges: 1000, samplesPerEdge: 1024, staleMs: 3000 } as const;
export type LocalInteraction = { from: string; to: string; duration_ms?: number; error: boolean };
export type LocalTraffic = { edge: string; reverse: boolean; count: number; errors: number; samples: number; p50: number | null; p95: number | null };
export type LocalTrafficWindow = { at: number; duration: number; stale: boolean; traffic: LocalTraffic[] };
export function localInteraction(value: unknown): LocalInteraction {
  const v = value as LocalInteraction;
  if (!v || typeof v !== 'object' || Array.isArray(v) || typeof v.from !== 'string' || typeof v.to !== 'string' || !v.from.trim() || !v.to.trim() || v.from.length > 200 || v.to.length > 200 || (v.duration_ms !== undefined && (typeof v.duration_ms !== 'number' || !Number.isFinite(v.duration_ms) || v.duration_ms < 0)) || (v.error !== undefined && typeof v.error !== 'boolean')) throw new Error('REJECTED: expected from, to, optional nonnegative duration_ms and boolean error');
  return { from: v.from, to: v.to, ...(v.duration_ms !== undefined ? { duration_ms: v.duration_ms } : {}), error: v.error ?? false };
}
