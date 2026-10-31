// The dashboard reads activity straight from the outbox (the my_activity view),
// so each board keeps a bounded tail of its newest bursts instead of waiting
// for a drain that never runs.

/** Rows my_activity returns, newest first. */
export const FEED_SIZE = 100;
/** Rows each board's outbox keeps; older bursts are dropped as new ones arrive. */
export const KEEP_PER_BOARD = 100;

/** The board layer an event's payload belongs to: a reader sees it only where they see that layer. */
export function activityLayer(type: string): 'code' | 'threats' | undefined {
  if (type.startsWith('coderef.')) return 'code';
  if (type.startsWith('threat.')) return 'threats';
  return undefined;
}

type Row = { id: bigint; lastAt: { microsSinceUnixEpoch: bigint } };
const cmp = (a: bigint, b: bigint): number => (a < b ? -1 : a > b ? 1 : 0);

/** Latest activity first; the newer row (higher id) breaks a tie. */
export const newestFirst = (a: Row, b: Row): number =>
  cmp(b.lastAt.microsSinceUnixEpoch, a.lastAt.microsSinceUnixEpoch) || cmp(b.id, a.id);

/** The rows past the newest `keep`: what a board's outbox drops. */
export function beyondKeep<R extends Row>(rows: R[], keep: number): R[] {
  return rows.length <= keep ? [] : [...rows].sort(newestFirst).slice(keep);
}
