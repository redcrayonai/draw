/**
 * Change note tools (spec 2026-10-16): the input shapes, reducer arguments,
 * get_board summary and tool texts of the hosted MCP server (mcp/src/tools.ts).
 */
import { z } from 'zod';
import {
  MAX_COLUMNS,
  MAX_READERS,
  MAX_STEPS,
  MAX_SUBJECTS,
  MAX_SUMMARY_CHARS,
  MAX_TITLE_CHARS,
  NOTE_KINDS,
  SEVERITIES,
  parseReaders,
  parseSubjects,
  type NoteKind,
  type ReaderStatus,
  type Severity,
} from '../../module/src/change-notes';

const id = z.string().regex(/^\d+$/).describe('numeric id as a string');
const line = z.number().int().positive();

const note = {
  kind: z.enum(NOTE_KINDS as [NoteKind, ...NoteKind[]]).describe('migration (others: breaking-api, data-loss, dependency)'),
  severity: z.enum(SEVERITIES as [Severity, ...Severity[]]).describe('destructive: drops or rewrites data, or cannot be undone; notable: a reviewer must still see it'),
  title: z.string().min(1).max(MAX_TITLE_CHARS).describe('short, e.g. "Migration 0042"'),
  summary: z.string().min(1).max(MAX_SUMMARY_CHARS).describe('one plain line: what changes, and what cannot be undone'),
  refId: id.describe('the code ref of the migration file itself (add_code_ref it first)'),
  steps: z
    .array(z.object({ label: z.string().min(1), startLine: line, endLine: line, irreversible: z.boolean().optional() }).strict())
    .max(MAX_STEPS)
    .optional()
    .describe("the migration's steps in order, each a line range inside the ref; mark the one that cannot be undone irreversible"),
  schema: z
    .object({
      table: z.string().min(1),
      columns: z
        .array(z.object({ name: z.string().min(1), type: z.string(), change: z.enum(['added', 'dropped', 'renamed']).nullable() }).strict())
        .min(1)
        .max(MAX_COLUMNS),
    })
    .strict()
    .optional()
    .describe("the table's columns after the change; change: added | dropped | renamed | null for unchanged"),
  subjects: z
    .array(z.object({ table: z.string().min(1), column: z.string().min(1), aliases: z.array(z.string().min(1)).optional() }).strict())
    .max(MAX_SUBJECTS)
    .optional()
    .describe('what readers depend on, e.g. { table: "customers", column: "name" }; aliases are other names code uses for it (ORM fields)'),
  readers: z
    .array(z.object({ refId: id, subject: z.number().int().min(0) }).strict())
    .max(MAX_READERS)
    .optional()
    .describe('code refs (add_code_ref) of code that reads a subject; subject is its index in subjects'),
};

export const noteInput = { anchorId: id.describe('the node the change is about, e.g. the datastore'), ...note };

export const noteUpdateInput = {
  noteId: id,
  kind: note.kind.optional(),
  severity: note.severity.optional(),
  title: note.title.optional(),
  summary: note.summary.optional(),
  refId: note.refId.optional(),
  steps: note.steps,
  schema: note.schema,
  subjects: note.subjects,
  readers: note.readers,
};

type NoteInput = z.infer<z.ZodObject<typeof noteInput>>;
type NoteUpdateInput = z.infer<z.ZodObject<typeof noteUpdateInput>>;

const json = (v: unknown) => (v === undefined ? '' : JSON.stringify(v));
const maybe = (v: unknown) => (v === undefined ? undefined : JSON.stringify(v));

export function addNoteArgs(boardId: bigint, input: NoteInput, author: string) {
  return {
    boardId,
    anchorId: BigInt(input.anchorId),
    kind: input.kind,
    severity: input.severity,
    title: input.title,
    summary: input.summary,
    refId: BigInt(input.refId),
    steps: json(input.steps),
    schema: json(input.schema),
    subjects: json(input.subjects),
    readers: json(input.readers),
    author,
  };
}

