/**
 * layout_board's engine: a layered left-to-right layout (elkjs) of the
 * visible board, containers (see containersOf) as compound nodes. Pure: rows in, grid-snapped
 * moves and boundary resizes out. Never imported by session/ids/results/
 * routes (mcp/src/bundle.test.ts pins their external imports).
 */
import ELK from 'elkjs/lib/elk.bundled.js';

export interface LayoutNode {
  id: bigint;
  kind: string;
  x: number;
  y: number;
  w: number;
  h: number;
  hidden: boolean;
}
export interface LayoutEdge {
  id: bigint;
  from: bigint;
  to: bigint;
  label: string;
  hidden: boolean;
}
export interface LayoutPlan {
  moves: Array<{ id: bigint; x: number; y: number }>;
  resizes: Array<{ id: bigint; x: number; y: number; w: number; h: number }>;
}

interface ElkIn {
  id: string;
  width?: number;
  height?: number;
  layoutOptions?: Record<string, string>;
  children?: ElkIn[];
  edges?: Array<{ id: string; sources: string[]; targets: string[]; labels?: Array<{ text: string; width: number; height: number }> }>;
}
interface ElkOut {
  id: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  children?: ElkOut[];
}

// ELK does not inherit spacing into child graphs, so boundaries repeat it.
const SPACING: Record<string, string> = {
  'elk.spacing.nodeNode': '48',
  'elk.layered.spacing.nodeNodeBetweenLayers': '96',
  'elk.layered.spacing.edgeNodeBetweenLayers': '24',
  'elk.spacing.edgeEdge': '16',
  'elk.layered.spacing.edgeEdgeBetweenLayers': '16',
};
const ROOT_OPTIONS: Record<string, string> = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
  ...SPACING,
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.edgeLabels.placement': 'CENTER',
  'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
};
const BOUNDARY_PADDING = '[top=48,left=24,bottom=24,right=24]';
const CHAR_PX = 7.3;

const snap = (v: number): number => Math.round(v / 4) * 4;
const floor4 = (v: number): number => Math.floor(v / 4) * 4;
const ceil4 = (v: number): number => Math.ceil(v / 4) * 4;
const byId = (a: { id: bigint }, b: { id: bigint }): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const contains = (b: LayoutNode, n: LayoutNode): boolean =>
  b.x <= n.x && b.y <= n.y && b.x + b.w >= n.x + n.w && b.y + b.h >= n.y + n.h;

/**
 * The client's container rule (render.ts containerIds): a boundary, or any node
 * fully containing another visible node. Unlike the client, the contained node
 * must be smaller, so a pile of same-size nodes is spread out, not grouped.
 */
export function containersOf(visible: LayoutNode[]): LayoutNode[] {
  // Charts never group: resizing one to fit members would break the server's chart minimum.
  return visible.filter(n => n.kind === 'boundary' || (n.kind !== 'chart' && visible.some(m => m.w * m.h < n.w * n.h && contains(n, m))));
}

export function parentOf(n: LayoutNode, boundaries: LayoutNode[]): LayoutNode | null {
  let best: LayoutNode | null = null;
  for (const b of boundaries) {
    if (b.id === n.id || !contains(b, n)) continue;
    const area = b.w * b.h;
    const own = n.w * n.h;
    if (area < own || (area === own && b.id > n.id)) continue;
    if (best === null || area < best.w * best.h || (area === best.w * best.h && b.id < best.id)) best = b;
  }
  return best;
}

export async function planLayout(nodes: LayoutNode[], edges: LayoutEdge[]): Promise<LayoutPlan> {
  const visible = nodes.filter(n => !n.hidden).sort(byId);
  if (visible.length === 0) return { moves: [], resizes: [] };
  const ids = new Set(visible.map(n => n.id));
  const boundaries = containersOf(visible);
  const parent = new Map<bigint, bigint | null>(visible.map(n => [n.id, parentOf(n, boundaries)?.id ?? null]));

  // A container with no members (a lone boundary) is laid out as a plain box of its own size
  // (ELK would shrink an empty compound node below the 64x48 minimum).
  const hasMembers = new Set([...parent.values()].filter((p): p is bigint => p !== null));
  const elkNodes = new Map<bigint, ElkIn>();
  for (const n of visible) {
    elkNodes.set(
      n.id,
      hasMembers.has(n.id)
        ? { id: String(n.id), layoutOptions: { ...SPACING, 'elk.padding': BOUNDARY_PADDING }, children: [] }
        : { id: String(n.id), width: n.w, height: n.h }
    );
  }
  const root: ElkIn = { id: 'root', layoutOptions: ROOT_OPTIONS, children: [], edges: [] };
  for (const n of visible) {
    const p = parent.get(n.id);
    (p == null ? root : elkNodes.get(p)!).children!.push(elkNodes.get(n.id)!);
  }
  for (const e of [...edges].sort(byId)) {
    if (e.hidden || e.from === e.to || !ids.has(e.from) || !ids.has(e.to)) continue;
    root.edges!.push({
      id: `e${e.id}`,
      sources: [String(e.from)],
      targets: [String(e.to)],
      ...(e.label.length > 0 ? { labels: [{ text: e.label, width: e.label.length * CHAR_PX + 8, height: 18 }] } : {}),
    });
  }

  const laid = (await new ELK().layout(root as never)) as unknown as ElkOut;
  const abs = new Map<bigint, { x: number; y: number; w: number; h: number }>();
  const walk = (n: ElkOut, ox: number, oy: number): void => {
    for (const c of n.children ?? []) {
      const x = ox + (c.x ?? 0);
      const y = oy + (c.y ?? 0);
      abs.set(BigInt(c.id), { x, y, w: c.width ?? 0, h: c.height ?? 0 });
      walk(c, x, y);
    }
  };
  walk(laid, 0, 0);

  const oldX = Math.min(...visible.map(n => n.x));
  const oldY = Math.min(...visible.map(n => n.y));
  const newX = Math.min(...[...abs.values()].map(r => r.x));
  const newY = Math.min(...[...abs.values()].map(r => r.y));
  const dx = snap(oldX - newX);
  const dy = snap(oldY - newY);

  const plan: LayoutPlan = { moves: [], resizes: [] };
  for (const n of visible) {
    const r = abs.get(n.id)!;
    if (hasMembers.has(n.id)) {
      const x = floor4(r.x + dx);
      const y = floor4(r.y + dy);
      const w = ceil4(r.x + dx + r.w) - x;
      const h = ceil4(r.y + dy + r.h) - y;
      if (x !== n.x || y !== n.y || w !== n.w || h !== n.h) plan.resizes.push({ id: n.id, x, y, w, h });
    } else {
      const x = snap(r.x + dx);
      const y = snap(r.y + dy);
      if (x !== n.x || y !== n.y) plan.moves.push({ id: n.id, x, y });
    }
  }
  return plan;
}
