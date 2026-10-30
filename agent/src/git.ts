/**
 * Git plumbing for the session companion. Every path-listing command uses -z and
 * NUL splitting (plain output octal-quotes non-ASCII paths). Every diff passes
 * --no-ext-diff so a configured external diff tool (difftastic on Alan's machine)
 * cannot replace the unified format we parse. Failures throw one readable Error
 * ("git unavailable or not a repo: …") that the MCP layer returns verbatim after
 * "REJECTED: " — spec §3.4.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { GitOutputTooLargeError, GitTimeoutError } from './errors';

export const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
export const EMPTY_TREE_SHA256 = '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321';

/** `until`: a Date.now() by which the call must end (a flow's deadline), else the plain timeout */
type RunOpts = { input?: Buffer; allowExit?: number[]; until?: number; env?: Record<string, string> };
type RunResult = { out: Buffer; status: number };

/**
 * Every git call is killed after this long (G15). git runs synchronously, so a
 * hung clean filter (git-lfs) or fsmonitor hook would otherwise stall every
 * tool and the 15 s reducer timer with it.
 */
export const GIT_TIMEOUT_MS = 10_000;
let maxBuffer = 64 * 1024 * 1024;

/** Tests only: a small output limit for a large diff. Returns the previous value. */
export function setGitMaxBuffer(bytes: number): number {
  const previous = maxBuffer;
  maxBuffer = bytes;
  return previous;
}

let gitTimeoutMs = GIT_TIMEOUT_MS;

/** Tests only: a short timeout for a fake slow git. Returns the previous value. */
export function setGitTimeoutMs(ms: number): number {
  const previous = gitTimeoutMs;
  gitTimeoutMs = ms;
  return previous;
}

// The flows pass the time they have left (timeoutMs) to the functions below;
// a function that runs git twice shares it between both calls.
const by = (timeoutMs: number | undefined) => (timeoutMs === undefined ? undefined : Date.now() + timeoutMs);

/**
 * The single wrapper around git. A missing binary (spawn ENOENT), a directory
 * that is not a repository, or any exit code not in `allowExit` becomes
 * `Error('git unavailable or not a repo: git <subcommand> in <root>: <detail>')`;
 * a git killed at the timeout says so, with the likely cause; so do output
 * over MAX_BUFFER and a git killed by any other signal.
 */
function git(root: string, args: string[], opts: RunOpts = {}): RunResult {
  const timeout = opts.until === undefined ? gitTimeoutMs : Math.max(1, Math.min(gitTimeoutMs, opts.until - Date.now()));
  try {
    const out = execFileSync('git', ['--no-pager', ...args], {
      cwd: root,
      env: opts.env === undefined ? undefined : { ...process.env, ...opts.env },
      input: opts.input,
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer,
      timeout,
      killSignal: 'SIGKILL',
    });
    return { out, status: 0 };
  } catch (err) {
    const e = err as { status?: number | null; signal?: string | null; code?: string; stdout?: Buffer; stderr?: Buffer; message: string };
    if (e.code === 'ETIMEDOUT') {
      const detail = `git ${args[0]} timed out after ${timeout / 1000} s`;
      throw new GitTimeoutError(
        `git unavailable or not a repo: ${detail} in ${root}; a clean filter (git-lfs) or fsmonitor hook may be hanging — retry or check git config`,
        detail,
        timeout < gitTimeoutMs
      );
    }
    if (e.code === 'ENOBUFS') {
      const detail = `git ${args[0]} output exceeded ${maxBuffer / 1024 / 1024} MiB`;
      throw new GitOutputTooLargeError(`git unavailable or not a repo: ${detail} in ${root}`, detail);
    }
    if (e.signal) throw new Error(`git unavailable or not a repo: git ${args[0]} was killed by ${e.signal} in ${root}`);
    if (typeof e.status === 'number' && opts.allowExit?.includes(e.status)) {
      return { out: e.stdout ?? Buffer.alloc(0), status: e.status };
    }
    const detail = e.stderr?.toString('utf8').trim() || e.message;
    throw new Error(`git unavailable or not a repo: git ${args[0]} in ${root}: ${detail}`);
  }
}

function splitNul(buf: Buffer): string[] {
  return buf
    .toString('utf8')
    .split('\0')
    .filter(s => s.length > 0);
}

export function gitTopLevel(root: string, timeoutMs?: number): string {
  return git(root, ['rev-parse', '--show-toplevel'], { until: by(timeoutMs) }).out.toString('utf8').trim();
}

