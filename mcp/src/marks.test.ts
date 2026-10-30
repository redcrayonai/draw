import { describe, expect, it } from 'vitest';
import { groupByFiles, newSeat } from './marks';

describe('groupByFiles', () => {
  it('unions marks that share a path; a mark with no path stands alone', () => {
    expect(groupByFiles([{ id: 1n, paths: ['a'] }, { id: 2n, paths: ['a', 'b'] }, { id: 3n, paths: ['b'] }, { id: 4n, paths: [] }])).toEqual([[1n, 2n, 3n], [4n]]);
  });
  it('orders groups by their smallest mark id', () => {
    expect(groupByFiles([{ id: 5n, paths: ['x'] }, { id: 2n, paths: ['y'] }, { id: 3n, paths: ['x'] }])).toEqual([[2n], [3n, 5n]]);
  });
});

describe('newSeat', () => {
  it('is 16 alphanumerics and differs per call', () => {
    const a = newSeat();
    expect(a).toMatch(/^[A-Za-z0-9]{16}$/);
    expect(newSeat()).not.toBe(a);
  });
});
