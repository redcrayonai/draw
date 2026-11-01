/**
 * What a capture holds (spec §5), read from this checkout with the flows' own
 * git and file code (agent/src/git.ts, local-deps.ts readSource), and the
 * helper's state in <git-common-dir>/redcrayon/: `cited/<board id>` (the
 * paths captured for ref and cite on that board, JSON) and `boards.json`
 * ({ <board id>: <baseSha> }). Nothing here touches the network or the
 * repository's index or files: cli.ts uploads what buildCapture returns.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { GitOutputTooLargeError, GitTimeoutError } from '../../agent/src/errors';
import {
  gitChangeCandidates,
  gitCommonDir,
  gitConfirmChanged,
  gitDeleted,
  gitDirtyPaths,
  gitHashObject,
  gitHead,
  gitHeadPushed,
  gitHunks,
  gitIsCitable,
  gitObjectFormat,
  gitRemoteUrl,
  gitSpelling,
  gitTopLevel,
  gitUntracked,
} from '../../agent/src/git';
import { canonicalRepoPath, readSource, resolveRepoPath } from '../../agent/src/local-deps';
import { BinaryFileError, MissingFileError } from '../../agent/src/snippet';
import {
  CAPTURE_VERSION,
  MAX_BODY_BYTES,
  MAX_FILE_BYTES,
  REMOTE_MAX,
  isSecretFile,
  mb,
  pathProblem,
  type AbsentFile,
  type CaptureBody,
  type CaptureKind,
  type CheckpointBody,
  type WireFile,
} from '../../shared/capture';

/** Equals package.json's version (a test checks); claims refuse helpers older than MIN_HELPER_VERSION. */
export const HELPER_VERSION = '1.0.2';

export const PRIVACY =
  'To check code refs, redcrayon uploads each file your agent cites and deletes it within 10 minutes. It keeps paths, line numbers, git hashes, hashes of the cited lines and the GitHub repo address. It keeps the cited lines themselves only if you turn on storing code.';

/** The helper's refusals, exact (spec §12 Failure copy). */
export const say = {
  gitMissing: 'redcrayon: code refs need git on PATH, and git was not found. Install git, then call again.',
  notRepo: (dir: string) => `redcrayon: ${dir} is not inside a git repository. Code refs and checkpoints need a git checkout: start the agent in your project.`,
  secret: (path: string) => `redcrayon: ${path} is ignored by git or looks like a secrets file; code refs never read it. Cite another file.`,
  binary: (path: string) => `redcrayon: ${path} is a binary file; code refs read text. Cite another file.`,
  tooLarge: (path: string, bytes: number) => `redcrayon: ${path} is ${mb(bytes)} MB; code refs read files up to 1 MB. Cite a smaller file.`,
  bodyTooLarge: (bytes: number) =>
    `redcrayon: the checkpoint capture is ${mb(bytes)} MB; the limit is 8 MB. Nothing was uploaded. Remove code refs to large files, then call again.`,
  offline: (host: string) =>
    `redcrayon: could not reach ${host}. Nothing was uploaded. Check the network (in a sandboxed agent, allow network access for this command), then call again.`,
  windows: 'redcrayon: Windows is not supported yet.',
};

/** A refusal: its message is the one stderr line. */
export class HelperError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HelperError';
  }
}

/** The tools the plugin hook captures for, under every prefix Claude Code gives them (P0.6); group 3 is the tool. */
export const HOOK_MATCHER = '^mcp__(plugin_draw_)?(?:draw|redcrayon)(-dev)?__(start_session|add_code_ref|mark_checkpoint|create_edge|arrive|apply_board)$';

export const BOARD_RE = /^[0-9]{1,20}$/;
const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const remainingMs = (deadline?: number) => deadline === undefined ? undefined : Math.max(1, deadline - Date.now());

export const DEFAULT_ORIGIN = 'http://localhost:8788';
// REDCRAYON_MCP_URL is also the plugin's server URL (plugin/.mcp.json), so one variable moves both.
export const origin = () => {
  const { REDCRAYON_ORIGIN: set, REDCRAYON_MCP_URL: url } = process.env;
  return (set || (url ? new URL(url).origin : DEFAULT_ORIGIN)).replace(/\/+$/, '');
};

/**
 * The checkout around cwd (its realpath top level) and the helper's state dir,
 * shared by its worktrees and kept per server: board ids from a dev, staging
 * and production server must not share cited lists or base shas.
 */
export function checkout(cwd: string, deadline?: number): { root: string; state: string } {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore', timeout: remainingMs(deadline) });
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') throw new HelperError(say.gitMissing);
    throw err;
  }
  let root: string;
  try {
    root = realpathSync(gitTopLevel(cwd, remainingMs(deadline)));
  } catch {
    throw new HelperError(say.notRepo(resolve(cwd)));
  }
  return { root, state: join(gitCommonDir(root, remainingMs(deadline)), 'redcrayon', new URL(origin()).host.replace(/[^A-Za-z0-9.-]/g, '_')) };
}