/** HEAD sha, or the empty-tree sha when the repository has no commits yet. */
export function gitHead(root: string, timeoutMs?: number): string {
  const r = git(root, ['rev-parse', '--verify', '-q', 'HEAD'], { allowExit: [1], until: by(timeoutMs) });
  // No commit yet: the empty tree, in the repository's own hash.
  if (r.status !== 0) return gitObjectFormat(root, timeoutMs) === 'sha256' ? EMPTY_TREE_SHA256 : EMPTY_TREE_SHA;
  return r.out.toString('utf8').trim();
}

/** The repository's own git dir, shared by all its worktrees (absolute). */
export function gitCommonDir(root: string, timeoutMs?: number): string {
  return resolve(root, git(root, ['rev-parse', '--git-common-dir'], { until: by(timeoutMs) }).out.toString('utf8').trim());
}

/** sha1 or sha256; git before 2.25 knows only sha1 and has no --show-object-format. */
export function gitObjectFormat(root: string, timeoutMs?: number): 'sha1' | 'sha256' {
  const r = git(root, ['rev-parse', '--show-object-format'], { allowExit: [128, 129], until: by(timeoutMs) });
  return r.status === 0 && r.out.toString('utf8').trim() === 'sha256' ? 'sha256' : 'sha1';
}

export function gitListTracked(root: string, timeoutMs?: number): string[] {
  return splitNul(git(root, ['ls-files', '-z'], { until: by(timeoutMs) }).out);
}

/**
 * Paths added/modified/renamed since baseSha (deleted excluded), worktree vs
 * baseSha. Porcelain: it cleans every stat-dirty file (and, when one only
 * changed its stat, refreshes the whole index), so with a slow clean filter it
 * can outlast the git timeout. mark_checkpoint uses gitChangeCandidates.
 */
export function gitChanged(root: string, baseSha: string, timeoutMs?: number): string[] {
  return splitNul(git(root, ['diff', '--no-ext-diff', '-z', '--name-only', '--diff-filter=d', baseSha], { until: by(timeoutMs) }).out);
}

/** Paths deleted since baseSha. Plumbing: a missing file needs no content, so no clean filter runs (G15). */
export function gitDeleted(root: string, baseSha: string, timeoutMs?: number): string[] {
  return splitNul(git(root, ['diff-index', '--no-ext-diff', '-z', '--name-only', '--diff-filter=D', baseSha], { until: by(timeoutMs) }).out);
}

/**
 * A path that may differ from baseSha. sure: the index says so (added, a type
 * change, a stat-clean entry whose blob differs). Otherwise its stat changed
 * since it was indexed (a file, a symlink or a submodule), and only git's own
 * content check can tell (gitConfirmChanged).
 */
export type ChangeCandidate = { path: string; sure: boolean };

/**
 * Every path that may have been added or modified since baseSha (deleted
 * excluded), from `git diff-index --raw`: the index and stat only, so no
 * clean filter runs however many files are dirty (G15). Same paths as
 * gitChanged; gitConfirmChanged drops the stat-only ones.
 */
export function gitChangeCandidates(root: string, baseSha: string, timeoutMs?: number): ChangeCandidate[] {
  const args = ['diff-index', '--no-ext-diff', '--no-renames', '-z', '--raw', '--diff-filter=d', baseSha];
  const parts = git(root, args, { until: by(timeoutMs) }).out.toString('utf8').split('\0');
  const out: ChangeCandidate[] = [];
  // -z --raw: ":<srcmode> <dstmode> <srcsha> <dstsha> <status>" NUL "<path>" NUL
  for (let i = 0; i + 1 < parts.length && parts[i].startsWith(':'); i += 2) {
    const [, , , dstSha, status] = parts[i].slice(1).split(' ');
    out.push({ path: parts[i + 1], sure: !(status === 'M' && /^0+$/.test(dstSha)) });
  }
  return out;
}

/** The index file of the worktree at root (a linked worktree has its own). */
export function gitIndexPath(root: string, timeoutMs?: number): string {
  return resolve(root, git(root, ['rev-parse', '--git-path', 'index'], { until: by(timeoutMs) }).out.toString('utf8').trim());
}

/**
 * Git's own answer for stat-dirty candidates (G15), one file at a time:
 * changed when `git diff --name-only <baseSha> -- <path>` names it. git
 * compares the content without building a diff, so a huge rewritten file
 * costs no output, and eol rules (a blob that already has CRLF is left
 * alone), filters, symlinks and submodules are git's. A file git cannot
 * compare within GIT_TIMEOUT_MS counts as changed, with the reason. It runs
 * on a temporary copy of the index whose lock is already held: git then
 * cannot refresh and rewrite the index, a refresh that would re-clean every
 * dirty file of the repo (past the git timeout with a slow filter), and the
 * user's index is never written. `more` is asked before every file but the
 * first; when it answers false, or the caller's deadline cuts a file short,
 * the files not yet answered are left out.
 */
