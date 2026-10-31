// Change notes as the canvas shows them (spec 2026-10-16, D5-D9b): one pure
// pass over the note rows, the board's code refs and its visible edges gives
// what the board draws (anchor tags, reader edge colors, pips) and what the
// inspector lists. Rebuilt on table change, never per frame.
import {
  hasTerm,
  mergeSchemas,
  parseReaders,
  parseSchema,
  parseSubjects,
  stepsFor,
  termsOf,
  type NoteKind,
  type ReaderStatus,
  type Schema,
  type Severity,
  type Step,
  type Subject,
} from '../../module/src/change-notes';
import type { ChangeNote, CodeRef, Edge } from './module_bindings/types';

/** The note columns this view reads; the binding row satisfies it. */
export type NoteRow = Pick<
  ChangeNote,
  'id' | 'boardId' | 'anchorId' | 'refId' | 'kind' | 'severity' | 'title' | 'summary' | 'steps' | 'schema' | 'subjects' | 'readers' | 'reviewedBy'
> & { reviewedAt: { microsSinceUnixEpoch: bigint } };

export interface ReaderView {
  refId: bigint;
  subject: string; // table.column
  column: string;
  status: ReaderStatus;
  removed: boolean;
  path: string;
  line: number | null;
  nodeId: bigint | null;
  edgeId: bigint | null;
}

export interface NoteView {
  id: bigint;
  anchorId: bigint;
  kind: NoteKind;
  severity: Severity;
  title: string;
  summary: string;
  refId: bigint;
  /** the main ref's status: steps and review only mean something while it is 'ok' (null: the ref is gone) */
  mainRefStatus: string | null;
  steps: Step[];
  schema: Schema | null;
  subjects: Subject[];
  readers: ReaderView[];
  reviewedBy: string;
  reviewedAt: Date | null;
  reviewed: boolean;
}

export interface NoteIndex {
  /** worst severity first, then id */
  byAnchor: Map<bigint, NoteView[]>;
  edgeStatus: Map<bigint, { status: ReaderStatus; label: string }>;
  /** reader nodes with a stale reader and no edge to the anchor; never the anchor itself */
  pips: Set<bigint>;
  counts: { notes: number; byKind: Partial<Record<NoteKind, number>>; staleReaders: number };
}

const RANK: Record<ReaderStatus, number> = { updated: 0, unknown: 1, stale: 2 };

function attempt<T>(parse: () => T, fallback: T): T {
  try {
    return parse();
  } catch {
    return fallback;
  }
}

function edgeBetween(edges: readonly Edge[], a: bigint, b: bigint): Edge | undefined {
  return edges.find(e => (e.fromNode === a && e.toNode === b) || (e.fromNode === b && e.toNode === a));
}

export function buildNoteIndex(rows: Iterable<NoteRow>, refs: ReadonlyMap<bigint, CodeRef>, edges: readonly Edge[]): NoteIndex {
  const index: NoteIndex = { byAnchor: new Map(), edgeStatus: new Map(), pips: new Set(), counts: { notes: 0, byKind: {}, staleReaders: 0 } };
  const edgeById = new Map(edges.map(e => [e.id, e]));
  for (const row of rows) {
    const main = refs.get(row.refId);
    const subjects = attempt(() => parseSubjects(row.subjects), [] as Subject[]);
    const view: NoteView = {
      id: row.id,
      anchorId: row.anchorId,
      kind: row.kind as NoteKind,
      severity: row.severity as Severity,
      title: row.title,
      summary: row.summary,
      refId: row.refId,
      mainRefStatus: main?.status ?? null,
      steps: main ? stepsFor(row.steps, main) : [],
      schema: attempt(() => parseSchema(row.schema), null),
      subjects,
      readers: attempt(() => parseReaders(row.readers), []).map(r => {
        const ref = refs.get(BigInt(r.refId));
        const subject = subjects[r.subject];
        const terms = subject ? termsOf(subject) : [];
        let nodeId: bigint | null = null;
        let edgeId: bigint | null = null;
        if (ref?.targetKind === 'edge') {
          const e = edgeById.get(ref.targetId);
          edgeId = e ? e.id : null;
          nodeId = e ? (e.toNode === row.anchorId ? e.fromNode : e.toNode) : null;
        } else if (ref) {
          nodeId = ref.targetId;
          edgeId = nodeId === row.anchorId ? null : edgeBetween(edges, nodeId, row.anchorId)?.id ?? null;
        }
        const at = ref ? ref.snippet.split('\n').findIndex(l => hasTerm(l, terms)) : -1;
        return {
          refId: BigInt(r.refId),
          subject: subject ? `${subject.table}.${subject.column}` : '?',
          column: subject?.column ?? '',
          status: r.removed ? 'unknown' : r.status,
          removed: r.removed === true,
          path: ref?.path ?? '',
          line: ref ? ref.startLine + Math.max(at, 0) : null,
          nodeId,
          edgeId,
        };
      }),
      reviewedBy: row.reviewedBy,
      reviewedAt: row.reviewedBy === '' ? null : new Date(Number(row.reviewedAt.microsSinceUnixEpoch / 1000n)),
      reviewed: row.reviewedBy !== '',
    };
    index.counts.notes += 1;
    index.counts.byKind[view.kind] = (index.counts.byKind[view.kind] ?? 0) + 1;
    for (const r of view.readers) {
      if (r.status === 'stale') index.counts.staleReaders += 1;
      if (r.edgeId !== null) {
        const label = r.status === 'stale' ? `reads ${r.subject}` : r.status === 'updated' ? '✓ updated' : '?';
        const held = index.edgeStatus.get(r.edgeId);
        if (!held || RANK[r.status] > RANK[held.status]) index.edgeStatus.set(r.edgeId, { status: r.status, label });
      } else if (r.status === 'stale' && r.nodeId !== null && r.nodeId !== row.anchorId) {
        index.pips.add(r.nodeId);
      }
    }
    const list = index.byAnchor.get(view.anchorId) ?? [];
    list.push(view);
    index.byAnchor.set(view.anchorId, list);
  }
  for (const list of index.byAnchor.values()) {
    list.sort((a, b) => (a.severity === b.severity ? (a.id < b.id ? -1 : 1) : a.severity === 'destructive' ? -1 : 1));
  }
  return index;
}

/** One card for an anchor with several notes (mergeSchemas: by table and column, every table named). */
export function mergedSchema(notes: NoteView[]): Schema | null {
  return mergeSchemas(notes.flatMap(n => (n.schema ? [n.schema] : [])));
}

/** What "ask agent to fix" copies (D8): there is no channel from the board to a live agent yet. */
export function fixPrompt(note: NoteView, reader: ReaderView): string {
  return `${note.title} changes ${reader.subject}, but ${reader.path}:${reader.line} still reads it. Update that code to the new columns, then call mark_checkpoint.`;
}
