import { describe, expect, it } from 'vitest';
import { demoActivity, demoRps, getActivity, IDLE_MS, liveActivity, setActivity } from './activity';

describe('activity', () => {
  it('merges readings by edge and goes idle IDLE_MS after the last one', () => {
    setActivity([{ edgeId: 901n, rps: 4, errRate: 0, observedAt: 1000 }, { edgeId: 902n, rps: 2, errRate: 0, observedAt: 1000 }]);
    setActivity([{ edgeId: 901n, rps: 6, errRate: 0.1, observedAt: 5000 }]);
    expect(getActivity(901n)?.rps).toBe(6);
    expect(getActivity(902n)?.rps).toBe(2);
    expect(liveActivity(902n, 1000 + IDLE_MS - 1)).toBeDefined();
    expect(liveActivity(902n, 1000 + IDLE_MS)).toBeUndefined();
    expect(liveActivity(903n, 1000)).toBeUndefined();
  });

  it('treats zero traffic as idle', () => {
    setActivity([{ edgeId: 904n, rps: 0, errRate: 0, observedAt: 1000 }]);
    expect(liveActivity(904n, 1000)).toBeUndefined();
  });
});

describe('demoActivity', () => {
  const ids = [3n, 1n, 2n, 5n, 4n];

  it('gives each edge the same rate in [2, 12] on every call', () => {
    for (const id of ids) {
      expect(demoRps(id)).toBe(demoRps(id));
      expect(demoRps(id)).toBeGreaterThanOrEqual(2);
      expect(demoRps(id)).toBeLessThan(12);
    }
    expect(new Set(ids.map(demoRps)).size).toBe(ids.length);
  });

  it('errs on 5% of one edge, the busiest', () => {
    const errs = demoActivity(ids, 0).filter(a => a.errRate > 0);
    expect(errs).toHaveLength(1);
    expect(errs[0].errRate).toBe(0.05);
    expect(errs[0].rps).toBe(Math.max(...ids.map(demoRps)));
  });

  it('reports every edge, then pauses the last other than the erring one on alternate 20 s windows', () => {
    const busiest = demoActivity(ids, 0).find(a => a.errRate > 0)!.edgeId;
    const paused = ids.filter(id => id !== busiest).sort((a, b) => Number(a - b)).pop()!;
    expect(demoActivity(ids, 0).map(a => a.edgeId)).toEqual([1n, 2n, 3n, 4n, 5n]);
    expect(demoActivity(ids, 25_000).map(a => a.edgeId)).toEqual([1n, 2n, 3n, 4n, 5n].filter(id => id !== paused));
    expect(demoActivity([7n], 25_000)).toHaveLength(1);
    expect(demoActivity([], 0)).toEqual([]);
  });
});
