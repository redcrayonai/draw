import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { addNoteArgs, noteInput, noteSummary, noteUpdateInput, updateNoteArgs } from './change-notes';

const input = {
  anchorId: '4',
  kind: 'migration' as const,
  severity: 'destructive' as const,
  title: 'Migration 0042',
  summary: 'Splits name into first/last, then drops it.',
  refId: '9',
};

describe('addNoteArgs', () => {
  it('serializes the JSON fields with string ref ids, and empty strings for absent ones', () => {
    expect(addNoteArgs(7n, input, 'claude')).toEqual({
      boardId: 7n, anchorId: 4n, kind: 'migration', severity: 'destructive', title: 'Migration 0042',
      summary: 'Splits name into first/last, then drops it.', refId: 9n, steps: '', schema: '', subjects: '', readers: '', author: 'claude',
    });
    const full = addNoteArgs(7n, {
      ...input,
      steps: [{ label: 'drop name', startLine: 12, endLine: 12, irreversible: true }],
      schema: { table: 'customers', columns: [{ name: 'name', type: 'text', change: 'dropped' }] },
      subjects: [{ table: 'customers', column: 'name' }],
      readers: [{ refId: '11', subject: 0 }],
    }, '');
    expect(JSON.parse(full.steps)).toEqual([{ label: 'drop name', startLine: 12, endLine: 12, irreversible: true }]);
    expect(JSON.parse(full.schema)).toEqual({ table: 'customers', columns: [{ name: 'name', type: 'text', change: 'dropped' }] });
    expect(JSON.parse(full.subjects)).toEqual([{ table: 'customers', column: 'name' }]);
    expect(JSON.parse(full.readers)).toEqual([{ refId: '11', subject: 0 }]);
  });
});

describe('updateNoteArgs', () => {
  it('passes only the given fields; the rest stay undefined (option none)', () => {
    const args = updateNoteArgs({ noteId: '3', summary: 'x' });
    expect(args).toEqual({ id: 3n, summary: 'x' });
    expect(Object.keys(args).sort()).toEqual(['id', 'kind', 'readers', 'refId', 'schema', 'severity', 'steps', 'subjects', 'summary', 'title']);
    expect(updateNoteArgs({ noteId: '3', refId: '12', readers: [{ refId: '11', subject: 0 }] })).toEqual({
      id: 3n, refId: 12n, readers: '[{"refId":"11","subject":0}]',
    });
  });
});

describe('input shapes', () => {
  it('accept the documented shape and refuse unknown keys and numeric ids', () => {
    const add = z.object(noteInput).strict();
    expect(add.safeParse(input).success).toBe(true);
    expect(add.safeParse({ ...input, refId: 9 }).success).toBe(false);
    expect(add.safeParse({ ...input, severity: 'caution' }).success).toBe(false);
    expect(add.safeParse({ ...input, extra: 1 }).success).toBe(false);
    const update = z.object(noteUpdateInput).strict();
    expect(update.safeParse({ noteId: '3' }).success).toBe(true);
    expect(update.safeParse({ noteId: '3', anchorId: '4' }).success).toBe(false);
  });
});

describe('noteSummary', () => {
  it('names each reader subject as table.column and reports the review', () => {
    const row = {
      id: 1n, boardId: 7n, anchorId: 4n, refId: 9n, kind: 'migration', severity: 'destructive', title: 'Migration 0042',
      subjects: '[{"table":"customers","column":"name"}]',
      readers: '[{"refId":"11","subject":0,"status":"stale","checkpoint":2},{"refId":"12","subject":0,"status":"unknown","checkpoint":2,"removed":true}]',
      reviewedBy: '',
    };
    expect(noteSummary(row)).toEqual({
      id: '1', anchorId: '4', kind: 'migration', severity: 'destructive', title: 'Migration 0042', refId: '9',
      readers: [
        { refId: '11', subject: 'customers.name', status: 'stale' },
        { refId: '12', subject: 'customers.name', status: 'unknown', removed: true },
      ],
      reviewed: false,
    });
    expect(noteSummary({ ...row, reviewedBy: 'Ada' }).reviewed).toBe(true);
    expect(noteSummary({ ...row, readers: 'not json' }).readers).toEqual([]);
  });
});
