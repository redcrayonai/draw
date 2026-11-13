import { describe, it, expect } from 'vitest';
import { readTellings, stepView, stepMs, stepStart, stepAt, tellingMs, type Telling } from './telling';

const step = (nodes: string[], body = 'x', frame: string[] = []) => ({ nodes, frame, title: 't', body, source: '' });
const t: Telling = { id: 1n, audience: 'a', title: 'T', steps: [step(['1']), step(['2', '3']), step(['4'])] };
const live = new Set([1n, 2n, 3n, 4n]);

describe('stepView', () => {
  it('lights the current step and marks earlier ones seen', () => {
    const v = stepView(t, 1, live);
    expect([...v.lit].sort()).toEqual([2n, 3n]);
    expect([...v.seen]).toEqual([1n]);
    expect([...v.stepOf]).toEqual([[1n, 1], [2n, 2], [3n, 2]]);
    expect(v.frame).toEqual([2n, 3n]);
  });
  it('lights everything at the ending', () => {
    const v = stepView(t, 3, live);
    expect([...v.lit].sort()).toEqual([1n, 2n, 3n, 4n]);
    expect(v.seen.size).toBe(0);
    expect(v.frame).toEqual([1n, 2n, 3n, 4n]);
  });
  it('drops missing nodes', () => {
    expect([...stepView(t, 1, new Set([1n, 3n, 4n])).lit]).toEqual([3n]);
    const only: Telling = { ...t, steps: [step(['9'])] };
    const v = stepView(only, 0, live);
    expect(v.lit.size).toBe(0);
    expect(v.frame).toEqual([]);
  });
  it('uses the frame ids that exist, else the lit ids', () => {
    const f: Telling = { ...t, steps: [step(['1', '2'], 'x', ['3', '9'])] };
    expect(stepView(f, 0, live).frame).toEqual([3n]);
  });
  it('clamps at', () => {
    expect(stepView(t, -4, live).lit).toEqual(stepView(t, 0, live).lit);
    expect(stepView(t, 9, live).lit.size).toBe(4);
  });
});

describe('timing', () => {
  it('clamps step length', () => {
    expect(stepMs(step([], 'x'.repeat(10)))).toBe(3200);
    expect(stepMs(step([], 'x'.repeat(280)))).toBe(9000);
  });
  it('maps time to steps', () => {
    expect(stepAt(t, stepStart(t, 2))).toBe(2);
    expect(stepAt(t, tellingMs(t))).toBe(3);
    expect(stepAt(t, -5)).toBe(0);
  });
});

describe('readTellings', () => {
  const row = (id: bigint, steps: string, boardId = 1n) => ({ id, boardId, audience: 'a', title: 'T', steps });
  it('skips bad rows and other boards, oldest first', () => {
    const ok = JSON.stringify([{ nodes: ['1'], title: 't', body: 'b' }]);
    const r = readTellings([row(5n, ok), row(2n, 'x'), row(3n, ok, 2n), row(1n, ok), row(4n, '[]')], 1n);
    expect(r.map(x => x.id)).toEqual([1n, 5n]);
    expect(r[0].steps[0]).toMatchObject({ nodes: ['1'], frame: [], source: '' });
  });
});
