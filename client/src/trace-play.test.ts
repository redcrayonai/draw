import { describe, expect, it } from 'vitest';
import { traceSchedule } from './trace-play';

const span = (id: string, node: string, startMs: number, durationMs: number, parent: string | null = null) =>
  ({ id, parent, node, startMs, durationMs, status: 'ok' as const });

describe('traceSchedule', () => {
  it('slows a short trace to about nine seconds and hops only across nodes', () => {
    const { slowdown, totalMs, steps } = traceSchedule([
      span('b', '2', 10, 100, 'a'),
      span('a', '1', 0, 200),
      span('c', '2', 20, 30, 'b'),
    ]);
    expect(totalMs).toBe(200);
    expect(slowdown).toBe(45);
    expect(steps.map(s => [s.span.id, s.from, s.node, s.start, s.end])).toEqual([
      ['a', null, 1n, 0, 9000],
      ['b', 1n, 2n, 450, 4950],
      ['c', null, 2n, 900, 2250],
    ]);
    expect(steps[1].hopMs).toBe(720);
    expect(steps[2].hopMs).toBe(0);
  });

  it('never plays faster than real time, nor slower than 300x', () => {
    expect(traceSchedule([span('a', '1', 0, 60_000)]).slowdown).toBe(1);
    expect(traceSchedule([span('a', '1', 0, 1)]).slowdown).toBe(300);
  });
});
