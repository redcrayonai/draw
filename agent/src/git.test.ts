import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, unlinkSync, symlinkSync, readFileSync, chmodSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EMPTY_TREE_SHA,
  gitTopLevel,
  gitHead,
  gitListTracked,
  gitChanged,
  gitDeleted,
  gitChangeCandidates,
  gitConfirmChanged,
  gitIndexPath,
  gitUntracked,
  gitHashObject,
  gitHashFiles,
  gitIsCitable,
  gitListed,
  gitHunks,
  gitSpelling,
  setGitTimeoutMs,
  setGitMaxBuffer,
  GIT_TIMEOUT_MS,
} from './git';
import { GitOutputTooLargeError, GitTimeoutError } from './errors';

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
};
function sh(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();
}

// A path with a space AND non-ASCII letters: plain `git ls-files` prints it as
// "\303\274n\303\257 c\303\266d\303\251.ts" in quotes; -z prints the bytes.
const UNICODE = 'ünï cödé.ts';

let repo: string;
let base: string;

beforeAll(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'rc-git-')));
  sh(repo, ['init', '-q', '-b', 'main']);
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe('git.ts against a temp repository (tests run in order)', () => {
  it('gitHead returns the empty-tree sha before the first commit', () => {
    expect(gitHead(repo)).toBe(EMPTY_TREE_SHA);
  });

  it('gitChanged against the empty tree lists nothing in an empty repo', () => {
    expect(gitChanged(repo, EMPTY_TREE_SHA)).toEqual([]);
  });

  it('gitHead returns HEAD after a commit', () => {
    writeFileSync(join(repo, 'a.txt'), 'l1\nl2\nl3\n');
    writeFileSync(join(repo, 'b.txt'), 'b\n');
    writeFileSync(join(repo, 'naïve é.txt'), 'x\n');
    writeFileSync(join(repo, UNICODE), 'x\n');
    mkdirSync(join(repo, 'sub'));
    writeFileSync(join(repo, 'sub', 'c.txt'), 'c\n');
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
    sh(repo, ['add', '-A']);
    sh(repo, ['commit', '-q', '-m', 'one']);
    base = sh(repo, ['rev-parse', 'HEAD']);
    expect(gitHead(repo)).toMatch(/^[0-9a-f]{40}$/);
    expect(gitHead(repo)).toBe(base);
  });

  it('gitTopLevel resolves the realpath root from a subdirectory', () => {
    expect(gitTopLevel(join(repo, 'sub'))).toBe(repo);
  });

  it('gitListTracked returns exact (unquoted) non-ASCII names via -z', () => {
    expect(gitListTracked(repo)).toEqual(['.gitignore', 'a.txt', 'b.txt', 'naïve é.txt', 'sub/c.txt', UNICODE]);
  });

  it('gitHashObject matches the committed blob sha', () => {
    expect(gitHashObject(repo, 'a.txt', Buffer.from('l1\nl2\nl3\n'))).toBe(sh(repo, ['rev-parse', 'HEAD:a.txt']));
  });

  it('gitChanged lists modified files only (deleted excluded), non-ASCII intact', () => {
    writeFileSync(join(repo, 'a.txt'), 'l1\nX\nl3\nl4\nl5\n');
    unlinkSync(join(repo, 'b.txt'));
    writeFileSync(join(repo, 'u.txt'), 'u\n');
    mkdirSync(join(repo, 'node_modules'));
    writeFileSync(join(repo, 'node_modules', 'ig.js'), 'x');
    writeFileSync(join(repo, 'naïve é.txt'), 'x\ny\n');
    writeFileSync(join(repo, UNICODE), 'export const ü = 1;\nexport const ö = 2;\n');
    expect(gitChanged(repo, base)).toEqual(['a.txt', 'naïve é.txt', UNICODE]);
  });

  it('gitDeleted lists only deleted files', () => {
    expect(gitDeleted(repo, base)).toEqual(['b.txt']);
  });

  it('gitChangeCandidates lists what gitChanged lists, from the index alone; stat-dirty files are left to git to confirm (G15 review)', () => {
    const candidates = gitChangeCandidates(repo, base);
    expect(candidates.map(c => c.path)).toEqual(gitChanged(repo, base));
    for (const c of candidates) expect(c.sure).toBe(false); // written after the commit: stat-dirty, git confirms
  });

  it('gitUntracked excludes ignored paths', () => {
    expect(gitUntracked(repo)).toEqual(['u.txt']);
  });

  it('gitChanged against EMPTY_TREE_SHA lists every tracked file still on disk', () => {
    expect(gitChanged(repo, EMPTY_TREE_SHA)).toEqual(['.gitignore', 'a.txt', 'naïve é.txt', 'sub/c.txt', UNICODE]);
  });

  it('gitIsCitable: tracked yes, untracked-not-ignored yes, ignored/missing/dir/symlink no', () => {
    symlinkSync('a.txt', join(repo, 'link.txt'));
    expect(gitIsCitable(repo, 'a.txt')).toBe(true);
    expect(gitIsCitable(repo, 'u.txt')).toBe(true);
    expect(gitIsCitable(repo, 'node_modules/ig.js')).toBe(false);
    expect(gitIsCitable(repo, 'nope.txt')).toBe(false);
    expect(gitIsCitable(repo, 'sub')).toBe(false);
    expect(gitIsCitable(repo, 'link.txt')).toBe(false);
  });

  it('gitIsCitable: nothing under .git/ or inside a nested repository, which git never lists (U40)', () => {
    const inner = join(repo, 'vendor', 'inner');
    mkdirSync(inner, { recursive: true });
    sh(inner, ['init', '-q']);
    writeFileSync(join(inner, 'x.txt'), 'x\n');
    try {
      expect(gitIsCitable(repo, '.git/config')).toBe(false);
      expect(gitIsCitable(repo, 'vendor/inner/x.txt')).toBe(false);
      expect(gitIsCitable(repo, 'vendor/inner/.git/config')).toBe(false);
    } finally {
      rmSync(join(repo, 'vendor'), { recursive: true, force: true });
    }
  });

  it('gitListed: one call answers which paths git would list; ignored and missing ones are not', () => {
    expect(gitListed(repo, ['a.txt', 'u.txt', 'node_modules/ig.js', 'nope.txt', '*.txt']).sort()).toEqual(['a.txt', 'u.txt']);
    expect(gitListed(repo, [])).toEqual([]);
  });

  it('gitHunks returns new-side line ranges from -U0 (count omitted means 1)', () => {
    expect(gitHunks(repo, base, 'a.txt')).toEqual([
      { start: 2, end: 2 },
      { start: 4, end: 5 },
    ]);
  });

  it('gitHunks treats an untracked file as one open-ended hunk and an unchanged file as none', () => {
    expect(gitHunks(repo, base, 'u.txt')).toEqual([{ start: 1, end: Infinity }]);
    expect(gitHunks(repo, base, 'sub/c.txt')).toEqual([]);
  });

  it('a path with glob characters is literal: a[1].ts never picks up a1.ts', () => {
    const r = realpathSync(mkdtempSync(join(tmpdir(), 'rc-glob-')));
    try {
      sh(r, ['init', '-q']);
      writeFileSync(join(r, 'a[1].ts'), 'x\n');
      writeFileSync(join(r, 'a1.ts'), 'y\n');
      sh(r, ['add', '.']);
      sh(r, ['commit', '-qm', 'base']);
      const b = sh(r, ['rev-parse', 'HEAD']);
      writeFileSync(join(r, 'a1.ts'), 'y\nz\n');
      expect(gitHunks(r, b, 'a[1].ts')).toEqual([]);
      expect(gitHunks(r, b, 'a1.ts')).toEqual([{ start: 2, end: 2 }]);
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });

  it('parses hunks even when Git is configured to always emit color', () => {
    sh(repo, ['config', 'color.diff', 'always']);
    try {
      expect(gitHunks(repo, base, 'a.txt')).toEqual([{ start: 2, end: 2 }, { start: 4, end: 5 }]);
    } finally {
      sh(repo, ['config', '--unset', 'color.diff']);
    }
  });

  it('a path with a space and non-ASCII characters round-trips through listing, diff, hunks, citable and hash-object', () => {
    // the -z listing above returned the exact name; now feed that exact name back into every `--`-terminated call
    const rel = gitListTracked(repo).find(p => p === UNICODE)!;
    expect(rel).toBe(UNICODE);
    expect(gitChanged(repo, base)).toContain(rel);
    expect(gitHunks(repo, base, rel)).toEqual([{ start: 1, end: 2 }]);
    expect(gitIsCitable(repo, rel)).toBe(true);
    expect(gitHashObject(repo, rel, readFileSync(join(repo, rel)))).toBe(sh(repo, ['hash-object', '--', rel]));
  });

  it('every function throws a readable error outside a repository', () => {
    const notRepo = mkdtempSync(join(tmpdir(), 'rc-notgit-'));
    try {
      expect(() => gitListTracked(notRepo)).toThrow(/^git unavailable or not a repo: git ls-files in .*: fatal: not a git repository/);
      expect(() => gitHead(notRepo)).toThrow(/^git unavailable or not a repo: /);
    } finally {
      rmSync(notRepo, { recursive: true, force: true });
    }
  });

  it('a missing git binary is reported with the same prefix (spec 3.4), not as a bare ENOENT', () => {
    const savedPath = process.env.PATH;
    process.env.PATH = '/nonexistent';
    try {
      expect(() => gitHead(repo)).toThrow(/^git unavailable or not a repo: git rev-parse in .*: spawnSync git ENOENT/);
    } finally {
      process.env.PATH = savedPath;
    }
  });

  // Run fn with a fake 'git' script first on PATH.
  const withFakeGit = (script: string, fn: () => void) => {
    const bin = mkdtempSync(join(tmpdir(), 'rc-fakegit-'));
    writeFileSync(join(bin, 'git'), script);
    chmodSync(join(bin, 'git'), 0o755);
    const savedPath = process.env.PATH;
    process.env.PATH = `${bin}:${savedPath}`;
    try {
      fn();
    } finally {
      process.env.PATH = savedPath;
      rmSync(bin, { recursive: true, force: true });
    }
  };

  it('a git killed by a signal says which, not "timed out" (G15 review)', () => {
    withFakeGit('#!/bin/sh\nkill -SEGV $$\n', () => {
      expect(() => gitHead(repo)).toThrow(/^git unavailable or not a repo: git rev-parse was killed by SIGSEGV in .+$/);
    });
    withFakeGit('#!/bin/sh\nkill -TERM $$\n', () => {
      expect(() => gitHead(repo)).toThrow(/^git unavailable or not a repo: git rev-parse was killed by SIGTERM in .+$/);
    });
  });

  it('output over the buffer limit says so, not "timed out" (G15 review)', () => {
    withFakeGit('#!/bin/sh\nhead -c 70000000 /dev/zero\n', () => {
      expect(() => gitListTracked(repo)).toThrow(/^git unavailable or not a repo: git ls-files output exceeded 64 MiB in .+$/);
    });
  });

  it('slow fake git on PATH → timed-out error (G15)', () => {
    // a hung clean filter or fsmonitor hook looks like this: git never exits
    expect(GIT_TIMEOUT_MS).toBe(10_000);
    const bin = mkdtempSync(join(tmpdir(), 'rc-slowgit-'));
    writeFileSync(join(bin, 'git'), '#!/bin/sh\nexec sleep 30\n');
    chmodSync(join(bin, 'git'), 0o755);
    const savedPath = process.env.PATH;
    const savedTimeout = setGitTimeoutMs(300);
    process.env.PATH = `${bin}:${savedPath}`;
    const started = Date.now();
    try {
      expect(() => gitHead(repo)).toThrow(
        /^git unavailable or not a repo: git rev-parse timed out after 0\.3 s in .+; a clean filter \(git-lfs\) or fsmonitor hook may be hanging — retry or check git config$/
      );
      expect(Date.now() - started).toBeLessThan(5000); // killed, not waited for
      // typed, so a flow can tell git's own timeout from its deadline cutting the call short
      const full = (() => {
        try {
          gitHead(repo);
        } catch (e) {
          return e;
        }
      })();
      expect(full).toBeInstanceOf(GitTimeoutError);
      expect(full).toMatchObject({ limited: false, detail: 'git rev-parse timed out after 0.3 s' });
      const cut = (() => {
        try {
          gitHead(repo, 100); // the caller had 0.1 s left
        } catch (e) {
          return e;
        }
      })();
      expect(cut).toMatchObject({ limited: true });
    } finally {
      process.env.PATH = savedPath;
      setGitTimeoutMs(savedTimeout);
      rmSync(bin, { recursive: true, force: true });
    }
    expect(gitHead(repo)).toBe(base); // the real git again, at the default timeout
  });
});

describe('gitHashFiles — one git call for many files (G15)', () => {
  let dir: string;
  const NL = 'new\nline.txt';
  const files: Record<string, string> = {
    'crlf.txt': 'a\r\nb\r\n', // text eol=lf: the blob is LF
    'shout.up': 'quiet words\n', // clean filter: the blob is upper case
    'q"uote.txt': 'quoted\n',
    [NL]: 'newline in the name\n',
    [UNICODE]: 'export const ü = 1;\n',
    'sub/plain.ts': 'export const x = 1;\n',
  };
  beforeAll(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'rc-hash-')));
    sh(dir, ['init', '-q', '-b', 'main']);
    sh(dir, ['config', 'filter.up.clean', 'tr a-z A-Z']);
    writeFileSync(join(dir, '.gitattributes'), 'crlf.txt text eol=lf\n*.up filter=up\n');
    mkdirSync(join(dir, 'sub'));
    for (const [rel, text] of Object.entries(files)) writeFileSync(join(dir, rel), text);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('returns the shas the per-file hashObject returns, filters included, in order', () => {
    const rels = Object.keys(files);
    const one = rels.map(rel => gitHashObject(dir, rel, readFileSync(join(dir, rel))));
    expect(gitHashFiles(dir, rels)).toEqual(one);
    // the filters really applied: the raw bytes hash differently
    const raw = (rel: string) => execFileSync('git', ['hash-object', '--no-filters', '--', rel], { cwd: dir, encoding: 'utf8' }).trim();
    expect(one[0]).not.toBe(raw('crlf.txt'));
    expect(one[1]).not.toBe(raw('shout.up'));
    expect(gitHashFiles(dir, [])).toEqual([]);
  });
});

