import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DbConnection } from './module_bindings';
import type { Edge, EdgeWeight, Node } from './module_bindings/types';
import { showError } from './chrome';
import { DEFAULT_EDGE_STYLE, History, Ops } from './ops';
import type { LibraryPayloadV1 } from './library';

vi.mock('./chrome', () => ({ showError: vi.fn() }));

// Row ids are unique across this whole file: ops.ts keeps one module-wide set
// of claimed ids, so a second fake that restarted at the same id would never
// resolve its capture.
let next = 5000n;

/** Node, edge and edge weight tables with the server's rules: a weight row
 *  only for medium or bold, and every delete takes an edge's weight with it. */
function fakeConn() {
  const table = <R extends { id: bigint }>() => {
    const rows = new Map<bigint, R>();
    const ins = new Set<(ctx: unknown, r: R) => void>();
    return {
      rows,
      iter: () => rows.values(),
      onInsert: (cb: (ctx: unknown, r: R) => void) => ins.add(cb),
      removeOnInsert: (cb: (ctx: unknown, r: R) => void) => ins.delete(cb),
      insert(r: Omit<R, 'id'>) {
        const row = { ...r, id: next++ } as R;
        rows.set(row.id, row);
        for (const cb of [...ins]) cb(null, row);
        return row;
      },
    };
  };
  const node = table<Node>(), edge = table<Edge>();
  const weights = new Map<bigint, EdgeWeight>();
  const live = (id: bigint) => {
    const e = edge.rows.get(id);
    if (!e) throw new Error(`edge ${id} does not exist`);
    return e;
  };
  const dropEdge = (id: bigint) => { edge.rows.delete(id); weights.delete(id); };
  const reducers = {
    createNode: vi.fn(async (f: Partial<Node>) => {
      node.insert({ token: 'ink', focal: false, doc: '', hidden: false, imported: false, shape: 'rect', color: '', strokeStyle: 'solid', size: 'm', sourceKey: '', ...f } as Node);
    }),
    createEdge: vi.fn(async (f: Partial<Edge>) => {
      edge.insert({ color: '', strokeStyle: 'solid', hidden: false, imported: false, evidenceSnippet: '', evidenceStatus: '', relation: '', latencyMs: -1, latencySource: '', ...f } as Edge);
    }),
    updateEdgeStyle: vi.fn(async ({ edgeId, color, strokeStyle }: { edgeId: bigint; color?: string; strokeStyle?: string }) => {
      const e = live(edgeId);
      edge.rows.set(edgeId, { ...e, color: color ?? e.color, strokeStyle: strokeStyle ?? e.strokeStyle });
    }),
    setEdgeWeight: vi.fn(async ({ edgeId, weight }: { edgeId: bigint; weight: string }) => {
      const e = live(edgeId);
      if (weight === 'regular') weights.delete(edgeId);
      else weights.set(edgeId, { edgeId, boardId: e.boardId, weight });
    }),
    deleteEdge: vi.fn(async ({ edgeId }: { edgeId: bigint }) => { live(edgeId); dropEdge(edgeId); }),
    deleteNode: vi.fn(async ({ nodeId }: { nodeId: bigint }) => {
      for (const e of [...edge.rows.values()]) if (e.fromNode === nodeId || e.toNode === nodeId) dropEdge(e.id);
      node.rows.delete(nodeId);
    }),
  };
  const db = {
    visibleNode: node,
    visibleEdge: edge,
    visibleEdgeWeight: { iter: () => weights.values(), edgeId: { find: (id: bigint) => weights.get(id) } },
    visibleCodeRef: { iter: () => [].values() },
  };
  const ops = new Ops({ db, reducers } as unknown as DbConnection, 'me', new History());
  return { ops, reducers, node, edge, weights };
}

