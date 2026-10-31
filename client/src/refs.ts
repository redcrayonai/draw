import type { CodeRef } from './module_bindings/types';

/** Shape of session.coverage (JSON string written by the MCP server). */
export type Coverage = {
  changed: number;
  uncovered: string[];
  excluded: { reason: string; paths: string[] }[];
  deleted: string[];
  /** changed migration files no change note cites (spec 2026-10-16 D2); absent when none */
  unconfirmed?: string[];
};

/** What the chrome needs per ref. Snippet and sha stay on the row and are
 *  read lazily for the one expanded ref, so nothing per frame scales with
 *  snippet size. */
export type RefSummary = {
  id: bigint;
  symbol: string;
  path: string;
  startLine: number;
  endLine: number;
  checkpoint: number;
  status: string;
};

function byId(a: RefSummary, b: RefSummary): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Index codeRef rows for one board by target: keys are `node:<id>` and `edge:<id>`. */
export function buildRefsIndex(rows: Iterable<CodeRef>, boardId: bigint): Map<string, RefSummary[]> {
  const out = new Map<string, RefSummary[]>();
  for (const r of rows) {
    if (r.boardId !== boardId) {
      continue;
    }
    const key = `${r.targetKind}:${r.targetId}`;
    let list = out.get(key);
    if (list === undefined) {
      list = [];
      out.set(key, list);
    }
    list.push({
      id: r.id,
      symbol: r.symbol,
      path: r.path,
      startLine: r.startLine,
      endLine: r.endLine,
      checkpoint: r.checkpoint,
      status: r.status,
    });
  }
  for (const list of out.values()) {
    list.sort(byId);
  }
  return out;
}

/**
 * Remove refs whose target no longer exists (the server cascades on delete,
 * so these are rare: a delete that raced the subscription, or a row deleted
 * by hand). Mutates `index`; returns the number of refs still indexed.
 */
export function pruneOrphanRefs(
  index: Map<string, RefSummary[]>,
  nodeIds: ReadonlySet<bigint>,
  edgeIds: ReadonlySet<bigint>
): number {
  let live = 0;
  for (const [key, refs] of [...index]) {
    const sep = key.indexOf(':');
    const kind = key.slice(0, sep);
    const id = BigInt(key.slice(sep + 1));
    const alive = kind === 'node' ? nodeIds.has(id) : kind === 'edge' ? edgeIds.has(id) : false;
    if (alive) {
      live += refs.length;
    } else {
      index.delete(key);
    }
  }
  return live;
}

/**
 * The part of `symbol` that must occur in the snippet: the last dotted
 * segment (`allow` for `Limiter.allow`), or the whole symbol when undotted.
 * A copy of the rule in module/src/index.ts and agent/src/resolver.ts (the
 * client cannot import either); keep the three identical.
 */
export function symbolNeedle(symbol: string): string {
  const dot = symbol.lastIndexOf('.');
  const tail = dot >= 0 ? symbol.slice(dot + 1) : symbol;
  return tail.length > 0 ? tail : symbol;
}

/** Refs whose lines are as last seen, by status (G12). */
function statusCounts(refs: RefSummary[]): { stale: number; ambiguous: number } {
  let stale = 0;
  let ambiguous = 0;
  for (const r of refs) {
    if (r.status === 'stale') {
      stale++;
    } else if (r.status === 'ambiguous') {
      ambiguous++;
    }
  }
  return { stale, ambiguous };
}

export type StaleOwner = { kind: string; id: bigint; refId: bigint };

/**
 * Targets on the canvas that hold a stale or ambiguous ref, each with its
 * first such ref, and the counts over those targets only (G12). The rail line
 * counts exactly the set its click walks, so a hidden owner adds nothing.
 */
export function visibleStale(
  index: ReadonlyMap<string, RefSummary[]>,
  shownNodes: ReadonlySet<bigint>,
  shownEdges: ReadonlySet<bigint>
): { owners: StaleOwner[]; stale: number; ambiguous: number } {
  const owners: StaleOwner[] = [];
  let stale = 0;
  let ambiguous = 0;
  for (const [key, refs] of index) {
    const sep = key.indexOf(':');
    const kind = key.slice(0, sep);
    const id = BigInt(key.slice(sep + 1));
    const bad = refs.filter(r => r.status === 'stale' || r.status === 'ambiguous');
    if (bad.length === 0 || !(kind === 'edge' ? shownEdges : shownNodes).has(id)) {
      continue;
    }
    const c = statusCounts(bad);
    stale += c.stale;
    ambiguous += c.ambiguous;
    owners.push({ kind, id, refId: bad[0].id });
  }
  return { owners, stale, ambiguous };
}

/** The symbol the badge names: the first ok ref's, never a stale one (G12). */
function firstOkSymbol(refs: RefSummary[]): string {
  return refs.find(r => r.status === 'ok')?.symbol ?? '';
}

/**
 * Badge identity for the keyed renderer: count, node size, first ok symbol,
 * the node's title revision and, when any ref is not ok, a status digest. The
 * renderer rebuilds the badge only when this changes, so without `rev` a
 * range shift or a remove-B-add-C replace (same count, same first symbol)
 * would leave the <title> tooltip stale, and without the digest an ok ref
 * turning stale would never repaint (G12).
 */
export function refsKeyFor(refs: RefSummary[], w: number, h: number, rev = 0): string {
  const { stale, ambiguous } = statusCounts(refs);
  const digest = stale + ambiguous > 0 ? `|s${stale}a${ambiguous}` : '';
  return `${refs.length}|${w}|${h}|${firstOkSymbol(refs)}|${rev}${digest}`;
}