describe('gitSpelling — the spelling git prints, folded only as the repo config says (G17)', () => {
  let dir: string;
  const NFC = UNICODE.normalize('NFC');
  const NFD = UNICODE.normalize('NFD');
  const config = (ignorecase: boolean, precompose: boolean) => {
    sh(dir, ['config', 'core.ignorecase', String(ignorecase)]);
    sh(dir, ['config', 'core.precomposeunicode', String(precompose)]);
  };
  beforeAll(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'rc-spell-')));
    sh(dir, ['init', '-q', '-b', 'main']);
    writeFileSync(join(dir, '.gitignore'), 'build.ts\n');
    writeFileSync(join(dir, NFC), 'x\n');
    writeFileSync(join(dir, 'Tracked.txt'), 't\n');
    sh(dir, ['add', '-A']);
    // Index-only entries stand for files a case-sensitive volume holds next to
    // their case variants on disk: Notes.md and Build.ts are tracked, while
    // notes.md (untracked) and build.ts (ignored) are different files.
    const blob = sh(dir, ['hash-object', '-w', '--stdin']);
    sh(dir, ['update-index', '--add', '--cacheinfo', `100644,${blob},Notes.md`]);
    sh(dir, ['update-index', '--add', '--cacheinfo', `100644,${blob},Build.ts`]);
    sh(dir, ['commit', '-q', '-m', 'one']);
    writeFileSync(join(dir, 'u.txt'), 'u\n');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('an exact match, tracked or untracked, wins over a case variant (a different file on a case-sensitive volume)', () => {
    config(false, false);
    writeFileSync(join(dir, 'notes.md'), '# Limiter\n');
    writeFileSync(join(dir, 'build.ts'), 'ignored\n');
    try {
      expect(gitSpelling(dir, 'notes.md')).toBe('notes.md'); // never Notes.md with the snippet of notes.md
      expect(gitSpelling(dir, 'build.ts')).toBe('build.ts'); // ignored: not cited as Build.ts; isCitable refuses it
      expect(gitSpelling(dir, 'Tracked.txt')).toBe('Tracked.txt');
      expect(gitSpelling(dir, 'u.txt')).toBe('u.txt');
    } finally {
      rmSync(join(dir, 'notes.md'));
      rmSync(join(dir, 'build.ts'));
    }
  });

  it('folds ASCII case only when core.ignorecase is true', () => {
    config(true, false);
    expect(gitSpelling(dir, 'TRACKED.TXT')).toBe('Tracked.txt');
    expect(gitSpelling(dir, 'U.TXT')).toBe('u.txt');
    expect(gitSpelling(dir, 'notes.md')).toBe('Notes.md'); // one file under two spellings on such a volume
    config(false, false);
    expect(gitSpelling(dir, 'TRACKED.TXT')).toBe('TRACKED.TXT');
    expect(gitSpelling(dir, 'U.TXT')).toBe('U.TXT');
    expect(gitSpelling(dir, 'notes.md')).toBe('notes.md');
  });

  it('treats NFC and NFD as one name only when core.precomposeunicode is true', () => {
    config(false, true);
    expect(gitSpelling(dir, NFD)).toBe(NFC);
    expect(gitSpelling(dir, NFC)).toBe(NFC);
    config(false, false);
    expect(gitSpelling(dir, NFD)).toBe(NFD);
    expect(gitSpelling(dir, NFC)).toBe(NFC);
  });

  it('returns a path git would not list unchanged', () => {
    config(true, true);
    expect(gitSpelling(dir, 'missing.txt')).toBe('missing.txt');
  });
});

