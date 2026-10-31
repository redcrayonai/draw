import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Node } from './module_bindings/types';

function mkNode(i: number): Node {
  return {
    id: BigInt(i), boardId: 1n, label: `component number ${i}`, sublabel: `src/module-${i}.ts`,
    x: i * 10, y: 0, w: 160, h: 80, token: 'ink', focal: false, kind: 'service', doc: '',
    hidden: false, imported: false, shape: 'rect', color: '', strokeStyle: 'solid', size: 'm', sourceKey: '',
  };
}

describe('node text measurement cache (G48)', () => {
  let measure: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    measure = vi.fn((text: string) => ({ width: text.length * 7 }));
    vi.stubGlobal('CanvasRenderingContext2D', class {});
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      () => ({ font: '', measureText: measure }) as unknown as CanvasRenderingContext2D
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const mkState = () => ({
    selection: new Set<bigint>(), selectedEdges: new Set<bigint>(), overrides: new Map(), handles: new Set<bigint>(),
    edgeTarget: null, ghosts: new Set<bigint>(), ghostEdges: new Set<bigint>(), ghostSetNames: new Map<bigint, string>(),
    overlay: false, codeOverlay: false, refsByNode: new Map(), scale: 1,
  });
  const mkWorld = () => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const world = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    svg.append(world);
    return world;
  };

  it('nodeRect never measures: the drawn rect is the stored rect (G2)', async () => {
    const { nodeRect } = await import('./render');
    const nodes = Array.from({ length: 600 }, (_, i) => mkNode(i));
    const rects = nodes.map(n => nodeRect(n, new Map()));
    expect(measure).not.toHaveBeenCalled();
    expect(rects[1]).toEqual({ x: 10, y: 0, w: 160, h: 80 });
  });

  it('600 labelled nodes lay out once, not on every frame', async () => {
    const { renderBoard } = await import('./render');
    const world = mkWorld();
    const nodes = Array.from({ length: 600 }, (_, i) => mkNode(i));
    renderBoard(world, nodes, [], mkState());
    expect(measure).toHaveBeenCalled();
    measure.mockClear();
    renderBoard(world, nodes.map(n => ({ ...n })), [], mkState());
    expect(measure).not.toHaveBeenCalled();
  });

  it('a replaced row (new label) is laid out again', async () => {
    const { renderBoard } = await import('./render');
    const world = mkWorld();
    const n = mkNode(1);
    renderBoard(world, [n], [], mkState());
    measure.mockClear();
    renderBoard(world, [{ ...n, label: 'a much much longer component label than before' }], [], mkState());
    expect(measure).toHaveBeenCalled();
  });

  it('past the limit the oldest strings go first; recent ones stay cached', async () => {
    const { textWidth } = await import('./node-text');
    for (let i = 0; i < 1500; i++) textWidth(`label ${i}`, 15);
    measure.mockClear();
    for (let i = 1000; i < 1500; i++) textWidth(`label ${i}`, 15);
    expect(measure).not.toHaveBeenCalled();
  });
});

describe('the test setup stubs canvas (test/setup.ts)', () => {
  it('getContext is the quiet stub (no jsdom "Not implemented" notice); widths fall back to the estimate', async () => {
    expect(HTMLCanvasElement.prototype.getContext.name).toBe('noCanvas');
    expect(document.createElement('canvas').getContext('2d')).toBeNull();
    vi.resetModules();
    vi.stubGlobal('CanvasRenderingContext2D', class {});
    try {
      const { textWidth } = await import('./node-text');
      expect(textWidth('abcd', 10)).toBeCloseTo(4 * 10 * 0.65, 5);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
