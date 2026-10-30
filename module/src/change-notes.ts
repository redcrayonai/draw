// Change note contracts: the single source of truth for change notes (spec 2026-10-16).
// Zero imports, erasable TypeScript only, ES2021 APIs only: the module bundle, the client,
// the agent and `node --experimental-strip-types` all load this file as is.

export type NoteKind = 'migration' | 'breaking-api' | 'data-loss' | 'dependency';
export type Severity = 'destructive' | 'notable';
export type ReaderStatus = 'stale' | 'updated' | 'unknown';
export interface Step { label: string; startLine: number; endLine: number; irreversible?: boolean }
export interface SchemaColumn { name: string; type: string; change: 'added' | 'dropped' | 'renamed' | null }
export interface Schema { table: string; columns: SchemaColumn[] }
export interface Subject { table: string; column: string; aliases?: string[] }
export interface ReaderInput { refId: string; subject: number }
export interface Reader extends ReaderInput { status: ReaderStatus; checkpoint: number; removed?: true }

export const NOTE_KINDS: readonly NoteKind[] = ['migration', 'breaking-api', 'data-loss', 'dependency'];
export const SEVERITIES: readonly Severity[] = ['destructive', 'notable'];
const STATUSES: readonly ReaderStatus[] = ['stale', 'updated', 'unknown'];
const CHANGES = ['added', 'dropped', 'renamed'];

export const MAX_SUMMARY_CHARS = 200;
export const MAX_TITLE_CHARS = 80;
export const MAX_STEPS = 12;
export const MAX_SUBJECTS = 16;
export const MAX_ALIASES = 16;
export const MAX_ALIAS_CHARS = 100;
export const MAX_READERS = 32;
export const MAX_COLUMNS = 200;
export const MAX_UNCHANGED_SHOWN = 4;
/** The card never shows more rows than this, so a new table's card stays bounded too. */
export const MAX_ROWS_SHOWN = 10;
// Schema card geometry in px: the module grows the anchor to this height, render.ts draws it.
// Title block, 24 px rows, and a footer row (like a chart card's) for "+N more" and the ref
// badge. 60 + 24n + 28 stays on the 4px grid (assertOnGrid).
export const SCHEMA_HEAD_H = 60;
export const SCHEMA_ROW_H = 24;
export const SCHEMA_FOOT_H = 28;

export const NOTE_KIND_RULE = 'change note kind must be migration, breaking-api, data-loss or dependency';
export const NOTE_SEVERITY_RULE = 'change note severity must be destructive or notable';
export const NOTE_TITLE_RULE = 'change note title must be 1 to 80 characters';
export const NOTE_SUMMARY_RULE = 'change note summary must be 1 to 200 characters';
export const NOTE_JSON_RULE = 'change note steps, schema, subjects and readers must be valid JSON in the documented shape';
export const STEP_RANGE_RULE = "change note step lines must lie inside the main code ref's lines";
export const READER_SUBJECT_RULE = 'every change note reader must name a subject by its index';
export const READER_TERM_RULE = "a change note reader's code ref must contain its subject's column or an alias";
export const NOTE_LIMIT_RULE = 'change note has too many steps, subjects, readers or columns';
export const NOTE_ALIAS_RULE = 'a change note subject takes at most 16 aliases of at most 100 characters each';

export function checkKind(kind: string): NoteKind {
  if ((NOTE_KINDS as readonly string[]).indexOf(kind) < 0) throw new Error(NOTE_KIND_RULE);
  return kind as NoteKind;
}

export function checkSeverity(s: string): Severity {
  if ((SEVERITIES as readonly string[]).indexOf(s) < 0) throw new Error(NOTE_SEVERITY_RULE);
  return s as Severity;
}

export function checkText(title: string, summary: string): void {
  if (title.trim() === '' || title.length > MAX_TITLE_CHARS) throw new Error(NOTE_TITLE_RULE);
  if (summary.trim() === '' || summary.length > MAX_SUMMARY_CHARS) throw new Error(NOTE_SUMMARY_RULE);
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v !== '';
const isLine = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;
const isId = (v: unknown): v is string => typeof v === 'string' && /^\d+$/.test(v);

function parse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    throw new Error(NOTE_JSON_RULE);
  }
}

