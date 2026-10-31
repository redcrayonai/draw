import { describe, it, expect } from 'vitest';
import type { DbConnection } from './module_bindings';
import type { Chart, Edge, Node } from './module_bindings/types';
import { History, Ops } from './ops';
import type { LibraryPayloadV1 } from './library';

// Row ids are unique across this whole file: ops.ts keeps one module-wide set
// of claimed ids, so a second fake that restarted at the same id would never
// resolve its capture.
let next = 1000n;

interface ChartArgs {
  boardId: bigint; label: string; sublabel: string; x: number; y: number; w: number; h: number;
  type: string; csv: string; options?: string; source?: string;
}

/** In-memory node, edge and chart tables with the server's delete cascade.
 *  `rejectLabel` makes createNode/createChart throw for that label. */
function fakeConn(rejectLabel?: string) {
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
  const chart = new Map<bigint, Chart>();
  const nodeDefaults = {
    token: 'ink', focal: false, doc: '', hidden: false, imported: false,
    shape: 'rect', color: '', strokeStyle: 'solid', size: 'm', sourceKey: '',
  };
  const reducers = {
    createNode: async (f: Partial<Node>) => {
      if (f.label === rejectLabel) throw new Error('grid rule: x = 3 is not divisible by 4; all coordinates and sizes must be multiples of 4');
      node.insert({ ...nodeDefaults, ...f } as Node);
    },
    createChart: async (f: ChartArgs) => {
      if (f.label === rejectLabel) throw new Error('chart size rule: charts must be at least 224x144; got 200x100');
      const row = node.insert({
        ...nodeDefaults, boardId: f.boardId, label: f.label, sublabel: f.sublabel,
        x: f.x, y: f.y, w: f.w, h: f.h, kind: 'chart',
      } as Node);
      chart.set(row.id, {
        nodeId: row.id, boardId: f.boardId, type: f.type, csv: f.csv,
        options: f.options ?? '{}', source: f.source ?? 'human:me',
      } as unknown as Chart);
    },
    createEdge: async (f: Partial<Edge>) => {
      edge.insert({
        color: '', strokeStyle: 'solid', hidden: false, imported: false, evidenceSnippet: '',
        evidenceStatus: '', relation: '', ...f,
      } as Edge);
    },
    updateNode: async ({ nodeId, ...patch }: { nodeId: bigint } & Partial<Node>) => {
      const set = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
      node.rows.set(nodeId, { ...node.rows.get(nodeId)!, ...set });
    },
    setNodeDoc: async ({ nodeId, doc }: { nodeId: bigint; doc: string }) => {
      node.rows.set(nodeId, { ...node.rows.get(nodeId)!, doc });
    },
    updateEdgeStyle: async ({ edgeId, ...style }: { edgeId: bigint; color?: string; strokeStyle?: string }) => {
      const e = edge.rows.get(edgeId)!;
      edge.rows.set(edgeId, { ...e, ...style });
    },
    deleteNode: async ({ nodeId }: { nodeId: bigint }) => {
      for (const e of [...edge.rows.values()]) if (e.fromNode === nodeId || e.toNode === nodeId) edge.rows.delete(e.id);
      chart.delete(nodeId);
      node.rows.delete(nodeId);
    },
  };
  const chartTable = { iter: () => chart.values(), nodeId: { find: (id: bigint) => chart.get(id) } };
  return { conn: { db: { visibleNode: node, visibleEdge: edge, visibleChart: chartTable }, reducers } as unknown as DbConnection, node, edge, chart };
}

const PAYLOAD: LibraryPayloadV1 = {
  version: 1,
  nodes: [
    {
      key: 0, label: 'checkout api', sublabel: 'svc', x: 0, y: 0, w: 160, h: 80, token: 'ink', kind: 'service',
      doc: 'handles carts', shape: 'pill', color: 'blue', strokeStyle: 'solid', size: 'm',
    },
    {
      key: 1, label: 'p99 latency', sublabel: 'ms', x: 200, y: 40, w: 352, h: 224, token: 'ink', kind: 'chart',
      doc: '', shape: 'rect', color: '', strokeStyle: 'solid', size: 'm',
      chart: { type: 'timeseries', csv: 'x,p99\n10:00,12\n10:01,14\n', options: '{"unit":"ms"}', source: 'agent: npm run bench @ abc1234' },
    },
  ],
  edges: [{ from: 0, to: 1, label: 'reports', color: 'red', strokeStyle: 'dashed' }],
};

