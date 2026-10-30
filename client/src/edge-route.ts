// client/src/edge-route.ts
/**
 * Edge routing for the board (pure; no DOM). Edges leave and
 * enter by the facing sides of their boxes, ports on a shared side spread
 * apart in the order of their far ends, and a bent edge is an S-curve with a straight landing. Boxes that
 * overlap or nest have no facing sides: those edges keep the straight
 * border-to-border segment. No obstacle avoidance: layout keeps paths clear.
 */
import { borderPoint, type Rect } from './render';

export type Side = 'top' | 'right' | 'bottom' | 'left';
export interface Pt {
  x: number;
  y: number;
}
export interface RouteEdge {
  id: bigint;
  from: bigint;
  to: bigint;
}
export interface Route {
  points: Pt[];
  d: string;
  /** Where the label lives: the longest horizontal segment if at least half the longest overall, else the longest. */
  seg: { a: Pt; b: Pt; len: number };
}

export const CORNER_R = 8;
export const PORT_GAP = 24;
const CHANNEL_GAP = 12;
const CHANNEL_BUCKET = 24;
const LOOP = 24;

const r2 = (n: number): number => Math.round(n * 100) / 100;
const cx = (r: Rect): number => r.x + r.w / 2;
const cy = (r: Rect): number => r.y + r.h / 2;

export function pickSides(a: Rect, b: Rect): { out: Side; in: Side } | null {
  const gx = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w));
  const gy = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h));
  if (gx <= 0 && gy <= 0) {
    return null;
  }
  if (gx >= gy) {
    return cx(b) >= cx(a) ? { out: 'right', in: 'left' } : { out: 'left', in: 'right' };
  }
  return cy(b) >= cy(a) ? { out: 'bottom', in: 'top' } : { out: 'top', in: 'bottom' };
}

