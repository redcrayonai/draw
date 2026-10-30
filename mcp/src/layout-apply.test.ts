import { describe, expect, it } from 'vitest';
import { layoutUnits } from './layout-apply';

const node = (id: number, kind: string, x: number, y: number, w: number, h: number, hidden = false) => ({ id: BigInt(id), kind, x, y, w, h, hidden });
const ids = (u: { moves: { id: bigint }[]; resizes: { id: bigint }[] }) => [...u.moves, ...u.resizes].map(r => Number(r.id)).sort((a, b) => a - b);

describe('layoutUnits', () => {
  it('keeps a boundary, its members and nested boundaries in one unit; a free or partly overlapping node is its own', () => {
    const nodes = [
      node(1, 'boundary', 0, 0, 800, 600),
      node(2, 'boundary', 40, 80, 400, 400), // nested in 1
      node(3, 'service', 80, 160, 160, 64), // in 2
      node(4, 'service', 500, 80, 160, 64), // in 1 only
      node(5, 'service', 1000, 0, 160, 64), // outside every boundary
      node(6, 'service', 760, 560, 160, 64), // partly over 1: outside
      node(7, 'boundary', 2000, 0, 200, 200), // an empty boundary
    ];
    const plan = {
      moves: [3, 4, 5, 6].map(id => ({ id: BigInt(id), x: 0, y: 0 })),
      resizes: [1, 2, 7].map(id => ({ id: BigInt(id), x: 0, y: 0, w: 64, h: 48 })),
    };
    const units = layoutUnits(nodes, plan);
    expect(units.map(ids)).toEqual([[1, 2, 3, 4], [5], [6], [7]]);
    expect(units[0].moves.map(m => Number(m.id))).toEqual([3, 4]);
    expect(units[0].resizes.map(r => Number(r.id))).toEqual([1, 2]);
  });

  it('groups a non-boundary node that contains others with its members', () => {
    const nodes = [node(1, 'service', 0, 0, 600, 300), node(2, 'service', 40, 60, 160, 80), node(3, 'service', 360, 60, 160, 80), node(4, 'service', 900, 0, 160, 80)];
    const plan = { moves: [2, 3, 4].map(id => ({ id: BigInt(id), x: 0, y: 0 })), resizes: [{ id: 1n, x: 0, y: 0, w: 64, h: 48 }] };
    expect(layoutUnits(nodes, plan).map(ids)).toEqual([[1, 2, 3], [4]]);
  });

  it('a node whose boundary is hidden is its own unit', () => {
    const nodes = [node(1, 'boundary', 0, 0, 800, 600, true), node(2, 'service', 80, 80, 160, 64)];
    expect(layoutUnits(nodes, { moves: [{ id: 2n, x: 4, y: 4 }], resizes: [] }).map(ids)).toEqual([[2]]);
  });
});
