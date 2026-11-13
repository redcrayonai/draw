// Stepping inside a node: one board read at several depths. A node that has other nodes drawn
// inside its rectangle is a frame; stepping into it frames the view on it and dims the rest of
// the board. Nothing is stored: depth follows where the nodes are drawn.

export interface Box { id: bigint; x: number; y: number; w: number; h: number }

/** `a` holds `b`: b lies within a's rectangle. Two nodes on the same rectangle nest by id, so holding never goes both ways. */
export function holds(a: Box, b: Box): boolean {
  if (a.id === b.id || a.x > b.x || a.y > b.y || a.x + a.w < b.x + b.w || a.y + a.h < b.y + b.h) return false;
  return a.w * a.h > b.w * b.h || a.id < b.id;
}

/** The nodes drawn inside `frame`. */
export function within<T extends Box>(frame: Box, nodes: readonly T[]): T[] {
  return nodes.filter(node => holds(frame, node));
}

/** A node one can step into: something is drawn inside it. */
export function isFrame(node: Box, nodes: readonly Box[]): boolean {
  return nodes.some(other => holds(node, other));
}

/** The frames `node` is drawn inside, outermost first: the way back up. */
export function framesAround<T extends Box>(node: Box, nodes: readonly T[]): T[] {
  return nodes.filter(other => holds(other, node)).sort((a, b) => b.w * b.h - a.w * a.h || (a.id < b.id ? -1 : 1));
}

/**
 * Where the view is after the board changed under it: the frame it was in, or the nearest frame
 * around it that is still one (its node deleted, hidden, or emptied), or null for the whole board.
 * `trail` is the path stepped down, outermost first.
 */
export function surviving(trail: readonly bigint[], nodes: readonly Box[]): bigint | null {
  const byId = new Map(nodes.map(node => [node.id, node]));
  for (let i = trail.length - 1; i >= 0; i--) {
    const node = byId.get(trail[i]);
    if (node && isFrame(node, nodes)) return node.id;
  }
  return null;
}