function arr(v: unknown, max: number): unknown[] {
  if (!Array.isArray(v)) throw new Error(NOTE_JSON_RULE);
  if (v.length > max) throw new Error(NOTE_LIMIT_RULE);
  return v;
}

/** A JSON array argument: '' is the empty list. */
const list = (json: string, max: number): unknown[] => (json === '' ? [] : arr(parse(json), max));

export function parseSteps(json: string, ref: { startLine: number; endLine: number }): Step[] {
  return list(json, MAX_STEPS).map(s => {
    if (!isObj(s) || !isStr(s.label) || !isLine(s.startLine) || !isLine(s.endLine)) throw new Error(NOTE_JSON_RULE);
    if (s.irreversible !== undefined && typeof s.irreversible !== 'boolean') throw new Error(NOTE_JSON_RULE);
    if (s.startLine > s.endLine || s.startLine < ref.startLine || s.endLine > ref.endLine) throw new Error(STEP_RANGE_RULE);
    const step: Step = { label: s.label, startLine: s.startLine, endLine: s.endLine };
    if (s.irreversible) step.irreversible = true;
    return step;
  });
}

export function parseSchema(json: string): Schema | null {
  if (json === '') return null;
  const v = parse(json);
  if (!isObj(v) || !isStr(v.table)) throw new Error(NOTE_JSON_RULE);
  const columns = arr(v.columns, MAX_COLUMNS).map(c => {
    if (!isObj(c) || !isStr(c.name) || typeof c.type !== 'string') throw new Error(NOTE_JSON_RULE);
    if (c.change !== null && CHANGES.indexOf(c.change as string) < 0) throw new Error(NOTE_JSON_RULE);
    return { name: c.name, type: c.type, change: c.change as SchemaColumn['change'] };
  });
  if (columns.length === 0) throw new Error(NOTE_JSON_RULE);
  return { table: v.table, columns };
}

export function parseSubjects(json: string): Subject[] {
  return list(json, MAX_SUBJECTS).map(s => {
    if (!isObj(s) || !isStr(s.table) || !isStr(s.column)) throw new Error(NOTE_JSON_RULE);
    const subject: Subject = { table: s.table, column: s.column };
    if (s.aliases !== undefined) {
      if (!Array.isArray(s.aliases) || !s.aliases.every(isStr)) throw new Error(NOTE_JSON_RULE);
      if (s.aliases.length > 0) subject.aliases = s.aliases as string[];
    }
    return subject;
  });
}

/** hasTerm compiles every alias into one regex per reader check. Writes only: rows stored before the cap must still read. */
export function checkAliases(subjects: Subject[]): Subject[] {
  const over = (a: string[] = []) => a.length > MAX_ALIASES || a.some(x => x.length > MAX_ALIAS_CHARS);
  if (subjects.some(s => over(s.aliases))) throw new Error(NOTE_ALIAS_RULE);
  return subjects;
}

export function parseReaderInputs(json: string, subjectCount: number): ReaderInput[] {
  return list(json, MAX_READERS).map(r => {
    if (!isObj(r) || !isId(r.refId)) throw new Error(NOTE_JSON_RULE);
    const subject = r.subject;
    if (typeof subject !== 'number' || !Number.isInteger(subject) || subject < 0 || subject >= subjectCount) throw new Error(READER_SUBJECT_RULE);
    return { refId: r.refId, subject };
  });
}

export function parseReaders(json: string): Reader[] {
  return list(json, MAX_READERS).map(r => {
    if (!isObj(r) || !isId(r.refId) || typeof r.subject !== 'number' || !Number.isInteger(r.subject) || r.subject < 0) throw new Error(NOTE_JSON_RULE);
    if ((STATUSES as readonly unknown[]).indexOf(r.status) < 0 || typeof r.checkpoint !== 'number' || !Number.isInteger(r.checkpoint)) throw new Error(NOTE_JSON_RULE);
    const reader: Reader = { refId: r.refId, subject: r.subject, status: r.status as ReaderStatus, checkpoint: r.checkpoint };
    if (r.removed === true) reader.removed = true;
    return reader;
  });
}

