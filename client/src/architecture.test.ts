import { describe, expect, it } from 'vitest';
import { comparisonBoard, diffScene, orderedSnapshots, reconciliationSnapshot, type Version } from './architecture';
import type { Node, Edge } from './module_bindings/types';

const node = (id: bigint, key: string, extra = {}): Node => ({
  id, boardId: 1n, sourceKey: key, label: key, sublabel: '', kind: 'service',
  x: 0, y: 0, w: 160, h: 80, token: 'ink', focal: false, doc: '', hidden: false,
  imported: true, shape: 'rect', color: '', strokeStyle: 'solid', size: 'm', ...extra,
} as Node);
const edge = (id: bigint, fromNode: bigint, toNode: bigint): Edge => ({
  id, boardId: 1n, fromNode, toNode, label: '', relation: 'imports', evidence: 'import',
  hidden: false, imported: true, color: '', strokeStyle: 'solid', evidenceSnippet: '', evidenceStatus: '',
} as Edge);
const version = (boardId: bigint, index: number, extra = {}): Version => ({
  boardId, historyId: 1n, index, assertionMode: 'fact', baseBoardId: 0n, ref: `v${index}`,
  sha: 'a'.repeat(40), status: 'ready', requestKey: '', reviewedSignature: '', implementedBoardId: 0n, ...extra,
});

describe('architecture comparisons', () => {
  it('orders facts by the requested ref order and compares proposals with their exact base', () => {
    const rows = [version(3n, 2), version(1n, 0), version(2n, 1), version(4n, 0, { assertionMode: 'intent', baseBoardId: 1n })];
    expect(orderedSnapshots(rows, 1n).map(v => v.boardId)).toEqual([1n, 2n, 3n]);
    expect(comparisonBoard(rows[0], rows)).toBe(2n);
    expect(comparisonBoard(rows[3], rows)).toBe(1n);
    expect(comparisonBoard(rows[1], rows)).toBeNull();
  });

  it('on a hand-drawn base marks label, sublabel and doc edits as changed, and edge label edits too', () => {
    const before = [node(1n, 'node:1'), node(2n, 'node:2')], beforeEdges = [edge(3n, 1n, 2n)];
    const after = [node(20n, 'node:1', { label: 'Renamed' }), node(30n, 'node:2', { doc: 'why' })];
    const afterEdges = [{ ...edge(40n, 20n, 30n), label: 'enqueues' } as Edge];
    const scene = diffScene(before, beforeEdges, after, afterEdges, { content: true });
    expect([...scene.nodeDiff]).toEqual([[20n, 'changed'], [30n, 'changed']]);
    expect([...scene.edgeDiff]).toEqual([[40n, 'changed']]);
    expect(diffScene(before, beforeEdges, after, afterEdges).nodeDiff.size).toBe(0);
  });

  it('on a hand-drawn base never lists rows added to the base after the fork, nor charts, as changes', () => {
    const before = [node(1n, 'node:1'), node(2n, '', { label: 'Added on main' }), node(3n, '', { kind: 'chart', label: 'Latency' })];
    const beforeEdges = [edge(4n, 1n, 2n), { ...edge(5n, 1n, 2n), relation: '' } as Edge];
    const after = [node(20n, 'node:1'), node(30n, '', { kind: 'chart', label: 'Latency' })];
    const scene = diffScene(before, beforeEdges, after, [], { content: true });
    expect(scene.removedNodes).toEqual([]);
    expect(scene.removedEdges).toEqual([]);
    expect(scene.nodeDiff.size).toBe(0);
  });

  it('ignores row IDs, labels, positions and hide state when comparing graph identity', () => {
    const before = [node(1n, 'go:a'), node(2n, 'go:b')];
    const after = [node(20n, 'go:a', { label: 'Renamed', x: 400, hidden: true }), node(30n, 'go:b')];
    const scene = diffScene(before, [edge(3n, 1n, 2n)], after, [edge(40n, 20n, 30n)]);
    expect(scene.nodeDiff.size).toBe(0);
    expect(scene.edgeDiff.size).toBe(0);
    expect(scene.removedNodes).toEqual([]);
  });

  it('renders removed rows as inert negative IDs and remaps their surviving endpoints', () => {
    const scene = diffScene([node(1n, 'go:a'), node(2n, 'go:b')], [edge(3n, 1n, 2n)], [node(4n, 'go:a'), node(5n, 'go:c')], []);
    expect(scene.nodeDiff.get(5n)).toBe('added');
    expect(scene.removedNodes[0].id).toBe(-2n);
    expect(scene.removedEdges[0]).toMatchObject({ id: -3n, fromNode: 4n, toNode: -2n });
    expect(scene.edgeDiff.get(-3n)).toBe('removed');
  });

  it('keeps an empty relation distinct from a factual import relation', () => {
    const nodes = [node(1n, 'go:a'), node(2n, 'go:b')];
    const scene = diffScene(nodes, [{ ...edge(3n, 1n, 2n), relation: '' }], nodes, [edge(4n, 1n, 2n)]);
    expect(scene.diff.addedEdges).toHaveLength(1);
    expect(scene.diff.removedEdges).toHaveLength(1);
  });

  it('finds a new import of the same repository after a proposal from the latest snapshot', () => {
    const proposal = version(2n, 0, { assertionMode: 'intent', baseBoardId: 1n });
    const rows = [version(1n, 0), proposal, version(3n, 0, { historyId: 2n, sha: 'b'.repeat(40) }), version(4n, 0, { historyId: 3n, sha: 'c'.repeat(40) })];
    const histories = [
      { id: 1n, repository: 'https://github.com/a/repo', createdAt: { microsSinceUnixEpoch: 1n } },
      { id: 2n, repository: 'https://github.com/A/Repo.git/', createdAt: { microsSinceUnixEpoch: 2n } },
      { id: 3n, repository: 'https://github.com/a/other', createdAt: { microsSinceUnixEpoch: 3n } },
    ];
    expect(reconciliationSnapshot(proposal, rows, histories)?.boardId).toBe(3n);
  });
});
