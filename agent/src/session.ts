/**
 * Session companion flows: start_session, add_code_ref, mark_checkpoint, and the
 * ensureRepoPath helper create_edge shares. Pure orchestration over an
 * injectable connection (`Call`) and machine (`MachineDeps`: git and file
 * reads), so every branch is unit-testable with fakes; the hosted server
 * (mcp/) wires its HTTP calls and captures in. No node:fs or child_process
 * import here or below, so a server without the user's disk reuses the flows
 * over a capture. Every error thrown here is one sentence the model can act
 * on; the MCP layer prefixes it with "REJECTED: ". A CaptureRejection is
 * already the whole tool text.
 */
import { createHash } from 'node:crypto';
import { extname, posix } from 'node:path';
import type { ChangeCandidate } from './git';
import { GitOutputTooLargeError, GitTimeoutError } from './errors';
import { MissingFileError, sliceLines, type SourceFile } from './snippet';
import {
  resolveSymbol as resolveSymbolDefault,
  enclosingDeclaration,
  declarationsTouching,
  symbolNeedle,
  RESOLVABLE_EXTENSIONS,
  type ResolveResult,
} from './resolver';
import { computeCoverage, globToRegExp, MAX_GLOB_STEPS, type Coverage, type Hunk } from './coverage';
import { hasTerm, isMigrationPath, parseReaders, parseSubjects, readerStatus, termsOf, type Reader } from '../../module/src/change-notes';
import { CaptureRejection, isSecretFile, rejectText, secretCheck } from '../../shared/capture';
import { boardHref } from '../../shared/board-link';
import { lineHash, lineHashes } from './code-hash';

// One symbol rule in agent code (defined next to the resolver, re-exported here
// so callers of the flows never reach past this module).
export { symbolNeedle };

// ---------- the slice of DbConnection the flows need (structural) ----------

export type SessionRow = {
  id: bigint;
  boardId: bigint;
  repoRoot: string;
  baseSha: string;
  headSha: string;
  checkpoint: number;
  coverage: string;
  /** set by startSession; tells a session apart from one a wipe recreated with the same ids */
  startedAt?: { microsSinceUnixEpoch: bigint };
};

/** The change note columns the checkpoint reads (spec 2026-10-16). */
export type ChangeNoteRow = { id: bigint; boardId: bigint; refId: bigint; subjects: string; readers: string; refFileSha: string };

export type CodeRefRow = {
  id: bigint;
  boardId: bigint;
  targetKind: string;
  targetId: bigint;
  path: string;
  symbol: string;
  startLine: number;
  endLine: number;
  blobSha: string;
  snippet: string;
  author: string;
  checkpoint: number;
  status: string;
};

export type SessionEdgeRow = {
  id: bigint;
  boardId: bigint;
  evidence?: string;
  evidenceSnippet?: string;
  evidenceStatus?: string;
};

export type SessionRouteRow = {
  boardId: bigint;
  nodeIds: bigint[];
  currentIndex: number;
  revision: number;
  currentCheckpoint: number;
};

export type RouteEventRow = {
  id: bigint;
  boardId: bigint;
  kind: string;
  revision: number;
  nodeId?: bigint;
  nodeIds: bigint[];
  reason: string;
  checkpoint: number;
};

export type ArrivalCommit = { nodeId: bigint; expectedRevision: number; expectedCheckpoint: number };

export interface SessionDb {
  visibleBoard: { iter(): Iterable<{ id: bigint; name: string; slug: string }> };
  /** this identity's board list (the my_boards view, dashboard spec §1.6) */
  myBoards: { iter(): Iterable<{ boardId: bigint; name: string; access: string; isSession: boolean }> };
  visibleSession: { iter(): Iterable<SessionRow> };
  visibleRepoFile: { iter(): Iterable<{ id: bigint; boardId: bigint; path: string }> };
  visibleCodeRef: { iter(): Iterable<CodeRefRow> };
  visibleNode: { iter(): Iterable<{ id: bigint; boardId: bigint; hidden?: boolean }> };
  visibleEdge: { iter(): Iterable<SessionEdgeRow> };
  visibleSessionRoute: { iter(): Iterable<SessionRouteRow> };
  visibleRouteEvent: { iter(): Iterable<RouteEventRow> };
  visibleChangeNote: { iter(): Iterable<ChangeNoteRow> };
  /** RC-690: whether each board keeps code text; no row is no */
  visibleBoardCodeConsent: { iter(): Iterable<{ boardId: bigint; storeCode: boolean }> };
  visibleCodeRefHash: { iter(): Iterable<{ refId: bigint; boardId: bigint; lineHashes: string }> };
  visibleEdgeEvidenceHash: { iter(): Iterable<{ edgeId: bigint; boardId: bigint; lineHash: string }> };
}

export interface SessionReducers {
  startSession(a: { name: string; repoRoot: string; baseSha: string }): Promise<unknown>;
  addRepoFiles(a: { boardId: bigint; paths: string[] }): Promise<unknown>;
  addCodeRef(a: {
    boardId: bigint;
    targetKind: string;
    targetId: bigint;
    path: string;
    symbol: string;
    startLine: number;
    endLine: number;
    blobSha: string;
    snippet: string;
    author: string;
  }): Promise<unknown>;
  updateCodeRef(a: { id: bigint; startLine: number; endLine: number; blobSha: string; snippet: string; status: string }): Promise<unknown>;
  updateCodeRefAndFocus?(a: { id: bigint; startLine: number; endLine: number; blobSha: string; snippet: string; status: string }): Promise<unknown>;
  updateEdgeEvidence(a: { edgeId: bigint; evidence: string; status: string }): Promise<unknown>;
  markCheckpoint(a: { boardId: bigint; headSha: string; coverage: string }): Promise<unknown>;
  planRoute(a: { boardId: bigint; nodeIds: bigint[] }): Promise<unknown>;
  reroute(a: { boardId: bigint; addNodeIds: bigint[]; addIndices: number[]; removeNodeIds: bigint[]; reason: string }): Promise<unknown>;
  arriveAtCheckpoint(a: { boardId: bigint; headSha: string; coverage: string } & ArrivalCommit): Promise<unknown>;
  setChangeNoteReaders(a: { id: bigint; readers: string; refFileSha: string }): Promise<unknown>;
  setCodeRefHashes(a: { refId: bigint; lineHashes: string }): Promise<unknown>;
  setEdgeEvidenceCode(a: { edgeId: bigint; lineHash: string; snippet: string | undefined }): Promise<unknown>;
  setSessionRemote(a: { boardId: bigint; remoteUrl: string; pushedHead: string; dirtyPaths: string[] }): Promise<unknown>;
}

export interface SessionConn {
  db: SessionDb;
  reducers: SessionReducers;
}

/**
 * Reads and reducer calls alike go through here: PR0's ready gate + 15 s
 * timeout, or the shorter timeoutMs a flow passes when its deadline is nearer.
 */
export type Call = <T>(label: string, fn: (conn: SessionConn) => Promise<T>, timeoutMs?: number) => Promise<T>;

/**
 * The flows' calls with every snippet scanned for secrets before it is
 * written (spec §5 Checks). A ref that would store a secret is refused;
 * `partial` says so truthfully when the flow wrote before it.
 */
export function guardSecrets(call: Call, partial = false): Call {
  const check = (path: string, text: string, line: number) => {
    const found = secretCheck(path, text, line);
    if (found) throw new CaptureRejection(partial ? found.replace('Nothing was written.', 'Writes before it in this call stand; nothing after it was written.') : found);
  };
  return (label, fn, ms) =>
    call(
      label,
      conn => {
        const r = conn.reducers;
        const refPath = (id: bigint) => [...conn.db.visibleCodeRef.iter()].find(x => x.id === id)?.path ?? 'a code ref';
        return fn({
          db: conn.db,
          reducers: {
            ...r,
            addCodeRef: a => (check(a.path, a.snippet, a.startLine), r.addCodeRef(a)),
            updateCodeRef: a => (check(refPath(a.id), a.snippet, a.startLine), r.updateCodeRef(a)),
            updateCodeRefAndFocus: r.updateCodeRefAndFocus && (a => (check(refPath(a.id), a.snippet, a.startLine), r.updateCodeRefAndFocus!(a))),
          },
        });
      },
      ms
    );
}

// ---------- code consent (RC-690) ----------

/** The module's refusal of code text on a board that keeps none (module/src/index.ts). */
export const CODE_CONSENT_RULE = 'code rule: this board does not store code; send the code ref without its snippet';

/** Whether the board keeps code text: its owner opted in. No row (none, or not loaded) is no. */
export function boardStoresCode(call: Call, boardId: bigint): Promise<boolean> {
  return call('read code consent', async conn => [...conn.db.visibleBoardCodeConsent.iter()].some(r => r.boardId === boardId && r.storeCode));
}

/**
 * A write that may carry code text: with it where the board stores code. When
 * the module refuses the text (consent turned off since it was read), the same
 * write without it: the refusal is the answer. Resolves to whether text went in.
 */
export async function writeCode(storeCode: boolean, write: (withText: boolean) => Promise<unknown>): Promise<boolean> {
  if (storeCode) {
    try {
      await write(true);
      return true;
    } catch (err) {
      if (!(err instanceof Error && err.message.includes(CODE_CONSENT_RULE))) throw err;
    }
  }
  await write(false);
  return false;
}

/** A ref's hashes, as stored: one per line of `lines`, space-joined. */
const joinedHashes = (lines: string[]) => lineHashes(lines).join(' ');

