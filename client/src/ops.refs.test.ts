import { describe, it, expect, vi } from 'vitest';
import type { DbConnection } from './module_bindings';
import type { CodeRef, Edge, Node } from './module_bindings/types';
import { showError } from './chrome';
import { History, Ops } from './ops';

vi.mock('./chrome', () => ({ showError: vi.fn() }));

// Shared by every fake: ops never resolves a capture to an id it claimed before.
let next = 100n;

/** In-memory tables + reducers, with the server's delete cascade to code refs.
 *  `access` is the caller's my_boards row for board 1; an opened link is no
 *  member, and the module refuses it code refs and source: citations (U52). */
function fakeConn(access?: string, keepsCode = true) {
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
  // The side tables of RC-690, keyed by ref / edge id; the module drops a row with its owner.
  const refHashes = new Map<bigint, string>(), edgeHashes = new Map<bigint, string>();
  const dropRefs = (kind: string, id: bigint) => {
    if (kind === 'edge') edgeHashes.delete(id);
    for (const r of [...codeRef.rows.values()]) if (r.targetKind === kind && r.targetId === id) { codeRef.rows.delete(r.id); refHashes.delete(r.id); }
  };
  const cites: string[] = [];
  const cite = (what: string) => {
    cites.push(what);
    if (access === 'link') throw new Error("only board members can cite this board's code or register its files");
  };
  // A board without code consent refuses code text with the module's code rule (RC-690).
  const refused: string[] = [];
  const noText = (what: string, text: string | undefined) => {
    if (keepsCode || !text) return;
    refused.push(what);
    throw new Error('code rule: this board does not store code; send the code ref without its snippet');
  };
  const reducers = {
    createNode: async (f: Partial<Node>) => { node.insert({ shape: 'rect', color: '', strokeStyle: 'solid', size: 'm', doc: '', imported: false, hidden: false, ...f } as Node); },
    createEdge: async (f: Partial<Edge>) => { if (f.evidence?.startsWith('source:')) cite(f.evidence); noText(`edge ${f.label}`, f.evidenceSnippet); edge.insert({ color: '', strokeStyle: 'solid', hidden: false, imported: false, evidenceSnippet: '', evidenceStatus: '', ...f } as Edge); },
    updateEdgeStyle: async () => {},
    deleteEdge: async ({ edgeId }: { edgeId: bigint }) => { dropRefs('edge', edgeId); edge.rows.delete(edgeId); },
    deleteNode: async ({ nodeId }: { nodeId: bigint }) => {
      for (const e of [...edge.rows.values()]) if (e.fromNode === nodeId || e.toNode === nodeId) { dropRefs('edge', e.id); edge.rows.delete(e.id); }
      dropRefs('node', nodeId); node.rows.delete(nodeId);
    },
    addCodeRef: async (f: Omit<CodeRef, 'id' | 'checkpoint' | 'status'>) => { cite(f.symbol); noText(`ref ${f.symbol}`, f.snippet); codeRef.insert({ ...f, checkpoint: 9, status: 'ok' } as CodeRef); },
    updateCodeRef: async (f: { id: bigint; status: string; snippet?: string }) => { noText('update', f.snippet); const r = codeRef.rows.get(f.id)!; codeRef.rows.set(f.id, { ...r, ...f }); },
    setCodeRefHashes: vi.fn(async (f: { refId: bigint; lineHashes: string }) => { cite('hashes'); refHashes.set(f.refId, f.lineHashes); }),
    setEdgeEvidenceCode: vi.fn(async (f: { edgeId: bigint; lineHash: string; snippet?: string }) => { cite('line hash'); edgeHashes.set(f.edgeId, f.lineHash); }),
  };
  const myBoards = { iter: () => (access === undefined ? [] : [{ boardId: 1n, access }]).values() };
  const visibleCodeRefHash = { iter: () => [...refHashes].map(([refId, lineHashes]) => ({ refId, boardId: 1n, lineHashes })).values() };
  const visibleEdgeEvidenceHash = { iter: () => [...edgeHashes].map(([edgeId, lineHash]) => ({ edgeId, boardId: 1n, lineHash })).values() };
  const db = { visibleNode: node, visibleEdge: edge, visibleCodeRef: codeRef, visibleCodeRefHash, visibleEdgeEvidenceHash, myBoards, myBoardPermissions: { iter: () => access === 'link' ? [{ boardId: 1n, workspaceId: 0n, role: 'editor', canEdit: true, canManage: false }].values() : [].values() } };
  return { conn: { db, reducers } as unknown as DbConnection, node, edge, codeRef, cites, refHashes, edgeHashes, reducers, refused };
}

