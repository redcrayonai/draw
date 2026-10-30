import { describe, expect, it } from 'vitest';
import { branchActions, branchTree, chipText, statusWord, type BranchRow } from './branches';
import type { Version } from './architecture';

const v = (boardId: number, over: Partial<Version> = {}): Version => ({
  boardId: BigInt(boardId), historyId: 0n, index: 0, assertionMode: 'intent', baseBoardId: 1n, ref: '', sha: '',
  status: 'draft', requestKey: `k${boardId}`, reviewedSignature: '', implementedBoardId: 0n, ...over,
});
const names = new Map<bigint, string>([[1n, 'acme-shop'], [2n, 'add-queue'], [3n, 'split-orders'], [4n, 'cache-ttl'], [5n, 'old-idea']]);
const delta = () => ({ addedNodes: 1, removedNodes: 0, addedEdges: 1, removedEdges: 0 });
const versions = [v(2, { status: 'submitted' }), v(3, { status: 'draft' }), v(4, { status: 'implemented', implementedBoardId: 1n }), v(5, { status: 'rejected' })];

describe('branchTree', () => {
  it('puts the base first, the current branch next, open branches by name, then merged and rejected muted', () => {
    const rows = branchTree(3n, versions, names, delta);
    expect(rows.map(r => r.name)).toEqual(['acme-shop', 'split-orders', 'add-queue', 'cache-ttl', 'old-idea']);
    expect(rows[0]).toMatchObject<Partial<BranchRow>>({ base: true, current: false, boardId: 1n, muted: false });
    expect(rows[1]).toMatchObject<Partial<BranchRow>>({ current: true, status: 'draft', delta: delta() });
    expect(rows.map(r => r.muted)).toEqual([false, false, false, true, true]);
  });

  it('on a plain board with no branches is the board alone, current', () => {
    const rows = branchTree(9n, [], new Map([[9n, 'scratch']]), delta);
    expect(rows).toEqual([{ boardId: 9n, name: 'scratch', current: true, base: true, muted: false }]);
  });

  it('on the base board lists its branches with the base current', () => {
    const rows = branchTree(1n, versions, names, delta);
    expect(rows[0]).toMatchObject({ boardId: 1n, current: true, base: true });
    expect(rows).toHaveLength(5);
  });
});

describe('statusWord', () => {
  it('speaks the five statuses', () => {
    expect((['draft', 'submitted', 'accepted', 'rejected', 'implemented'] as const).map(statusWord)).toEqual(['Draft', 'In review', 'Accepted', 'Rejected', 'Merged']);
  });
});

describe('branchActions', () => {
  it('follows status and role', () => {
    expect(branchActions(v(2, { status: 'draft' }), 'editor', false)).toEqual(['submit']);
    expect(branchActions(v(2, { status: 'rejected' }), 'owner', false)).toEqual(['submit']);
    expect(branchActions(v(2, { status: 'submitted' }), 'owner', false)).toEqual(['accept', 'reject']);
    expect(branchActions(v(2, { status: 'submitted' }), 'editor', false)).toEqual([]);
    expect(branchActions(v(2, { status: 'accepted' }), 'owner', false)).toEqual(['merge']);
    expect(branchActions(v(2, { status: 'accepted' }), 'owner', true)).toEqual(['reconcile']);
    expect(branchActions(v(2, { status: 'implemented' }), 'owner', false)).toEqual([]);
    expect(branchActions(v(2, { status: 'submitted' }), 'viewer', false)).toEqual([]);
    expect(branchActions(undefined, 'owner', false)).toEqual([]);
    expect(branchActions(v(1, { assertionMode: 'fact', status: 'ready' }), 'owner', false)).toEqual([]);
  });
});

describe('chipText', () => {
  it('names a plain board, a fact by ref and sha, a branch with its status', () => {
    expect(chipText(undefined, 'scratch')).toEqual({ name: 'scratch' });
    expect(chipText(v(1, { assertionMode: 'fact', ref: 'main', sha: '2222222222222222222222222222222222222222', status: 'ready' }), 'acme · main')).toEqual({ name: 'main · 2222222' });
    expect(chipText(v(2, { status: 'submitted' }), 'add-queue')).toEqual({ name: 'add-queue', status: 'In review' });
  });
});
