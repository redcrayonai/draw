import { describe, it, expect } from 'vitest';
import type { DbConnection } from './module_bindings';
import type { Edge, Node } from './module_bindings/types';
import { History, Ops } from './ops';
import { iconNodePlacement, type LibraryPayloadV1 } from './library';

// Row ids are unique across this file: ops.ts keeps one module-wide set of claimed ids.
let next = 5000n;

/** In-memory node, edge and node-icon tables with the server's cascade:
 *  create_icon_node writes the node and its icon together; delete_node drops both. */
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
  const icons = new Map<bigint, { nodeId: bigint; boardId: bigint; icon: string }>();
  const calls: string[] = [];
  const nodeDefaults = {
    token: 'ink', focal: false, doc: '', hidden: false, imported: false,
    shape: 'rect', color: '', strokeStyle: 'solid', size: 'm', sourceKey: '',
  };
  const reducers = {
    createNode: async (f: Partial<Node>) => {
      calls.push('createNode');
      node.insert({ ...nodeDefaults, ...f } as Node);
    },
    createIconNode: async ({ icon, ...f }: Partial<Node> & { icon: string }) => {
      calls.push(`createIconNode:${icon}`);
      // One transaction: the icon row exists when the node's insert event fires.
      const id = next;
      icons.set(id, { nodeId: id, boardId: f.boardId!, icon });
      node.insert({ ...nodeDefaults, ...f } as Node);
    },
    createEdge: async (f: Partial<Edge>) => {
      edge.insert({ color: '', strokeStyle: 'solid', hidden: false, imported: false, evidenceSnippet: '', evidenceStatus: '', relation: '', ...f } as Edge);
    },
    updateEdgeStyle: async () => {},
    // update_node as the module runs it: a node that becomes a note loses its icon.
    updateNode: async ({ nodeId, ...patch }: { nodeId: bigint } & Partial<Node>) => {
      calls.push(`updateNode:${patch.kind ?? ''}`);
      const set = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
      const next = { ...node.rows.get(nodeId)!, ...set } as Node;
      node.rows.set(nodeId, next);
      if (!['service', 'datastore', 'external', 'boundary'].includes(next.kind)) icons.delete(nodeId);
    },
    setNodeIcon: async ({ nodeId, icon }: { nodeId: bigint; icon: string }) => {
      calls.push(`setNodeIcon:${icon}`);
      if (icon === '') icons.delete(nodeId);
      else icons.set(nodeId, { nodeId, boardId: node.rows.get(nodeId)!.boardId, icon });
    },
    deleteNode: async ({ nodeId }: { nodeId: bigint }) => {
      calls.push('deleteNode');
      for (const e of [...edge.rows.values()]) if (e.fromNode === nodeId || e.toNode === nodeId) edge.rows.delete(e.id);
      icons.delete(nodeId);
      node.rows.delete(nodeId);
    },
  };
  const iconTable = { iter: () => icons.values(), nodeId: { find: (id: bigint) => icons.get(id) } };
  const conn = { db: { visibleNode: node, visibleEdge: edge, visibleNodeIcon: iconTable, visibleCodeRef: { iter: () => [][Symbol.iterator]() } }, reducers } as unknown as DbConnection;
  return { conn, node, icons, calls };
}

const iconOf = (f: ReturnType<typeof fakeConn>, label: string) => {
  const n = [...f.node.rows.values()].find(r => r.label === label);
  return n ? f.icons.get(n.id)?.icon : undefined;
};

