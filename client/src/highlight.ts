import { loadHighlighter, type LazyLang, type ShikiLang } from './highlighter-loader';
import { symbolNeedle } from './refs';
import { shikiTheme } from './shiki-themes';
import type { ThemeId } from '../../shared/themes';

const LANG_BY_EXT: Record<string, ShikiLang | LazyLang> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.go': 'go',
  '.json': 'json',
  '.css': 'css',
  '.html': 'html',
  '.md': 'markdown',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
  '.sh': 'shellscript',
  // lazy chunks, loaded on first expand (G52)
  '.svelte': 'svelte',
  '.jsonc': 'jsonc',
};

/** Shiki language id for a repo path, or null → plain mono. */
export function languageForPath(path: string): string | null {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) {
    return null; // no extension, or a dotfile like .gitignore
  }
  return LANG_BY_EXT[base.slice(dot).toLowerCase()] ?? null;
}

type Tok = { content: string; color?: string; italic: boolean };

const IDENT = /[\p{L}\p{N}_$]/u;

function isIdent(ch: string | undefined): boolean {
  return ch !== undefined && IDENT.test(ch);
}

/** Occurrences of `needle` in `line` that stand alone as an identifier: an
 *  identifier character next to the needle's own identifier edge means it is
 *  part of a longer name (`id` inside `width`), so it is skipped. */
function symbolRanges(line: string, needle: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  if (needle.length === 0) {
    return out;
  }
  const checkStart = isIdent(needle[0]);
  const checkEnd = isIdent(needle[needle.length - 1]);
  let i = line.indexOf(needle);
  while (i !== -1) {
    const end = i + needle.length;
    const startOk = !checkStart || !isIdent(line[i - 1]);
    const endOk = !checkEnd || !isIdent(line[end]);
    if (startOk && endOk) {
      out.push([i, end]);
      i = line.indexOf(needle, end);
    } else {
      i = line.indexOf(needle, i + 1);
    }
  }
  return out;
}

function inRange(ranges: Array<[number, number]>, pos: number): boolean {
  for (const [a, b] of ranges) {
    if (pos >= a && pos < b) {
      return true;
    }
  }
  return false;
}

function emit(target: HTMLElement, tok: Tok, text: string, underline: boolean): void {
  if (text.length === 0) {
    return;
  }
  if (tok.color === undefined && !tok.italic && !underline) {
    target.append(document.createTextNode(text));
    return;
  }
  const span = document.createElement(underline ? 'mark' : 'span');
  if (underline) {
    span.className = 'code-sym';
  }
  if (tok.color !== undefined) {
    span.style.color = tok.color;
  }
  if (tok.italic) {
    span.style.fontStyle = 'italic';
  }
  span.textContent = text;
  target.append(span);
}

/** Wrapping prefers these: a break after . ( [ { , keeps identifiers whole. */
const BREAK_AFTER = new Set(['.', '(', '[', '{', ',']);

/** Positions where a <wbr> may go: after BREAK_AFTER punctuation that is not
 *  already followed by whitespace, never inside the underlined symbol. */
function breakPoints(line: string, ranges: Array<[number, number]>): Set<number> {
  const out = new Set<number>();
  for (let p = 1; p < line.length; p++) {
    if (BREAK_AFTER.has(line[p - 1]) && !/\s/.test(line[p]) && !ranges.some(([a, b]) => p > a && p < b)) {
      out.add(p);
    }
  }
  return out;
}

/** Deepest indent a continuation follows: past it, rows hang at 12ch + 4ch so
 *  a deeply nested line in the 320 px panel still has room for its text. */
const MAX_HANG_INDENT = 12;

/** Display width of a line's leading whitespace in ch (tab stops every 4,
 *  matching the block's tab-size). */
function indentWidth(line: string): number {
  let col = 0;
  for (const ch of line) {
    if (ch === ' ') col += 1;
    else if (ch === '\t') col = (Math.floor(col / 4) + 1) * 4;
    else break;
  }
  return col;
}

