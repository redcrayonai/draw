/**
 * The session flows' machine on the hosted path (spec §4): a claimed capture
 * (shared/capture.ts) stands in for the user's git and disk, so
 * startSessionFlow, addCodeRefFlow, prepareSourceEvidence, markCheckpointFlow
 * and arriveFlow run unchanged on it. A capture answers only what the helper
 * read. Any other question throws the REJECTED text (CaptureRejection) rather
 * than letting a missing file pass for an unchanged one.
 *
 * Runs in the Worker: no node:fs, no child_process. File bytes become the
 * global Buffer, as the flows expect (nodejs_compat provides it in workerd).
 */
import { GitOutputTooLargeError } from '../../agent/src/errors';
import type { GitOps, MachineDeps } from '../../agent/src/session';
import { BinaryFileError, MissingFileError, textSource, type SourceFile } from '../../agent/src/snippet';
import { BINARY_SNIFF_BYTES, MAX_FILE_BYTES, CaptureRejection, rejectText, type ClaimedCapture, type ClaimedFile } from '../../shared/capture';

/** `board`: the id the call acts on, for the cited-files text (checkpoint captures). */
export function captureDeps(capture: ClaimedCapture, board?: bigint | number | string): MachineDeps {
  const root = capture.toplevel;
  // D10: the capture holds the cited files only, never the repo's file list.
  const files = new Map<string, ClaimedFile | 'missing' | 'unreadable'>();
  if (capture.kind === 'ref' || capture.kind === 'cite') {
    files.set(capture.file.path, capture.file);
    files.set(capture.asked, capture.file);
  } else if (capture.kind === 'checkpoint') {
    for (const f of capture.files) files.set(f.path, 'bytes' in f ? f : 'missing' in f ? 'missing' : 'unreadable');
  }

  // Only a call the claim did not match asks a ref, cite or start capture for more.
  const holdsNo = (what: string) =>
    new CaptureRejection(`REJECTED: this ${capture.kind} capture holds no ${what}. Nothing was written. Run the capture for this call and pass the new id.`);
  const lacking = (paths: string[]) =>
    capture.kind === 'checkpoint' ? new CaptureRejection(rejectText.citedMissing(paths, String(board), capture.base)) : holdsNo(paths.join(', '));
  const checkpoint = (what: string) => {
    if (capture.kind !== 'checkpoint') throw holdsNo(what);
    return capture;
  };
  const entry = (rel: string) => {
    const f = files.get(rel);
    if (f === undefined) throw lacking([rel]);
    return f;
  };
  const buffers = new Map<ClaimedFile, Buffer>();
  const read = (rel: string): { file: ClaimedFile; bytes: Buffer } => {
    const f = entry(rel);
    if (f === 'missing') throw new MissingFileError(rel);
    if (f === 'unreadable') throw new Error(`'${rel}' could not be read as text on the user's machine`);
    const cached = buffers.get(f);
    const bytes = cached ?? Buffer.from(f.bytes.buffer, f.bytes.byteOffset, f.bytes.byteLength);
    if (!cached) buffers.set(f, bytes);
    return { file: f, bytes };
  };

  const git: GitOps = {
    topLevel: () => root,
    head: () => capture.head,
    listTracked: () => [],
    changeCandidates: () => {
      const c = checkpoint('changed paths');
      return c.changed.map(path => ({ path, sure: !c.uncompared.has(path) }));
    },
    // The helper asked git already; only what it could not compare is asked, and counts as changed.
    confirmChanged: (_root, _base, paths) => {
      const c = checkpoint('changed paths');
      return new Map(
        paths.map(p => {
          const reason = c.uncompared.get(p);
          if (reason === undefined) throw holdsNo(`answer for ${p}`);
          return [p, { changed: true, reason }];
        })
      );
    },
    indexPath: () => `${root}/.git/index`,
    deleted: () => checkpoint('deleted paths').deleted,
    untracked: () => checkpoint('untracked paths').untracked,
    // git's sha for these bytes, verified against them when the capture was claimed
    hashObject: (_root, rel, bytes) => {
      const { file, bytes: captured } = read(rel);
      if (!captured.equals(bytes)) throw lacking([rel]);
      return file.sha;
    },
    hashFiles: (_root, rels) => rels.map(rel => read(rel).file.sha),
    isCitable: (_root, rel) => {
      const f = entry(rel);
      return typeof f !== 'string' && f.citable;
    },
    hunks: (_root, _base, rel) => {
      const h = checkpoint('hunks').hunks.get(rel);
      if (h === undefined) throw lacking([rel]);
      if (typeof h === 'string') throw new GitOutputTooLargeError(h, h); // git could not print the diff: the flow notes it
      return h.map(([start, end]) => ({ start, end }));
    },
    spelling: (_root, rel) => read(rel).file.path,
  };

  return {
    git,
    readSource: (_root, rel): SourceFile => {
      const { file, bytes } = read(rel);
      // the claim refused these already; the disk's readSource refuses them too
      if (bytes.length > MAX_FILE_BYTES) throw new Error(`'${rel}' is over 1 MB; code refs read files up to 1 MB`);
      if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) throw new BinaryFileError(rel);
      return textSource(`${root}/${file.path}`, file.path, bytes);
    },
    realpath: p => p, // the helper sends the realpath top level
    diskPath: (_root, rel) => read(rel).file.path,
    stamp: () => undefined, // no stat on a capture: nothing is kept by stamp between calls (Decision 17)
    need: (_root, paths) => {
      const missing = paths.filter(p => !files.has(p));
      if (missing.length > 0) throw lacking(missing);
    },
  };
}
