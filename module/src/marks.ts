// Mark rules: claim lease and input limits for red crayon review marks (spec 2026-10-19).
// Zero imports, erasable TypeScript only: the module bundle and `node --experimental-strip-types` load this file as is.
// Times are micros since the Unix epoch as bigint (SpacetimeDB Timestamp.microsSinceUnixEpoch).

export const LEASE_MICROS = 15n * 60n * 1_000_000n;
export const HEAD_START_MICROS = 20n * 1_000_000n;
export const LISTENING_MICROS = 60n * 1_000_000n;
// A waiter row is rewritten at most this often: well inside the 60 s listening window, so the banner stays accurate.
export const WAITER_REFRESH_MICROS = 20n * 1_000_000n;

export const MARK_NOTE_MAX = 500;
export const MARK_REPLY_MAX = 400;
export const MARK_FILES_MAX = 20;
export const MARK_FILE_MAX = 300;
export const MARKS_PER_SEND_MAX = 20;
export const SEAT_RE = /^[A-Za-z0-9]{16}$/;

export const MARK_SEAT_RULE = 'mark rule: seat must be the 16-character seat start_session returned';
export const MARK_NOTE_RULE = 'mark rule: a note is at most 500 characters';
export const MARK_SEND_RULE = 'mark rule: send 1 to 20 marks, one per node, on nodes of this board';
export const MARK_REPLY_RULE = 'mark rule: reply is 1 to 400 characters and status is fixed or kept, with at most 20 files';
export const MARK_RECLAIMED_RULE = 'mark was reclaimed by another agent; drop it';
export const MARK_SEAT_MISMATCH_RULE = 'this mark is held by another seat of yours; use the seat that claimed it';
export const MARK_HUMANS_RULE = 'mark rule: only a person can send marks';
export const MARK_AGENTS_RULE = 'mark rule: only an agent can claim or answer marks';

/** A sent mark is open to its preferred agent at once and to anyone after the head start; a claim whose lease ran out is open again. */
export function claimable(
  m: { status: string; claimedBy: string; leaseUntil: bigint; preferredAgent: string; sentAt: bigint },
  now: bigint,
  agentHex: string,
): boolean {
  if (m.status === 'claimed') return m.leaseUntil <= now;
  if (m.status !== 'sent') return false;
  return m.preferredAgent === '' || m.preferredAgent === agentHex || now >= m.sentAt + HEAD_START_MICROS;
}

/** Why this seat may not answer the mark: 'seat' (same claim, another seat of the same agent: retry with that seat), 'reclaimed' (drop it), or null when it may. */
export function replyRefusal(
  m: { status: string; claimedBy: string; claimGen: number },
  owner: string,
  hex: string,
  claimGen: number,
): 'seat' | 'reclaimed' | null {
  if (m.status === 'claimed' && m.claimedBy === owner && m.claimGen === claimGen) return null;
  const sameClaim = m.status === 'claimed' && m.claimGen === claimGen;
  return sameClaim && m.claimedBy.startsWith(`${hex}/`) ? 'seat' : 'reclaimed';
}

/** A waiter row last renewed more than LISTENING_MICROS ago no longer counts as listening; claim_marks deletes it. */
export function staleWaiter(lastWaitAt: bigint, now: bigint): boolean {
  return now - lastWaitAt > LISTENING_MICROS;
}

/** claim_marks rewrites the owner's waiter row only when it has none or it is older than WAITER_REFRESH_MICROS. */
export function waiterDue(lastWaitAt: bigint | undefined, now: bigint): boolean {
  return lastWaitAt === undefined || now - lastWaitAt > WAITER_REFRESH_MICROS;
}

/** Count, uniqueness and note length; the reducer checks that each node is on this board. */
export function validateSend(nodeIds: bigint[], notes: string[]): void {
  if (nodeIds.length < 1 || nodeIds.length > MARKS_PER_SEND_MAX || notes.length !== nodeIds.length || new Set(nodeIds).size !== nodeIds.length) {
    throw new Error(MARK_SEND_RULE);
  }
  if (notes.some(n => n.length > MARK_NOTE_MAX)) throw new Error(MARK_NOTE_RULE);
}

export function validateReply(status: string, reply: string, files: string[]): void {
  if (
    (status !== 'fixed' && status !== 'kept') ||
    reply.trim() === '' || reply.length > MARK_REPLY_MAX ||
    files.length > MARK_FILES_MAX || files.some(f => f.length > MARK_FILE_MAX)
  ) throw new Error(MARK_REPLY_RULE);
}
