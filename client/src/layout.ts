/**
 * Pure layout math for the command palette's arrange commands.
 *
 * Deliberately structural (Box, not Node) and side-effect free so the geometry
 * is unit-testable without a DOM, a connection, or a board.
 */

export interface Box {
  id: bigint;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A move the caller can hand straight to ops.moveNodesAction(). */
export interface Placement {
  nodeId: bigint;
  from: { x: number; y: number };
  to: { x: number; y: number };
}

/** The board's placement grid; drags already snap to it. */
export const GRID = 8;

export function snap(v: number, grid: number = GRID): number {
  return Math.round(v / grid) * grid;
}

function byId(a: Box, b: Box): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Top-to-bottom in horizontal bands, left-to-right inside a band. Nodes a
 * human reads as "the same row" rarely share an exact y, so rows are bucketed.
 */
export function readingOrder(boxes: Box[], band: number = 40): Box[] {
  return [...boxes].sort((a, b) => {
    const ra = Math.floor(a.y / band);
    const rb = Math.floor(b.y / band);
    if (ra !== rb) {
      return ra - rb;
    }
    if (a.x !== b.x) {
      return a.x - b.x;
    }
    return byId(a, b);
  });
}

export interface TidyPlan {
  cols: number;
  rows: number;
  cellW: number;
  cellH: number;
  gap: number;
  placements: Placement[];
}

/**
 * Pack the selection into the squarest grid that holds it, on a uniform cell
 * sized to the largest member, anchored at the selection's top-left.
 */
export function tidyGrid(boxes: Box[], gap: number = 48): TidyPlan {
  const ordered = readingOrder(boxes);
  if (ordered.length === 0) {
    return { cols: 0, rows: 0, cellW: 0, cellH: 0, gap, placements: [] };
  }
  const cols = Math.ceil(Math.sqrt(ordered.length));
  const rows = Math.ceil(ordered.length / cols);
  const cellW = Math.max(...ordered.map(b => b.w));
  const cellH = Math.max(...ordered.map(b => b.h));
  const originX = snap(Math.min(...ordered.map(b => b.x)));
  const originY = snap(Math.min(...ordered.map(b => b.y)));

  const placements: Placement[] = [];
  ordered.forEach((b, i) => {
    const to = {
      x: originX + (i % cols) * (cellW + gap),
      y: originY + Math.floor(i / cols) * (cellH + gap),
    };
    // Only emit real moves: a no-op move would still cost a reducer call and
    // a history entry.
    if (to.x !== b.x || to.y !== b.y) {
      placements.push({ nodeId: b.id, from: { x: b.x, y: b.y }, to });
    }
  });
  return { cols, rows, cellW, cellH, gap, placements };
}

/**
 * Equalise horizontal gaps, holding the leftmost and rightmost edges. Fewer
 * than three boxes have no interior gap to equalise.
 */
export function distributeHorizontally(boxes: Box[]): Placement[] {
  if (boxes.length < 3) {
    return [];
  }
  const ordered = [...boxes].sort((a, b) => (a.x !== b.x ? a.x - b.x : byId(a, b)));
  const last = ordered[ordered.length - 1];
  const span = last.x + last.w - ordered[0].x;
  const occupied = ordered.reduce((sum, b) => sum + b.w, 0);
  const gap = (span - occupied) / (ordered.length - 1);

  // Only the interior moves. Snapping an accumulated fractional cursor used to
  // shift the last box too, which contradicted holding the outer edges.
  const placements: Placement[] = [];
  let cursor = ordered[0].x + ordered[0].w + gap;
  for (let i = 1; i < ordered.length - 1; i++) {
    const b = ordered[i];
    const x = snap(cursor);
    if (x !== b.x) {
      placements.push({ nodeId: b.id, from: { x: b.x, y: b.y }, to: { x, y: b.y } });
    }
    cursor += b.w + gap;
  }
  return placements;
}

/** Edges to create so the selection reads as a flow, in reading order. */
export function connectInOrder(boxes: Box[]): Array<{ from: bigint; to: bigint }> {
  const ordered = readingOrder(boxes);
  const pairs: Array<{ from: bigint; to: bigint }> = [];
  for (let i = 0; i < ordered.length - 1; i++) {
    pairs.push({ from: ordered[i].id, to: ordered[i + 1].id });
  }
  return pairs;
}