// ---------- state ----------

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value)}\n`);
  renameSync(tmp, file);
}

const citedFile = (state: string, board: string) => join(state, 'cited', board);
const boardId = (board: string) => {
  if (!BOARD_RE.test(board)) throw new HelperError(`redcrayon: --board takes a board id (a number), not '${board}'.`);
  return board;
};

export function readCited(state: string, board: string): string[] {
  const paths = readJson<unknown>(citedFile(state, boardId(board)), []);
  return Array.isArray(paths) ? paths.filter((p): p is string => pathProblem(p) === undefined) : [];
}

/** Replace a board's cited paths (the PostToolUse hook, from a checkpoint's citedPaths). */
export function writeCited(state: string, board: string, paths: string[]): void {
  writeJson(citedFile(state, boardId(board)), [...new Set(paths.filter(p => pathProblem(p) === undefined))]);
}

export function readBase(state: string, board: string): string | undefined {
  const base = readJson<Record<string, unknown>>(join(state, 'boards.json'), {})[boardId(board)];
  return typeof base === 'string' && SHA_RE.test(base) ? base : undefined;
}

/** Record a session board's baseSha (the PostToolUse hook, from start_session's result). */
export function writeBase(state: string, board: string, baseSha: string): void {
  if (!SHA_RE.test(baseSha)) return;
  const file = join(state, 'boards.json');
  writeJson(file, { ...readJson<Record<string, string>>(file, {}), [boardId(board)]: baseSha });
}

/** True the first time it is asked in this repository: the privacy line is printed once. */
export function firstRun(state: string): boolean {
  const marker = join(state, 'notice');
  if (existsSync(marker)) return false;
  try {
    mkdirSync(state, { recursive: true });
    writeFileSync(marker, `${PRIVACY}\n`);
  } catch {
    // asked after an upload: a state dir it cannot write must not lose the capture id
  }
  return true;
}

// ---------- files ----------

/**
 * A file a ref or cite capture may hold, refused here, before any upload,
 * when it is on the secret list, ignored by git, a symlink, outside the repo,
 * binary or over 1 MB. MissingFileError passes through for checkpoints.
 */
function readCitable(root: string, asked: string, deadline?: number): WireFile {
  if (isSecretFile(asked)) throw new HelperError(say.secret(asked));
  let abs: string;
  try {
    abs = resolveRepoPath(root, asked);
  } catch (err) {
    if (err instanceof MissingFileError) throw err;
    throw new HelperError(`redcrayon: ${(err as Error).message}.`); // escapes, symlinks, non-files: readSource's own sentences
  }
  // the flows' spelling: on disk (realpath), then git's (G17)
  const path = gitSpelling(root, canonicalRepoPath(root, asked), remainingMs(deadline));
  if (isSecretFile(path) || !gitIsCitable(root, path, remainingMs(deadline))) throw new HelperError(say.secret(asked));
  const size = statSync(abs).size;
  if (size > MAX_FILE_BYTES) throw new HelperError(say.tooLarge(asked, size));
  let bytes: Buffer;
  try {
    bytes = readSource(root, asked).bytes;
  } catch (err) {
    if (err instanceof BinaryFileError) throw new HelperError(say.binary(asked));
    throw err;
  }
  if (bytes.length > MAX_FILE_BYTES) throw new HelperError(say.tooLarge(asked, bytes.length));
  return { path, bytes: bytes.toString('base64'), sha: gitHashObject(root, path, bytes, remainingMs(deadline)), citable: true };
}

// A cited file the helper will not upload is not a refusal of the checkpoint:
// the flow reads it as missing (its refs go stale) or unreadable (left as they are).
function checkpointFile(root: string, path: string, deadline?: number): WireFile | AbsentFile {
  try {
    return { ...readCitable(root, path, deadline), path };
  } catch (err) {
    if (err instanceof MissingFileError) return { path, missing: true };
    if (err instanceof HelperError) return { path, unreadable: true };
    throw err;
  }
}

// ---------- the remote ----------

const GITHUB_SCP = /^(?:[A-Za-z0-9._-]+@)?github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/?$/i;
const GITHUB_PATH = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/?$/;

/**
 * The origin URL as the capture sends it: `https://github.com/<owner>/<repo>` (a `.git` suffix stays),
 * whatever form git printed (https with a user name or token, `git@github.com:o/r`, ssh://, git://);
 * undefined for every other remote. The credentials never leave the machine, and a local path or file://
 * URL would put a user name in a view that public boards expose.
 */
export function githubRemote(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const url = raw.trim();
  let owner: string | undefined;
  let repo: string | undefined;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(url)) {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return undefined;
    }
    if (!['https:', 'http:', 'ssh:', 'git:'].includes(u.protocol) || u.hostname !== 'github.com') return undefined;
    [, owner, repo] = GITHUB_PATH.exec(u.pathname) ?? [];
  } else {
    [, owner, repo] = GITHUB_SCP.exec(url) ?? [];
  }
  const dots = (name: string) => /^\.{1,2}$/.test(name);
  const out = owner && repo && !dots(owner) && !dots(repo) ? `https://github.com/${owner}/${repo}` : undefined;
  return out !== undefined && out.length <= REMOTE_MAX ? out : undefined;
}

