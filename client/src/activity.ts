// Edge traffic as the canvas sees it. View-local: nothing here reaches the database.
// The ?demo=flow generator fills it until a tap source does.

export type EdgeActivity = { edgeId: bigint; rps: number; errRate: number; observedAt: number };

/** A reading older than this (ms, by observedAt) leaves its edge idle: static, as without activity. */
export const IDLE_MS = 10_000;

const byEdge = new Map<bigint, EdgeActivity>();

/** Merges readings by edge: an edge keeps its last reading until a newer one or IDLE_MS passes. */
export function setActivity(list: readonly EdgeActivity[]): void {
  for (const a of list) byEdge.set(a.edgeId, a);
  // Readings already idle by the newest one go, so edges that stop reporting (or leave the board) are not kept.
  const now = Math.max(...list.map(a => a.observedAt));
  for (const [id, a] of byEdge) if (now - a.observedAt >= IDLE_MS) byEdge.delete(id);
}

export const getActivity = (edgeId: bigint): EdgeActivity | undefined => byEdge.get(edgeId);

/** The edge's reading if it is fresh at `now` (epoch ms) and carries traffic. */
export function liveActivity(edgeId: bigint, now: number): EdgeActivity | undefined {
  const a = byEdge.get(edgeId);
  return a !== undefined && a.rps > 0 && now - a.observedAt < IDLE_MS ? a : undefined;
}

/** Each edge's demo rate in [2, 12] rps, the same on every load (an integer hash of its id). */
export function demoRps(edgeId: bigint): number {
  let h = Number(BigInt.asUintN(32, edgeId)) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return 2 + (((h ^ (h >>> 16)) >>> 0) / 2 ** 32) * 10;
}

/** The demo pauses one edge for this long out of every two, so the switch back to static is visible. */
const DEMO_PAUSE_MS = 20_000;

/**
 * Synthetic readings for ?demo=flow at `now` (epoch ms). The busiest edge errs on
 * 5% of its requests; the last other edge by id stops reporting on alternate
 * DEMO_PAUSE_MS windows and goes idle IDLE_MS later.
 */
export function demoActivity(edgeIds: readonly bigint[], now: number): EdgeActivity[] {
  if (edgeIds.length === 0) return [];
  const ids = [...edgeIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const busiest = ids.reduce((a, b) => (demoRps(b) > demoRps(a) ? b : a));
  const paused = Math.floor(now / DEMO_PAUSE_MS) % 2 === 1 ? ids.filter(id => id !== busiest).pop() : undefined;
  return ids
    .filter(id => id !== paused)
    .map(edgeId => ({ edgeId, rps: demoRps(edgeId), errRate: edgeId === busiest ? 0.05 : 0, observedAt: now }));
}
