import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DbConnection } from './module_bindings';
import type { Chart, CodeRef, Edge, Node } from './module_bindings/types';
import { History, Ops, type ChartFields } from './ops';
import { showError } from './chrome';

// History.undo reports a rejected undo through showError; the real chrome
// module needs the app shell.
vi.mock('./chrome', () => ({ showError: vi.fn() }));

const NODE_DEFAULTS = {
  token: 'ink', focal: false, doc: '', hidden: false, imported: false,
  shape: 'rect', color: '', strokeStyle: 'solid', size: 'm', sourceKey: '',
};

/**
 * In-memory tables and reducers that act like the server for charts:
 * create_node refuses kind 'chart', create_chart writes the node and its
 * chart row together, and delete_node cascades edges, code refs and the
 * chart row.
 */
// Row ids are never reused across tests: ops.ts keeps claimed ids in a
// module-level set, so a fake that restarted at 100n would never resolve.
let next = 100n;

function fakeConn() {
  let clock = 1n;
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
  const node = table<Node>(), edge = table<Edge>(), codeRef = table<CodeRef>();
  const charts = new Map<bigint, Chart>();
  const chart = { iter: () => charts.values(), nodeId: { find: (id: bigint) => charts.get(id) ?? null } };
  const stamp = () => ({ microsSinceUnixEpoch: clock++ }) as unknown as Chart['updatedAt'];
  const calls: Array<[string, unknown]> = [];
  const dropRefs = (kind: string, id: bigint) => {
    for (const r of [...codeRef.rows.values()]) if (r.targetKind === kind && r.targetId === id) codeRef.rows.delete(r.id);
  };
  const reducers = {
    createNode: async (f: Partial<Node>) => {
      calls.push(['createNode', { ...f }]);
      if (f.kind === 'chart') throw new Error('use create_chart for charts');
      node.insert({ ...NODE_DEFAULTS, ...f } as Node);
    },
    createChart: async (f: ChartFields) => {
      calls.push(['createChart', { ...f }]);
      const n = node.insert({
        ...NODE_DEFAULTS, boardId: f.boardId, label: f.label, sublabel: f.sublabel, x: f.x, y: f.y, w: f.w, h: f.h, kind: 'chart',
      } as Node);
      charts.set(n.id, {
        nodeId: n.id, boardId: f.boardId, type: f.type, csv: f.csv, options: f.options || '{}',
        source: f.source || 'human:me', updatedAt: stamp(),
      });
    },
    setChartData: async (f: { nodeId: bigint; type?: string; csv?: string; options?: string; source?: string }) => {
      calls.push(['setChartData', { ...f }]);
      const r = charts.get(f.nodeId);
      if (!r) throw new Error(`node ${f.nodeId} is not a chart`);
      // the server's source rule for a human: new numbers without a source
      // keep a source that names the caller and replace any other with theirs
      const type = f.type ?? r.type, csv = f.csv ?? r.csv;
      const newNumbers = type !== r.type || csv !== r.csv;
      const source = f.source ?? (newNumbers && !r.source.startsWith('human:me') ? 'human:me' : r.source);
      charts.set(f.nodeId, { ...r, type, csv, options: f.options ?? r.options, source, updatedAt: stamp() });
    },
    updateNode: async (f: { nodeId: bigint } & Partial<Node>) => {
      calls.push(['updateNode', { ...f }]);
      const { nodeId, ...rest } = f;
      const set = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
      node.rows.set(nodeId, { ...node.rows.get(nodeId)!, ...set });
    },
    setNodeDoc: async (f: { nodeId: bigint; doc: string }) => {
      calls.push(['setNodeDoc', { ...f }]);
      node.rows.set(f.nodeId, { ...node.rows.get(f.nodeId)!, doc: f.doc });
    },
    createEdge: async (f: Partial<Edge>) => {
      edge.insert({ color: '', strokeStyle: 'solid', hidden: false, imported: false, evidenceSnippet: '', evidenceStatus: '', relation: '', ...f } as Edge);
    },
    updateEdgeStyle: async () => {},
    deleteEdge: async ({ edgeId }: { edgeId: bigint }) => { dropRefs('edge', edgeId); edge.rows.delete(edgeId); },
    deleteNode: async ({ nodeId }: { nodeId: bigint }) => {
      calls.push(['deleteNode', { nodeId }]);
      for (const e of [...edge.rows.values()]) if (e.fromNode === nodeId || e.toNode === nodeId) { dropRefs('edge', e.id); edge.rows.delete(e.id); }
      dropRefs('node', nodeId);
      charts.delete(nodeId);
      node.rows.delete(nodeId);
    },
    addCodeRef: async (f: Omit<CodeRef, 'id' | 'checkpoint' | 'status'>) => { codeRef.insert({ ...f, checkpoint: 9, status: 'ok' } as CodeRef); },
    updateCodeRef: async (f: { id: bigint; status: string }) => { const r = codeRef.rows.get(f.id)!; codeRef.rows.set(f.id, { ...r, ...f }); },
  };
  const conn = { db: { visibleNode: node, visibleEdge: edge, visibleCodeRef: codeRef, visibleChart: chart }, reducers } as unknown as DbConnection;
  return { conn, reducers, node, edge, codeRef, charts, calls };
}