/** A `source:` evidence line about to be stored with create_edge: refused when it looks like a secret. */
export function checkEvidence(evidence: string, snippet: string | undefined) {
  const citation = sourceCitation(evidence);
  const found = citation && snippet !== undefined && secretCheck(citation.path, snippet, citation.line);
  if (found) throw new CaptureRejection(found);
}

// Any board writer can register a path, so the list is checked even for a registered one.
function refuseSecretFile(...paths: string[]) {
  const secret = paths.find(isSecretFile);
  if (secret !== undefined) throw new CaptureRejection(rejectText.secretFile(secret));
}

/** timeoutMs: the most the call may take (a flow's time left); git.ts caps it at GIT_TIMEOUT_MS. */
export type GitOps = {
  topLevel(root: string, timeoutMs?: number): string;
  head(root: string, timeoutMs?: number): string;
  listTracked(root: string, timeoutMs?: number): string[];
  /** what may have changed since baseSha, from the index alone (see gitChangeCandidates) */
  changeCandidates(root: string, baseSha: string, timeoutMs?: number): ChangeCandidate[];
  /** git's answer per stat-dirty candidate; reason when git could not compare it in time (see gitConfirmChanged) */
  confirmChanged(root: string, baseSha: string, paths: string[], timeoutMs?: number, more?: () => boolean): Map<string, { changed: boolean; reason?: string }>;
  indexPath(root: string, timeoutMs?: number): string;
  deleted(root: string, baseSha: string, timeoutMs?: number): string[];
  untracked(root: string, timeoutMs?: number): string[];
  hashObject(root: string, rel: string, bytes: Buffer, timeoutMs?: number): string;
  /** shas of the files at `rels` on disk, in order, with one git call */
  hashFiles(root: string, rels: string[], timeoutMs?: number): string[];
  isCitable(root: string, rel: string, timeoutMs?: number): boolean;
  hunks(root: string, baseSha: string, rel: string, timeoutMs?: number): Hunk[];
  /** the spelling git prints for an on-disk repo-relative path (G17) */
  spelling(root: string, rel: string, timeoutMs?: number): string;
  /** which of `rels` git would list (tracked, or untracked and not ignored), with one git call; a capture has none: the helper sends only those */
  listed?(root: string, rels: string[], timeoutMs?: number): string[];
};

/** The user's machine: localDeps (local-deps.ts) on it, a capture when it is elsewhere. */
export interface MachineDeps {
  git: GitOps;
  /** the whole file under the repo root, refusing escapes, symlinks and binaries (local-deps.ts readSource) */
  readSource: (repoRoot: string, rel: string) => SourceFile;
  realpath: (p: string) => string;
  /** the on-disk spelling of a repo-relative path (canonicalRepoPath); throws when the file cannot be read */
  diskPath: (repoRoot: string, rel: string) => string;
  /** a path's lstat stamp (repo-relative or absolute), undefined when it cannot be read */
  stamp: (repoRoot: string, rel: string) => string | undefined;
  /**
   * Throws unless the machine can answer for every file mark_checkpoint will
   * read; asked before any write. A disk always can; a capture that lacks a
   * cited file must refuse, not pass the file off as unreadable.
   */
  need?: (repoRoot: string, paths: string[]) => void;
}

export interface SessionDeps extends MachineDeps {
  call: Call;
  /** Older modules keep ref edits available without automatic focus. */
  followCodeRef?: boolean;
  resolveSymbol?: (absPath: string, source: string, symbol: string) => ResolveResult;
  /** repo-relative path -> the spelling git prints; defaults to diskPath, then git.spelling */
  canonicalPath?: (repoRoot: string, path: string) => string;
  /** wall clock in ms for the flow budget; defaults to Date.now */
  now?: () => number;
  /** where an unfinished mark_checkpoint keeps its progress; defaults to this process's checkpointProgress */
  progress?: Map<bigint, CheckpointProgress>;
  /** the calling tool's budget; ensureRepoPath runs within it when given */
  budget?: FlowBudget;
}

// A file that cannot be read (deleted but still tracked, a symlink git tracks)
// keeps its lexically normalised spelling; isCitable then decides.
function defaultCanonicalPath(deps: MachineDeps, repoRoot: string, path: string, timeoutMs?: number): string {
  let onDisk: string;
  try {
    onDisk = deps.diskPath(repoRoot, path);
  } catch {
    return posix.normalize(path);
  }
  return deps.git.spelling(repoRoot, onDisk, timeoutMs);
}

// A git call cut short by the tool's deadline (not git's own timeout) becomes
// the tool's answer for running out of time; anything else stays as it is.
const outOfTime = (err: unknown, text: string): unknown => (err instanceof GitTimeoutError && err.limited ? new Error(text) : err);
const registeredButOutOfTime = (path: string, what: string) =>
  `${path} is registered for this board, but time ran out before ${what} was written; nothing else was written, so calling again is safe`;
// The ref landed, its line hashes did not: calling again finds the ref and fills them (addCodeRefFlow's existing-ref path).
const hashesOutOfTime = (id: bigint, path: string) =>
  `add_code_ref wrote code ref ${id} for ${path}, but time ran out before its line hashes were written; calling again is safe`;

// Same rule and text as the module's startSession.
export const SESSION_NAME_MAX = 100;
export const SESSION_NAME_RE = /^[^\x00-\x1f\x7f]+$/;
export const SESSION_NAME_RULE = 'session name must be one short line, e.g. the git branch';
export const MAX_SNIPPET_LINES = 60;
export const MAX_SNIPPET_CHARS = 4000;
export const REPO_FILE_CHUNK = 200;
/**
 * One deadline for a whole tool call that chains git and reducer calls
 * (G15): start_session, mark_checkpoint, add_code_ref, and create_edge with
 * source evidence on a session board. So the tool answers inside 15 s: no new step (a chunk, a ref, a coverage git call, the
 * final write) starts after FLOW_BUDGET_MS from entry, and a step already
 * running gets git and reducer timeouts that end FLOW_CUTOFF_MS after entry
 * (at least FLOW_MIN_CALL_MS). Past the deadline the flow says how far it got.
 * Calling again makes progress: start_session uploads at least one chunk per
 * call; mark_checkpoint keeps what it computed (checkpointProgress) and each
 * call hashes at least one file no earlier call hashed, or, with every hash
 * kept, has nearly its whole budget for refs and coverage. The limit is one
 * git call: a coverage listing that alone takes longer than GIT_TIMEOUT_MS
 * (e.g. a slow clean filter run on many modified files) fails with git's
 * timeout text instead.
 */
export const FLOW_BUDGET_MS = 13_000;
export const FLOW_CUTOFF_MS = 14_000;
export const FLOW_MIN_CALL_MS = 500;
/**
 * A reducer write never starts with less than this left before the cut-off:
 * a reducer timeout drops and rebuilds the connection, so a short one would
 * cost a slow but healthy DB its socket. The flow stops with "call again".
 */
export const FLOW_MIN_WRITE_MS = 2_000;
/** ref files hashed per git call (G15): small enough for a slow clean filter to fit the budget */
export const HASH_CHUNK = 16;
const REDUCER_TIMEOUT_MS = 15_000;

export type FlowBudget = ReturnType<typeof flowBudget>;

export function flowBudget(now: () => number) {
  const start = now();
  return {
    over: () => now() > start + FLOW_BUDGET_MS,
    /** time left before the cut-off, for one git or reducer call */
    ms: () => Math.max(FLOW_MIN_CALL_MS, Math.min(REDUCER_TIMEOUT_MS, start + FLOW_CUTOFF_MS - now())),
    /** enough time left to start a reducer write */
    canWrite: () => start + FLOW_CUTOFF_MS - now() >= FLOW_MIN_WRITE_MS,
  };
}

// ---------- small pure helpers ----------


/**
 * Lines startLine..endLine, clamped from the start to the module's limits
 * (60 lines, 4000 chars). `clampedFrom` is the requested endLine when clamping
 * happened. Range errors come from sliceLines (real line count in the message).
 */
export function fitSnippet(
  rel: string,
  lines: string[],
  startLine: number,
  endLine: number
): { startLine: number; endLine: number; text: string; clampedFrom?: number } {
  const full = sliceLines(rel, lines, startLine, endLine); // validates the range
  if (endLine - startLine + 1 <= MAX_SNIPPET_LINES && full.length <= MAX_SNIPPET_CHARS) {
    return { startLine, endLine, text: full, clampedFrom: undefined };
  }
  let end = Math.min(endLine, startLine + MAX_SNIPPET_LINES - 1);
  let text = lines.slice(startLine - 1, end).join('\n');
  while (text.length > MAX_SNIPPET_CHARS && end > startLine) {
    end -= 1;
    text = lines.slice(startLine - 1, end).join('\n');
  }
  if (text.length > MAX_SNIPPET_CHARS) {
    throw new Error(`line ${startLine} of ${rel} alone exceeds ${MAX_SNIPPET_CHARS} chars; code refs need a shorter range`);
  }
  return { startLine, endLine: end, text, clampedFrom: end < endLine ? endLine : undefined };
}

// Code no name reaches. The honest remedy for it is coverage's exclude (G1);
// ranges stay refused for TS/JS.
const UNCITABLE = 'outside every addressable declaration (a top-level call, an import or an export list)';
const excludeRemedy = (path: string) => `exclude ${path} at mark_checkpoint with a reason`;
/** Resolver kinds whose members are indexed as Name.member. */
const MEMBER_KINDS = new Set(['class', 'interface', 'enum', 'namespace']);

