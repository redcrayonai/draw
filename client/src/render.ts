import type { Node, Edge, Chart } from './module_bindings/types';
import { symbolNeedle } from './refs';
import { sizeTextCache, textEpoch, textWidth } from './node-text';
import { drawTextBlock } from './text-block';
import { layoutNodeText, ellipsize, labelFontSize, labelLineHeight, BADGE_GAP, BOUNDARY_ICON, iconPlacement, type NodeTextLayout } from './node-layout';
import { drawableIcon, iconGroup } from './node-icons';
import { renderPlot, parsedChart } from './charts/index';
import { SAMPLE_SOURCE } from '../../module/src/chart-contracts';
import type { RouteMarker } from './route';
import { routeEdges, placeLabels, type Route } from './edge-route';
import { SCHEMA_FOOT_H, SCHEMA_HEAD_H, SCHEMA_ROW_H, schemaRows, type Schema, type SchemaColumn } from '../../module/src/change-notes';
import { mergedSchema, type NoteIndex, type NoteView } from './change-notes-view';
import { makeHopBadge, makeMarker, markerKey, type MarkerSpec } from './board-marker';
import type { Blast } from './blast';
import { blastEdgeIds } from './blast-play';

const SVG_NS = 'http://www.w3.org/2000/svg';

// Note bodies wrap via measured tspans (foreignObject would vanish in
// exported SVGs opened outside a browser).
const NOTE_FONT = "400 14px 'Geist', system-ui, sans-serif";
const NOTE_LINE_HEIGHT = 21;
let measureCtx: CanvasRenderingContext2D | null = null;

function wrapText(text: string, maxWidth: number): string[] {
  if (!measureCtx) {
    measureCtx = document.createElement('canvas').getContext('2d');
  }
  const ctx = measureCtx;
  if (!ctx) {
    return [text];
  }
  ctx.font = NOTE_FONT;
  const lines: string[] = [];
  let line = '';
  const pushWord = (word: string) => {
    let candidate = line.length > 0 ? `${line} ${word}` : word;
    if (line.length > 0 && ctx.measureText(candidate).width > maxWidth) {
      lines.push(line);
      line = '';
      candidate = word;
    }
    // A single word wider than the note breaks mid-word so it never
    // overflows the bounds (long URLs, identifiers, hashes).
    if (line.length === 0 && ctx.measureText(candidate).width > maxWidth) {
      let chunk = '';
      for (const ch of word) {
        if (chunk.length > 0 && ctx.measureText(chunk + ch).width > maxWidth) {
          lines.push(chunk);
          chunk = ch;
        } else {
          chunk += ch;
        }
      }
      line = chunk;
      return;
    }
    line = candidate;
  };
  for (const word of text.split(/\s+/)) {
    if (word.length > 0) {
      pushWord(word);
    }
  }
  if (line.length > 0) {
    lines.push(line);
  }
  return lines;
}

export function el<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string>
): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    e.setAttribute(k, v);
  }
  return e;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Evidence class of an edge: weight and dash carry it, colour never does. */
export type EvidenceClass = 'import' | 'source' | 'stale' | 'test' | 'human' | 'agent' | 'none';

export function evidenceClass(evidence: string, status = ''): EvidenceClass {
  if (evidence === 'import') {
    return 'import';
  }
  if (evidence === 'test-import') {
    return 'test';
  }
  if (evidence.startsWith('source:')) {
    return status === 'ok' ? 'source' : 'stale';
  }
  if (evidence.startsWith('human:')) {
    return 'human';
  }
  if (evidence.startsWith('agent:')) {
    return 'agent';
  }
  return 'none';
}

/** The evidence overlay has something to say: an edge with machine evidence (anything but human or none). */
export function hasMachineEvidence(edges: readonly { evidence: string; evidenceStatus?: string }[]): boolean {
  return edges.some(e => !['human', 'none'].includes(evidenceClass(e.evidence, e.evidenceStatus)));
}

/** Everything the badge renders, keyed by `key` so a drag never rebuilds it. */
export interface RefBadge {
  key: string;
  count: number;
  /** The first ok ref's symbol ('' when none is ok). */
  first: string;
  title: string;
  /** Refs whose lines are as last seen (G12); absent means none. */
  stale?: number;
  ambiguous?: number;
}

/** Fade-out lifetime of a removed badge; matches the CSS transition. */
export const BADGE_FADE_MS = 120;

function fadeOutBadge(g: SVGGElement): void {
  g.classList.add('leaving');
  window.setTimeout(() => g.remove(), BADGE_FADE_MS);
}

/** Advance of one 11 px mono character (Geist Mono / ui-monospace ≈ 0.6 em). */
export const BADGE_CHAR_PX = 6.6;
/** The badge text box spans this far above and below its baseline. */
const BADGE_ASCENT = 9;
const BADGE_DESCENT = 3;

/**
 * Badge anchor (text end, baseline) inside the node outline, plus the width
 * the text may use. Mirrors the rx/ry geometry of the patch pass: rect corners
 * are 10 px, a pill's caps have radius h/2, an ellipse is the full w×h oval.
 * The room is symmetric (the left limit mirrors the right one).
 */
function badgeAnchor(shape: string, w: number, h: number): { x: number; y: number; room: number } {
  let x = w - 10;
  let y = h - 10;
  if (shape === 'ellipse' || shape === 'pill') {
    const ry = h / 2;
    const rx = shape === 'ellipse' ? w / 2 : Math.min(h / 2, w / 2);
    const cx = w - rx;
    if (shape === 'ellipse') {
      y = h - 14;
    }
    // Half-width of the outline at the text row farthest from the centre line.
    const far = Math.max(Math.abs(y - BADGE_ASCENT - ry), Math.abs(y + BADGE_DESCENT - ry));
    const t = Math.min(1, far / ry);
    x = Math.min(x, cx + rx * Math.sqrt(1 - t * t) - 6);
  }
  return { x, y, room: Math.max(0, 2 * x - w) };
}

/**
 * The status suffix (G12): ` · 1 stale`, ` · 2 ambiguous` or both, else a
 * combined count when both do not fit, else nothing (the <title> marks each).
 */
function badgeStatus(stale: number, ambiguous: number, room: number): string {
  const parts = [stale > 0 ? `${stale} stale` : '', ambiguous > 0 ? `${ambiguous} ambiguous` : ''].filter(Boolean);
  if (parts.length === 0) {
    return '';
  }
  for (const s of [` · ${parts.join(' · ')}`, ` · ${stale + ambiguous} stale/ambiguous`]) {
    if (s.length <= room) {
      return s;
    }
  }
  return '';
}

/**
 * `3 refs`, and on nodes at least 200 px wide `3 refs · Limiter.allow`. A
 * symbol that does not fit the room is shortened to `…member` (its needle),
 * else dropped: a needle is never cut (G36); the full list stays in the
 * <title>. Refs whose lines are as last seen add a status suffix, which
 * outranks the symbol. `countOnly`: the label shares the badge's row on a
 * node too short to lift it (node-layout.ts), so the count stands alone.
 */
function badgeLabel(b: RefBadge, w: number, room: number, countOnly: boolean): { main: string; status: string } {
  const head = `${b.count} ref${b.count === 1 ? '' : 's'}`;
  if (countOnly) {
    return { main: head, status: '' };
  }
  const max = Math.floor(room / BADGE_CHAR_PX);
  const status = badgeStatus(b.stale ?? 0, b.ambiguous ?? 0, max - head.length);
  const first = b.first;
  if (w < 200 || first.length === 0) {
    return { main: head, status };
  }
  const fits = (sym: string) => head.length + 3 + [...sym].length + status.length <= max;
  if (fits(first)) {
    return { main: `${head} · ${first}`, status };
  }
  const needle = symbolNeedle(first);
  if (needle !== first && fits(`…${needle}`)) {
    return { main: `${head} · …${needle}`, status };
  }
  return { main: head, status };
}

/** Build a badge group for a node of size w×h. Attributes are set before the
 *  group is attached, so the only DOM record is the single append. */
function makeBadge(badge: RefBadge, shape: string, w: number, h: number, countOnly: boolean): SVGGElement {
  // The text takes hover (CSS) so the <title> ref list shows; selection and
  // drag hit-test by coordinates, so the badge never steals a node gesture.
  const g = el('g', { class: 'node-refs' });
  const title = el('title', {});
  title.textContent = badge.title;
  const at = badgeAnchor(shape, w, h);
  const text = el('text', {
    class: 'node-refs-text',
    'text-anchor': 'end',
    x: String(at.x),
    y: String(at.y),
  });
  // Mono, faint, never accent; bottom-right inside the outline. The status
  // suffix is a muted tspan, one step stronger than the count (G12).
  const label = badgeLabel(badge, w, at.room, countOnly);
  text.textContent = label.main;
  if (label.status.length > 0) {
    const status = el('tspan', { class: 'node-refs-status' });
    status.textContent = label.status;
    text.append(status);
  }
  g.append(title, text);
  return g;
}

function makeRouteMarker(marker: RouteMarker): SVGGElement {
  const label = `Waypoint ${marker.number} · ${marker.status}`;
  const g = el('g', { class: `node-route route-${marker.status}`, role: 'img', 'aria-label': label });
  const title = el('title', {});
  title.textContent = label;
  const number = el('text', { class: 'node-route-number', x: '6', y: '-9', 'text-anchor': 'middle' });
  number.textContent = String(marker.number);
  g.append(title, el('circle', { class: 'node-route-circle', cx: '6', cy: '-13', r: '11' }), number);
  if (marker.status === 'current') {
    const current = el('text', { class: 'node-route-current', x: '23', y: '-9' });
    current.textContent = 'current';
    g.append(current);
  }
  return g;
}

// --- change notes (spec 2026-10-16) ---------------------------------------------

const SCHEMA_PAD = 16;
/** Title and table name baselines; the 15 px title matches a datastore label, the table a chart subtitle. */
const SCHEMA_TITLE_Y = 28;
const SCHEMA_SUB_Y = 46;
const SCHEMA_TEXT_SIZE = 12;
const SCHEMA_SUB_SIZE = 11.5;
/** The change sign's gutter, left of the column name. */
const SCHEMA_NAME_X = SCHEMA_PAD + 14;
const NOTE_TAG_SIZE = 10.5;
const NOTE_TAG_PAD = 6;
const NOTE_TAG_H = 17;
const NOTE_KIND_LABEL: Record<string, string> = { migration: 'MIGRATION', 'breaking-api': 'BREAKING API', 'data-loss': 'DATA LOSS', dependency: 'DEPENDENCY' };

/** "MIGRATION 0042" for one note whose title starts with its kind, else the kind; "2 MIGRATIONS" (or "2 CHANGES") for several. */
export function noteTagText(notes: readonly NoteView[]): string {
  const kinds = new Set(notes.map(n => n.kind));
  if (notes.length > 1) return `${notes.length} ${kinds.size === 1 ? `${NOTE_KIND_LABEL[notes[0].kind] ?? 'CHANGE'}S` : 'CHANGES'}`;
  const kind = NOTE_KIND_LABEL[notes[0].kind] ?? 'CHANGE';
  const title = notes[0].title.toUpperCase();
  return title.startsWith(kind) && title.length <= 28 ? title : kind;
}

const noteTagWidth = (text: string) => Math.ceil(textWidth(text, NOTE_TAG_SIZE, true) + 2 * NOTE_TAG_PAD);

/** Room beside the tag for the whole title, or at least 72 px of it. */
function tagFitsInside(n: Node, w: number, tag: string): boolean {
  const room = w - 2 * SCHEMA_PAD - noteTagWidth(tag) - 8;
  return room >= Math.min(textWidth(n.label, labelFontSize(n.size)), 72);
}

