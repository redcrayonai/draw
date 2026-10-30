import { describe, expect, it, vi } from 'vitest';
import type { CodeRef, Edge } from './module_bindings/types';
import { buildNoteIndex, type NoteRow, type NoteView } from './change-notes-view';

// The real plain block; the highlighted one never arrives, so the DOM under test is stable.
vi.mock('./highlight', async importOriginal => {
  const real = await importOriginal<typeof import('./highlight')>();
  return { ...real, highlightSnippet: () => new Promise<HTMLElement>(() => {}) };
});
const { changeNoteSignature, renderChangeNotes } = await import('./change-note-inspector');

const MIGRATION = [
  'ALTER TABLE customers',
  '  ADD COLUMN first_name text,',
  '  ADD COLUMN last_name text;',
  'UPDATE customers SET first_name = split_part(name, \' \', 1);',
  'ALTER TABLE customers DROP COLUMN name;',
].join('\n');
const ref = (id: bigint, targetId: bigint, path: string, startLine: number, snippet: string): CodeRef =>
  ({ id, boardId: 1n, targetKind: 'node', targetId, path, symbol: 's', startLine, endLine: startLine + snippet.split('\n').length - 1, blobSha: 'x', snippet, author: '', checkpoint: 1, status: 'ok' }) as CodeRef;
const refs = new Map<bigint, CodeRef>([
  [20n, ref(20n, 4n, 'migrations/0042.sql', 1, MIGRATION)],
  [21n, ref(21n, 2n, 'services/billing/src/customers.ts', 22, 'return row.first_name;')],
  [22n, ref(22n, 3n, 'workers/invoice/src/bill-to.ts', 38, 'export async function loadBillTo() {\n  const [row] = await sql`\n    SELECT name, email`;')],
]);
const row = (o: Partial<NoteRow> = {}): NoteRow => ({
  id: 1n, boardId: 1n, anchorId: 4n, refId: 20n, kind: 'migration', severity: 'destructive', title: 'Migration 0042',
  summary: 'Splits name into first/last, then drops it.',
  // stored relative to the main ref's first line (line 1)
  steps: JSON.stringify([{ label: 'add', startLine: 0, endLine: 2 }, { label: 'backfill', startLine: 3, endLine: 3 }, { label: 'drop', startLine: 4, endLine: 4, irreversible: true }]),
  schema: JSON.stringify({ table: 'customers', columns: [{ name: 'name', type: 'text', change: 'dropped' }, { name: 'first_name', type: 'text', change: 'added' }] }),
  subjects: '[{"table":"customers","column":"name"}]',
  readers: JSON.stringify([{ refId: '21', subject: 0, status: 'updated', checkpoint: 1 }, { refId: '22', subject: 0, status: 'stale', checkpoint: 1 }]),
  reviewedBy: '', reviewedAt: { microsSinceUnixEpoch: 0n }, ...o,
});
const edges = [{ id: 10n, boardId: 1n, fromNode: 2n, toNode: 4n }, { id: 11n, boardId: 1n, fromNode: 3n, toNode: 4n }] as Edge[];
const views = (o: Partial<NoteRow> = {}): NoteView[] => buildNoteIndex([row(o)], refs, edges).byAnchor.get(4n)!;

function mount(notes: NoteView[], over: Partial<Parameters<typeof renderChangeNotes>[0]> = {}) {
  const host = document.createElement('div');
  host.append(...renderChangeNotes({ notes, refRow: id => refs.get(id), canReview: false, theme: 'dark', ...over }));
  document.body.replaceChildren(host);
  return host;
}

