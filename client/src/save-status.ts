type State = 'pending' | 'saved' | 'error';
export type UnsavedWrite = { reducer: string; args: unknown[] };

/** Report server acknowledgements, excluding connection setup, presence and
 *  the personal library (not the board; its notice and error strip report it). */
export function trackBoardWrites<T extends { reducers: object }>(conn: T, report: (state: State, reason?: string) => void): () => UnsavedWrite[] {
  let pending = 0;
  let failed = false;
  const unsaved = new Set<UnsavedWrite>();
  const ignored = new Set(['updateCursor', 'markRepliesRead', 'setSelection', 'joinBoard', 'openBoards', 'openSharedLink', 'ensureGuestBoard', 'claimGuestBoard', 'offerGuestClaim', 'saveLibraryItem', 'renameLibraryItem', 'deleteLibraryItem']);
  conn.reducers = new Proxy(conn.reducers, {
    get(target, key, receiver) {
      const call = Reflect.get(target, key, receiver);
      if (typeof call !== 'function' || typeof key !== 'string' || ignored.has(key)) return call;
      return async (...args: unknown[]) => {
        const write = { reducer: key, args: structuredClone(args) };
        unsaved.add(write);
        if (pending === 0) failed = false;
        pending++;
        report('pending');
        try {
          const result = await call.apply(target, args);
          unsaved.delete(write);
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
  // A later successful write cannot acknowledge a different failed edit.
  return () => [...unsaved];
}