export function termsOf(subject: Subject): string[] {
  return [subject.column, ...(subject.aliases ?? [])];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** True when any term occurs in text as a whole identifier: `name` matches `row.name`, never `first_name`. */
export function hasTerm(text: string, terms: string[]): boolean {
  if (terms.length === 0) return false;
  return new RegExp(`(?<![A-Za-z0-9_$])(?:${terms.map(escapeRe).join('|')})(?![A-Za-z0-9_$])`).test(text);
}

/**
 * D4, in order: an ok ref is judged by its snippet; a stale or ambiguous ref by
 * the whole current file, where a term still present is unknown, never green;
 * a deleted file no longer reads anything.
 */
export function readerStatus(refStatus: string, snippet: string, file: string | 'missing' | 'unreadable', terms: string[]): ReaderStatus {
  if (refStatus === 'ok') return hasTerm(snippet, terms) ? 'stale' : 'updated';
  if (file === 'missing') return 'updated';
  if (file === 'unreadable') return 'unknown';
  return hasTerm(file, terms) ? 'unknown' : 'updated';
}

const MIGRATION_DIR = /(^|\/)(migrations|migrate|alembic\/versions|drizzle)\//;

/** A path that looks like a schema migration, from the path alone (the server never sees uncited content). */
export function isMigrationPath(path: string): boolean {
  return MIGRATION_DIR.test(path) && !/\.md$/i.test(path);
}

/** The columns a schema card shows: changed ones and the first few unchanged, in order, at most MAX_ROWS_SHOWN. */
export function schemaRows(schema: Schema): { rows: SchemaColumn[]; more: number } {
  let unchanged = 0;
  const rows = schema.columns.filter(c => c.change !== null || unchanged++ < MAX_UNCHANGED_SHOWN).slice(0, MAX_ROWS_SHOWN);
  return { rows, more: schema.columns.length - rows.length };
}

/**
 * One card for an anchor with several notes (D9b): columns merged by table and
 * name in first-seen order, a change winning over unchanged. Several tables are
 * all named in the title, and each column names its table.
 */
export function mergeSchemas(schemas: readonly Schema[]): Schema | null {
  if (schemas.length === 0) return null;
  const tables = [...new Set(schemas.map(s => s.table))];
  const columns = new Map<string, SchemaColumn>();
  for (const s of schemas) {
    for (const c of s.columns) {
      const key = `${s.table}.${c.name}`;
      const held = columns.get(key);
      const named = tables.length > 1 ? { ...c, name: key } : c;
      if (!held || (held.change === null && c.change !== null)) columns.set(key, named);
    }
  }
  return { table: tables.join(' · '), columns: [...columns.values()] };
}

/** Steps as stored: line offsets from the main ref's first line, so they follow the ref when it moves. */
export function storeSteps(steps: readonly Step[], refStart: number): string {
  return JSON.stringify(steps.map(s => ({ ...s, startLine: s.startLine - refStart, endLine: s.endLine - refStart })));
}

/** Stored offsets moved from a ref starting at `fromStart` to one starting at `toStart`: same lines, new anchor. */
export function rebaseSteps(json: string, fromStart: number, toStart: number): string {
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return json;
  }
  if (!Array.isArray(v)) return json;
  const d = fromStart - toStart;
  return JSON.stringify(v.map(s => (isObj(s) && typeof s.startLine === 'number' && typeof s.endLine === 'number' ? { ...s, startLine: s.startLine + d, endLine: s.endLine + d } : s)));
}

/** Stored steps at the ref's current lines; a step that no longer fits the ref is left out, never all of them. */
export function stepsFor(json: string, ref: { startLine: number; endLine: number }): Step[] {
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(v)) return [];
  const out: Step[] = [];
  for (const s of v) {
    if (!isObj(s) || !isStr(s.label) || typeof s.startLine !== 'number' || typeof s.endLine !== 'number') continue;
    const step: Step = { label: s.label, startLine: ref.startLine + s.startLine, endLine: ref.startLine + s.endLine };
    if (s.irreversible === true) step.irreversible = true;
    if (step.startLine >= ref.startLine && step.endLine <= ref.endLine && step.startLine <= step.endLine) out.push(step);
  }
  return out;
}

export function schemaCardHeight(schema: Schema): number {
  return SCHEMA_HEAD_H + schemaRows(schema).rows.length * SCHEMA_ROW_H + SCHEMA_FOOT_H;
}
