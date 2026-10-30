import type { Chart, Edge, Node } from './module_bindings/types';
import type { ChartFields } from './ops';
import type { TemplatePick } from './library-popover';
import {
  ARCHITECTURE_CHART_RULE,
  CHART_CONTRACTS,
  CHART_TYPES,
  SAMPLE_SOURCE,
  isChartType,
  parseChart,
  type ChartType,
} from '../../module/src/chart-contracts';
import { ARCHITECTURE_ICON_RULE, ICON_NODE_H, ICON_NODE_KINDS, ICON_NODE_W, iconSpec, isIconId } from '../../module/src/node-icons';
import type { NodeFields } from './ops';

/**
 * A saved library item (spec "Library popover"). Coordinates are relative to
 * the group's top-left. Focal, hidden, imported, source keys, edge evidence,
 * edge relations and code refs are never part of it: the inserter makes the
 * claims on the new board. A chart's source does copy: the data's origin
 * does not change.
 */
export interface LibraryNodeV1 {
  key: number;
  label: string;
  sublabel: string;
  x: number;
  y: number;
  w: number;
  h: number;
  token: string;
  kind: string;
  doc: string;
  shape: string;
  color: string;
  strokeStyle: string;
  size: string;
  chart?: { type: string; csv: string; options: string; source: string };
  /** The node's library icon (spec 2026-10-18); absent means none. Still version 1. */
  icon?: string;
}

export interface LibraryEdgeV1 {
  from: number;
  to: number;
  label: string;
  color: string;
  strokeStyle: string;
  /** RC-688: present only for medium or bold; items saved before it have none. */
  weight?: string;
}

export interface LibraryPayloadV1 {
  version: 1;
  nodes: LibraryNodeV1[];
  edges: LibraryEdgeV1[];
}

/** The kinds a saved item may hold: the six node kinds plus chart. */
const LIBRARY_KINDS = ['service', 'datastore', 'external', 'boundary', 'note', 'text', 'chart'];
const NODE_INTS = ['key', 'x', 'y', 'w', 'h'] as const;
const NODE_STRINGS = ['label', 'sublabel', 'token', 'kind', 'doc', 'shape', 'color', 'strokeStyle', 'size'] as const;
const CHART_STRINGS = ['type', 'csv', 'options', 'source'] as const;
const EDGE_INTS = ['from', 'to'] as const;
const EDGE_STRINGS = ['label', 'color', 'strokeStyle'] as const;

/** A chart placed from the library: 88 × 56 grid cells, above the 224 × 144 minimum. */
const SAMPLE_W = 352;
const SAMPLE_H = 224;
/**
 * Examples that need more room; render.test.ts pins each one. The
 * waterfall's 7 spans, ms axis and legend need 24 px more: the smallest
 * height that cuts no span. The schedule needs the width to label every
 * item. The kanban needs both to show every card with its detail line.
 */
const SAMPLE_SIZES: Partial<Record<ChartType, { w: number; h: number }>> = {
  waterfall: { w: SAMPLE_W, h: 248 },
  schedule: { w: 448, h: SAMPLE_H },
  kanban: { w: 448, h: 260 },
};

/** Shown when a chart's row has not arrived: without it, undo could not
 *  recreate the chart, and a saved item would hold the node without its data. */
export const CHART_NOT_LOADED = 'chart data has not loaded yet; try again in a moment';

/**
 * Client-side refusal for ⇧L: a selected chart whose row has not arrived
 * would be dropped by buildLibraryPayload, and the item would be saved
 * without it. Refuse instead, as deleteNodesAction does, so nothing is
 * stored half-copied and no one is asked to name an item first.
 */
export function saveRefusal(nodes: Node[], chartOf: (nodeId: bigint) => Chart | undefined): string | null {
  return nodes.some(n => n.kind === 'chart' && chartOf(n.id) === undefined) ? CHART_NOT_LOADED : null;
}

/**
 * The visible selection as a payload. Keys are 0..n-1 in the given order;
 * only edges with both ends selected are kept. A chart whose row has not
 * arrived has no data to save, so it is left out with its edges — callers
 * that save on a person's behalf check saveRefusal first.
 */
