import type { TellingStep } from '../../module/src/tellings';

export interface Telling { id: bigint; audience: string; title: string; steps: TellingStep[] }

const ID = /^\d{1,20}$/;
const ids = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && ID.test(x)) : [];

/** This board's tellings, oldest first. A row whose steps do not parse is skipped. */
export function readTellings(rows: Iterable<{ id: bigint; boardId: bigint; audience: string; title: string; steps: string }>, boardId: bigint): Telling[] {
  const out: Telling[] = [];
  for (const r of rows) {
    if (r.boardId !== boardId) continue;
    let raw: unknown;
    try { raw = JSON.parse(r.steps); } catch { continue; }
    if (!Array.isArray(raw) || !raw.length) continue;
    if (!raw.every(s => s && typeof s === 'object' && Array.isArray((s as { nodes?: unknown }).nodes))) continue;
    const steps = raw.map((s: Partial<TellingStep>): TellingStep => ({
      nodes: ids(s.nodes), frame: ids(s.frame),
      title: String(s.title ?? ''), body: String(s.body ?? ''), source: String(s.source ?? ''),
    }));
    out.push({ id: r.id, audience: r.audience, title: r.title, steps });
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export interface StepView {
  lit: ReadonlySet<bigint>;
  seen: ReadonlySet<bigint>;
  stepOf: ReadonlyMap<bigint, number>;
  frame: bigint[];
}

/** at in 0..steps.length-1 is a step; at === steps.length is the ending: every named node lit, frame = all of them. */
export function stepView(t: Telling, at: number, live: ReadonlySet<bigint>): StepView {
  const n = t.steps.length;
  at = Math.max(0, Math.min(n, at));
  const named = t.steps.map(s => s.nodes.map(BigInt).filter(id => live.has(id)));
  const first = new Map<bigint, number>(); // node -> 1-based step that first named it
  named.forEach((ids, i) => ids.forEach(id => { if (!first.has(id)) first.set(id, i + 1); }));
  if (at === n) return { lit: new Set(first.keys()), seen: new Set(), stepOf: first, frame: [...first.keys()] };
  const lit = new Set(named[at]);
  const seen = new Set<bigint>();
  for (let i = 0; i < at; i++) for (const id of named[i]) if (!lit.has(id)) seen.add(id);
  const stepOf = new Map([...first].filter(([id]) => lit.has(id) || seen.has(id)));
  const framed = t.steps[at].frame.map(BigInt).filter(id => live.has(id));
  return { lit, seen, stepOf, frame: framed.length ? framed : [...lit] };
}

export const stepMs = (step: TellingStep): number => Math.min(9000, Math.max(3200, 2600 + 45 * step.body.length));

export function stepStart(t: Telling, at: number): number {
  return t.steps.slice(0, at).reduce((sum, s) => sum + stepMs(s), 0);
}

export const tellingMs = (t: Telling): number => stepStart(t, t.steps.length);

/** steps.length once ms >= tellingMs(t). */
export function stepAt(t: Telling, ms: number): number {
  let end = 0;
  for (let i = 0; i < t.steps.length; i++) {
    end += stepMs(t.steps[i]);
    if (ms < end) return i;
  }
  return t.steps.length;
}