describe('icon nodes through Ops (spec 2026-10-18)', () => {
  it('placing an icon tile makes the node and its icon in one create_icon_node call, with undo and redo', async () => {
    const f = fakeConn();
    const history = new History();
    const ops = new Ops(f.conn, 'me', history);
    const id = await ops.createNodeAction({ boardId: 1n, x: 40, y: 80, ...iconNodePlacement('orchestrator') });
    expect(f.calls).toEqual(['createIconNode:orchestrator']);
    const row = f.node.rows.get(id)!;
    expect([row.label, row.kind, row.w, row.h]).toEqual(['Orchestrator', 'service', 160, 96]);
    expect(f.icons.get(id)?.icon).toBe('orchestrator');
    await history.undo();
    expect(f.node.rows.size).toBe(0);
    expect(f.icons.size).toBe(0);
    await history.redo();
    expect(iconOf(f, 'Orchestrator')).toBe('orchestrator');
  });

  it('a node without an icon still goes through create_node', async () => {
    const f = fakeConn();
    const ops = new Ops(f.conn, 'me', new History());
    await ops.createNodeAction({ boardId: 1n, label: 'api', sublabel: '', x: 0, y: 0, w: 160, h: 80, token: 'ink', focal: false, kind: 'service' });
    expect(f.calls).toEqual(['createNode']);
  });

  it('duplicate copies the icon', async () => {
    const f = fakeConn();
    const ops = new Ops(f.conn, 'me', new History());
    const id = await ops.createNodeAction({ boardId: 1n, x: 0, y: 0, ...iconNodePlacement('grok') });
    const [copy] = await ops.duplicateNodesAction([f.node.rows.get(id)!]);
    expect(f.icons.get(copy)?.icon).toBe('grok');
    expect([f.node.rows.get(copy)!.x, f.node.rows.get(copy)!.y]).toEqual([16, 16]);
  });

  it('undoing a delete brings the icon back with the node', async () => {
    const f = fakeConn();
    const history = new History();
    const ops = new Ops(f.conn, 'me', history);
    const a = await ops.createNodeAction({ boardId: 1n, x: 0, y: 0, ...iconNodePlacement('aws') });
    const b = await ops.createNodeAction({ boardId: 1n, x: 240, y: 0, label: 'plain', sublabel: '', w: 160, h: 80, token: 'ink', focal: false, kind: 'service' });
    await ops.deleteNodesAction([f.node.rows.get(a)!, f.node.rows.get(b)!], []);
    expect(f.node.rows.size).toBe(0);
    await history.undo();
    expect(iconOf(f, 'AWS Cloud')).toBe('aws');
    expect(iconOf(f, 'plain')).toBeUndefined();
  });

  it('inserting a saved item recreates its icons', async () => {
    const f = fakeConn();
    const ops = new Ops(f.conn, 'me', new History());
    const payload: LibraryPayloadV1 = {
      version: 1,
      nodes: [
        { key: 0, label: 'Lead', sublabel: '', x: 0, y: 0, w: 160, h: 96, token: 'ink', kind: 'service', doc: '', shape: 'rect', color: '', strokeStyle: 'solid', size: 'm', icon: 'orchestrator' },
        { key: 1, label: 'Grok', sublabel: '', x: 240, y: 0, w: 160, h: 96, token: 'ink', kind: 'external', doc: '', shape: 'rect', color: '', strokeStyle: 'solid', size: 'm', icon: 'grok' },
        { key: 2, label: 'notes', sublabel: '', x: 0, y: 160, w: 160, h: 80, token: 'ink', kind: 'service', doc: '', shape: 'rect', color: '', strokeStyle: 'solid', size: 'm' },
      ],
      edges: [{ from: 0, to: 1, label: 'calls', color: '', strokeStyle: 'solid' }],
    };
    await ops.insertLibraryAction('agent pair', payload, { x: 100, y: 100 }, 1n);
    expect([iconOf(f, 'Lead'), iconOf(f, 'Grok'), iconOf(f, 'notes')]).toEqual(['orchestrator', 'grok', undefined]);
    expect(f.calls).toEqual(['createIconNode:orchestrator', 'createIconNode:grok', 'createNode']);
  });

  it('turning an icon node into a note drops its icon; undo brings the kind and the icon back, redo drops it again', async () => {
    const f = fakeConn();
    const history = new History();
    const ops = new Ops(f.conn, 'me', history);
    const id = await ops.createNodeAction({ boardId: 1n, x: 0, y: 0, ...iconNodePlacement('queue') });
    await ops.updateNodeAction(id, { kind: 'note' });
    expect([f.node.rows.get(id)!.kind, f.icons.get(id)]).toEqual(['note', undefined]);
    await history.undo();
    expect([f.node.rows.get(id)!.kind, f.icons.get(id)?.icon]).toEqual(['datastore', 'queue']);
    await history.redo();
    expect([f.node.rows.get(id)!.kind, f.icons.get(id)]).toEqual(['note', undefined]);
    // a change between box kinds never touches the icon, and undo sets none
    await history.undo();
    f.calls.length = 0;
    await ops.updateNodeAction(id, { kind: 'service' });
    await history.undo();
    expect(f.calls).toEqual(['updateNode:service', 'updateNode:datastore']);
    expect(f.icons.get(id)?.icon).toBe('queue');
  });

  it('a stale icon row on a note never reaches create_icon_node: duplicate and undo of a delete make a plain note', async () => {
    const f = fakeConn();
    const history = new History();
    const ops = new Ops(f.conn, 'me', history);
    await ops.createNodeAction({ boardId: 1n, label: 'n', sublabel: '', x: 0, y: 0, w: 216, h: 88, token: 'ink', focal: false, kind: 'note' });
    const note = [...f.node.rows.values()][0];
    f.icons.set(note.id, { nodeId: note.id, boardId: 1n, icon: 'agent' }); // e.g. a row from before the kind change landed
    f.calls.length = 0;
    await ops.duplicateNodesAction([note]);
    await ops.deleteNodesAction([f.node.rows.get(note.id)!], []);
    await history.undo();
    expect(f.calls.filter(c => c.startsWith('create'))).toEqual(['createNode', 'createNode']);
  });
});
