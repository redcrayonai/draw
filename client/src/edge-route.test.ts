// client/src/edge-route.test.ts
import { describe, expect, it } from 'vitest';
import { pickSides, placeLabels, roundedPath, routeEdges, PORT_GAP, type Pt } from './edge-route';
import type { Rect } from './render';

const R = (x: number, y: number, w = 160, h = 80): Rect => ({ x, y, w, h });
const rects = (...rs: Array<[number, Rect]>) => new Map(rs.map(([id, r]) => [BigInt(id), r]));
const noShapes = new Map<bigint, string>();
const first = (pts: Pt[]) => pts[0];
const last = (pts: Pt[]) => pts[pts.length - 1];

describe('pickSides', () => {
  it('faces right→left when the target is to the right', () => {
    expect(pickSides(R(0, 0), R(400, 0))).toEqual({ out: 'right', in: 'left' });
  });
  it('faces bottom→top when the vertical gap is larger', () => {
    expect(pickSides(R(0, 0), R(40, 400))).toEqual({ out: 'bottom', in: 'top' });
  });
  it('faces left→right and top→bottom in the reverse directions', () => {
    expect(pickSides(R(400, 0), R(0, 0))).toEqual({ out: 'left', in: 'right' });
    expect(pickSides(R(0, 400), R(0, 0))).toEqual({ out: 'top', in: 'bottom' });
  });
  it('returns null for overlapping or nested boxes', () => {
    expect(pickSides(R(0, 0, 400, 400), R(100, 100))).toBeNull();
    expect(pickSides(R(0, 0), R(100, 40))).toBeNull();
  });
});

describe('roundedPath', () => {
  it('draws a straight segment with no curve', () => {
    expect(roundedPath([{ x: 0, y: 0 }, { x: 100, y: 0 }])).toBe('M0,0 L100,0');
  });
  it('rounds each corner with a quadratic of radius 8', () => {
    expect(roundedPath([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }])).toBe(
      'M0,0 L92,0 Q100,0 100,8 L100,100'
    );
  });
  it('shrinks the radius to half of a short segment', () => {
    expect(roundedPath([{ x: 0, y: 0 }, { x: 6, y: 0 }, { x: 6, y: 100 }])).toBe('M0,0 L3,0 Q6,0 6,3 L6,100');
  });
});

