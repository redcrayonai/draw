import { describe, expect, it } from 'vitest';
import { positional, safeToken, safeU64, sql } from './db';

describe('SQL holes (Decision 16)', () => {
  it('accept only SafeU64 and SafeToken', () => {
    const id = safeU64('42')!;
    expect(sql`SELECT * FROM visible_node WHERE id = ${id}`.text).toBe('SELECT * FROM visible_node WHERE id = 42');
    // @ts-expect-error a plain string hole fails tsc
    sql`SELECT * FROM visible_node WHERE label = ${'x'}`;
    // @ts-expect-error so does a number
    sql`SELECT * FROM visible_node WHERE id = ${42}`;
  });

  it.each(["' OR 1=1 --", "\\'", 'a\u0000b', '’ OR ‘', '1; DROP TABLE board', '-1', 'a-b', ''])(
    'refuse %j before any query is built',
    value => {
      expect(safeU64(value)).toBeUndefined();
      expect(safeToken(value)).toBeUndefined();
      // a cast cannot smuggle it past the run-time check either
      expect(() => sql`SELECT ${value as never}`).toThrow('unsafe SQL hole');
    }
  );

  it('ids below 2^53 pass; 2^53 and above are refused', () => {
    expect(safeU64('9007199254740991')).toBe(9007199254740991n);
    expect(safeU64('9007199254740992')).toBeUndefined();
  });
});

describe('positional', () => {
  it('orders arguments as the bindings do, encoding options and u64s', () => {
    expect(positional('create_edge', { boardId: 7n, fromNode: '1', toNode: 2n, label: 'uses', evidence: 'import' })).toEqual([
      7n, 1n, 2n, 'uses', 'import', { none: [] }, { none: [] }, { none: [] },
    ]);
    expect(positional('set_node_hidden', { nodeId: 5n, hidden: true, setName: 'vendor' })).toEqual([5n, true, { some: 'vendor' }]);
  });

  it('refuses unknown and missing arguments', () => {
    expect(() => positional('move_node', { nodeId: 1n, x: 0, y: 0, z: 1 })).toThrow('takes no argument z');
    expect(() => positional('move_node', { nodeId: 1n, x: 0 })).toThrow('needs y');
  });
});