// No TS/JS text below offers a range: add_code_ref refuses one for those
// extensions (refs are re-found by symbol at every checkpoint, so a ranged ref
// would go stale or drift). Only unsupported_language asks for a range.
export function describeResolveFailure(r: Exclude<ResolveResult, { ok: true }>, symbol: string, path: string): string {
  switch (r.reason) {
    case 'ambiguous': {
      // Candidates always carry the very name asked for, so no more specific
      // name exists: the owner of a member encloses them all, and a top-level
      // repeat (a JS redeclaration) has no owner. exports.x has no citable owner.
      const dot = symbol.lastIndexOf('.');
      const owner = dot > 0 ? symbol.slice(0, dot) : '';
      const list = `ambiguous: '${symbol}' matches ${r.candidates.length} declarations in ${path}: ` + r.candidates.map(c => `${c.kind} ${c.name} ${c.startLine}-${c.endLine}`).join(', ');
      if (owner !== '' && owner !== 'exports' && owner !== 'module.exports') {
        return `${list}; they share one name, so neither can be cited alone — cite the enclosing '${owner}' instead`;
      }
      // Repeated blocks (two `interface Q`, two `namespace NS`) still have
      // citable members; a value repeat (a JS redeclaration) has none.
      const hasMembers = (kind: string) => kind.split('+').some(k => MEMBER_KINDS.has(k));
      return owner === '' && r.candidates.every(c => hasMembers(c.kind))
        ? `${list}; they share one name, so neither block can be cited whole — cite their members (${symbol}.member) instead`
        : `${list}; they share one name and no declaration encloses them, so they cannot be cited — ${excludeRemedy(path)}`;
    }
    case 'not_found':
      return (
        `not found: no top-level declaration or Class.member named '${symbol}' in ${path}; ` +
        (r.suggestions.length > 0
          ? `did you mean ${r.suggestions.join(', ')}?`
          : `if it is nested or local, cite the declaration that encloses it; code ${UNCITABLE} cannot be cited — ${excludeRemedy(path)}`)
      );
    case 'parse_error':
      return `${path} does not parse (${r.message}); fix the syntax error, then add the ref again`;
    case 'unsupported_language':
      return `'${r.ext}' files are not resolvable; pass startLine and endLine for ${path}`;
  }
}

/**
 * The rejection for a range on a resolvable file, naming what to cite instead:
 * the enclosing declaration, else every declaration the range touches, else
 * (nothing touched) the exclude remedy — never a name that does not exist (G1).
 * `touching` is declarationsTouching's answer, undefined when the file does
 * not parse; its `rest` adds the exclude remedy for the lines no name reaches.
 */
export function describeRangeRefusal(
  ext: string,
  path: string,
  startLine: number,
  endLine: number,
  enclosing: { name: string; startLine: number; endLine: number } | undefined,
  touching: { names: string[]; rest: boolean } | undefined
): string {
  const head = `startLine/endLine are not accepted for ${ext} files: the server resolves the symbol and re-finds it by name at every checkpoint; `;
  if (enclosing) {
    return head + `cite symbol '${enclosing.name}' (the declaration enclosing lines ${startLine}-${endLine}, at ${enclosing.startLine}-${enclosing.endLine}) and omit the range`;
  }
  if (touching === undefined) {
    return head + `${path} does not parse, so no declaration can be named for lines ${startLine}-${endLine}; fix the syntax error, then cite the declaration that contains them and omit the range`;
  }
  if (touching.names.length > 0) {
    const rest = touching.rest ? `; the rest is outside every addressable declaration — ${excludeRemedy(path)}` : '';
    return head + `no one declaration encloses lines ${startLine}-${endLine} — cite each one they touch by name (${touching.names.join(', ')}) and omit the range` + rest;
  }
  return head + `lines ${startLine}-${endLine} of ${path} are ${UNCITABLE}; they cannot be cited — ${excludeRemedy(path)}`;
}

// ---------- ensureRepoPath (shared with create_edge) ----------

const notCitable = (path: string, repoRoot: string) =>
  new Error(`path '${path}' is not citable: it must be tracked by git, or untracked and not ignored, under ${repoRoot}`);

/**
 * Register `path` in repoFile for the board unless it already is, under the
 * spelling git prints, and return that spelling. Only paths git would list are
 * accepted: tracked, or untracked and not ignored. A registered path is checked
 * too: any board writer can register one, and git may stop listing it.
 */
export async function ensureRepoPath(deps: SessionDeps, boardId: bigint, repoRoot: string, given: string): Promise<string> {
  const { git, budget } = deps;
  const nothing = (p: string) => `ran out of time (git was slow) before registering ${p}; nothing was written, so calling again is safe`;
  let path = given;
  let citable: boolean;
  let registered: boolean;
  try {
    path = deps.canonicalPath ? deps.canonicalPath(repoRoot, given) : defaultCanonicalPath(deps, repoRoot, given, budget?.ms());
    refuseSecretFile(given, path);
    citable = git.isCitable(repoRoot, path, budget?.ms());
    registered = await deps.call('read repo files', async conn =>
      [...conn.db.visibleRepoFile.iter()].some(f => f.boardId === boardId && f.path === path)
    );
  } catch (err) {
    throw outOfTime(err, nothing(path));
  }
  if (!citable) throw notCitable(path, repoRoot);
  if (registered) return path;
  if (budget && !budget.canWrite()) throw new Error(nothing(path));
  await deps.call('add_repo_files', conn => conn.reducers.addRepoFiles({ boardId, paths: [path] }), budget?.ms());
  return path;
}

/**
 * create_edge's source:<path>:<line> evidence (G15): the canonical path,
 * registered for the board, and enough budget left to start the edge write.
 * Returns the evidence and its exact cited line;
 * throws a sentence saying what was written when time runs out.
 */
export async function prepareSourceEvidence(
  deps: SessionDeps & { budget: FlowBudget },
  boardId: bigint,
  repoRoot: string,
  evidence: string
): Promise<{ evidence: string; evidenceSnippet: string; evidenceHash: string }> {
  const citation = sourceCitation(evidence);
  if (!citation) throw new Error(`'${evidence}' must have the form source:<path>:<positive line>`);
  // Read before registering: an invalid citation must not leave a repoFile row.
  const src = deps.readSource(repoRoot, citation.path);
  const evidenceSnippet = sliceLines(citation.path, src.lines, citation.line, citation.line);
  if (!evidenceSnippet.trim()) throw new Error(`${evidence} cites a blank line; cite the line that establishes the relationship`);
  if (evidenceSnippet.length > MAX_SNIPPET_CHARS) throw new Error(`${evidence} cites a line longer than ${MAX_SNIPPET_CHARS} characters; cite a shorter line that establishes the relationship`);
  if (src.lines.filter(line => line === evidenceSnippet).length !== 1) throw new Error(`${evidence} cites a line that appears more than once; cite a unique line that establishes the relationship`);
  checkEvidence(evidence, evidenceSnippet);
  const path = await ensureRepoPath(deps, boardId, repoRoot, citation.path);
  if (!deps.budget.canWrite()) throw new Error(registeredButOutOfTime(path, 'the edge'));
  return { evidence: path !== citation.path ? `source:${path}:${citation.line}` : evidence, evidenceSnippet, evidenceHash: lineHash(evidenceSnippet) };
}

// Paths may contain colons. Only the final colon separates the line number.
function sourceCitation(evidence: string): { path: string; line: number } | undefined {
  if (!evidence.startsWith('source:')) return undefined;
  const rest = evidence.slice('source:'.length);
  const colon = rest.lastIndexOf(':');
  const line = Number(rest.slice(colon + 1));
  if (colon <= 0 || !/^[0-9]+$/.test(rest.slice(colon + 1)) || !Number.isSafeInteger(line) || line < 1) return undefined;
  return { path: rest.slice(0, colon), line };
}

// ---------- start_session ----------

export interface StartSessionInput {
  name: string;
  repoRoot: string;
  force: boolean;
  activeBoardId: bigint | undefined;
  clientUrl: string;
  dbName: string;
  /** false on a module that predates the my_boards view: find the board by name instead */
  myBoards?: boolean;
}

export interface StartSessionResult {
  boardId: bigint;
  /** the session row and its startedAt: the server checks they are still there at every reconnect (G19) */
  sessionId: bigint;
  sessionStartedAt: bigint | undefined;
  board: string;
  id: string;
  repoRoot: string;
  checkpoint: number;
  url: string;
  seeded: number;
}

