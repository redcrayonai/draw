import { describe, expect, it } from 'vitest';
import { planLayout, type LayoutEdge, type LayoutNode } from './layout';

const N = (id: number, x: number, y: number, kind = 'service', w = 160, h = 80, hidden = false): LayoutNode => ({
  id: BigInt(id), kind, x, y, w, h, hidden,
});
const E = (id: number, from: number, to: number, label = '', hidden = false): LayoutEdge => ({
  id: BigInt(id), from: BigInt(from), to: BigInt(to), label, hidden,
});

function apply(nodes: LayoutNode[], plan: Awaited<ReturnType<typeof planLayout>>): LayoutNode[] {
  return nodes.map(n => {
    const m = plan.moves.find(p => p.id === n.id);
    const r = plan.resizes.find(p => p.id === n.id);
    return r ? { ...n, ...r } : m ? { ...n, x: m.x, y: m.y } : n;
  });
}
const inside = (b: LayoutNode, n: LayoutNode) => b.x <= n.x && b.y <= n.y && b.x + b.w >= n.x + n.w && b.y + b.h >= n.y + n.h;

describe('planLayout', () => {
  it('lays a chain out left to right', async () => {
    const nodes = [N(1, 0, 400), N(2, 0, 0), N(3, 400, 200)];
    const out = apply(nodes, await planLayout(nodes, [E(1, 1, 2), E(2, 2, 3)]));
    const x = (id: number) => out.find(n => n.id === BigInt(id))!.x;
    expect(x(1)).toBeLessThan(x(2));
    expect(x(2)).toBeLessThan(x(3));
  });
  it('writes only 4px-grid values', async () => {
    const nodes = [N(1, 0, 0, 'service', 164, 84), N(2, 300, 0), N(3, 600, 0, 'boundary', 400, 300), N(4, 640, 40)];
    const plan = await planLayout(nodes, [E(1, 1, 2, 'calls'), E(2, 2, 4, 'reads and writes')]);
    for (const m of plan.moves) expect([m.x % 4, m.y % 4]).toEqual([0, 0]);
    for (const r of plan.resizes) expect([r.x % 4, r.y % 4, r.w % 4, r.h % 4]).toEqual([0, 0, 0, 0]);
  });
  it('keeps members inside their boundary, and nested boundaries nested', async () => {
    const nodes = [
      N(10, 0, 0, 'boundary', 1000, 600),
      N(11, 40, 40, 'boundary', 400, 300),
      N(1, 80, 80),
      N(2, 600, 80),
      N(3, 1200, 80),
    ];
    const out = apply(nodes, await planLayout(nodes, [E(1, 1, 2), E(2, 2, 3)]));
    const get = (id: number) => out.find(n => n.id === BigInt(id))!;
    expect(inside(get(11), get(1))).toBe(true);
    expect(inside(get(10), get(11))).toBe(true);
    expect(inside(get(10), get(2))).toBe(true);
    expect(inside(get(10), get(3))).toBe(false);
  });
  it('keeps members inside any node that contains them, not only a boundary', async () => {
    const nodes = [N(10, 0, 0, 'service', 600, 300), N(1, 40, 60), N(2, 360, 60), N(3, 900, 60)];
    const out = apply(nodes, await planLayout(nodes, [E(1, 1, 2), E(2, 2, 3)]));
    const get = (id: number) => out.find(n => n.id === BigInt(id))!;
    expect(inside(get(10), get(1))).toBe(true);
    expect(inside(get(10), get(2))).toBe(true);
    expect(inside(get(10), get(3))).toBe(false);
  });
  it('never resizes a chart that has a node drawn over it', async () => {
    const nodes = [N(10, 0, 0, 'chart', 400, 300), N(1, 40, 60, 'note', 120, 56)];
    const plan = await planLayout(nodes, []);
    expect(plan.resizes).toEqual([]);
  });
  it('treats a node that only partly overlaps a boundary as outside it', async () => {
    const nodes = [N(10, 0, 0, 'boundary', 300, 200), N(1, 40, 40), N(2, 250, 150)];
    const out = apply(nodes, await planLayout(nodes, [E(1, 1, 2)]));
    const get = (id: number) => out.find(n => n.id === BigInt(id))!;
    expect(inside(get(10), get(1))).toBe(true);
    expect(inside(get(10), get(2))).toBe(false);
  });
  it('never moves hidden nodes and ignores hidden edges and self-loops', async () => {
    const nodes = [N(1, 0, 0), N(2, 400, 0), N(3, 2000, 2000, 'service', 160, 80, true)];
    const plan = await planLayout(nodes, [E(1, 1, 2), E(2, 2, 3), E(3, 1, 1), E(4, 2, 1, '', true)]);
    expect(plan.moves.some(m => m.id === 3n)).toBe(false);
  });
  it('anchors the result at the old top-left', async () => {
    const nodes = [N(1, 400, 200), N(2, 0, 800)];
    const out = apply(nodes, await planLayout(nodes, [E(1, 2, 1)]));
    expect(Math.min(...out.map(n => n.x))).toBe(0);
    expect(Math.min(...out.map(n => n.y))).toBe(200);
  });
  it('is a no-op on its own output', async () => {
    const nodes = [N(1, 0, 400), N(2, 0, 0), N(3, 400, 200), N(10, 600, 0, 'boundary', 300, 300)];
    const edges = [E(1, 1, 2, 'calls'), E(2, 2, 3)];
    const once = apply(nodes, await planLayout(nodes, edges));
    const again = await planLayout(once, edges);
    expect(again).toEqual({ moves: [], resizes: [] });
  });
  it('keeps an empty boundary at its own size', async () => {
    const nodes = [N(1, 0, 0), N(10, 400, 0, 'boundary', 300, 200)];
    const out = apply(nodes, await planLayout(nodes, []));
    const b = out.find(n => n.id === 10n)!;
    expect([b.w, b.h]).toEqual([300, 200]);
  });
  it('spaces members inside a boundary like the root does', async () => {
    const nodes = [N(1, 0, 0), N(10, 400, 0, 'boundary', 400, 600), N(2, 440, 60), N(3, 440, 200), N(4, 440, 340)];
    const out = apply(nodes, await planLayout(nodes, [E(1, 1, 2), E(2, 1, 3), E(3, 1, 4)]));
    const ys = [2, 3, 4].map(id => out.find(n => n.id === BigInt(id)!)!).sort((a, b) => a.y - b.y);
    for (let i = 1; i < ys.length; i++) expect(ys[i].y - (ys[i - 1].y + ys[i - 1].h)).toBeGreaterThanOrEqual(48);
  });
  it('returns an empty plan for an empty board', async () => {
    expect(await planLayout([], [])).toEqual({ moves: [], resizes: [] });
  });
});
