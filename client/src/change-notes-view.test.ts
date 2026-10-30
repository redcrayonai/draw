import { describe, expect, it } from 'vitest';
import { buildNoteIndex, fixPrompt, mergedSchema, type NoteRow } from './change-notes-view';
import type { CodeRef, Edge } from './module_bindings/types';

const SUBJECTS = '[{"table":"customers","column":"name"}]';
const SCHEMA = JSON.stringify({
  table: 'customers',
  columns: [
    { name: 'id', type: 'uuid', change: null },
    { name: 'name', type: 'text', change: 'dropped' },
    { name: 'first_name', type: 'text', change: 'added' },
  ],
});

const note = (o: Partial<NoteRow> = {}): NoteRow => ({
  id: 1n, boardId: 1n, anchorId: 4n, refId: 20n, kind: 'migration', severity: 'destructive', title: 'Migration 0042',
  summary: 'Splits name into first/last, then drops it.', steps: '[]', schema: SCHEMA, subjects: SUBJECTS, readers: '[]',
  reviewedBy: '', reviewedAt: { microsSinceUnixEpoch: 0n }, ...o,
});
const readers = (...rs: [string, string, true?][]) =>
  JSON.stringify(rs.map(([refId, status, removed]) => ({ refId, subject: 0, status, checkpoint: 1, ...(removed ? { removed } : {}) })));
const ref = (id: bigint, targetId: bigint, path: string, startLine: number, snippet: string, targetKind = 'node'): CodeRef =>
  ({ id, boardId: 1n, targetKind, targetId, path, symbol: 's', startLine, endLine: startLine + 5, blobSha: 'x', snippet, author: '', checkpoint: 1, status: 'ok' }) as CodeRef;
const edge = (id: bigint, fromNode: bigint, toNode: bigint) => ({ id, boardId: 1n, fromNode, toNode }) as Edge;

// The mockup: Billing API (2) and Invoice worker (3) both read Postgres (4).
const refs = new Map<bigint, CodeRef>([
  [20n, ref(20n, 4n, 'migrations/0042.sql', 1, 'ALTER TABLE customers DROP COLUMN name;')],
  [21n, ref(21n, 2n, 'services/billing/src/customers.ts', 22, 'return { first: row.first_name };')],
  [22n, ref(22n, 3n, 'workers/invoice/src/bill-to.ts', 38, 'export async function loadBillTo() {\n  const [row] = await sql`\n    SELECT name, email`;')],
]);
const edges = [edge(10n, 2n, 4n), edge(11n, 3n, 4n)];