/** A hairline pill: inside a schema card on its title row, else astride the top outline (no card to sit in). */
function makeNoteTag(text: string, severity: string, w: number, inside: boolean): SVGGElement {
  const g = el('g', { class: `node-note-tag sev-${severity}`, role: 'img', 'aria-label': `Change note: ${text.toLowerCase()}` });
  const width = noteTagWidth(text);
  const x = Math.max(0, w - (inside ? SCHEMA_PAD : 12) - width);
  const baseline = inside ? SCHEMA_TITLE_Y - 1 : 4;
  g.append(
    el('rect', { class: 'node-note-tag-box', x: String(x), y: String(baseline - 12), width: String(width), height: String(NOTE_TAG_H), rx: '5' }),
    Object.assign(el('text', { class: 'node-note-tag-text', x: String(x + NOTE_TAG_PAD), y: String(baseline) }), { textContent: text })
  );
  return g;
}

function makeReaderPip(w: number): SVGGElement {
  const g = el('g', { class: 'node-reader-pip', role: 'img', 'aria-label': 'Reads a changed column' });
  const title = el('title', {});
  title.textContent = 'Still reads a column a change note drops or renames';
  const mark = el('text', { class: 'node-reader-pip-mark', x: String(w), y: '4', 'text-anchor': 'middle' });
  mark.textContent = '!';
  g.append(title, el('circle', { class: 'node-reader-pip-circle', cx: String(w), cy: '0', r: '8' }), mark);
  return g;
}

function makeReaderLabel(status: string, label: string, edgeId: bigint): SVGGElement {
  const g = el('g', { class: `edge-reader reader-${status}`, 'data-edge-id': edgeId.toString() });
  const text = el('text', { class: 'edge-reader-text', 'text-anchor': 'middle' });
  text.textContent = label;
  g.append(el('rect', { class: 'edge-label-bg edge-reader-bg', height: '18' }), text);
  return g;
}

/** The reader row's box is 18 px tall from `top`, centred on `mx`, like an edge label box. */
function placeReaderLabel(g: SVGGElement, mx: number, top: number, label: string): void {
  const w = label.length * EDGE_CHAR_PX + 8;
  const [bg, text] = g.children as unknown as [SVGRectElement, SVGTextElement];
  put(bg, 'x', String(mx - w / 2));
  put(bg, 'y', String(top));
  put(bg, 'width', String(w));
  put(text, 'x', String(mx));
  put(text, 'y', String(top + 13));
}

const CUT_ORDER: Record<string, number> = { dropped: 0, renamed: 1, added: 2 };

/** Rows for a card taller than its node ("+N more" counts the rest): dropped, renamed, then added rows stay, in column order. */
function cutRows(rows: SchemaColumn[], more: number, fits: number): { rows: SchemaColumn[]; more: number } {
  const room = Math.max(0, fits);
  const keep = new Set([...rows].sort((a, b) => (CUT_ORDER[a.change ?? ''] ?? 3) - (CUT_ORDER[b.change ?? ''] ?? 3)).slice(0, room));
  const kept = rows.filter(c => keep.has(c));
  return { rows: kept, more: more + rows.length - kept.length };
}

/** The changed table inside the stored rect: title and table name, the rows schemaRows picks, then a
 *  footer row (like a chart card's) for "+N more", which leaves the bottom right to the ref badge. */
function drawSchemaCard(e: NodeEntry, n: Node, r: Rect, schema: Schema, tag: string): void {
  const labelCls = `node-label token-${n.token} schema-title`;
  if (labelCls !== e.labelCls) {
    e.label!.setAttribute('class', labelCls);
    e.labelCls = labelCls;
  }
  const room = Math.max(0, r.w - 2 * SCHEMA_PAD);
  const title = ellipsize(n.label, Math.max(0, room - (tag ? noteTagWidth(tag) + 8 : 0)), labelFontSize(n.size), false).text;
  if (title !== e.labelText) {
    e.label!.textContent = title;
    e.labelText = title;
  }
  const table = ellipsize(schema.table, room, SCHEMA_SUB_SIZE, true).text;
  if (table !== e.sublabelText) {
    e.sublabel!.textContent = table;
    e.sublabelText = table;
  }
  const fits = Math.max(0, Math.floor((r.h - SCHEMA_HEAD_H - SCHEMA_FOOT_H) / SCHEMA_ROW_H)); // never draw past the stored rect
  const picked = schemaRows(schema);
  const { rows, more } = picked.rows.length <= fits ? picked : cutRows(picked.rows, picked.more, fits);
  const key = `${r.w}|${r.h}|${more}|${textEpoch()}|${rows.map(c => `${c.name}:${c.type}:${c.change}`).join(',')}`;
  if (key === e.schemaKey) return;
  e.schemaKey = key;
  const typeRight = r.w - SCHEMA_PAD;
  const out: SVGGElement[] = [];
  rows.forEach((c, i) => {
    const y = SCHEMA_HEAD_H + i * SCHEMA_ROW_H;
    const baseline = String(y + 16);
    const row = el('g', { class: `schema-row change-${c.change ?? 'none'}` });
    if (c.change !== null) row.append(el('rect', { class: 'schema-band', x: '8', y: String(y + 2), width: String(r.w - 16), height: String(SCHEMA_ROW_H - 4), rx: '4' }));
    const type = ellipsize(c.type, Math.max(0, room / 2 - 8), SCHEMA_TEXT_SIZE, true).text;
    const nameRoom = typeRight - textWidth(type, SCHEMA_TEXT_SIZE, true) - 12 - SCHEMA_NAME_X;
    const name = el('text', { class: 'schema-col', x: String(SCHEMA_NAME_X), y: baseline });
    name.textContent = ellipsize(c.name, Math.max(0, nameRoom), SCHEMA_TEXT_SIZE, true).text;
    const typeText = el('text', { class: 'schema-type', x: String(typeRight), y: baseline, 'text-anchor': 'end' });
    typeText.textContent = type;
    if (c.change !== null) {
      // Diff grammar: the sign, the band and (for a drop) the strike carry the change, never colour alone.
      const sign = el('text', { class: 'schema-sign', x: String(SCHEMA_PAD), y: baseline });
      sign.textContent = c.change === 'added' ? '+' : c.change === 'dropped' ? '−' : '~';
      const title = el('title', {});
      title.textContent = `${c.name}: ${c.change}`;
      row.append(title, sign);
    }
    row.append(name, typeText);
    out.push(row);
  });
  if (more > 0) {
    const moreRow = el('g', { class: 'schema-more-row' });
    const t = el('text', { class: 'schema-more', x: String(SCHEMA_PAD), y: String(r.h - 12) });
    t.textContent = `+${more} more`;
    moreRow.append(t);
    out.push(moreRow);
  }
  e.schemaRows!.replaceChildren(...out);
}

/** The code-overlay suffix on an edge label (G51), keyed like a node badge. */
export interface EdgeRefBadge {
  key: string;
  count: number;
  title: string;
}

/** The suffix group for an edge: <title> ref list plus the muted count. Its
 *  text and position are written by the label pass before it is attached. */
function makeEdgeRefs(badge: EdgeRefBadge, edgeId: bigint): { g: SVGGElement; text: SVGTextElement } {
  // data-edge-id: a click on the suffix selects the edge, like the label.
  const g = el('g', { class: 'edge-refs', 'data-edge-id': edgeId.toString() });
  const title = el('title', {});
  title.textContent = badge.title;
  const t = el('text', { class: 'edge-refs-text' });
  g.append(title, t);
  return { g, text: t };
}

export interface RenderState {
  selection: ReadonlySet<bigint>;
  /** Edges selected for inspection (view-local). */
  selectedEdges: ReadonlySet<bigint>;
  /** Local drag preview positions (and sizes, while resizing), keyed by node id. */
  overrides: ReadonlyMap<bigint, { x: number; y: number; w?: number; h?: number }>;
  /** Node ids that should show edge handles (hovered or selected). */
  handles: ReadonlySet<bigint>;
  /** Node currently highlighted as an edge-draw target. */
  edgeTarget: bigint | null;
  /** Hidden rows temporarily revealed at low opacity (view-only). */
  ghosts: ReadonlySet<bigint>;
  ghostEdges: ReadonlySet<bigint>;
  /** hide-set name per revealed ghost node, for the caption under it. */
  ghostSetNames: ReadonlyMap<bigint, string>;
  /** Evidence overlay on: stroke weight/dash encode the evidence class. */
  overlay: boolean;
  /** Code overlay on: nodes in refsByNode get a count badge. */
  codeOverlay: boolean;
  /** Per-node badge inputs, precomputed by the caller (never rows). */
  refsByNode: ReadonlyMap<bigint, RefBadge>;
  /** Per-edge suffix inputs (G51); absent means no edge carries refs. */
  refsByEdge?: ReadonlyMap<bigint, EdgeRefBadge>;
  /** Durable route markers are independent of local selection and evidence. */
  routeByNode?: ReadonlyMap<bigint, RouteMarker>;
  nodeDiff?: ReadonlyMap<bigint, 'added' | 'removed' | 'changed'>;
  edgeDiff?: ReadonlyMap<bigint, 'added' | 'removed' | 'changed'>;
  /** Chart rows by node id; absent (or no row) draws a chart's 'no data' state. */
  charts?: ReadonlyMap<bigint, Chart>;
  /** Hand-set line weight by edge id (visible_edge_weight, RC-688); absent means regular. */
  edgeWeights?: ReadonlyMap<bigint, string>;
  /** Library icon id by node (visible_node_icon); a node without one draws as before. */
  icons?: ReadonlyMap<bigint, string>;
  /** Neighbour focus: hovered node, else the single selected one. flow = from selection. */
  focus?: { id: bigint; flow: boolean } | null;
  /** Change notes (spec 2026-10-16): anchor tags and schema cards, reader edges and pips. */
  notes?: NoteIndex;
  /** Hazard markers by anchor node (visible nodes only; the caller filters). */
  threatMarkers?: ReadonlyMap<bigint, MarkerSpec>;
  /** The open threat's blast radius: outlines, hop badges and flowing edges; it owns the dimming. */
  blast?: Blast | null;
  /** Live tap summaries by edge id (the canvas resolves the tap's node pairs to edges). */
  live?: ReadonlyMap<bigint, LiveEdge>;
  scale: number;
  /** Fade in the nodes and edges this render adds: live arrivals, never a board's first paint. */
  enter?: boolean;
}

/** Neighbour focus: the hovered node, else the single selected one. Flow
 *  whenever the focus is the sole selection, hovered or not (a click leaves
 *  the pointer on the node). */
export function focusOf(hoverId: bigint | null, selection: ReadonlySet<bigint>): RenderState['focus'] {
  const id = hoverId ?? (selection.size === 1 ? [...selection][0] : null);
  return id === null ? null : { id, flow: selection.size === 1 && selection.has(id) };
}

/** Edges drawn as ghosts: revealed hidden edges, and unhidden edges touching a ghost endpoint. */
export function ghostEdges(
  edges: Edge[], renderable: ReadonlySet<bigint>, shownNodes: () => Node[], revealed: (e: Edge) => boolean,
): Edge[] {
  const shown = new Set(shownNodes().map(n => n.id));
  return edges.filter(e => {
    if (!renderable.has(e.fromNode) || !renderable.has(e.toNode)) {
      return false;
    }
    if (e.hidden) {
      return revealed(e);
    }
    return !(shown.has(e.fromNode) && shown.has(e.toNode));
  });
}