export function buildLibraryPayload(
  nodes: Node[],
  edges: Edge[],
  chartOf: (nodeId: bigint) => Chart | undefined,
  weightOf: (edgeId: bigint) => string = () => 'regular',
  iconOf: (nodeId: bigint) => string | undefined = () => undefined
): LibraryPayloadV1 {
  const kept = nodes.filter(n => n.kind !== 'chart' || chartOf(n.id) !== undefined);
  const minX = Math.min(...kept.map(n => n.x));
  const minY = Math.min(...kept.map(n => n.y));
  const keys = new Map<bigint, number>();
  const out = kept.map((n, key): LibraryNodeV1 => {
    keys.set(n.id, key);
    const node: LibraryNodeV1 = {
      key,
      label: n.label,
      sublabel: n.sublabel,
      x: n.x - minX,
      y: n.y - minY,
      w: n.w,
      h: n.h,
      token: n.token,
      kind: n.kind,
      doc: n.doc,
      shape: n.shape,
      color: n.color,
      strokeStyle: n.strokeStyle,
      size: n.size,
    };
    const row = n.kind === 'chart' ? chartOf(n.id) : undefined;
    if (row) {
      node.chart = { type: row.type, csv: row.csv, options: row.options, source: row.source };
    }
    // Only a kind that shows an icon carries one, as the parser requires.
    const icon = ICON_NODE_KINDS.includes(n.kind) ? iconOf(n.id) : undefined;
    if (icon) {
      node.icon = icon;
    }
    return node;
  });
  const links: LibraryEdgeV1[] = [];
  for (const e of edges) {
    const from = keys.get(e.fromNode);
    const to = keys.get(e.toNode);
    if (from !== undefined && to !== undefined) {
      const weight = weightOf(e.id);
      links.push({ from, to, label: e.label, color: e.color, strokeStyle: e.strokeStyle, ...(weight === 'regular' ? {} : { weight }) });
    }
  }
  return { version: 1, nodes: out, edges: links };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

type Parsed = { ok: true; payload: LibraryPayloadV1 } | { ok: false; error: string };
const fail = (error: string): Parsed => ({ ok: false, error });

/** Check a stored payload before it is drawn or inserted. Every failure is
 *  one sentence that names the field; the result holds known fields only. */
export function parseLibraryPayload(text: string): Parsed {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return fail('library item is not valid JSON');
  }
  if (!isObject(raw) || raw.version !== 1) {
    return fail('library item payload must be a JSON object with version 1');
  }
  if (!Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) {
    return fail('library item must have a nodes array and an edges array');
  }
  if (raw.nodes.length === 0) {
    return fail('library item has no nodes');
  }
  const nodes: LibraryNodeV1[] = [];
  const keys = new Set<number>();
  for (let i = 0; i < raw.nodes.length; i++) {
    const n: unknown = raw.nodes[i];
    const at = `library item nodes[${i}]`;
    if (!isObject(n)) return fail(`${at} must be an object`);
    for (const f of NODE_INTS) if (!Number.isInteger(n[f])) return fail(`${at}.${f} must be an integer`);
    for (const f of NODE_STRINGS) if (typeof n[f] !== 'string') return fail(`${at}.${f} must be a string`);
    const kind = n.kind as string;
    if (!LIBRARY_KINDS.includes(kind)) {
      return fail(`${at}.kind '${kind}' is not one of ${LIBRARY_KINDS.join(', ')}`);
    }
    const key = n.key as number;
    if (keys.has(key)) return fail(`${at}.key ${key} is used twice`);
    keys.add(key);
    const node: LibraryNodeV1 = {
      key,
      label: n.label as string,
      sublabel: n.sublabel as string,
      x: n.x as number,
      y: n.y as number,
      w: n.w as number,
      h: n.h as number,
      token: n.token as string,
      kind,
      doc: n.doc as string,
      shape: n.shape as string,
      color: n.color as string,
      strokeStyle: n.strokeStyle as string,
      size: n.size as string,
    };
    if (kind === 'chart') {
      const c: unknown = n.chart;
      if (!isObject(c) || CHART_STRINGS.some(f => typeof c[f] !== 'string')) {
        return fail(`${at}.chart must hold type, csv, options and source strings`);
      }
      const type = c.type as string;
      if (!isChartType(type)) {
        return fail(`${at}.chart.type '${type}' is not one of ${CHART_TYPES.join(', ')}`);
      }
      node.chart = { type, csv: c.csv as string, options: c.options as string, source: c.source as string };
      // Saved before a stricter rule? Refuse the whole item before anything is written.
      const check = parseChart(type, node.chart.csv, node.chart.options);
      if (!check.ok) return fail(`library item chart "${node.label}": ${check.error}`);
    }
    if (n.icon !== undefined) {
      // An id withdrawn since the item was saved refuses the item, as an unknown kind does.
      if (typeof n.icon !== 'string' || !isIconId(n.icon)) return fail(`${at}.icon '${String(n.icon)}' is not a library icon`);
      if (!ICON_NODE_KINDS.includes(kind)) return fail(`${at}.icon is set on a ${kind} node`);
      node.icon = n.icon;
    }
    nodes.push(node);
  }
  const edges: LibraryEdgeV1[] = [];
  for (let i = 0; i < raw.edges.length; i++) {
    const e: unknown = raw.edges[i];
    const at = `library item edges[${i}]`;
    if (!isObject(e)) return fail(`${at} must be an object`);
    for (const f of EDGE_INTS) if (!Number.isInteger(e[f])) return fail(`${at}.${f} must be an integer`);
    for (const f of EDGE_STRINGS) if (typeof e[f] !== 'string') return fail(`${at}.${f} must be a string`);
    if (e.weight !== undefined && typeof e.weight !== 'string') return fail(`${at}.weight must be a string`);
    for (const f of EDGE_INTS) {
      if (!keys.has(e[f] as number)) return fail(`${at}.${f} ${e[f] as number} is not a node key in this item`);
    }
    edges.push({
      from: e.from as number,
      to: e.to as number,
      label: e.label as string,
      color: e.color as string,
      strokeStyle: e.strokeStyle as string,
      ...(e.weight === undefined ? {} : { weight: e.weight as string }),
    });
  }
  return { ok: true, payload: { version: 1, nodes, edges } };
}

