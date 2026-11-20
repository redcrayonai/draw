import { describe, it, expect } from 'vitest';
import { flowPaint, readFlows } from './flows';
import type { Telling } from './telling';

const step = (...nodes: number[]) => ({ nodes: nodes.map(String), frame: [], title: 't', body: 'b', source: '' });
const telling = (id: number, audience: string, color: string, ...steps: number[][]): Telling => ({ id: BigInt(id), audience, title: `${audience} title`, color, steps: steps.map(s => step(...s)) });
const live = new Set([1n, 2n, 3n, 4n, 5n, 6n]);
// 1 web -> 2 gateway -> 3 cart -> 4 pay ; 2 -> 5 auth ; 6 untouched
const edges = [[10, 1, 2], [11, 2, 3], [12, 3, 4], [13, 2, 5], [14, 5, 6]].map(([id, a, b]) => ({ id: BigInt(id), fromNode: BigInt(a), toNode: BigInt(b) }));
const tellings = [telling(1, 'Checkout', 'blue', [1], [2], [3, 4]), telling(2, 'Product', '', [1, 2, 3]), telling(3, 'Sign-in', 'pink', [1], [2], [5, 99])];

describe('readFlows', () => {
  it('lists only tellings with a colour, with the nodes still on the board and the step that first names each', () => {
    const flows = readFlows(tellings, live);
    expect(flows.map(f => [f.name, f.color, f.steps])).toEqual([['Checkout', 'blue', 3], ['Sign-in', 'pink', 3]]);
    expect([...flows[1].nodes]).toEqual([1n, 2n, 5n]);
    expect(flows[0].stepOf.get(4n)).toBe(3);
  });
});

describe('flowPaint', () => {
  const flows = readFlows(tellings, live);

  it('paints nothing on a board without flows', () => {
    expect(flowPaint([], edges, null)).toBeNull();
  });

  it('with no flow picked: a node or edge one flow uses takes its hue, a shared node gets a dot per flow', () => {
    const p = flowPaint(flows, edges, null)!;
    expect([...p.nodeHue]).toEqual([[3n, 'blue'], [4n, 'blue'], [5n, 'pink']]);
    expect([...p.dots]).toEqual([[1n, ['blue', 'pink']], [2n, ['blue', 'pink']]]);
    // 1->2 is in both flows, so it stays plain; 5->6 leaves the flow
    expect([...p.edgeHue]).toEqual([[11n, 'blue'], [12n, 'blue'], [13n, 'pink']]);
    expect(p.only).toBeNull();
    expect(p.stepOf).toBeNull();
  });

  it('with one picked: its whole path takes its hue, shared trunk too, and the rest is left out', () => {
    const p = flowPaint(flows, edges, 3n)!;
    expect([...p.nodeHue]).toEqual([[1n, 'pink'], [2n, 'pink'], [5n, 'pink']]);
    expect([...p.edgeHue]).toEqual([[10n, 'pink'], [13n, 'pink']]);
    expect(p.dots.size).toBe(0);
    expect([...p.only!]).toEqual([1n, 2n, 5n]);
    expect(p.stepOf!.get(5n)).toBe(3);
  });

  it('a picked flow that is gone falls back to the overview', () => {
    expect(flowPaint(flows, edges, 42n)!.only).toBeNull();
  });
});