export function roundedPath(pts: Pt[], r: number = CORNER_R): string {
  let d = `M${r2(pts[0].x)},${r2(pts[0].y)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const c = pts[i + 1];
    const l1 = Math.hypot(b.x - a.x, b.y - a.y);
    const l2 = Math.hypot(c.x - b.x, c.y - b.y);
    const k = Math.min(r, l1 / 2, l2 / 2);
    if (k < 0.5) {
      d += ` L${r2(b.x)},${r2(b.y)}`;
      continue;
    }
    const p = { x: b.x + ((a.x - b.x) * k) / l1, y: b.y + ((a.y - b.y) * k) / l1 };
    const q = { x: b.x + ((c.x - b.x) * k) / l2, y: b.y + ((c.y - b.y) * k) / l2 };
    d += ` L${r2(p.x)},${r2(p.y)} Q${r2(b.x)},${r2(b.y)} ${r2(q.x)},${r2(q.y)}`;
  }
  const z = pts[pts.length - 1];
  return `${d} L${r2(z.x)},${r2(z.y)}`;
}

const contains = (o: Rect, i: Rect): boolean =>
  o.x <= i.x && o.y <= i.y && o.x + o.w >= i.x + i.w && o.y + o.h >= i.y + i.h;

/**
 * Boxes with no facing sides. When one contains the other (or the centres coincide, larger box
 * outside) the edge runs perpendicular from the inner box's side nearest the outer border out to
 * that border. Plain partial overlap returns null (border-to-border fallback).
 */
function nesting(a: Rect, b: Rect): { innerIsFrom: boolean; side: Side; outer: Rect } | null {
  let innerIsFrom: boolean;
  if (contains(a, b)) {
    innerIsFrom = false;
  } else if (contains(b, a)) {
    innerIsFrom = true;
  } else if (cx(a) === cx(b) && cy(a) === cy(b)) {
    innerIsFrom = a.w * a.h < b.w * b.h;
  } else {
    return null;
  }
  const [o, i] = innerIsFrom ? [b, a] : [a, b];
  const dist: Array<[Side, number]> = [
    ['top', i.y - o.y],
    ['right', o.x + o.w - (i.x + i.w)],
    ['bottom', o.y + o.h - (i.y + i.h)],
    ['left', i.x - o.x],
  ];
  let best = dist[0];
  for (const d of dist) {
    if (d[1] < best[1]) {
      best = d;
    }
  }
  return { innerIsFrom, side: best[0], outer: o };
}

/** Point on `side` of `r` at fraction `t` (left→right, top→bottom), on the drawn outline. */
function portPoint(r: Rect, side: Side, t: number, shape: string): Pt {
  const horizontal = side === 'top' || side === 'bottom';
  if (shape === 'pill') {
    // Rounded rect with corner radius rr: flat run in the middle, circular arcs within rr of either end.
    const rr = Math.min(r.w, r.h) / 2;
    if (horizontal) {
      const x = r.x + t * r.w;
      const ax = x < r.x + rr ? r.x + rr : x > r.x + r.w - rr ? r.x + r.w - rr : null;
      if (ax === null) {
        return { x, y: side === 'top' ? r.y : r.y + r.h };
      }
      const dy = Math.sqrt(Math.max(0, rr * rr - (x - ax) ** 2));
      return { x, y: side === 'top' ? r.y + rr - dy : r.y + r.h - rr + dy };
    }
    const y = r.y + t * r.h;
    const ay = y < r.y + rr ? r.y + rr : y > r.y + r.h - rr ? r.y + r.h - rr : null;
    if (ay === null) {
      return { x: side === 'left' ? r.x : r.x + r.w, y };
    }
    const dx = Math.sqrt(Math.max(0, rr * rr - (y - ay) ** 2));
    return { x: side === 'left' ? r.x + rr - dx : r.x + r.w - rr + dx, y };
  }
  if (shape === 'ellipse') {
    const rx = r.w / 2;
    const ry = r.h / 2;
    if (horizontal) {
      const x = r.x + t * r.w;
      const off = ry * Math.sqrt(Math.max(0, 1 - ((x - cx(r)) / rx) ** 2));
      return { x, y: side === 'top' ? cy(r) - off : cy(r) + off };
    }
    const y = r.y + t * r.h;
    const off = rx * Math.sqrt(Math.max(0, 1 - ((y - cy(r)) / ry) ** 2));
    return { x: side === 'left' ? cx(r) - off : cx(r) + off, y };
  }
  if (horizontal) {
    return { x: r.x + t * r.w, y: side === 'top' ? r.y : r.y + r.h };
  }
  return { x: side === 'left' ? r.x : r.x + r.w, y: r.y + t * r.h };
}

/** Segments longest first (stable on ties). */
function bySize(points: Pt[]): Array<Route['seg']> {
  return points
    .slice(1)
    .map((b, i) => ({ a: points[i], b, len: Math.hypot(b.x - points[i].x, b.y - points[i].y) }))
    .sort((u, v) => v.len - u.len);
}

function labelSeg(points: Pt[]): Route['seg'] {
  // Labels read best on a horizontal run: prefer it unless it is under half the longest.
  const all = bySize(points);
  const flat = all.find(s => Math.abs(s.a.y - s.b.y) < 0.5);
  return flat && flat.len >= all[0].len / 2 ? flat : all[0];
}

function finish(points: Pt[]): Route {
  return { points, d: roundedPath(points), seg: labelSeg(points) };
}

const CURVE_SAMPLES = 8;
const ARROW_LANDING = 12;

/**
 * A Z-edge as an S-curve with a straight landing through the arrowhead.
 * `points` samples the drawn path; `seg` is the curve's middle half.
 */
export function curve(p: Pt, c1: Pt, c2: Pt, q: Pt): Route {
  const dx = q.x - c2.x;
  const dy = q.y - c2.y;
  const length = Math.hypot(dx, dy);
  // The curve must finish before the 8px head; preserve its tangent in tight gaps.
  const landing = length > 0 ? Math.min(ARROW_LANDING, length * 0.75) / length : 0;
  const end = { x: r2(q.x - dx * landing), y: r2(q.y - dy * landing) };
  const at = (t: number): Pt => {
    const u = 1 - t;
    return {
      x: r2(u * u * u * p.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * end.x),
      y: r2(u * u * u * p.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * end.y),
    };
  };
  const points = Array.from({ length: CURVE_SAMPLES + 1 }, (_, i) => at(i / CURVE_SAMPLES));
  points.push({ x: r2(q.x), y: r2(q.y) });
  const a = at(0.25);
  const b = at(0.75);
  return {
    points,
    d: `M${r2(p.x)},${r2(p.y)} C${r2(c1.x)},${r2(c1.y)} ${r2(c2.x)},${r2(c2.y)} ${end.x},${end.y} L${r2(q.x)},${r2(q.y)}`,
    seg: { a, b, len: Math.hypot(b.x - a.x, b.y - a.y) },
  };
}

export function routeEdges(
  edges: RouteEdge[],
  rects: ReadonlyMap<bigint, Rect>,
  shapes: ReadonlyMap<bigint, string>
): Map<bigint, Route> {
  type Slot = { edge: bigint; end: 'out' | 'in'; key: number; t: number };
  const sides = new Map<bigint, { out: Side; in: Side }>();
  const nests = new Map<bigint, NonNullable<ReturnType<typeof nesting>>>();
  const slots = new Map<string, Slot[]>();
  const out = new Map<bigint, Route>();
  const addSlot = (node: bigint, side: Side, s: Slot): void => {
    const k = `${node}:${side}`;
    const list = slots.get(k);
    if (list) {
      list.push(s);
    } else {
      slots.set(k, [s]);
    }
  };

  for (const e of edges) {
    const a = rects.get(e.from);
    const b = rects.get(e.to);
    if (!a || !b || e.from === e.to) {
      continue;
    }
    const along = (side: Side, r: Rect): number => (side === 'top' || side === 'bottom' ? cx(r) : cy(r));
    const s = pickSides(a, b);
    if (s === null) {
      const n = nesting(a, b);
      if (n) {
        nests.set(e.id, n);
        addSlot(n.innerIsFrom ? e.from : e.to, n.side, {
          edge: e.id,
          end: n.innerIsFrom ? 'out' : 'in',
          key: along(n.side, n.outer),
          t: 0.5,
        });
      }
      continue;
    }
    sides.set(e.id, s);
    addSlot(e.from, s.out, { edge: e.id, end: 'out', key: along(s.out, b), t: 0.5 });
    addSlot(e.to, s.in, { edge: e.id, end: 'in', key: along(s.in, a), t: 0.5 });
  }

  const tOf = new Map<string, number>();
  const zs: Array<{ id: bigint; p: Pt; q: Pt; horizontal: boolean }> = [];
  for (const [k, list] of slots) {
    const [node, side] = k.split(':') as [string, Side];
    const r = rects.get(BigInt(node))!;
    const len = side === 'top' || side === 'bottom' ? r.w : r.h;
    list.sort((p, q) => p.key - q.key || (p.edge < q.edge ? -1 : p.edge > q.edge ? 1 : 0));
    const n = list.length;
    const step = n > 1 ? Math.min(PORT_GAP, (0.6 * len) / (n - 1)) / len : 0;
    list.forEach((s, i) => tOf.set(`${s.edge}:${s.end}`, 0.5 + (i - (n - 1) / 2) * step));
  }

  for (const e of edges) {
    const a = rects.get(e.from);
    const b = rects.get(e.to);
    if (!a || !b) {
      continue;
    }
    if (e.from === e.to) {
      const p = { x: a.x + a.w, y: cy(a) };
      out.set(
        e.id,
        finish([p, { x: p.x + LOOP, y: p.y }, { x: p.x + LOOP, y: a.y - LOOP }, { x: cx(a), y: a.y - LOOP }, { x: cx(a), y: a.y }])
      );
      continue;
    }
    const n = nests.get(e.id);
    if (n) {
      const inner = n.innerIsFrom ? a : b;
      const end = n.innerIsFrom ? 'out' : 'in';
      const p = portPoint(inner, n.side, tOf.get(`${e.id}:${end}`)!, shapes.get(n.innerIsFrom ? e.from : e.to) ?? 'rect');
      // shortcut: the outer end sits on the outer's bounding-box border, off the curve for ellipse/pill outers; upgrade if those outers matter
      const o = n.outer;
      const q =
        n.side === 'top' ? { x: p.x, y: o.y } : n.side === 'bottom' ? { x: p.x, y: o.y + o.h } : n.side === 'left' ? { x: o.x, y: p.y } : { x: o.x + o.w, y: p.y };
      out.set(e.id, finish(n.innerIsFrom ? [p, q] : [q, p]));
      continue;
    }
    const s = sides.get(e.id);
    if (!s) {
      const p1 = borderPoint({ x: cx(b), y: cy(b) }, a, shapes.get(e.from) ?? 'rect');
      const p2 = borderPoint({ x: cx(a), y: cy(a) }, b, shapes.get(e.to) ?? 'rect');
      out.set(e.id, finish([p1, p2]));
      continue;
    }
    const p = portPoint(a, s.out, tOf.get(`${e.id}:out`)!, shapes.get(e.from) ?? 'rect');
    const q = portPoint(b, s.in, tOf.get(`${e.id}:in`)!, shapes.get(e.to) ?? 'rect');
    const horizontal = s.out === 'left' || s.out === 'right';
    if (horizontal ? Math.abs(p.y - q.y) < 1 : Math.abs(p.x - q.x) < 1) {
      out.set(e.id, finish([p, horizontal ? { x: q.x, y: p.y } : { x: p.x, y: q.y }]));
      continue;
    }
    zs.push({ id: e.id, p, q, horizontal });
  }

  // Channels: Z-edges whose middle runs would share a line spread apart, ordered so they don't cross.
  const channels = new Map<string, typeof zs>();
  for (const z of zs) {
    const mid = z.horizontal ? (z.p.x + z.q.x) / 2 : (z.p.y + z.q.y) / 2;
    const k = `${z.horizontal ? 'h' : 'v'}:${Math.round(mid / CHANNEL_BUCKET)}`;
    const list = channels.get(k);
    if (list) {
      list.push(z);
    } else {
      channels.set(k, [z]);
    }
  }
  for (const list of channels.values()) {
    const key = (z: (typeof zs)[number]): number => {
      const [port, far] = z.horizontal ? [z.p.y, z.q.y] : [z.p.x, z.q.x];
      const k = far < port ? port : -port;
      // A run heading toward smaller coordinates mirrors the order.
      return (z.horizontal ? z.q.x < z.p.x : z.q.y < z.p.y) ? -k : k;
    };
    list.sort((u, v) => key(u) - key(v) || (u.id < v.id ? -1 : u.id > v.id ? 1 : 0));
    const n = list.length;
    const ends = list.map(({ p, q, horizontal }) => (horizontal ? [p.x, q.x] : [p.y, q.y]).sort((u, v) => u - v));
    // One base and step per group, so runs whose natural mids differ inside the bucket cannot coincide.
    const base = ends.reduce((sum, [lo, hi]) => sum + (lo + hi) / 2, 0) / n;
    const room = Math.min(...ends.map(([lo, hi]) => Math.max(0, (hi - lo) / 2 - 2 * CORNER_R)));
    const step = n > 1 ? Math.min(CHANNEL_GAP, (2 * room) / (n - 1)) : 0;
    list.forEach((z, i) => {
      const { p, q } = z;
      const [lo, hi] = ends[i];
      // Keep the run between this edge's own ports, clear of its corners.
      const c = Math.min(2 * CORNER_R, (hi - lo) / 2);
      const mid = Math.min(Math.max(base + (i - (n - 1) / 2) * step, lo + c), hi - c);
      out.set(z.id, z.horizontal ? curve(p, { x: mid, y: p.y }, { x: mid, y: q.y }, q) : curve(p, { x: p.x, y: mid }, { x: q.x, y: mid }, q));
    });
  }
  return out;
}

const FRACTIONS = [0.5, 0.35, 0.65, 0.2, 0.8];

function hits(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

export function placeLabels(items: Array<{ id: bigint; route: Route; w: number; h: number }>, obstacles: Rect[]): Map<bigint, Rect> {
  const placed: Rect[] = [];
  const out = new Map<bigint, Rect>();
  for (const it of items) {
    const { a, b } = it.route.seg;
    const at = (s: Route['seg'], f: number): Rect => ({
      x: r2(s.a.x + (s.b.x - s.a.x) * f - it.w / 2),
      y: r2(s.a.y + (s.b.y - s.a.y) * f - it.h / 2),
      w: it.w,
      h: it.h,
    });
    const free = (c: Rect): boolean => !placed.some(p => hits(p, c)) && !obstacles.some(o => hits(o, c));
    let box: Rect | undefined;
    for (const s of [it.route.seg, ...bySize(it.route.points).filter(s => s.a !== a || s.b !== b)]) {
      box = FRACTIONS.map(f => at(s, f)).find(free);
      if (box) {
        break;
      }
    }
    box ??= at(it.route.seg, 0.5);
    placed.push(box);
    out.set(it.id, box);
  }
  return out;
}
