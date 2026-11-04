/**
 * Search ranking for the library panel. Pure and generic: callers map their
 * objects, icons, charts and saved items to SearchEntry and get the matches
 * back best first. The query is only ever compared as text, never built into
 * a RegExp.
 *
 * Sort key, left to right: [exact name, on this board, tier, span, input index].
 * Tier 0 name prefix, 1 word prefix, 2 name substring, 3 name fuzzy (queries of
 * 2+ characters), 4 id, term or section title.
 */

export interface SearchEntry<T> { value: T; name: string; id: string; terms: readonly string[]; group: string; onBoard: boolean }
/** `highlight` holds indexes into `name`; `term` is the matched term when name, id and group did not match. */
export interface RankedEntry<T> { value: T; name: string; group: string; highlight: readonly number[]; term?: string }

const range = (start: number, len: number): number[] => Array.from({ length: len }, (_, i) => start + i);
const isWordChar = (c: string): boolean => /[\p{L}\p{N}]/u.test(c);

/** Letters of `q` in order inside `text`, in the shortest window (earliest on a tie), or null. */
function fuzzy(text: string, q: string): number[] | null {
  let best: number[] | null = null;
  let bestSpan = Infinity;
  for (let s = text.indexOf(q[0]); s >= 0; s = text.indexOf(q[0], s + 1)) {
    const at: number[] = [];
    for (let i = s, j = 0; i < text.length && j < q.length; i++) if (text[i] === q[j]) { at.push(i); j++; }
    if (at.length < q.length) break; // no later start can fit either
    const span = at[at.length - 1] - s + 1;
    if (span < bestSpan) { best = at; bestSpan = span; }
  }
  return best;
}

interface Hit { exact: boolean; tier: number; span: number; highlight: number[]; term?: string }

function match<T>(q: string, en: SearchEntry<T>): Hit | null {
  const name = en.name.toLowerCase();
  const exact = name === q;
  if (name.startsWith(q)) return { exact, tier: 0, span: q.length, highlight: range(0, q.length) };
  for (let i = name.indexOf(q, 1); i >= 0; i = name.indexOf(q, i + 1)) {
    if (!isWordChar(name[i - 1])) return { exact, tier: 1, span: q.length, highlight: range(i, q.length) };
  }
  const at = name.indexOf(q);
  if (at >= 0) return { exact, tier: 2, span: q.length, highlight: range(at, q.length) };
  const fz = q.length > 1 ? fuzzy(name, q) : null;
  if (fz) return { exact, tier: 3, span: fz[fz.length - 1] - fz[0] + 1, highlight: fz };
  const id = en.id.toLowerCase();
  if (id.includes(q) || (q.length > 1 && fuzzy(id, q)) || en.group.toLowerCase().includes(q)) {
    return { exact, tier: 4, span: 0, highlight: [] };
  }
  const term = en.terms.find(t => t.toLowerCase().includes(q));
  return term === undefined ? null : { exact, tier: 4, span: 0, highlight: [], term };
}

/** The entries that match `query`, best first; an empty or blank query matches nothing. */
export function rankEntries<T>(query: string, entries: readonly SearchEntry<T>[]): RankedEntry<T>[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: { key: number[]; out: RankedEntry<T> }[] = [];
  entries.forEach((en, i) => {
    const h = match(q, en);
    if (!h) return;
    const out: RankedEntry<T> = { value: en.value, name: en.name, group: en.group, highlight: h.highlight };
    if (h.term !== undefined) out.term = h.term;
    hits.push({ key: [h.exact ? 0 : 1, en.onBoard ? 0 : 1, h.tier, h.span, i], out });
  });
  hits.sort((a, b) => {
    for (let k = 0; k < a.key.length; k++) if (a.key[k] !== b.key[k]) return a.key[k] - b.key[k];
    return 0;
  });
  return hits.map(h => h.out);
}