type Fake = ReturnType<typeof fakeConn>;

const FIELDS: ChartFields = {
  boardId: 1n, label: 'p99 latency', sublabel: 'checkout', x: 96, y: 96, w: 352, h: 224,
  type: 'timeseries', csv: 'time,p99\n10:00,40\n10:05,42', options: '{}', source: 'agent: k6 run @ 4f2c1d0',
};

const service = (f: Fake, label: string, x = 0, y = 0) =>
  f.node.insert({ ...NODE_DEFAULTS, boardId: 1n, label, sublabel: '', x, y, w: 160, h: 80, kind: 'service' } as Node);

const ref = (targetKind: string, targetId: bigint, symbol: string): Omit<CodeRef, 'id'> => ({
  boardId: 1n, targetKind, targetId, path: 'bench/k6.js', symbol, startLine: 1, endLine: 3,
  blobSha: 'a'.repeat(40), snippet: `function ${symbol}() {}`, author: 'agent', checkpoint: 2, status: 'ok',
});

let f: Fake;
let ops: Ops;

beforeEach(() => {
  f = fakeConn();
  ops = new Ops(f.conn, 'me', new History());
  vi.mocked(showError).mockClear();
});

describe('creating charts', () => {
  it('createChartAction returns the node id; undo deletes the chart, redo makes it again', async () => {
    const id = await ops.createChartAction(FIELDS);
    expect(f.node.rows.get(id)!.kind).toBe('chart');
    expect(f.charts.get(id)).toMatchObject({ type: 'timeseries', csv: FIELDS.csv, options: '{}', source: FIELDS.source });

    await ops.history.undo();
    expect(f.node.rows.size).toBe(0);
    expect(f.charts.size).toBe(0);

    await ops.history.redo();
    const [again] = [...f.node.rows.values()];
    expect(again.id).not.toBe(id);
    expect(again.kind).toBe('chart');
    expect(f.charts.get(again.id)!.csv).toBe(FIELDS.csv);
  });

  it('createChart takes the chart, not a plain node that lands at the same spot first', async () => {
    const real = f.reducers.createChart;
    f.reducers.createChart = async fields => {
      service(f, fields.label, fields.x, fields.y);
      await real(fields);
    };
    const id = await ops.createChart(FIELDS);
    expect(f.node.rows.get(id)!.kind).toBe('chart');
    expect(f.charts.has(id)).toBe(true);
  });
});