export function gitConfirmChanged(
  root: string,
  baseSha: string,
  paths: string[],
  timeoutMs?: number,
  more: () => boolean = () => true
): Map<string, { changed: boolean; reason?: string }> {
  const out = new Map<string, { changed: boolean; reason?: string }>();
  if (paths.length === 0) return out;
  const until = by(timeoutMs);
  const index = gitIndexPath(root, timeoutMs);
  const dir = mkdtempSync(join(tmpdir(), 'rc-index-'));
  try {
    const env = existsSync(index) ? { GIT_INDEX_FILE: join(dir, 'index') } : undefined;
    if (env) {
      // keep the index's mtime: git marks an entry no older than it racily clean and compares its content.
      // Stat before copying, so an index rewritten in between can only make the copy look older (more racy).
      const { atime, mtime } = statSync(index);
      copyFileSync(index, env.GIT_INDEX_FILE);
      utimesSync(env.GIT_INDEX_FILE, atime, mtime);
      writeFileSync(`${env.GIT_INDEX_FILE}.lock`, '');
    }
    for (const [k, p] of paths.entries()) {
      if (k > 0 && !more()) break;
      const args = ['diff', '--no-ext-diff', '-z', '--name-only', '--diff-filter=d', baseSha, '--', `:(literal)${p}`];
      try {
        out.set(p, { changed: splitNul(git(root, args, { until, env }).out).length > 0 });
      } catch (err) {
        if (!(err instanceof GitTimeoutError)) throw err;
        if (err.limited) break; // the caller's deadline: answer it in a later call
        out.set(p, { changed: true, reason: err.detail });
      }
    }
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The `origin` URL as git prints it, or undefined when there is no origin. */
export function gitRemoteUrl(root: string, timeoutMs?: number): string | undefined {
  // 2: no such remote; 128: git could not read the config. Neither is worth failing a capture for.
  const r = git(root, ['remote', 'get-url', 'origin'], { allowExit: [2, 128], until: by(timeoutMs) });
  return r.status === 0 ? r.out.toString('utf8').trim() || undefined : undefined;
}

/** HEAD is an ancestor of its upstream, by the local remote-tracking refs. No upstream, a detached HEAD or no commit: false. */
export function gitHeadPushed(root: string, timeoutMs?: number): boolean {
  // 1: not an ancestor; 128: no upstream configured, or HEAD does not exist yet
  return git(root, ['merge-base', '--is-ancestor', 'HEAD', '@{u}'], { allowExit: [1, 128], until: by(timeoutMs) }).status === 0;
}

/**
 * Which of `paths` differ from HEAD in the working copy: staged or unstaged edits and deletions
 * (`diff-index`, stat-based, so a touched file may be named too: the safe side), and untracked files.
 */
export function gitDirtyPaths(root: string, paths: string[], timeoutMs?: number): string[] {
  if (paths.length === 0) return [];
  const until = by(timeoutMs);
  const specs = paths.map(p => `:(literal)${p}`);
  const tracked = splitNul(git(root, ['diff-index', '--no-ext-diff', '--no-renames', '-z', '--name-only', gitHead(root, timeoutMs), '--', ...specs], { until }).out);
  const untracked = splitNul(git(root, ['ls-files', '-z', '--others', '--exclude-standard', '--', ...specs], { until }).out);
  const dirty = new Set([...tracked, ...untracked]);
  return paths.filter(p => dirty.has(p));
}

export function gitUntracked(root: string, timeoutMs?: number): string[] {
  return splitNul(git(root, ['ls-files', '-z', '--others', '--exclude-standard'], { until: by(timeoutMs) }).out);
}

/** Blob sha of `bytes` as git would store it at `rel` (filters applied via --path). */
export function gitHashObject(root: string, rel: string, bytes: Buffer, timeoutMs?: number): string {
  return git(root, ['hash-object', `--path=${rel}`, '--stdin'], { input: bytes, until: by(timeoutMs) }).out.toString('utf8').trim();
}

// hash-object --stdin-paths reads one path per line and C-unquotes a line that
// starts with '"', so every path is quoted: a newline or CR in a name survives.
const C_ESCAPES: Record<string, string> = { '"': '\\"', '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t' };
const cQuote = (p: string) =>
  '"' + p.replace(/["\\\x00-\x1f\x7f]/g, c => C_ESCAPES[c] ?? '\\' + c.charCodeAt(0).toString(8).padStart(3, '0')) + '"';

/**
 * Blob shas of the files at `rels` as they are on disk, in order, with ONE git
 * call (G15). Each file is hashed with its own path's filters, exactly like
 * gitHashObject(root, rel, <its bytes>). Every path must be a readable file.
 */
export function gitHashFiles(root: string, rels: string[], timeoutMs?: number): string[] {
  if (rels.length === 0) return [];
  const input = Buffer.from(rels.map(cQuote).join('\n') + '\n', 'utf8');
  const shas = git(root, ['hash-object', '--stdin-paths'], { input, until: by(timeoutMs) }).out.toString('utf8').split('\n').filter(s => s.length > 0);
  if (shas.length !== rels.length) {
    throw new Error(`git unavailable or not a repo: git hash-object in ${root}: ${shas.length} shas for ${rels.length} paths`);
  }
  return shas;
}

/** core.ignorecase and core.precomposeunicode, as git reads them for this repo. */
function pathConfig(root: string, until?: number): { ignoreCase: boolean; precompose: boolean } {
  const out = git(root, ['config', '--bool', '--get-regexp', '^core\\.(ignorecase|precomposeunicode)$'], { allowExit: [1], until }).out.toString('utf8');
  return { ignoreCase: /^core\.ignorecase true$/m.test(out), precompose: /^core\.precomposeunicode true$/m.test(out) };
}

/**
 * `rel` as git itself prints it (G17). On macOS a file keeps the NFD bytes it
 * was created with, which realpath returns, while git (core.precomposeunicode)
 * prints NFC; on a case-insensitive volume (core.ignorecase) the index may
 * differ in case. An exact match among the tracked and the untracked, not
 * ignored files wins; otherwise git's spelling is returned when exactly one
 * listed file matches with ASCII case folded (only if core.ignorecase) and
 * NFC/NFD taken as one (only if core.precomposeunicode). Without those, a case
 * variant is a different file. A path git would not list comes back unchanged.
 */
export function gitSpelling(root: string, rel: string, timeoutMs?: number): string {
  const until = by(timeoutMs);
  const { ignoreCase, precompose } = pathConfig(root, until);
  if (!ignoreCase && !precompose) return rel; // nothing to fold: rel is git's spelling, or isCitable refuses it
  const forms = precompose ? [rel, rel.normalize('NFC'), rel.normalize('NFD')] : [rel];
  const specs = [...new Set(forms)].map(p => `:(${ignoreCase ? 'literal,icase' : 'literal'})${p}`);
  const listed = splitNul(git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...specs], { until }).out);
  if (listed.includes(rel)) return rel;
  const fold = (p: string) => {
    const q = precompose ? p.normalize('NFC') : p;
    return ignoreCase ? q.replace(/[A-Z]/g, c => c.toLowerCase()) : q;
  };
  const same = [...new Set(listed)].filter(p => fold(p) === fold(rel));
  return same.length === 1 ? same[0] : rel;
}

function isTracked(root: string, rel: string, until?: number): boolean {
  return git(root, ['ls-files', '--error-unmatch', '--', `:(literal)${rel}`], { allowExit: [1], until }).status === 0;
}

/** Which of `rels` git would list (tracked, or untracked and not ignored), with ONE git call; on disk or not. */
export function gitListed(root: string, rels: string[], timeoutMs?: number): string[] {
  if (rels.length === 0) return [];
  return splitNul(git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...rels.map(p => `:(literal)${p}`)], { until: by(timeoutMs) }).out);
}