export async function startSessionFlow(input: StartSessionInput, deps: SessionDeps): Promise<StartSessionResult> {
  if (input.name.length > SESSION_NAME_MAX || !SESSION_NAME_RE.test(input.name)) throw new Error(SESSION_NAME_RULE);
  const { git } = deps;
  const budget = flowBudget(deps.now ?? Date.now);
  const root = deps.realpath(git.topLevel(input.repoRoot, budget.ms()));

  // A board selected by SPACETIME_BOARD without a session row (e.g. Demo) is
  // not an active session; only a session board blocks a switch.
  if (input.activeBoardId !== undefined && !input.force) {
    const active = input.activeBoardId;
    const current = await deps.call('read active session', async conn => {
      const session = [...conn.db.visibleSession.iter()].find(s => s.boardId === active);
      if (!session) return undefined;
      return [...conn.db.visibleBoard.iter()].find(b => b.id === active)?.name ?? `#${active}`;
    });
    if (current !== undefined && current !== input.name) {
      throw new Error(`a session is already active on board "${current}"; pass force: true to switch boards`);
    }
  }

  const baseSha = git.head(root, budget.ms());
  if (!budget.canWrite()) throw new Error('git took most of the time budget before start_session could write; call again to continue');
  await deps.call('start_session', conn => conn.reducers.startSession({ name: input.name, repoRoot: root, baseSha }), budget.ms());

  // Reducers return nothing. The module keeps at most one SESSION board per
  // name and checkout among the caller's boards (dashboard spec §1.5): its own,
  // and for a linked agent its owner's boards it edits ('grant'). Anyone
  // else's board of that name, or a same-named plain board, is not it. So pick
  // from this identity's my_boards rows: same name, a session, this checkout.
  // A module without my_boards keeps names unique across all boards, so
  // there the same-named board with a session row is it.
  const found = await deps.call('find session board', async conn => {
    let boardId: bigint | undefined;
    if (input.myBoards === false) {
      const named = new Set([...conn.db.visibleBoard.iter()].filter(b => b.name === input.name).map(b => b.id));
      boardId = [...conn.db.visibleSession.iter()].find(s => named.has(s.boardId))?.boardId;
      if (boardId === undefined) throw new Error(`session board "${input.name}" is not in the cache after start_session; retry in a moment`);
    } else {
      const mine = [...conn.db.myBoards.iter()].filter(b => (b.access === 'owner' || b.access === 'grant') && b.name === input.name && b.isSession).map(b => b.boardId);
      if (mine.length === 0) throw new Error(`session board "${input.name}" is not in this agent's board list (my_boards) after start_session; retry in a moment`);
      // a same-named board from another checkout can be listed too; the reducer used this checkout's
      boardId = [...conn.db.visibleSession.iter()].find(s => mine.includes(s.boardId) && s.repoRoot === root)?.boardId;
    }
    const session = [...conn.db.visibleSession.iter()].find(s => s.boardId === boardId);
    if (!session) throw new Error(`board "${input.name}" has no session row after start_session; retry in a moment`);
    const registered = new Set([...conn.db.visibleRepoFile.iter()].filter(f => f.boardId === session.boardId).map(f => f.path));
    // By slug, as the canvas links it: names are unique only per owner.
    const slug = [...conn.db.visibleBoard.iter()].find(b => b.id === session.boardId)?.slug ?? '';
    return { boardId: session.boardId, slug, sessionId: session.id, sessionStartedAt: session.startedAt?.microsSinceUnixEpoch, checkpoint: session.checkpoint, repoRoot: session.repoRoot, registered };
  });

  // Seed only what the cache does not already hold (a resumed session seeds
  // nothing); addRepoFiles dedupes server-side too, so a retry is harmless.
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const p of git.listTracked(root, budget.ms())) {
    if (found.registered.has(p) || seen.has(p)) continue;
    seen.add(p);
    missing.push(p);
  }
  const chunks = Math.ceil(missing.length / REPO_FILE_CHUNK);
  for (let i = 0; i < missing.length; i += REPO_FILE_CHUNK) {
    if ((i > 0 && budget.over()) || !budget.canWrite()) {
      throw new Error(`processed ${i / REPO_FILE_CHUNK} of ${chunks} repo file chunks; call again to continue`);
    }
    const paths = missing.slice(i, i + REPO_FILE_CHUNK);
    await deps.call('add_repo_files', conn => conn.reducers.addRepoFiles({ boardId: found.boardId, paths }), budget.ms());
  }

  return {
    boardId: found.boardId,
    sessionId: found.sessionId,
    sessionStartedAt: found.sessionStartedAt,
    board: input.name,
    id: found.boardId.toString(),
    repoRoot: found.repoRoot,
    checkpoint: found.checkpoint,
    url: boardHref({ app: input.clientUrl, slug: found.slug, db: input.dbName }),
    seeded: missing.length,
  };
}

// ---------- add_code_ref ----------

export interface AddCodeRefInput {
  boardId: bigint;
  repoRoot: string;
  targetKind: 'node' | 'edge';
  targetId: bigint;
  path: string;
  symbol: string;
  startLine?: number;
  endLine?: number;
  author?: string;
}

export interface AddCodeRefResult {
  id: bigint;
  path: string;
  startLine: number;
  endLine: number;
  clampedFrom?: number;
  /** true when the target already had a ref for this path + symbol; nothing was written unless `moved` */
  existing: boolean;
  /** an existing non-TS/JS ref was moved in place to the newly requested range (G18) */
  moved?: true;
  /** the existing ref's status when it is not ok (G18) */
  status?: string;
}

const REF_REMEDY = 'remove_code_ref then add_code_ref under the current name';

/** The add_code_ref result text, before the board suffix. */
export function addCodeRefText(r: AddCodeRefResult): string {
  const verb = r.moved ? 'moved' : r.existing ? 'already attached' : 'committed';
  const clamp = r.clampedFrom ? ` (clamped from ${r.clampedFrom})` : '';
  const status = r.status ? ` status=${r.status} (${REF_REMEDY})` : '';
  return `${verb} id=${r.id} ${r.path}:${r.startLine}-${r.endLine}${clamp}${status}`;
}

/** The ref's identity: one ref per target, path and symbol (module addCodeRef enforces it too). */
function findSameRef(conn: SessionConn, boardId: bigint, targetKind: string, targetId: bigint, path: string, symbol: string): CodeRefRow | undefined {
  return [...conn.db.visibleCodeRef.iter()].find(
    r => r.boardId === boardId && r.targetKind === targetKind && r.targetId === targetId && r.path === path && r.symbol === symbol
  );
}

const asExisting = (r: CodeRefRow): AddCodeRefResult => ({
  id: r.id,
  path: r.path,
  startLine: r.startLine,
  endLine: r.endLine,
  clampedFrom: undefined,
  existing: true,
  ...(r.status !== 'ok' ? { status: r.status } : {}),
});