describe('buildNoteIndex', () => {
  it('colors each reader edge by status and counts stale readers', () => {
    const index = buildNoteIndex([note({ readers: readers(['21', 'updated'], ['22', 'stale']) })], refs, edges);
    expect(index.edgeStatus.get(11n)).toEqual({ status: 'stale', label: 'reads customers.name' });
    expect(index.edgeStatus.get(10n)?.label).toBe('✓ updated');
    expect(index.counts).toEqual({ notes: 1, byKind: { migration: 1 }, staleReaders: 1 });
    const [view] = index.byAnchor.get(4n)!;
    expect(view.readers.map(r => [r.path, r.line, r.edgeId, r.nodeId])).toEqual([
      ['services/billing/src/customers.ts', 22, 10n, 2n],
      ['workers/invoice/src/bill-to.ts', 40, 11n, 3n],
    ]);
    expect(view.schema?.columns).toHaveLength(3);
    expect(index.pips.size).toBe(0);
  });

  it('a reader on the anchor itself gets no edge and no pip', () => {
    const own = new Map(refs).set(23n, ref(23n, 4n, 'db/views.sql', 3, 'SELECT name FROM customers'));
    const index = buildNoteIndex([note({ readers: readers(['23', 'stale']) })], own, edges);
    const [view] = index.byAnchor.get(4n)!;
    expect(view.readers[0].edgeId).toBeNull();
    expect(index.edgeStatus.size).toBe(0);
    expect(index.pips.has(4n)).toBe(false);
  });

  it('a stale reader node with no edge to the anchor gets a pip', () => {
    const index = buildNoteIndex([note({ readers: readers(['22', 'stale']) })], refs, [edge(10n, 2n, 4n)]);
    expect(index.pips).toEqual(new Set([3n]));
  });

  it('a reader ref on an edge colors that edge', () => {
    const onEdge = new Map(refs).set(24n, ref(24n, 11n, 'workers/invoice/src/q.ts', 5, 'SELECT name', 'edge'));
    const index = buildNoteIndex([note({ readers: readers(['24', 'stale']) })], onEdge, edges);
    expect(index.edgeStatus.get(11n)?.status).toBe('stale');
  });

  it('the worst status wins on a shared edge, and a removed reader is unknown, never green', () => {
    const second = new Map(refs).set(25n, ref(25n, 3n, 'workers/invoice/src/pdf.ts', 9, 'row.name'));
    const index = buildNoteIndex([note({ readers: readers(['22', 'updated'], ['25', 'unknown', true]) })], second, edges);
    expect(index.edgeStatus.get(11n)).toEqual({ status: 'unknown', label: '?' });
    const r = index.byAnchor.get(4n)![0].readers[1];
    expect([r.status, r.removed]).toEqual(['unknown', true]);
  });

  it('orders notes on one anchor destructive first, and merges their schemas', () => {
    const notable = note({
      id: 2n, severity: 'notable', title: 'Migration 0043',
      schema: JSON.stringify({ table: 'customers', columns: [{ name: 'id', type: 'uuid', change: null }, { name: 'email', type: 'text', change: 'renamed' }] }),
    });
    const index = buildNoteIndex([notable, note({ id: 3n })], refs, edges);
    const views = index.byAnchor.get(4n)!;
    expect(views.map(v => v.severity)).toEqual(['destructive', 'notable']);
    expect(mergedSchema(views)?.columns.map(c => [c.name, c.change])).toEqual([
      ['id', null], ['name', 'dropped'], ['first_name', 'added'], ['email', 'renamed'],
    ]);
    expect(mergedSchema([{ ...views[0], schema: null }])).toBeNull();
  });

  it('reads steps relative to the main ref, so they follow it when it moves', () => {
    const steps = JSON.stringify([{ label: 'drop', startLine: 0, endLine: 0, irreversible: true }, { label: 'gone', startLine: 30, endLine: 30 }]);
    const moved = new Map(refs).set(20n, ref(20n, 4n, 'migrations/0042.sql', 11, 'ALTER TABLE customers DROP COLUMN name;'));
    const [view] = buildNoteIndex([note({ steps })], moved, edges).byAnchor.get(4n)!;
    expect(view.steps).toEqual([{ label: 'drop', startLine: 11, endLine: 11, irreversible: true }]); // past the ref's end: left out
    expect(view.mainRefStatus).toBe('ok');
  });

  it('merges notes on different tables by table and names both', () => {
    const orders = note({ id: 4n, title: 'Migration 0050', schema: JSON.stringify({ table: 'orders', columns: [{ name: 'legacy', type: 'text', change: 'dropped' }] }) });
    const views = buildNoteIndex([note({ id: 3n }), orders], refs, edges).byAnchor.get(4n)!;
    const merged = mergedSchema(views)!;
    expect(merged.table).toBe('customers · orders');
    expect(merged.columns.map(c => c.name)).toContain('orders.legacy');
  });

  it('reads the review state and survives bad JSON', () => {
    const index = buildNoteIndex([note({ reviewedBy: 'Ada', reviewedAt: { microsSinceUnixEpoch: 1_700_000_000_000_000n }, readers: 'nope', steps: '{' })], refs, edges);
    const [view] = index.byAnchor.get(4n)!;
    expect(view.reviewed).toBe(true);
    expect(view.reviewedAt?.getTime()).toBe(1_700_000_000_000);
    expect(view.readers).toEqual([]);
    expect(view.steps).toEqual([]);
  });
});

describe('fixPrompt', () => {
  it('names the change, the reader line and the next step', () => {
    const index = buildNoteIndex([note({ readers: readers(['22', 'stale']) })], refs, edges);
    const view = index.byAnchor.get(4n)![0];
    expect(fixPrompt(view, view.readers[0])).toBe(
      'Migration 0042 changes customers.name, but workers/invoice/src/bill-to.ts:40 still reads it. Update that code to the new columns, then call mark_checkpoint.'
    );
  });
});
