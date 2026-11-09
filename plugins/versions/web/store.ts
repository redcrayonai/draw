import { writable, type DbConnection, type MyBoardVersion } from '@draw/client';

export const boardVersions = writable<MyBoardVersion[]>([]);

export function reset(): void {
  boardVersions.set([]);
}

/** Its own subscription: an older server without this view still serves boards. */
export function attach(conn: DbConnection, stale: () => boolean): void {
  if (!('myBoardVersions' in conn.db)) return;
  const rebuild = () => {
    if (stale()) return;
    boardVersions.set([...conn.db.myBoardVersions.iter()].sort((a, b) =>
      Number(b.createdAt.microsSinceUnixEpoch - a.createdAt.microsSinceUnixEpoch) || Number(b.id - a.id)));
  };
  conn.db.myBoardVersions.onInsert(rebuild);
  conn.db.myBoardVersions.onUpdate(rebuild);
  conn.db.myBoardVersions.onDelete(rebuild);
  conn.subscriptionBuilder().onApplied(rebuild).onError(() => { if (!stale()) reset(); })
    .subscribe(['SELECT * FROM my_board_versions']);
}
