/**
 * The capture protocol (spec §5): what the local helper uploads to
 * `POST /facts`, and the checks a tool call runs when it claims a capture.
 * Zero dependencies and no Node API (WebCrypto, atob, TextEncoder only), so
 * the helper on Node 20+ and the Worker on workerd share one copy. Every
 * refusal is the exact §12 Failure-copy text.
 */

export const CAPTURE_VERSION = 1;
/** The oldest helper whose captures a claim accepts. */
export const MIN_HELPER_VERSION = '1.0.0';
export const CAPTURE_ID_RE = /^cap_[A-Za-z0-9]{22}$/;
export const MB = 1_048_576;
export const MAX_FILE_BYTES = MB;
export const MAX_BODY_BYTES = 8 * MB;
export const MAX_LIST_PATHS = 20_000;
/** A NUL byte this early marks a binary file (readSource's rule). */
export const BINARY_SNIFF_BYTES = 8192;
/** Matched against a path's last segment, ignoring case; the helper never reads these. */
export const SECRET_FILES = ['.env*', '*.env', '*.pem', '*.key', 'id_rsa*', 'id_dsa*', 'id_ecdsa*', 'id_ed25519*', '*.p12', '*.pfx', '.npmrc', '.netrc'] as const;

export type CaptureKind = 'start' | 'ref' | 'cite' | 'checkpoint';
export type ObjectFormat = 'sha1' | 'sha256';

/** One file: its path in git's spelling, its bytes in base64, git's blob sha (`hash-object --path`) and its citability. */
export type WireFile = { path: string; bytes: string; sha: string; citable: boolean };
/** A cited file a checkpoint holds no bytes for: gone from disk, or refused by the helper (binary, too large, ignored). */
export type AbsentFile = { path: string; missing: true } | { path: string; unreadable: true };

type Head = {
  v: typeof CAPTURE_VERSION;
  helper: string;
  /** the checkout's absolute top level, symlinks resolved */
  toplevel: string;
  objectFormat: ObjectFormat;
  /** HEAD, or the empty-tree sha in a repo with no commits */
  head: string;
  /** the github.com origin as https without credentials (one line, at most 2048 characters); absent for any other remote. Helpers before 1.0.2 send none. */
  remote?: string;
};
export type StartBody = Head & { kind: 'start' };
/** ref and cite: `asked` is the path as the call names it; `file.path` is git's spelling of it. */
export type FileBody = Head & { kind: 'ref' | 'cite'; asked: string; file: WireFile };
export type CheckpointBody = Head & {
  kind: 'checkpoint';
  base: string;
  /** tracked paths whose content differs from base (`diff-index --raw --no-renames`, stat-only candidates confirmed), in git's order */
  changed: string[];
  /** changed paths git could not compare in time, with git's reason: counted as changed */
  uncompared: Record<string, string>;
  untracked: string[];
  deleted: string[];
  /** new-side line ranges (`diff -U0`) of each uploaded changed file, or why git could not print its diff */
  hunks: Record<string, [number, number][] | string>;
  /** every path in cited/<board> and --also */
  files: (WireFile | AbsentFile)[];
  /** HEAD is an ancestor of its upstream, by the local remote-tracking refs */
  pushed?: boolean;
  /** the paths of `files` whose working copy differs from HEAD (edited, deleted or untracked) */
  dirty?: string[];
};
export type CaptureBody = StartBody | FileBody | CheckpointBody;

/** A file after its claim checks: decoded bytes whose git sha is verified. */
export type ClaimedFile = { path: string; bytes: Uint8Array; sha: string; citable: boolean };
export type ClaimedCapture =
  | StartBody
  | (Omit<FileBody, 'file'> & { file: ClaimedFile })
  | (Omit<CheckpointBody, 'files' | 'uncompared' | 'hunks'> & {
      files: (ClaimedFile | AbsentFile)[];
      uncompared: Map<string, string>;
      hunks: Map<string, [number, number][] | string>;
    });

/** A refusal whose message is the full tool text, REJECTED prefix included: pass it on verbatim. */
export class CaptureRejection extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CaptureRejection';
  }
}