describe('routeEdges', () => {
  it('routes an aligned pair as one straight horizontal segment between facing sides', () => {
    const r = routeEdges([{ id: 1n, from: 1n, to: 2n }], rects([1, R(0, 0)], [2, R(400, 0)]), noShapes).get(1n)!;
    expect(r.points).toEqual([{ x: 160, y: 40 }, { x: 400, y: 40 }]);
    expect(r.seg.len).toBe(240);
  });
  it('routes an offset pair as an S-curve with a straight landing', () => {
    const r = routeEdges([{ id: 1n, from: 1n, to: 2n }], rects([1, R(0, 0)], [2, R(400, 200)]), noShapes).get(1n)!;
    expect(r.d).toBe('M160,40 C280,40 280,240 388,240 L400,240');
    expect(r.points).toHaveLength(10);
    expect(r.points[0]).toEqual({ x: 160, y: 40 });
    expect(r.points[4]).toEqual({ x: 278.5, y: 140 });
    expect(r.points[8]).toEqual({ x: 388, y: 240 });
    expect(r.points[9]).toEqual({ x: 400, y: 240 });
  });
  it.each([
    ['right', 400, 200, 12, 0],
    ['left', -400, 200, -12, 0],
    ['down', 200, 400, 0, 12],
    ['up', 200, -400, 0, -12],
  ] as const)('keeps the final arrowhead approach straight when entering %s', (_side, x, y, dx, dy) => {
    const r = routeEdges([{ id: 1n, from: 1n, to: 2n }], rects([1, R(0, 0)], [2, R(x, y)]), noShapes).get(1n)!;
    const [approach, end] = r.points.slice(-2);
    expect({ x: end.x - approach.x, y: end.y - approach.y }).toEqual({ x: dx, y: dy });
    expect(r.d.endsWith(` L${end.x},${end.y}`)).toBe(true);
  });
  it('falls back to a straight border-to-border segment when boxes nest', () => {
    const r = routeEdges([{ id: 1n, from: 1n, to: 2n }], rects([1, R(0, 0, 600, 400)], [2, R(200, 100)]), noShapes).get(1n)!;
    expect(r.points).toHaveLength(2);
    expect(r.d).not.toContain('Q');
  });
  it('spreads several edges on one side PORT_GAP apart, ordered by the far end', () => {
    // node 1 on the left; targets above, level, below on the right
    const rs = rects([1, R(0, 200)], [2, R(400, 0)], [3, R(400, 200)], [4, R(400, 400)]);
    const out = routeEdges(
      [
        { id: 10n, from: 1n, to: 4n },
        { id: 11n, from: 1n, to: 2n },
        { id: 12n, from: 1n, to: 3n },
      ],
      rs,
      noShapes
    );
    const ys = [11n, 12n, 10n].map(id => first(out.get(id)!.points).y);
    expect(ys).toEqual([240 - PORT_GAP, 240, 240 + PORT_GAP]);
    for (const id of [10n, 11n, 12n]) {
      expect(first(out.get(id)!.points).x).toBe(160);
    }
  });
  it('keeps seven ports on one 80px side distinct and on the side', () => {
    const rs = rects([1, R(0, 400)], ...[0, 1, 2, 3, 4, 5, 6].map(i => [i + 2, R(1000, i * 120)] as [number, Rect]));
    const out = routeEdges([0, 1, 2, 3, 4, 5, 6].map(i => ({ id: BigInt(20 + i), from: 1n, to: BigInt(i + 2) })), rs, noShapes);
    const ys = [...out.values()].map(r => first(r.points).y).sort((a, b) => a - b);
    expect(new Set(ys).size).toBe(7);
    expect(ys[0]).toBeGreaterThanOrEqual(400);
    expect(ys[6]).toBeLessThanOrEqual(480);
  });
  it('places an ellipse port on the curve', () => {
    const shapes = new Map([[1n, 'ellipse']]);
    const r = routeEdges([{ id: 1n, from: 1n, to: 2n }], rects([1, R(0, 0)], [2, R(0, 400)]), shapes).get(1n)!;
    expect(first(r.points)).toEqual({ x: 80, y: 80 });
  });
  it('draws a self-loop out of the right side and into the top', () => {
    const r = routeEdges([{ id: 1n, from: 1n, to: 1n }], rects([1, R(0, 0)]), noShapes).get(1n)!;
    expect(first(r.points)).toEqual({ x: 160, y: 40 });
    expect(last(r.points)).toEqual({ x: 80, y: 0 });
  });
  it('skips edges whose endpoint has no rect', () => {
    expect(routeEdges([{ id: 1n, from: 1n, to: 9n }], rects([1, R(0, 0)]), noShapes).size).toBe(0);
  });
  it('is deterministic: identical input gives identical d strings', () => {
    const rs = rects([1, R(0, 0)], [2, R(400, 200)]);
    const a = routeEdges([{ id: 1n, from: 1n, to: 2n }], rs, noShapes).get(1n)!.d;
    const b = routeEdges([{ id: 1n, from: 1n, to: 2n }], rs, noShapes).get(1n)!.d;
    expect(a).toBe(b);
  });
});

type Seg = { a: Pt; b: Pt };
const segs = (pts: Pt[]): Seg[] => pts.slice(1).map((b, i) => ({ a: pts[i], b }));
const side = (a: Pt, b: Pt, c: Pt): number => Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
/** Proper crossing of two segments (touching at an endpoint does not count). */
const crosses = (u: Seg, v: Seg): boolean =>
  side(u.a, u.b, v.a) * side(u.a, u.b, v.b) < 0 && side(v.a, v.b, u.a) * side(v.a, v.b, u.b) < 0;