/** The badge <title> for one node: `symbol · path:start–end`, one line per
 *  ref, marked ` (stale)` or ` (ambiguous)` when its lines are as last seen. */
/** `12–18`, or `12` for a one-line range. */
export function lineSpan(start: number, end: number): string {
  return start === end ? String(start) : `${start}–${end}`;
}

export function badgeTitle(refs: RefSummary[]): string {
  return refs
    .map(r => `${r.symbol} · ${r.path}:${lineSpan(r.startLine, r.endLine)}${r.status === 'ok' ? '' : ` (${r.status})`}`)
    .join('\n');
}

export type BadgeTitle = { title: string; rev: number };

/**
 * Per-target badge titles for one kind (node badges; edge suffixes, G51),
 * built once per table change. `rev` carries over from `prev` and bumps
 * when a target's title text changes, so the per-frame key stays O(targets)
 * and never compares title strings.
 */
export function buildBadgeTitles(
  index: ReadonlyMap<string, RefSummary[]>,
  prev: ReadonlyMap<bigint, BadgeTitle>,
  kind: 'node' | 'edge' = 'node'
): Map<bigint, BadgeTitle> {
  const out = new Map<bigint, BadgeTitle>();
  const prefix = `${kind}:`;
  for (const [key, refs] of index) {
    if (!key.startsWith(prefix)) {
      continue;
    }
    const id = BigInt(key.slice(prefix.length));
    const title = badgeTitle(refs);
    const old = prev.get(id);
    out.set(id, { title, rev: old === undefined ? 0 : old.title === title ? old.rev : old.rev + 1 });
  }
  return out;
}

type NodeBadge = { key: string; count: number; first: string; title: string; stale: number; ambiguous: number };
/** A node badge minus its size: everything that needs the ref list. */
export type NodeBadgeBase = Omit<NodeBadge, 'key'> & { rev: number };

function nodeBadgeBase(refs: RefSummary[], t: BadgeTitle): NodeBadgeBase {
  return { count: refs.length, first: firstOkSymbol(refs), title: t.title, rev: t.rev, ...statusCounts(refs) };
}

/** The per-frame half: the size-dependent key, no ref list (same key as refsKeyFor). */
export function sizedBadge(b: NodeBadgeBase, w: number, h: number): NodeBadge {
  const digest = b.stale + b.ambiguous > 0 ? `|s${b.stale}a${b.ambiguous}` : '';
  return {
    key: `${b.count}|${w}|${h}|${b.first}|${b.rev}${digest}`,
    count: b.count, first: b.first, title: b.title, stale: b.stale, ambiguous: b.ambiguous,
  };
}

/** Badge inputs for one node (structurally render.ts's RefBadge). */
export function badgeFor(refs: RefSummary[], w: number, h: number, t: BadgeTitle): NodeBadge {
  return sizedBadge(nodeBadgeBase(refs, t), w, h);
}

/** Every node's badge minus its size, built once per code-ref table change
 *  next to the titles, so a frame does no per-ref work. */
export function buildNodeBadges(
  index: ReadonlyMap<string, RefSummary[]>,
  titles: ReadonlyMap<bigint, BadgeTitle>
): Map<bigint, NodeBadgeBase> {
  const out = new Map<bigint, NodeBadgeBase>();
  for (const [id, t] of titles) {
    const refs = index.get(`node:${id}`);
    if (refs !== undefined && refs.length > 0) {
      out.set(id, nodeBadgeBase(refs, t));
    }
  }
  return out;
}

/** Suffix inputs for one edge (structurally render.ts's EdgeRefBadge): the
 *  count and the same <title> as a node badge, keyed on count, status and
 *  title revision. */
export function edgeBadgeFor(refs: RefSummary[], t: BadgeTitle): { key: string; count: number; title: string } {
  return { key: refsKeyFor(refs, 0, 0, t.rev), count: refs.length, title: t.title };
}

/** Every edge's suffix inputs, built once per code-ref table change next to
 *  the edge titles: the renderer looks up only the edges it draws, so a
 *  frame does no per-ref work. */
export function buildEdgeBadges(
  index: ReadonlyMap<string, RefSummary[]>,
  titles: ReadonlyMap<bigint, BadgeTitle>
): Map<bigint, { key: string; count: number; title: string }> {
  const out = new Map<bigint, { key: string; count: number; title: string }>();
  for (const [id, t] of titles) {
    const refs = index.get(`edge:${id}`);
    if (refs !== undefined && refs.length > 0) {
      out.set(id, edgeBadgeFor(refs, t));
    }
  }
  return out;
}

function strings(x: unknown): string[] {
  return Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string') : [];
}

function isGroup(x: unknown): x is { reason: string; paths?: unknown } {
  return typeof x === 'object' && x !== null && typeof (x as { reason?: unknown }).reason === 'string';
}

const EMPTY_COVERAGE = (): Coverage => ({ changed: 0, uncovered: [], excluded: [], deleted: [] });

/** Tolerant parser: anything malformed collapses to the empty coverage. */
export function parseCoverage(json: string): Coverage {
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return EMPTY_COVERAGE();
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    return EMPTY_COVERAGE();
  }
  const o = v as Record<string, unknown>;
  return {
    changed: typeof o.changed === 'number' && Number.isFinite(o.changed) ? o.changed : 0,
    uncovered: strings(o.uncovered),
    excluded: Array.isArray(o.excluded)
      ? o.excluded.filter(isGroup).map(g => ({ reason: g.reason, paths: strings(g.paths) }))
      : [],
    deleted: strings(o.deleted),
    ...(Array.isArray(o.unconfirmed) ? { unconfirmed: strings(o.unconfirmed) } : {}),
  };
}