// ---------- texts ----------

export const mb = (bytes: number) => (bytes / MB).toFixed(1);
const count = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const sha7 = (sha: string) => sha.slice(0, 7);
// The commands in the texts are pasted into a shell.
const shellArg = (s: string) => (/^[A-Za-z0-9_./@%+=:,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

export const rejectText = {
  madeFor: (id: string, madeFor: string, call: string) =>
    `REJECTED: capture ${id} was made for ${madeFor}, not ${call}. Nothing was written. Run the capture for this call and pass the new id.`,
  anotherCheckout: (from: string, board: string, tracks: string) =>
    `REJECTED: this capture comes from ${from}, but board "${board}" tracks ${tracks}. Nothing was written. Run the agent in ${tracks}, or call start_session with a new name.`,
  anotherBase: (base: string, board: string, boardId: string, baseSha: string) =>
    `REJECTED: this capture compares against ${sha7(base)}, but board "${board}" started at ${sha7(baseSha)}. Nothing was written. Run \`npx -y @redcrayonai/draw@1 capture checkpoint --board ${boardId} --base ${baseSha}\` and pass the new id.`,
  citedMissing: (paths: string[], boardId: string, baseSha: string) =>
    `REJECTED: the checkpoint needs these cited files: ${paths.join(', ')}. Nothing was written. Run \`npx -y @redcrayonai/draw@1 capture checkpoint --board ${boardId} --base ${baseSha} --also ${paths.map(shellArg).join(' ')}\` and pass the new id.`,
  oldHelper: (version: string) =>
    `REJECTED: this capture comes from an older redcrayon helper (${version}). Nothing was written. Update it with /plugin update draw or npx -y @redcrayonai/draw@1, then call again.`,
  filtered: (path: string) =>
    `REJECTED: ${path} is stored through a git filter such as LFS, so its bytes cannot be checked. Nothing was written. Cite another file.`,
  tooLarge: (path: string, bytes: number) =>
    `REJECTED: ${path} is ${mb(bytes)} MB; code refs cite files up to 1 MB. Nothing was written. Cite a smaller file.`,
  listTooLong: (n: number, what: string) =>
    `REJECTED: the checkpoint lists ${count(n)} ${what} paths; the limit is ${count(MAX_LIST_PATHS)}. Nothing was written. Commit or ignore generated output, then call again.`,
  secret: (path: string, line: number, kind: string) =>
    `REJECTED: ${path}:${line} looks like a secret (${kind}). Nothing was written. Cite lines without secrets.`,
  // Not in the §12 table: only a helper other than ours uploads these.
  binary: (path: string) => `REJECTED: ${path} is a binary file; code refs cite text. Nothing was written. Cite another file.`,
  secretFile: (path: string) => `REJECTED: ${path} looks like a secrets file; code refs never read it. Nothing was written. Cite another file.`,
  malformed: (id: string, problem: string) =>
    `REJECTED: capture ${id} is not a capture redcrayon can read (${problem}). Nothing was written. Run the capture again and pass the new id.`,
};

// ---------- ids, paths, secrets ----------

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** cap_ and 22 base62 characters: 131 bits from crypto.getRandomValues. */
export function newCaptureId(): string {
  let id = '';
  while (id.length < 22) {
    for (const b of crypto.getRandomValues(new Uint8Array(32))) {
      // 248 = 4 × 62: dropping 248..255 keeps every character equally likely
      if (b < 248 && id.length < 22) id += BASE62[b % 62];
    }
  }
  return `cap_${id}`;
}

const SECRET_FILE_RES = SECRET_FILES.map(g => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i'));

export function isSecretFile(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return SECRET_FILE_RES.some(re => re.test(name));
}

/** Why `p` is not a repo-relative POSIX path, or undefined when it is one. */
export function pathProblem(p: unknown): string | undefined {
  if (typeof p !== 'string' || p === '') return 'an empty path';
  if (p.length > 4096) return 'a path over 4096 characters';
  if (/[\x00-\x1f\x7f]/.test(p)) return 'a control character in a path';
  if (p.startsWith('/')) return 'an absolute path';
  if (p.split('/').some(s => s === '' || s === '.' || s === '..')) return 'an empty, . or .. segment in a path';
  return undefined;
}

const SECRETS: [kind: string, re: RegExp][] = [
  ['Redcrayon API key', /\brcak_[0-9a-f]{32}_[0-9a-f]{64}\b/],
  ['private key', /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/],
  ['AWS access key', /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/],
  ['GCP API key', /\bAIza[0-9A-Za-z_-]{35}/],
  ['GCP OAuth client secret', /\bGOCSPX-[0-9A-Za-z_-]{28}/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,})/],
  ['Slack token', /\bxox[abposr]-[A-Za-z0-9-]{10,}/],
  ['Slack webhook', /hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/],
  ['Stripe secret key', /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/],
  // before OpenAI's, whose pattern also matches it
  ['Anthropic API key', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['OpenAI API key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/],
  ['GitLab token', /\bglpat-[A-Za-z0-9_-]{20}/],
  // scheme://user:password@ (the user may be empty: redis://:pw@); a ${VAR} password is a placeholder.
  // No scheme in the pattern, so a try only starts at ://, and every part (the ${VAR} lookahead too) stops
  // at the next / or @: no try reads past the next ://, so a long line costs linear time.
  ['URL with credentials', /:\/\/[^\s:@/]*:(?!\$\{[^}\s/@]*\}@)[^\s@/]+@/],
];

/** The first line of `text` (numbered from `firstLine`) that looks like a secret, and what it looks like. */
export function findSecret(text: string, firstLine = 1): { line: number; kind: string } | undefined {
  for (const [i, line] of text.split('\n').entries()) {
    for (const [kind, re] of SECRETS) if (re.test(line)) return { line: firstLine + i, kind };
  }
  return undefined;
}

/** The Secret refusal for a snippet or evidence line about to be stored, or undefined when it is clean. */
export function secretCheck(path: string, text: string, firstLine: number): string | undefined {
  const hit = findSecret(text, firstLine);
  return hit && rejectText.secret(path, hit.line, hit.kind);
}

// ---------- git blob shas ----------

/** git's object id of a blob: sha1 or sha256 of "blob <n>\0" + bytes. */
export async function blobSha(format: ObjectFormat, bytes: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const all = new Uint8Array(header.length + bytes.length);
  all.set(header);
  all.set(bytes, header.length);
  const digest = new Uint8Array(await crypto.subtle.digest(format === 'sha256' ? 'SHA-256' : 'SHA-1', all));
  return Array.from(digest, b => b.toString(16).padStart(2, '0')).join('');
}

function crlfToLf(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length);
  let n = 0;
  for (let i = 0; i < bytes.length; i++) if (!(bytes[i] === 13 && bytes[i + 1] === 10)) out[n++] = bytes[i];
  return out.subarray(0, n);
}

/** git's reported sha holds for these bytes as they are, or after CRLF→LF (git's eol filter); any other filter (LFS) fails. */
export async function gitShaHolds(format: ObjectFormat, bytes: Uint8Array, sha: string): Promise<boolean> {
  if ((await blobSha(format, bytes)) === sha) return true;
  return bytes.includes(13) && (await blobSha(format, crlfToLf(bytes))) === sha;
}

// ---------- the body ----------

const TOOL_OF: Record<CaptureKind, string> = { start: 'start_session', ref: 'add_code_ref', cite: 'create_edge', checkpoint: 'mark_checkpoint' };
const KIND_OF: Record<ClaimTool, CaptureKind> = { start_session: 'start', add_code_ref: 'ref', create_edge: 'cite', mark_checkpoint: 'checkpoint', arrive: 'checkpoint' };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isSha = (v: unknown, format: ObjectFormat) => typeof v === 'string' && (format === 'sha256' ? /^[0-9a-f]{64}$/ : /^[0-9a-f]{40}$/).test(v);
const SEMVER = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/;
export const REMOTE_MAX = 2048;

function older(version: string, than: string): boolean {
  const a = SEMVER.exec(version)!.slice(1).map(Number);
  const b = SEMVER.exec(than)!.slice(1).map(Number);
  const i = a.findIndex((n, k) => n !== b[k]);
  return i >= 0 && a[i] < b[i];
}

/** Why the body is not a v1 capture body, or undefined (paths are checked by pathProblem, lists by their cap first). */
function shapeProblem(b: Record<string, unknown>): string | undefined {
  if (!['start', 'ref', 'cite', 'checkpoint'].includes(b.kind as string)) return 'an unknown kind';
  if (typeof b.toplevel !== 'string' || !b.toplevel.startsWith('/') || b.toplevel.length > 4096 || /[\x00-\x1f\x7f]/.test(b.toplevel)) return 'toplevel is not an absolute path';
  if (b.objectFormat !== 'sha1' && b.objectFormat !== 'sha256') return 'an unknown object format';
  const format = b.objectFormat;
  if (!isSha(b.head, format)) return 'head is not a sha';
  // the same rule as set_session_remote, whose refusal would otherwise come after the checkpoint
  if (b.remote !== undefined && (typeof b.remote !== 'string' || b.remote.length > REMOTE_MAX || /[\x00-\x1f\x7f]/.test(b.remote) || /^https?:\/\/[^/]*@/i.test(b.remote))) {
    return 'remote is not one line without a user name or token';
  }
  const file = (f: unknown): string | undefined => {
    if (!isObject(f)) return 'a file is not an object';
    const problem = pathProblem(f.path);
    if (problem) return problem;
    if ('missing' in f || 'unreadable' in f) return f.missing === true || f.unreadable === true ? undefined : 'an absent file without its reason';
    if (typeof f.bytes !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(f.bytes) || f.bytes.length % 4 !== 0) return `${f.path} has no base64 bytes`;
    if (!isSha(f.sha, format)) return `${f.path} has no sha`;
    return typeof f.citable === 'boolean' ? undefined : `${f.path} has no citability`;
  };
  if (b.kind === 'ref' || b.kind === 'cite') {
    if (typeof b.asked !== 'string' || b.asked === '' || b.asked.length > 4096 || /[\x00-\x1f\x7f]/.test(b.asked)) return 'asked is not a path';
    if (isObject(b.file) && ('missing' in b.file || 'unreadable' in b.file)) return 'the file has no bytes';
    return file(b.file);
  }
  if (b.kind === 'checkpoint') {
    if (!isSha(b.base, format)) return 'base is not a sha';
    for (const key of ['changed', 'untracked', 'deleted'] as const) {
      const list = b[key];
      if (!Array.isArray(list)) return `${key} is not a list`;
      for (const p of list) if (pathProblem(p)) return pathProblem(p);
    }
    if (!isObject(b.uncompared) || Object.values(b.uncompared).some(r => typeof r !== 'string')) return 'uncompared is not a map of reasons';
    if (!isObject(b.hunks)) return 'hunks is not a map';
    for (const [p, h] of Object.entries(b.hunks)) {
      if (pathProblem(p)) return pathProblem(p);
      const range = (r: unknown) => Array.isArray(r) && r.length === 2 && r.every(n => Number.isSafeInteger(n) && n >= 1) && r[0] <= r[1];
      if (typeof h !== 'string' && !(Array.isArray(h) && h.every(range))) return `the hunks of ${p} are not line ranges`;
    }
    if (!Array.isArray(b.files)) return 'files is not a list';
    for (const f of b.files) if (file(f)) return file(f);
    if (b.pushed !== undefined && typeof b.pushed !== 'boolean') return 'pushed is not true or false';
    if (b.dirty !== undefined) {
      if (!Array.isArray(b.dirty)) return 'dirty is not a list';
      for (const p of b.dirty) if (pathProblem(p)) return pathProblem(p);
    }
  }
  return undefined;
}

function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------- the claim ----------

export type ClaimTool = 'start_session' | 'add_code_ref' | 'create_edge' | 'mark_checkpoint' | 'arrive';
/** The session board the call acts on: what the capture must match. */
export type ClaimBoard = { id: bigint | number | string; name: string; repoRoot: string; baseSha: string };
export type ClaimCall =
  | { tool: 'start_session' }
  | { tool: 'add_code_ref' | 'create_edge'; path: string; board: ClaimBoard }
  | { tool: 'mark_checkpoint' | 'arrive'; board: ClaimBoard };

/**
 * The §5 checks a call runs on the capture it claims, after the store's
 * exists/unexpired/unclaimed check: helper version, kind and path, the
 * checkout and base, list caps, paths, and each file's size, binary sniff and
 * git sha (raw, or after CRLF→LF). Secrets are checked where snippets are
 * written (secretCheck). The first failure is the tool's whole answer.
 */
export async function claimCapture(
  id: string,
  body: unknown,
  call: ClaimCall
): Promise<{ ok: true; capture: ClaimedCapture } | { ok: false; text: string }> {
  const no = (text: string) => ({ ok: false as const, text });
  if (!isObject(body)) return no(rejectText.malformed(id, 'not an object'));
  const helper = typeof body.helper === 'string' && SEMVER.test(body.helper) ? body.helper : undefined;
  if (body.v !== CAPTURE_VERSION || !helper || older(helper, MIN_HELPER_VERSION)) return no(rejectText.oldHelper(helper ?? 'unknown'));

  if (body.kind === 'checkpoint') {
    for (const key of ['changed', 'untracked', 'deleted', 'files', 'dirty'] as const) {
      const list = body[key];
      if (Array.isArray(list) && list.length > MAX_LIST_PATHS) return no(rejectText.listTooLong(list.length, key === 'files' ? 'cited' : key));
    }
  }
  const problem = shapeProblem(body);
  if (problem) return no(rejectText.malformed(id, problem));
  const b = body as CaptureBody;

  const kind = KIND_OF[call.tool];
  const madeFor = b.kind === 'ref' || b.kind === 'cite' ? `${TOOL_OF[b.kind]} ${b.file.path}` : TOOL_OF[b.kind];
  if (b.kind !== kind) return no(rejectText.madeFor(id, madeFor, call.tool));
  if ((b.kind === 'ref' || b.kind === 'cite') && 'path' in call && call.path !== b.asked && call.path !== b.file.path) {
    return no(rejectText.madeFor(id, madeFor, `${call.tool} ${call.path}`));
  }
  if ('board' in call) {
    const board = call.board;
    if (b.toplevel !== board.repoRoot) return no(rejectText.anotherCheckout(b.toplevel, board.name, board.repoRoot));
    if (b.kind === 'checkpoint' && b.base !== board.baseSha) return no(rejectText.anotherBase(b.base, board.name, String(board.id), board.baseSha));
  }

  const claim = async (f: WireFile): Promise<ClaimedFile | string> => {
    const bytes = fromBase64(f.bytes);
    if (bytes.length > MAX_FILE_BYTES) return rejectText.tooLarge(f.path, bytes.length);
    if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return rejectText.binary(f.path);
    if (!(await gitShaHolds(b.objectFormat, bytes, f.sha))) return rejectText.filtered(f.path);
    return { path: f.path, bytes, sha: f.sha, citable: f.citable };
  };
  if (b.kind === 'start') return { ok: true, capture: b };
  if (b.kind !== 'checkpoint') {
    // the helper refuses these; a hand-made upload must not get past it
    if (isSecretFile(b.asked) || isSecretFile(b.file.path)) return no(rejectText.secretFile(b.file.path));
    const file = await claim(b.file);
    return typeof file === 'string' ? no(file) : { ok: true, capture: { ...b, file } };
  }
  const files: (ClaimedFile | AbsentFile)[] = [];
  for (const f of b.files) {
    if (!('bytes' in f)) {
      files.push(f);
      continue;
    }
    // what the helper sends for a secrets file: the flow leaves its refs as they are
    if (isSecretFile(f.path)) {
      files.push({ path: f.path, unreadable: true });
      continue;
    }
    const file = await claim(f);
    if (typeof file === 'string') return no(file);
    files.push(file);
  }
  return {
    ok: true,
    capture: { ...b, files, uncompared: new Map(Object.entries(b.uncompared)), hunks: new Map(Object.entries(b.hunks)) },
  };
}