async function drawn(f: ReturnType<typeof fakeConn>) {
  const base = { boardId: 1n, sublabel: '', y: 0, w: 160, h: 80, token: 'ink', focal: false, kind: 'service' };
  const a = await f.ops.createNode({ ...base, label: 'a', x: 0 });
  const b = await f.ops.createNode({ ...base, label: 'b', x: 400 });
  const id = await f.ops.createEdge({ boardId: 1n, fromNode: a, toNode: b, label: 'calls' });
  f.reducers.updateEdgeStyle.mockClear();
  f.reducers.setEdgeWeight.mockClear();
  return { a, b, id, row: () => f.edge.rows.get(id)!, style: () => f.ops.edgeStyle(f.edge.rows.get(id)!) };
}

describe('edge style actions (RC-688)', () => {
  beforeEach(() => vi.mocked(showError).mockClear());

  it("reads a new edge as the default style: no colour, solid, regular", async () => {
    const f = fakeConn();
    const { style } = await drawn(f);
    expect(style()).toEqual(DEFAULT_EDGE_STYLE);
  });

  it('weight goes through set_edge_weight, colour and line through update_edge_style; undo and redo each put back theirs', async () => {
    const f = fakeConn();
    const { id, style } = await drawn(f);
    await f.ops.updateEdgeStyleAction(id, { weight: 'bold' });
    expect(f.reducers.setEdgeWeight).toHaveBeenCalledWith({ edgeId: id, weight: 'bold' });
    expect(f.reducers.updateEdgeStyle).not.toHaveBeenCalled();
    await f.ops.updateEdgeStyleAction(id, { strokeStyle: 'dotted' });
    expect(f.reducers.updateEdgeStyle).toHaveBeenCalledWith({ edgeId: id, color: undefined, strokeStyle: 'dotted' });
    expect(style()).toEqual({ color: '', strokeStyle: 'dotted', weight: 'bold' });
    await f.ops.history.undo();
    expect(style()).toEqual({ color: '', strokeStyle: 'solid', weight: 'bold' });
    await f.ops.history.undo();
    expect(style()).toEqual(DEFAULT_EDGE_STYLE);
    expect(f.weights.size).toBe(0);
    await f.ops.history.redo();
    await f.ops.history.redo();
    expect(style()).toEqual({ color: '', strokeStyle: 'dotted', weight: 'bold' });
    expect(showError).not.toHaveBeenCalled();
  });

  it('a patch that changes nothing writes nothing and adds no undo step', async () => {
    const f = fakeConn();
    const { id, style } = await drawn(f);
    await f.ops.updateEdgeStyleAction(id, { color: 'blue', weight: 'medium' });
    f.reducers.updateEdgeStyle.mockClear();
    f.reducers.setEdgeWeight.mockClear();
    await f.ops.updateEdgeStyleAction(id, { color: 'blue', weight: 'medium' });
    expect(f.reducers.updateEdgeStyle).not.toHaveBeenCalled();
    expect(f.reducers.setEdgeWeight).not.toHaveBeenCalled();
    // so the one undo there is still reverses the real change
    await f.ops.history.undo();
    expect(style()).toEqual(DEFAULT_EDGE_STYLE);
  });

  it('Reset writes only the parts that differ, and one undo brings the whole style back', async () => {
    const f = fakeConn();
    const { id, style } = await drawn(f);
    await f.ops.history.batch('style', async () => {
      await f.ops.updateEdgeStyleAction(id, { color: 'red' });
      await f.ops.updateEdgeStyleAction(id, { weight: 'bold' });
    });
    f.reducers.updateEdgeStyle.mockClear();
    f.reducers.setEdgeWeight.mockClear();
    await f.ops.history.batch('reset style on 1 item', () => f.ops.updateEdgeStyleAction(id, { ...DEFAULT_EDGE_STYLE }));
    expect(f.reducers.updateEdgeStyle.mock.calls).toEqual([[{ edgeId: id, color: '', strokeStyle: undefined }]]);
    expect(f.reducers.setEdgeWeight.mock.calls).toEqual([[{ edgeId: id, weight: 'regular' }]]);
    expect(style()).toEqual(DEFAULT_EDGE_STYLE);
    await f.ops.history.undo();
    expect(style()).toEqual({ color: 'red', strokeStyle: 'solid', weight: 'bold' });
  });

  it("an undo is dropped, not forced, once a collaborator has changed the edge's weight", async () => {
    const f = fakeConn();
    const { id, style } = await drawn(f);
    await f.ops.updateEdgeStyleAction(id, { weight: 'bold' });
    await f.reducers.setEdgeWeight({ edgeId: id, weight: 'medium' }); // someone else
    await f.ops.history.undo();
    expect(style().weight).toBe('medium');
    expect(vi.mocked(showError).mock.calls[0][0]).toMatch(/undo of "style edge" rejected — dropped: it was changed by someone else since/);
  });

  it('undo of an edge delete brings back its colour, line and weight', async () => {
    const f = fakeConn();
    const { id, row } = await drawn(f);
    await f.ops.updateEdgeStyleAction(id, { color: 'green', strokeStyle: 'dotted', weight: 'bold' });
    await f.ops.deleteEdgeAction(row());
    expect(f.edge.rows.size).toBe(0);
    expect(f.weights.size).toBe(0);
    await f.ops.history.undo();
    const [restored] = [...f.edge.rows.values()];
    expect(f.ops.edgeStyle(restored)).toEqual({ color: 'green', strokeStyle: 'dotted', weight: 'bold' });
  });

  it('undo of a node delete brings back the styled edges it took', async () => {
    const f = fakeConn();
    const { a, id, row } = await drawn(f);
    await f.ops.updateEdgeStyleAction(id, { weight: 'medium' });
    const edges = [row()];
    await f.ops.deleteNodesAction([f.node.rows.get(a)!], edges);
    expect(f.weights.size).toBe(0);
    await f.ops.history.undo();
    const [restored] = [...f.edge.rows.values()];
    expect(f.ops.edgeStyle(restored)).toEqual({ color: '', strokeStyle: 'solid', weight: 'medium' });
  });

  it('a restored default edge makes no style calls at all', async () => {
    const f = fakeConn();
    const { row } = await drawn(f);
    await f.ops.deleteEdgeAction(row());
    await f.ops.history.undo();
    expect(f.reducers.updateEdgeStyle).not.toHaveBeenCalled();
    expect(f.reducers.setEdgeWeight).not.toHaveBeenCalled();
  });

  it('a library insert gives each edge its saved weight; an item saved before weights draws regular edges', async () => {
    const payload = (weight?: string): LibraryPayloadV1 => ({
      version: 1,
      nodes: [0, 1].map(key => ({
        key, label: `n${key}`, sublabel: '', x: key * 400, y: 0, w: 160, h: 80, token: 'ink', kind: 'service',
        doc: '', shape: 'rect', color: '', strokeStyle: 'solid', size: 'm',
      })),
      edges: [{ from: 0, to: 1, label: 'calls', color: 'blue', strokeStyle: 'dashed', ...(weight ? { weight } : {}) }],
    });
    const f = fakeConn();
    await f.ops.insertLibraryAction('pair', payload('bold'), { x: 0, y: 0 }, 1n);
    const [bold] = [...f.edge.rows.values()];
    expect(f.ops.edgeStyle(bold)).toEqual({ color: 'blue', strokeStyle: 'dashed', weight: 'bold' });
    const g = fakeConn();
    await g.ops.insertLibraryAction('pair', payload(), { x: 0, y: 0 }, 1n);
    const [plain] = [...g.edge.rows.values()];
    expect(g.ops.edgeStyle(plain)).toEqual({ color: 'blue', strokeStyle: 'dashed', weight: 'regular' });
    expect(g.reducers.setEdgeWeight).not.toHaveBeenCalled();
  });
});
