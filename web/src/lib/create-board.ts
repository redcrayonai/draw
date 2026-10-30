import { callReducer } from './reducer';

/** The request record identifies this creation even when board-list updates arrive later. */
export async function createBoard(name: string, orgId: string, workspaceId?: bigint): Promise<bigint> {
  const requestKey = crypto.randomUUID();
  let finished = false;
  let removeListener = () => {};
  let subscription: { unsubscribe(): void; isEnded(): boolean } | undefined;
  try {
    return await callReducer((c) => new Promise<bigint>((resolve, reject) => {
      const table = c.db.myBoardCreations;
      let committed = false;
      const check = () => {
        if (finished || !committed) return;
        const row = [...table.iter()].find((row) => row.requestKey === requestKey);
        if (row) { finished = true; resolve(row.boardId); }
      };
      table.onInsert(check);
      removeListener = () => table.removeOnInsert(check);
      subscription = c.subscriptionBuilder()
        .onApplied(() => {
          if (finished) return;
          void (workspaceId === undefined
            ? c.reducers.createRequestedBoard({ name, orgId, requestKey })
            : c.reducers.createWorkspaceBoard({ name, workspaceId, requestKey })).then(() => {
            committed = true;
            check();
          }, reject);
        })
        .onError(() => reject(new Error('The board server could not confirm your new board. Try again.')))
        .subscribe([`SELECT * FROM my_board_creations WHERE request_key = '${requestKey}'`]);
    }));
  } finally {
    finished = true;
    removeListener();
    if (subscription && !subscription.isEnded()) subscription.unsubscribe();
  }
}