describe('listings that never run a clean filter (G15 review)', () => {
  let dir: string;
  let base: string;
  beforeAll(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'rc-slowfilter-')));
    sh(dir, ['init', '-q', '-b', 'main']);
    sh(dir, ['config', 'filter.slow.clean', 'sleep 0.3; cat']);
    writeFileSync(join(dir, '.gitattributes'), '*.ts filter=slow\n');
    for (const f of ['a', 'b', 'c', 'touched', 'gone']) writeFileSync(join(dir, `${f}.ts`), `export const ${f} = 1;\n`);
    sh(dir, ['add', '-A']);
    sh(dir, ['commit', '-q', '-m', 'base']);
    base = sh(dir, ['rev-parse', 'HEAD']);
    for (const f of ['a', 'b', 'c']) writeFileSync(join(dir, `${f}.ts`), `export const ${f} = 2;\n`);
    writeFileSync(join(dir, 'touched.ts'), 'export const touched = 1;\n'); // same content, new stat
    unlinkSync(join(dir, 'gone.ts'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('gitConfirmChanged answers like git diff for the paths given, on a copy of the index: the index of the user is never written (G15 review)', () => {
    const index = gitIndexPath(dir);
    expect(index).toBe(join(dir, '.git', 'index'));
    const before = readFileSync(index);
    const t0 = Date.now();
    // a.ts changed (its hunk is line 1); touched.ts has the same content, so git says nothing about it
    expect(gitConfirmChanged(dir, base, ['a.ts', 'touched.ts'])).toEqual(new Map([['a.ts', { changed: true }], ['touched.ts', { changed: false }]]));
    expect(Date.now() - t0).toBeLessThan(3000); // the two files only, never a whole-index refresh
    expect(readFileSync(index).equals(before)).toBe(true);
    expect(existsSync(`${index}.lock`)).toBe(false);
    expect(gitConfirmChanged(dir, base, [])).toEqual(new Map());
    // more() is asked before every file but the first: false stops after one
    expect([...gitConfirmChanged(dir, base, ['a.ts', 'touched.ts'], undefined, () => false).keys()]).toEqual(['a.ts']);
  });

  it('gitDeleted and gitChangeCandidates answer without cleaning a single file (0.3 s per file here)', () => {
    const t0 = Date.now();
    expect(gitDeleted(dir, base)).toEqual(['gone.ts']);
    const candidates = gitChangeCandidates(dir, base);
    expect(Date.now() - t0).toBeLessThan(900);
    expect(candidates.map(c => c.path)).toEqual(['a.ts', 'b.ts', 'c.ts', 'touched.ts']); // touched.ts: only its content can tell
    expect(candidates.find(c => c.path === 'touched.ts')).toEqual({ path: 'touched.ts', sure: false });
  });
});