describe('Ops.insertLibraryAction', () => {
  it('places nodes at the snapped point plus their offsets, charts through createChart, edges between the new ids', async () => {
    const f = fakeConn();
    const ops = new Ops(f.conn, 'me', new History());
    const ids = await ops.insertLibraryAction('checkout panel', PAYLOAD, { x: 102, y: 49 }, 1n);
    expect(ids).toHaveLength(2);
    const [api, latency] = ids.map(id => f.node.rows.get(id)!);
    expect([api.label, api.x, api.y, api.kind, api.shape, api.color, api.doc, api.focal]).toEqual([
      'checkout api', 104, 48, 'service', 'pill', 'blue', 'handles carts', false,
    ]);
    expect([latency.label, latency.sublabel, latency.x, latency.y, latency.w, latency.h, latency.kind]).toEqual([
      'p99 latency', 'ms', 304, 88, 352, 224, 'chart',
    ]);
    const row = f.chart.get(latency.id)!;
    expect([row.type, row.csv, row.options, row.source]).toEqual([
      'timeseries', 'x,p99\n10:00,12\n10:01,14\n', '{"unit":"ms"}', 'agent: npm run bench @ abc1234',
    ]);
    const edges = [...f.edge.rows.values()];
    expect(edges.map(e => [e.fromNode, e.toNode, e.label, e.evidence, e.color, e.strokeStyle])).toEqual([
      [api.id, latency.id, 'reports', 'human:me', 'red', 'dashed'],
    ]);
  });

  it('one undo removes the whole insert; redo rebuilds it with the edge on the new node ids', async () => {
    const f = fakeConn();
    const ops = new Ops(f.conn, 'me', new History());
    const first = await ops.insertLibraryAction('checkout panel', PAYLOAD, { x: 0, y: 0 }, 1n);
    await ops.history.undo();
    expect([f.node.rows.size, f.edge.rows.size, f.chart.size]).toEqual([0, 0, 0]);
    await ops.history.redo();
    const nodes = [...f.node.rows.values()];
    expect(nodes.map(n => n.label).sort()).toEqual(['checkout api', 'p99 latency']);
    expect(nodes.some(n => first.includes(n.id))).toBe(false);
    const byLabel = new Map(nodes.map(n => [n.label, n.id]));
    const [edge] = [...f.edge.rows.values()];
    expect([edge.fromNode, edge.toNode]).toEqual([byLabel.get('checkout api'), byLabel.get('p99 latency')]);
    expect(f.chart.size).toBe(1);
    await ops.history.undo();
    expect([f.node.rows.size, f.edge.rows.size, f.chart.size]).toEqual([0, 0, 0]);
  });

  it('a styled chart keeps its style and doc: create_chart takes neither', async () => {
    const f = fakeConn();
    const ops = new Ops(f.conn, 'me', new History());
    const styled = { ...PAYLOAD.nodes[1], token: 'accent', shape: 'pill', color: 'blue', strokeStyle: 'dashed', size: 'l', doc: 'bench' };
    const [id] = await ops.insertLibraryAction('styled', { version: 1, nodes: [styled], edges: [] }, { x: 0, y: 0 }, 1n);
    const n = f.node.rows.get(id)!;
    expect([n.kind, n.token, n.shape, n.color, n.strokeStyle, n.size, n.doc, n.focal]).toEqual([
      'chart', 'accent', 'pill', 'blue', 'dashed', 'l', 'bench', false,
    ]);
  });

  it('a chart whose doc is refused after create_chart stays in the insert undo', async () => {
    const f = fakeConn();
    (f.conn.reducers as unknown as { setNodeDoc: () => Promise<void> }).setNodeDoc = async () => { throw new Error('doc refused'); };
    const ops = new Ops(f.conn, 'me', new History());
    const withDoc = { ...PAYLOAD.nodes[1], doc: 'bench' };
    await expect(ops.insertLibraryAction('doc', { version: 1, nodes: [withDoc], edges: [] }, { x: 0, y: 0 }, 1n)).rejects.toThrow('doc refused');
    expect(f.chart.size).toBe(1);
    await ops.history.undo();
    expect([f.node.rows.size, f.chart.size]).toEqual([0, 0]);
  });

  it('a rejection part-way rethrows the server sentence and keeps the created part undoable', async () => {
    const f = fakeConn('p99 latency');
    const ops = new Ops(f.conn, 'me', new History());
    await expect(ops.insertLibraryAction('checkout panel', PAYLOAD, { x: 0, y: 0 }, 1n)).rejects.toThrow(
      'chart size rule: charts must be at least 224x144; got 200x100'
    );
    expect([...f.node.rows.values()].map(n => n.label)).toEqual(['checkout api']);
    expect(f.edge.rows.size).toBe(0);
    await ops.history.undo();
    expect(f.node.rows.size).toBe(0);
  });
});