describe('editing chart data', () => {
  const sent = () => f.calls.map(([name, a]) => [name, JSON.parse(JSON.stringify(a, (_k, v) => (typeof v === 'bigint' ? String(v) : v)))]);

  it('undo restores new numbers with the source they had; redo replays the patch', async () => {
    const id = await ops.createChart({ ...FIELDS, source: 'sample' });
    const edited = 'time,p99\n10:00,41\n10:05,43';
    await ops.setChartDataAction(id, { csv: edited });
    expect(f.charts.get(id)).toMatchObject({ csv: edited, source: 'human:me' });

    f.calls.length = 0;
    await ops.history.undo();
    expect(sent()).toEqual([['setChartData', { nodeId: String(id), csv: FIELDS.csv, source: 'sample' }]]);
    expect(f.charts.get(id)).toMatchObject({ csv: FIELDS.csv, source: 'sample' });

    f.calls.length = 0;
    await ops.history.redo();
    expect(sent()).toEqual([['setChartData', { nodeId: String(id), csv: edited }]]);
    expect(f.charts.get(id)!.csv).toBe(edited);
  });

  it("an options undo restores only the options: a collaborator's later data and source stay", async () => {
    const id = await ops.createChart(FIELDS);
    await ops.setChartDataAction(id, { options: '{"style":"area"}' });
    const later = 'time,p99\n10:00,50\n10:05,51';
    await f.reducers.setChartData({ nodeId: id, csv: later, source: 'agent: query @ t2' }); // an agent, meanwhile
    f.calls.length = 0;
    await ops.history.undo();
    expect(sent()).toEqual([['setChartData', { nodeId: String(id), options: '{}' }]]);
    expect(f.charts.get(id)).toMatchObject({ csv: later, options: '{}', source: 'agent: query @ t2' });
    f.calls.length = 0;
    await ops.history.redo();
    expect(sent()).toEqual([['setChartData', { nodeId: String(id), options: '{"style":"area"}' }]]);
  });

  it("undo is refused once an agent changed the data after you; redo once someone changed it after the undo", async () => {
    const id = await ops.createChart(FIELDS);
    const edited = 'time,p99\n10:00,41\n10:05,43', later = 'time,p99\n10:00,50\n10:05,51';
    await ops.setChartDataAction(id, { csv: edited });
    await f.reducers.setChartData({ nodeId: id, csv: later, source: 'agent: query @ t2' }); // an agent, meanwhile
    f.calls.length = 0;
    await ops.history.undo();
    expect(sent()).toEqual([]);
    expect(f.charts.get(id)).toMatchObject({ csv: later, source: 'agent: query @ t2' });
    expect(vi.mocked(showError)).toHaveBeenCalledWith(expect.stringContaining('changed by someone else since'));

    vi.mocked(showError).mockClear();
    await ops.setChartDataAction(id, { csv: edited });
    await ops.history.undo();
    await f.reducers.setChartData({ nodeId: id, csv: later, source: 'agent: query @ t3' });
    f.calls.length = 0;
    await ops.history.redo();
    expect(sent()).toEqual([]);
    expect(f.charts.get(id)).toMatchObject({ csv: later, source: 'agent: query @ t3' });
    expect(vi.mocked(showError)).toHaveBeenCalledWith(expect.stringContaining('changed by someone else since'));
  });

  // Holds set_chart_data calls at the server until the returned release()
  // runs. release() first waits a macrotask, so every save that can reach
  // the server by then has, and returns how many are held: with saves on a
  // chart serialised, only the first. Each held call still writes its row
  // before its promise resolves, as the SDK applies a transaction's rows
  // before it resolves the reducer call.
  const hold = () => {
    const real = f.reducers.setChartData;
    let open!: () => void, held = 0;
    const gate = new Promise<void>(r => { open = r; });
    f.reducers.setChartData = async a => { held++; await gate; await real(a); };
    return async () => {
      await new Promise(r => setTimeout(r));
      f.reducers.setChartData = real;
      open();
      return held;
    };
  };

  it('two saves inside one round trip undo one step at a time', async () => {
    const id = await ops.createChart(FIELDS);
    const release = hold();
    const one = ops.setChartDataAction(id, { options: '{"style":"area"}' });
    const two = ops.setChartDataAction(id, { options: '{"style":"stacked"}' });
    expect(await release()).toBe(1); // the second save waits for the first
    await Promise.all([one, two]);
    f.calls.length = 0;
    await ops.history.undo();
    expect(sent()).toEqual([['setChartData', { nodeId: String(id), options: '{"style":"area"}' }]]);
    await ops.history.undo();
    expect(sent().slice(1)).toEqual([['setChartData', { nodeId: String(id), options: '{}' }]]);
    expect(f.charts.get(id)!.options).toBe('{}');
  });

  it("two quick csv saves on someone else's chart undo one step at a time, each to its own csv and source", async () => {
    // the server credits each new set of numbers to the editor; the first
    // undo must restore the source the first save left, never the old name
    const id = await ops.createChart({ ...FIELDS, source: 'human:ann' });
    const v2 = 'time,p99\n10:00,41\n10:05,43', v3 = 'time,p99\n10:00,44\n10:05,45';
    const release = hold();
    const one = ops.setChartDataAction(id, { csv: v2 });
    const two = ops.setChartDataAction(id, { csv: v3 });
    expect(await release()).toBe(1); // the second save waits for the first
    await Promise.all([one, two]);
    expect(f.charts.get(id)).toMatchObject({ csv: v3, source: 'human:me' });
    f.calls.length = 0;
    await ops.history.undo();
    expect(sent()).toEqual([['setChartData', { nodeId: String(id), csv: v2, source: 'human:me' }]]);
    await ops.history.undo();
    expect(f.charts.get(id)).toMatchObject({ csv: FIELDS.csv, source: 'human:ann' });
  });

  it('a Source edit made while a data save is pending undoes to the source that save left, then to the original', async () => {
    const id = await ops.createChart(FIELDS); // an agent's source
    const edited = 'time,p99\n10:00,41\n10:05,43';
    const release = hold();
    const a = ops.setChartDataAction(id, { csv: edited });
    const b = ops.setChartDataAction(id, { source: 'k6 on staging' });
    expect(await release()).toBe(1); // the second save waits for the first
    await Promise.all([a, b]);
    expect(f.charts.get(id)).toMatchObject({ csv: edited, source: 'k6 on staging' });

    await ops.history.undo();
    expect(f.charts.get(id)).toMatchObject({ csv: edited, source: 'human:me' });
    await ops.history.undo();
    expect(f.charts.get(id)).toMatchObject({ csv: FIELDS.csv, source: FIELDS.source });

    await ops.history.redo();
    expect(f.charts.get(id)).toMatchObject({ csv: edited, source: 'human:me' });
    await ops.history.redo();
    expect(f.charts.get(id)).toMatchObject({ csv: edited, source: 'k6 on staging' });
    expect(vi.mocked(showError)).not.toHaveBeenCalled();
  });

  it('a refused save does not hold up the next save on the chart and records no undo step', async () => {
    const id = await ops.createChart(FIELDS);
    const real = f.reducers.setChartData;
    f.reducers.setChartData = async a => {
      if (a.type === 'heatmap') throw new Error('unknown chart type "heatmap"');
      await real(a);
    };
    const release = hold();
    const bad = ops.setChartDataAction(id, { type: 'heatmap' });
    const good = ops.setChartDataAction(id, { options: '{"style":"area"}' });
    expect(await release()).toBe(1); // the second save waits for the first
    await expect(bad).rejects.toThrow('unknown chart type "heatmap"');
    await good;
    expect(f.charts.get(id)).toMatchObject({ type: 'timeseries', options: '{"style":"area"}' });
    await ops.history.undo();
    expect(f.charts.get(id)!.options).toBe('{}');
    f.calls.length = 0;
    await ops.history.undo(); // nothing left: the refused save recorded nothing
    expect(f.calls).toEqual([]);
  });

  it('a node without chart data is refused with the server sentence and records nothing', async () => {
    await expect(ops.setChartDataAction(5n, { csv: 'a,b\n1,2' })).rejects.toThrow('node 5 is not a chart');
    expect(f.calls).toEqual([]);
    await ops.history.undo();
    expect(f.calls).toEqual([]);
  });

  it('a connection without the chart table (as in ops.refs.test.ts) gets sentences, not a TypeError', async () => {
    const bare = new Ops(
      { db: { visibleNode: f.node, visibleEdge: f.edge, visibleCodeRef: f.codeRef }, reducers: f.reducers } as unknown as DbConnection,
      'me',
      new History()
    );
    await expect(bare.setChartDataAction(5n, { csv: 'a' })).rejects.toThrow('node 5 is not a chart');
    // A chart node makes deleteNodesAction and duplicateNodesAction look for chart rows.
    const n = f.node.insert({ ...NODE_DEFAULTS, boardId: 1n, label: 'p99 latency', sublabel: '', x: 0, y: 0, w: 352, h: 224, kind: 'chart' } as Node);
    await expect(bare.duplicateNodesAction([n])).rejects.toThrow('the data of chart "p99 latency" was not loaded, so it cannot be recreated');
    await expect(bare.deleteNodesAction([n], [])).rejects.toThrow('chart data has not loaded yet; try again in a moment');
    expect(f.node.rows.has(n.id)).toBe(true);
  });
});