/** Emit tokens, splitting each at symbol-range boundaries so a symbol that
 *  spans tokens (`Limiter` `.` `allow`) is underlined across all of them. */
function appendTokens(
  target: HTMLElement,
  toks: Tok[],
  ranges: Array<[number, number]>,
  breaks: ReadonlySet<number>
): void {
  let pos = 0;
  for (const tok of toks) {
    const len = tok.content.length;
    let segStart = 0;
    let segIn = inRange(ranges, pos);
    for (let k = 1; k <= len; k++) {
      const end = k === len;
      const nextIn = end ? segIn : inRange(ranges, pos + k);
      const brk = !end && breaks.has(pos + k);
      if (end || nextIn !== segIn || brk) {
        emit(target, tok, tok.content.slice(segStart, k), segIn);
        segStart = k;
        segIn = nextIn;
        if (brk) {
          target.append(document.createElement('wbr'));
        }
      }
    }
    pos += len;
    if (breaks.has(pos)) {
      target.append(document.createElement('wbr')); // a break on a token edge
    }
  }
}

function buildBlock(lines: Tok[][], lang: string | null, startLine: number, symbol: string): HTMLElement {
  // Underline the needle, the same rule the module checks the snippet with:
  // a `Class.member` ref's snippet starts at `member`, never at `Class.`.
  const needle = symbolNeedle(symbol);
  const block = document.createElement('div');
  block.className = 'code-block';
  block.dataset.lang = lang ?? 'plain';
  const width = String(startLine + lines.length - 1).length;
  lines.forEach((toks, i) => {
    const row = document.createElement('div');
    row.className = 'code-line';
    const gutter = document.createElement('span');
    gutter.className = 'code-gutter';
    gutter.setAttribute('aria-hidden', 'true');
    gutter.textContent = String(startLine + i).padStart(width, ' ');
    const text = document.createElement('span');
    text.className = 'code-text';
    // Continuation rows hang 4ch past the line's own indentation (style.css),
    // so a wrapped line never lines up with the next source line.
    const line = toks.map(t => t.content).join('');
    const indent = Math.min(indentWidth(line), MAX_HANG_INDENT);
    text.style.setProperty('--indent', `${indent}ch`);
    text.style.setProperty('--hang', `${indent + 4}ch`);
    const ranges = symbolRanges(line, needle);
    appendTokens(text, toks, ranges, breakPoints(line, ranges));
    row.append(gutter, text);
    block.append(row);
  });
  return block;
}

function plainLines(code: string): Tok[][] {
  return code.split('\n').map(l => [{ content: l, italic: false }]);
}

/**
 * The snippet as plain mono rows, built synchronously. Same rows, gutter and
 * wrapping as the highlighted block, so the inspector can paint it in the same
 * frame as a rebuild and keep its height (and the reader's scroll position)
 * until the coloured block replaces it.
 */
export function plainSnippet(code: string, startLine: number, symbol: string): HTMLElement {
  return buildBlock(plainLines(code), null, startLine, symbol);
}

/**
 * Build the snippet DOM: one row per line, gutter with the ref's real line
 * numbers, tokens coloured by Shiki when `lang` is known (lazy, cached), plain
 * mono otherwise or when highlighting fails. Never throws.
 */
export async function highlightSnippet(
  code: string,
  lang: string | null,
  theme: Exclude<ThemeId, 'brutal'>,
  startLine: number,
  symbol: string
): Promise<HTMLElement> {
  let lines = plainLines(code);
  if (lang !== null) {
    try {
      const hl = await loadHighlighter(lang);
      const { tokens } = hl.codeToTokens(code, {
        lang,
        theme: shikiTheme(theme),
      });
      lines = tokens.map(line =>
        line.map(t => ({
          content: t.content,
          color: t.color,
          italic: ((t.fontStyle ?? 0) & 1) === 1,
        }))
      );
    } catch {
      // A grammar or engine failure must never blank the panel: plain mono.
    }
  }
  return buildBlock(lines, lang, startLine, symbol);
}
