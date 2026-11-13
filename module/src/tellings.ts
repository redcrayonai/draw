// Telling rules: pure, no imports. A telling is an ordered walk-through of a board;
// each step lights some nodes and carries one sentence.
export const MAX_TELLINGS_PER_BOARD = 6, MAX_TELLING_STEPS = 12, MAX_STEP_NODES = 12;
export const MAX_AUDIENCE = 40, MAX_TELLING_TITLE = 120, MAX_STEP_TITLE = 80, MAX_STEP_BODY = 280, MAX_STEP_SOURCE = 200;
export const STEP_KEYS = ['nodes', 'frame', 'title', 'body', 'source'] as const;

/** Node ids are decimal strings. frame and source are always present after parsing ([] and ''). */
export interface TellingStep { nodes: string[]; frame: string[]; title: string; body: string; source: string }

const ID = /^\d{1,20}$/;

/** Lower-cased, trimmed, inner spaces collapsed: two audiences with the same key are the same telling. */
export function audienceKey(audience: string): string {
  return audience.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Returns the error sentence (without the "telling rule: " prefix) or null. */
export function tellingHeadError(audience: string, title: string): string | null {
  const a = audience.trim().length, t = title.trim().length;
  if (a < 1 || a > MAX_AUDIENCE) return `audience must be 1 to ${MAX_AUDIENCE} characters`;
  if (t < 1 || t > MAX_TELLING_TITLE) return `title must be 1 to ${MAX_TELLING_TITLE} characters`;
  return null;
}

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

export function parseTellingSteps(json: string, onBoard: (nodeId: bigint) => boolean):
  { ok: true; json: string; steps: TellingStep[] } | { ok: false; error: string } {
  const fail = (error: string) => ({ ok: false as const, error });
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { return fail('steps must be a JSON array'); }
  if (!Array.isArray(raw)) return fail('steps must be a JSON array');
  if (raw.length === 0) return fail('steps must be a non-empty array');
  if (raw.length > MAX_TELLING_STEPS) return fail(`at most ${MAX_TELLING_STEPS} steps`);

  const steps: TellingStep[] = [];
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i], at = `step ${i}`;
    if (typeof s !== 'object' || s === null || Array.isArray(s)) return fail(`${at} must be an object`);
    const extra = Object.keys(s).filter((k) => !(STEP_KEYS as readonly string[]).includes(k));
    if (extra.length) return fail(`${at} has fields outside ${STEP_KEYS.join(', ')}: ${extra.join(', ')}`);
    const o = s as Record<string, unknown>;

    // Returns the deduped ids, or an error sentence.
    const ids = (v: unknown[]): string[] | string => {
      const out: string[] = [];
      for (const id of v) {
        if (typeof id !== 'string' || !ID.test(id) || !onBoard(BigInt(id))) {
          return `${at} names node ${String(id)}, which is not on this board`;
        }
        if (!out.includes(id)) out.push(id);
      }
      return out;
    };

    if (!Array.isArray(o.nodes) || o.nodes.length < 1 || o.nodes.length > MAX_STEP_NODES) {
      return fail(`${at} must light 1 to ${MAX_STEP_NODES} nodes`);
    }
    const nodes = ids(o.nodes);
    if (typeof nodes === 'string') return fail(nodes);

    const frameIn = o.frame === undefined ? [] : o.frame;
    if (!Array.isArray(frameIn) || frameIn.length > MAX_STEP_NODES) return fail(`${at} frame must be at most ${MAX_STEP_NODES} nodes`);
    const frame = ids(frameIn);
    if (typeof frame === 'string') return fail(frame);

    const title = text(o.title), body = text(o.body), source = text(o.source);
    if (title.length < 1 || title.length > MAX_STEP_TITLE) return fail(`${at} title must be 1 to ${MAX_STEP_TITLE} characters`);
    if (body.length < 1 || body.length > MAX_STEP_BODY) return fail(`${at} body must be 1 to ${MAX_STEP_BODY} characters`);
    if (source.length > MAX_STEP_SOURCE) return fail(`${at} source must be at most ${MAX_STEP_SOURCE} characters`);
    steps.push({ nodes, frame, title, body, source });
  }
  return { ok: true, json: JSON.stringify(steps), steps };
}

/** For version restore: maps every node id; ids that map to 0n are dropped; malformed JSON is returned unchanged. */
export function remapTellingSteps(json: string, to: (id: bigint) => bigint): string {
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { return json; }
  if (!Array.isArray(raw)) return json;
  const map = (v: unknown): unknown => {
    if (!Array.isArray(v)) return v;
    return v.flatMap((id) => {
      if (typeof id !== 'string' || !ID.test(id)) return [id];
      const n = to(BigInt(id));
      return n === 0n ? [] : [n.toString()];
    });
  };
  return JSON.stringify(raw.map((s) => (typeof s === 'object' && s !== null ? { ...s, nodes: map(s.nodes), frame: map(s.frame) } : s)));
}