export async function addCodeRefFlow(input: AddCodeRefInput, deps: SessionDeps): Promise<AddCodeRefResult> {
  const { git, readSource } = deps;
  const resolve = deps.resolveSymbol ?? resolveSymbolDefault;
  const { boardId, repoRoot, symbol } = input;
  // One deadline for the whole tool, like mark_checkpoint (G15): git and
  // reducer calls take the time left, and no write starts with under 2 s.
  const budget = deps.budget ?? flowBudget(deps.now ?? Date.now);
  const NOTHING = 'add_code_ref ran out of time before writing anything (git was slow); nothing was written, so calling again is safe';
  const gitStep = <T>(step: () => T): T => {
    try {
      return step();
    } catch (err) {
      throw outOfTime(err, NOTHING);
    }
  };

  // The server reads the file; the model never pastes code. From here on the
  // path is the spelling git prints (F4), whatever spelling the model used:
  // readSource gives the on-disk spelling, git.spelling git's own (G17).
  const src = readSource(repoRoot, input.path);
  const path = gitStep(() => git.spelling(repoRoot, src.rel, budget.ms()));
  refuseSecretFile(input.path, path); // before the existing-ref branch, which skips ensureRepoPath

  // A retry (e.g. after "reducer timed out", when the write may have landed)
  // or a re-add at a later checkpoint names the existing ref (F17).
  const same = await deps.call('read code refs', async conn => findSameRef(conn, boardId, input.targetKind, input.targetId, path, symbol));
  const ext = extname(path).toLowerCase();
  const resolvable = RESOLVABLE_EXTENSIONS.includes(ext);
  const hashesOf = (fit: { startLine: number; endLine: number }) => joinedHashes(src.lines.slice(fit.startLine - 1, fit.endLine));
  const fitWithNeedle = (s: number, e: number) => {
    const fit = fitSnippet(path, src.lines, s, e);
    if (!fit.text.includes(symbolNeedle(symbol))) {
      throw new Error(`symbol '${symbol}' does not occur in ${path}:${fit.startLine}-${fit.endLine}; name the declaration that lives in that range`);
    }
    return fit;
  };
  if (same) {
    // This branch skips ensureRepoPath, and with it the citable check.
    if (!gitStep(() => git.isCitable(repoRoot, path, budget.ms()))) throw notCitable(path, repoRoot);
    // Line hashes that never landed (time ran out after add_code_ref) are filled while the file is the one
    // the ref was made from, so its stored lines are still the ones it cites.
    const hashed = await deps.call('read code ref hashes', async conn => [...conn.db.visibleCodeRefHash.iter()].some(h => h.refId === same.id));
    if (!hashed && budget.canWrite() && gitStep(() => git.hashObject(repoRoot, path, src.bytes, budget.ms())) === same.blobSha) {
      await deps.call('set_code_ref_hashes', conn => conn.reducers.setCodeRefHashes({ refId: same.id, lineHashes: hashesOf(same) }), budget.ms());
    }
    // A non-TS/JS ref has no name to re-find it by, so a re-add with other
    // lines says the code moved: move the ref in place (same id, ok) (G18).
    const { startLine: s, endLine: e } = input;
    if (resolvable || s === undefined || e === undefined || (s === same.startLine && e === same.endLine)) return asExisting(same);
    const fit = fitWithNeedle(s, e);
    if (fit.startLine === same.startLine && fit.endLine === same.endLine) return asExisting(same);
    const blobSha = gitStep(() => git.hashObject(repoRoot, path, src.bytes, budget.ms()));
    const storeCode = await boardStoresCode(deps.call, boardId);
    if (!budget.canWrite()) throw new Error(NOTHING);
    // Hashes first: a move that does not land leaves hashes for the lines it
    // asked for (the next checkpoint follows or rewrites them), never hashes
    // for lines the ref has left.
    await deps.call('set_code_ref_hashes', conn => conn.reducers.setCodeRefHashes({ refId: same.id, lineHashes: hashesOf(fit) }), budget.ms());
    await writeCode(storeCode, withText =>
      deps.call(
        'update_code_ref',
        conn => {
          const args = { id: same.id, startLine: fit.startLine, endLine: fit.endLine, blobSha, snippet: withText ? fit.text : '', status: 'ok' };
          return deps.followCodeRef !== false && conn.reducers.updateCodeRefAndFocus
            ? conn.reducers.updateCodeRefAndFocus(args)
            : conn.reducers.updateCodeRef(args);
        },
        budget.ms()
      )
    );
    return { id: same.id, path, startLine: fit.startLine, endLine: fit.endLine, clampedFrom: fit.clampedFrom, existing: true, moved: true };
  }

  let startLine: number;
  let endLine: number;
  if (input.startLine !== undefined || input.endLine !== undefined) {
    if (resolvable) {
      const s = input.startLine ?? input.endLine!;
      const e = input.endLine ?? s;
      const enclosing = enclosingDeclaration(src.abs, src.text, s, e);
      throw new Error(describeRangeRefusal(ext, path, s, e, enclosing, enclosing ? { names: [], rest: false } : declarationsTouching(src.abs, src.text, s, e)));
    }
    if (input.startLine === undefined || input.endLine === undefined) {
      throw new Error(`pass both startLine and endLine for ${path} (got startLine=${input.startLine}, endLine=${input.endLine})`);
    }
    startLine = input.startLine;
    endLine = input.endLine;
  } else {
    if (!resolvable) {
      throw new Error(describeResolveFailure({ ok: false, reason: 'unsupported_language', ext }, symbol, path));
    }
    const r = resolve(src.abs, src.text, symbol);
    if (!r.ok) throw new Error(describeResolveFailure(r, symbol, path));
    startLine = r.startLine;
    endLine = r.endLine;
  }

  const fit = fitWithNeedle(startLine, endLine);
  const blobSha = gitStep(() => git.hashObject(repoRoot, path, src.bytes, budget.ms()));

  await ensureRepoPath({ ...deps, budget, canonicalPath: () => path }, boardId, repoRoot, path);
  if (!budget.canWrite()) throw new Error(registeredButOutOfTime(path, 'the code ref'));

  const storeCode = await boardStoresCode(deps.call, boardId);
  const before = await deps.call('read code refs', async conn =>
    new Set([...conn.db.visibleCodeRef.iter()].filter(r => r.boardId === boardId).map(r => r.id))
  );
  const args = {
    boardId,
    targetKind: input.targetKind,
    targetId: input.targetId,
    path,
    symbol,
    startLine: fit.startLine,
    endLine: fit.endLine,
    blobSha,
    snippet: fit.text,
    author: input.author ?? '',
  };
  try {
    await writeCode(storeCode, withText => deps.call('add_code_ref', conn => conn.reducers.addCodeRef({ ...args, snippet: withText ? args.snippet : '' }), budget.ms()));
  } catch (err) {
    // The module refuses a second ref for the same identity; one that landed
    // after the pre-check (a concurrent or timed-out call) is the answer.
    if (!(err instanceof Error) || !err.message.startsWith('already attached id=')) throw err;
    const landed = await deps.call('read code refs', async conn => findSameRef(conn, boardId, args.targetKind, args.targetId, path, symbol));
    if (!landed) throw err;
    return asExisting(landed);
  }
  const id = await deps.call('find new code ref', async conn => {
    const created = [...conn.db.visibleCodeRef.iter()]
      .filter(
        r =>
          r.boardId === boardId &&
          !before.has(r.id) &&
          r.targetKind === args.targetKind &&
          r.targetId === args.targetId &&
          r.path === path &&
          r.symbol === symbol
      )
      .map(r => r.id)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    if (created.length === 0) throw new Error(`add_code_ref committed but the new row is not in the cache yet; re-read get_board for ${path}`);
    return created[created.length - 1];
  });
  if (!budget.canWrite()) throw new Error(hashesOutOfTime(id, path));
  await deps.call('set_code_ref_hashes', conn => conn.reducers.setCodeRefHashes({ refId: id, lineHashes: hashesOf(fit) }), budget.ms());

  return { id, path, startLine: fit.startLine, endLine: fit.endLine, clampedFrom: fit.clampedFrom, existing: false };
}

// ---------- mark_checkpoint ----------

export interface MarkCheckpointInput {
  boardId: bigint;
  exclude?: { reason: string; glob: string }[];
  /** Arrival commits progress and presence in the same transaction as this checkpoint. */
  arrival?: ArrivalCommit;
}

export interface ReanchorSummary {
  shifted: number;
  drifted: number;
  stale: string[];
  ambiguous: string[];
  /** refs and source citations that were stale or ambiguous and are ok again: no action needed (G24) */
  restored: string[];
}

export interface MarkCheckpointResult {
  checkpoint: number;
  headSha: string;
  coverage: Coverage;
  reanchor: ReanchorSummary;
  /** files git could not compare or diff in full, and what that meant for coverage (only when there are any) */
  notes?: string[];
  /** change note readers that still read a changed column, and changed migration files no note cites (only when there are any) */
  changeNotes?: { staleReaders: StaleReader[]; unconfirmed: string[] };
}

export type StaleReader = { note: string; ref: string; path: string; line: number };

/** What re-anchoring did to one ref or source citation at the coming checkpoint (G15). */
type RefOutcome = {
  /** the file's sha (or missing/unreadable) and the row as evaluation left it; see rowKey */
  key: string;
  label: string;
  kind: 'none' | 'shifted' | 'drifted' | 'stale' | 'ambiguous';
  restored: boolean;
};

/**
 * An unfinished mark_checkpoint (G15): the file shas and source indexes already computed, the
 * refs and source citations already evaluated (the next call skips and reports them),
 * and the diff hunks already read, per file sha. Valid for one session row
 * and checkpoint number; dropped once the checkpoint is recorded.
 */
export type CheckpointProgress = {
  sessionId: bigint;
  startedAt: bigint | undefined;
  checkpoint: number;
  refs: Map<bigint, RefOutcome>;
  edges: Map<bigint, RefOutcome>;
  /** line-hash indexes, the lines and raw-byte keys, reusable while the file's stat stamp is unchanged */
  sources: Map<string, { stamp: string; key: string; lines: Map<string, number>; text: string[] }>;
  /** hunks null: git could not print the diff (too large, too slow); reason says why */
  hunks: Map<string, { sha: string; hunks: Hunk[] | null; reason?: string }>;
  /** each ref file's sha, by its stat stamp: a file whose stamp is unchanged is not hashed again */
  shas: Map<string, { stamp: string; sha: string }>;
  /** git's answer for a stat-dirty candidate, by its lstat and the index's stamp */
  changed: Map<string, { key: string; changed: boolean; reason?: string }>;
};

/** Per board, in this (MCP server) process. */
export const checkpointProgress = new Map<bigint, CheckpointProgress>();

// A ref is skipped when its file and its row are what an earlier call left: a
// changed file (new sha), or a row someone else rewrote, is evaluated again.
const rowKey = (file: string, r: { blobSha: string; status: string; startLine: number; endLine: number }) =>
  `${file} ${r.blobSha} ${r.status} ${r.startLine}-${r.endLine}`;

export type ReanchorResult =
  | { ok: true; startLine: number; endLine: number; fit: ReturnType<typeof fitSnippet> }
  | { ok: false; reason: 'unsupported_language' | 'parse_error' | 'not_found' | 'ambiguous' | 'unfit' | 'no_needle' | 'snippet_lost' };

/**
 * Where a ref's symbol lives in the current text of its file, or why it cannot
 * be placed. The one decision mark_checkpoint applies and the eval re-checks,
 * so the two cannot drift (G22): resolve; on ambiguous, the single candidate
 * whose fitted lines still have the stored line hashes (the declaration the
 * ref was made for, only moved); then fitSnippet and the symbolNeedle rule.
 * startLine/endLine are the fitted range, as stored. unfit: the range cannot
 * become a snippet (e.g. one line over the cap); no_needle: the module would
 * reject the snippet.
 * A file the resolver cannot read follows its captured lines instead (G4):
 * the run of lines whose hashes are the stored ones, found exactly once, is
 * the ref's new range; found never or more than once, it is snippet_lost.
 * oldHashes empty: the board keeps no code for the ref (RC-690), so only the
 * resolver can place it.
 */