const ref = (targetKind: string, targetId: bigint, symbol: string, status = 'ok'): Omit<CodeRef, 'id'> => ({
  boardId: 1n, targetKind, targetId, path: 'a.ts', symbol, startLine: 1, endLine: 3,
  blobSha: 'a'.repeat(40), snippet: `function ${symbol}() {}`, author: 'agent', checkpoint: 2, status,
});

describe('undo restores code refs the delete cascade removed', () => {
  it('delete node → undo: the node and its attached edge get their refs back, status kept', async () => {
    const f = fakeConn('team');
    const ops = new Ops(f.conn, 'me', new History());
    const a = f.node.insert({ boardId: 1n, label: 'a', sublabel: '', x: 0, y: 0, w: 160, h: 80, token: 'ink', focal: false, kind: 'service' } as Node);
    const b = f.node.insert({ boardId: 1n, label: 'b', sublabel: '', x: 200, y: 0, w: 160, h: 80, token: 'ink', focal: false, kind: 'service' } as Node);
    const e = f.edge.insert({ boardId: 1n, fromNode: a.id, toNode: b.id, label: 'calls', evidence: 'source:a.ts:2', evidenceSnippet: 'call();', evidenceStatus: 'stale' } as Edge);
    f.codeRef.insert(ref('node', a.id, 'alpha'));
    f.codeRef.insert(ref('node', a.id, 'beta', 'stale'));
    f.codeRef.insert(ref('edge', e.id, 'gamma'));

    await ops.deleteNodesAction([a], [e]);
    expect(f.codeRef.rows.size).toBe(0);

    await ops.history.undo();
    const [na] = [...f.node.rows.values()].filter(n => n.label === 'a');
    const [ne] = [...f.edge.rows.values()];
    expect([ne.evidence, ne.evidenceSnippet, ne.evidenceStatus]).toEqual(['source:a.ts:2', 'call();', 'stale']);
    const refs = [...f.codeRef.rows.values()];
    expect(refs.filter(r => r.targetKind === 'node' && r.targetId === na.id).map(r => [r.symbol, r.status]).sort())
      .toEqual([['alpha', 'ok'], ['beta', 'stale']]);
    expect(refs.filter(r => r.targetKind === 'edge' && r.targetId === ne.id).map(r => r.symbol)).toEqual(['gamma']);
  });

  it('delete edge → undo: its refs come back on the recreated edge', async () => {
    const f = fakeConn();
    const ops = new Ops(f.conn, 'me', new History());
    const e = f.edge.insert({ boardId: 1n, fromNode: 1n, toNode: 2n, label: 'calls', evidence: 'source:a.ts:2', evidenceSnippet: 'call();', evidenceStatus: 'stale' } as Edge);
    f.codeRef.insert(ref('edge', e.id, 'gamma', 'ambiguous'));
    await ops.deleteEdgeAction(e);
    await ops.history.undo();
    const [ne] = [...f.edge.rows.values()];
    expect([ne.evidence, ne.evidenceSnippet, ne.evidenceStatus]).toEqual(['source:a.ts:2', 'call();', 'stale']);
    expect([...f.codeRef.rows.values()].map(r => [r.targetId, r.symbol, r.status])).toEqual([[ne.id, 'gamma', 'ambiguous']]);
  });

  const H = (c: string) => c.repeat(32);

  it('delete node → undo: hashes replay onto the recreated refs and cited edge, with no text', async () => {
    const f = fakeConn('team');
    const ops = new Ops(f.conn, 'me', new History());
    const a = f.node.insert({ boardId: 1n, label: 'a', sublabel: '', x: 0, y: 0, w: 160, h: 80, token: 'ink', focal: false, kind: 'service' } as Node);
    const b = f.node.insert({ boardId: 1n, label: 'b', sublabel: '', x: 200, y: 0, w: 160, h: 80, token: 'ink', focal: false, kind: 'service' } as Node);
    const e = f.edge.insert({ boardId: 1n, fromNode: a.id, toNode: b.id, label: 'calls', evidence: 'source:a.ts:2', evidenceSnippet: '', evidenceStatus: 'ok' } as Edge);
    const alpha = f.codeRef.insert({ ...ref('node', a.id, 'alpha'), snippet: '' });
    const gamma = f.codeRef.insert({ ...ref('edge', e.id, 'gamma'), snippet: '' });
    f.codeRef.insert({ ...ref('node', a.id, 'bare'), snippet: '' }); // a ref with no hash row replays none
    f.refHashes.set(alpha.id, `${H('1')} ${H('2')}`);
    f.refHashes.set(gamma.id, H('3'));
    f.edgeHashes.set(e.id, H('4'));

    await ops.deleteNodesAction([a], [e]);
    expect([f.refHashes.size, f.edgeHashes.size]).toEqual([0, 0]);
    await ops.history.undo();

    const [ne] = [...f.edge.rows.values()];
    const refs = [...f.codeRef.rows.values()];
    const id = (symbol: string) => refs.find(r => r.symbol === symbol)!.id;
    expect(f.reducers.setCodeRefHashes.mock.calls.map(c => c[0])).toEqual([
      { refId: id('alpha'), lineHashes: `${H('1')} ${H('2')}` },
      { refId: id('gamma'), lineHashes: H('3') },
    ]);
    expect(f.reducers.setEdgeEvidenceCode.mock.calls.map(c => c[0])).toEqual([{ edgeId: ne.id, lineHash: H('4') }]);
    expect(refs.map(r => r.snippet)).toEqual(['', '', '']);
  });

  it('delete edge → undo: the edge hash and its refs\' hashes replay onto the recreated rows', async () => {
    const f = fakeConn();
    const ops = new Ops(f.conn, 'me', new History());
    const e = f.edge.insert({ boardId: 1n, fromNode: 1n, toNode: 2n, label: 'calls', evidence: 'source:a.ts:2', evidenceSnippet: '', evidenceStatus: 'ok' } as Edge);
    const gamma = f.codeRef.insert({ ...ref('edge', e.id, 'gamma', 'stale'), snippet: '' });
    f.refHashes.set(gamma.id, H('5'));
    f.edgeHashes.set(e.id, H('6'));
    await ops.deleteEdgeAction(e);
    await ops.history.undo();
    const [ne] = [...f.edge.rows.values()];
    const [nr] = [...f.codeRef.rows.values()];
    expect(f.reducers.setEdgeEvidenceCode).toHaveBeenCalledWith({ edgeId: ne.id, lineHash: H('6') });
    expect(f.reducers.setCodeRefHashes).toHaveBeenCalledWith({ refId: nr.id, lineHashes: H('5') });
    expect(nr.status).toBe('stale');
  });

  it('delete node → undo on a board that keeps no code: text refused, retried without it, hashes replayed', async () => {
    vi.mocked(showError).mockClear();
    const f = fakeConn('team', false);
    const ops = new Ops(f.conn, 'me', new History());
    const a = f.node.insert({ boardId: 1n, label: 'a', sublabel: '', x: 0, y: 0, w: 160, h: 80, token: 'ink', focal: false, kind: 'service' } as Node);
    const b = f.node.insert({ boardId: 1n, label: 'b', sublabel: '', x: 200, y: 0, w: 160, h: 80, token: 'ink', focal: false, kind: 'service' } as Node);
    // old text the wipe has not reached yet
    const e = f.edge.insert({ boardId: 1n, fromNode: a.id, toNode: b.id, label: 'calls', evidence: 'source:a.ts:2', evidenceSnippet: 'call();', evidenceStatus: 'ok' } as Edge);
    const alpha = f.codeRef.insert(ref('node', a.id, 'alpha', 'stale'));
    f.codeRef.insert(ref('edge', e.id, 'gamma'));
    f.refHashes.set(alpha.id, H('1'));
    f.edgeHashes.set(e.id, H('2'));

    await ops.deleteNodesAction([a], [e]);
    await ops.history.undo();
    expect(showError).not.toHaveBeenCalled();
    expect(f.refused).toEqual(['edge calls', 'ref alpha', 'update', 'ref gamma']);
    const [ne] = [...f.edge.rows.values()];
    expect([ne.evidence, ne.evidenceSnippet, ne.evidenceStatus]).toEqual(['source:a.ts:2', '', 'ok']);
    const refs = [...f.codeRef.rows.values()];
    expect(refs.map(r => [r.symbol, r.snippet, r.status]).sort()).toEqual([['alpha', '', 'stale'], ['gamma', '', 'ok']]);
    expect(f.reducers.setEdgeEvidenceCode).toHaveBeenCalledWith({ edgeId: ne.id, lineHash: H('2') });
    expect(f.reducers.setCodeRefHashes).toHaveBeenCalledWith({ refId: refs.find(r => r.symbol === 'alpha')!.id, lineHashes: H('1') });
  });

  it('delete edge → undo on a board that keeps no code: the edge and its ref come back without text', async () => {
    vi.mocked(showError).mockClear();
    const f = fakeConn(undefined, false);
    const ops = new Ops(f.conn, 'me', new History());
    const e = f.edge.insert({ boardId: 1n, fromNode: 1n, toNode: 2n, label: 'calls', evidence: 'source:a.ts:2', evidenceSnippet: 'call();', evidenceStatus: 'stale' } as Edge);
    f.codeRef.insert(ref('edge', e.id, 'gamma'));
    f.edgeHashes.set(e.id, H('3'));
    await ops.deleteEdgeAction(e);
    await ops.history.undo();
    expect(showError).not.toHaveBeenCalled();
    expect(f.refused).toEqual(['edge calls', 'ref gamma']);
    const [ne] = [...f.edge.rows.values()];
    expect([ne.evidence, ne.evidenceSnippet, ne.evidenceStatus]).toEqual(['source:a.ts:2', '', 'stale']);
    expect([...f.codeRef.rows.values()].map(r => [r.targetId, r.symbol, r.snippet])).toEqual([[ne.id, 'gamma', '']]);
    expect(f.reducers.setEdgeEvidenceCode).toHaveBeenCalledWith({ edgeId: ne.id, lineHash: H('3') });
  });

  it("an edit-link visitor's node-delete undo brings back the node and its edges, citing no code (U52)", async () => {
    vi.mocked(showError).mockClear();
    const f = fakeConn('link');
    const ops = new Ops(f.conn, 'me', new History());
    const a = f.node.insert({ boardId: 1n, label: 'a', sublabel: '', x: 0, y: 0, w: 160, h: 80, token: 'ink', focal: false, kind: 'service' } as Node);
    const b = f.node.insert({ boardId: 1n, label: 'b', sublabel: '', x: 200, y: 0, w: 160, h: 80, token: 'ink', focal: false, kind: 'service' } as Node);
    const cited = f.edge.insert({ boardId: 1n, fromNode: a.id, toNode: b.id, label: 'calls', evidence: 'source:a.ts:2', evidenceSnippet: 'call();', evidenceStatus: 'stale' } as Edge);
    const drawn = f.edge.insert({ boardId: 1n, fromNode: b.id, toNode: a.id, label: 'drawn', evidence: 'human:owner' } as Edge);
    const alpha = f.codeRef.insert(ref('node', a.id, 'alpha'));
    f.codeRef.insert(ref('edge', cited.id, 'gamma'));
    f.refHashes.set(alpha.id, H('7'));
    f.edgeHashes.set(cited.id, H('8'));

    await ops.deleteNodesAction([a], [cited, drawn]);
    await ops.history.undo();
    expect(showError).not.toHaveBeenCalled();
    expect([...f.node.rows.values()].map(n => n.label).sort()).toEqual(['a', 'b']);
    // the cited edge comes back as if drawn by hand: this client's default evidence
    expect([...f.edge.rows.values()].map(e => [e.label, e.evidence, e.evidenceSnippet || '', e.evidenceStatus || '']).sort())
      .toEqual([['calls', 'human:me', '', ''], ['drawn', 'human:owner', '', '']]);
    expect(f.cites).toEqual([]);
    expect(f.codeRef.rows.size).toBe(0);
    expect(f.reducers.setEdgeEvidenceCode).not.toHaveBeenCalled();
    expect(f.reducers.setCodeRefHashes).not.toHaveBeenCalled();
  });

  it("an edit-link visitor's edge-delete undo restores the edge with default evidence and no refs (U52)", async () => {
    vi.mocked(showError).mockClear();
    const f = fakeConn('link');
    const ops = new Ops(f.conn, 'me', new History());
    const e = f.edge.insert({ boardId: 1n, fromNode: 1n, toNode: 2n, label: 'calls', evidence: 'source:a.ts:2', evidenceSnippet: 'call();', evidenceStatus: 'stale' } as Edge);
    f.codeRef.insert(ref('edge', e.id, 'gamma'));
    await ops.deleteEdgeAction(e);
    await ops.history.undo();
    expect(showError).not.toHaveBeenCalled();
    const [ne] = [...f.edge.rows.values()];
    expect([ne.evidence, ne.evidenceSnippet || '', ne.evidenceStatus || '']).toEqual(['human:me', '', '']);
    expect(f.cites).toEqual([]);
  });
});
