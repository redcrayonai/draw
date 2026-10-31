/**
 * get_board on the hosted path: the board snapshot the retired stdio server
 * returned, built from the caller's views, within
 * 45,000 characters (Claude Code moves results over 50,000 to a file). Over
 * the cap it drops doc bodies first, then hidden rows, then nodes and edges
 * past the cap by id, and discloses each count under `omitted` (spec §4).
 */
import { noteSummaries, type NoteRow } from '../../agent/src/change-notes';
import { threatSummaries, type ThreatRow } from '../../agent/src/threats';
import { chartNodeSummary, type StoredChart } from '../../agent/src/charts';
import { routeSnapshot } from '../../agent/src/routes';
import type { SessionConn } from '../../agent/src/session';
import type { Database, SafeU64 } from './db';
import { sql } from './db';

export const BOARD_TEXT_MAX = 45_000;

type Row = Record<string, any>;
const iter = (rows: Row[]) => ({ iter: () => rows as never[] });

/** Every view get_board needs for one board, read in parallel (a Worker keeps 6 open and queues the rest). */
export async function readBoard(db: Database, board: SafeU64, signal?: AbortSignal) {
  const [boards, nodes, edges, hideSets, members, refs, sessions, routes, events, charts, versions, notes, threats, icons] = await Promise.all([
    db.read<Row>(sql`SELECT * FROM visible_board WHERE id = ${board}`, signal),
    db.read<Row>(sql`SELECT * FROM visible_node WHERE board_id = ${board}`, signal),
    db.read<Row>(sql`SELECT * FROM visible_edge WHERE board_id = ${board}`, signal),
    db.read<Row>(sql`SELECT * FROM visible_hide_set WHERE board_id = ${board}`, signal),
    // hide_set_member has no board column: every readable member, filtered by this board's sets below
    db.read<Row>(sql`SELECT * FROM visible_hide_set_member`, signal),
    db.read<Row>(sql`SELECT * FROM visible_code_ref WHERE board_id = ${board}`, signal),
    db.read<Row>(sql`SELECT * FROM visible_session WHERE board_id = ${board}`, signal),
    db.read<Row>(sql`SELECT * FROM visible_session_route WHERE board_id = ${board}`, signal),
    db.read<Row>(sql`SELECT * FROM visible_route_event WHERE board_id = ${board}`, signal),
    db.read<Row>(sql`SELECT * FROM visible_chart WHERE board_id = ${board}`, signal),
    db.read<Row>(sql`SELECT * FROM visible_architecture_version WHERE board_id = ${board}`, signal),
    db.read<Row>(sql`SELECT * FROM visible_change_note WHERE board_id = ${board}`, signal),
    // members only: a visitor's view has no rows
    db.read<Row>(sql`SELECT * FROM visible_threat WHERE board_id = ${board}`, signal),
    db.read<Row>(sql`SELECT * FROM visible_node_icon WHERE board_id = ${board}`, signal),
  ]);
  const version = versions[0] as Row | undefined;
  // A branch names its base; a fact snapshot names its commit.
  const [baseBoard] = version?.assertionMode === 'intent' ? await db.read<Row>(sql`SELECT * FROM visible_board WHERE id = ${version.baseBoardId as SafeU64}`, signal) : [];
  const setIds = new Set(hideSets.map(h => h.id));
  return {
    board: boards[0] as Row | undefined,
    nodes,
    edges,
    hideSets,
    members: members.filter(m => setIds.has(m.setId)),
    refs,
    session: sessions[0] as Row | undefined,
    routes,
    events,
    charts,
    version,
    ...(baseBoard ? { baseName: baseBoard.name as string } : {}),
    notes,
    threats,
    icons,
  };
}

export type BoardRows = Awaited<ReturnType<typeof readBoard>>;