export function reanchor(
  path: string,
  abs: string,
  text: string,
  lines: string[],
  symbol: string,
  oldHashes: string[],
  resolve: (absPath: string, source: string, symbol: string) => ResolveResult = resolveSymbolDefault
): ReanchorResult {
  if (!RESOLVABLE_EXTENSIONS.includes(extname(path).toLowerCase())) {
    const n = oldHashes.length;
    const hashes = n > 0 ? lineHashes(lines) : [];
    const found: number[] = [];
    for (let i = 0; n > 0 && i + n <= lines.length && found.length < 2; i++) {
      if (oldHashes.every((h, k) => hashes[i + k] === h)) found.push(i);
    }
    if (found.length !== 1) return { ok: false, reason: 'snippet_lost' };
    const startLine = found[0] + 1;
    const endLine = found[0] + n;
    return { ok: true, startLine, endLine, fit: { startLine, endLine, text: lines.slice(found[0], endLine).join('\n'), clampedFrom: undefined } };
  }
  let r = resolve(abs, text, symbol);
  if (!r.ok && r.reason === 'ambiguous') {
    const want = oldHashes.join(' ');
    const same = r.candidates.filter(c => {
      try {
        const fit = fitSnippet(path, lines, c.startLine, c.endLine);
        return joinedHashes(lines.slice(fit.startLine - 1, fit.endLine)) === want;
      } catch {
        return false;
      }
    });
    if (same.length === 1) r = { ok: true, startLine: same[0].startLine, endLine: same[0].endLine, kind: same[0].kind, name: same[0].name };
  }
  if (!r.ok) return { ok: false, reason: r.reason };
  let fit: ReturnType<typeof fitSnippet>;
  try {
    fit = fitSnippet(path, lines, r.startLine, r.endLine);
  } catch {
    return { ok: false, reason: 'unfit' };
  }
  if (!fit.text.includes(symbolNeedle(symbol))) return { ok: false, reason: 'no_needle' };
  return { ok: true, startLine: fit.startLine, endLine: fit.endLine, fit };
}

