import { afterEach, describe, expect, it, vi } from 'vitest';
import { blastRadius } from './blast';
import { blastEdgeIds, blastLegs, loopBlast, MAX_DOTS, playSpread } from './blast-play';

const e = (id: number, fromNode: number, toNode: number, label = '') => ({ id: BigInt(id), fromNode: BigInt(fromNode), toNode: BigInt(toNode), label });
const ids = (...n: number[]) => n.map(BigInt);
const label = (id: bigint) => `n${id}`;

// auth(3) is the source. gateway(1) -> auth, pay(6) -> auth ("verify"), pay -> stripe(7).
const MOCK = [e(1, 1, 3), e(2, 6, 3, 'verify'), e(3, 6, 7)];

afterEach(() => vi.unstubAllGlobals());

describe('blastLegs', () => {
  const blast = blastRadius(3n, ids(1, 3, 6, 7), MOCK, label, { direction: 'both', depth: 'all' });

  it('orients every leg away from the source: pay -> auth plays auth -> pay, reversed', () => {
    const legs = blastLegs(blast, MOCK);
    expect(legs.find(l => l.edgeId === 2n)).toEqual({ from: 3n, to: 6n, edgeId: 2n, reverse: true, latencyMs: null });
    expect(legs.find(l => l.edgeId === 1n)).toEqual({ from: 3n, to: 1n, edgeId: 1n, reverse: true, latencyMs: null });
    expect(legs.find(l => l.edgeId === 3n)).toEqual({ from: 6n, to: 7n, edgeId: 3n, reverse: false, latencyMs: null });
  });

  it('puts hop 1 legs before hop 2', () => {
    expect(blastLegs(blast, MOCK).map(l => l.edgeId)).toEqual([1n, 2n, 3n]);
  });

  it('caps a 300 edge blast at 40 legs', () => {
    const edges = Array.from({ length: 300 }, (_, i) => e(i + 1, 0, i + 1));
    const big = blastRadius(0n, [0n, ...edges.map(x => x.toNode)], edges, label, { direction: 'reaches', depth: 'all' });
    expect(blastLegs(big, edges)).toHaveLength(MAX_DOTS);
    expect(MAX_DOTS).toBe(40);
    expect([...blastEdgeIds(big, edges)]).toEqual(blastLegs(big, edges).map(l => l.edgeId));
  });
});

describe('reduced motion', () => {
  const reduce = () => vi.stubGlobal('matchMedia', () => ({ matches: true }));
  const legs = [{ from: 1n, to: 2n, edgeId: null, reverse: false, latencyMs: null }];
  const world = () => document.createElementNS('http://www.w3.org/2000/svg', 'g');

  it('loopBlast adds nothing and stop is safe', () => {
    reduce();
    const w = world();
    const loop = loopBlast(w, legs, () => ({ x: 0, y: 0 }));
    expect(w.childElementCount).toBe(0);
    expect(() => loop.stop()).not.toThrow();
  });

  it('playSpread resolves at once', async () => {
    reduce();
    const w = world();
    await playSpread(w, legs, () => ({ x: 0, y: 0 }));
    expect(w.childElementCount).toBe(0);
  });
});

describe('loopBlast', () => {
  it('runs one comet per leg, warm for hop 2, and stop removes them', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    const w = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    const blast = blastRadius(3n, ids(1, 3, 6, 7), MOCK, label, { direction: 'both', depth: 'all' });
    const loop = loopBlast(w, blastLegs(blast, MOCK), () => ({ x: 0, y: 0 }));
    expect(w.querySelectorAll('.route-comet')).toHaveLength(3);
    expect(w.querySelectorAll('.blast-dot.warm')).toHaveLength(1);
    expect(w.querySelectorAll('.blast-dot')).toHaveLength(3);
    const cancel = vi.spyOn(globalThis, 'cancelAnimationFrame');
    loop.stop();
    expect(cancel).toHaveBeenCalled();
    expect(w.querySelectorAll('.route-comet')).toHaveLength(0);
    cancel.mockRestore();
  });
});