const byId = (a: Row, b: Row) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The snapshot JSON, capped. `rows.board` must be present. */
export function boardText(rows: BoardRows, boardId: bigint, max = BOARD_TEXT_MAX): string {
  const { hideSets, members } = rows;
  const setName = (targetKind: string, targetId: bigint) => {
    const mem = members.find(m => m.targetKind === targetKind && m.targetId === targetId);
    return mem ? hideSets.find(h => h.id === mem.setId)?.name ?? 'unsorted' : 'unsorted';
  };
  let coverage: unknown = {};
  if (rows.session) {
    try {
      coverage = JSON.parse(rows.session.coverage);
    } catch {
      coverage = {};
    }
  }
  const refsFor = (kind: 'node' | 'edge', targetId: bigint) =>
    rows.refs
      .filter(r => r.targetKind === kind && r.targetId === targetId)
      .map(r => ({ id: r.id.toString(), symbol: r.symbol, path: r.path, startLine: r.startLine, endLine: r.endLine, checkpoint: r.checkpoint, status: r.status }));
  const charts = new Map(rows.charts.map(c => [c.nodeId, c]));
  const icons = new Map(rows.icons.map(i => [i.nodeId, i.icon as string]));
  // routeSnapshot reads the SDK cache's shape; the views give the same rows.
  const conn = { db: { visibleSessionRoute: iter(rows.routes), visibleRouteEvent: iter(rows.events), visibleNode: iter(rows.nodes) } } as unknown as SessionConn;

  const node = (n: Row, docs: boolean) => ({
    id: n.id.toString(),
    label: n.label,
    sublabel: n.sublabel,
    x: n.x,
    y: n.y,
    w: n.w,
    h: n.h,
    token: n.token,
    focal: n.focal,
    kind: n.kind,
    sourceKey: n.sourceKey,
    hidden: n.hidden,
    hideSet: n.hidden ? setName('node', n.id) : undefined,
    doc: docs ? (n.doc.length > 240 ? n.doc.slice(0, 240) + '...' : n.doc) : undefined,
    refs: refsFor('node', n.id),
    chart: n.kind === 'chart' ? chartNodeSummary(charts.get(n.id) as StoredChart | undefined) : undefined,
    icon: icons.get(n.id),
  });
  const edge = (e: Row) => ({
    id: e.id.toString(),
    from: e.fromNode.toString(),
    to: e.toNode.toString(),
    label: e.label,
    evidence: e.evidence,
    relation: e.relation,
    evidenceStatus: e.evidence.startsWith('source:') ? e.evidenceStatus || 'stale' : e.evidenceStatus,
    latencyMs: e.latencyMs < 0 ? undefined : e.latencyMs,
    latencySource: e.latencyMs < 0 ? undefined : e.latencySource,
    hidden: e.hidden,
    hideSet: e.hidden ? setName('edge', e.id) : undefined,
    refs: refsFor('edge', e.id),
  });

  const v = rows.version;
  const head = {
    board: rows.board!.name,
    architecture: v
      ? v.assertionMode === 'intent'
        ? { assertionMode: v.assertionMode, status: v.status, baseBoardId: v.baseBoardId.toString(), base: rows.baseName ?? '', ...(v.historyId === 0n ? {} : { ref: v.ref, sha: v.sha }) }
        : { assertionMode: v.assertionMode, status: v.status, baseBoardId: v.baseBoardId.toString(), ref: v.ref, sha: v.sha }
      : undefined,
    session: rows.session ? { checkpoint: rows.session.checkpoint, headSha: rows.session.headSha, coverage } : undefined,
    route: rows.session ? routeSnapshot(conn, boardId) : undefined,
    hideSets: hideSets.map(h => h.name),
    changeNotes: noteSummaries(rows.notes as NoteRow[]),
    threats: threatSummaries(rows.threats as ThreatRow[]),
  };
  const nodes = [...rows.nodes].sort(byId);
  const edges = [...rows.edges].sort(byId);
  let top: Record<string, unknown> = head;
  const render = (ns: Row[], es: Row[], docs: boolean, omitted?: Record<string, number>) =>
    JSON.stringify({ ...top, nodes: ns.map(n => node(n, docs)), edges: es.map(edge), ...(omitted ? { omitted } : {}) }, null, 1);

  let text = render(nodes, edges, true);
  if (text.length <= max) return text;
  const docs = nodes.filter(n => n.doc).length;
  text = render(nodes, edges, false, { docs });
  if (text.length <= max) return text;
  const shownNodes = nodes.filter(n => !n.hidden);
  const shownEdges = edges.filter(e => !e.hidden);
  // The header's lists grow with the change, not the board: cap them too, or no node trimming could fit.
  let limit = HEAD_LIST_MAX;
  let capped = capHead(head, limit);
  const headSize = () => JSON.stringify({ ...capped.head, omitted: capped.omitted }, null, 1).length;
  // Reserve room for the graph; entry counts alone cannot bound long paths or nested lists.
  while (headSize() > max / 2 && limit > 0) {
    limit = Math.floor(limit / 2);
    capped = capHead(head, limit);
  }
  // Coverage is opaque agent-written JSON, so even a header with no lists can be oversized.
  for (const key of ['session', 'route', 'architecture', 'board']) {
    if (headSize() <= max / 2) break;
    if (capped.head[key] === undefined) continue;
    delete capped.head[key];
    capped.omitted[`${key}Header`] = 1;
  }
  top = capped.head;
  const omitted = { docs, hiddenNodes: nodes.length - shownNodes.length, hiddenEdges: edges.length - shownEdges.length, ...capped.omitted, nodes: 0, edges: 0 };
  text = render(shownNodes, shownEdges, false, omitted);
  // Past that, keep the lowest ids that fit: edges go first, then nodes.
  let ns = shownNodes;
  let es = shownEdges;
  while (text.length > max && (es.length > 0 || ns.length > 0)) {
    const over = text.length - max;
    const cut = (list: Row[]) => Math.max(1, Math.ceil((list.length * over) / text.length));
    if (es.length > 0) es = es.slice(0, es.length - cut(es));
    else ns = ns.slice(0, ns.length - cut(ns));
    text = render(ns, es, false, { ...omitted, nodes: shownNodes.length - ns.length, edges: shownEdges.length - es.length });
  }
  return text;
}