export async function markCheckpointFlow(input: MarkCheckpointInput, deps: SessionDeps): Promise<MarkCheckpointResult> {
  const { git, readSource } = deps;
  const resolve = deps.resolveSymbol ?? resolveSymbolDefault;
  const budget = flowBudget(deps.now ?? Date.now);
  const { boardId } = input;

  // Session row plus the refs whose target node/edge still exists. Orphans
  // (target deleted, cascade not yet visible) are neither re-anchored nor
  // counted for coverage.
  const readState = (conn: SessionConn) => {
    const session = [...conn.db.visibleSession.iter()].find(s => s.boardId === boardId);
    if (!session) throw new Error(`board ${boardId} has no session; call start_session first`);
    const nodeIds = new Set([...conn.db.visibleNode.iter()].filter(n => n.boardId === boardId).map(n => n.id));
    const edges = [...conn.db.visibleEdge.iter()].filter(e => e.boardId === boardId);
    const edgeIds = new Set(edges.map(e => e.id));
    const refs = [...conn.db.visibleCodeRef.iter()].filter(
      r =>
        r.boardId === boardId &&
        (r.targetKind === 'node' ? nodeIds.has(r.targetId) : r.targetKind === 'edge' ? edgeIds.has(r.targetId) : false)
    );
    const sourceEdges = edges.filter(e => e.evidence?.startsWith('source:'));
    // RC-690: what each ref and citation keeps of its code when the board keeps no text
    const refHashes = new Map([...conn.db.visibleCodeRefHash.iter()].filter(h => h.boardId === boardId).map(h => [h.refId, h.lineHashes]));
    const edgeHashes = new Map([...conn.db.visibleEdgeEvidenceHash.iter()].filter(h => h.boardId === boardId).map(h => [h.edgeId, h.lineHash]));
    return { session, refs, sourceEdges, refHashes, edgeHashes };
  };

  const state = await deps.call('read session', async conn => readState(conn));
  if (input.arrival && state.session.checkpoint !== input.arrival.expectedCheckpoint) {
    throw new Error('session checkpoint changed; read get_board and call arrive again');
  }
  // Text goes in only where the board keeps it; a refusal mid-flow turns it off for the rest.
  let storeCode = await boardStoresCode(deps.call, boardId);
  const root = state.session.repoRoot;
  const baseSha = state.session.baseSha;
  const cited = [...new Set([...state.refs.map(r => r.path), ...state.sourceEdges.flatMap(e => sourceCitation(e.evidence!)?.path ?? [])])];
  deps.need?.(root, cited);

  // An earlier call that stopped at the budget left its progress here (G15).
  const store = deps.progress ?? checkpointProgress;
  let progress = store.get(boardId);
  const startedAt = state.session.startedAt?.microsSinceUnixEpoch;
  if (!progress || progress.sessionId !== state.session.id || progress.startedAt !== startedAt || progress.checkpoint !== state.session.checkpoint) {
    progress = { sessionId: state.session.id, startedAt, checkpoint: state.session.checkpoint, refs: new Map(), edges: new Map(), sources: new Map(), hunks: new Map(), shas: new Map(), changed: new Map() };
    store.set(boardId, progress);
  }

  // 1. Re-anchor (spec §3.3): blob unchanged -> untouched; file deleted -> stale;
  //    not_found or unfittable range -> stale; ambiguous -> ambiguous unless exactly one
  //    candidate still holds the stored snippet verbatim (then shifted); parse_error (TS/JS)
  //    -> untouched, retried next checkpoint. Other files follow their captured lines when
  //    they occur exactly once (shifted), else stale (G4).
  //    Ref files are hashed in chunks, kept by stat stamp. Source-only files
  //    are read as their citations are evaluated, within the same budget.
  const stampOf = deps.stamp;
  // Any board writer can register a path: only a file git would list, and no
  // secrets file, is read, so an ignored file's lines never reach the board.
  const listed = git.listed && new Set(git.listed(root, cited, budget.ms()));
  // Unreadable code refs stay untouched; evidence cannot be verified and becomes stale.
  const read = (path: string): SourceFile | 'missing' | 'unreadable' => {
    if (isSecretFile(path) || (listed && !listed.has(path))) {
      // not read; one gone from disk (an untracked file deleted) still goes stale
      return listed && stampOf(root, path) === undefined ? 'missing' : 'unreadable';
    }
    try {
      return readSource(root, path);
    } catch (err) {
      return err instanceof MissingFileError ? 'missing' : 'unreadable';
    }
  };
  const files = new Map<string, SourceFile | 'missing' | 'unreadable'>();
  const refPaths = [...new Set(state.refs.map(r => r.path))];
  for (const path of refPaths) files.set(path, read(path));
  const readable = refPaths.filter(p => typeof files.get(p) !== 'string');
  const n = state.refs.length;
  const AGAIN = 'call again to continue (no checkpoint is recorded until a call completes)';

  // A file whose stat stamp is unchanged since an earlier call keeps its sha;
  // the rest are hashed in chunks, with the budget checked between chunks, so
  // a slow clean filter spreads the work over calls instead of timing out.
  const shaOf = new Map<string, string>();
  const need: string[] = [];
  for (const p of readable) {
    const kept = progress.shas.get(p);
    const { stamp } = files.get(p) as SourceFile;
    if (kept && stamp !== undefined && kept.stamp === stamp) shaOf.set(p, kept.sha);
    else need.push(p);
  }
  const hashStop = () => new Error(`hashed ${shaOf.size} of ${readable.length} ref files; ${AGAIN}`);
  // The batch hash reads the disk again. A file rewritten after its text was
  // read must not get the new sha next to the old text (the next checkpoint
  // would take it as current), so a file whose bytes changed meanwhile, or a
  // batch that fails (a file deleted meanwhile, a slow filter), is hashed from
  // what was read, one file at a time.
  const sameOnDisk = (p: string, src: SourceFile) => {
    try {
      return readSource(root, p).bytes.equals(src.bytes);
    } catch {
      return false;
    }
  };
  for (let i = 0; i < need.length; i += HASH_CHUNK) {
    if (i > 0 && budget.over()) throw hashStop();
    const chunk = need.slice(i, i + HASH_CHUNK);
    let hashes: string[] | undefined;
    try {
      hashes = git.hashFiles(root, chunk, budget.ms());
    } catch {
      hashes = undefined;
    }
    for (const [k, p] of chunk.entries()) {
      const src = files.get(p) as SourceFile;
      const batch = hashes !== undefined && sameOnDisk(p, src);
      if (!batch && i + k > 0 && budget.over()) throw hashStop();
      const sha = batch ? hashes![k] : git.hashObject(root, p, src.bytes, budget.ms());
      shaOf.set(p, sha);
      // the stamp was stable while src.bytes were read, and sha is theirs
      if (src.stamp !== undefined) progress.shas.set(p, { stamp: src.stamp, sha });
    }
  }

  const refStop = () => {
    const done = state.refs.filter(r => progress.refs.has(r.id)).length;
    return new Error(`re-anchored ${done} of ${n} refs; ${AGAIN}`);
  };
  const update = async (row: { id: bigint; startLine: number; endLine: number; blobSha: string; snippet: string; status: string }) => {
    if (!budget.canWrite()) throw refStop(); // this ref is not recorded: the next call evaluates it again
    storeCode = await writeCode(storeCode, withText =>
      deps.call('update_code_ref', conn => conn.reducers.updateCodeRef({ ...row, snippet: withText ? row.snippet : '' }), budget.ms())
    );
  };
  // Written before the ref's lines: a stop in between leaves hashes for the
  // lines the ref is moving to, which the next call follows, never hashes for
  // lines it has left.
  const setHashes = async (refId: bigint, lines: string[]) => {
    const hashes = joinedHashes(lines);
    if (state.refHashes.get(refId) === hashes) return;
    if (!budget.canWrite()) throw refStop();
    await deps.call('set_code_ref_hashes', conn => conn.reducers.setCodeRefHashes({ refId, lineHashes: hashes }), budget.ms());
  };

  // One ref against its file's current state; returns what it did and the row it left.
  const evaluate = async (ref: CodeRefRow, src: SourceFile | 'missing' | 'unreadable', sha: string | undefined) => {
    const left = { blobSha: ref.blobSha, status: ref.status, startLine: ref.startLine, endLine: ref.endLine };
    // A ref already in `status` is not rewritten (G15); it is still listed.
    const flag = async (status: 'stale' | 'ambiguous') => {
      if (ref.status !== status) await update({ ...left, id: ref.id, snippet: ref.snippet, status });
      return { kind: status, restored: false, left: { ...left, status } };
    };
    if (src === 'missing') return flag('stale');
    if (src === 'unreadable' || sha === undefined) return { kind: 'none' as const, restored: false, left };
    if (sha === ref.blobSha) {
      // The original file may have returned after a deletion or an ambiguous
      // edit. Its cached range is valid again, including for non-TS refs.
      // Fill in what the ref lacks (RC-690): its hashes, and its text where
      // the board keeps code. Text added while the board kept none was never
      // checked: one that looks like a secret stays out, or every checkpoint
      // would be refused on it.
      const now = rangeLines(src.lines, ref);
      const fill = storeCode && ref.snippet === '' && now ? now.join('\n') : undefined;
      const text = fill !== undefined && !secretCheck(ref.path, fill, ref.startLine) ? fill : ref.snippet;
      const restored = ref.status !== 'ok';
      if (now) await setHashes(ref.id, now);
      if (restored || text !== ref.snippet) await update({ ...left, id: ref.id, snippet: text, status: 'ok' });
      return { kind: 'none' as const, restored, left: { ...left, status: 'ok' } };
    }
    // The stored hashes, else those of legacy text; none: only the resolver can place it.
    const old = state.refHashes.get(ref.id) ?? (ref.snippet === '' ? '' : joinedHashes(ref.snippet.split('\n')));
    const r = reanchor(ref.path, src.abs, src.text, src.lines, ref.symbol, old === '' ? [] : old.split(' '), resolve);
    if (!r.ok) {
      if (r.reason === 'ambiguous') return flag('ambiguous');
      // not_found, a range that cannot become a snippet, one the module would
      // reject, or non-TS/JS lines that no longer occur exactly once (G4)
      if (r.reason === 'not_found' || r.reason === 'unfit' || r.reason === 'no_needle' || r.reason === 'snippet_lost') return flag('stale');
      return { kind: 'none' as const, restored: false, left }; // parse_error (TS/JS only): retried next checkpoint
    }
    const { fit } = r;
    const now = src.lines.slice(fit.startLine - 1, fit.endLine);
    // Decided before the write, on hashes read before it: a cache row object
    // may be updated in place.
    const kind = joinedHashes(now) === old ? ('shifted' as const) : ('drifted' as const);
    const restored = ref.status !== 'ok';
    const row = { id: ref.id, startLine: fit.startLine, endLine: fit.endLine, blobSha: sha, snippet: fit.text, status: 'ok' };
    await setHashes(ref.id, now);
    await update(row);
    return { kind, restored, left: row };
  };

  let fresh = 0; // refs evaluated by this call
  for (const ref of state.refs) {
    const src = files.get(ref.path)!;
    const sha = shaOf.get(ref.path);
    const file = typeof src === 'string' ? src : sha!;
    if (progress.refs.get(ref.id)?.key === rowKey(file, ref)) continue; // done by an earlier call
    if (fresh > 0 && budget.over()) throw refStop();
    fresh += 1;
    const label = `${ref.symbol} ${ref.path} id=${ref.id}`;
    const o = await evaluate(ref, src, sha);
    progress.refs.set(ref.id, { key: rowKey(file, o.left), label, kind: o.kind, restored: o.restored });
  }

  // Source evidence follows one exact captured line in every language, by its
  // hash (RC-690). It never captures the current line as a replacement for a
  // missing baseline.
  const sourceFiles = new Map<string, { key: string; lines: Map<string, number>; text: string[] }>();
  const sourceFile = (path: string) => {
    const seen = sourceFiles.get(path);
    if (seen) return seen;
    // Shared ref bytes belong to this call's read snapshot. Only source-only
    // reads can reuse an earlier index whose stamp still matches the disk.
    const shared = files.get(path);
    const stamp = shared === undefined ? stampOf(root, path) : undefined;
    const kept = progress.sources.get(path);
    if (kept && stamp !== undefined && kept.stamp === stamp) {
      sourceFiles.set(path, kept);
      return kept;
    }
    const src = shared ?? read(path);
    // Clean filters can preserve a git blob sha while raw lines move. Key
    // decisions on the bytes read, rather than a later state of the file.
    const key = typeof src === 'string' ? src : createHash('sha256').update(src.bytes).digest('hex');
    // line hash -> its line, 0 when it occurs more than once
    const lines = new Map<string, number>();
    if (typeof src !== 'string') {
      for (const [i, text] of src.lines.entries()) {
        const h = lineHash(text);
        lines.set(h, lines.has(h) ? 0 : i + 1);
      }
    }
    const result = { key, lines, text: typeof src === 'string' ? [] : src.lines };
    sourceFiles.set(path, result);
    if (stamp !== undefined && stampOf(root, path) === stamp) progress.sources.set(path, { stamp, ...result });
    else progress.sources.delete(path);
    return result;
  };
  const edgeKey = (file: string, edge: SessionEdgeRow) =>
    JSON.stringify([file, edge.evidence, edge.evidenceSnippet ?? '', edge.evidenceStatus ?? '']);
  const edgeStop = () => {
    const done = state.sourceEdges.filter(e => progress.edges.has(e.id)).length;
    return new Error(`re-anchored ${done} of ${state.sourceEdges.length} source citations; ${AGAIN}`);
  };
  for (const edge of state.sourceEdges) {
    if (budget.over()) throw edgeStop();
    const evidence = edge.evidence!;
    const citation = sourceCitation(evidence);
    const src = citation ? sourceFile(citation.path) : undefined;
    const file = src?.key ?? 'invalid';
    if (progress.edges.get(edge.id)?.key === edgeKey(file, edge)) continue;
    const snippet = edge.evidenceSnippet ?? '';
    const oldStatus = edge.evidenceStatus ?? '';
    const stored = state.edgeHashes.get(edge.id);
    const want = stored ?? (snippet.trim() ? lineHash(snippet) : undefined);
    const line = want === undefined ? undefined : src?.lines.get(want) || undefined;
    const status = line === undefined ? 'stale' : 'ok';
    const current = line === undefined ? evidence : `source:${citation!.path}:${line}`;
    const kind = status === 'stale' ? 'stale' : current !== evidence ? 'shifted' : 'none';
    const restored = status === 'ok' && oldStatus !== 'ok';
    // Fill in what the citation lacks (RC-690): its hash, and its line where
    // the board keeps code (never a line that looks like a secret). Before the
    // move, which an ok citation without its line needs on such a board.
    const text = line !== undefined && storeCode && snippet === '' ? src!.text[line - 1] : undefined;
    const fill = text !== undefined && !secretCheck(citation!.path, text, line!) ? text : undefined;
    if (line !== undefined && (stored === undefined || fill !== undefined)) {
      if (!budget.canWrite()) throw edgeStop();
      await writeCode(fill !== undefined, withText =>
        deps.call('set_edge_evidence_code', conn => conn.reducers.setEdgeEvidenceCode({ edgeId: edge.id, lineHash: want!, snippet: withText ? fill : undefined }), budget.ms())
      );
    }
    if (current !== evidence || status !== oldStatus) {
      if (!budget.canWrite()) throw edgeStop();
      await deps.call('update_edge_evidence', conn => conn.reducers.updateEdgeEvidence({ edgeId: edge.id, evidence: current, status }), budget.ms());
    }
    progress.edges.set(edge.id, {
      key: edgeKey(file, { ...edge, evidence: current, evidenceStatus: status }),
      label: `edge ${edge.id} ${current}`,
      kind,
      restored,
    });
  }

  // The summary covers every call since the last checkpoint, in ref then edge order.
  const summary: ReanchorSummary = { shifted: 0, drifted: 0, stale: [], ambiguous: [], restored: [] };
  for (const ref of state.refs) {
    const o = progress.refs.get(ref.id);
    if (!o) continue;
    if (o.kind === 'shifted' || o.kind === 'drifted') summary[o.kind] += 1;
    else if (o.kind === 'stale' || o.kind === 'ambiguous') summary[o.kind].push(o.label);
    if (o.restored) summary.restored.push(o.label);
  }
  for (const edge of state.sourceEdges) {
    const o = progress.edges.get(edge.id);
    if (!o) continue;
    if (o.kind === 'shifted') summary.shifted += 1;
    if (o.kind === 'stale') summary.stale.push(o.label);
    if (o.restored) summary.restored.push(o.label);
  }

  // 2. Coverage over the re-anchored, live refs (Decision 10). Only ok refs
  //    count: a stale or ambiguous ref is one the board itself flags as wrong,
  //    so it must not clear the debt for the hunk it used to sit on (F16).
  //    Hunks are kept per file sha, so a call that stopped here resumes.
  const { live, notes: changeNotes, refRows } = await deps.call('read code refs', async conn => {
    const refs = readState(conn).refs;
    return {
      live: refs.filter(r => r.status === 'ok').map(r => ({ path: r.path, startLine: r.startLine, endLine: r.endLine })),
      notes: [...conn.db.visibleChangeNote.iter()].filter(cn => cn.boardId === boardId),
      refRows: new Map(refs.map(r => [r.id.toString(), r])),
    };
  });
  const listing = () => {
    if (budget.over()) throw new Error(`re-anchored all ${n} refs; coverage stopped while listing the changed files; ${AGAIN}`);
  };
  listing();
  const candidates = git.changeCandidates(root, baseSha, budget.ms());
  listing();
  const deleted = git.deleted(root, baseSha, budget.ms());
  listing();
  const untracked = git.untracked(root, budget.ms());

  // A candidate whose stat changed since it was indexed may hold the base
  // content again (a touch, an undo, a checkout). Only git can tell for every
  // case (eol rules, filters, symlinks, submodules), so git confirms them one
  // file at a time within the budget (--name-only: no diff is printed), on a
  // copy of the index it cannot rewrite. An answer is kept until the file's
  // lstat or the index changes.
  const unsure = candidates.filter(c => !c.sure).map(c => c.path);
  const verdict = new Map<string, { changed: boolean; reason?: string }>();
  const notes: string[] = []; // files git could not compare or diff: said in the result
  const indexStamp = unsure.length > 0 ? stampOf(root, git.indexPath(root, budget.ms())) : undefined;
  const keyOf = (p: string) => {
    const stamp = stampOf(root, p);
    return stamp === undefined || indexStamp === undefined ? undefined : `${stamp} ${indexStamp}`;
  };
  const check: { path: string; key: string | undefined }[] = [];
  for (const p of unsure) {
    const kept = progress.changed.get(p);
    const key = keyOf(p);
    if (kept && key !== undefined && kept.key === key) verdict.set(p, { changed: kept.changed, reason: kept.reason });
    else check.push({ path: p, key });
  }
  if (check.length > 0) {
    if (budget.over()) throw new Error(`re-anchored all ${n} refs; coverage stopped while checking changed files (${verdict.size} of ${unsure.length} checked); ${AGAIN}`);
    const answers = git.confirmChanged(root, baseSha, check.map(c => c.path), budget.ms(), () => !budget.over());
    for (const { path, key } of check) {
      const answer = answers.get(path);
      if (answer === undefined) continue; // not answered: the budget ran out
      verdict.set(path, answer);
      if (key !== undefined && keyOf(path) === key) progress.changed.set(path, { key, ...answer });
    }
    if (verdict.size < unsure.length) {
      throw new Error(`re-anchored all ${n} refs; coverage stopped while checking changed files (${verdict.size} of ${unsure.length} checked); ${AGAIN}`);
    }
  }
  for (const [p, v] of verdict) if (v.reason) notes.push(`${p}: ${v.reason}; counted as changed`);
  const changed = candidates.filter(c => c.sure || verdict.get(c.path)?.changed === true).map(c => c.path);
  const all = [...new Set([...changed, ...untracked])];
  const meter = { left: MAX_GLOB_STEPS }; // the caller picks the globs, and (hosted) the paths
  const coverage = computeCoverage({
    changed,
    deleted,
    untracked,
    refs: live,
    // Only changed files with refs reach here. A diff git cannot print (too
    // large for the output limit, or slower than git's own timeout) leaves the
    // file's changed lines unknown: no ref can be shown to touch them, so it
    // counts as uncovered, with the reason, and the checkpoint goes on.
    hunksFor: p => {
      const stop = () => new Error(`re-anchored all ${n} refs; coverage stopped at ${all.indexOf(p)} of ${all.length} changed files; ${AGAIN}`);
      const unknown = (reason: string) => notes.push(`${p}: ${reason}; its changed lines are unknown, so it counts as uncovered`);
      const sha = shaOf.get(p);
      const kept = progress.hunks.get(p);
      if (kept && kept.sha === sha) {
        if (kept.reason) unknown(kept.reason);
        return kept.hunks ?? [];
      }
      if (budget.over()) throw stop();
      let hunks: Hunk[] | null;
      let reason: string | undefined;
      try {
        hunks = git.hunks(root, baseSha, p, budget.ms());
      } catch (err) {
        if (err instanceof GitTimeoutError && err.limited) throw stop(); // the budget, not the file: a later call
        if (!(err instanceof GitOutputTooLargeError || err instanceof GitTimeoutError)) throw err;
        hunks = null;
        reason = err.detail;
        unknown(reason);
      }
      if (sha !== undefined) progress.hunks.set(p, { sha, hunks, reason });
      return hunks ?? [];
    },
    exclude: input.exclude ?? [],
    meter,
  });

  // 3. Change notes (spec 2026-10-16): each reader judged on the re-anchored
  //    rows and the text already read (D4, no extra reads), and changed
  //    migration files that no note cites (D2). Recomputed on every call and
  //    written only when a value changed, so a call that stops here resumes.
  const staleReaders: StaleReader[] = [];
  const noteWrites: { id: bigint; readers: string; refFileSha: string }[] = [];
  const fileText = (path: string) => {
    const f = files.get(path);
    return f === undefined ? 'unreadable' : typeof f === 'string' ? f : f.text;
  };
  // A ref's lines as they are now, cut from the file read above (RC-690); its
  // stored text when its range is not that file's (a parse_error kept it).
  const refText = (ref: CodeRefRow) => {
    const f = files.get(ref.path);
    const now = f !== undefined && typeof f !== 'string' && shaOf.get(ref.path) === ref.blobSha ? rangeLines(f.lines, ref) : undefined;
    return now ? now.join('\n') : ref.snippet;
  };
  for (const cn of changeNotes) {
    const subjects = safeList(() => parseSubjects(cn.subjects));
    const readers = safeList(() => parseReaders(cn.readers));
    const next = readers.map((r): Reader => {
      if (r.removed) return r;
      const ref = refRows.get(r.refId);
      const subject = subjects[r.subject];
      const text = ref ? refText(ref) : '';
      // An ok ref with no text to judge is judged by its whole file, like a stale one: never a false 'updated'.
      const status = ref && subject ? readerStatus(ref.status === 'ok' && text === '' ? 'stale' : ref.status, text, fileText(ref.path), termsOf(subject)) : 'unknown';
      if (ref && subject && status === 'stale') staleReaders.push({ note: cn.id.toString(), ref: r.refId, path: ref.path, line: termLine(ref.startLine, text, termsOf(subject)) });
      return status === r.status ? r : { ...r, status, checkpoint: state.session.checkpoint + 1 };
    });
    const main = refRows.get(cn.refId.toString());
    const refFileSha = (main && shaOf.get(main.path)) ?? cn.refFileSha;
    if (refFileSha !== cn.refFileSha || next.some((r, i) => r !== readers[i])) noteWrites.push({ id: cn.id, readers: JSON.stringify(next), refFileSha });
  }
  for (const w of noteWrites) {
    if (budget.over() || !budget.canWrite()) throw new Error(`re-anchored all ${n} refs and covered all ${all.length} changed files; change notes stopped; ${AGAIN}`);
    await deps.call('set_change_note_readers', conn => conn.reducers.setChangeNoteReaders(w), budget.ms());
  }
  const noted = new Set(changeNotes.flatMap(cn => refRows.get(cn.refId.toString())?.path ?? []));
  // A migration the agent excluded on purpose (an additive one, say) is answered, not unconfirmed.
  const excluded = (input.exclude ?? []).map(g => globToRegExp(g.glob, meter));
  const unconfirmed = all.filter(p => isMigrationPath(p) && !noted.has(p) && !excluded.some(re => re.test(p)));
  const recorded: Coverage = unconfirmed.length > 0 ? { ...coverage, unconfirmed } : coverage;

  // 4. The checkpoint is the last write.
  if (budget.over() || !budget.canWrite()) {
    throw new Error(`re-anchored all ${n} refs and covered all ${all.length} changed files; call again to record the checkpoint (no checkpoint is recorded until a call completes)`);
  }
  const headSha = git.head(root, budget.ms());
  const checkpointArgs = { boardId, headSha, coverage: JSON.stringify(recorded) };
  if (input.arrival) {
    await deps.call('arrive', conn => conn.reducers.arriveAtCheckpoint({ ...checkpointArgs, ...input.arrival! }), budget.ms());
  } else {
    await deps.call('mark_checkpoint', conn => conn.reducers.markCheckpoint(checkpointArgs), budget.ms());
  }
  store.delete(boardId);
  const checkpoint = await deps.call('read checkpoint', async conn => {
    if (input.arrival) {
      const event = [...conn.db.visibleRouteEvent.iter()].find(e => e.boardId === boardId && e.kind === 'arrive' && e.nodeId === input.arrival!.nodeId);
      if (event) return event.checkpoint;
    }
    return readState(conn).session.checkpoint;
  });

  return {
    checkpoint,
    headSha,
    coverage: recorded,
    reanchor: summary,
    ...(notes.length > 0 ? { notes } : {}),
    ...(staleReaders.length + unconfirmed.length > 0 ? { changeNotes: { staleReaders, unconfirmed } } : {}),
  };
}

/** A list column that fails to parse reads as empty: a bad row never blocks the checkpoint. */
function safeList<T>(parse: () => T[]): T[] {
  try {
    return parse();
  } catch {
    return [];
  }
}

/** The first line of a ref's text that names a term (the line a reviewer needs), else its first line. */
function termLine(startLine: number, text: string, terms: string[]): number {
  const i = text.split('\n').findIndex(l => hasTerm(l, terms));
  return startLine + Math.max(i, 0);
}

/** A ref's stored range in `lines`; undefined when the file is shorter than the range. */
function rangeLines(lines: string[], ref: { startLine: number; endLine: number }): string[] | undefined {
  return ref.endLine <= lines.length ? lines.slice(ref.startLine - 1, ref.endLine) : undefined;
}
