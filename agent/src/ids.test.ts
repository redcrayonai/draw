import { describe, it, expect } from 'vitest';
import { describeCommit, idsOf, newIds, ownNewIds } from './ids';

const rows = (...pairs: Array<[bigint, bigint]>) => pairs.map(([id, boardId]) => ({ id, boardId }));

describe('ids', () => {
  it('idsOf keeps only the given board', () => {
    const s = idsOf(rows([1n, 7n], [2n, 7n], [3n, 8n]), 7n);
    expect([...s]).toEqual([1n, 2n]);
  });

  it('newIds returns ids added for the board since the snapshot, ascending', () => {
    const before = idsOf(rows([1n, 7n]), 7n);
    const after = rows([1n, 7n], [9n, 7n], [4n, 7n], [5n, 8n]);
    expect(newIds(before, after, 7n)).toEqual([4n, 9n]);
  });

  it('describeCommit reports one id, zero ids, or candidates', () => {
    expect(describeCommit([12n])).toBe('committed id=12');
    expect(describeCommit([])).toBe('committed (no new row observed; re-read with get_board)');
    expect(describeCommit([12n, 13n])).toBe(
      'committed (2 new rows: 12, 13 — another writer was active; re-read with get_board)'
    );
  });

  it('ownNewIds keeps only new rows matching the call input, so parallel creates each get their own id (F2)', () => {
    type N = { id: bigint; boardId: bigint; label: string; x: number };
    const before = idsOf<N>([{ id: 40n, boardId: 7n, label: 'old', x: 0 }], 7n);
    const after: N[] = [
      { id: 40n, boardId: 7n, label: 'old', x: 0 },
      { id: 41n, boardId: 7n, label: 'A', x: 0 },
      { id: 42n, boardId: 7n, label: 'B', x: 4 },
      { id: 43n, boardId: 7n, label: 'C', x: 8 },
      { id: 44n, boardId: 8n, label: 'B', x: 4 },
    ];
    const like = (label: string, x: number) => (r: N) => r.label === label && r.x === x;
    expect(ownNewIds(before, after, 7n, like('B', 4))).toEqual([42n]);
    expect(describeCommit(ownNewIds(before, after, 7n, like('C', 8)))).toBe('committed id=43');
    // two identical creates in flight: the candidates are listed, never a stranger's row
    const twins = [...after, { id: 45n, boardId: 7n, label: 'B', x: 4 }];
    expect(ownNewIds(before, twins, 7n, like('B', 4))).toEqual([42n, 45n]);
    expect(ownNewIds(before, after, 7n, like('Z', 0))).toEqual([]);
  });
});
