import { describe, expect, it, vi } from 'vitest';
import { DbError, type DbHttp, type DbType } from '../../shared/db-http';
import { createSnapshot } from './snapshot';

// Column types as /sql's schema states them.
const U64 = { U64: [] };
const S = { String: [] };
const U32 = { U32: [] };
const B = { Bool: [] };
const TS = { Product: { elements: [{ name: { some: '__timestamp_micros_since_unix_epoch__' }, algebraic_type: { I64: [] } }] } };
const OPT_U64 = { Sum: { variants: [{ name: { some: 'some' }, algebraic_type: U64 }, { name: { some: 'none' }, algebraic_type: { Product: { elements: [] } } }] } };
const U64S = { Array: U64 };
type Table = { columns: { name: string; type: DbType }[]; rows: unknown[][] };
const table = (columns: [string, DbType][], rows: unknown[][]): Table => ({ columns: columns.map(([name, type]) => ({ name, type })), rows });

// A DB with one session board (7) of another identity's board (8) next to it; rows as /sql returns them.
function fakeHttp(tables: Record<string, Table>) {
  const queries: string[] = [];
  const calls: [string, unknown[]][] = [];
  const http: Pick<DbHttp, 'sqlTypedAs' | 'callAs'> = {
    sqlTypedAs: vi.fn(async (_token: string, query: string) => {
      queries.push(query);
      const m = query.match(/^SELECT \* FROM (\w+)(?: WHERE (\w+) = (\d+))?$/);
      if (!m) throw new Error(`unexpected query ${query}`);
      const [, name, column, id] = m;
      const t = tables[name] ?? table([], []);
      const i = t.columns.findIndex(c => c.name === column);
      return { columns: t.columns, rows: t.rows.filter(r => column === undefined || String(r[i]) === id) };
    }),
    callAs: vi.fn(async (_token: string, reducer: string, args: unknown[]) => {
      calls.push([reducer, args]);
    }),
  };
  return { http, queries, calls };
}

const MAX = 18446744073709551615n;
const TABLES = {
  my_boards: table([['board_id', U64], ['name', S], ['access', S], ['is_session', B], ['updated_at', TS]], [[7, 'main', 'owner', true, [1_791_000_000_000_000]]]),
  visible_board: table([['id', U64], ['name', S]], [[7, 'main'], [8, 'other']]),
  visible_session: table(
    [['id', U64], ['board_id', U64], ['repo_root', S], ['base_sha', S], ['head_sha', S], ['checkpoint', U32], ['coverage', S], ['started_at', TS], ['updated_at', TS]],
    [[3, 7, '/r', 'b', '', 0, '{}', [1_791_000_000_000_123], [1]]]
  ),
  visible_repo_file: table([['id', U64], ['board_id', U64], ['path', S]], [[1, 7, 'a.ts'], [2, 8, 'b.ts']]),
  visible_code_ref: table(
    [['id', U64], ['board_id', U64], ['target_kind', S], ['target_id', U64], ['path', S], ['symbol', S], ['start_line', U32], ['end_line', U32], ['blob_sha', S], ['snippet', S], ['author', S], ['checkpoint', U32], ['status', S]],
    [[MAX, 7, 'node', 5, 'a.ts', 'f', 1, 2, 's', 'x', '', 0, 'ok']]
  ),
  visible_node: table([['id', U64], ['board_id', U64], ['hidden', B]], [[5, 7, false]]),
  visible_edge: table(
    [['id', U64], ['board_id', U64], ['from_node', U64], ['to_node', U64], ['evidence', S], ['evidence_snippet', S], ['evidence_status', S]],
    [[6, 7, 5, 5, 'source:a.ts:1', 'x', 'ok']]
  ),
  visible_session_route: table(
    [['board_id', U64], ['node_ids', U64S], ['current_index', U32], ['revision', U32], ['current_checkpoint', U32], ['updated_at', TS]],
    [[7, [5, MAX], 0, 2, 1, [1]]]
  ),
  // node_id is an option: [0, value] is some, [1, []] is none
  visible_route_event: table(
    [['id', U64], ['board_id', U64], ['kind', S], ['revision', U32], ['node_id', OPT_U64], ['node_ids', U64S], ['reason', S], ['checkpoint', U32], ['at', TS]],
    [
      [1, 7, 'plan', 1, [1, []], [5], '', 0, [1]],
      [2, 7, 'arrive', 2, [0, 5], [5, MAX], '', 1, [2]],
    ]
  ),
  visible_board_code_consent: table([['board_id', U64], ['store_code', B]], [[7, false], [8, true]]),
  visible_code_ref_hash: table([['ref_id', U64], ['board_id', U64], ['line_hashes', S]], [[MAX, 7, 'a'.repeat(32)]]),
  visible_edge_evidence_hash: table([['edge_id', U64], ['board_id', U64], ['line_hash', S]], [[6, 7, 'b'.repeat(32)]]),
};

