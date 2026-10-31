import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DbConnection } from './module_bindings';
import type { Node } from './module_bindings/types';
import { showError } from './chrome';
import { History, Ops } from './ops';

vi.mock('./chrome', () => ({ showError: vi.fn() }));

/**
 * Regression tests for two defects found in review:
 *  - a batch that rejected partway discarded its history, leaving the rows it
 *    had already changed with no way to undo them;
 *  - style fields were missing from NodeFields, so duplicate and
 *    delete-then-undo silently reset a styled node.
 */

describe('History.batch partial failure', () => {
  it('keeps the successful half of a rejected batch undoable', async () => {
    const history = new History();
    const undone: number[] = [];

    await expect(
      history.batch('mark focal', async () => {
        // two rows succeed...
        for (const i of [1, 2]) {
          history.push({
            label: `row ${i}`,
            undo: async () => {
              undone.push(i);
            },
            redo: async () => {},
          });
        }
        // ...then the server refuses the third (focal limit)
        throw new Error('focal limit: at most 2 focal nodes per board');
      })
    ).rejects.toThrow('focal limit');

    // The applied rows must still be reversible.
    await history.undo();
    expect(undone).toEqual([2, 1]);
  });

  it('records nothing when a batch fails before changing anything', async () => {
    const history = new History();
    await expect(
      history.batch('noop', async () => {
        throw new Error('rejected immediately');
      })
    ).rejects.toThrow('rejected immediately');
    // undo on an empty stack must be a no-op, not a throw
    await expect(history.undo()).resolves.toBeUndefined();
  });

  it('still collapses a fully successful batch into one entry', async () => {
    const history = new History();
    const undone: number[] = [];
    await history.batch('three rows', async () => {
      for (const i of [1, 2, 3]) {
        history.push({
          label: `row ${i}`,
          undo: async () => {
            undone.push(i);
          },
          redo: async () => {},
        });
      }
    });
    await history.undo();
    expect(undone).toEqual([3, 2, 1]);
    // one entry, so a second undo has nothing left
    undone.length = 0;
    await history.undo();
    expect(undone).toEqual([]);
  });
});

// Shared across fakes: ops claims captured ids module-wide, so a fake that
// restarted at 100n would never resolve a capture.
let next = 100n;

/** In-memory node table whose reducers reject a missing row, as the server does. */
function fakeConn() {
  const rows = new Map<bigint, Node>();
  const ins = new Set<(ctx: unknown, r: Node) => void>();
  const live = (id: bigint) => {
    const n = rows.get(id);
    if (!n) throw new Error(`node ${id} does not exist`);
    return n;
  };
  const reducers = {
    createNode: vi.fn(async (f: Partial<Node>) => {
      const row = { ...f, id: next++ } as Node;
      rows.set(row.id, row);
      for (const cb of [...ins]) cb(null, row);
    }),
    deleteNode: vi.fn(async ({ nodeId }: { nodeId: bigint }) => { live(nodeId); rows.delete(nodeId); }),
    moveNode: vi.fn(async ({ nodeId, x, y }: { nodeId: bigint; x: number; y: number }) => { rows.set(nodeId, { ...live(nodeId), x, y }); }),
  };
  const db = {
    visibleNode: { iter: () => rows.values(), onInsert: (cb: (ctx: unknown, r: Node) => void) => ins.add(cb), removeOnInsert: (cb: (ctx: unknown, r: Node) => void) => ins.delete(cb) },
    visibleCodeRef: { iter: () => [].values() },
  };
  return { rows, reducers, ops: new Ops({ db, reducers } as unknown as DbConnection, 'me', new History()) };
}

const fields = { boardId: 1n, label: 'n', sublabel: '', x: 0, y: 0, w: 160, h: 80, token: 'ink', focal: false, kind: 'service' };

describe('undo follows rows recreated under new ids', () => {
  beforeEach(() => vi.mocked(showError).mockClear());

  it('create → delete → undo → undo leaves no node, even with both undos pressed at once', async () => {
    const { ops, rows } = fakeConn();
    const id = await ops.createNodeAction(fields);
    await ops.deleteNodesAction([rows.get(id)!], []);
    await Promise.all([ops.history.undo(), ops.history.undo()]);
    expect(rows.size).toBe(0);
    expect(showError).not.toHaveBeenCalled();
  });

  it('move → delete → undo → undo puts the restored node back where it started', async () => {
    const { ops, rows } = fakeConn();
    const id = await ops.createNodeAction(fields);
    await ops.moveNodesAction([{ nodeId: id, from: { x: 0, y: 0 }, to: { x: 40, y: 40 } }]);
    await ops.deleteNodesAction([rows.get(id)!], []);
    await ops.history.undo();
    await ops.history.undo();
    expect([...rows.values()].map(n => [n.x, n.y])).toEqual([[0, 0]]);
    expect(showError).not.toHaveBeenCalled();
  });

  it('redo of an undone create is followed by the redo of a later move', async () => {
    const { ops, rows } = fakeConn();
    const id = await ops.createNodeAction(fields);
    await ops.moveNodesAction([{ nodeId: id, from: { x: 0, y: 0 }, to: { x: 40, y: 40 } }]);
    await ops.history.undo();
    await ops.history.undo();
    await ops.history.redo();
    await ops.history.redo();
    expect([...rows.values()].map(n => [n.x, n.y])).toEqual([[40, 40]]);
    expect(showError).not.toHaveBeenCalled();
  });
});

describe('moveNodesAction', () => {
  beforeEach(() => vi.mocked(showError).mockClear());

  it('keeps the moves that landed undoable when one node is gone', async () => {
    const { ops, rows } = fakeConn();
    const a = await ops.createNodeAction(fields);
    await expect(ops.moveNodesAction([
      { nodeId: a, from: { x: 0, y: 0 }, to: { x: 40, y: 40 } },
      { nodeId: 999n, from: { x: 0, y: 0 }, to: { x: 40, y: 40 } },
    ])).rejects.toThrow('node 999 does not exist');
    await ops.history.undo();
    expect([rows.get(a)!.x, rows.get(a)!.y]).toEqual([0, 0]);
    expect(showError).not.toHaveBeenCalled();
  });

  it('drops the undo when someone else moved the node since', async () => {
    const { ops, rows, reducers } = fakeConn();
    const id = await ops.createNodeAction(fields);
    await ops.moveNodesAction([{ nodeId: id, from: { x: 0, y: 0 }, to: { x: 40, y: 40 } }]);
    rows.set(id, { ...rows.get(id)!, x: 80 }); // an agent's layout
    await ops.history.undo();
    expect(reducers.moveNode).toHaveBeenCalledTimes(1);
    expect(rows.get(id)!.x).toBe(80);
    expect(vi.mocked(showError).mock.calls[0][0]).toContain('changed by someone else since');
    await ops.history.redo(); // dropped, not parked on the redo stack
    expect(reducers.moveNode).toHaveBeenCalledTimes(1);
  });
});
