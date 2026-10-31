/**
 * board_stats — composition metrics for a board, callable outside the browser.
 *
 * Reports: node/edge counts, content bounding box + aspect ratio, occupied
 * fraction (sum of node areas / bbox area), largest empty rectangle inside the
 * bbox as a fraction of it, longest and mean edge length (center to center),
 * nodes per token, focal count.
 *
 * Usage:
 *   SPACETIME_URI=... SPACETIME_DB=... npm run stats -- --board <name> [--json]
 */
import { DbConnection } from './module_bindings/index';
import type { Node, Edge } from './module_bindings/types';
import { readTokenAt, saveTokenAt, tokenPathFor } from './identity';

const uri = process.env.SPACETIME_URI;
const db = process.env.SPACETIME_DB;
if (!uri) throw new Error('SPACETIME_URI is not set');
if (!db) throw new Error('SPACETIME_DB is not set');
const tokenPath = tokenPathFor(uri, process.env.SPACETIME_TOKEN_FILE);
const savedToken = readTokenAt(tokenPath);

const args = process.argv.slice(2);
const bi = args.indexOf('--board');
if (bi === -1 || bi + 1 >= args.length) throw new Error('missing --board <name>');
const boardName = args[bi + 1];
const asJson = args.includes('--json');

function fail(reason: string): never {
  console.error(`FATAL: ${reason}`);
  process.exit(1);
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Largest empty axis-aligned rectangle inside `bbox` avoiding all `obstacles`.
 * Coordinate-compressed grid + maximal-rectangle-in-histogram.
 */
function largestEmptyRect(bbox: Rect, obstacles: Rect[]): number {
  const xsSet = new Set<number>([bbox.x, bbox.x + bbox.w]);
  const ysSet = new Set<number>([bbox.y, bbox.y + bbox.h]);
  for (const o of obstacles) {
    xsSet.add(Math.max(bbox.x, o.x));
    xsSet.add(Math.min(bbox.x + bbox.w, o.x + o.w));
    ysSet.add(Math.max(bbox.y, o.y));
    ysSet.add(Math.min(bbox.y + bbox.h, o.y + o.h));
  }
  const xs = [...xsSet].sort((a, b) => a - b);
  const ys = [...ysSet].sort((a, b) => a - b);
  const cols = xs.length - 1;
  const rows = ys.length - 1;
  if (cols <= 0 || rows <= 0) return 0;

  // blocked[r][c] = cell (xs[c]..xs[c+1]) x (ys[r]..ys[r+1]) intersects an obstacle
  const blocked: boolean[][] = Array.from({ length: rows }, () => new Array(cols).fill(false));
  for (const o of obstacles) {
    const x0 = Math.max(bbox.x, o.x);
    const x1 = Math.min(bbox.x + bbox.w, o.x + o.w);
    const y0 = Math.max(bbox.y, o.y);
    const y1 = Math.min(bbox.y + bbox.h, o.y + o.h);
    if (x1 <= x0 || y1 <= y0) continue;
    for (let r = 0; r < rows; r++) {
      if (ys[r + 1] <= y0 || ys[r] >= y1) continue;
      for (let c = 0; c < cols; c++) {
        if (xs[c + 1] <= x0 || xs[c] >= x1) continue;
        blocked[r][c] = true;
      }
    }
  }

  // histogram sweep over variable-size cells
  let best = 0;
  const heights = new Array(cols).fill(0); // continuous height above current row bottom
  for (let r = 0; r < rows; r++) {
    const rowH = ys[r + 1] - ys[r];
    for (let c = 0; c < cols; c++) {
      heights[c] = blocked[r][c] ? 0 : heights[c] + rowH;
    }
    // maximal rectangle in histogram with variable column widths
    const stack: Array<{ start: number; height: number }> = [];
    for (let c = 0; c <= cols; c++) {
      const h = c < cols ? heights[c] : 0;
      let start = c;
      while (stack.length > 0 && stack[stack.length - 1].height > h) {
        const top = stack.pop()!;
        const width = xs[c] - xs[top.start];
        best = Math.max(best, width * top.height);
        start = top.start;
      }
      if (stack.length === 0 || stack[stack.length - 1].height < h) {
        stack.push({ start, height: h });
      }
    }
  }
  return best;
}

/** Area of the union of rects (coordinate-compressed grid). */
function unionArea(rects: Rect[]): number {
  if (rects.length === 0) return 0;
  const xs = [...new Set(rects.flatMap(r => [r.x, r.x + r.w]))].sort((a, b) => a - b);
  const ys = [...new Set(rects.flatMap(r => [r.y, r.y + r.h]))].sort((a, b) => a - b);
  let area = 0;
  for (let r = 0; r < ys.length - 1; r++) {
    for (let c = 0; c < xs.length - 1; c++) {
      const cx = (xs[c] + xs[c + 1]) / 2;
      const cy = (ys[r] + ys[r + 1]) / 2;
      if (rects.some(o => cx > o.x && cx < o.x + o.w && cy > o.y && cy < o.y + o.h)) {
        area += (xs[c + 1] - xs[c]) * (ys[r + 1] - ys[r]);
      }
    }
  }
  return area;
}

function computeStats(nodes: Node[], edges: Edge[]) {
  if (nodes.length === 0) {
    return { nodes: 0, edges: edges.length, note: 'empty board' };
  }
  const minX = Math.min(...nodes.map(n => n.x));
  const minY = Math.min(...nodes.map(n => n.y));
  const maxX = Math.max(...nodes.map(n => n.x + n.w));
  const maxY = Math.max(...nodes.map(n => n.y + n.h));
  const bbox: Rect = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  const bboxArea = bbox.w * bbox.h;

  const rects: Rect[] = nodes.map(n => ({ x: n.x, y: n.y, w: n.w, h: n.h }));
  // container-aware: overlapping area (a container behind its children) counts once
  const nodeArea = unionArea(rects);
  const emptyArea = largestEmptyRect(bbox, rects);

  const byId = new Map(nodes.map(n => [n.id, n]));
  const lengths: number[] = [];
  for (const e of edges) {
    const a = byId.get(e.fromNode);
    const b = byId.get(e.toNode);
    if (!a || !b) continue;
    const dx = a.x + a.w / 2 - (b.x + b.w / 2);
    const dy = a.y + a.h / 2 - (b.y + b.h / 2);
    lengths.push(Math.hypot(dx, dy));
  }

  const tokens: Record<string, number> = {};
  for (const n of nodes) {
    tokens[n.token] = (tokens[n.token] ?? 0) + 1;
  }

  return {
    nodes: nodes.length,
    edges: edges.length,
    bbox: { x: bbox.x, y: bbox.y, w: bbox.w, h: bbox.h },
    aspectRatio: +(bbox.w / bbox.h).toFixed(2),
    occupiedFraction: +(nodeArea / bboxArea).toFixed(3),
    largestEmptyRectFraction: +(emptyArea / bboxArea).toFixed(3),
    longestEdge: lengths.length > 0 ? Math.round(Math.max(...lengths)) : 0,
    meanEdge: lengths.length > 0 ? Math.round(lengths.reduce((s, l) => s + l, 0) / lengths.length) : 0,
    tokens,
    focal: nodes.filter(n => n.focal).length,
  };
}

DbConnection.builder()
  .withUri(uri)
  .withDatabaseName(db)
  .withToken(savedToken)
  .onConnect((conn: DbConnection, _identity, token) => {
    try {
      saveTokenAt(tokenPath, token, savedToken);
    } catch (error) {
      fail(`could not save anonymous identity: ${String(error)}`);
    }
    conn.subscriptionBuilder()
      .onApplied(() => {
        const board = [...conn.db.visibleBoard.iter()].find(b => b.name === boardName);
        if (!board) {
          fail(
            `no board named "${boardName}" -- available: ` +
              [...conn.db.visibleBoard.iter()].map(b => b.name).join(', ')
          );
        }
        const nodes = [...conn.db.visibleNode.iter()].filter(n => n.boardId === board.id);
        const edges = [...conn.db.visibleEdge.iter()].filter(e => e.boardId === board.id);
        // shown subgraph: what a reader actually sees — the headline metric
        const shownNodes = nodes.filter(n => !n.hidden);
        const visibleIds = new Set(shownNodes.map(n => n.id));
        const shownEdges = edges.filter(
          e => !e.hidden && visibleIds.has(e.fromNode) && visibleIds.has(e.toNode)
        );
        const sets = [...conn.db.visibleHideSet.iter()].filter(h => h.boardId === board.id);
        const setIds = new Set(sets.map(h => h.id));
        const members = [...conn.db.visibleHideSetMember.iter()].filter(m => setIds.has(m.setId));
        const nameOf = (targetKind: string, targetId: bigint) => {
          const mem = members.find(m => m.targetKind === targetKind && m.targetId === targetId);
          return mem ? sets.find(h => h.id === mem.setId)!.name : 'unsorted';
        };
        const hiddenBySet: Record<string, number> = {};
        for (const n of nodes.filter(n => n.hidden)) {
          const name = nameOf('node', n.id);
          hiddenBySet[name] = (hiddenBySet[name] ?? 0) + 1;
        }
        for (const e of edges.filter(e => e.hidden)) {
          const name = nameOf('edge', e.id);
          hiddenBySet[name] = (hiddenBySet[name] ?? 0) + 1;
        }
        const { unsorted: unsortedHidden = 0, ...namedSets } = hiddenBySet;
        const stats = {
          shown: computeStats(shownNodes, shownEdges),
          total: computeStats(nodes, edges),
          hiddenByNamedSet: namedSets,
          // unsorted hides are curation debt, not a category — reported apart
          unsortedHidden,
        };
        if (asJson) {
          console.log(JSON.stringify({ board: boardName, ...stats }));
        } else {
          console.log(`board_stats: ${boardName}`);
          console.log(JSON.stringify(stats, null, 2));
        }
        conn.disconnect();
        setTimeout(() => process.exit(0), 200);
      })
      .onError(ctx => fail(`subscription error: ${String(ctx.event)}`))
      .subscribeToAllTables();
  })
  .onConnectError((_ctx, err) => fail(`connection failed: ${String(err)}`))
  .build();
