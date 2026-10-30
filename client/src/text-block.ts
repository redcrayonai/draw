/**
 * Free text (kind 'text'): heading-sized lines with inline markdown —
 * **bold**, *italic*, ~~strike~~ and `code`. The label stores the markers;
 * the canvas draws them as styled tspans and the box fits the drawn text.
 */
import { fontWidth } from './node-text';

export interface Run {
  text: string;
  b: boolean;
  i: boolean;
  s: boolean;
  code: boolean;
}

type Flags = Omit<Run, 'text'>;

/** Font px per node size. */
const TEXT_SIZES: Record<string, number> = { s: 14, m: 20, l: 28 };

// Longest marker first, so ***x*** is bold italic rather than bold "*x". A
// closing ** or * never takes the first stars of a longer run, so an italic
// last word closes inside its bold (**a *b***) and a bold one inside its
// italic (*a **b***). Italic needs non-space inside both stars: 2 * 3 stays text.
const TOKEN = /`([^`]+)`|\*\*\*(.+?)\*\*\*|\*\*(.+?)\*\*(?!\*)|~~(.+?)~~|\*(?![\s*])((?:\*\*.+?\*\*|[^*])+?)(?<!\s)\*(?!\*)/;

export function parseInline(src: string, f: Flags = { b: false, i: false, s: false, code: false }): Run[] {
  const out: Run[] = [];
  let rest = src;
  while (rest.length > 0) {
    const m = TOKEN.exec(rest);
    if (m === null) {
      out.push({ text: rest, ...f });
      break;
    }
    if (m.index > 0) out.push({ text: rest.slice(0, m.index), ...f });
    if (m[1] !== undefined) out.push({ text: m[1], ...f, code: true });
    else if (m[2] !== undefined) out.push(...parseInline(m[2], { ...f, b: true, i: true }));
    else if (m[3] !== undefined) out.push(...parseInline(m[3], { ...f, b: true }));
    else if (m[4] !== undefined) out.push(...parseInline(m[4], { ...f, s: true }));
    else out.push(...parseInline(m[5], { ...f, i: true }));
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}

function runFont(r: Flags, px: number): string {
  const family = r.code ? "'Geist Mono', monospace" : "'Geist', system-ui, sans-serif";
  return `${r.i ? 'italic ' : ''}${r.b ? 700 : 500} ${px}px ${family}`;
}

export interface TextLayout {
  lines: Run[][];
  fontSize: number;
  lineHeight: number;
  /** The box that fits the text, on the 4 px grid. */
  w: number;
  h: number;
}

const up4 = (v: number) => Math.ceil(v / 4) * 4;

export function layoutText(label: string, size: string): TextLayout {
  const fontSize = TEXT_SIZES[size] ?? TEXT_SIZES.m;
  const lineHeight = up4(fontSize * 1.3);
  const lines = label.split('\n').map(line => parseInline(line));
  const width = Math.max(0, ...lines.map(runs => runs.reduce((sum, r) => sum + fontWidth(r.text, runFont(r, fontSize)), 0)));
  return { lines, fontSize, lineHeight, w: Math.max(16, up4(width)), h: lines.length * lineHeight };
}

/** Draw `label` into `target`, one tspan per line and one per styled run. */
export function drawTextBlock(target: SVGTextElement, label: string, size: string): void {
  const t = layoutText(label, size);
  target.setAttribute('font-size', String(t.fontSize));
  // Attributes, not CSS: the SVG export rewrites each element's style from a fixed list.
  // Keep the spaces layoutText measured (indents, aligned code).
  target.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:space', 'preserve');
  target.replaceChildren();
  t.lines.forEach((runs, i) => {
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'tspan');
    line.setAttribute('x', '0');
    // Baseline ≈0.34 em below the middle of its line box, where a textarea puts it.
    line.setAttribute('y', String(i * t.lineHeight + t.lineHeight / 2 + 0.34 * t.fontSize));
    for (const r of runs) {
      const span = document.createElementNS('http://www.w3.org/2000/svg', 'tspan');
      const cls = [r.b && 'md-b', r.i && 'md-i', r.code && 'md-code'].filter(Boolean).join(' ');
      if (cls) span.setAttribute('class', cls);
      if (r.s) span.setAttribute('text-decoration', 'line-through');
      span.textContent = r.text;
      line.append(span);
    }
    target.append(line);
  });
}

/**
 * Toggle `mark` (** or * or ~~ or `) around the selection: unwrap when the
 * selection already sits inside it, else wrap. Returns the new value and the
 * selection, which stays on the same text.
 */
export function toggleMark(value: string, start: number, end: number, mark: string): { value: string; start: number; end: number } {
  const before = value.slice(0, start);
  const after = value.slice(end);
  const inner = value.slice(start, end);
  const n = mark.length;
  // Stars stack: * is italic, ** bold, *** both. k = stars on both sides.
  const stars = mark === '*' || mark === '**';
  const has = (k: number) => (mark === '**' ? k >= 2 : k % 2 === 1);
  // Text that carries the markers itself (⌘A, or the whole label).
  const carries = (t: string) => t.length > 2 * n && (stars
    ? has(Math.min(/^\**/.exec(t)![0].length, /\**$/.exec(t)![0].length))
    : t.startsWith(mark) && t.endsWith(mark));
  if (inner.includes('\n')) {
    // Markers do not span lines (each line parses alone): toggle every non-blank line,
    // off when all of them carry the mark, else on where it is missing.
    const lines = inner.split('\n');
    const off = lines.every(l => l.trim() === '' || carries(l));
    const next = lines
      .map(l => (l.trim() === '' ? l : off ? l.slice(n, -n) : carries(l) ? l : mark + l + mark))
      .join('\n');
    return { value: before + next + after, start, end: start + next.length };
  }
  if (carries(inner)) {
    return { value: before + inner.slice(n, -n) + after, start, end: end - 2 * n };
  }
  const on = stars
    ? has(Math.min(/\**$/.exec(before)![0].length, /^\**/.exec(after)![0].length))
    : before.endsWith(mark) && after.startsWith(mark);
  if (on) {
    return { value: before.slice(0, -n) + value.slice(start, end) + after.slice(n), start: start - n, end: end - n };
  }
  return { value: before + mark + value.slice(start, end) + mark + after, start: start + n, end: end + n };
}