// ---------- captures ----------

export type CaptureOpts = {
  /** the project directory the agent runs in */
  cwd: string;
  /** ref and cite: the file, as the call names it */
  path?: string;
  /** ref and cite: records the path in cited/<board>; checkpoint: whose cited files to include */
  board?: string;
  /** checkpoint: the session's baseSha */
  base?: string;
  /** checkpoint: more files to include */
  also?: string[];
};

/** The body `POST /facts` takes for one capture (spec §5 Upload table); throws HelperError on a local refusal. */
export function buildCapture(kind: CaptureKind, opts: CaptureOpts, deadline?: number): CaptureBody {
  const { root, state } = checkout(opts.cwd, deadline);
  const objectFormat = gitObjectFormat(root, remainingMs(deadline));
  const remote = githubRemote(gitRemoteUrl(root, remainingMs(deadline)));
  const common = { v: CAPTURE_VERSION, helper: HELPER_VERSION, toplevel: root, objectFormat, head: gitHead(root, remainingMs(deadline)), ...(remote === undefined ? {} : { remote }) } as const;
  if (kind === 'start') return { ...common, kind };

  if (kind === 'ref' || kind === 'cite') {
    if (opts.path === undefined) throw new HelperError(`redcrayon: capture ${kind} needs the file's path.`);
    if (opts.board !== undefined) boardId(opts.board);
    let file: WireFile;
    try {
      file = readCitable(root, opts.path, deadline);
    } catch (err) {
      if (err instanceof MissingFileError) throw new HelperError(`redcrayon: ${err.message}.`);
      throw err;
    }
    if (opts.board !== undefined) writeCited(state, opts.board, [...readCited(state, opts.board), file.path]);
    return { ...common, kind, asked: opts.path, file };
  }

  if (opts.board === undefined || opts.base === undefined) throw new HelperError('redcrayon: capture checkpoint needs --board <id> and --base <sha>.');
  const base = opts.base;
  if (!SHA_RE.test(base)) throw new HelperError(`redcrayon: --base takes the session's baseSha, not '${base}'.`);
  // What git says changed, exactly as mark_checkpoint asks it locally: the
  // index first, then git's content check for each stat-only candidate.
  const candidates = gitChangeCandidates(root, base, remainingMs(deadline));
  const answers = gitConfirmChanged(root, base, candidates.filter(c => !c.sure).map(c => c.path), remainingMs(deadline));
  const uncompared: Record<string, string> = {};
  for (const [p, a] of answers) if (a.reason) uncompared[p] = a.reason;
  const changed = candidates.filter(c => c.sure || answers.get(c.path)?.changed).map(c => c.path);
  const files = [...new Set([...readCited(state, opts.board), ...(opts.also ?? [])])].map(p => checkpointFile(root, p, deadline));
  const changedSet = new Set(changed);
  const hunks: CheckpointBody['hunks'] = {};
  // An unreadable file's ok refs stay ok, so coverage still asks for its hunks: numbers only.
  for (const f of files) {
    if ('missing' in f || !changedSet.has(f.path)) continue;
    try {
      hunks[f.path] = gitHunks(root, base, f.path, remainingMs(deadline)).map(h => [h.start, h.end]);
    } catch (err) {
      if (!(err instanceof GitOutputTooLargeError || err instanceof GitTimeoutError)) throw err;
      hunks[f.path] = err.detail; // the flow notes it: the file's changed lines are unknown
    }
  }
  const body: CheckpointBody = {
    ...common,
    kind,
    base,
    changed,
    uncompared,
    untracked: gitUntracked(root, remainingMs(deadline)),
    deleted: gitDeleted(root, base, remainingMs(deadline)),
    hunks,
    files,
    pushed: gitHeadPushed(root, remainingMs(deadline)),
    dirty: gitDirtyPaths(root, files.map(f => f.path), remainingMs(deadline)),
  };
  const size = Buffer.byteLength(JSON.stringify(body));
  if (size > MAX_BODY_BYTES) throw new HelperError(say.bodyTooLarge(size));
  return body;
}
