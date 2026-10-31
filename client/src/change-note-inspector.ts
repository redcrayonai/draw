import type { CodeRef } from './module_bindings/types';
import { highlightSnippet, languageForPath, plainSnippet } from './highlight';
import { fixPrompt, type NoteView, type ReaderView } from './change-notes-view';

/**
 * The change note block of the node inspector (spec 2026-10-16, D5, D8, D12):
 * what changed, the code that reads it, the migration with its numbered steps,
 * the line each stale reader will break on, and the review. chrome.ts places
 * it above the node's CODE section and owns the memo (changeNoteSignature).
 */
export interface ChangeNotePanel {
  notes: readonly NoteView[];
  refRow: (id: bigint) => CodeRef | undefined;
  /** D12: a signed-in person who may edit the board. Everyone else sees the review, never the button. */
  canReview: boolean;
  theme: CodeTheme;
  markReviewed?: (id: bigint, reviewed: boolean) => void;
  /** "ask agent to fix" (D8): the caller copies the prompt and flashes the button. */
  copyFix?: (text: string, button: HTMLButtonElement) => void;
  now?: () => number;
}

type CodeTheme = Parameters<typeof highlightSnippet>[2];

const KIND_LABEL: Record<string, string> = { migration: 'migration', 'breaking-api': 'breaking API', 'data-loss': 'data loss', dependency: 'dependency' };
const STATUS_TEXT = { stale: 'still reads', updated: 'updated', unknown: 'unknown' } as const;
const MARK = { stale: '!', updated: '✓', unknown: '?' } as const;

function div(className: string, text?: string): HTMLDivElement {
  const d = document.createElement('div');
  d.className = className;
  if (text !== undefined) d.textContent = text;
  return d;
}

function span(className: string, text: string): HTMLSpanElement {
  const s = document.createElement('span');
  s.className = className;
  s.textContent = text;
  return s;
}

function button(className: string, text: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = className;
  b.textContent = text;
  b.addEventListener('click', onClick);
  return b;
}

/** Repaint when anything the block shows changes; positions of unrelated rows never do. */
export function changeNoteSignature(notes: readonly NoteView[], canReview: boolean): string {
  return [
    canReview ? 'review' : 'view',
    ...notes.map(n =>
      [n.id, n.severity, n.title, n.summary, n.reviewedBy, n.reviewedAt?.getTime() ?? '', JSON.stringify(n.steps), JSON.stringify(n.schema),
        n.readers.map(r => `${r.refId}:${r.status}:${r.line}:${r.removed ? 1 : 0}`).join(',')].join('|')
    ),
  ].join('\n');
}

export function renderChangeNotes(p: ChangeNotePanel): HTMLElement[] {
  return p.notes.map(note => renderNote(note, p));
}

function renderNote(note: NoteView, p: ChangeNotePanel): HTMLElement {
  const box = div(`cn-note sev-${note.severity}`);
  box.append(head(note), readers(note, p));
  const main = p.refRow(note.refId);
  if (main) box.append(mainCode(note, main, p));
  const breaksAt = Math.max(note.steps.findIndex(s => s.irreversible) + 1, 0) || note.steps.length;
  for (const r of note.readers) {
    if (r.status === 'stale') {
      const ref = p.refRow(r.refId);
      if (ref) box.append(breakingLine(note, r, ref, breaksAt, p));
    }
  }
  box.append(footer(note, p));
  return box;
}

function head(note: NoteView): HTMLElement {
  const h = div('cn-head');
  const row = div('cn-title-row');
  row.append(span('cn-kind', KIND_LABEL[note.kind] ?? 'change'), span('cn-title', note.title), span('cn-sev', note.severity));
  h.append(row);
  const changed = (note.schema?.columns ?? []).filter(c => c.change !== null);
  if (changed.length > 0) {
    const deltas = div('cn-deltas');
    if (note.schema) deltas.append(span('cn-table', note.schema.table));
    for (const c of changed) {
      const [cls, sign] = c.change === 'added' ? ['add', '+'] : c.change === 'dropped' ? ['drop', '−'] : ['rename', '~'];
      deltas.append(span(`cn-delta ${cls}`, `${sign}${c.name}`));
    }
    h.append(deltas);
  }
  h.append(div('cn-summary', note.summary));
  return h;
}