/**
 * A path is citable when it is a regular file on disk AND git would list it:
 * tracked, or untracked and not ignored (gitListed, the checkpoint's rule).
 * node_modules, build output and .env stay uncitable; so do directories,
 * symlinks, missing files, and anything under .git/ or in a nested repository,
 * which check-ignore would pass.
 */
export function gitIsCitable(root: string, rel: string, timeoutMs?: number): boolean {
  let st;
  try {
    st = lstatSync(resolve(root, rel));
  } catch {
    return false;
  }
  return st.isFile() && gitListed(root, [rel], timeoutMs).includes(rel);
}

/**
 * New-file-side line ranges of `git diff -U0 <baseSha> -- <rel>`. An untracked
 * file has no diff, so it is one open-ended hunk (any ref on it counts).
 */
export function gitHunks(root: string, baseSha: string, rel: string, timeoutMs?: number): Array<{ start: number; end: number }> {
  const until = by(timeoutMs);
  if (!isTracked(root, rel, until)) return [{ start: 1, end: Infinity }];
  return parseHunks(git(root, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '-U0', baseSha, '--', `:(literal)${rel}`], { until }).out.toString('utf8'));
}

type Hunk = { start: number; end: number };

/** New-side line ranges of a -U0 unified diff (count omitted means 1; a pure deletion has none). */
function parseHunks(out: string): Hunk[] {
  const hunks: Hunk[] = [];
  const re = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(out)) !== null) {
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    if (count === 0) continue; // pure deletion: nothing on the new side
    hunks.push({ start, end: start + count - 1 });
  }
  return hunks;
}
