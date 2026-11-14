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

/** Keep only the oldest batch in a max heap; table iteration has no ordering guarantee. */
export function oldestBatch<R extends { id: bigint }>(rows: Iterable<R>, limit: number): R[] {
  const heap: R[] = [];
  if (limit <= 0) return heap;
  for (const row of rows) {
    if (heap.length < limit) {
      let i = heap.length;
      heap.push(row);
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if (heap[parent].id >= row.id) break;
        heap[i] = heap[parent];
        i = parent;
      }
      heap[i] = row;
    } else if (row.id < heap[0].id) {
      let i = 0;
      while (2 * i + 1 < heap.length) {
        let child = 2 * i + 1;
        if (child + 1 < heap.length && heap[child + 1].id > heap[child].id) child++;
        if (heap[child].id <= row.id) break;
        heap[i] = heap[child];
        i = child;
      }
      heap[i] = row;
    }
  }
  return heap.sort((a, b) => cmp(a.id, b.id));
}
