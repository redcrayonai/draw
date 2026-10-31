import { describe, expect, it } from 'vitest';
import { easeOut, Glide, GLIDE_MS } from './glide';

describe('Glide', () => {
  it('starts at from, ends at to, eases between', () => {
    const g = new Glide();
    g.begin([{ id: 1n, from: { x: 0, y: 0 }, to: { x: 100, y: 40 } }], 1000);
    expect(g.frame(1000).get(1n)).toEqual({ x: 0, y: 0 });
    const mid = g.frame(1000 + GLIDE_MS / 2).get(1n)!;
    expect(mid.x).toBeCloseTo(100 * easeOut(0.5));
    expect(g.active(1000 + GLIDE_MS / 2)).toBe(true);
    expect(g.frame(1000 + GLIDE_MS).size).toBe(0);
    expect(g.active(1000 + GLIDE_MS)).toBe(false);
  });
  it('restarts a node mid-glide from where it is drawn', () => {
    const g = new Glide();
    g.begin([{ id: 1n, from: { x: 0, y: 0 }, to: { x: 100, y: 0 } }], 0);
    const at = g.frame(GLIDE_MS / 2).get(1n)!;
    g.begin([{ id: 1n, from: { x: 100, y: 0 }, to: { x: 200, y: 0 } }], GLIDE_MS / 2);
    expect(g.frame(GLIDE_MS / 2).get(1n)).toEqual(at);
  });
  it('keeps other nodes gliding when one restarts', () => {
    const g = new Glide();
    g.begin([{ id: 1n, from: { x: 0, y: 0 }, to: { x: 100, y: 0 } }, { id: 2n, from: { x: 0, y: 0 }, to: { x: 0, y: 100 } }], 0);
    g.begin([{ id: 1n, from: { x: 100, y: 0 }, to: { x: 200, y: 0 } }], 100);
    expect(g.frame(150).has(2n)).toBe(true);
  });
  it('a frame straddling the end still gets a final clean step', () => {
    const g = new Glide();
    g.begin([{ id: 1n, from: { x: 0, y: 0 }, to: { x: 100, y: 0 } }], 0);
    const last = g.step(GLIDE_MS - 1);
    expect(last.positions.size).toBe(1);
    expect(last.done).toBe(false);
    const settle = g.step(GLIDE_MS + 50);
    expect(settle.positions.size).toBe(0);
    expect(settle.done).toBe(true);
    expect(g.step(GLIDE_MS + 100)).toEqual({ positions: new Map(), done: true });
  });
  it('cancel drops one track; clear settles all', () => {
    const g = new Glide();
    g.begin([{ id: 1n, from: { x: 0, y: 0 }, to: { x: 100, y: 0 } }, { id: 2n, from: { x: 0, y: 0 }, to: { x: 0, y: 100 } }], 0);
    g.cancel(1n);
    expect([...g.frame(100).keys()]).toEqual([2n]);
    g.clear();
    expect(g.step(100)).toEqual({ positions: new Map(), done: true });
  });
  it('easeOut is 0 at 0 and 1 at 1', () => {
    expect(easeOut(0)).toBe(0);
    expect(easeOut(1)).toBe(1);
  });
});