/** A short fade-in. Web Animations, not a CSS class: class writes and layer re-sorts never restart it. */
function fadeIn(e: Element): void {
  if (typeof e.animate !== 'function') return;
  if (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  // One keyframe at offset 0: fade up to whatever opacity CSS gives the element (ghosts stay dim).
  // Without the offset a lone keyframe sits at 1, and the element fades out instead.
  e.animate([{ opacity: 0, offset: 0 }], { duration: 240, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' });
}

function center(r: Rect): { x: number; y: number } {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

/** Point where the segment from `from` to the center of `rect` crosses the rect border. */
export function borderPoint(
  from: { x: number; y: number },
  rect: Rect,
  shape: string = 'rect'
): { x: number; y: number } {
  const c = center(rect);
  const dx = from.x - c.x;
  const dy = from.y - c.y;
  if (dx === 0 && dy === 0) {
    return c;
  }
  if (shape === 'ellipse') {
    // Intersect the ray with the ellipse instead of its bounding box: the box
    // corner lies well outside the curve, which left a visible gap at
    // diagonal endpoints.
    const rx = rect.w / 2;
    const ry = rect.h / 2;
    const t = 1 / Math.hypot(dx / rx, dy / ry);
    return { x: c.x + dx * t, y: c.y + dy * t };
  }
  // 'pill' keeps the box solution: its flat sides and its cap tips both lie on
  // the bounding box, so only the cap shoulders differ, by under a pixel at
  // normal zoom.
  const scaleX = dx !== 0 ? rect.w / 2 / Math.abs(dx) : Infinity;
  const scaleY = dy !== 0 ? rect.h / 2 / Math.abs(dy) : Infinity;
  const s = Math.min(scaleX, scaleY);
  return { x: c.x + dx * s, y: c.y + dy * s };
}

/** Estimated advance of one 12 px mono character in an edge label. */
const EDGE_CHAR_PX = 7.3;

/** Width of the box behind an edge label run. */
function edgeLabelW(text: string): number {
  return text.length * EDGE_CHAR_PX + 8;
}

/** One edge's latest live tap window. `reverse`: the calls run against the drawn arrow. */
export interface LiveEdge {
  count: number;
  errors: number;
  p50: number;
  p95: number;
  /** Calls per second over the window. */
  rps: number;
  reverse: boolean;
}

const fmtMs = (ms: number) => (ms < 10 ? Math.round(ms * 10) / 10 : Math.round(ms));
const fmtRate = (rps: number) => (rps < 10 ? Math.round(rps * 10) / 10 : Math.round(rps));

/** The numbers an edge can show: live `12ms · 41/s` (`· 2 err`), else its stored latency (`38ms`, `13ms local`, `~4ms`). */
function edgeMetric(edge: Pick<Edge, 'latencyMs' | 'latencySource'>, live?: LiveEdge): string {
  if (live) return `${fmtMs(live.p50)}ms · ${fmtRate(live.rps)}/s${live.errors > 0 ? ` · ${live.errors} err` : ''}`;
  if (!(edge.latencyMs >= 0)) return '';
  const n = fmtMs(edge.latencyMs);
  return edge.latencySource === 'estimate' ? `~${n}ms` : edge.latencySource === 'local' ? `${n}ms local` : `${n}ms`;
}

/**
 * An edge's label, with its numbers when `reveal` (selected, or next to the
 * focused node). Quiet by default: a busy board shows warmth, not numbers.
 */
export function edgeText(edge: Pick<Edge, 'label' | 'latencyMs' | 'latencySource'>, reveal = true, live?: LiveEdge): string {
  const metric = reveal ? edgeMetric(edge, live) : '';
  if (metric === '') return edge.label;
  return edge.label.length > 0 ? `${edge.label} · ${metric}` : metric;
}

/** Latency at which an edge reads warm, and hot. */
const WARM_MS = 100;
const HOT_MS = 400;

/** How fast a live edge flows: busier is faster, 2.4 s per dash cycle down to 0.4 s. */
export function flowSeconds(rps: number): number {
  return Math.min(2.4, Math.max(0.4, 2.4 - 0.6 * Math.log10(rps + 1)));
}

/** The count an edge's code-overlay suffix shows (G51): `N ref(s)`, or ''. */
export function edgeRefsCount(count: number): string {
  return count > 0 ? `${count} ref${count === 1 ? '' : 's'}` : '';
}

/** The drawn outline. A chart card is always a rectangle: its title, plot
 *  and footnote are laid out for one, whatever shape is stored. */
function shapeOf(n: Pick<Node, 'kind' | 'shape'>): string {
  return n.kind === 'chart' ? 'rect' : n.shape || 'rect';
}

/**
 * The drawn rect is the stored rect (G2): text wraps and ellipsizes inside it
 * (node-layout.ts) and never grows it, so selection, fit, edges, the size
 * readout and the agent's get_board all see the same geometry. Only a local
 * drag or resize preview overrides it. Never measures text.
 */
export function nodeRect(n: Node, overrides: RenderState['overrides']): Rect {
  const o = overrides.get(n.id);
  return { x: o?.x ?? n.x, y: o?.y ?? n.y, w: o?.w ?? n.w, h: o?.h ?? n.h };
}

export function contentBounds(nodes: Node[]): { minX: number; minY: number; maxX: number; maxY: number } | null {
  if (nodes.length === 0) {
    return null;
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    const r = nodeRect(n, new Map());
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w);
    maxY = Math.max(maxY, r.y + r.h);
  }
  return { minX, minY, maxX, maxY };
}

const KINDS = ['service', 'datastore', 'external', 'boundary', 'note', 'text', 'chart'];
function normalizeKind(kind: string): string {
  return KINDS.includes(kind) ? kind : 'service';
}

/** Chart card geometry, node-local px (the approved mock, gen-aesthetic.mjs). */
const CHART_PAD = 16;
const CHART_TITLE_Y = 27;
const CHART_TITLE_SIZE = 13;
const CHART_SUB_Y = 43;
const CHART_SUB_SIZE = 11.5;
const CHART_TAG_SIZE = 10.5;
/** Tag and sample pills: 6 px of padding each side of the text, 17 px tall, radius 5. */
const CHART_PILL_PAD = 6;
const CHART_PILL_H = 17;
const CHART_PLOT_TOP = 56;
/** Dense hides the subtitle and the footnote: the plot starts under the title and ends at the padding. */
const CHART_DENSE_TOP = 40;
/** The footnote row under the plot; its baseline sits 12 px above the bottom. */
const CHART_FOOT_H = 28;
const CHART_FOOT_SIZE = 11;
const CHART_SAMPLE_SIZE = 10.5;

/** Marker id for an edge given its overlay class and selection state. */
const EDGE_COLORS = ['ink', 'blue', 'red', 'green', 'purple', 'gray'] as const;
/** Head stroke for a hand-set weight: its line's width plus half a pixel. */
const WEIGHT_HEAD_PX = new Map([['medium', '2.5'], ['bold', '3.5']]);

function markerFor(
  cls: EvidenceClass,
  overlay: boolean,
  selected: boolean,
  color: string = ''
): string {
  // A colour of its own (hand-set, or a diff or reader status) holds while the
  // edge is selected, so a colour picked from the toolbar shows at once; a
  // halo marks the selection instead (style.css, RC-688).
  const own = color.length > 0 && (EDGE_COLORS as readonly string[]).includes(color);
  if (selected && !own) {
    return 'mk-sel';
  }
  if (overlay && cls === 'stale') {
    return 'mk-muted';
  }
  // A hand-coloured edge takes a matching head; otherwise the body would be
  // red while the arrow stayed grey.
  if (own) {
    return `mk-c-${color}`;
  }
  if (!overlay) {
    return 'mk-edge';
  }
  switch (cls) {
    case 'import':
      return 'mk-ink-heavy';
    case 'source':
      return 'mk-ink';
    case 'test':
    case 'human':
      return 'mk-muted';
    default:
      return 'mk-edge';
  }
}

// A head keeps one size whatever its line's evidence weight or zoom. A
// hand-set medium or bold weight (RC-688) gets heads of their own, stroked
// half a pixel heavier than the line as the regular head is, so the head
// reads with the line (style.css thins them with the line below 60% zoom);
// their round ends may pass the padding when zoomed out.
function arrowMarker(id: string, cssClass: string, weight?: string): SVGMarkerElement {
  const marker = el('marker', {
    id,
    viewBox: '0 0 12 12',
    refX: '10',
    refY: '6',
    markerWidth: '12',
    markerHeight: '12',
    // Evidence weight and dense-mode thinning must not resize the arrowhead.
    markerUnits: 'userSpaceOnUse',
    orient: 'auto-start-reverse',
    ...(weight === undefined ? {} : { overflow: 'visible' }),
  });
  marker.append(el('path', {
    d: 'M2,2 L10,6 L2,10',
    class: `edge-arrowhead ${cssClass}${weight === undefined ? '' : ` head-${weight}`}`,
    'stroke-width': weight === undefined ? '1.5' : WEIGHT_HEAD_PX.get(weight)!,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'vector-effect': 'non-scaling-stroke',
  }));
  return marker;
}

// --- keyed incremental renderer ---
//
// renderBoard is a keyed reconciler: DOM elements persist across calls in
// per-world state, and each call writes only the attributes that differ from
// what was last rendered. Node/overlay groups carry their position in a
// translate() transform with children at local coordinates, so a drag frame is
// one transform write per moved node (plus endpoint updates on the edges that
// touch it). The node's visual grammar (kind-specific shape, note wrapping,
// evidence overlay) rides on top of that reconciler.

/**
 * A rendered node. Its inner DOM depends on `kind`, so when the kind changes the
 * children are rebuilt; within a kind, only changed attributes/text are written.
 */
interface NodeEntry {
  g: SVGGElement;
  kind: string;
  rect: SVGRectElement;
  rule: SVGRectElement | null;
  /** Datastore cylinder rim and external ↗ glyph, drawn only when they fit. */
  rim: SVGPathElement | null;
  glyph: SVGPathElement | null;
  /** Library icon (spec 2026-10-18), keyed on its id and placement ('' = none). */
  icon: SVGGElement | null;
  iconKey: string;
  /** Primary label (service/datastore/boundary); null for notes. */
  label: SVGTextElement | null;
  sublabel: SVGTextElement | null;
  /** Note body (wrapped tspans); null for non-notes. */
  body: SVGTextElement | null;
  caption: SVGTextElement | null;
  /** Code-overlay badge group; added and removed from the DOM, never CSS-hidden. */
  refs: SVGGElement | null;
  route: SVGGElement | null;
  routeKey: string;
  /** The RefBadge.key the current badge was built from ('' = no badge). */
  refsKey: string;
  /** The shape the current badge was anchored for. */
  refsShape: string;
  /** The current badge shows its count alone (the label shares its row). */
  refsCountOnly: boolean;
  /** Inputs the label and sublabel were last laid out from ('' = stale). */
  textKey: string;
  /** The layout the label and sublabel were drawn from (inline editor reads it). */
  text: NodeTextLayout | null;
  /** Full label (and sublabel) while either is cut; added and removed keyed on its text. */
  title: SVGTitleElement | null;
  titleText: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Cached so a shape change re-runs the rx/ry geometry. */
  shape: string;
  labelText: string;
  sublabelText: string;
  bodyText: string;
  bodyW: number;
  cls: string;
  labelCls: string;
  captionText: string;
  /** Whether the group currently lives in the containers layer. */
  container: boolean;
  /** Row area (not override area), which drives paint order. */
  area: number;
  /** Chart marks (kind 'chart' only); rebuilt only when plotKey changes. */
  plot: SVGGElement | null;
  /** `type|updatedAt|w|h|dense|font epoch` the plot was drawn from ('' = stale). */
  plotKey: string;
  /** Chart type tag, top right, on its hairline pill (tagBox). */
  tag: SVGTextElement | null;
  tagBox: SVGRectElement | null;
  /** The dashed pill behind the 'sample data' tag; in the DOM only for sample charts. */
  sampleBox: SVGRectElement | null;
  /** `source: …` footnote, or the 'sample data' tag. */
  source: SVGTextElement | null;
  /** Change note tag on an anchor ('' key = none); keyed on its text and severity. */
  noteTag: SVGGElement | null;
  noteTagKey: string;
  /** Threat marker, top right; keyed on its spec, width and slot. */
  marker: SVGGElement | null;
  markerKey: string;
  /** Blast hop number, beside the threat marker; keyed on hop, width and slot. */
  hopBadge: SVGGElement | null;
  hopBadgeKey: string;
  /** The "!" on a node whose stale reader has no edge to the anchor. */
  pip: SVGGElement | null;
  pipKey: string;
  /** Schema card rows (draw kind 'schema' only); rebuilt only when schemaKey changes. */
  schemaRows: SVGGElement | null;
  schemaKey: string;
}

interface EdgeEntry {
  g: SVGGElement;
  /** The edge's label run (background, label, hit box, ref suffix), painted
   *  in the layer above the nodes so a short edge never cuts it (P17). */
  labels: SVGGElement;
  line: SVGPathElement;
  hit: SVGPathElement;
  title: SVGTitleElement;
  label: SVGTextElement | null;
  labelBg: SVGRectElement | null;
  labelHit: SVGRectElement | null;
  labelText: string;
  /** Code-overlay suffix (G51); added and removed by key, never CSS-hidden. */
  refs: SVGGElement | null;
  refsText: SVGTextElement | null;
  /** The count's own backing, present only while it sits under the label. */
  refsBg: SVGRectElement | null;
  /** EdgeRefBadge.key plus the suffix text it was built with ('' = none). */
  refsKey: string;
  /** Change note reader status, on its own row under the line ('' key = none). */
  reader: SVGGElement | null;
  readerKey: string;
  lineCls: string;
  /** Last-written blast class of g and labels ('' = none). */
  blast: string;
  marker: string;
  selected: boolean;
  /** Last-written focus-near state of g and labels. */
  near: boolean;
  /** Last-written path data, and the route it came from. */
  d: string;
  route: Route | null;
  /** Where an edge-only selection anchors the toolbar (G35): the drawn label
   *  run, its own-row count included (G51), or a 0×0 rect at the longest
   *  segment's midpoint when the edge draws no text. */
  anchor: Rect | null;
}

/**
 * Overlay chrome for one node, split across three global layers so stacking
 * matches the old three-pass paint order: every resize handle above every
 * edge handle above every outline.
 */
interface OverlayEntry {
  outline: SVGGElement | null;
  handle: SVGGElement | null;
  resize: SVGGElement | null;
  x: number;
  y: number;
  /** Everything the overlay's contents depend on besides position. */
  sig: string;
}

interface WorldState {
  containers: SVGGElement;
  edgesLayer: SVGGElement;
  nodesLayer: SVGGElement;
  edgeLabelsLayer: SVGGElement;
  outlineLayer: SVGGElement;
  handleLayer: SVGGElement;
  resizeLayer: SVGGElement;
  nodes: Map<bigint, NodeEntry>;
  edges: Map<bigint, EdgeEntry>;
  overlayMap: Map<bigint, OverlayEntry>;
}

const worlds = new WeakMap<SVGGElement, WorldState>();

function bind(world: SVGGElement): WorldState {
  let st = worlds.get(world);
  if (st) {
    return st;
  }
  world.replaceChildren();

  const defs = el('defs', {});
  defs.append(
    arrowMarker('mk-edge', 'mk-edge'),
    arrowMarker('mk-ink', 'mk-ink'),
    arrowMarker('mk-ink-heavy', 'mk-ink'),
    arrowMarker('mk-muted', 'mk-muted'),
    arrowMarker('mk-sel', 'mk-sel'),
    ...EDGE_COLORS.map(c => arrowMarker(`mk-c-${c}`, `mk-c-${c}`)),
    // RC-688: the heads a medium or bold edge can take with the overlay off.
    ...['mk-edge', 'mk-sel', ...EDGE_COLORS.map(c => `mk-c-${c}`)].flatMap(id =>
      [...WEIGHT_HEAD_PX.keys()].map(weight => arrowMarker(`${id}-${weight}`, id, weight))
    )
  );

  // Fixed layer order replaces the old paint order: containers below edges
  // below regular nodes below edge labels below overlay chrome (outlines,
  // then edge handles, then resize handles — mirroring the old three global
  // passes). Edge lines stay under the nodes; their labels paint over them,
  // so a label longer than its visible segment is never cut (P17).
  // #crayon (draft review circles, crayon.ts), #transient and #presence
  // persist across renders instead of being recreated empty.
  const containers = el('g', { class: 'layer-containers' });
  const edgesLayer = el('g', { class: 'layer-edges' });
  const nodesLayer = el('g', { class: 'layer-nodes' });
  const edgeLabelsLayer = el('g', { class: 'layer-edge-labels' });
  const outlineLayer = el('g', { class: 'layer-outlines' });
  const handleLayer = el('g', { class: 'layer-edge-handles' });
  const resizeLayer = el('g', { class: 'layer-resize-handles' });
  world.append(
    defs,
    containers,
    edgesLayer,
    nodesLayer,
    edgeLabelsLayer,
    outlineLayer,
    handleLayer,
    resizeLayer,
    el('g', { id: 'crayon' }),
    el('g', { id: 'transient' }),
    el('g', { id: 'presence' })
  );

  st = {
    containers,
    edgesLayer,
    nodesLayer,
    edgeLabelsLayer,
    outlineLayer,
    handleLayer,
    resizeLayer,
    nodes: new Map(),
    edges: new Map(),
    overlayMap: new Map(),
  };
  worlds.set(world, st);
  return st;
}

function makeNodeEntry(n: Node): NodeEntry {
  const g = el('g', {});
  g.dataset.id = n.id.toString();
  return {
    g,
    kind: '',
    // rect is (re)created by buildInner; a throwaway keeps the type non-null.
    rect: el('rect', {}),
    rule: null,
    rim: null,
    glyph: null,
    icon: null,
    iconKey: '',
    label: null,
    sublabel: null,
    body: null,
    caption: null,
    refs: null,
    route: null,
    routeKey: '',
    noteTag: null,
    noteTagKey: '',
    marker: null,
    markerKey: '',
    hopBadge: null,
    hopBadgeKey: '',
    pip: null,
    pipKey: '',
    schemaRows: null,
    schemaKey: '',
    refsKey: '',
    refsShape: '',
    refsCountOnly: false,
    textKey: '',
    text: null,
    title: null,
    titleText: '',
    x: NaN,
    y: NaN,
    w: NaN,
    h: NaN,
    labelText: '',
    sublabelText: '',
    bodyText: '',
    bodyW: NaN,
    shape: '',
    cls: '',
    labelCls: '',
    captionText: '',
    container: false,
    area: NaN,
    plot: null,
    plotKey: '',
    tag: null,
    tagBox: null,
    sampleBox: null,
    source: null,
  };
}

/** Rebuild a node's inner DOM for its kind. Child positions that never change
 *  are set here; sizes and text are written by the patch pass (caches reset). */
function buildInner(e: NodeEntry, kind: string): void {
  e.g.replaceChildren();
  e.rule = null;
  e.rim = null;
  e.glyph = null;
  e.icon = null;
  e.iconKey = '';
  e.label = null;
  e.sublabel = null;
  e.body = null;
  // caption is managed separately (ghost state), so drop any stale one.
  e.caption = null;
  // replaceChildren dropped the badge too; reset the key so the patch pass
  // re-adds it (a kind change must never strand a badge).
  e.refs = null;
  e.refsKey = '';
  e.route = null;
  e.routeKey = '';
  e.noteTag = null;
  e.noteTagKey = '';
  e.marker = null;
  e.markerKey = '';
  e.hopBadge = null;
  e.hopBadgeKey = '';
  e.pip = null;
  e.pipKey = '';
  e.schemaRows = null;
  e.schemaKey = '';
  e.title = null;
  e.titleText = '';
  e.plot = null;
  e.plotKey = '';
  e.tag = null;
  e.tagBox = null;
  e.sampleBox = null;
  e.source = null;

  if (kind === 'note') {
    // A note is bare text on the canvas: NOTE eyebrow plus a wrapped body. The
    // invisible rect keeps it hittable for drag/select.
    e.rect = el('rect', { x: '0', y: '0', fill: 'transparent', stroke: 'none' });
    const eyebrow = el('text', { class: 'note-eyebrow', x: '0', y: '11' });
    eyebrow.textContent = 'NOTE';
    e.body = el('text', { class: 'note-body', x: '0', y: '33' });
    e.body.dataset.field = 'label';
    e.g.append(e.rect, eyebrow, e.body);
  } else if (kind === 'text') {
    // Free text: the body alone, box fitted to it (text-block.ts).
    e.rect = el('rect', { x: '0', y: '0', fill: 'transparent', stroke: 'none' });
    e.body = el('text', { class: 'text-body', x: '0', y: '0' });
    e.body.dataset.field = 'label';
    e.g.append(e.rect, e.body);
  } else if (kind === 'schema') {
    // A changed table (spec 2026-10-16 D5): the datastore's rule and label,
    // its table name, then one row per column the note shows.
    e.rect = el('rect', { class: 'node-rect', x: '0', y: '0', rx: '10' });
    e.rule = el('rect', { class: 'node-rule', x: '0', y: '5', width: '3' });
    e.label = el('text', { x: String(SCHEMA_PAD), y: String(SCHEMA_TITLE_Y) });
    e.label.dataset.field = 'label';
    e.sublabel = el('text', { class: 'node-sublabel schema-table', x: String(SCHEMA_PAD), y: String(SCHEMA_SUB_Y) });
    e.schemaRows = el('g', { class: 'schema-rows' });
    e.g.append(e.rect, e.rule, e.label, e.sublabel, e.schemaRows);
  } else if (kind === 'chart') {
    // A chart card: title, subtitle and type tag, the plot, then the source
    // footnote. Title and subtitle keep data-field and .node-sublabel, so a
    // double-click edits them like any label (interactions.ts).
    e.rect = el('rect', { class: 'node-rect', x: '0', y: '0', rx: '10' });
    e.label = el('text', { class: 'chart-title', x: String(CHART_PAD), y: String(CHART_TITLE_Y) });
    e.label.dataset.field = 'label';
    e.sublabel = el('text', { class: 'node-sublabel chart-subtitle', x: String(CHART_PAD), y: String(CHART_SUB_Y) });
    e.sublabel.dataset.field = 'sublabel';
    e.tagBox = el('rect', { class: 'chart-tag-box', y: String(CHART_TITLE_Y - 12), height: String(CHART_PILL_H), rx: '5' });
    e.tag = el('text', { class: 'chart-tag', y: String(CHART_TITLE_Y), 'text-anchor': 'end' });
    e.plot = el('g', { class: 'chart-plot', transform: `translate(${CHART_PAD} ${CHART_PLOT_TOP})` });
    e.sampleBox = el('rect', { class: 'chart-sample-box', x: String(CHART_PAD), height: String(CHART_PILL_H), rx: '5' });
    e.source = el('text', { class: 'chart-source', x: String(CHART_PAD) });
    e.g.append(e.rect, e.label, e.sublabel, e.tagBox, e.tag, e.plot, e.source);
  } else {
    e.rect = el('rect', { class: 'node-rect', x: '0', y: '0', rx: '10' });
    e.g.append(e.rect);
    if (kind === 'datastore') {
      // Left rule hugs the border at every zoom (like the mock's border-left).
      e.rule = el('rect', { class: 'node-rule', x: '0', y: '5', width: '3' });
      e.g.append(e.rule);
    }
    if (kind === 'boundary') {
      e.label = el('text', { class: 'node-boundary-label', x: '16', y: '24' });
      e.label.dataset.field = 'label';
      e.g.append(e.label);
    } else {
      e.label = el('text', { 'text-anchor': 'middle', y: '31' });
      e.label.dataset.field = 'label';
      e.sublabel = el('text', { class: 'node-sublabel', 'text-anchor': 'middle', y: '53' });
      e.sublabel.dataset.field = 'sublabel';
      e.g.append(e.label, e.sublabel);
    }
  }

  // Force the patch pass to rewrite everything geometry/text after a rebuild.
  e.w = NaN;
  e.h = NaN;
  e.shape = '';
  e.labelText = '';
  e.sublabelText = '';
  e.bodyText = '';
  e.bodyW = NaN;
  e.labelCls = '';
  e.textKey = '';
  e.text = null;
}

/** Write an attribute only when its value changes (keyed-render contract). */
function put(target: Element, name: string, value: string): void {
  if (target.getAttribute(name) !== value) {
    target.setAttribute(name, value);
  }
}

/**
 * Draw a laid-out label block (G2, G9): one line as plain text, two as
 * centred tspans; the sublabel on its own baseline (empty when it has no
 * room); and the node <title> while anything is cut.
 */
function drawNodeText(e: NodeEntry, t: NodeTextLayout, w: number): void {
  const label = e.label!;
  const sub = e.sublabel!;
  const cx = String(w / 2);
  put(label, 'x', cx);
  put(label, 'y', String(t.labelY));
  const labelText = t.lines.length === 1 ? t.lines[0] : `${t.lines.join('\n')}\n${cx}\n${t.lineHeight}`;
  if (labelText !== e.labelText) {
    if (t.lines.length === 1) {
      label.textContent = t.lines[0];
    } else {
      label.replaceChildren(
        ...t.lines.map((line, i) => {
          const tspan = el('tspan', { x: cx, dy: i === 0 ? '0' : String(t.lineHeight) });
          tspan.textContent = line;
          return tspan;
        })
      );
    }
    e.labelText = labelText;
  }
  put(sub, 'x', cx);
  put(sub, 'y', String(t.subY));
  if (t.sub !== e.sublabelText) {
    sub.textContent = t.sub;
    e.sublabelText = t.sub;
  }
  if (t.title !== e.titleText) {
    if (t.title.length === 0) {
      e.title?.remove();
      e.title = null;
    } else {
      if (e.title === null) {
        e.title = el('title', {});
        e.g.prepend(e.title);
      }
      e.title.textContent = t.title;
    }
    e.titleText = t.title;
  }
  e.text = t;
}

/**
 * The kind's mark on a plain rect, kept clear of the laid-out label: a datastore's cylinder
 * rim when the label's first line box starts 16 px or more below the top, an
 * external's corner arrow when the node is 120 px wide and the widest label line leaves
 * 20 px clear of the glyph on the right.
 */
function drawKindMark(e: NodeEntry, kind: string, shape: string, w: number, hasIcon: boolean): void {
  const t = e.text!;
  if (kind === 'datastore') {
    // Same first-line box top the inline editor uses (interactions.ts). An
    // icon owns the top of the node: the rim would cross it.
    const fits = !hasIcon && shape === 'rect' && t.labelY - t.lineHeight / 2 - 0.34 * t.fontSize >= 16;
    if (!fits) {
      e.rim?.remove();
      e.rim = null;
    } else {
      if (e.rim === null) {
        e.rim = el('path', { class: 'node-rim' });
        e.rect.after(e.rim);
      }
      put(e.rim, 'd', `M0,6 Q${w / 2},18 ${w},6`);
    }
  } else if (kind === 'external') {
    const widest = Math.max(...t.lines.map(line => textWidth(line, t.fontSize)));
    const fits = shape === 'rect' && w >= 120 && (w - widest) / 2 >= 20 + GLYPH_W;
    if (!fits) {
      e.glyph?.remove();
      e.glyph = null;
    } else {
      if (e.glyph === null) {
        e.glyph = el('path', { class: 'node-glyph', 'aria-hidden': 'true', d: 'M0,8 L8,0 M2,0 H8 V6' });
        e.g.append(e.glyph);
      }
      put(e.glyph, 'transform', `translate(${w - 16} 8)`);
    }
  }
}

/** Width of the drawn corner arrow. */
const GLYPH_W = 8;

/**
 * The node's library icon at `place` (node-local), or none. Named by its
 * <title> for assistive tech (role img); pointer events pass through to the
 * node. Rebuilt only when the id or the placement changes.
 */
function drawNodeIcon(e: NodeEntry, iconId: string | undefined, place: { x: number; y: number; size: number } | null): void {
  const spec = place ? drawableIcon(iconId) : undefined;
  const key = spec && place ? `${spec.id}|${place.x}|${place.y}|${place.size}` : '';
  if (key === e.iconKey) {
    return;
  }
  e.icon?.remove();
  e.icon = null;
  const art = spec && place ? iconGroup(spec.id, place.size) : null;
  // A logo whose artwork is still loading keeps no key, so the render after it arrives draws it.
  e.iconKey = art === null ? '' : key;
  if (!spec || !place || art === null) {
    return;
  }
  const g = el('g', { class: 'node-icon-slot', transform: `translate(${place.x} ${place.y})`, role: 'img' });
  const title = el('title', {});
  title.textContent = spec.name;
  g.append(title, art);
  // Above the outline and its rule, below the text.
  (e.rule ?? e.rect).after(g);
  e.icon = g;
}

/**
 * A chart card's text and plot. The text is laid out when its inputs change;
 * the plot is rebuilt only when its key (type, updatedAt, size, density)
 * does, so a move, a selection or a hover never parses or redraws it. The
 * code-ref badge sits bottom right (badgeAnchor) and shows its count alone
 * on a chart, and the footnote stops short of it.
 */
function drawChart(e: NodeEntry, n: Node, r: Rect, row: Chart | undefined, badge: RefBadge | undefined, dense: boolean): void {
  const type = row?.type ?? 'chart';
  const source = row?.source ?? '';
  const countPx = badge === undefined ? 0 : `${badge.count} ref${badge.count === 1 ? '' : 's'}`.length * BADGE_CHAR_PX;
  const textKey = `${n.label}\n${n.sublabel}\n${type}\n${source}\n${r.w}\n${countPx}\n${textEpoch()}`;
  if (textKey !== e.textKey) {
    const room = Math.max(0, r.w - 2 * CHART_PAD);
    // The tag is a hairline pill sized from its measured text (mock: .kind).
    const pillW = textWidth(type, CHART_TAG_SIZE, true) + 2 * CHART_PILL_PAD;
    const title = ellipsize(n.label, Math.max(0, room - pillW - 8), CHART_TITLE_SIZE, false);
    const sub = ellipsize(n.sublabel, room, CHART_SUB_SIZE, false);
    e.label!.textContent = title.text;
    e.sublabel!.textContent = sub.text;
    e.tag!.textContent = type;
    put(e.tag!, 'x', String(r.w - CHART_PAD - CHART_PILL_PAD));
    put(e.tagBox!, 'x', String(r.w - CHART_PAD - pillW));
    put(e.tagBox!, 'width', String(pillW));
    const foot = e.source!;
    if (source === SAMPLE_SOURCE) {
      // A dashed pill in the footnote position, distinct from the solid tag pill.
      put(foot, 'class', 'chart-source chart-sample');
      put(foot, 'x', String(CHART_PAD + CHART_PILL_PAD));
      put(e.sampleBox!, 'width', String(textWidth('sample data', CHART_SAMPLE_SIZE, true) + 2 * CHART_PILL_PAD));
      if (e.sampleBox!.parentNode !== e.g) {
        foot.before(e.sampleBox!);
      }
      foot.replaceChildren('sample data');
    } else {
      put(foot, 'class', 'chart-source');
      put(foot, 'x', String(CHART_PAD));
      e.sampleBox!.remove();
      const full = source === '' ? '' : `source: ${source}`;
      const right = badge === undefined ? r.w - CHART_PAD : r.w - 10 - countPx - BADGE_GAP;
      const shown = ellipsize(full, Math.max(0, right - CHART_PAD), CHART_FOOT_SIZE, true);
      if (shown.cut) {
        const tip = el('title', {});
        tip.textContent = full;
        foot.replaceChildren(tip, shown.text);
      } else {
        foot.replaceChildren(shown.text);
      }
    }
    // The inline editor opens on the drawn title row, left aligned.
    e.text = {
      lines: [title.text],
      labelY: CHART_TITLE_Y,
      lineHeight: labelLineHeight(CHART_TITLE_SIZE),
      fontSize: CHART_TITLE_SIZE,
      sub: sub.text,
      subY: CHART_SUB_Y,
      room,
      title: '',
      badgeCountOnly: true,
    };
    e.textKey = textKey;
  }
  put(e.source!, 'y', String(r.h - 12));
  put(e.sampleBox!, 'y', String(r.h - 12 - 12));
  // Charts measure their text: a web font that finishes loading lays the plot out again.
  const plotKey = row === undefined
    ? `none|${r.w}|${r.h}|${dense}`
    : `${row.type}|${row.updatedAt.microsSinceUnixEpoch}|${r.w}|${r.h}|${dense}|${textEpoch()}`;
  if (plotKey !== e.plotKey) {
    // Dense drops the subtitle, the axes and the footnote: the plot takes the card's height.
    const top = dense ? CHART_DENSE_TOP : CHART_PLOT_TOP;
    const bottom = dense ? CHART_PAD : CHART_FOOT_H;
    put(e.plot!, 'transform', `translate(${CHART_PAD} ${top})`);
    const box = { x: 0, y: 0, w: Math.max(0, r.w - 2 * CHART_PAD), h: Math.max(0, r.h - top - bottom) };
    const parsed = row === undefined ? null : parsedChart(row);
    e.plot!.replaceChildren(...(parsed?.ok ? renderPlot(parsed.data, box, dense) : [noData(box, parsed?.error ?? '')]));
    e.plotKey = plotKey;
  }
}

/** The quiet state of a chart without a row, or whose data no longer parses. */
function noData(box: Rect, error: string): SVGTextElement {
  const t = el('text', {
    class: 'chart-empty chart-faint',
    x: String(box.w / 2),
    y: String(box.h / 2),
    'text-anchor': 'middle',
    'dominant-baseline': 'middle',
  });
  if (error !== '') {
    const tip = el('title', {});
    tip.textContent = error;
    t.append(tip);
  }
  t.append('no data');
  return t;
}

/** The toolbar anchor of a drawn edge (G35), or null when it is not drawn. */
export function renderedEdgeAnchor(world: SVGGElement, edgeId: bigint): Rect | null {
  return worlds.get(world)?.edges.get(edgeId)?.anchor ?? null;
}

/** The text layout a rendered node was last drawn with (inline editor). */
export function renderedText(world: SVGGElement, id: bigint): NodeTextLayout | null {
  return worlds.get(world)?.nodes.get(id)?.text ?? null;
}

export function renderBoard(
  world: SVGGElement,
  nodes: Node[],
  edges: Edge[],
  state: RenderState
): void {
  const st = bind(world);
  sizeTextCache(nodes.length);
  world.classList.toggle('overlay', state.overlay);
  world.classList.toggle('code', state.codeOverlay);
  world.classList.toggle('dense', state.scale < 0.6);

  const rects = new Map<bigint, Rect>();
  const shapes = new Map<bigint, string>();
  const rectList: Rect[] = new Array(nodes.length);
  for (let i = 0; i < nodes.length; i++) {
    const r = nodeRect(nodes[i], state.overrides);
    rectList[i] = r;
    rects.set(nodes[i].id, r);
    shapes.set(nodes[i].id, shapeOf(nodes[i]));
  }

  // Boundaries are containers by kind; any node geometrically containing
  // another still renders below (legacy boards without kinds).
  const contains = (a: Rect, b: Rect) =>
    a.x <= b.x && a.y <= b.y && a.x + a.w >= b.x + b.w && a.y + a.h >= b.y + b.h;
  const containerIds = new Set<bigint>();
  for (let i = 0; i < nodes.length; i++) {
    if (normalizeKind(nodes[i].kind) === 'boundary') {
      containerIds.add(nodes[i].id);
      continue;
    }
    const r = rectList[i];
    for (let j = 0; j < nodes.length; j++) {
      if (j !== i && contains(r, rectList[j])) {
        containerIds.add(nodes[i].id);
        break;
      }
    }
  }

  // Routes and label boxes are recomputed every render (placement depends on
  // every edge at once); put() keeps an unchanged frame write-free. Routed
  // here, before the nodes, because neighbour focus follows the drawn edges.
  const routes = routeEdges(edges.map(e => ({ id: e.id, from: e.fromNode, to: e.toNode })), rects, shapes);

  // Neighbour focus: the focused node, every node a drawn edge joins it to,
  // and those edges. A focus id that is not drawn focuses nothing; nor does a
  // container (hovering its interior would otherwise dim its own members).
  const focusId = state.focus && rects.has(state.focus.id) && !containerIds.has(state.focus.id) ? state.focus.id : null;
  const nearNodes = new Set<bigint>();
  const nearEdges = new Set<bigint>();
  if (focusId !== null) {
    nearNodes.add(focusId);
    for (const edge of edges) {
      if (routes.has(edge.id) && (edge.fromNode === focusId || edge.toNode === focusId)) {
        nearEdges.add(edge.id);
        nearNodes.add(edge.fromNode);
        nearNodes.add(edge.toNode);
      }
    }
  }
  const blast = state.blast ?? null;
  const blastMoving = blast === null ? null : blastEdgeIds(blast, edges);
  world.classList.toggle('blast-on', blast !== null);
  world.classList.toggle('focus-dim', focusId !== null && blast === null);
  world.classList.toggle('focus-flow', focusId !== null && state.focus!.flow && blast === null);

  // --- nodes ---
  const seen = new Set<bigint>();
  let containersDirty = false;
  let nodesDirty = false;

  for (const n of nodes) {
    seen.add(n.id);
    const r = rects.get(n.id)!;
    const kind = normalizeKind(n.kind);
    const isContainer = containerIds.has(n.id);
    let e = st.nodes.get(n.id);
    if (!e) {
      e = makeNodeEntry(n);
      e.container = isContainer;
      st.nodes.set(n.id, e);
      (isContainer ? st.containers : st.nodesLayer).append(e.g);
      if (state.enter) fadeIn(e.g);
      if (isContainer) {
        containersDirty = true;
      } else {
        nodesDirty = true;
      }
    } else if (isContainer !== e.container) {
      e.container = isContainer;
      (isContainer ? st.containers : st.nodesLayer).append(e.g);
      containersDirty = true;
      nodesDirty = true;
    }

    // An anchor whose notes carry a schema draws as a schema card: its own
    // inner DOM, so the draw kind (not the row's kind) keys the rebuild.
    const anchorNotes = state.notes?.byAnchor.get(n.id);
    const schema = anchorNotes && (kind === 'service' || kind === 'datastore' || kind === 'external') ? mergedSchema(anchorNotes) : null;
    // The tag sits inside the card only while the title still reads beside it.
    const tagInside = schema !== null && anchorNotes !== undefined && tagFitsInside(n, r.w, noteTagText(anchorNotes));
    const drawKind = schema ? 'schema' : kind;
    if (drawKind !== e.kind) {
      buildInner(e, drawKind);
      e.kind = drawKind;
    }

    if (r.x !== e.x || r.y !== e.y) {
      e.g.setAttribute('transform', `translate(${r.x} ${r.y})`);
      e.x = r.x;
      e.y = r.y;
    }
    const shape = shapeOf(n);
    if (r.w !== e.w || r.h !== e.h || shape !== e.shape) {
      e.rect.setAttribute('width', String(r.w));
      e.rect.setAttribute('height', String(r.h));
      if (kind !== 'note' && kind !== 'text') {
        // An SVG rect with rx = w/2 and ry = h/2 IS an ellipse, so shape costs
        // two attributes instead of a different element. data-shape names it
        // for CSS, since rx alone cannot tell a rect from a 20 px pill.
        e.rect.setAttribute('data-shape', shape);
        if (shape === 'ellipse') {
          e.rect.setAttribute('rx', String(r.w / 2));
          e.rect.setAttribute('ry', String(r.h / 2));
        } else if (shape === 'pill') {
          e.rect.setAttribute('rx', String(r.h / 2));
          e.rect.setAttribute('ry', String(r.h / 2));
        } else {
          e.rect.setAttribute('rx', '10');
          e.rect.setAttribute('ry', '10');
        }
      }
      if (e.rule) {
        e.rule.setAttribute('height', String(Math.max(0, r.h - 10)));
      }
      e.w = r.w;
      e.h = r.h;
      e.shape = shape;
    }

    // Blast hop: 0 source, -1 unreached (containers never dim), 1+ the hop it was reached at.
    const blastHop = blast === null ? undefined : n.id === blast.source ? 0 : blast.nodes.get(n.id)?.hop ?? (isContainer ? undefined : -1);
    const cls =
      'node node-' +
      kind +
      (state.nodeDiff?.has(n.id) ? ` diff-${state.nodeDiff.get(n.id)}` : '') +
      (state.ghosts.has(n.id) ? ' ghost' : '') +
      (n.focal ? ' focal' : '') +
      (state.edgeTarget !== null && n.id === state.edgeTarget ? ' edge-target' : '') +
      // Sub-project C styling. '' colour means "derive from kind", which is
      // the pre-C look, so unstyled boards render exactly as before.
      (n.color ? ` color-${n.color}` : '') +
      (n.strokeStyle === 'dashed' ? ' stroke-dashed' : '') +
      (n.size && n.size !== 'm' ? ` size-${n.size}` : '') +
      (nearNodes.has(n.id) ? ' focus-near' : '') +
      (blastHop === undefined ? '' : blastHop === 0 ? ' blast-src' : blastHop === -1 ? ' blast-clear' : blastHop === 1 ? ' blast-hop1' : ' blast-hopn') +
      (anchorNotes ? ` note-${anchorNotes[0].severity}` : '') +
      (schema ? ' schema-card' : '');
    if (cls !== e.cls) {
      e.g.setAttribute('class', cls);
      e.cls = cls;
    }

    // The badge (if any) is decided before the text: the label block keeps
    // clear of the badge row (G36).
    const badge = state.codeOverlay ? state.refsByNode.get(n.id) : undefined;
    // Notes draw no outline: their badge sits like a rect's.
    const badgeShape = kind === 'note' || kind === 'text' ? 'rect' : shape;

    if (kind === 'note') {
      // Re-wrap when the text, the width, or the height (max lines) changes.
      if (n.label !== e.bodyText || r.w !== e.bodyW) {
        e.bodyText = n.label;
        e.bodyW = r.w;
        const maxLines = Math.max(1, Math.floor((r.h - 19) / NOTE_LINE_HEIGHT));
        e.body!.replaceChildren();
        for (const [i, lineText] of wrapText(n.label, r.w).slice(0, maxLines).entries()) {
          const tspan = el('tspan', { x: '0', dy: i === 0 ? '0' : String(NOTE_LINE_HEIGHT) });
          tspan.textContent = lineText;
          e.body!.append(tspan);
        }
      }
    } else if (kind === 'text') {
      const key = `${n.label}\n${n.size}\n${textEpoch()}`;
      if (key !== e.bodyText) {
        e.bodyText = key;
        drawTextBlock(e.body!, n.label, n.size);
      }
    } else if (kind === 'boundary') {
      if (n.label !== e.labelText) {
        e.label!.textContent = n.label;
        e.labelText = n.label;
      }
      // A boundary's icon sits left of its heading, which moves right to clear it.
      const icon = drawableIcon(state.icons?.get(n.id)) && r.w >= 96 && r.h >= 40 ? BOUNDARY_ICON : null;
      put(e.label!, 'x', String(icon ? icon.labelX : 16));
      drawNodeIcon(e, state.icons?.get(n.id), icon);
    } else if (kind === 'chart') {
      drawChart(e, n, r, state.charts?.get(n.id), badge, state.scale < 0.6);
    } else if (schema) {
      drawSchemaCard(e, n, r, schema, tagInside ? noteTagText(anchorNotes!) : '');
    } else {
      const labelCls = `node-label token-${n.token}`;
      if (labelCls !== e.labelCls) {
        e.label!.setAttribute('class', labelCls);
        e.labelCls = labelCls;
      }
      // Laid out inside the stored rect; re-run only when an input changes.
      const dense = state.scale < 0.6;
      const badgeTop = badge !== undefined && !dense ? badgeAnchor(shape, r.w, r.h).y - BADGE_ASCENT : null;
      // An icon sits above the label; the text centres in the band below it.
      const iconId = state.icons?.get(n.id);
      const icon = drawableIcon(iconId) ? iconPlacement(n, r.w, r.h, badgeTop, dense) : null;
      const textTop = icon?.textTop ?? 0;
      const textKey = `${n.label}\n${n.sublabel}\n${n.size}\n${shape}\n${r.w}\n${r.h}\n${badgeTop}\n${dense}\n${textTop}\n${icon !== null}\n${textEpoch()}`;
      if (textKey !== e.textKey) {
        drawNodeText(e, layoutNodeText(n, r.w, r.h, badgeTop, dense, textTop), r.w);
        drawKindMark(e, kind, shape, r.w, icon !== null);
        e.textKey = textKey;
      }
      drawNodeIcon(e, iconId, icon);
    }

    // Revealed hidden rows say which set hid them, right under the ghost.
    const setName = state.ghosts.has(n.id) ? state.ghostSetNames.get(n.id) : undefined;
    const captionText = setName ? `hidden · ${setName}` : '';
    if (captionText !== e.captionText) {
      if (captionText) {
        if (!e.caption) {
          e.caption = el('text', { class: 'ghost-caption', x: '0' });
          e.g.append(e.caption);
        }
        e.caption.setAttribute('y', String(r.h + 16));
        e.caption.textContent = captionText;
      } else if (e.caption) {
        e.caption.remove();
        e.caption = null;
      }
      e.captionText = captionText;
    } else if (e.caption) {
      e.caption.setAttribute('y', String(r.h + 16));
    }

    // Code overlay badge, keyed on (codeOverlay, refsKey). The group is added
    // and removed from the DOM, never CSS-hidden, so exportSvg follows the
    // screen. A badge that goes away fades (class `leaving`, removed after
    // BADGE_FADE_MS); a badge whose key changed is swapped at once so a node
    // never carries two.
    const refsKey = badge !== undefined ? badge.key : '';
    // Laid out above: on a node too short to lift its label clear of the
    // badge, the badge shows its count alone (G36).
    const countOnly = e.text?.badgeCountOnly === true;
    if (refsKey !== e.refsKey || (badge !== undefined && (badgeShape !== e.refsShape || countOnly !== e.refsCountOnly))) {
      if (e.refs !== null) {
        if (badge === undefined) {
          fadeOutBadge(e.refs);
        } else {
          e.refs.remove();
        }
        e.refs = null;
      }
      if (badge !== undefined) {
        e.refs = makeBadge(badge, badgeShape, r.w, r.h, countOnly);
        e.g.append(e.refs);
      }
      e.refsKey = refsKey;
      e.refsShape = badgeShape;
      e.refsCountOnly = countOnly;
    }

    const route = state.routeByNode?.get(n.id);
    const routeKey = route === undefined ? '' : `${route.number}:${route.status}`;
    if (routeKey !== e.routeKey) {
      e.route?.remove();
      e.route = route === undefined ? null : makeRouteMarker(route);
      if (e.route !== null) {
        e.g.append(e.route);
      }
      e.routeKey = routeKey;
    }

    // Change note tag (top right, astride the outline) and reader pip, keyed.
    // On a schema card the tag sits inside, on the title row, like a chart's type tag.
    const tag = anchorNotes ? noteTagText(anchorNotes) : '';
    const tagKey = tag === '' ? '' : `${tag}|${anchorNotes![0].severity}|${r.w}|${tagInside ? 'in' : 'out'}`;
    if (tagKey !== e.noteTagKey) {
      e.noteTag?.remove();
      e.noteTag = tag === '' ? null : makeNoteTag(tag, anchorNotes![0].severity, r.w, tagInside);
      if (e.noteTag !== null) e.g.append(e.noteTag);
      e.noteTagKey = tagKey;
    }
    const pipKey = state.notes?.pips.has(n.id) ? `pip|${r.w}` : '';
    if (pipKey !== e.pipKey) {
      e.pip?.remove();
      e.pip = pipKey === '' ? null : makeReaderPip(r.w);
      if (e.pip !== null) e.g.append(e.pip);
      e.pipKey = pipKey;
    }

    // Threat marker: the top right corner, 26 px left of whatever else sits there.
    const spec = state.threatMarkers?.get(n.id);
    const shift = badge !== undefined || route !== undefined || tag !== '' || pipKey !== '' ? 26 : 0;
    const mKey = spec === undefined ? '' : `${markerKey(spec)}|${r.w}|${shift}`;
    if (mKey !== e.markerKey) {
      e.marker?.remove();
      e.marker = spec === undefined ? null : makeMarker(spec);
      if (e.marker !== null) {
        e.marker.setAttribute('transform', `translate(${r.w - shift} 0)`);
        e.g.append(e.marker);
      }
      e.markerKey = mKey;
    }

    // Hop badge: affected nodes only, left of the threat marker's slot when both sit there.
    const hopBadgeKey = blastHop === undefined || blastHop < 1 ? '' : `${blastHop}|${r.w}|${shift + (spec === undefined ? 0 : 26)}`;
    if (hopBadgeKey !== e.hopBadgeKey) {
      e.hopBadge?.remove();
      e.hopBadge = hopBadgeKey === '' ? null : makeHopBadge(blastHop!);
      if (e.hopBadge !== null) {
        e.hopBadge.setAttribute('transform', `translate(${r.w - shift - (spec === undefined ? 0 : 26)} 0)`);
        e.g.append(e.hopBadge);
      }
      e.hopBadgeKey = hopBadgeKey;
    }

    const area = n.w * n.h;
    if (area !== e.area) {
      e.area = area;
      if (isContainer) {
        containersDirty = true;
      } else {
        nodesDirty = true;
      }
    }
  }

  for (const [id, e] of st.nodes) {
    if (!seen.has(id)) {
      e.g.remove();
      st.nodes.delete(id);
    }
  }

  // Paint order within each layer: largest first, so containers nest visibly
  // and small nodes stay clickable on top. Only re-appended when membership or
  // an area actually changed — drags never reorder.
  const sortLayer = (layer: SVGGElement, wantContainer: boolean) => {
    const desired = nodes
      .filter(n => containerIds.has(n.id) === wantContainer)
      .sort((a, b) => b.w * b.h - a.w * a.h)
      .map(n => st.nodes.get(n.id)!.g);
    let same = layer.children.length === desired.length;
    if (same) {
      for (let i = 0; i < desired.length; i++) {
        if (layer.children[i] !== desired[i]) {
          same = false;
          break;
        }
      }
    }
    if (!same) {
      layer.append(...desired);
    }
  };
  if (containersDirty) {
    sortLayer(st.containers, true);
  }
  if (nodesDirty) {
    sortLayer(st.nodesLayer, false);
  }

  // --- edges ---
  // Code-overlay suffix input (G51). Below 60% zoom it goes with the node
  // badges (P1): removed, not CSS-hidden, so the label re-centres alone and
  // the export follows.
  const refsOf = (edge: Edge): EdgeRefBadge | undefined =>
    state.codeOverlay && state.scale >= 0.6 ? state.refsByEdge?.get(edge.id) : undefined;
  // The label run: label and ` · N refs` in one box, or the count alone. A run
  // wider than the segment it sits on would slide under the nodes, so there
  // the box holds the label alone and the count takes a row under it.
  const ownRow = new Set<bigint>();
  const labelItems: Array<{ id: bigint; route: Route; w: number; h: number }> = [];
  for (const edge of edges) {
    const route = routes.get(edge.id);
    const badge = refsOf(edge);
    const count = badge === undefined ? '' : edgeRefsCount(badge.count);
    // Placement reserves room for the numbers, so revealing them never moves another label.
    const text = edgeText(edge, true, state.live?.get(edge.id));
    if (route === undefined || (text.length === 0 && count.length === 0)) {
      continue;
    }
    const both = text.length > 0 && count.length > 0;
    let w = edgeLabelW(both ? `${text} · ${count}` : text + count);
    if (both && w > route.seg.len) {
      ownRow.add(edge.id);
      w = edgeLabelW(text);
    }
    labelItems.push({ id: edge.id, route, w, h: 18 });
  }
  const labelBoxes = placeLabels(
    labelItems,
    nodes.filter(n => !containerIds.has(n.id)).map(n => rects.get(n.id)!)
  );

  const seenEdges = new Set<bigint>();
  for (const edge of edges) {
    const route = routes.get(edge.id);
    let e = st.edges.get(edge.id);
    if (route === undefined) {
      if (e) {
        e.g.remove();
        e.labels.remove();
        st.edges.delete(edge.id);
      }
      continue;
    }
    seenEdges.add(edge.id);
    if (!e) {
      const g = el('g', { class: 'edge' });
      const title = el('title', {});
      const line = el('path', { class: 'edge-line' });
      // Fat transparent twin so the hairline is clickable.
      const hit = el('path', { class: 'edge-hit' });
      hit.dataset.edgeId = edge.id.toString();
      g.append(title, line, hit);
      st.edgesLayer.append(g);
      const labels = el('g', { class: 'edge-labels' });
      st.edgeLabelsLayer.append(labels);
      if (state.enter) {
        fadeIn(g);
        fadeIn(labels);
      }
      e = {
        g,
        labels,
        line,
        hit,
        title,
        label: null,
        labelBg: null,
        labelHit: null,
        labelText: '',
        refs: null,
        refsText: null,
        refsBg: null,
        refsKey: '',
        reader: null,
        readerKey: '',
        lineCls: '',
        blast: '',
        marker: '',
        selected: false,
        near: false,
        d: '',
        route: null,
        anchor: null,
      };
      st.edges.set(edge.id, e);
    }
    const near = nearEdges.has(edge.id);
    if (near !== e.near) {
      e.g.classList.toggle('focus-near', near);
      e.labels.classList.toggle('focus-near', near);
      e.near = near;
    }
    // Past the dot cap an edge keeps its static dash: blast-still stops the flow.
    const blastCls = blast === null ? '' : blast.edges.has(edge.id) ? `blast-${blast.edges.get(edge.id)! >= 2 ? 'warm' : 'hot'}${blastMoving!.has(edge.id) ? '' : ' blast-still'}` : 'blast-clear';
    if (blastCls !== e.blast) {
      for (const t of [e.g, e.labels]) {
        if (e.blast !== '') t.classList.remove(...e.blast.split(' '));
        if (blastCls !== '') t.classList.add(...blastCls.split(' '));
      }
      e.blast = blastCls;
    }

    const evCls = evidenceClass(edge.evidence, edge.evidenceStatus);
    const title = evCls === 'stale' ? `Stale source citation · ${edge.evidence.slice('source:'.length)}` : edge.evidence;
    if (e.title.textContent !== title) {
      e.title.textContent = title;
    }
    const selected = state.selectedEdges.has(edge.id);
    const reader = state.notes?.edgeStatus.get(edge.id);
    const weight = state.edgeWeights?.get(edge.id);
    const lineCls =
      'edge-line ev-' +
      evCls +
      (reader ? ` reader-${reader.status}` : '') +
      (state.edgeDiff?.has(edge.id) ? ` diff-${state.edgeDiff.get(edge.id)}` : '') +
      (state.ghostEdges.has(edge.id) ? ' ghost' : '') +
      (selected ? ' selected' : '') +
      // '' colour leaves the evidence overlay in charge of how the edge reads.
      (edge.color ? ` color-${edge.color}` : '') +
      (edge.strokeStyle === 'dashed' || edge.strokeStyle === 'dotted' ? ` stroke-${edge.strokeStyle}` : '') +
      // The overlay owns line and weight while it is on; style.css lets these
      // classes apply only while it is off, so the row keeps what was set.
      (weight === 'medium' || weight === 'bold' ? ` weight-${weight}` : '');
    if (lineCls !== e.lineCls) {
      e.line.setAttribute('class', lineCls);
      e.lineCls = lineCls;
    }
    // Warmth from latency (live p50, else the stored value); red when live calls fail.
    // An explicit style wins: the evidence overlay, or a hand-set colour.
    const le = state.live?.get(edge.id);
    const ms = le?.p50 ?? (edge.latencyMs >= 0 ? edge.latencyMs : null);
    const styled = state.overlay || edge.color !== '';
    e.g.classList.toggle('lat-warm', !styled && ms !== null && ms >= WARM_MS && ms < HOT_MS);
    e.g.classList.toggle('lat-hot', !styled && ms !== null && ms >= HOT_MS);
    e.g.classList.toggle('lat-err', !styled && le !== undefined && le.errors > 0);
    e.g.classList.toggle('live', le !== undefined && le.count > 0);
    e.g.classList.toggle('live-rev', le !== undefined && le.reverse);
    const dur = le ? `${flowSeconds(le.rps).toFixed(2)}s` : '';
    if (e.g.style.getPropertyValue('--flow-dur') !== dur) {
      if (dur) e.g.style.setProperty('--flow-dur', dur);
      else e.g.style.removeProperty('--flow-dur');
    }
    const diffColor = state.edgeDiff?.get(edge.id);
    const head = markerFor(evCls, state.overlay, selected, diffColor === 'added' ? 'green' : diffColor === 'removed' ? 'red' : diffColor === 'changed' ? 'blue' : reader?.status === 'stale' ? 'red' : edge.color);
    // The overlay owns weight; with it off, a medium or bold edge takes a head of its weight.
    const marker = !state.overlay && weight !== undefined && WEIGHT_HEAD_PX.has(weight) ? `${head}-${weight}` : head;
    if (marker !== e.marker) {
      e.line.setAttribute('marker-end', `url(#${marker})`);
      e.marker = marker;
    }

    if (route.d !== e.d) {
      e.line.setAttribute('d', route.d);
      e.hit.setAttribute('d', route.d);
      e.d = route.d;
    }
    e.route = route;

    // Change note reader status (spec 2026-10-16 D5): its own row under the
    // line, keyed on its text, placed again when the line moves.
    const readerKey = reader ? `${reader.status}|${reader.label}` : '';
    if (readerKey !== e.readerKey) {
      e.reader?.remove();
      e.reader = reader ? makeReaderLabel(reader.status, reader.label, edge.id) : null;
      if (e.reader !== null) e.labels.append(e.reader);
      e.readerKey = readerKey;
    }

    // Code-overlay suffix (G51), keyed on (codeOverlay, refs key incl. the
    // title revision, suffix text): ` · N refs` after a label, `N refs` alone.
    const refsBadge = refsOf(edge);
    const liveEdge = state.live?.get(edge.id);
    const text = edgeText(edge, selected || near, liveEdge);
    const refsCount = refsBadge === undefined ? '' : edgeRefsCount(refsBadge.count);
    const refsLabel = refsBadge === undefined ? '' : text.length > 0 ? ` · ${refsCount}` : refsCount;
    const refsKey = refsBadge === undefined ? '' : `${refsBadge.key}|${refsLabel}`;
    let refsNew = false;
    if (refsKey !== e.refsKey) {
      e.refs?.remove();
      e.refs = null;
      e.refsText = null;
      e.refsBg = null;
      if (refsBadge !== undefined) {
        const made = makeEdgeRefs(refsBadge, edge.id);
        e.refs = made.g;
        e.refsText = made.text;
        refsNew = true;
      }
      e.refsKey = refsKey;
    }

    const box = labelBoxes.get(edge.id);
    if (box !== undefined) {
      if (!e.label) {
        e.labelBg = el('rect', { class: 'edge-label-bg', height: '18' });
        e.label = el('text', { class: 'edge-label', 'text-anchor': 'middle' });
        e.labelHit = el('rect', {
          height: '18',
          fill: 'transparent',
          stroke: 'none',
          cursor: 'pointer',
        });
        e.labelHit.dataset.edgeId = edge.id.toString();
        e.labels.append(e.labelBg, e.label, e.labelHit);
      }
      const selCls = selected ? ' selected' : '';
      if (e.label.getAttribute('class') !== `edge-label${selCls}`) {
        e.label.setAttribute('class', `edge-label${selCls}`);
        e.labelBg!.setAttribute('class', `edge-label-bg${selCls}`);
      }
      if (text !== e.labelText) {
        e.label.textContent = text;
        e.labelText = text;
      }
      // The box is centred on the line and sized for the label with its
      // numbers; what is drawn now (maybe without them) centres inside it, on
      // a paper backing that hides the line under the text. The suffix follows.
      const labelW = text.length * EDGE_CHAR_PX;
      const inlineRefs = e.refsText !== null && !ownRow.has(edge.id);
      const drawnW = Math.min(box.w, inlineRefs ? edgeLabelW(text.length > 0 ? `${text} · ${refsCount}` : refsCount) : edgeLabelW(text));
      const x0 = box.x + (box.w - drawnW) / 2;
      const baseline = String(box.y + 13);
      put(e.labelBg!, 'x', String(x0));
      put(e.labelBg!, 'y', String(box.y));
      put(e.labelBg!, 'width', String(drawnW));
      put(e.label, 'x', String(x0 + 4 + labelW / 2));
      put(e.label, 'y', baseline);
      put(e.labelHit!, 'x', String(box.x));
      put(e.labelHit!, 'y', String(box.y));
      put(e.labelHit!, 'width', String(box.w));
      e.anchor = box;
      if (e.refsText !== null) {
        // SVG drops a text's leading space: the gap is an x offset.
        const own = ownRow.has(edge.id);
        const shown = own ? refsCount : text.length > 0 ? `· ${refsCount}` : refsCount;
        if (e.refsText.textContent !== shown) {
          e.refsText.textContent = shown;
        }
        if (own) {
          const rw = edgeLabelW(refsCount);
          const row = { x: box.x + box.w / 2 - rw / 2, y: box.y + 18, w: rw, h: 18 };
          if (e.refsBg === null) {
            e.refsBg = el('rect', { class: 'edge-label-bg', height: '18' });
            e.refs!.insertBefore(e.refsBg, e.refsText);
          }
          put(e.refsBg, 'x', String(row.x));
          put(e.refsBg, 'y', String(row.y));
          put(e.refsBg, 'width', String(row.w));
          put(e.refsText, 'x', String(row.x + 4));
          put(e.refsText, 'y', String(row.y + 13));
          const x = Math.min(box.x, row.x);
          e.anchor = { x, y: box.y, w: Math.max(box.x + box.w, row.x + row.w) - x, h: 36 };
        } else {
          e.refsBg?.remove();
          e.refsBg = null;
          put(e.refsText, 'x', String(x0 + 4 + labelW + (text.length > 0 ? EDGE_CHAR_PX : 0)));
          put(e.refsText, 'y', baseline);
        }
      }
      if (refsNew) {
        // Above the label's hit box, so the suffix's <title> takes hover.
        e.labels.append(e.refs!);
      }
    } else {
      const { a, b } = route.seg;
      e.anchor = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, w: 0, h: 0 };
      if (e.label) {
        e.label.remove();
        e.labelBg!.remove();
        e.labelHit!.remove();
        e.label = null;
        e.labelBg = null;
        e.labelHit = null;
        e.labelText = '';
      }
    }
    // Placed after the label run: the row under the label (or under its own-row
    // ref count), or under the longest segment's midpoint when the edge draws no text.
    if (e.reader !== null) {
      const { a, b } = route.seg;
      const mx = box ? box.x + box.w / 2 : (a.x + b.x) / 2;
      const top = box ? box.y + (ownRow.has(edge.id) ? 36 : 18) : (a.y + b.y) / 2 + 4;
      const at = `${mx},${top}`;
      if (e.reader.dataset.at !== at) {
        placeReaderLabel(e.reader, mx, top, reader!.label);
        e.reader.dataset.at = at;
      }
    }
    e.selected = selected;
  }

  for (const [id, e] of st.edges) {
    if (!seenEdges.has(id)) {
      e.g.remove();
      e.labels.remove(); // takes the reader row with it
      st.edges.delete(id);
    }
  }

  // Keep edge paint order equal to input order, as the full rebuild did —
  // a recreated edge (endpoint hide/unhide cycle) must not jump to the top.
  const desiredEdges: SVGGElement[] = [];
  for (const edge of edges) {
    const e = st.edges.get(edge.id);
    if (e) {
      desiredEdges.push(e.g);
    }
  }
  let edgesSame = st.edgesLayer.children.length === desiredEdges.length;
  if (edgesSame) {
    for (let i = 0; i < desiredEdges.length; i++) {
      if (st.edgesLayer.children[i] !== desiredEdges[i]) {
        edgesSame = false;
        break;
      }
    }
  }
  if (!edgesSame) {
    st.edgesLayer.append(...desiredEdges);
  }
  // Labels keep the same order in their own layer.
  const desiredLabels: SVGGElement[] = [];
  for (const edge of edges) {
    const e = st.edges.get(edge.id);
    if (e) {
      desiredLabels.push(e.labels);
    }
  }
  const labelsLayer = st.edgeLabelsLayer;
  if (labelsLayer.children.length !== desiredLabels.length || desiredLabels.some((l, i) => labelsLayer.children[i] !== l)) {
    labelsLayer.append(...desiredLabels);
  }

  // --- overlays: selection outline + edge/resize handles, keyed per node,
  // each kind in its own global layer to preserve the old stacking ---
  const seenOverlays = new Set<bigint>();
  const handleR = 5 / state.scale;
  const rh = 6 / state.scale;
  for (const n of nodes) {
    const selected = state.selection.has(n.id);
    const handles = state.handles.has(n.id);
    if (!selected && !handles) {
      continue;
    }
    seenOverlays.add(n.id);
    const r = rects.get(n.id)!;
    // The threat marker can sit on the NE corner: that handle goes so a click on the marker never starts a resize.
    const marked = state.threatMarkers?.has(n.id) === true;
    const sig = `${selected ? 1 : 0}${handles ? 1 : 0}${marked ? 1 : 0}|${r.w}|${r.h}|${state.scale}`;
    let e = st.overlayMap.get(n.id);
    if (!e) {
      e = { outline: null, handle: null, resize: null, x: NaN, y: NaN, sig: '' };
      st.overlayMap.set(n.id, e);
    }
    if (sig !== e.sig) {
      e.sig = sig;
      // Rebuilt groups need their transform written again.
      e.x = NaN;
      e.y = NaN;

      if (selected) {
        if (!e.outline) {
          e.outline = el('g', {});
          st.outlineLayer.append(e.outline);
        }
        e.outline.replaceChildren(
          // Dashed hairline offset 4px outside — never accent.
          el('rect', {
            class: 'selection-outline',
            x: '-4',
            y: '-4',
            width: String(r.w + 8),
            height: String(r.h + 8),
            rx: '12',
          })
        );
      } else if (e.outline) {
        e.outline.remove();
        e.outline = null;
      }

      if (handles) {
        if (!e.handle) {
          e.handle = el('g', {});
          st.handleLayer.append(e.handle);
        }
        e.handle.replaceChildren();
        const mids: Array<[number, number]> = [
          [r.w / 2, 0],
          [r.w, r.h / 2],
          [r.w / 2, r.h],
          [0, r.h / 2],
        ];
        for (const [hx, hy] of mids) {
          const c = el('circle', {
            class: 'edge-handle',
            cx: String(hx),
            cy: String(hy),
            r: String(handleR),
          });
          c.dataset.nodeId = n.id.toString();
          e.handle.append(c);
        }
      } else if (e.handle) {
        e.handle.remove();
        e.handle = null;
      }

      if (selected) {
        if (!e.resize) {
          e.resize = el('g', {});
          st.resizeLayer.append(e.resize);
        }
        e.resize.replaceChildren();
        const corners: Array<[string, number, number]> = [
          ['nw', 0, 0],
          ['ne', r.w, 0],
          ['sw', 0, r.h],
          ['se', r.w, r.h],
        ];
        for (const [corner, cx, cy] of corners) {
          if (marked && corner === 'ne') continue;
          const sq = el('rect', {
            class: 'resize-handle',
            x: String(cx - rh / 2),
            y: String(cy - rh / 2),
            width: String(rh),
            height: String(rh),
          });
          sq.dataset.nodeId = n.id.toString();
          sq.dataset.corner = corner;
          e.resize.append(sq);
        }
      } else if (e.resize) {
        e.resize.remove();
        e.resize = null;
      }
    }
    if (r.x !== e.x || r.y !== e.y) {
      const transform = `translate(${r.x} ${r.y})`;
      e.outline?.setAttribute('transform', transform);
      e.handle?.setAttribute('transform', transform);
      e.resize?.setAttribute('transform', transform);
      e.x = r.x;
      e.y = r.y;
    }
  }

  for (const [id, e] of st.overlayMap) {
    if (!seenOverlays.has(id)) {
      e.outline?.remove();
      e.handle?.remove();
      e.resize?.remove();
      st.overlayMap.delete(id);
    }
  }
}
