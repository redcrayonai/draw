// Reducer calls from the UI (new board, share, redeem, unlink). SDK 2.8 never
// settles a call whose socket closed mid-flight, so each one gives up after
// 15 s with a sentence instead of leaving a button busy forever.
import type { DbConnection } from '../module_bindings';
import { getConn } from './stdb';

const NOT_LIVE = 'Not connected to the database yet; wait a moment and retry.';
const NO_ANSWER = 'The database did not answer in 15 seconds. Check your connection and try again.';

/** Runs `f` on the live connection. Rejects with a sentence when not live or
 * after 15 s; otherwise settles as the reducer does (its error, verbatim). */
export async function callReducer<T>(f: (c: DbConnection) => Promise<T>): Promise<T> {
  const c = getConn();
  if (!c) throw new Error(NOT_LIVE);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(NO_ANSWER)), 15_000);
  });
  try {
    return await Promise.race([f(c), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