/** Fields left out stay undefined: the reducer keeps their stored value. */
export function updateNoteArgs(input: NoteUpdateInput) {
  return {
    id: BigInt(input.noteId),
    kind: input.kind,
    severity: input.severity,
    title: input.title,
    summary: input.summary,
    refId: input.refId === undefined ? undefined : BigInt(input.refId),
    steps: maybe(input.steps),
    schema: maybe(input.schema),
    subjects: maybe(input.subjects),
    readers: maybe(input.readers),
  };
}

export interface NoteRow {
  id: bigint;
  anchorId: bigint;
  refId: bigint;
  kind: string;
  severity: string;
  title: string;
  subjects: string;
  readers: string;
  reviewedBy: string;
}

export interface NoteSummary {
  id: string;
  anchorId: string;
  kind: string;
  severity: string;
  title: string;
  refId: string;
  readers: { refId: string; subject: string; status: ReaderStatus; removed?: true }[];
  reviewed: boolean;
}

const orEmpty = <T>(parse: () => T[]): T[] => {
  try {
    return parse();
  } catch {
    return [];
  }
};

export function noteSummary(row: NoteRow): NoteSummary {
  const subjects = orEmpty(() => parseSubjects(row.subjects));
  return {
    id: String(row.id),
    anchorId: String(row.anchorId),
    kind: row.kind,
    severity: row.severity,
    title: row.title,
    refId: String(row.refId),
    readers: orEmpty(() => parseReaders(row.readers)).map(r => {
      const s = subjects[r.subject];
      return { refId: r.refId, subject: s ? `${s.table}.${s.column}` : '?', status: r.status, ...(r.removed ? { removed: true as const } : {}) };
    }),
    reviewed: row.reviewedBy !== '',
  };
}

/** get_board's changeNotes, or undefined (left out of the JSON) when the board has none. */
export function noteSummaries(rows: NoteRow[]): NoteSummary[] | undefined {
  return rows.length === 0 ? undefined : [...rows].sort((a, b) => (a.id < b.id ? -1 : 1)).map(noteSummary);
}

export const SCHEMA_HINT = '; the schema card may have made the anchor taller: call layout_board if nodes now overlap';

export const ADD_NOTE_DESCRIPTION =
  'Flag a migration or another big or risky change so the reviewer sees it on the board: the anchor node shows a tag (and, with schema, the table shape), and readers show whether their code was updated. ' +
  'Use it only for changes a reviewer must not miss: schema migrations, dropped or renamed columns, data loss, breaking APIs. ' +
  'First add_code_ref the migration file (refId) and every reader you found by searching the code for the column (readers). ' +
  "Each reader's code ref must contain its subject's column or an alias, or the call is refused; add aliases for ORM names (createdAt for created_at). " +
  'Step lines must lie inside the ref. mark_checkpoint then reports readers that still read a changed column. Returns "committed id=<n>".';

export const UPDATE_NOTE_DESCRIPTION =
  'Change a change note by id (ids come from get_board changeNotes or the add_change_note result). Fields left out keep their value; readers, when given, replaces the list ' +
  '(readers already listed keep their status). Use it to point refId at a replacement code ref before removing the old one, and to add readers you found later. ' +
  'Changing severity, steps, schema, subjects or refId clears a review.';

export const REMOVE_NOTE_DESCRIPTION = 'Delete one change note by id (ids come from get_board changeNotes). The code refs it names stay.';

export const CHECKPOINT_NOTES_TEXT =
  ' changeNotes? { staleReaders [{ note, ref, path, line }], unconfirmed [path] } appears when there is something to do: fix each stale reader (its code still reads a changed column), then checkpoint again; ' +
  'an unconfirmed path is a changed migration file no change note cites: add_change_note for it, or exclude it.';

export const MAIN_REF_RULE_TEXT =
  " Refused while the ref is a change note's main ref: add_code_ref the migration again under another symbol, update_change_note with its refId, then remove_code_ref the old one.";
