type State = 'pending' | 'saved' | 'error';

/** Report server acknowledgements, excluding ephemeral presence writes and
 *  the personal library (not the board; its notice and error strip report it). */
export function trackBoardWrites<T extends { reducers: object }>(conn: T, report: (state: State, reason?: string) => void): void {
  let pending = 0;
  let failed = false;
  const ignored = new Set(['updateCursor', 'setSelection', 'joinBoard', 'offerGuestClaim', 'saveLibraryItem', 'renameLibraryItem', 'deleteLibraryItem']);
  conn.reducers = new Proxy(conn.reducers, {
    get(target, key, receiver) {
      const call = Reflect.get(target, key, receiver);
      if (typeof call !== 'function' || typeof key !== 'string' || ignored.has(key)) return call;
      return async (...args: unknown[]) => {
        if (pending === 0) failed = false;
        pending++;
        report('pending');
        try {
          const result = await call.apply(target, args);
          pending--;
          if (!pending && !failed) report('saved');
          return result;
        } catch (error) {
          pending--;
          failed = true;
          report('error', error instanceof Error ? error.message : String(error));
          throw error;
        }
      };
    },
  });
}
