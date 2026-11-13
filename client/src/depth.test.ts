import { describe, it, expect } from 'vitest';
import { framesAround, isFrame, surviving, within } from './depth';

const box = (id: bigint, x: number, y: number, w: number, h: number) => ({ id, x, y, w, h });
// company holds payments and search; payments holds checkout and ledger; checkout holds a handler.
const company = box(1n, 0, 0, 2000, 1000);
const payments = box(2n, 100, 100, 900, 600);
const checkout = box(3n, 150, 150, 400, 300);
const handler = box(4n, 200, 200, 160, 80);
const ledger = box(5n, 600, 200, 160, 80);
const search = box(6n, 1200, 100, 160, 80);
const outside = box(7n, 2400, 0, 160, 80);
const all = [company, payments, checkout, handler, ledger, search, outside];
const ids = (nodes: { id: bigint }[]) => nodes.map(node => node.id);

describe('depth', () => {
  it('a frame is a node with something drawn inside it', () => {
    expect(all.filter(node => isFrame(node, all)).map(node => node.id)).toEqual([1n, 2n, 3n]);
  });

  it('within lists every node inside the frame, at any depth below it', () => {
    expect(ids(within(payments, all))).toEqual([3n, 4n, 5n]);
    expect(ids(within(checkout, all))).toEqual([4n]);
    expect(within(ledger, all)).toEqual([]);
  });

  it('a node that only overlaps the frame is not inside it', () => {
    const straddling = box(8n, 950, 150, 160, 80); // crosses payments' right edge
    expect(ids(within(payments, [...all, straddling]))).not.toContain(8n);
  });

  it('framesAround is the way back up, outermost first', () => {
    expect(ids(framesAround(handler, all))).toEqual([1n, 2n, 3n]);
    expect(ids(framesAround(checkout, all))).toEqual([1n, 2n]);
    expect(framesAround(company, all)).toEqual([]);
    expect(framesAround(outside, all)).toEqual([]);
  });

  it('two nodes on the same rectangle nest one way only', () => {
    const twin = box(9n, 100, 100, 900, 600); // drawn exactly over payments
    const nodes = [...all, twin];
    expect(ids(framesAround(twin, nodes))).toEqual([1n, 2n]);
    expect(ids(framesAround(payments, nodes))).toEqual([1n]);
  });

  it('surviving keeps the frame while it still is one, else steps out to the nearest that is', () => {
    const trail = [1n, 2n, 3n];
    expect(surviving(trail, all)).toBe(3n);
    expect(surviving(trail, all.filter(node => node.id !== 4n))).toBe(2n); // checkout emptied
    expect(surviving(trail, all.filter(node => node.id !== 3n && node.id !== 2n))).toBe(1n); // both deleted
    expect(surviving(trail, [outside])).toBeNull();
    expect(surviving([], all)).toBeNull();
  });
});