describe('renderChangeNotes', () => {
  it('renders head, readers, steps and breaking line for the mockup note', () => {
    const host = mount(views());
    expect(host.querySelector('.cn-title')?.textContent).toBe('Migration 0042');
    expect(host.querySelector('.cn-sev')?.textContent).toBe('destructive');
    expect([...host.querySelectorAll('.cn-delta')].map(d => d.textContent)).toEqual(['−name', '+first_name']);
    expect(host.querySelector('.cn-readers .eyebrow')?.textContent).toBe('READERS OF customers.name');
    const stale = host.querySelectorAll('.cn-reader.stale');
    expect(stale).toHaveLength(1);
    expect(stale[0].textContent).toContain('bill-to.ts:40');
    expect(host.querySelector('.cn-reader.updated')?.textContent).toContain('customers.ts:22');
    expect([...host.querySelectorAll('.cn-step')].map(s => s.textContent)).toEqual(['1', '2', '3']);
    // every line keeps one step column, numbered or blank, so line numbers stay aligned
    const lines = [...host.querySelectorAll('.cn-code .code-line')];
    expect(lines.map(l => l.querySelectorAll(':scope > .cn-step, :scope > .cn-step-slot').length)).toEqual(lines.map(() => 1));
    const danger = host.querySelectorAll('.cn-code .code-line.cn-danger');
    expect(danger).toHaveLength(1);
    expect(danger[0].textContent).toContain('DROP COLUMN');
    const breaking = host.querySelector('.cn-break')!;
    expect(breaking.textContent).toContain('breaks at 3');
    expect(breaking.querySelector('.code-line')?.textContent).toContain('SELECT name, email');
    expect(host.querySelector('.cn-error')?.textContent).toBe('on deploy: column "name" does not exist');
  });

  it('mark reviewed only when canReview', () => {
    expect(mount(views()).querySelector('.cn-review')).toBeNull();
    const markReviewed = vi.fn();
    const host = mount(views(), { canReview: true, markReviewed });
    const button = host.querySelector<HTMLButtonElement>('.cn-review')!;
    expect(button.textContent).toBe('mark reviewed');
    button.click();
    expect(markReviewed).toHaveBeenCalledWith(1n, true);
    const reviewed = mount(views({ reviewedBy: 'Ada', reviewedAt: { microsSinceUnixEpoch: BigInt(Date.now() - 120_000) * 1000n } }), { canReview: true, markReviewed });
    reviewed.querySelector<HTMLButtonElement>('.cn-review')!.click();
    expect(markReviewed).toHaveBeenLastCalledWith(1n, false);
  });

  it('a stale main ref warns and cannot be reviewed: its lines may not be the code in the file', () => {
    const stale = new Map(refs).set(20n, { ...refs.get(20n)!, status: 'stale' });
    const notes = buildNoteIndex([row()], stale, edges).byAnchor.get(4n)!;
    const host = document.createElement('div');
    host.append(...renderChangeNotes({ notes, refRow: id => stale.get(id), canReview: true, theme: 'dark', markReviewed: vi.fn() }));
    expect(host.querySelector('.cn-ref-stale')?.textContent).toContain('as last seen');
    expect(host.querySelector('.cn-review')).toBeNull();
  });

  it('reviewed state is shown to everyone', () => {
    const host = mount(views({ reviewedBy: 'Ada', reviewedAt: { microsSinceUnixEpoch: BigInt(Date.now() - 120_000) * 1000n } }));
    expect(host.querySelector('.cn-reviewed')?.textContent).toBe('reviewed by Ada · 2 min ago');
  });

  it('ask agent to fix hands over the prompt and the button', () => {
    const copyFix = vi.fn();
    const host = mount(views(), { copyFix });
    const ask = host.querySelector<HTMLButtonElement>('.cn-reader.stale button')!;
    expect(ask.textContent).toBe('ask agent to fix');
    ask.click();
    expect(copyFix).toHaveBeenCalledWith(
      'Migration 0042 changes customers.name, but workers/invoice/src/bill-to.ts:40 still reads it. Update that code to the new columns, then call mark_checkpoint.',
      ask
    );
    expect(host.querySelector('.cn-reader.updated button')).toBeNull();
  });

  it('a removed reader says so and has no fix button', () => {
    const host = mount(views({ readers: JSON.stringify([{ refId: '22', subject: 0, status: 'unknown', checkpoint: 1, removed: true }]) }));
    const r = host.querySelector('.cn-reader.unknown')!;
    expect(r.textContent).toContain('ref removed');
    expect(r.querySelector('button')).toBeNull();
  });

  it('memo repaints on reader status change and on review', () => {
    const base = changeNoteSignature(views(), false);
    expect(changeNoteSignature(views(), false)).toBe(base);
    expect(changeNoteSignature(views({ readers: JSON.stringify([{ refId: '22', subject: 0, status: 'updated', checkpoint: 2 }]) }), false)).not.toBe(base);
    expect(changeNoteSignature(views({ reviewedBy: 'Ada' }), false)).not.toBe(base);
    expect(changeNoteSignature(views(), true)).not.toBe(base);
  });
});