const HEAD_LIST_MAX = 100;

/** Bound every growing header list, including nested paths and history node IDs. */
function capHead(head: Record<string, any>, limit: number): { head: Record<string, unknown>; omitted: Record<string, number> } {
  const omitted: Record<string, number> = {};
  const cut = <X>(list: X[] | undefined, key: string, keepLast = false): X[] | undefined => {
    if (!Array.isArray(list) || list.length <= limit) return list;
    omitted[key] = (omitted[key] ?? 0) + list.length - limit;
    return limit === 0 ? [] : keepLast ? list.slice(-limit) : list.slice(0, limit);
  };
  const out: Record<string, any> = { ...head, hideSets: cut(head.hideSets, 'hideSets') };
  const coverage = head.session?.coverage;
  if (coverage && typeof coverage === 'object') {
    const excluded = Array.isArray(coverage.excluded)
      ? cut(coverage.excluded, 'excludedGroups')!.map((g: any) => ({ ...g, paths: cut(g.paths, 'excludedPaths') }))
      : coverage.excluded;
    if (Array.isArray(coverage.excluded)) {
      const pathCount = (groups: any[]) => groups.reduce((n, g) => n + (Array.isArray(g.paths) ? g.paths.length : 0), 0);
      const excludedPaths = pathCount(coverage.excluded) - pathCount(excluded);
      if (excludedPaths) omitted.excludedPaths = excludedPaths;
    }
    out.session = { ...head.session, coverage: { ...coverage, uncovered: cut(coverage.uncovered, 'uncovered'), deleted: cut(coverage.deleted, 'deleted'), excluded } };
  }
  if (head.route) {
    const history = cut(head.route.history, 'routeHistory', true)?.map((e: any) => ({ ...e, nodeIds: cut(e.nodeIds, 'routeNodeIds') }));
    const nodeIdCount = (events: any[]) => events.reduce((n, e) => n + e.nodeIds.length, 0);
    const routeNodeIds = nodeIdCount(head.route.history) - nodeIdCount(history ?? []);
    if (routeNodeIds) omitted.routeNodeIds = routeNodeIds;
    out.route = { ...head.route, waypoints: cut(head.route.waypoints, 'routeWaypoints'), history };
  }
  return { head: out, omitted };
}
