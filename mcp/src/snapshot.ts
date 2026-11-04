/**
 * The session flows' SessionConn over the database's HTTP API (spec §3). The
 * flows read rows synchronously, as from a live cache; here, before each
 * `call`, the views that callback needs are loaded and cached until a write.
 * Reads are scoped to the caller and board. reducers.* post /call and mark
 * the snapshot stale; write-only callbacks need no fresh snapshot.
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
type TableKey = (typeof TABLES)[number][0];
const SESSION_TABLES: TableKey[] = ['visibleBoard', 'visibleSession', 'visibleRepoFile'];
const CHECKPOINT_TABLES: TableKey[] = ['visibleSession', 'visibleCodeRef', 'visibleNode', 'visibleEdge', 'visibleCodeRefHash', 'visibleEdgeEvidenceHash'];
const ROUTE_TABLES: TableKey[] = ['visibleSession', 'visibleNode', 'visibleSessionRoute', 'visibleRouteEvent'];
// Keep these in sync with the callbacks in session.ts/routes.ts. Unknown labels load all views.
const READS: Record<string, readonly TableKey[]> = {
  'find session board': SESSION_TABLES,
  'read active session': SESSION_TABLES,
  'read code consent': ['visibleBoardCodeConsent'],
  'read repo files': ['visibleRepoFile'],
  'read code refs': ['visibleCodeRef'],
  'find new code ref': ['visibleCodeRef'],
  'read code ref hashes': ['visibleCodeRefHash'],
  'read session': CHECKPOINT_TABLES,
  'read checkpoint coverage': [...CHECKPOINT_TABLES, 'visibleChangeNote'],
  'read checkpoint': ['visibleSession', 'visibleRouteEvent'],
  'read route': ROUTE_TABLES,
  'read committed arrival': ROUTE_TABLES,
};
const WRITE_ONLY = new Set(['start_session', 'add_repo_files', 'add_code_ref', 'update_edge_evidence', 'set_change_note_readers', 'set_code_ref_hashes', 'set_edge_evidence_code', 'mark_checkpoint', 'arrive', 'plan_route', 'reroute', 'set_session_remote']);

export function createSnapshot(http: Pick<DbHttp, 'sqlTypedAs' | 'callAs'>, token: string, board: BoardPick) {
  let stale = true;
  let signal: AbortSignal | undefined;
  const rows = new Map<string, Record<string, unknown>[]>();
  const table = (key: string) => ({ iter: () => (rows.get(key) ?? []) as never[] });
  const sql = async (query: string) => decodeRows(await http.sqlTypedAs(token, query, signal));

  async function read(tables: readonly (typeof TABLES)[number][]): Promise<void> {
    const mine = stale ? await sql('SELECT * FROM my_boards') : rows.get('myBoards')!;
    const id = typeof board === 'bigint' ? board : board(mine as MyBoardRow[]);
    // id is a bigint from our own code, never text from a model or a user.
    const data = await Promise.all(
      tables.map(([, name, column]) => {
        if (id === undefined) return [];
        return sql(`SELECT * FROM ${name} WHERE ${column} = ${id}`);
      })
    );
    if (stale) rows.clear();
    rows.set('myBoards', mine);
    tables.forEach(([key], i) => rows.set(key, data[i]));
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
    if (WRITE_ONLY.has(label)) return fn(conn);
    // guardSecrets needs the ref's unchanged path even on a write-only call.
    if (label === 'update_code_ref') {
      if (!rows.has('visibleCodeRef')) await read(TABLES.filter(([key]) => key === 'visibleCodeRef'));
      return fn(conn);
    }
    const keys = READS[label];
    const tables = TABLES.filter(([key]) => (!keys || keys.includes(key)) && (stale || !rows.has(key)));
    if (tables.length) await read(tables);
    return fn(conn);
  };

  return { conn, call, write };
}
