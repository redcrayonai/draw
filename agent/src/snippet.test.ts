import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MissingFileError, sliceLines } from './snippet';
import { canonicalRepoPath, readRepoEntry, resolveRepoPath, readSource } from './local-deps';
import { MAX_FILE_BYTES } from '../../shared/capture';

let tmp: string;
let root: string;

beforeAll(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'rc-snip-')));
  root = join(tmp, 'repo');
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(tmp, 'repo-evil'));
  mkdirSync(join(tmp, 'outside'));
  writeFileSync(join(root, 'src', 'a.ts'), 'one\ntwo\nthree\n');
  writeFileSync(join(root, 'crlf.txt'), 'a\r\nb\r\nc\r\n');
  writeFileSync(join(root, 'nonl.txt'), 'a\nb');
  writeFileSync(join(root, 'blank-end.txt'), 'a\n\n');
  writeFileSync(join(root, 'bin.dat'), Buffer.from([0x50, 0x4b, 0x00, 0x01, 0x41]));
  writeFileSync(join(tmp, 'repo-evil', 'secret.txt'), 'secret\n');
  writeFileSync(join(tmp, 'outside', 'f.txt'), 'outside\n');
  symlinkSync(join(tmp, 'repo-evil', 'secret.txt'), join(root, 'link.txt'));
  symlinkSync(join(tmp, 'outside'), join(root, 'outdir'));
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('resolveRepoPath', () => {
  it('turns a vanished repo root into a readable sentence, not a raw ENOENT and not a MissingFileError (F3)', () => {
    const gone = join(tmp, 'moved-away');
    let err: unknown;
    try {
      resolveRepoPath(gone, 'src/a.ts');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(MissingFileError);
    expect((err as Error).message).toBe(
      `the session's repo root ${gone} no longer exists; start_session from the current checkout under another name`
    );
  });
  it('returns the realpath of a clean repo-relative file', () => {
    expect(resolveRepoPath(root, 'src/a.ts')).toBe(join(root, 'src', 'a.ts'));
  });
  it('rejects ".." escapes', () => {
    expect(() => resolveRepoPath(root, '../repo-evil/secret.txt')).toThrow(/escapes the repo root/);
    expect(() => resolveRepoPath(root, 'src/../../repo-evil/secret.txt')).toThrow(/escapes the repo root/);
  });
  it('rejects absolute paths, including the sibling-prefix case the old startsWith guard allowed', () => {
    expect(() => resolveRepoPath(root, `${root}-evil/secret.txt`)).toThrow(/must be repo-relative/);
  });
  it('rejects a symlink even when it points at an existing file', () => {
    expect(() => resolveRepoPath(root, 'link.txt')).toThrow(/is a symlink/);
  });
  it('rejects a regular file reached through a symlinked directory that leaves the root', () => {
    expect(() => resolveRepoPath(root, 'outdir/f.txt')).toThrow(/resolves outside the repo root/);
  });
  it('rejects directories and missing files', () => {
    expect(() => resolveRepoPath(root, 'src')).toThrow(/not a regular file/);
    expect(() => resolveRepoPath(root, 'src/missing.ts')).toThrow(/no such file in repo: 'src\/missing.ts'/);
  });
  it('throws a MissingFileError for a missing file only, with the message unchanged', () => {
    const thrown = (rel: string): unknown => {
      try {
        resolveRepoPath(root, rel);
      } catch (e) {
        return e;
      }
      throw new Error(`resolveRepoPath(${rel}) did not throw`);
    };
    const missing = thrown('src/missing.ts');
    expect(missing).toBeInstanceOf(MissingFileError);
    expect((missing as Error).message).toBe("no such file in repo: 'src/missing.ts'");
    expect(thrown('src')).not.toBeInstanceOf(MissingFileError);
    expect(thrown('link.txt')).not.toBeInstanceOf(MissingFileError);
  });
});

describe('canonicalRepoPath — the spelling git prints (F4)', () => {
  it('normalises ./, doubled slashes and .. detours to the plain repo-relative path', () => {
    expect(canonicalRepoPath(root, 'src/a.ts')).toBe('src/a.ts');
    expect(canonicalRepoPath(root, './src/a.ts')).toBe('src/a.ts');
    expect(canonicalRepoPath(root, 'src//a.ts')).toBe('src/a.ts');
    expect(canonicalRepoPath(root, 'src/../src/a.ts')).toBe('src/a.ts');
  });
  it('restores the on-disk case on a case-insensitive filesystem', () => {
    if (!existsSync(join(root, 'SRC', 'A.ts'))) return; // case-sensitive filesystem: nothing to normalise
    expect(canonicalRepoPath(root, 'SRC/A.ts')).toBe('src/a.ts');
    expect(readSource(root, 'Src/a.TS').rel).toBe('src/a.ts');
  });
  it('readSource stamps the file it read; a rewrite changes the stamp (G15 review)', () => {
    writeFileSync(join(root, 'stamped.txt'), 'one\n');
    const first = readSource(root, 'stamped.txt').stamp;
    expect(first).toMatch(/^[\d.]+:4:\d+$/);
    writeFileSync(join(root, 'stamped.txt'), 'one two\n');
    expect(readSource(root, 'stamped.txt').stamp).not.toBe(first);
  });
  it('readSource reports the canonical path it read', () => {
    expect(readSource(root, './src//a.ts').rel).toBe('src/a.ts');
  });
});

describe('readSource / sliceLines', () => {
  const slice = (rel: string, s: number, e: number) => sliceLines(rel, readSource(root, rel).lines, s, e);
  it('splits on CRLF and drops the trailing empty element', () => {
    const src = readSource(root, 'crlf.txt');
    expect(src.lines).toEqual(['a', 'b', 'c']);
    expect(src.text).toBe('a\r\nb\r\nc\r\n');
    expect(src.abs).toBe(join(root, 'crlf.txt'));
  });
  it('joins the requested lines with LF', () => {
    expect(slice('crlf.txt', 1, 2)).toBe('a\nb');
    expect(slice('src/a.ts', 1, 3)).toBe('one\ntwo\nthree');
  });
  it('counts lines correctly for a CRLF file, a file without a trailing newline, and a file ending in a blank line', () => {
    expect(slice('crlf.txt', 1, 3)).toBe('a\nb\nc');
    expect(slice('nonl.txt', 1, 2)).toBe('a\nb');
    expect(slice('nonl.txt', 2, 2)).toBe('b');
    expect(() => slice('nonl.txt', 1, 3)).toThrow("endLine 3 exceeds the line count of 'nonl.txt' (2 lines)");
    expect(readSource(root, 'blank-end.txt').lines).toEqual(['a', '']); // only ONE trailing empty element is dropped
    expect(slice('blank-end.txt', 1, 2)).toBe('a\n');
  });
  it('rejects binary files by a NUL in the first 8 KiB', () => {
    expect(() => readSource(root, 'bin.dat')).toThrow(/'bin.dat' looks binary/);
  });
  it('refuses a file over 1 MB before reading it, like the hosted path (P15)', () => {
    writeFileSync(join(root, 'big.txt'), 'a'.repeat(MAX_FILE_BYTES + 1));
    writeFileSync(join(root, 'max.txt'), 'a'.repeat(MAX_FILE_BYTES));
    expect(() => readSource(root, 'big.txt')).toThrow("'big.txt' is over 1 MB; code refs read files up to 1 MB");
    expect(readSource(root, 'max.txt').bytes.length).toBe(MAX_FILE_BYTES);
  });
  it('reports the real line count when endLine is past EOF', () => {
    expect(() => slice('src/a.ts', 1, 10)).toThrow("endLine 10 exceeds the line count of 'src/a.ts' (3 lines)");
  });
  it('rejects a bad range', () => {
    expect(() => sliceLines('x.ts', ['a', 'b'], 0, 1)).toThrow(/startLine must be a positive integer/);
    expect(() => sliceLines('x.ts', ['a', 'b'], 2, 1)).toThrow(/endLine 1 is before startLine 2/);
  });
});

describe('readRepoEntry (the read_source tool of reason.ts)', () => {
  it('lists the entries of the root and of a subdirectory, sorted', () => {
    // its own directory: other tests in this file add files to the shared fixture root
    const listing = join(tmp, 'listing');
    mkdirSync(join(listing, 'sub'), { recursive: true });
    writeFileSync(join(listing, 'b.txt'), 'b\n');
    writeFileSync(join(listing, 'a.txt'), 'a\n');
    writeFileSync(join(listing, 'sub', 'c.ts'), 'c\n');
    expect(readRepoEntry(listing, '.')).toEqual({ dir: ['a.txt', 'b.txt', 'sub'] });
    expect(readRepoEntry(listing, '')).toEqual({ dir: ['a.txt', 'b.txt', 'sub'] });
    expect(readRepoEntry(listing, 'sub')).toEqual({ dir: ['c.ts'] });
  });
  it('reads a file as LF-normalised lines', () => {
    const entry = readRepoEntry(root, 'crlf.txt');
    expect('file' in entry && entry.file.lines).toEqual(['a', 'b', 'c']);
  });
  it('refuses the paths the old startsWith guard let through', () => {
    // sibling directory that shares the repo path as a prefix, as a relative and as an absolute path
    expect(() => readRepoEntry(root, '../repo-evil/secret.txt')).toThrow(/escapes the repo root/);
    expect(() => readRepoEntry(root, '../repo-evil')).toThrow(/escapes the repo root/);
    expect(() => readRepoEntry(root, `${root}-evil/secret.txt`)).toThrow(/must be repo-relative/);
    // a symlink to a file, a symlinked directory, and a file reached through one
    expect(() => readRepoEntry(root, 'link.txt')).toThrow(/is a symlink/);
    expect(() => readRepoEntry(root, 'outdir')).toThrow(/is a symlink/);
    expect(() => readRepoEntry(root, 'outdir/f.txt')).toThrow(/resolves outside the repo root/);
    // a directory reached through a symlinked parent (the entry itself is a plain directory)
    mkdirSync(join(tmp, 'outside', 'sub'), { recursive: true });
    expect(() => readRepoEntry(root, 'outdir/sub')).toThrow(/resolves outside the repo root/);
  });
  it('says so for a missing path, and for a repo root that vanished', () => {
    expect(() => readRepoEntry(root, 'src/missing.ts')).toThrow(/no such file in repo: 'src\/missing.ts'/);
    expect(() => readRepoEntry(join(tmp, 'moved-away'), 'src')).toThrow(/no longer exists/);
  });
});
