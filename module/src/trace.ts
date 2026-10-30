/** play_trace spans: the only fields a trace may carry onto a board. */
export const MAX_TRACE_SPANS = 200;
export const MAX_SPAN_MS = 600_000;
export const SPAN_KEYS = ['id', 'parent', 'node', 'startMs', 'durationMs', 'status'] as const;

export interface TraceSpan {
  id: string;
  parent: string | null;
  /** Board node id, as a decimal string. */
  node: string;
  startMs: number;
  durationMs: number;
  status: 'ok' | 'error';
}

/** A trace's length: the latest span end. */
export function traceMs(spans: readonly { startMs: number; durationMs: number }[]): number {
  return Math.round(Math.max(0, ...spans.map(s => s.startMs + s.durationMs)));
}

/**
 * Normalise play_trace spans. Only the whitelisted keys are accepted, so no
 * request data (attributes, URLs, payloads) can reach a board.
 */
export function parseTraceSpans(json: string, onBoard: (nodeId: bigint) => boolean): { ok: true; json: string; spans: TraceSpan[] } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { ok: false, error: 'spans must be a JSON array' };
  }
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: 'spans must be a non-empty array' };
  if (raw.length > MAX_TRACE_SPANS) return { ok: false, error: `at most ${MAX_TRACE_SPANS} spans` };
  const ids = new Set<string>();
  const spans: TraceSpan[] = [];
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i];
    if (s === null || typeof s !== 'object' || Array.isArray(s)) return { ok: false, error: `span ${i} is not an object` };
    const extra = Object.keys(s).filter(k => !(SPAN_KEYS as readonly string[]).includes(k));
    if (extra.length > 0) return { ok: false, error: `span ${i} has fields outside ${SPAN_KEYS.join(', ')}: ${extra.join(', ')}` };
    const { id, parent, node, startMs, durationMs, status } = s as Record<string, unknown>;
    if (typeof id !== 'string' || id.length === 0 || id.length > 64) return { ok: false, error: `span ${i} id must be 1-64 characters` };
    if (ids.has(id)) return { ok: false, error: `span id ${id} repeats` };
    ids.add(id);
    if (parent !== undefined && parent !== null && typeof parent !== 'string') return { ok: false, error: `span ${id} parent must be a span id` };
    if (typeof node !== 'string' || !/^\d{1,20}$/.test(node) || !onBoard(BigInt(node))) return { ok: false, error: `span ${id} node ${String(node)} is not on this board` };
    for (const [k, v] of [['startMs', startMs], ['durationMs', durationMs]] as const) {
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > MAX_SPAN_MS) return { ok: false, error: `span ${id} ${k} must be a number from 0 to ${MAX_SPAN_MS}` };
    }
    if (status !== undefined && status !== 'ok' && status !== 'error') return { ok: false, error: `span ${id} status must be ok or error` };
    spans.push({ id, parent: (parent as string | undefined) ?? null, node, startMs: startMs as number, durationMs: durationMs as number, status: (status as 'ok' | 'error' | undefined) ?? 'ok' });
  }
  for (const s of spans) {
    if (s.parent !== null && !ids.has(s.parent)) return { ok: false, error: `span ${s.id} parent ${s.parent} is not in the trace` };
    if (s.parent === s.id) return { ok: false, error: `span ${s.id} is its own parent` };
  }
  return { ok: true, json: JSON.stringify(spans), spans };
}
