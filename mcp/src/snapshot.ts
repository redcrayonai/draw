/**
 * The session flows' SessionConn over the database's HTTP API (spec §3). The
 * flows read rows synchronously, as from a live cache; here, before each
 * `call`, if a write happened since the last read, the rows are read again:
 * the caller's my_boards, then the scoped board, session, repo_file, code_ref,
 * node, edge, session_route, route_event, change note, threat, code consent
 * and line hash views filtered by board id (a
 * Worker keeps at most 6 requests open and queues the rest). reducers.* post
 * /call and mark the snapshot stale.
 */
import type { Call, SessionConn, SessionDb } from '../../agent/src/session';
import type { DbHttp } from '../../shared/db-http';
import { decodeRows } from './decode';

export type MyBoardRow = { boardId: bigint; name: string; access: string; isSession: boolean };

/** The board whose rows are read: its id, or a pick from the caller's my_boards (start_session finds its board by name). */
export type BoardPick = bigint | ((mine: MyBoardRow[]) => bigint | undefined);

/** DEFAULT_TIMEOUT_MS of the stdio server's connection: one call, its reads and its write. */
export const CALL_TIMEOUT_MS = 15_000;

// The 13 scoped views, keyed as the flows read them, and the column holding the board id.
const TABLES = [
  ['visibleBoard', 'visible_board', 'id'],
  ['visibleSession', 'visible_session', 'board_id'],
  ['visibleRepoFile', 'visible_repo_file', 'board_id'],
  ['visibleCodeRef', 'visible_code_ref', 'board_id'],
  ['visibleNode', 'visible_node', 'board_id'],
  ['visibleEdge', 'visible_edge', 'board_id'],
  ['visibleSessionRoute', 'visible_session_route', 'board_id'],
  ['visibleRouteEvent', 'visible_route_event', 'board_id'],
  ['visibleChangeNote', 'visible_change_note', 'board_id'],
  ['visibleThreat', 'visible_threat', 'board_id'],
  ['visibleBoardCodeConsent', 'visible_board_code_consent', 'board_id'],
  ['visibleCodeRefHash', 'visible_code_ref_hash', 'board_id'],
  ['visibleEdgeEvidenceHash', 'visible_edge_evidence_hash', 'board_id'],
] as const;

const WRITE_ONLY = new Set(['update_code_ref', 'update_edge_evidence', 'set_change_note_readers', 'set_code_ref_hashes', 'set_edge_evidence_code']);

export function createSnapshot(http: Pick<DbHttp, 'sqlTypedAs' | 'callAs'>, token: string, board: BoardPick) {
  let stale = true;
  let signal: AbortSignal | undefined;
  const rows = new Map<string, Record<string, unknown>[]>();
  const table = (key: string) => ({ iter: () => (rows.get(key) ?? []) as never[] });
  const sql = async (query: string) => decodeRows(await http.sqlTypedAs(token, query, signal));

  async function read(): Promise<void> {
    const mine = await sql('SELECT * FROM my_boards');
    const id = typeof board === 'bigint' ? board : board(mine as MyBoardRow[]);
    // id is a bigint from our own code, never text from a model or a user.
    const tables = await Promise.all(
      TABLES.map(([, name, column]) => {
        if (id === undefined) return [];
        return sql(`SELECT * FROM ${name} WHERE ${column} = ${id}`);
      })
    );
    rows.set('myBoards', mine);
    TABLES.forEach(([key], i) => rows.set(key, tables[i]));
    stale = false;
  }

  /** Post a reducer call (inside `call`, which sets its timeout); the next call reads again. */
  async function write(reducer: string, args: unknown[]): Promise<void> {
    stale = true;
    await http.callAs(token, reducer, args, signal);
  }

  const db: SessionDb = {
    myBoards: table('myBoards'),
    visibleBoard: table('visibleBoard'),
    visibleSession: table('visibleSession'),
    visibleRepoFile: table('visibleRepoFile'),
    visibleCodeRef: table('visibleCodeRef'),
    visibleNode: table('visibleNode'),
    visibleEdge: table('visibleEdge'),
    visibleSessionRoute: table('visibleSessionRoute'),
    visibleRouteEvent: table('visibleRouteEvent'),
    visibleChangeNote: table('visibleChangeNote'),
    visibleBoardCodeConsent: table('visibleBoardCodeConsent'),
    visibleCodeRefHash: table('visibleCodeRefHash'),
    visibleEdgeEvidenceHash: table('visibleEdgeEvidenceHash'),
  };

  const conn: SessionConn = {
    db,
    reducers: {
      startSession: a => write('start_session', [a.name, a.repoRoot, a.baseSha]),
      addRepoFiles: a => write('add_repo_files', [a.boardId, a.paths]),
      addCodeRef: a =>
        write('add_code_ref', [a.boardId, a.targetKind, a.targetId, a.path, a.symbol, a.startLine, a.endLine, a.blobSha, a.snippet, a.author]),
      updateCodeRef: a => write('update_code_ref', [a.id, a.startLine, a.endLine, a.blobSha, a.snippet, a.status]),
      updateCodeRefAndFocus: a => write('update_code_ref_and_focus', [a.id, a.startLine, a.endLine, a.blobSha, a.snippet, a.status]),
      updateEdgeEvidence: a => write('update_edge_evidence', [a.edgeId, a.evidence, a.status]),
      markCheckpoint: a => write('mark_checkpoint', [a.boardId, a.headSha, a.coverage]),
      planRoute: a => write('plan_route', [a.boardId, a.nodeIds]),
      reroute: a => write('reroute', [a.boardId, a.addNodeIds, a.addIndices, a.removeNodeIds, a.reason]),
      arriveAtCheckpoint: a =>
        write('arrive_at_checkpoint', [a.boardId, a.nodeId, a.expectedRevision, a.expectedCheckpoint, a.headSha, a.coverage]),
      setChangeNoteReaders: a => write('set_change_note_readers', [a.id, a.readers, a.refFileSha]),
      setCodeRefHashes: a => write('set_code_ref_hashes', [a.refId, a.lineHashes]),
      setEdgeEvidenceCode: a => write('set_edge_evidence_code', [a.edgeId, a.lineHash, a.snippet === undefined ? { none: [] } : { some: a.snippet }]),
      setSessionRemote: a => write('set_session_remote', [a.boardId, a.remoteUrl, a.pushedHead, a.dirtyPaths]),
    },
  };

  const call: Call = async (label, fn, timeoutMs = CALL_TIMEOUT_MS) => {
    signal = AbortSignal.timeout(timeoutMs);
    // Checkpoint's per-ref writes read nothing new (guardSecrets reads only a ref's unchanged path), so they skip the re-read; keyed on session.ts's labels.
    if (stale && !(WRITE_ONLY.has(label) && rows.size > 0)) await read();
    return fn(conn);
  };

  return { conn, call, write };
}
