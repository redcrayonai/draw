import { describe, expect, it } from 'vitest';
import { easeInOut, legMs, routeLegs } from './route-play';

const e = (id: bigint, fromNode: bigint, toNode: bigint, latencyMs = -1) => ({ id, fromNode, toNode, latencyMs });

describe('routeLegs', () => {
  it('follows the edge between consecutive waypoints, backwards when it points the other way', () => {
    expect(routeLegs([1n, 2n, 3n], [e(10n, 1n, 2n, 38), e(11n, 3n, 2n)])).toEqual([
      { from: 1n, to: 2n, edgeId: 10n, reverse: false, latencyMs: 38 },
      { from: 2n, to: 3n, edgeId: 11n, reverse: true, latencyMs: null },
    ]);
  });

  it('prefers the forward edge and falls back to a straight leg when none joins them', () => {
    expect(routeLegs([1n, 2n, 4n], [e(12n, 2n, 1n), e(10n, 1n, 2n)])).toEqual([
      { from: 1n, to: 2n, edgeId: 10n, reverse: false, latencyMs: null },
      { from: 2n, to: 4n, edgeId: null, reverse: false, latencyMs: null },
    ]);
  });

  it('has no legs for fewer than two waypoints', () => {
    expect(routeLegs([1n], [])).toEqual([]);
    expect(routeLegs([], [])).toEqual([]);
  });

  it('plays a known latency in slow motion, else by length, within bounds', () => {
    expect(legMs({ latencyMs: 38 }, 66)).toBe(760);
    expect(legMs({ latencyMs: 38 }, 660)).toBe(1500); // a long leg never rushes past twice SPEED
    expect(legMs({ latencyMs: 0.5 }, 10)).toBe(450);
    expect(legMs({ latencyMs: 2000 }, 10)).toBe(4000);
    expect(legMs({ latencyMs: null }, 220)).toBe(1000);
  });

  it('eases in and out: still at both ends, fastest in the middle', () => {
    expect(easeInOut(0)).toBe(0);
    expect(easeInOut(1)).toBe(1);
    expect(easeInOut(0.5)).toBeCloseTo(0.5);
    expect(easeInOut(0.1)).toBeLessThan(0.1);
    expect(easeInOut(0.9)).toBeGreaterThan(0.9);
  });
});