/** A chart tile's placement: the contract's example with source 'sample'. */
export function samplePlacement(type: ChartType): Omit<ChartFields, 'boardId' | 'x' | 'y'> {
  const c = CHART_CONTRACTS[type];
  return {
    label: c.title,
    sublabel: '',
    w: SAMPLE_SIZES[type]?.w ?? SAMPLE_W,
    h: SAMPLE_SIZES[type]?.h ?? SAMPLE_H,
    type,
    csv: c.example,
    options: '{}',
    source: SAMPLE_SOURCE,
  };
}

/** An icon tile's placement (spec 2026-10-18 D5): a 160 × 96 node of the
 *  icon's kind, labelled with its name, with the icon attached. */
export function iconNodePlacement(icon: string): Omit<NodeFields, 'boardId' | 'x' | 'y'> {
  const spec = iconSpec(icon);
  if (spec === undefined) throw new Error(`icon '${icon}' is not a library icon`);
  return { label: spec.name, sublabel: '', w: ICON_NODE_W, h: ICON_NODE_H, token: 'ink', focal: false, kind: spec.kind, icon: spec.id };
}

/**
 * Client-side refusal for a library placement (spec "Library popover"): a
 * chart tile, or a saved item that holds a chart, is refused on an
 * architecture board with the module's own sentence, and so is an icon tile
 * or a saved item that holds an icon (spec 2026-10-18 D12). `payload` is the
 * parsed saved item (null for a tile). Factual boards are refused earlier,
 * by the Editor, with READ_ONLY_HINT.
 */
export function insertRefusal(
  pick: TemplatePick,
  payload: LibraryPayloadV1 | null,
  onArchitectureBoard: boolean
): string | null {
  if (!onArchitectureBoard) {
    return null;
  }
  const holdsChart = pick.kind === 'chart' || (payload?.nodes.some(n => n.kind === 'chart') ?? false);
  if (holdsChart) {
    return ARCHITECTURE_CHART_RULE;
  }
  const holdsIcon = pick.kind === 'icon' || (payload?.nodes.some(n => n.icon !== undefined) ?? false);
  return holdsIcon ? ARCHITECTURE_ICON_RULE : null;
}