function readers(note: NoteView, p: ChangeNotePanel): HTMLElement {
  const box = div('cn-readers');
  const subjects = note.subjects.map(s => `${s.table}.${s.column}`).join(', ');
  box.append(div('eyebrow', subjects ? `READERS OF ${subjects}` : 'READERS'));
  if (note.readers.length === 0) box.append(div('cn-reader none', 'no readers cited'));
  for (const r of note.readers) {
    const row = div(`cn-reader ${r.status}${r.removed ? ' removed' : ''}`);
    row.append(
      span('cn-reader-mark', MARK[r.status]),
      span('cn-reader-path', r.path ? `${r.path}:${r.line}` : `ref ${r.refId}`),
      span('cn-reader-status', r.removed ? 'ref removed' : STATUS_TEXT[r.status])
    );
    if (r.status === 'stale' && p.copyFix) {
      const ask: HTMLButtonElement = button('ctl', 'ask agent to fix', () => p.copyFix!(fixPrompt(note, r), ask));
      row.append(ask);
    }
    box.append(row);
  }
  return box;
}

/** A snippet shown plain at once, then highlighted; `decorate` runs on both. */
function code(source: string, path: string, startLine: number, symbol: string, theme: CodeTheme, decorate: (block: HTMLElement) => void): HTMLElement {
  const holder = div('cn-snippet');
  const show = (block: HTMLElement) => {
    decorate(block);
    holder.replaceChildren(block);
  };
  show(plainSnippet(source, startLine, symbol));
  void highlightSnippet(source, languageForPath(path), theme, startLine, symbol).then(show, () => {});
  return holder;
}

function mainCode(note: NoteView, ref: CodeRef, p: ChangeNotePanel): HTMLElement {
  const box = div('cn-code');
  box.append(div('cn-ref-path', `${ref.path}:${ref.startLine}-${ref.endLine}`));
  if (ref.status !== 'ok') {
    box.append(div('cn-ref-stale', `${ref.status}: these lines are as last seen, not the file now; the agent must cite the migration again before it can be reviewed`));
  }
  box.append(
    code(ref.snippet, ref.path, ref.startLine, '', p.theme, block => {
      [...block.querySelectorAll<HTMLElement>('.code-line')].forEach((line, i) => {
        const n = ref.startLine + i;
        const at = note.steps.findIndex(s => s.startLine === n);
        // One step column on every line, numbered on a step's first line, so line numbers stay aligned.
        line.prepend(at >= 0 ? span(`cn-step${note.steps[at].irreversible ? ' danger' : ''}`, String(at + 1)) : span('cn-step-slot', ''));
        if (note.steps.some(s => s.irreversible && n >= s.startLine && n <= s.endLine)) line.classList.add('cn-danger');
      });
    })
  );
  return box;
}

function breakingLine(note: NoteView, r: ReaderView, ref: CodeRef, breaksAt: number, p: ChangeNotePanel): HTMLElement {
  const box = div('cn-break');
  const top = div('cn-break-head');
  top.append(span('cn-ref-path', `${r.path}:${r.line}`));
  if (breaksAt > 0) top.append(span('cn-breaks', `breaks at ${breaksAt}`));
  box.append(top);
  const line = r.line ?? ref.startLine;
  const text = ref.snippet.split('\n')[line - ref.startLine] ?? '';
  box.append(code(text, ref.path, line, r.column, p.theme, block => block.querySelector('.code-line')?.classList.add('cn-danger')));
  const gone = note.schema?.columns.find(c => c.name === r.column && (c.change === 'dropped' || c.change === 'renamed'));
  if (gone) box.append(div('cn-error', `on deploy: column "${r.column}" does not exist`));
  return box;
}

function ago(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

function footer(note: NoteView, p: ChangeNotePanel): HTMLElement {
  const foot = div('cn-foot');
  if (note.reviewed) {
    const when = note.reviewedAt ? ` · ${ago((p.now ?? Date.now)() - note.reviewedAt.getTime())}` : '';
    foot.append(div('cn-reviewed', `reviewed by ${note.reviewedBy}${when}`));
  }
  // A review approves the code shown; while the main ref is not ok that may not be the code in the file (D9).
  if (p.canReview && p.markReviewed && (note.mainRefStatus === 'ok' || note.reviewed)) {
    foot.append(button('ctl strong cn-review', note.reviewed ? 'clear review' : 'mark reviewed', () => p.markReviewed!(note.id, !note.reviewed)));
  }
  return foot;
}