describe('deleting and duplicating charts', () => {
  it('delete → undo recreates the chart through create_chart with its data, style, focal, edges and refs', async () => {
    const id = await ops.createChart(FIELDS);
    f.node.rows.set(id, { ...f.node.rows.get(id)!, color: 'blue', size: 'l', focal: true, doc: '# p99 budget' });
    const svc = service(f, 'api');
    const e = f.edge.insert({
      boardId: 1n, fromNode: svc.id, toNode: id, label: 'measures', evidence: 'human:me', evidenceSnippet: '',
      evidenceStatus: '', relation: '', color: '', strokeStyle: 'solid', hidden: false, imported: false,
    } as Edge);
    f.codeRef.insert(ref('node', id, 'bench'));

    await ops.deleteNodesAction([f.node.rows.get(id)!], [e]);
    expect(f.charts.size).toBe(0);
    expect(f.edge.rows.size).toBe(0);

    f.calls.length = 0;
    await ops.history.undo();
    expect(vi.mocked(showError)).not.toHaveBeenCalled();
    expect(f.calls.some(([name, a]) => name === 'createNode' && (a as Node).kind === 'chart')).toBe(false);
    const back = [...f.node.rows.values()].find(n => n.kind === 'chart')!;
    expect(back.id).not.toBe(id);
    expect([back.label, back.sublabel, back.x, back.y, back.w, back.h, back.color, back.size, back.focal, back.doc])
      .toEqual(['p99 latency', 'checkout', 96, 96, 352, 224, 'blue', 'l', true, '# p99 budget']);
    expect(f.charts.get(back.id)).toMatchObject({ type: 'timeseries', csv: FIELDS.csv, options: '{}', source: FIELDS.source });
    const [ne] = [...f.edge.rows.values()];
    expect([ne.fromNode, ne.toNode, ne.evidence]).toEqual([svc.id, back.id, 'human:me']);
    expect([...f.codeRef.rows.values()].map(r => [r.targetKind, r.targetId, r.symbol])).toEqual([['node', back.id, 'bench']]);

    await ops.history.redo();
    expect(f.charts.size).toBe(0);
    expect([...f.node.rows.values()].map(n => n.kind)).toEqual(['service']);
  });

  it('an unstyled chart comes back with no update_node call', async () => {
    const id = await ops.createChart(FIELDS);
    await ops.deleteNodesAction([f.node.rows.get(id)!], []);
    f.calls.length = 0;
    await ops.history.undo();
    expect(f.calls.map(([name]) => name)).toEqual(['createChart']);
  });

  it('a chart whose data has not loaded is not deleted (undo could not bring it back)', async () => {
    const n = f.node.insert({ ...NODE_DEFAULTS, boardId: 1n, label: 'p99 latency', sublabel: '', x: 0, y: 0, w: 352, h: 224, kind: 'chart' } as Node);
    const svc = service(f, 'api');
    await expect(ops.deleteNodesAction([svc, n], [])).rejects.toThrow('chart data has not loaded yet; try again in a moment');
    expect(f.calls.filter(([name]) => name === 'deleteNode')).toEqual([]);
    expect([f.node.rows.has(n.id), f.node.rows.has(svc.id)]).toEqual([true, true]);
    await ops.history.undo();
    expect(f.calls).toEqual([]);
  });

  it('a refused focal on restore brings the chart back without focal, says so, and restores the rest', async () => {
    const id = await ops.createChart(FIELDS);
    f.node.rows.set(id, { ...f.node.rows.get(id)!, focal: true, color: 'blue' });
    const svc = service(f, 'api');
    const e = f.edge.insert({
      boardId: 1n, fromNode: svc.id, toNode: id, label: 'measures', evidence: 'human:me', evidenceSnippet: '',
      evidenceStatus: '', relation: '', color: '', strokeStyle: 'solid', hidden: false, imported: false,
    } as Edge);
    await ops.deleteNodesAction([f.node.rows.get(id)!, svc], [e]);
    const real = f.reducers.updateNode;
    f.reducers.updateNode = async a => {
      if (a.focal) throw new Error('at most 2 focal nodes per board');
      await real(a);
    };
    await ops.history.undo();
    expect(vi.mocked(showError)).toHaveBeenCalledWith('"p99 latency" came back without focal: at most 2 focal nodes per board');
    const back = [...f.node.rows.values()].find(n => n.kind === 'chart')!;
    expect([back.focal, back.color]).toEqual([false, 'blue']);
    expect([...f.node.rows.values()].map(n => n.label).sort()).toEqual(['api', 'p99 latency']);
    expect(f.edge.rows.size).toBe(1);
    await ops.history.redo(); // the entry survived the refusal
    expect(f.node.rows.size).toBe(0);
  });

  it('a duplicated chart stays in the undo entry when a follow-up call is refused', async () => {
    const id = await ops.createChart(FIELDS);
    f.node.rows.set(id, { ...f.node.rows.get(id)!, doc: '# p99 budget' });
    f.reducers.setNodeDoc = async () => { throw new Error('doc refused'); };
    await expect(ops.duplicateNodesAction([f.node.rows.get(id)!])).rejects.toThrow('doc refused');
    expect(f.charts.size).toBe(2);
    await ops.history.undo();
    expect([...f.charts.keys()]).toEqual([id]);
  });

  it('duplicate copies the chart row, keeps sample as the source and style, and never copies focal', async () => {
    const id = await ops.createChart({ ...FIELDS, source: 'sample' });
    f.node.rows.set(id, { ...f.node.rows.get(id)!, focal: true, color: 'red', doc: '# p99 budget' });
    const [copy] = await ops.duplicateNodesAction([f.node.rows.get(id)!]);
    const c = f.node.rows.get(copy)!;
    expect([c.kind, c.x, c.y, c.focal, c.color, c.doc]).toEqual(['chart', 112, 112, false, 'red', '# p99 budget']);
    expect(f.charts.get(copy)).toMatchObject({ type: 'timeseries', csv: FIELDS.csv, options: '{}', source: 'sample' });

    await ops.history.undo();
    expect(f.node.rows.has(copy)).toBe(false);
    expect(f.charts.has(copy)).toBe(false);
    expect(f.charts.has(id)).toBe(true);
  });

  it('duplicate of a mixed selection uses create_node for nodes and create_chart for charts, in order', async () => {
    const svc = service(f, 'api');
    const id = await ops.createChart(FIELDS);
    f.calls.length = 0;
    const ids = await ops.duplicateNodesAction([svc, f.node.rows.get(id)!]);
    expect(f.calls.map(([name]) => name)).toEqual(['createNode', 'createChart']);
    expect(ids.map(i => f.node.rows.get(i)!.kind)).toEqual(['service', 'chart']);
  });
});
