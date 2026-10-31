import { describe, it, expect } from 'vitest';
import {
  snap,
  readingOrder,
  tidyGrid,
  distributeHorizontally,
  connectInOrder,
  type Box,
} from './layout';

function box(id: number, x: number, y: number, w = 180, h = 64): Box {
  return { id: BigInt(id), x, y, w, h };
}

describe('snap', () => {
  it('rounds to the 8px board grid', () => {
    expect(snap(0)).toBe(0);
    expect(snap(3)).toBe(0);
    expect(snap(5)).toBe(8);
    expect(snap(-3)).toBe(-0);
    expect(snap(101)).toBe(104);
  });
});

describe('readingOrder', () => {
  it('bands rows, then sorts left to right inside a band', () => {
    // y=10 and y=30 are the same visual row; 200 is the row below.
    const ordered = readingOrder([box(1, 500, 30), box(2, 100, 10), box(3, 300, 200)]);
    expect(ordered.map(b => Number(b.id))).toEqual([2, 1, 3]);
  });

  it('is deterministic for exactly coincident boxes', () => {
    const a = readingOrder([box(9, 0, 0), box(4, 0, 0)]).map(b => Number(b.id));
    const b = readingOrder([box(4, 0, 0), box(9, 0, 0)]).map(x => Number(x.id));
    expect(a).toEqual(b);
    expect(a).toEqual([4, 9]);
  });
});

describe('tidyGrid', () => {
  it('packs four boxes into a 2x2 anchored at the selection top-left', () => {
    const plan = tidyGrid([box(1, 13, 11), box(2, 400, 20), box(3, 30, 300), box(4, 420, 310)], 48);
    expect(plan.cols).toBe(2);
    expect(plan.rows).toBe(2);
    expect(plan.cellW).toBe(180);
    expect(plan.cellH).toBe(64);

    const to = new Map(plan.placements.map(p => [Number(p.nodeId), p.to]));
    // origin snaps to (16, 8); step is cell + gap = 228 across, 112 down
    expect(to.get(1)).toEqual({ x: 16, y: 8 });
    expect(to.get(2)).toEqual({ x: 244, y: 8 });
    expect(to.get(3)).toEqual({ x: 16, y: 120 });
    expect(to.get(4)).toEqual({ x: 244, y: 120 });
  });

  it('sizes every cell to the largest member so the grid stays uniform', () => {
    const plan = tidyGrid([box(1, 0, 0, 100, 40), box(2, 500, 0, 260, 90)], 10);
    expect(plan.cellW).toBe(260);
    expect(plan.cellH).toBe(90);
    const to = new Map(plan.placements.map(p => [Number(p.nodeId), p.to]));
    expect(to.get(2)).toEqual({ x: 270, y: 0 });
  });

  it('emits no move for a box already in place', () => {
    // single box: cols=1, origin is its own snapped position
    const plan = tidyGrid([box(1, 16, 24)], 48);
    expect(plan.placements).toEqual([]);
  });

  it('handles an empty selection', () => {
    expect(tidyGrid([]).placements).toEqual([]);
  });

  it('every placement carries the original position for undo', () => {
    const plan = tidyGrid([box(1, 13, 11), box(2, 400, 20)], 48);
    const p = plan.placements.find(x => Number(x.nodeId) === 2);
    expect(p?.from).toEqual({ x: 400, y: 20 });
  });
});

describe('distributeHorizontally', () => {
  it('equalises gaps and holds the outer edges', () => {
    // span 0..1000, three 200-wide boxes => 400 of slack over 2 gaps
    const out = distributeHorizontally([box(1, 0, 0, 200), box(2, 50, 0, 200), box(3, 800, 0, 200)]);
    const to = new Map(out.map(p => [Number(p.nodeId), p.to.x]));
    expect(to.get(2)).toBe(400);
    // the outer boxes do not move, so they emit no placement
    expect(to.has(1)).toBe(false);
    expect(to.has(3)).toBe(false);
  });

  it('holds the outer edges even when the gap is fractional', () => {
    // span 0..433 with three 100-wide boxes => gap 66.5, so an accumulated
    // cursor snaps the last box off its original x unless it is excluded.
    const out = distributeHorizontally([
      box(1, 0, 0, 100),
      box(2, 50, 0, 100),
      box(3, 333, 0, 100),
    ]);
    const moved = out.map(p => Number(p.nodeId));
    expect(moved).not.toContain(1);
    expect(moved).not.toContain(3);
    expect(moved).toEqual([2]);
  });

  it('does nothing with fewer than three boxes', () => {
    expect(distributeHorizontally([box(1, 0, 0), box(2, 900, 0)])).toEqual([]);
    expect(distributeHorizontally([])).toEqual([]);
  });

  it('leaves y untouched', () => {
    const out = distributeHorizontally([box(1, 0, 5, 100), box(2, 50, 77, 100), box(3, 600, 9, 100)]);
    const moved = out.find(p => Number(p.nodeId) === 2);
    expect(moved?.to.y).toBe(77);
  });
});

describe('connectInOrder', () => {
  it('chains the selection in reading order', () => {
    const pairs = connectInOrder([box(3, 300, 200), box(1, 100, 10), box(2, 500, 20)]);
    expect(pairs.map(p => [Number(p.from), Number(p.to)])).toEqual([
      [1, 2],
      [2, 3],
    ]);
  });

  it('needs at least two nodes to make an edge', () => {
    expect(connectInOrder([box(1, 0, 0)])).toEqual([]);
    expect(connectInOrder([])).toEqual([]);
  });
});
