/**
 * A source file as the session flows see it, and the line slicing they share.
 * No disk access here: local-deps.ts reads files on this machine (readSource).
 */

/**
 * `rel` is the on-disk repo-relative spelling of the file that was read: git's
 * up to Unicode normalisation (macOS keeps NFD names; git prints NFC), which
 * gitSpelling resolves (G17).
 */
export type SourceFile = {
  abs: string;
  rel: string;
  bytes: Buffer;
  text: string;
  lines: string[];
  /** mtime, size and inode, when they did not change while the file was read: a cache key for its sha (G15) */
  stamp?: string;
};

/** Thrown by resolveRepoPath when `rel` does not exist; callers detect a deleted file with instanceof. */
export class MissingFileError extends Error {
  constructor(readonly rel: string) {
    super(`no such file in repo: '${rel}'`);
    this.name = 'MissingFileError';
  }
}

/** Thrown by readSource for a NUL byte in the first 8 KiB; the helper tells it apart from other refusals. */
export class BinaryFileError extends Error {
  constructor(readonly rel: string) {
    super(`'${rel}' looks binary (NUL byte in the first 8 KiB); code refs need text files`);
    this.name = 'BinaryFileError';
  }
}

/** A text file's bytes as the flows read them, from disk (readSource) or from a capture. */
export function textSource(abs: string, rel: string, bytes: Buffer, stamp?: string): SourceFile {
  const text = bytes.toString('utf8');
  const lines = text.split(/\r?\n/);
  // "a\nb\n" splits to ['a','b',''] and "a\nb" to ['a','b']: drop exactly one
  // trailing empty element so both count 2 lines; "a\n\n" keeps its blank line 2.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return { abs, rel, bytes, text, lines, stamp };
}

/** Lines startLine..endLine (1-based, inclusive) joined with LF; throws on a bad range. */
export function sliceLines(rel: string, lines: string[], startLine: number, endLine: number): string {
  if (!Number.isInteger(startLine) || startLine < 1) throw new Error(`startLine must be a positive integer, got ${startLine}`);
  if (!Number.isInteger(endLine) || endLine < startLine) throw new Error(`endLine ${endLine} is before startLine ${startLine}`);
  if (endLine > lines.length) {
    throw new Error(`endLine ${endLine} exceeds the line count of '${rel}' (${lines.length} lines)`);
  }
  return lines.slice(startLine - 1, endLine).join('\n');
}
