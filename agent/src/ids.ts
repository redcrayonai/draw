/**
 * Reducers return nothing; a caller learns the id of a row it created by
 * snapshotting the board's id set before the call and diffing after the
 * promise resolves (the SDK applies the transaction's row updates to the client
 * cache before settling the reducer promise). Exactly one new id is the normal
 * case; zero or several means another writer landed in the same window.
 */
export type RowWithBoard = { id: bigint; boardId: bigint };

export function idsOf<R extends RowWithBoard>(rows: Iterable<R>, boardId: bigint): Set<bigint> {
  const out = new Set<bigint>();
  for (const r of rows) if (r.boardId === boardId) out.add(r.id);
  return out;
}

export function newIds(before: Set<bigint>, rows: Iterable<RowWithBoard>, boardId: bigint): bigint[] {
  const out: bigint[] = [];
  for (const r of rows) if (r.boardId === boardId && !before.has(r.id)) out.push(r.id);
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * New rows on the board that match this call's own input. Parallel tool calls
 * in one message all land between each other's snapshots; filtering by the
 * call's fields gives each caller its own id. Several ids remain only when
 * identical creates were in flight together.
 */
export function ownNewIds<R extends RowWithBoard>(
  before: Set<bigint>,
  rows: Iterable<R>,
  boardId: bigint,
  matches: (row: R) => boolean
): bigint[] {
  const own: R[] = [];
  for (const r of rows) if (r.boardId === boardId && !before.has(r.id) && matches(r)) own.push(r);
  return newIds(before, own, boardId);
}

export function describeCommit(created: bigint[]): string {
  if (created.length === 1) return `committed id=${created[0]}`;
  if (created.length === 0) return 'committed (no new row observed; re-read with get_board)';
  return `committed (${created.length} new rows: ${created.map(String).join(', ')} — another writer was active; re-read with get_board)`;
}