describe('routeEdges: channels', () => {
  it.each([
    ['right', 0, 600],
    ['left', 600, 0],
  ])('spreads a %s fan-out into distinct middle runs between the boxes, with no crossings', (_dir, sx, tx) => {
    const rs = rects([1, R(sx, 200)], [2, R(tx, 0)], [3, R(tx, 320)], [4, R(tx, 480)]);
    const out = routeEdges([2, 3, 4].map(t => ({ id: BigInt(t), from: 1n, to: BigInt(t) })), rs, noShapes);
    const routes = [2n, 3n, 4n].map(id => out.get(id)!);
    // a curve's midpoint sits 3/4 of the way to its channel's run, so runs 12 apart land 9 apart
    const xs = routes.map(r => r.points[4].x);
    expect(new Set(xs).size).toBe(3);
    const lo = Math.min(sx, tx) + 160;
    const hi = Math.max(sx, tx);
    for (const x of xs) {
      expect(x).toBeGreaterThan(lo);
      expect(x).toBeLessThan(hi);
    }
    const sorted = [...xs].sort((a, b) => a - b);
    expect(sorted[1] - sorted[0]).toBeGreaterThanOrEqual(9);
    expect(sorted[2] - sorted[1]).toBeGreaterThanOrEqual(9);
    for (let i = 0; i < routes.length; i++) {
      for (let j = i + 1; j < routes.length; j++) {
        for (const u of segs(routes[i].points)) {
          for (const v of segs(routes[j].points)) {
            expect(crosses(u, v)).toBe(false);
          }
        }
      }
    }
  });
  it('keeps runs apart when their natural mids differ within one bucket', () => {
    // natural mids 392 and 380 would both land on 386 if each were offset from its own mid
    const rs = rects([1, R(0, 0, 184, 80)], [2, R(0, 300)], [3, R(600, 140)]);
    const out = routeEdges([{ id: 1n, from: 1n, to: 3n }, { id: 2n, from: 2n, to: 3n }], rs, noShapes);
    const [a, b] = [1n, 2n].map(id => out.get(id)!.d.split(' ')[1].slice(1).split(',')[0]).map(Number);
    expect(Math.abs(a - b)).toBeGreaterThanOrEqual(12);
  });
  it('is deterministic across edge order', () => {
    const rs = rects([1, R(0, 200)], [2, R(600, 0)], [3, R(600, 320)], [4, R(600, 480)]);
    const es = [2, 3, 4].map(t => ({ id: BigInt(t), from: 1n, to: BigInt(t) }));
    const a = routeEdges(es, rs, noShapes);
    const b = routeEdges([...es].reverse(), rs, noShapes);
    for (const id of [2n, 3n, 4n]) {
      expect(b.get(id)!.d).toBe(a.get(id)!.d);
    }
  });
});

describe('routeEdges: label run', () => {
  const one = (a: Rect, b: Rect) => routeEdges([{ id: 1n, from: 1n, to: 2n }], rects([1, a], [2, b]), noShapes).get(1n)!;
  it('puts seg on the middle half of a curve', () => {
    for (const r of [one(R(0, 0), R(600, 300)), one(R(0, 0, 160, 400), R(200, 300, 160, 400))]) {
      expect(r.seg.a).toEqual(r.points[2]);
      expect(r.seg.b).toEqual(r.points[6]);
    }
  });
  it('keeps the label run of a straight edge on the line', () => {
    const r = one(R(0, 0), R(400, 0));
    expect(r.seg).toEqual({ a: { x: 160, y: 40 }, b: { x: 400, y: 40 }, len: 240 });
  });
});