describe('createSnapshot', () => {
  // An empty list would pass for "no notes": a checkpoint would then miss stale readers.
  it.each(['visible_change_note', 'visible_threat'])('fails the read when %s cannot be read', async view => {
    const base = fakeHttp(TABLES);
    const http: typeof base.http = {
      ...base.http,
      sqlTypedAs: async (token, query, signal) => {
        if (query.includes(view)) throw new DbError(503, `the database answered 503 to sql: ${query}`);
        return base.http.sqlTypedAs(token, query, signal);
      },
    };
    await expect(createSnapshot(http, 'tok', 7n).call('read', async conn => [...conn.db.visibleChangeNote.iter()])).rejects.toThrow(/503/);
  });

  it('posts set_change_note_readers positionally', async () => {
    const { http, calls } = fakeHttp(TABLES);
    const snap = createSnapshot(http, 'tok', 7n);
    await snap.call('set_change_note_readers', conn => conn.reducers.setChangeNoteReaders({ id: 4n, readers: '[]', refFileSha: 'f'.repeat(40) }));
    expect(calls).toEqual([['set_change_note_readers', [4n, '[]', 'f'.repeat(40)]]]);
  });

  it('posts the line hash and remote writes positionally, an absent snippet as none (RC-690)', async () => {
    const { http, calls } = fakeHttp(TABLES);
    const snap = createSnapshot(http, 'tok', 7n);
    await snap.call('set_code_ref_hashes', conn => conn.reducers.setCodeRefHashes({ refId: 9n, lineHashes: 'a'.repeat(32) }));
    await snap.call('set_edge_evidence_code', conn => conn.reducers.setEdgeEvidenceCode({ edgeId: 6n, lineHash: 'b'.repeat(32), snippet: undefined }));
    await snap.call('set_edge_evidence_code', conn => conn.reducers.setEdgeEvidenceCode({ edgeId: 6n, lineHash: 'b'.repeat(32), snippet: 'x' }));
    await snap.call('set_session_remote', conn => conn.reducers.setSessionRemote({ boardId: 7n, remoteUrl: 'git@github.com:o/r.git', pushedHead: '', dirtyPaths: ['a.ts'] }));
    expect(calls).toEqual([
      ['set_code_ref_hashes', [9n, 'a'.repeat(32)]],
      ['set_edge_evidence_code', [6n, 'b'.repeat(32), { none: [] }]],
      ['set_edge_evidence_code', [6n, 'b'.repeat(32), { some: 'x' }]],
      ['set_session_remote', [7n, 'git@github.com:o/r.git', '', ['a.ts']]],
    ]);
  });

  it('reads my_boards, then the 13 scoped views by board id, as the flows read the SDK cache', async () => {
    const { http, queries } = fakeHttp(TABLES);
    const snap = createSnapshot(http, 'tok', 7n);
    const seen = await snap.call('read', async conn => ({
      mine: [...conn.db.myBoards.iter()],
      boards: [...conn.db.visibleBoard.iter()],
      session: [...conn.db.visibleSession.iter()],
      files: [...conn.db.visibleRepoFile.iter()],
      refs: [...conn.db.visibleCodeRef.iter()],
      edges: [...conn.db.visibleEdge.iter()],
      routes: [...conn.db.visibleSessionRoute.iter()],
      events: [...conn.db.visibleRouteEvent.iter()],
      consent: [...conn.db.visibleBoardCodeConsent.iter()],
      refHashes: [...conn.db.visibleCodeRefHash.iter()],
      edgeHashes: [...conn.db.visibleEdgeEvidenceHash.iter()],
    }));
    expect(queries).toEqual([
      'SELECT * FROM my_boards',
      'SELECT * FROM visible_board WHERE id = 7',
      'SELECT * FROM visible_session WHERE board_id = 7',
      'SELECT * FROM visible_repo_file WHERE board_id = 7',
      'SELECT * FROM visible_code_ref WHERE board_id = 7',
      'SELECT * FROM visible_node WHERE board_id = 7',
      'SELECT * FROM visible_edge WHERE board_id = 7',
      'SELECT * FROM visible_session_route WHERE board_id = 7',
      'SELECT * FROM visible_route_event WHERE board_id = 7',
      'SELECT * FROM visible_change_note WHERE board_id = 7',
      'SELECT * FROM visible_threat WHERE board_id = 7',
      'SELECT * FROM visible_board_code_consent WHERE board_id = 7',
      'SELECT * FROM visible_code_ref_hash WHERE board_id = 7',
      'SELECT * FROM visible_edge_evidence_hash WHERE board_id = 7',
    ]);
    expect(seen.mine).toEqual([{ boardId: 7n, name: 'main', access: 'owner', isSession: true, updatedAt: { microsSinceUnixEpoch: 1_791_000_000_000_000n } }]);
    expect(seen.boards).toEqual([{ id: 7n, name: 'main' }]);
    expect(seen.session[0]).toMatchObject({ id: 3n, boardId: 7n, repoRoot: '/r', startedAt: { microsSinceUnixEpoch: 1_791_000_000_000_123n } });
    expect(seen.files).toEqual([{ id: 1n, boardId: 7n, path: 'a.ts' }]);
    expect(seen.refs[0]).toMatchObject({ id: 18446744073709551615n, targetId: 5n, startLine: 1, blobSha: 's' });
    expect(seen.edges).toEqual([{ id: 6n, boardId: 7n, fromNode: 5n, toNode: 5n, evidence: 'source:a.ts:1', evidenceSnippet: 'x', evidenceStatus: 'ok' }]);
    expect(seen.routes).toEqual([
      { boardId: 7n, nodeIds: [5n, 18446744073709551615n], currentIndex: 0, revision: 2, currentCheckpoint: 1, updatedAt: { microsSinceUnixEpoch: 1n } },
    ]);
    expect(seen.events.map(e => [e.kind, e.nodeId, e.nodeIds])).toEqual([
      ['plan', undefined, [5n]],
      ['arrive', 5n, [5n, 18446744073709551615n]],
    ]);
    expect(seen.consent).toEqual([{ boardId: 7n, storeCode: false }]);
    expect(seen.refHashes).toEqual([{ refId: MAX, boardId: 7n, lineHashes: 'a'.repeat(32) }]);
    expect(seen.edgeHashes).toEqual([{ edgeId: 6n, boardId: 7n, lineHash: 'b'.repeat(32) }]);
  });

  it('reads again only after a write', async () => {
    const { http, queries } = fakeHttp(TABLES);
    const snap = createSnapshot(http, 'tok', 7n);
    await snap.call('a', async () => undefined);
    await snap.call('b', async () => undefined);
    expect(queries).toHaveLength(14);
    await snap.call('w', conn => conn.reducers.addRepoFiles({ boardId: 7n, paths: ['c.ts'] }));
    expect(queries).toHaveLength(14);
    await snap.call('c', async () => undefined);
    expect(queries).toHaveLength(28);
  });

  it("checkpoint's per-ref writes do not re-read between them; the next read does", async () => {
    const { http, queries, calls } = fakeHttp(TABLES);
    const snap = createSnapshot(http, 'tok', 7n);
    await snap.call('read session', async () => undefined);
    const ref = { id: 9n, startLine: 1, endLine: 2, blobSha: 's', snippet: 'x', status: 'ok' };
    for (let i = 0; i < 5; i++) await snap.call('update_code_ref', conn => conn.reducers.updateCodeRef(ref));
    await snap.call('update_edge_evidence', conn => conn.reducers.updateEdgeEvidence({ edgeId: 6n, evidence: 'source:a.ts:2', status: 'ok' }));
    expect(calls).toHaveLength(6);
    expect(queries).toHaveLength(14);
    await snap.call('read code refs', async () => undefined);
    expect(queries).toHaveLength(28);
  });

  it('a failed write still marks the rows stale: it may have landed', async () => {
    const { http, queries } = fakeHttp(TABLES);
    vi.mocked(http.callAs).mockRejectedValueOnce(new Error('network'));
    const snap = createSnapshot(http, 'tok', 7n);
    await expect(snap.call('w', conn => conn.reducers.markCheckpoint({ boardId: 7n, headSha: 'h', coverage: '{}' }))).rejects.toThrow('network');
    await snap.call('r', async () => undefined);
    expect(queries).toHaveLength(28);
  });

  it('posts each reducer with its positional arguments', async () => {
    const { http, calls } = fakeHttp(TABLES);
    const { call } = createSnapshot(http, 'tok', 7n);
    const ref = { id: 9n, startLine: 1, endLine: 2, blobSha: 's', snippet: 'x', status: 'ok' };
    await call('w', async conn => {
      await conn.reducers.startSession({ name: 'main', repoRoot: '/r', baseSha: 'b' });
      await conn.reducers.addRepoFiles({ boardId: 7n, paths: ['a.ts'] });
      await conn.reducers.addCodeRef({ boardId: 7n, targetKind: 'node', targetId: 5n, path: 'a.ts', symbol: 'f', startLine: 1, endLine: 2, blobSha: 's', snippet: 'x', author: 'me' });
      await conn.reducers.updateCodeRef(ref);
      await conn.reducers.updateCodeRefAndFocus!(ref);
      await conn.reducers.updateEdgeEvidence({ edgeId: 6n, evidence: 'source:a.ts:2', status: 'ok' });
      await conn.reducers.markCheckpoint({ boardId: 7n, headSha: 'h', coverage: '{}' });
      await conn.reducers.planRoute({ boardId: 7n, nodeIds: [5n, 6n] });
      await conn.reducers.reroute({ boardId: 7n, addNodeIds: [6n], addIndices: [0], removeNodeIds: [5n], reason: 'r' });
      await conn.reducers.arriveAtCheckpoint({ boardId: 7n, nodeId: 5n, expectedRevision: 2, expectedCheckpoint: 1, headSha: 'h', coverage: '{}' });
    });
    expect(calls).toEqual([
      ['start_session', ['main', '/r', 'b']],
      ['add_repo_files', [7n, ['a.ts']]],
      ['add_code_ref', [7n, 'node', 5n, 'a.ts', 'f', 1, 2, 's', 'x', 'me']],
      ['update_code_ref', [9n, 1, 2, 's', 'x', 'ok']],
      ['update_code_ref_and_focus', [9n, 1, 2, 's', 'x', 'ok']],
      ['update_edge_evidence', [6n, 'source:a.ts:2', 'ok']],
      ['mark_checkpoint', [7n, 'h', '{}']],
      ['plan_route', [7n, [5n, 6n]]],
      ['reroute', [7n, [6n], [0], [5n], 'r']],
      ['arrive_at_checkpoint', [7n, 5n, 2, 1, 'h', '{}']],
    ]);
  });

  it('picks its board from my_boards at every read, and reads no table before there is one', async () => {
    const tables = { ...TABLES, my_boards: { ...TABLES.my_boards, rows: [] as unknown[][] } };
    const { http, queries } = fakeHttp(tables);
    const pick = vi.fn((mine: { boardId: bigint; name: string }[]) => mine.find(b => b.name === 'main')?.boardId);
    const snap = createSnapshot(http, 'tok', pick);
    expect(await snap.call('r', async conn => [...conn.db.visibleSession.iter()])).toEqual([]);
    expect(queries).toEqual(['SELECT * FROM my_boards']);
    await snap.call('start', conn => conn.reducers.startSession({ name: 'main', repoRoot: '/r', baseSha: 'b' }));
    tables.my_boards = TABLES.my_boards;
    expect(await snap.call('find', async conn => [...conn.db.visibleSession.iter()].map(s => s.boardId))).toEqual([7n]);
    expect(pick).toHaveBeenCalledTimes(2);
  });

  it('gives each call its own timeout, shared by its reads and its write', async () => {
    const { http } = fakeHttp(TABLES);
    const { call } = createSnapshot(http, 'tok', 7n);
    await call('w', conn => conn.reducers.addRepoFiles({ boardId: 7n, paths: [] }), 1234);
    const readSignal = vi.mocked(http.sqlTypedAs).mock.calls[0][2];
    expect(readSignal).toBeInstanceOf(AbortSignal);
    expect(vi.mocked(http.callAs).mock.calls[0][3]).toBe(readSignal);
  });
});