describe('a same-size edit with the mtime it was indexed with (racy git)', () => {
  it('gitConfirmChanged still sees it: the copy of the index keeps the timestamp that marks the entry racy', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'rc-racy-')));
    try {
      sh(dir, ['init', '-q', '-b', 'main']);
      sh(dir, ['config', 'core.trustctime', 'false']); // the rewrite changes ctime; leave mtime and size to decide
      const past = new Date(Date.now() - 3_600_000);
      writeFileSync(join(dir, 'a.ts'), 'return 1;\n');
      utimesSync(join(dir, 'a.ts'), past, past);
      sh(dir, ['add', '-A']);
      sh(dir, ['commit', '-q', '-m', 'base']);
      const base = sh(dir, ['rev-parse', 'HEAD']);
      // what an edit in the same second as the index write looks like: stat-clean, and
      // only the index file's own mtime (not newer than the entry) tells git to compare content
      writeFileSync(join(dir, 'a.ts'), 'return 2;\n');
      utimesSync(join(dir, 'a.ts'), past, past);
      utimesSync(gitIndexPath(dir), past, past);
      expect(gitChangeCandidates(dir, base)).toEqual([{ path: 'a.ts', sure: false }]);
      expect(gitConfirmChanged(dir, base, ['a.ts'])).toEqual(new Map([['a.ts', { changed: true }]]));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a diff too large to print (G15 review)', () => {
  let dir: string;
  let base: string;
  let saved: number;
  beforeAll(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'rc-bigdiff-')));
    sh(dir, ['init', '-q', '-b', 'main']);
    writeFileSync(join(dir, 'big.txt'), Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n') + '\n');
    sh(dir, ['add', '-A']);
    sh(dir, ['commit', '-q', '-m', 'base']);
    base = sh(dir, ['rev-parse', 'HEAD']);
    writeFileSync(join(dir, 'big.txt'), Array.from({ length: 400 }, (_, i) => `LINE ${i}`).join('\n') + '\n'); // every line rewritten
    saved = setGitMaxBuffer(2048); // the diff is ~8 KB; a name is a few bytes
  });
  afterAll(() => {
    setGitMaxBuffer(saved);
    rmSync(dir, { recursive: true, force: true });
  });

  it('gitConfirmChanged answers from --name-only, so it never prints the diff', () => {
    expect(gitConfirmChanged(dir, base, ['big.txt'])).toEqual(new Map([['big.txt', { changed: true }]]));
  });

  it('gitHunks overflowing the buffer throws GitOutputTooLargeError', () => {
    expect(() => gitHunks(dir, base, 'big.txt')).toThrow(GitOutputTooLargeError);
    expect(() => gitHunks(dir, base, 'big.txt')).toThrow(/^git unavailable or not a repo: git diff output exceeded 0\.001953125 MiB in /);
  });
});
