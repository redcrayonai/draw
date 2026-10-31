/**
 * The session flows' view of this machine: git (git.ts) and the file reads
 * below, which the helper and the parity test (mcp/src/parity.db.test.ts) use.
 * session.ts imports none of this, so a server without a local disk can run
 * the same flows over a capture instead.
 *
 * Server-side snippet capture: the model never pastes code. The file is read
 * from disk under the session's repo root, after a realpath-based guard that
 * refuses escapes, symlinks, non-files and binaries.
 */
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync, type Stats } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import {
  gitTopLevel,
  gitHead,
  gitListTracked,
  gitChangeCandidates,
  gitConfirmChanged,
  gitIndexPath,
  gitDeleted,
  gitUntracked,
  gitHashObject,
  gitHashFiles,
  gitIsCitable,
  gitListed,
  gitHunks,
  gitSpelling,
} from './git';
import { BinaryFileError, MissingFileError, textSource, type SourceFile } from './snippet';
import { MAX_FILE_BYTES } from '../../shared/capture';
import type { GitOps, MachineDeps } from './session';

export const defaultGit: GitOps = {
  topLevel: gitTopLevel,
  head: gitHead,
  listTracked: gitListTracked,
  changeCandidates: gitChangeCandidates,
  confirmChanged: gitConfirmChanged,
  indexPath: gitIndexPath,
  deleted: gitDeleted,
  untracked: gitUntracked,
  hashObject: gitHashObject,
  hashFiles: gitHashFiles,
  isCitable: gitIsCitable,
  hunks: gitHunks,
  spelling: gitSpelling,
  listed: gitListed,
};

function leavesRoot(root: string, abs: string): boolean {
  const rel = relative(root, abs);
  return rel.startsWith('..') || isAbsolute(rel);
}

// The guard every disk read in this file goes through: the repo root as a real path, a repo-relative
// `rel` that stays inside it, an entry that exists and is not a symlink.
function locate(repoRoot: string, rel: string): { root: string; abs: string; st: Stats } {
  let root: string;
  try {
    root = realpathSync.native(repoRoot);
  } catch {
    // Not a MissingFileError: a vanished root must not mark every ref stale.
    throw new Error(`the session's repo root ${repoRoot} no longer exists; start_session from the current checkout under another name`);
  }
  if (isAbsolute(rel)) throw new Error(`path must be repo-relative, got absolute path '${rel}'`);
  const abs = resolve(root, rel);
  if (leavesRoot(root, abs)) throw new Error(`path '${rel}' escapes the repo root`);
  let st;
  try {
    st = lstatSync(abs);
  } catch {
    throw new MissingFileError(rel);
  }
  if (st.isSymbolicLink()) throw new Error(`path '${rel}' is a symlink; cite the target file instead`);
  return { root, abs, st };
}

/** Realpath of `repoRoot/rel`, or a readable Error when the path is not a plain file inside the root. */
export function resolveRepoPath(repoRoot: string, rel: string): string {
  const { root, abs, st } = locate(repoRoot, rel);
  if (!st.isFile()) throw new Error(`path '${rel}' is not a regular file`);
  // native realpath also restores the on-disk case on a case-insensitive filesystem
  const real = realpathSync.native(abs);
  if (leavesRoot(root, real)) throw new Error(`path '${rel}' resolves outside the repo root`);
  return real;
}

/**
 * What `repoRoot/rel` is for a tool that lets a model browse the repo: a directory's entry names
 * (sorted; '' and '.' are the root) or a file read through readSource. Same guard as resolveRepoPath.
 */
export function readRepoEntry(repoRoot: string, rel: string): { dir: string[] } | { file: SourceFile } {
  const { root, abs, st } = locate(repoRoot, rel);
  if (!st.isDirectory()) return { file: readSource(repoRoot, rel) };
  const real = realpathSync.native(abs);
  if (leavesRoot(root, real)) throw new Error(`path '${rel}' resolves outside the repo root`);
  return { dir: readdirSync(real).sort() };
}

/**
 * The on-disk spelling of `rel` ('./a//b/../b/c.ts' -> 'b/c.ts', and the
 * on-disk case on APFS): POSIX separators, relative to the real root. This is
 * the spelling git prints up to Unicode normalisation; gitSpelling (git.ts)
 * finishes the job, since coverage, the eval and the editor link all key on
 * git's exact string (G17). Throws like resolveRepoPath.
 */
export function canonicalRepoPath(repoRoot: string, rel: string): string {
  const real = resolveRepoPath(repoRoot, rel);
  return relative(realpathSync.native(repoRoot), real).split(sep).join('/');
}

/** mtime, size and inode of a file: changes when its content may have (G15). Throws if it is gone. */
export function fileStamp(abs: string): string {
  const st = statSync(abs);
  return `${st.mtimeMs}:${st.size}:${st.ino}`;
}

/**
 * lstat of a path (a symlink itself, not its target): mtime, ctime, size,
 * inode and mode. Changes on any edit, touch, chmod or retarget (G15).
 * Throws if it is gone.
 */
export function pathStamp(abs: string): string {
  const st = lstatSync(abs);
  return `${st.mtimeMs}:${st.ctimeMs}:${st.size}:${st.ino}:${st.mode}`;
}

/** Whole file, up to 1 MB as on the hosted path: bytes (for git hash-object), text (for the resolver), LF-normalised lines. */
export function readSource(repoRoot: string, rel: string): SourceFile {
  const abs = resolveRepoPath(repoRoot, rel);
  const canonical = relative(realpathSync.native(repoRoot), abs).split(sep).join('/');
  const before = fileStamp(abs);
  if (statSync(abs).size > MAX_FILE_BYTES) throw new Error(`'${rel}' is over 1 MB; code refs read files up to 1 MB`);
  const bytes = readFileSync(abs);
  const stamp = fileStamp(abs) === before ? before : undefined;
  if (bytes.subarray(0, 8192).includes(0)) throw new BinaryFileError(rel);
  return textSource(abs, canonical, bytes, stamp);
}

/** This machine, for SessionDeps: `{ ...localDeps, call }`. */
export const localDeps: MachineDeps = {
  git: defaultGit,
  readSource,
  realpath: p => realpathSync(p),
  diskPath: canonicalRepoPath,
  stamp: (repoRoot, rel) => {
    try {
      return pathStamp(resolve(repoRoot, rel));
    } catch {
      return undefined;
    }
  },
};