describe('routeEdges: nesting and pills', () => {
  const edge = (from: number, to: number) => [{ id: 1n, from: BigInt(from), to: BigInt(to) }];
  const outer = R(0, 0, 600, 400);
  const member = R(200, 100);
  it('runs an off-centre member straight out through its nearest side', () => {
    const up = routeEdges(edge(2, 1), rects([1, outer], [2, member]), noShapes).get(1n)!;
    expect(up.points).toEqual([{ x: 280, y: 100 }, { x: 280, y: 0 }]);
    const down = routeEdges(edge(1, 2), rects([1, outer], [2, member]), noShapes).get(1n)!;
    expect(down.points).toEqual([{ x: 280, y: 0 }, { x: 280, y: 100 }]);
  });
  it('breaks a concentric tie toward the top and keeps a non-zero length', () => {
    const r = routeEdges(edge(2, 1), rects([1, outer], [2, R(220, 160)]), noShapes).get(1n)!;
    expect(r.points).toEqual([{ x: 300, y: 160 }, { x: 300, y: 0 }]);
    expect(r.seg.len).toBe(160);
  });
  it('gives partial overlaps with coincident centres a non-zero straight segment', () => {
    const r = routeEdges(edge(1, 2), rects([1, R(0, 0, 200, 100)], [2, R(40, -20, 120, 140)]), noShapes).get(1n)!;
    expect(r.points).toHaveLength(2);
    expect(r.seg.len).toBeGreaterThan(0);
  });
  it('spreads three pill left-side ports on the outline, all distinct', () => {
    const shapes = new Map([[1n, 'pill']]);
    const rs = rects([1, R(500, 200)], [2, R(0, 0)], [3, R(0, 200)], [4, R(0, 400)]);
    const out = routeEdges([{ id: 1n, from: 1n, to: 2n }, { id: 2n, from: 1n, to: 3n }, { id: 3n, from: 1n, to: 4n }], rs, shapes);
    const starts = [1n, 2n, 3n].map(id => first(out.get(id)!.points));
    expect(new Set(starts.map(p => `${p.x},${p.y}`)).size).toBe(3);
    for (const p of starts) {
      expect(Math.abs(Math.hypot(p.x - 540, p.y - 240) - 40)).toBeLessThan(0.01);
    }
  });
  it('keeps pill top ports on the flat part at the top edge', () => {
    const shapes = new Map([[1n, 'pill']]);
    const rs = rects([1, R(0, 400, 400, 80)], [2, R(0, 0)], [3, R(100, 0)], [4, R(200, 0)]);
    const out = routeEdges([{ id: 1n, from: 1n, to: 2n }, { id: 2n, from: 1n, to: 3n }, { id: 3n, from: 1n, to: 4n }], rs, shapes);
    for (const id of [1n, 2n, 3n]) {
      expect(first(out.get(id)!.points).y).toBe(400);
    }
  });
});

describe('placeLabels', () => {
  const route = (ax: number, ay: number, bx: number, by: number) => ({
    points: [{ x: ax, y: ay }, { x: bx, y: by }],
    d: '',
    seg: { a: { x: ax, y: ay }, b: { x: bx, y: by }, len: Math.hypot(bx - ax, by - ay) },
  });
  it('centres a lone label on the longest segment midpoint', () => {
    const out = placeLabels([{ id: 1n, route: route(0, 100, 400, 100), w: 80, h: 18 }], []);
    expect(out.get(1n)).toEqual({ x: 160, y: 91, w: 80, h: 18 });
  });
  it('slides a second label along its segment instead of overlapping the first', () => {
    const out = placeLabels(
      [
        { id: 1n, route: route(0, 100, 400, 100), w: 80, h: 18 },
        { id: 2n, route: route(0, 104, 400, 104), w: 80, h: 18 },
      ],
      []
    );
    const a = out.get(1n)!;
    const b = out.get(2n)!;
    const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    expect(overlap).toBe(false);
  });
  it('moves to another segment of its route when every seg candidate collides', () => {
    const r = (down: number) => ({
      points: [{ x: 0, y: 100 }, { x: 300, y: 100 }, { x: 300, y: 100 + down }],
      d: '',
      seg: { a: { x: 0, y: 100 }, b: { x: 300, y: 100 }, len: 300 },
    });
    const out = placeLabels(
      [
        { id: 1n, route: r(200), w: 280, h: 18 },
        { id: 2n, route: r(-200), w: 280, h: 18 },
      ],
      []
    );
    const a = out.get(1n)!;
    const b = out.get(2n)!;
    const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    expect(overlap).toBe(false);
  });
  it('avoids a node rect obstacle when a candidate is free', () => {
    const out = placeLabels([{ id: 1n, route: route(0, 100, 400, 100), w: 80, h: 18 }], [{ x: 150, y: 80, w: 100, h: 40 }]);
    const b = out.get(1n)!;
    expect(b.x + b.w <= 150 || b.x >= 250).toBe(true);
  });
});
