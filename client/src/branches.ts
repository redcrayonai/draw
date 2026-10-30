import type { Version } from './architecture';

export type BranchStatus = 'draft' | 'submitted' | 'accepted' | 'rejected' | 'implemented';
export type Role = 'owner' | 'editor' | 'viewer';
export type BranchAction = 'submit' | 'accept' | 'reject' | 'merge' | 'reconcile';
export type Delta = { addedNodes: number; removedNodes: number; addedEdges: number; removedEdges: number };
export type BranchRow = {
  boardId: bigint;
  name: string;
  status?: BranchStatus;
  current: boolean;
  base: boolean;
  delta?: Delta;
  muted: boolean;
};

const WORDS: Record<BranchStatus, string> = { draft: 'Draft', submitted: 'In review', accepted: 'Accepted', rejected: 'Rejected', implemented: 'Merged' };
export const statusWord = (status: BranchStatus): string => WORDS[status] ?? status;

const CLOSED = new Set<string>(['implemented', 'rejected']);

/** The base at the root, then its branches: current first, open ones by name, closed ones last. */
export function branchTree(current: bigint, versions: Version[], names: Map<bigint, string>, deltas: (boardId: bigint) => Delta | undefined): BranchRow[] {
  const here = versions.find(v => v.boardId === current);
  const baseId = here?.assertionMode === 'intent' ? here.baseBoardId : current;
  const root: BranchRow = { boardId: baseId, name: names.get(baseId) ?? 'Board', current: baseId === current, base: true, muted: false };
  const rank = (r: BranchRow) => (r.current ? 0 : r.muted ? 2 : 1);
  const branches = versions
    .filter(v => v.assertionMode === 'intent' && v.baseBoardId === baseId)
    .map<BranchRow>(v => ({
      boardId: v.boardId,
      name: names.get(v.boardId) ?? 'Branch',
      status: v.status as BranchStatus,
      current: v.boardId === current,
      base: false,
      delta: deltas(v.boardId),
      muted: CLOSED.has(v.status),
    }))
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  return [root, ...branches];
}

export function branchActions(version: Version | undefined, role: Role, baseIsFact: boolean): BranchAction[] {
  if (!version || version.assertionMode !== 'intent' || role === 'viewer') return [];
  const s = version.status as BranchStatus;
  if (s === 'draft' || s === 'rejected') return ['submit'];
  if (role !== 'owner') return [];
  if (s === 'submitted') return ['accept', 'reject'];
  if (s === 'accepted') return [baseIsFact ? 'reconcile' : 'merge'];
  return [];
}

export function chipText(version: Version | undefined, boardName: string): { name: string; status?: string } {
  if (!version) return { name: boardName };
  if (version.assertionMode === 'fact') return { name: `${version.ref} · ${version.sha.slice(0, 7)}` };
  return { name: boardName, status: statusWord(version.status as BranchStatus) };
}
