// Blast radius: a breadth-first walk over the drawn edges from a threatened node.
// Pure; rebuilt when the card opens or its options change, never per frame.
import type { Edge } from './module_bindings/types';

export type Direction = 'reaches' | 'trusts' | 'both';
export type Depth = 1 | 2 | 3 | 'all';
export interface BlastNode { hop: number; why: string; viaEdge: bigint }
export interface Blast {
  source: bigint;
  nodes: Map<bigint, BlastNode>;
  /** edge id -> hop of the node it reached */
  edges: Map<bigint, number>;
  /** nodes that are not the source and not reached, in input order */
  clear: bigint[];
}

export function blastRadius(
  source: bigint,
  nodeIds: readonly bigint[],
  edges: readonly Pick<Edge, 'id' | 'fromNode' | 'toNode' | 'label'>[],
  labelOf: (id: bigint) => string,
  opts: { direction: Direction; depth: Depth },
): Blast {
  // adjacency: node -> [edge, neighbour] steps allowed by the direction
  const adj = new Map<bigint, { e: (typeof edges)[number]; to: bigint }[]>();
  const add = (from: bigint, to: bigint, e: (typeof edges)[number]) => {
    const l = adj.get(from);
    if (l) l.push({ e, to }); else adj.set(from, [{ e, to }]);
  };
  const walkable = new Set(nodeIds).add(source);
  for (const e of edges) {
    if (e.fromNode === e.toNode || !walkable.has(e.fromNode) || !walkable.has(e.toNode)) continue;
    if (opts.direction !== 'trusts') add(e.fromNode, e.toNode, e);
    if (opts.direction !== 'reaches') add(e.toNode, e.fromNode, e);
  }
  const max = opts.depth === 'all' ? Infinity : opts.depth;
  const nodes = new Map<bigint, BlastNode>();
  const used = new Map<bigint, number>();
  let level = [source];
  for (let hop = 1; hop <= max && level.length > 0; hop++) {
    const next: bigint[] = [];
    for (const u of level) {
      for (const { e, to } of adj.get(u) ?? []) {
        if (to === source) continue;
        const seen = nodes.get(to);
        if (seen === undefined) {
          const why = hop === 1 ? (e.label !== '' ? e.label : e.fromNode === source ? 'calls' : 'trusts it') : `via ${labelOf(u)}`;
          nodes.set(to, { hop, why, viaEdge: e.id });
          used.set(e.id, hop);
          next.push(to);
        } else if (seen.hop === hop) used.set(e.id, hop); // parallel route at the same hop
      }
    }
    level = next;
  }
  return { source, nodes, edges: used, clear: nodeIds.filter(id => id !== source && !nodes.has(id)) };
}
