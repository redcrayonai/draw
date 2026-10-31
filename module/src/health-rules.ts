// Pure board-health rules shared in spirit with the canvas. The module cannot
// import client code, so these are copies of client/src/render.ts
// evidenceClass and client/src/refs.ts parseCoverage. They live in this
// dependency-free file so client/src/health-rules-parity.test.ts can run both
// copies over the same inputs and fail when they drift.

export type EvidenceClass = 'import' | 'source' | 'stale' | 'test' | 'human' | 'agent' | 'none';

export function evidenceClass(evidence: string, status = ''): EvidenceClass {
  if (evidence === 'import') {
    return 'import';
  }
  if (evidence === 'test-import') {
    return 'test';
  }
  if (evidence.startsWith('source:')) {
    return status === 'ok' ? 'source' : 'stale';
  }
  if (evidence.startsWith('human:')) {
    return 'human';
  }
  if (evidence.startsWith('agent:')) {
    return 'agent';
  }
  return 'none';
}

export const HUMAN_EVIDENCE_RESERVED =
  "evidence rule: agents cannot use human: evidence; for a flow you cannot cite, pass agent:<what it rests on> (for example 'agent:user described the topology')";
export const AGENT_EVIDENCE_EMPTY = "evidence rule: 'agent:' must be followed by what the edge rests on";

/**
 * The prefix rules of edge evidence that need no database: human: names a
 * person, so an agent may not send it; agent: must say what it rests on.
 * Humans may send agent: so undo can replay an agent's edge. Throws plain
 * Errors; index.ts rethrows them as refusals.
 */
export function checkEvidencePrefix(evidence: string, agent: boolean): void {
  if (agent && evidence.startsWith('human:')) throw new Error(HUMAN_EVIDENCE_RESERVED);
  if (evidence.startsWith('agent:') && evidence.slice('agent:'.length).trim() === '') throw new Error(AGENT_EVIDENCE_EMPTY);
}

export interface Coverage {
  changed: number;
  uncovered: string[];
  excluded: { reason: string; paths: string[] }[];
  deleted: string[];
}

function strings(x: unknown): string[] {
  return Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string') : [];
}

function isGroup(x: unknown): x is { reason: string; paths?: unknown } {
  return typeof x === 'object' && x !== null && typeof (x as { reason?: unknown }).reason === 'string';
}

// Anything malformed collapses to the empty coverage.
export function parseCoverage(json: string): Coverage {
  const empty: Coverage = { changed: 0, uncovered: [], excluded: [], deleted: [] };
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return empty;
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    return empty;
  }
  const o = v as Record<string, unknown>;
  return {
    changed: typeof o.changed === 'number' && Number.isFinite(o.changed) ? o.changed : 0,
    uncovered: strings(o.uncovered),
    excluded: Array.isArray(o.excluded)
      ? o.excluded.filter(isGroup).map(g => ({ reason: g.reason, paths: strings(g.paths) }))
      : [],
    deleted: strings(o.deleted),
  };
}
