import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, lutimesSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { GitOutputTooLargeError, GitTimeoutError } from './errors';
import { gitChangeCandidates, gitChanged, gitListTracked } from './git';
import type { ResolveResult } from './resolver';
import { MissingFileError, type SourceFile } from './snippet';
import { localDeps } from './local-deps';
import { arriveFlow, routeSnapshot } from './routes';
import { lineHash, lineHashes } from './code-hash';
import {
  CODE_CONSENT_RULE,
  boardStoresCode,
  symbolNeedle,
  fitSnippet,
  describeResolveFailure,
  ensureRepoPath,
  startSessionFlow,
  addCodeRefFlow,
  markCheckpointFlow,
  reanchor,
  addCodeRefText,
  prepareSourceEvidence,
  flowBudget,
  guardSecrets,
  type Call,
  type GitOps,
  type SessionConn,
  type SessionRow,
  type CodeRefRow,
  type ChangeNoteRow,
} from './session';

// ---------- fakes ----------

/** A board's 20-hex link slug in the fakes. */
const slugOf = (id: bigint) => id.toString(16).padStart(20, '0');

function fakeConn(seed: {
  /** access: this identity's my_boards access to the board; a seeded board is its own ('owner') unless set */
  boards?: { id: bigint; name: string; access?: string }[];
  sessions?: SessionRow[];
  repoFiles?: { id: bigint; boardId: bigint; path: string }[];
  codeRefs?: CodeRefRow[];
  nodes?: { id: bigint; boardId: bigint }[];
  edges?: { id: bigint; boardId: bigint; evidence?: string; evidenceSnippet?: string; evidenceStatus?: string }[];
  changeNotes?: ChangeNoteRow[];
  /** whether the boards keep code text (RC-690); these tests' boards do unless a test says not */
  storeCode?: boolean;
  refHashes?: { refId: bigint; boardId: bigint; lineHashes: string }[];
  edgeHashes?: { edgeId: bigint; boardId: bigint; lineHash: string }[];
} = {}) {
  const boards = seed.boards ?? [];
  const sessions = seed.sessions ?? [];
  const repoFiles = seed.repoFiles ?? [];
  const codeRefs = seed.codeRefs ?? [];
  const nodes = seed.nodes ?? [];
  const edges = seed.edges ?? [];
  const changeNotes = seed.changeNotes ?? [];
  const refHashes = seed.refHashes ?? [];
  const edgeHashes = seed.edgeHashes ?? [];
  // the module's answer; the cache's (visibleBoardCodeConsent) says the same unless a test overrides it
  const consent = { storeCode: seed.storeCode ?? true };
  const refuseText = (text: string | undefined) => {
    if (text && !consent.storeCode) throw new Error(CODE_CONSENT_RULE);
  };
  const calls: { name: string; args: unknown }[] = [];
  let nextId = 100n;
  const conn: SessionConn = {
    db: {
      visibleBoard: { iter: () => boards.map(b => ({ ...b, slug: slugOf(b.id) })) },
      myBoards: {
        iter: () => boards.map(b => ({ boardId: b.id, name: b.name, access: b.access ?? 'owner', isSession: sessions.some(s => s.boardId === b.id) })),
      },
      visibleSession: { iter: () => sessions },
      visibleRepoFile: { iter: () => repoFiles },
      visibleCodeRef: { iter: () => codeRefs },
      visibleNode: { iter: () => nodes },
      visibleEdge: { iter: () => edges },
      visibleSessionRoute: { iter: () => [] },
      visibleRouteEvent: { iter: () => [] },
      visibleChangeNote: { iter: () => changeNotes },
      visibleBoardCodeConsent: {
        iter: () =>
          [...new Set([...boards.map(b => b.id), ...[sessions, repoFiles, codeRefs, nodes, edges].flatMap(rows => rows.map(r => r.boardId))])].map(boardId => ({
            boardId,
            storeCode: consent.storeCode,
          })),
      },
      visibleCodeRefHash: { iter: () => refHashes },
      visibleEdgeEvidenceHash: { iter: () => edgeHashes },
    },
    reducers: {
      async startSession(a) {
        calls.push({ name: 'startSession', args: a });
        // mirrors the module: among the caller's own and granted boards (dashboard spec §1.5),
        // re-adopt the same-named SESSION board, refuse another checkout
        const named = boards.filter(b => b.name === a.name && ['owner', 'grant'].includes(b.access ?? 'owner'));
        const own = sessions.filter(s => named.some(b => b.id === s.boardId));
        if (own.some(s => s.repoRoot === a.repoRoot)) return;
        if (own.length > 0) {
          throw new Error(`session board '${a.name}' belongs to ${own[0].repoRoot}; start_session from that checkout or choose another name`);
        }
        if (named.length > 0) {
          throw new Error(`board '${a.name}' already exists without a session (someone made it by hand); call start_session with another name, e.g. '${a.name.slice(0, 92)}-session'`);
        }
        const id = nextId++;
        boards.push({ id, name: a.name });
        sessions.push({ id: nextId++, boardId: id, repoRoot: a.repoRoot, baseSha: a.baseSha, headSha: '', checkpoint: 0, coverage: '{}' });
      },
      async addRepoFiles(a) {
        calls.push({ name: 'addRepoFiles', args: a });
        for (const p of a.paths) repoFiles.push({ id: nextId++, boardId: a.boardId, path: p });
      },
      async addCodeRef(a) {
        calls.push({ name: 'addCodeRef', args: a });
        refuseText(a.snippet);
        codeRefs.push({ id: nextId++, ...a, checkpoint: 1, status: 'ok' });
      },
      async updateCodeRef(a) {
        calls.push({ name: 'updateCodeRef', args: a });
        if (a.status === 'ok') refuseText(a.snippet);
        Object.assign(codeRefs.find(r => r.id === a.id)!, a);
      },
      async setCodeRefHashes(a) {
        calls.push({ name: 'setCodeRefHashes', args: a });
        const ref = codeRefs.find(r => r.id === a.refId)!;
        const row = refHashes.find(h => h.refId === a.refId);
        if (row) row.lineHashes = a.lineHashes;
        else refHashes.push({ refId: a.refId, boardId: ref.boardId, lineHashes: a.lineHashes });
      },
      async setEdgeEvidenceCode(a) {
        calls.push({ name: 'setEdgeEvidenceCode', args: a });
        const edge = edges.find(e => e.id === a.edgeId)!;
        refuseText(a.snippet);
        if (a.snippet !== undefined) edge.evidenceSnippet = a.snippet;
        const row = edgeHashes.find(h => h.edgeId === a.edgeId);
        if (row) row.lineHash = a.lineHash;
        else edgeHashes.push({ edgeId: a.edgeId, boardId: edge.boardId, lineHash: a.lineHash });
      },
      setSessionRemote: async () => { throw new Error('setSessionRemote not faked'); },
      async updateEdgeEvidence(a) {
        calls.push({ name: 'updateEdgeEvidence', args: a });
        Object.assign(edges.find(e => e.id === a.edgeId)!, { evidence: a.evidence, evidenceStatus: a.status });
      },
      async markCheckpoint(a) {
        calls.push({ name: 'markCheckpoint', args: a });
        const s = sessions.find(s => s.boardId === a.boardId)!;
        s.checkpoint += 1;
        s.headSha = a.headSha;
        s.coverage = a.coverage;
      },
      async setChangeNoteReaders(a) {
        calls.push({ name: 'setChangeNoteReaders', args: a });
        Object.assign(changeNotes.find(n => n.id === a.id)!, { readers: a.readers, refFileSha: a.refFileSha });
      },
      // Route tests replace these with fakes of their own.
      planRoute: async () => { throw new Error('planRoute not faked'); },
      reroute: async () => { throw new Error('reroute not faked'); },
      arriveAtCheckpoint: async () => { throw new Error('arriveAtCheckpoint not faked'); },
    },
  };
  // Reads and writes both go through `call`; only reducer calls are recorded in `calls`.
  const call: Call = (_label, fn) => fn(conn);
  return { conn, call, calls, boards, sessions, repoFiles, codeRefs, nodes, edges, changeNotes, refHashes, edgeHashes, consent };
}

describe('session route arrivals', () => {
  function seeded(currentIndex = -1) {
    const f = fakeConn({
      sessions: [{ id: 9n, boardId: 1n, repoRoot: '/r', baseSha: 'a'.repeat(40), headSha: '', checkpoint: 3, coverage: '{}' }],
      nodes: [{ id: 5n, boardId: 1n }, { id: 6n, boardId: 1n }],
    });
    const route = { boardId: 1n, nodeIds: [5n, 6n], currentIndex, revision: 2, currentCheckpoint: currentIndex < 0 ? 0 : 2 };
    Object.assign(f.conn.db, { visibleSessionRoute: { iter: () => [route] }, visibleRouteEvent: { iter: () => [] } });
    const arrived: unknown[] = [];
    Object.assign(f.conn.reducers, { arriveAtCheckpoint: async (args: { nodeId: bigint; headSha: string; coverage: string }) => {
      arrived.push(args);
      f.sessions[0].checkpoint += 1;
      route.currentIndex += 1;
      route.currentCheckpoint = f.sessions[0].checkpoint;
      Object.assign(f.sessions[0], { headSha: args.headSha, coverage: args.coverage });
    } });
    return { ...f, route, arrived };
  }

  it('returns route order, derived status and destination without changing evidence', () => {
    const f = seeded(0);
    expect(routeSnapshot(f.conn, 1n)).toMatchObject({
      destinationId: '6', complete: false, arrived: 1,
      waypoints: [{ nodeId: '5', status: 'current' }, { nodeId: '6', status: 'pending' }],
    });
    f.route.currentIndex = 1;
    expect(routeSnapshot(f.conn, 1n)).toMatchObject({ complete: true, arrived: 2, waypoints: [{ status: 'done' }, { status: 'current' }] });
    expect(f.edges).toEqual([]);
    expect(routeSnapshot(f.conn, 999n)).toBeNull();
  });

  it('returns the original arrival checkpoint on retry without git or a write, even after reroute', async () => {
    const f = seeded(0);
    f.route.revision = 7;
    const git = fakeGit({ head: () => { throw new Error('must not call git'); } });
    const result = await arriveFlow({ boardId: 1n, nodeId: 5n }, { ...localDeps, call: f.call, git });
    expect(result).toMatchObject({ checkpoint: 2, existing: true });
    expect(f.arrived).toEqual([]);
    expect(f.calls).toEqual([]);
  });

  it('rejects an out-of-order stop and a done stop before any checkpoint', async () => {
    const f = seeded();
    await expect(arriveFlow({ boardId: 1n, nodeId: 6n }, { ...localDeps, call: f.call, git: fakeGit() })).rejects.toThrow('next waypoint');
    f.route.currentIndex = 1;
    await expect(arriveFlow({ boardId: 1n, nodeId: 5n }, { ...localDeps, call: f.call, git: fakeGit() })).rejects.toThrow('already done');
    expect(f.sessions[0].checkpoint).toBe(3);
    expect(f.arrived).toEqual([]);
  });

  it('uses checkpoint preparation and sends the original revision and checkpoint to the atomic arrival', async () => {
    const f = seeded();
    const result = await arriveFlow({ boardId: 1n, nodeId: 5n }, { ...localDeps, call: f.call, git: fakeGit(), progress: new Map() });
    expect(f.arrived).toEqual([expect.objectContaining({ boardId: 1n, nodeId: 5n, expectedRevision: 2, expectedCheckpoint: 3 })]);
    expect(result).toMatchObject({ checkpoint: 4, existing: false, route: { arrived: 1 } });
    expect(f.calls.some(c => c.name === 'markCheckpoint')).toBe(false);
  });

  it('returns committed coverage when a concurrent arrival wins the same waypoint', async () => {
    const f = seeded();
    const coverage = { changed: 1, uncovered: [], excluded: [{ reason: 'concurrent winner', paths: ['other.ts'] }], deleted: [] };
    Object.assign(f.conn.reducers, { arriveAtCheckpoint: async () => {
      f.route.currentIndex = 0;
      f.route.currentCheckpoint = 4;
      Object.assign(f.sessions[0], { checkpoint: 4, headSha: 'b'.repeat(40), coverage: JSON.stringify(coverage) });
    } });
    const result = await arriveFlow({ boardId: 1n, nodeId: 5n }, { ...localDeps, call: f.call, git: fakeGit(), progress: new Map() });
    expect(result).toMatchObject({ checkpoint: 4, existing: true, coverage, headSha: 'b'.repeat(40) });
  });

  it('omits a later checkpoint\'s coverage when recovering an earlier arrival', async () => {
    const f = seeded();
    Object.assign(f.conn.db, { visibleRouteEvent: { iter: () => [{ id: 1n, boardId: 1n, kind: 'arrive', revision: 2, nodeId: 5n, nodeIds: [5n, 6n], reason: '', checkpoint: 4 }] } });
    Object.assign(f.conn.reducers, { arriveAtCheckpoint: async () => {
      f.route.currentIndex = 0;
      f.route.currentCheckpoint = 4;
      f.sessions[0].checkpoint = 5;
    } });
    const result = await arriveFlow({ boardId: 1n, nodeId: 5n }, { ...localDeps, call: f.call, git: fakeGit(), progress: new Map() });
    expect(result).toMatchObject({ checkpoint: 4, existing: true });
    expect(result).not.toHaveProperty('coverage');
    expect(result).not.toHaveProperty('headSha');
  });

  it('discloses missing or hidden waypoints and refuses to arrive there', async () => {
    const f = seeded();
    Object.assign(f.nodes[0], { hidden: true });
    expect(routeSnapshot(f.conn, 1n)).toMatchObject({ waypoints: [{ hidden: true, missing: false }, { missing: false }] });
    await expect(arriveFlow({ boardId: 1n, nodeId: 5n }, { ...localDeps, call: f.call, git: fakeGit() })).rejects.toThrow('hidden');
    f.nodes.splice(0, 1);
    expect(routeSnapshot(f.conn, 1n)).toMatchObject({ waypoints: [{ missing: true }, { missing: false }] });
    await expect(arriveFlow({ boardId: 1n, nodeId: 5n }, { ...localDeps, call: f.call, git: fakeGit() })).rejects.toThrow('does not exist');
    expect(f.sessions[0].checkpoint).toBe(3);
  });
});

// changed: the paths that differ from the base, as sure candidates (most tests);
// override changeCandidates to exercise the content check.
type FakeGitOver = Partial<GitOps> & { changed?: (root: string, baseSha: string, timeoutMs?: number) => string[] };
function fakeGit(over: FakeGitOver = {}): GitOps & { log: string[]; hashed: string[][] } {
  const log: string[] = [];
  const hashed: string[][] = [];
  const { changed, ...rest } = over;
  const git: GitOps & { log: string[]; hashed: string[][] } = {
    log,
    hashed,
    topLevel: r => r,
    head: () => 'a'.repeat(40),
    listTracked: () => [],
    changeCandidates: (r, b, ms) => (changed ? changed(r, b, ms) : []).map(path => ({ path, sure: true })),
    confirmChanged: (_r, _b, paths) => new Map(paths.map(p => [p, { changed: true }])),
    indexPath: () => '.git/index',
    deleted: () => [],
    untracked: () => [],
    hashObject: (_r, rel) => `sha-${rel}`,
    isCitable: () => true,
    hunks: (_r, _b, rel) => {
      log.push(`hunks ${rel}`);
      return [];
    },
    spelling: (_r, rel) => rel,
    // one batch per call, each file hashed like hashObject (so its overrides apply)
    hashFiles: (r, rels) => {
      hashed.push(rels);
      return rels.map(rel => git.hashObject(r, rel, Buffer.alloc(0)));
    },
    ...rest,
  };
  return git;
}

// stamps: give each file a stat stamp that changes with its text, as readSource does
function fakeSource(files: Record<string, string>, opts: { stamps?: boolean } = {}) {
  return (repoRoot: string, asked: string): SourceFile => {
    const rel = posix.normalize(asked); // the real readSource canonicalises through realpath
    if (!(rel in files)) throw new MissingFileError(asked);
    const text = files[rel];
    const lines = text.split(/\r?\n/);
    if (lines[lines.length - 1] === '') lines.pop();
    const stamp = opts.stamps ? `${rel}:${text}` : undefined;
    return { abs: `${repoRoot}/${rel}`, rel, bytes: Buffer.from(text), text, lines, stamp };
  };
}

const okRange = (startLine: number, endLine: number, name: string): ResolveResult => ({ ok: true, startLine, endLine, kind: 'function', name });

// ---------- helpers ----------

describe('symbolNeedle / fitSnippet / describeResolveFailure', () => {
  it('symbolNeedle is the resolver rule: last dotted segment, whole when undotted', () => {
    expect(symbolNeedle('Editor.handles')).toBe('handles');
    expect(symbolNeedle('gitHead')).toBe('gitHead');
  });
  it('fitSnippet clamps to 60 lines and 4000 chars, reporting the original end', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
    expect(fitSnippet('a.ts', lines, 1, 100)).toMatchObject({ startLine: 1, endLine: 60, clampedFrom: 100 });
    expect(fitSnippet('a.ts', lines, 1, 100).text.split('\n')).toHaveLength(60);
    expect(fitSnippet('a.ts', lines, 5, 7)).toEqual({ startLine: 5, endLine: 7, text: 'line 5\nline 6\nline 7', clampedFrom: undefined });
    const wide = Array.from({ length: 10 }, () => 'x'.repeat(1000));
    expect(fitSnippet('a.ts', wide, 1, 10)).toMatchObject({ endLine: 3, clampedFrom: 10 }); // 3 lines = 3002 chars fit; 4 lines = 4003 do not
    expect(() => fitSnippet('a.ts', ['y'.repeat(4001)], 1, 1)).toThrow(/line 1 of a.ts alone exceeds 4000 chars/);
    expect(() => fitSnippet('a.ts', lines, 1, 101)).toThrow("endLine 101 exceeds the line count of 'a.ts' (100 lines)");
  });
  it('describeResolveFailure renders every failure as an actionable sentence', () => {
    expect(describeResolveFailure({ ok: false, reason: 'unsupported_language', ext: '.go' }, 'Run', 'cmd/main.go')).toBe(
      "'.go' files are not resolvable; pass startLine and endLine for cmd/main.go"
    );
    expect(describeResolveFailure({ ok: false, reason: 'parse_error', message: "1:14 '}' expected." }, 'f', 'b.ts')).toBe(
      "b.ts does not parse (1:14 '}' expected.); fix the syntax error, then add the ref again"
    );
  });
  it('an ambiguous undotted name of namespace, interface or class blocks points at their members (G1)', () => {
    expect(
      describeResolveFailure({ ok: false, reason: 'ambiguous', candidates: [{ name: 'Q', kind: 'interface', startLine: 1, endLine: 1 }, { name: 'Q', kind: 'interface', startLine: 2, endLine: 2 }] }, 'Q', 'a.ts')
    ).toBe("ambiguous: 'Q' matches 2 declarations in a.ts: interface Q 1-1, interface Q 2-2; they share one name, so neither block can be cited whole — cite their members (Q.member) instead");
    expect(
      describeResolveFailure({ ok: false, reason: 'ambiguous', candidates: [{ name: 'NS', kind: 'namespace', startLine: 1, endLine: 3 }, { name: 'NS', kind: 'function+namespace', startLine: 4, endLine: 8 }] }, 'NS', 'a.ts')
    ).toMatch(/cite their members \(NS\.member\) instead$/);
    // a value repeat (a JS redeclaration) has no members to cite
    expect(
      describeResolveFailure({ ok: false, reason: 'ambiguous', candidates: [{ name: 'x', kind: 'const', startLine: 1, endLine: 1 }, { name: 'x', kind: 'class', startLine: 2, endLine: 2 }] }, 'x', 'a.js')
    ).toMatch(/so they cannot be cited — exclude a\.js at mark_checkpoint with a reason$/);
  });
  it('never tells the model to pass a range for a TS/JS file (F1)', () => {
    const texts = [
      describeResolveFailure({ ok: false, reason: 'ambiguous', candidates: [{ name: 'I', kind: 'interface', startLine: 1, endLine: 1 }, { name: 'I', kind: 'interface', startLine: 2, endLine: 2 }] }, 'I', 'a.ts'),
      describeResolveFailure({ ok: false, reason: 'not_found', suggestions: [] }, 'inner', 'a.ts'),
      describeResolveFailure({ ok: false, reason: 'not_found', suggestions: ['C.inner'] }, 'inner', 'a.ts'),
      describeResolveFailure({ ok: false, reason: 'parse_error', message: 'x' }, 'f', 'a.ts'),
    ];
    for (const t of texts) expect(t).not.toMatch(/startLine|endLine|range/);
  });
});

describe('ensureRepoPath', () => {
  it('is a no-op when a citable path is already registered for the board', async () => {
    const f = fakeConn({ repoFiles: [{ id: 1n, boardId: 1n, path: 'a.ts' }] });
    await ensureRepoPath({ ...localDeps, call: f.call, git: fakeGit() }, 1n, '/r', 'a.ts');
    expect(f.calls).toEqual([]);
  });
  it('refuses a registered path git would not list: any board writer can register a path (P2)', async () => {
    const f = fakeConn({ repoFiles: [{ id: 1n, boardId: 1n, path: 'ignored.json' }] });
    await expect(ensureRepoPath({ ...localDeps, call: f.call, git: fakeGit({ isCitable: () => false }) }, 1n, '/r', 'ignored.json')).rejects.toThrow(
      /is not citable/
    );
    expect(f.calls).toEqual([]);
  });
  it('returns the canonical path and registers that spelling, not the one given (F4)', async () => {
    const f = fakeConn();
    const canon = await ensureRepoPath(
      { ...localDeps, call: f.call, git: fakeGit({ isCitable: (_r, rel) => rel === 'src/a.ts' }), canonicalPath: (_r, p) => posix.normalize(p) },
      1n,
      '/r',
      './src//a.ts'
    );
    expect(canon).toBe('src/a.ts');
    expect(f.calls).toEqual([{ name: 'addRepoFiles', args: { boardId: 1n, paths: ['src/a.ts'] } }]);
  });
  it('registers a citable path and refuses an uncitable one', async () => {
    const f = fakeConn();
    await ensureRepoPath({ ...localDeps, call: f.call, git: fakeGit({ isCitable: (_r, rel) => rel === 'ok.ts' }) }, 1n, '/r', 'ok.ts');
    expect(f.calls).toEqual([{ name: 'addRepoFiles', args: { boardId: 1n, paths: ['ok.ts'] } }]);
    await expect(ensureRepoPath({ ...localDeps, call: f.call, git: fakeGit({ isCitable: () => false }) }, 1n, '/r', 'node_modules/x.js')).rejects.toThrow(
      "path 'node_modules/x.js' is not citable: it must be tracked by git, or untracked and not ignored, under /r"
    );
  });
});

describe('startSessionFlow', () => {
  const base = { force: false, clientUrl: 'http://localhost:5173', dbName: 'redcrayon' };

  it('normalises the root, records baseSha, creates board+session, seeds tracked files in chunks of 200', async () => {
    const tracked = Array.from({ length: 250 }, (_, i) => `src/f${i}.ts`);
    const git = fakeGit({ topLevel: () => '/work/link-repo', listTracked: () => tracked, head: () => 'b'.repeat(40) });
    const f = fakeConn();
    const res = await startSessionFlow(
      { ...base, name: 'feat/x', repoRoot: '/work/link-repo/sub', activeBoardId: undefined },
      { ...localDeps, call: f.call, git, realpath: p => p.replace('link-repo', 'repo') }
    );
    expect(f.boards).toEqual([{ id: 100n, name: 'feat/x' }]);
    expect(f.sessions[0]).toMatchObject({ boardId: 100n, repoRoot: '/work/repo', baseSha: 'b'.repeat(40), checkpoint: 0 });
    const adds = f.calls.filter(c => c.name === 'addRepoFiles').map(c => (c.args as { paths: string[] }).paths.length);
    expect(adds).toEqual([200, 50]);
    expect(f.repoFiles).toHaveLength(250);
    expect(res).toEqual({ boardId: 100n, sessionId: 101n, board: 'feat/x', id: '100', repoRoot: '/work/repo', checkpoint: 0, url: `http://localhost:5173/#b=${slugOf(100n)}`, seeded: 250 });
  });

  it('re-adopts an existing session board by name and seeds only the missing paths', async () => {
    const tracked = Array.from({ length: 250 }, (_, i) => `src/f${i}.ts`);
    const f = fakeConn({
      boards: [{ id: 7n, name: 'feat/x' }],
      sessions: [{ id: 8n, boardId: 7n, repoRoot: '/work/repo', baseSha: 'c'.repeat(40), headSha: '', checkpoint: 2, coverage: '{}' }],
      repoFiles: tracked.slice(0, 30).map((p, i) => ({ id: BigInt(i), boardId: 7n, path: p })),
    });
    const res = await startSessionFlow(
      { ...base, name: 'feat/x', repoRoot: '/work/repo', activeBoardId: undefined },
      { ...localDeps, call: f.call, git: fakeGit({ listTracked: () => tracked }), realpath: p => p }
    );
    expect(f.calls.filter(c => c.name === 'startSession')).toHaveLength(1);
    const adds = f.calls.filter(c => c.name === 'addRepoFiles').map(c => (c.args as { paths: string[] }).paths.length);
    expect(adds).toEqual([200, 20]);
    expect(res).toMatchObject({ boardId: 7n, sessionId: 8n, id: '7', checkpoint: 2, seeded: 220 });
  });

  it('resumed after a Claude Code restart: the same name returns the same board id and seeds no duplicate repoFile rows', async () => {
    // the cache already holds the board, its session row and 3 repoFile rows that equal git ls-files
    const tracked = ['a.ts', 'b.ts', 'c.ts'];
    const f = fakeConn({
      boards: [{ id: 7n, name: 'feat/x' }],
      sessions: [{ id: 8n, boardId: 7n, repoRoot: '/work/repo', baseSha: 'c'.repeat(40), headSha: 'd'.repeat(40), checkpoint: 2, coverage: '{}' }],
      repoFiles: tracked.map((p, i) => ({ id: BigInt(i + 1), boardId: 7n, path: p })),
    });
    const res = await startSessionFlow(
      { ...base, name: 'feat/x', repoRoot: '/work/repo', activeBoardId: undefined },
      { ...localDeps, call: f.call, git: fakeGit({ listTracked: () => tracked }), realpath: p => p }
    );
    expect(res).toMatchObject({ boardId: 7n, id: '7', checkpoint: 2, seeded: 0, url: `http://localhost:5173/#b=${slugOf(7n)}` });
    expect(f.boards).toHaveLength(1);
    expect(f.sessions).toHaveLength(1);
    expect(f.repoFiles).toHaveLength(3);
    expect(f.calls.map(c => c.name)).toEqual(['startSession']); // no addRepoFiles at all
  });

  it('re-adopts the same-named board that HAS a session row, not the first same-named board (F3)', async () => {
    const f = fakeConn({
      boards: [{ id: 3n, name: 'feat/x' }, { id: 7n, name: 'feat/x' }], // 3 is a hand-made board created later via createBoard
      sessions: [{ id: 8n, boardId: 7n, repoRoot: '/work/repo', baseSha: 'c'.repeat(40), headSha: '', checkpoint: 1, coverage: '{}' }],
    });
    const res = await startSessionFlow({ ...base, name: 'feat/x', repoRoot: '/work/repo', activeBoardId: undefined }, { ...localDeps, call: f.call, git: fakeGit(), realpath: p => p });
    expect(res).toMatchObject({ boardId: 7n, id: '7', repoRoot: '/work/repo', checkpoint: 1 });
  });

  it("re-adopts a session board it edits for its owner ('grant'), this checkout's when the name repeats", async () => {
    const f = fakeConn({
      boards: [{ id: 5n, name: 'feat/x', access: 'grant' }, { id: 7n, name: 'feat/x', access: 'grant' }],
      sessions: [
        { id: 6n, boardId: 5n, repoRoot: '/other/checkout', baseSha: 'c'.repeat(40), headSha: '', checkpoint: 4, coverage: '{}' },
        { id: 8n, boardId: 7n, repoRoot: '/work/repo', baseSha: 'c'.repeat(40), headSha: '', checkpoint: 1, coverage: '{}' },
      ],
    });
    const res = await startSessionFlow({ ...base, name: 'feat/x', repoRoot: '/work/repo', activeBoardId: undefined }, { ...localDeps, call: f.call, git: fakeGit(), realpath: p => p });
    expect(res).toMatchObject({ boardId: 7n, sessionId: 8n, repoRoot: '/work/repo', checkpoint: 1 });
    expect(f.boards).toHaveLength(2);
  });

  it('surfaces the module refusal when the same-named session belongs to another checkout (F3)', async () => {
    const f = fakeConn({
      boards: [{ id: 7n, name: 'feat/x' }],
      sessions: [{ id: 8n, boardId: 7n, repoRoot: '/old/checkout', baseSha: 'c'.repeat(40), headSha: '', checkpoint: 1, coverage: '{}' }],
    });
    await expect(
      startSessionFlow({ ...base, name: 'feat/x', repoRoot: '/new/checkout', activeBoardId: undefined }, { ...localDeps, call: f.call, git: fakeGit(), realpath: p => p })
    ).rejects.toThrow("session board 'feat/x' belongs to /old/checkout; start_session from that checkout or choose another name");
    expect(f.calls.map(c => c.name)).toEqual(['startSession']);
  });

  it('surfaces the module refusal for a name only a hand-made board uses, with the name and a next step (G21)', async () => {
    const f = fakeConn({ boards: [{ id: 3n, name: 'feat/x' }] });
    await expect(
      startSessionFlow({ ...base, name: 'feat/x', repoRoot: '/r', activeBoardId: undefined }, { ...localDeps, call: f.call, git: fakeGit(), realpath: p => p })
    ).rejects.toThrow(
      "board 'feat/x' already exists without a session (someone made it by hand); call start_session with another name, e.g. 'feat/x-session'"
    );
    expect(f.sessions).toEqual([]);
    expect(f.calls.map(c => c.name)).toEqual(['startSession']);
  });

  it('rejects an empty, multi-line or over-long name before any call, with the module text (F5)', async () => {
    for (const name of ['', 'feat/x\nsecond line', 'tab\there', 'x'.repeat(101)]) {
      const f = fakeConn();
      await expect(
        startSessionFlow({ ...base, name, repoRoot: '/r', activeBoardId: undefined }, { ...localDeps, call: f.call, git: fakeGit(), realpath: p => p })
      ).rejects.toThrow('session name must be one short line, e.g. the git branch');
      expect(f.calls).toEqual([]);
    }
    const ok = fakeConn();
    await expect(
      startSessionFlow({ ...base, name: 'x'.repeat(100), repoRoot: '/r', activeBoardId: undefined }, { ...localDeps, call: ok.call, git: fakeGit(), realpath: p => p })
    ).resolves.toMatchObject({ board: 'x'.repeat(100) });
  });

  it('rejects when a different session is active on this process unless force', async () => {
    const seed = () =>
      fakeConn({
        boards: [{ id: 7n, name: 'other' }],
        sessions: [{ id: 8n, boardId: 7n, repoRoot: '/r', baseSha: 'c'.repeat(40), headSha: '', checkpoint: 0, coverage: '{}' }],
      });
    const f1 = seed();
    await expect(
      startSessionFlow({ ...base, name: 'feat/x', repoRoot: '/r', activeBoardId: 7n }, { ...localDeps, call: f1.call, git: fakeGit(), realpath: p => p })
    ).rejects.toThrow('a session is already active on board "other"; pass force: true to switch boards');
    const f2 = seed();
    await expect(
      startSessionFlow({ ...base, name: 'feat/x', repoRoot: '/r', activeBoardId: 7n, force: true }, { ...localDeps, call: f2.call, git: fakeGit(), realpath: p => p })
    ).resolves.toMatchObject({ board: 'feat/x' });
    const f3 = seed();
    await expect(
      startSessionFlow({ ...base, name: 'other', repoRoot: '/r', activeBoardId: 7n }, { ...localDeps, call: f3.call, git: fakeGit(), realpath: p => p })
    ).resolves.toMatchObject({ boardId: 7n });
  });

  it('stops seeding at the 12 s budget, says how far it got, and a second call finishes the rest (G15)', async () => {
    const tracked = Array.from({ length: 500 }, (_, i) => `src/f${i}.ts`); // chunks of 200, 200, 100
    const f = fakeConn();
    let t = 0;
    const slow = f.conn.reducers.addRepoFiles;
    f.conn.reducers.addRepoFiles = async a => {
      t += 7000; // each chunk takes 7 s
      return slow(a);
    };
    const deps = { ...localDeps, call: f.call, git: fakeGit({ listTracked: () => tracked }), realpath: (p: string) => p, now: () => t };
    const input = { ...base, name: 'feat/x', repoRoot: '/r', activeBoardId: undefined };
    await expect(startSessionFlow(input, deps)).rejects.toThrow('processed 2 of 3 repo file chunks; call again to continue');
    expect(f.repoFiles).toHaveLength(400);
    await expect(startSessionFlow(input, deps)).resolves.toMatchObject({ boardId: 100n, seeded: 100 });
    expect(f.repoFiles).toHaveLength(500);
  });

  it('start_session: one deadline from entry; git and reducer calls get the time left before the cut-off, never under 2 s for a write (G15)', async () => {
    const tracked = Array.from({ length: 500 }, (_, i) => `src/f${i}.ts`);
    const f = fakeConn();
    let t = 0;
    const seen: string[] = [];
    const call: Call = (label, fn, timeoutMs) => {
      if (timeoutMs !== undefined) seen.push(`${label} ${timeoutMs}`);
      if (label === 'add_repo_files') t += 1000;
      return fn(f.conn);
    };
    const git = fakeGit({
      topLevel: (r, ms) => (seen.push(`topLevel ${ms}`), r),
      head: (_r, ms) => (seen.push(`head ${ms}`), 'a'.repeat(40)),
      listTracked: (_r, ms) => {
        seen.push(`listTracked ${ms}`);
        t += 11500; // a slow ls-files uses up most of the budget
        return tracked;
      },
    });
    await expect(
      startSessionFlow({ ...base, name: 'feat/x', repoRoot: '/r', activeBoardId: undefined }, { ...localDeps, call, git, realpath: p => p, now: () => t })
    ).rejects.toThrow('processed 1 of 3 repo file chunks; call again to continue');
    expect(seen).toEqual(['topLevel 14000', 'head 14000', 'start_session 14000', 'listTracked 14000', 'add_repo_files 2500']);
  });

  it('start_session: git that leaves no time for the first write stops before it (G15 review)', async () => {
    const f = fakeConn();
    let t = 0;
    const git = fakeGit({
      head: () => {
        t += 12500;
        return 'a'.repeat(40);
      },
    });
    await expect(
      startSessionFlow({ ...base, name: 'feat/x', repoRoot: '/r', activeBoardId: undefined }, { ...localDeps, call: f.call, git, realpath: p => p, now: () => t })
    ).rejects.toThrow('git took most of the time budget before start_session could write; call again to continue');
    expect(f.calls).toEqual([]);
  });

  it('does not treat a non-session active board (SPACETIME_BOARD) as an active session', async () => {
    const f = fakeConn({ boards: [{ id: 3n, name: 'Demo' }] });
    await expect(
      startSessionFlow({ ...base, name: 'feat/x', repoRoot: '/r', activeBoardId: 3n }, { ...localDeps, call: f.call, git: fakeGit(), realpath: p => p })
    ).resolves.toMatchObject({ board: 'feat/x' });
  });

  it('adopts only its own session board: a same-named session board shared with it through a team is left alone (dashboard spec §4)', async () => {
    const f = fakeConn({
      boards: [{ id: 3n, name: 'feat/x', access: 'team' }], // a teammate's session board of the same name
      sessions: [{ id: 4n, boardId: 3n, repoRoot: '/r', baseSha: 'c'.repeat(40), headSha: '', checkpoint: 5, coverage: '{}' }],
    });
    const res = await startSessionFlow({ ...base, name: 'feat/x', repoRoot: '/r', activeBoardId: undefined }, { ...localDeps, call: f.call, git: fakeGit(), realpath: p => p });
    expect(res).toMatchObject({ boardId: 100n, sessionId: 101n, checkpoint: 0, url: `http://localhost:5173/#b=${slugOf(100n)}` });
  });

  it('says to retry when start_session committed but my_boards does not list the board yet', async () => {
    const f = fakeConn();
    f.conn.reducers.startSession = async () => {}; // committed, but no row reached this identity's my_boards
    await expect(
      startSessionFlow({ ...base, name: 'feat/x', repoRoot: '/r', activeBoardId: undefined }, { ...localDeps, call: f.call, git: fakeGit(), realpath: p => p })
    ).rejects.toThrow(`session board "feat/x" is not in this agent's board list (my_boards) after start_session; retry in a moment`);
  });

  it('on a module without my_boards, finds the same-named session board by name', async () => {
    const f = fakeConn({
      boards: [{ id: 3n, name: 'feat/x' }, { id: 5n, name: 'feat/x' }], // a hand-made plain board shares the name
      sessions: [{ id: 6n, boardId: 5n, repoRoot: '/r', baseSha: 'c'.repeat(40), headSha: '', checkpoint: 2, coverage: '{}' }],
    });
    f.conn.db.myBoards.iter = () => []; // not subscribed: the view does not exist there
    const res = await startSessionFlow(
      { ...base, name: 'feat/x', repoRoot: '/r', activeBoardId: undefined, myBoards: false },
      { ...localDeps, call: f.call, git: fakeGit(), realpath: p => p }
    );
    expect(res).toMatchObject({ boardId: 5n, sessionId: 6n, checkpoint: 2, url: `http://localhost:5173/#b=${slugOf(5n)}` });
  });
});

describe('addCodeRefFlow', () => {
  const TS = 'export function gitHead(root: string): string {\n  return root;\n}\n';
  const seed = () =>
    fakeConn({
      boards: [{ id: 1n, name: 's' }],
      nodes: [{ id: 5n, boardId: 1n }],
      repoFiles: [{ id: 1n, boardId: 1n, path: 'agent/src/git.ts' }],
    });

  it('resolves the symbol for a .ts file when the range is omitted, captures the snippet server-side, returns the new id', async () => {
    const f = seed();
    const git = fakeGit({ hashObject: (_r, rel, bytes) => `sha:${rel}:${bytes.length}` });
    const resolveSymbol = vi.fn((_abs: string, _src: string, _sym: string): ResolveResult => okRange(1, 3, 'gitHead'));
    const res = await addCodeRefFlow(
      { boardId: 1n, repoRoot: '/r', targetKind: 'node', targetId: 5n, path: 'agent/src/git.ts', symbol: 'gitHead' },
      { ...localDeps, call: f.call, git, readSource: fakeSource({ 'agent/src/git.ts': TS }), resolveSymbol }
    );
    expect(resolveSymbol).toHaveBeenCalledWith('/r/agent/src/git.ts', TS, 'gitHead');
    expect(f.codeRefs[0]).toMatchObject({
      boardId: 1n,
      targetKind: 'node',
      targetId: 5n,
      path: 'agent/src/git.ts',
      symbol: 'gitHead',
      startLine: 1,
      endLine: 3,
      blobSha: `sha:agent/src/git.ts:${Buffer.byteLength(TS)}`,
      snippet: TS.trimEnd(),
      author: '',
    });
    expect(res).toEqual({ id: 100n, path: 'agent/src/git.ts', startLine: 1, endLine: 3, clampedFrom: undefined, existing: false });
  });

  it('requires a range for non-resolvable extensions and uses a supplied range as given', async () => {
    const f = seed();
    const deps = { ...localDeps, call: f.call, git: fakeGit(), readSource: fakeSource({ 'cmd/main.go': 'package main\nfunc Run() {}\n' }) };
    await expect(
      addCodeRefFlow({ boardId: 1n, repoRoot: '/r', targetKind: 'node', targetId: 5n, path: 'cmd/main.go', symbol: 'Run' }, deps)
    ).rejects.toThrow("'.go' files are not resolvable; pass startLine and endLine for cmd/main.go");
    await expect(
      addCodeRefFlow({ boardId: 1n, repoRoot: '/r', targetKind: 'node', targetId: 5n, path: 'cmd/main.go', symbol: 'Run', startLine: 2 }, deps)
    ).rejects.toThrow('pass both startLine and endLine for cmd/main.go (got startLine=2, endLine=undefined)');
    const res = await addCodeRefFlow(
      { boardId: 1n, repoRoot: '/r', targetKind: 'node', targetId: 5n, path: 'cmd/main.go', symbol: 'Run', startLine: 2, endLine: 2, author: 'sub-a' },
      deps
    );
    expect(f.codeRefs[0]).toMatchObject({ snippet: 'func Run() {}', author: 'sub-a', startLine: 2, endLine: 2 });
    expect(res.id).toBe(f.codeRefs[0].id); // cmd/main.go was registered first (id 100n), so the ref is 101n
  });

  it('surfaces resolver failures as actionable sentences', async () => {
    const f = seed();
    const mk = (r: ResolveResult) => ({ ...localDeps, call: f.call, git: fakeGit(), readSource: fakeSource({ 'agent/src/git.ts': TS }), resolveSymbol: () => r });
    const input = { boardId: 1n, repoRoot: '/r', targetKind: 'node' as const, targetId: 5n, path: 'agent/src/git.ts', symbol: 'dup' };
    await expect(
      addCodeRefFlow(input, mk({ ok: false, reason: 'ambiguous', candidates: [{ name: 'dup', kind: 'function', startLine: 1, endLine: 1 }, { name: 'dup', kind: 'function', startLine: 2, endLine: 2 }] }))
    ).rejects.toThrow(
      "ambiguous: 'dup' matches 2 declarations in agent/src/git.ts: function dup 1-1, function dup 2-2; they share one name and no declaration encloses them, so they cannot be cited — exclude agent/src/git.ts at mark_checkpoint with a reason"
    );
    await expect(
      addCodeRefFlow(
        { ...input, symbol: 'C.m' },
        mk({ ok: false, reason: 'ambiguous', candidates: [{ name: 'C.m', kind: 'method', startLine: 2, endLine: 2 }, { name: 'C.m', kind: 'method', startLine: 3, endLine: 3 }] })
      )
    ).rejects.toThrow(
      "ambiguous: 'C.m' matches 2 declarations in agent/src/git.ts: method C.m 2-2, method C.m 3-3; they share one name, so neither can be cited alone — cite the enclosing 'C' instead"
    );
    await expect(addCodeRefFlow(input, mk({ ok: false, reason: 'not_found', suggestions: ['Editor.dup'] }))).rejects.toThrow(
      "not found: no top-level declaration or Class.member named 'dup' in agent/src/git.ts; did you mean Editor.dup?"
    );
    await expect(addCodeRefFlow(input, mk({ ok: false, reason: 'not_found', suggestions: [] }))).rejects.toThrow(
      "not found: no top-level declaration or Class.member named 'dup' in agent/src/git.ts; if it is nested or local, cite the declaration that encloses it; code outside every addressable declaration (a top-level call, an import or an export list) cannot be cited — exclude agent/src/git.ts at mark_checkpoint with a reason"
    );
    await expect(addCodeRefFlow(input, mk({ ok: false, reason: 'parse_error', message: "1:14 '}' expected." }))).rejects.toThrow(
      "agent/src/git.ts does not parse (1:14 '}' expected.); fix the syntax error, then add the ref again"
    );
    expect(f.calls).toEqual([]);
  });

  it('rejects when the symbol needle does not occur in the captured lines', async () => {
    const f = seed();
    await expect(
      addCodeRefFlow(
        { boardId: 1n, repoRoot: '/r', targetKind: 'node', targetId: 5n, path: 'cmd/main.go', symbol: 'Editor.nope', startLine: 2, endLine: 2 },
        { ...localDeps, call: f.call, git: fakeGit(), readSource: fakeSource({ 'cmd/main.go': 'package main\nfunc Run() {}\n' }) }
      )
    ).rejects.toThrow("symbol 'Editor.nope' does not occur in cmd/main.go:2-2; name the declaration that lives in that range");
  });

  it('refuses startLine/endLine for TS/JS files and names the enclosing declaration to cite instead (F1)', async () => {
    const f = seed();
    const src = 'export class Editor {\n  get handles(): number {\n    const inner = () => 1;\n    return inner();\n  }\n}\nconst top = 1;\n';
    const deps = { ...localDeps, call: f.call, git: fakeGit(), readSource: fakeSource({ 'agent/src/editor.ts': src }) };
    const input = { boardId: 1n, repoRoot: '/r', targetKind: 'node' as const, targetId: 5n, path: 'agent/src/editor.ts', symbol: 'inner' };
    await expect(addCodeRefFlow({ ...input, startLine: 3, endLine: 3 }, deps)).rejects.toThrow(
      "startLine/endLine are not accepted for .ts files: the server resolves the symbol and re-finds it by name at every checkpoint; cite symbol 'Editor.handles' (the declaration enclosing lines 3-3, at 2-5) and omit the range"
    );
    await expect(addCodeRefFlow({ ...input, startLine: 3 }, deps)).rejects.toThrow(/cite symbol 'Editor.handles'/);
    await expect(addCodeRefFlow({ ...input, path: 'agent/src/editor.ts', startLine: 6, endLine: 7 }, deps)).rejects.toThrow(
      "startLine/endLine are not accepted for .ts files: the server resolves the symbol and re-finds it by name at every checkpoint; no one declaration encloses lines 6-7 — cite each one they touch by name (Editor, top) and omit the range"
    );
    expect(f.calls).toEqual([]);
  });

  it('range refusal with no enclosing declaration names exclude (G1)', async () => {
    const f = seed();
    const src = "import { x } from 'y';\nserver.registerTool('t', {}, async () => {\n  return x;\n});\nexport function after() {}\n";
    const deps = { ...localDeps, call: f.call, git: fakeGit(), readSource: fakeSource({ 'agent/src/mcp.ts': src }) };
    const input = { boardId: 1n, repoRoot: '/r', targetKind: 'node' as const, targetId: 5n, path: 'agent/src/mcp.ts', symbol: 'registerTool' };
    await expect(addCodeRefFlow({ ...input, startLine: 2, endLine: 4 }, deps)).rejects.toThrow(
      "startLine/endLine are not accepted for .ts files: the server resolves the symbol and re-finds it by name at every checkpoint; lines 2-4 of agent/src/mcp.ts are outside every addressable declaration (a top-level call, an import or an export list); they cannot be cited — exclude agent/src/mcp.ts at mark_checkpoint with a reason"
    );
    // a range that also reaches a declaration names it, and says the rest cannot be cited
    await expect(addCodeRefFlow({ ...input, startLine: 3, endLine: 5 }, deps)).rejects.toThrow(
      "startLine/endLine are not accepted for .ts files: the server resolves the symbol and re-finds it by name at every checkpoint; no one declaration encloses lines 3-5 — cite each one they touch by name (after) and omit the range; the rest is outside every addressable declaration — exclude agent/src/mcp.ts at mark_checkpoint with a reason"
    );
    // an unparseable file is not "outside every declaration"
    const broken = { ...deps, readSource: fakeSource({ 'agent/src/mcp.ts': 'function f( {\n' }) };
    await expect(addCodeRefFlow({ ...input, startLine: 1, endLine: 1 }, broken)).rejects.toThrow(
      "startLine/endLine are not accepted for .ts files: the server resolves the symbol and re-finds it by name at every checkpoint; agent/src/mcp.ts does not parse, so no declaration can be named for lines 1-1; fix the syntax error, then cite the declaration that contains them and omit the range"
    );
    expect(f.calls).toEqual([]);
  });

  it('registers an unregistered citable path before adding, and refuses an uncitable one without writing', async () => {
    const f = fakeConn({ boards: [{ id: 1n, name: 's' }], nodes: [{ id: 5n, boardId: 1n }] });
    const src = fakeSource({ 'new.ts': 'function fresh() {}\n', 'node_modules/x.js': 'function fresh() {}\n' });
    await addCodeRefFlow(
      { boardId: 1n, repoRoot: '/r', targetKind: 'node', targetId: 5n, path: 'new.ts', symbol: 'fresh' },
      { ...localDeps, call: f.call, git: fakeGit({ isCitable: (_r, rel) => rel === 'new.ts' }), readSource: src }
    );
    expect(f.calls.map(c => c.name)).toEqual(['addRepoFiles', 'addCodeRef', 'setCodeRefHashes']);
    await expect(
      addCodeRefFlow(
        { boardId: 1n, repoRoot: '/r', targetKind: 'node', targetId: 5n, path: 'node_modules/x.js', symbol: 'fresh' },
        { ...localDeps, call: f.call, git: fakeGit({ isCitable: () => false }), readSource: src }
      )
    ).rejects.toThrow(/is not citable/);
    expect(f.calls.map(c => c.name)).toEqual(['addRepoFiles', 'addCodeRef', 'setCodeRefHashes']);
  });

  it('refuses to re-add or move an existing ref on a path git would not list (P2)', async () => {
    const f = seed();
    f.codeRefs.push({ id: 77n, boardId: 1n, targetKind: 'node', targetId: 5n, path: 'ignored.md', symbol: 'pw', startLine: 1, endLine: 1, blobSha: 'old', snippet: 'x', author: '', checkpoint: 1, status: 'ok' });
    const deps = { ...localDeps, call: f.call, git: fakeGit({ isCitable: () => false }), readSource: fakeSource({ 'ignored.md': 'x\npw = hunter2\n' }) };
    const input = { boardId: 1n, repoRoot: '/r', targetKind: 'node' as const, targetId: 5n, path: 'ignored.md', symbol: 'pw' };
    await expect(addCodeRefFlow({ ...input, startLine: 2, endLine: 2 }, deps)).rejects.toThrow(/is not citable/);
    await expect(addCodeRefFlow(input, deps)).rejects.toThrow(/is not citable/);
    expect(f.calls).toEqual([]);
  });

  it('never writes a snippet that looks like a secret, nor reads a secrets file, even one already registered', async () => {
    const key = 'sk_' + 'live_' + 'x1'.repeat(12); // split so no scanner flags this file
    const f = fakeConn({
      boards: [{ id: 1n, name: 's' }],
      nodes: [{ id: 5n, boardId: 1n }],
      repoFiles: ['src/billing.ts', '.env', 'config/.npmrc'].map((path, i) => ({ id: BigInt(i + 1), boardId: 1n, path })),
    });
    const readSource = fakeSource({ 'src/billing.ts': `// billing\nconst stripeKey = '${key}';\n`, '.env': 'DATABASE_URL=postgres://u:pass@host\n', 'config/.npmrc': '//r/:_authToken=abc\n' });
    const deps = { ...localDeps, call: guardSecrets(f.call), git: fakeGit(), readSource, resolveSymbol: () => okRange(2, 2, 'stripeKey') };
    const add = (path: string, symbol: string, range: { startLine?: number; endLine?: number } = {}) =>
      addCodeRefFlow({ boardId: 1n, repoRoot: '/r', targetKind: 'node', targetId: 5n, path, symbol, ...range }, deps);
    await expect(add('src/billing.ts', 'stripeKey')).rejects.toThrow(
      'REJECTED: src/billing.ts:2 looks like a secret (Stripe secret key). Nothing was written. Cite lines without secrets.'
    );
    await expect(add('.env', 'DATABASE_URL', { startLine: 1, endLine: 1 })).rejects.toThrow(
      'REJECTED: .env looks like a secrets file; code refs never read it. Nothing was written. Cite another file.'
    );
    await expect(add('config/.npmrc', '_authToken', { startLine: 1, endLine: 1 })).rejects.toThrow(/config\/\.npmrc looks like a secrets file/);
    await expect(ensureRepoPath({ ...deps, canonicalPath: (_r, p) => p }, 1n, '/r', '.env')).rejects.toThrow(/looks like a secrets file/);
    // create_edge's source line: refused before its path is registered
    const edge = { ...deps, readSource: fakeSource({ 'src/new.ts': `// billing\nconst stripeKey = '${key}';\n` }), budget: flowBudget(Date.now), canonicalPath: (_r: string, p: string) => p };
    await expect(prepareSourceEvidence(edge, 1n, '/r', 'source:src/new.ts:2')).rejects.toThrow('REJECTED: src/new.ts:2 looks like a secret (Stripe secret key).');
    expect(f.calls).toEqual([]);
  });

  it('stores the path as git prints it, whatever spelling the model used (F4)', async () => {
    const f = seed();
    const res = await addCodeRefFlow(
      { boardId: 1n, repoRoot: '/r', targetKind: 'node', targetId: 5n, path: './agent//src/../src/git.ts', symbol: 'gitHead' },
      { ...localDeps, call: f.call, git: fakeGit(), readSource: fakeSource({ 'agent/src/git.ts': TS }), resolveSymbol: () => okRange(1, 3, 'gitHead') }
    );
    expect(res.path).toBe('agent/src/git.ts');
    expect(f.codeRefs[0]).toMatchObject({ path: 'agent/src/git.ts' });
    expect(f.calls.map(c => c.name)).toEqual(['addCodeRef', 'setCodeRefHashes']); // already registered under the canonical spelling: no duplicate repoFile row
  });

  it('returns the existing ref for the same target/path/symbol without writing (F17)', async () => {
    const existing: CodeRefRow = {
      id: 77n, boardId: 1n, targetKind: 'node', targetId: 5n, path: 'agent/src/git.ts', symbol: 'gitHead',
      startLine: 1, endLine: 3, blobSha: 'old', snippet: 'x', author: '', checkpoint: 1, status: 'ok',
    };
    const f = fakeConn({
      boards: [{ id: 1n, name: 's' }],
      nodes: [{ id: 5n, boardId: 1n }, { id: 6n, boardId: 1n }],
      repoFiles: [{ id: 1n, boardId: 1n, path: 'agent/src/git.ts' }],
      codeRefs: [existing],
    });
    const deps = { ...localDeps, call: f.call, git: fakeGit(), readSource: fakeSource({ 'agent/src/git.ts': '\n' + TS }), resolveSymbol: () => okRange(2, 4, 'gitHead') };
    const res = await addCodeRefFlow({ boardId: 1n, repoRoot: '/r', targetKind: 'node', targetId: 5n, path: './agent/src/git.ts', symbol: 'gitHead' }, deps);
    expect(res).toEqual({ id: 77n, path: 'agent/src/git.ts', startLine: 1, endLine: 3, clampedFrom: undefined, existing: true });
    expect(f.calls).toEqual([]);
    // another node, or another symbol, is a new ref
    const other = await addCodeRefFlow({ boardId: 1n, repoRoot: '/r', targetKind: 'node', targetId: 6n, path: 'agent/src/git.ts', symbol: 'gitHead' }, deps);
    expect(other).toMatchObject({ existing: false, startLine: 2, endLine: 4 });
  });

  it('non-TS re-add with new range moves the ref (G18)', async () => {
    const md = '# Title\nintro\n## Limiter\nthe Limiter allows bursts\n';
    const existing: CodeRefRow = {
      id: 77n, boardId: 1n, targetKind: 'node', targetId: 5n, path: 'README.md', symbol: 'Limiter',
      startLine: 1, endLine: 2, blobSha: 'old', snippet: '# Limiter\nold', author: '', checkpoint: 1, status: 'stale',
    };
    const f = fakeConn({ boards: [{ id: 1n, name: 's' }], nodes: [{ id: 5n, boardId: 1n }], repoFiles: [{ id: 1n, boardId: 1n, path: 'README.md' }], codeRefs: [existing] });
    const deps = { ...localDeps, call: f.call, git: fakeGit(), readSource: fakeSource({ 'README.md': md }) };
    const input = { boardId: 1n, repoRoot: '/r', targetKind: 'node' as const, targetId: 5n, path: 'README.md', symbol: 'Limiter' };

    const res = await addCodeRefFlow({ ...input, startLine: 3, endLine: 4 }, deps);
    expect(res).toEqual({ id: 77n, path: 'README.md', startLine: 3, endLine: 4, clampedFrom: undefined, existing: true, moved: true });
    expect(f.calls).toEqual([
      { name: 'setCodeRefHashes', args: { refId: 77n, lineHashes: lineHashes(['## Limiter', 'the Limiter allows bursts']).join(' ') } },
      { name: 'updateCodeRef', args: { id: 77n, startLine: 3, endLine: 4, blobSha: 'sha-README.md', snippet: '## Limiter\nthe Limiter allows bursts', status: 'ok' } },
    ]);
    expect(f.codeRefs).toHaveLength(1);
    expect(addCodeRefText(res)).toBe('moved id=77 README.md:3-4');

    // the same range again is already attached and writes nothing
    const again = await addCodeRefFlow({ ...input, startLine: 3, endLine: 4 }, deps);
    expect(again).toEqual({ id: 77n, path: 'README.md', startLine: 3, endLine: 4, clampedFrom: undefined, existing: true });
    expect(addCodeRefText(again)).toBe('already attached id=77 README.md:3-4');
    expect(f.calls).toHaveLength(2);

    // a new range the symbol does not occur in is refused, and nothing moves
    await expect(addCodeRefFlow({ ...input, startLine: 1, endLine: 2 }, deps)).rejects.toThrow(
      "symbol 'Limiter' does not occur in README.md:1-2; name the declaration that lives in that range"
    );
    expect(f.calls).toHaveLength(2);
    expect(f.codeRefs[0]).toMatchObject({ startLine: 3, endLine: 4 });
  });

  it('uses the focus reducer for a range change initiated by add_code_ref', async () => {
    const f = fakeConn({ nodes: [{ id: 5n, boardId: 1n }], codeRefs: [{
      id: 77n, boardId: 1n, targetKind: 'node', targetId: 5n, path: 'README.md', symbol: 'Limiter',
      startLine: 1, endLine: 1, blobSha: 'old', snippet: 'Limiter old', author: '', checkpoint: 1, status: 'ok',
    }] });
    let followed = false;
    Object.assign(f.conn.reducers, { updateCodeRefAndFocus: async (a: unknown) => {
      followed = true;
      return f.conn.reducers.updateCodeRef(a as Parameters<typeof f.conn.reducers.updateCodeRef>[0]);
    } });
    await addCodeRefFlow(
      { boardId: 1n, repoRoot: '/r', targetKind: 'node', targetId: 5n, path: 'README.md', symbol: 'Limiter', startLine: 2, endLine: 2 },
      { ...localDeps, call: f.call, git: fakeGit(), readSource: fakeSource({ 'README.md': '# Title\nLimiter moved\n' }) }
    );
    expect(followed).toBe(true);
  });

  it('a TS/JS ref re-added with another range is already attached: it is re-found by name, never moved (G18)', async () => {
    const existing: CodeRefRow = {
      id: 77n, boardId: 1n, targetKind: 'node', targetId: 5n, path: 'agent/src/git.ts', symbol: 'gitHead',
      startLine: 1, endLine: 3, blobSha: 'old', snippet: TS.trimEnd(), author: '', checkpoint: 1, status: 'ok',
    };
    const f = fakeConn({ boards: [{ id: 1n, name: 's' }], nodes: [{ id: 5n, boardId: 1n }], codeRefs: [existing] });
    const res = await addCodeRefFlow(
      { boardId: 1n, repoRoot: '/r', targetKind: 'node', targetId: 5n, path: 'agent/src/git.ts', symbol: 'gitHead', startLine: 2, endLine: 3 },
      { ...localDeps, call: f.call, git: fakeGit(), readSource: fakeSource({ 'agent/src/git.ts': TS }) }
    );
    expect(res).toEqual({ id: 77n, path: 'agent/src/git.ts', startLine: 1, endLine: 3, clampedFrom: undefined, existing: true });
    expect(addCodeRefText(res)).toBe('already attached id=77 agent/src/git.ts:1-3');
    expect(f.calls).toEqual([]);
  });

  it('already attached reports stale status (G18)', async () => {
    const existing: CodeRefRow = {
      id: 77n, boardId: 1n, targetKind: 'node', targetId: 5n, path: 'agent/src/git.ts', symbol: 'gitHead',
      startLine: 1, endLine: 3, blobSha: 'old', snippet: 'x', author: '', checkpoint: 1, status: 'stale',
    };
    const f = fakeConn({ boards: [{ id: 1n, name: 's' }], nodes: [{ id: 5n, boardId: 1n }], codeRefs: [existing] });
    const res = await addCodeRefFlow(
      { boardId: 1n, repoRoot: '/r', targetKind: 'node', targetId: 5n, path: 'agent/src/git.ts', symbol: 'gitHead' },
      { ...localDeps, call: f.call, git: fakeGit(), readSource: fakeSource({ 'agent/src/git.ts': TS }), resolveSymbol: () => okRange(1, 3, 'gitHead') }
    );
    expect(res).toEqual({ id: 77n, path: 'agent/src/git.ts', startLine: 1, endLine: 3, clampedFrom: undefined, existing: true, status: 'stale' });
    expect(f.calls).toEqual([]);
    expect(addCodeRefText(res)).toBe(
      'already attached id=77 agent/src/git.ts:1-3 status=stale (remove_code_ref then add_code_ref under the current name)'
    );
    expect(addCodeRefText({ id: 9n, path: 'a.ts', startLine: 1, endLine: 60, clampedFrom: 90, existing: false })).toBe('committed id=9 a.ts:1-60 (clamped from 90)');
  });

  it('turns a server-side "already attached" (a concurrent or timed-out-then-landed write) into the existing ref (F17)', async () => {
    const f = seed();
    f.conn.reducers.addCodeRef = async a => {
      f.codeRefs.push({ id: 88n, ...a, checkpoint: 1, status: 'ok' }); // landed earlier, invisible to the pre-check
      throw new Error(`already attached id=88 ${a.path}:${a.startLine}-${a.endLine}`);
    };
    const res = await addCodeRefFlow(
      { boardId: 1n, repoRoot: '/r', targetKind: 'node', targetId: 5n, path: 'agent/src/git.ts', symbol: 'gitHead' },
      { ...localDeps, call: f.call, git: fakeGit(), readSource: fakeSource({ 'agent/src/git.ts': TS }), resolveSymbol: () => okRange(1, 3, 'gitHead') }
    );
    expect(res).toMatchObject({ id: 88n, path: 'agent/src/git.ts', startLine: 1, endLine: 3, existing: true });
  });

  it('clamps a long resolved range to 60 lines and reports it', async () => {
    const f = seed();
    const long = Array.from({ length: 100 }, (_, i) => (i === 0 ? 'function big() {' : i === 99 ? '}' : `  // ${i}`)).join('\n') + '\n';
    const res = await addCodeRefFlow(
      { boardId: 1n, repoRoot: '/r', targetKind: 'node', targetId: 5n, path: 'agent/src/git.ts', symbol: 'big' },
      { ...localDeps, call: f.call, git: fakeGit(), readSource: fakeSource({ 'agent/src/git.ts': long }), resolveSymbol: () => okRange(1, 100, 'big') }
    );
    expect(res).toMatchObject({ startLine: 1, endLine: 60, clampedFrom: 100 });
    expect(f.codeRefs[0].snippet.split('\n')).toHaveLength(60);
  });
});

describe('add_code_ref and create_edge answer within 15 s, saying what was written (G15 review)', () => {
  const TS = 'export function gitHead(root: string): string {\n  return root;\n}\n';
  // A clock, a fake call that charges writes to it and records their timeouts.
  function slow(opts: { writeMs?: Record<string, number> } = {}) {
    const f = fakeConn({ boards: [{ id: 1n, name: 's' }], nodes: [{ id: 5n, boardId: 1n }] });
    const clock = { t: 0 };
    const timeouts: string[] = [];
    const call: Call = (label, fn, timeoutMs) => {
      if (timeoutMs !== undefined) timeouts.push(`${label} ${timeoutMs}`);
      clock.t += opts.writeMs?.[label] ?? 0;
      return fn(f.conn);
    };
    return { f, clock, timeouts, call, now: () => clock.t };
  }
  const input = { boardId: 1n, repoRoot: '/r', targetKind: 'node' as const, targetId: 5n, path: 'agent/src/git.ts', symbol: 'gitHead' };
  const NOTHING = /^add_code_ref ran out of time before writing anything \(git was slow\); nothing was written, so calling again is safe$/;

  it('slow git: no write starts with under 2 s left; nothing was written, and the answer says so', async () => {
    const s0 = slow();
    const git = fakeGit({
      spelling: (_r, rel) => {
        s0.clock.t += 12_500; // git takes most of the budget
        return rel;
      },
    });
    const deps = { ...localDeps, call: s0.call, git, readSource: fakeSource({ 'agent/src/git.ts': TS }), resolveSymbol: () => okRange(1, 3, 'gitHead'), now: s0.now };
    await expect(addCodeRefFlow(input, deps)).rejects.toThrow(/^ran out of time \(git was slow\) before registering agent\/src\/git\.ts; nothing was written, so calling again is safe$/);
    expect(s0.f.calls).toEqual([]);
  });

  it('a git call cut short by the deadline answers the same; the full git timeout keeps its text', async () => {
    const s0 = slow();
    const cut = fakeGit({
      hashObject: () => {
        throw new GitTimeoutError('git unavailable or not a repo: git hash-object timed out after 1.5 s in /r; …', 'git hash-object timed out after 1.5 s', true);
      },
    });
    const deps = { ...localDeps, call: s0.call, readSource: fakeSource({ 'agent/src/git.ts': TS }), resolveSymbol: () => okRange(1, 3, 'gitHead'), now: s0.now };
    await expect(addCodeRefFlow(input, { ...deps, git: cut })).rejects.toThrow(NOTHING);
    const hung = fakeGit({
      hashObject: () => {
        throw new GitTimeoutError('git unavailable or not a repo: git hash-object timed out after 10 s in /r; a clean filter (git-lfs) or fsmonitor hook may be hanging — retry or check git config', 'git hash-object timed out after 10 s', false);
      },
    });
    await expect(addCodeRefFlow(input, { ...deps, git: hung })).rejects.toThrow(/^git unavailable or not a repo: git hash-object timed out after 10 s/);
    expect(s0.f.calls).toEqual([]);
  });

  it('slow reducer: the path is registered, the ref is not, and the answer says exactly that; calling again writes only the ref', async () => {
    const s0 = slow({ writeMs: { add_repo_files: 12_500 } });
    const deps = { ...localDeps, call: s0.call, git: fakeGit(), readSource: fakeSource({ 'agent/src/git.ts': TS }), resolveSymbol: () => okRange(1, 3, 'gitHead'), now: s0.now };
    await expect(addCodeRefFlow(input, deps)).rejects.toThrow(
      /^agent\/src\/git\.ts is registered for this board, but time ran out before the code ref was written; nothing else was written, so calling again is safe$/
    );
    expect(s0.f.calls.map(c => c.name)).toEqual(['addRepoFiles']);
    const res = await addCodeRefFlow(input, deps); // a new call, a new budget
    expect(res).toMatchObject({ existing: false, path: 'agent/src/git.ts' });
    expect(s0.f.calls.map(c => c.name)).toEqual(['addRepoFiles', 'addCodeRef', 'setCodeRefHashes']); // the path is not registered twice
  });

  it('slow hash write: the ref lands, its line hashes do not, and the answer says so; calling again fills them and writes nothing else', async () => {
    const s0 = slow({ writeMs: { add_code_ref: 12_500 } });
    const deps = { ...localDeps, call: s0.call, git: fakeGit(), readSource: fakeSource({ 'agent/src/git.ts': TS }), resolveSymbol: () => okRange(1, 3, 'gitHead'), now: s0.now };
    await expect(addCodeRefFlow(input, deps)).rejects.toThrow(
      /^add_code_ref wrote code ref \d+ for agent\/src\/git\.ts, but time ran out before its line hashes were written; calling again is safe$/
    );
    expect(s0.f.calls.map(c => c.name)).toEqual(['addRepoFiles', 'addCodeRef']);
    const res = await addCodeRefFlow(input, deps); // a new call, a new budget
    expect(res).toMatchObject({ existing: true, path: 'agent/src/git.ts' });
    expect(s0.f.calls.map(c => c.name)).toEqual(['addRepoFiles', 'addCodeRef', 'setCodeRefHashes']);
  });

  it('an existing ref without line hashes gets none once its file changed: its stored lines may no longer be the ones it cites', async () => {
    const s0 = slow({ writeMs: { add_code_ref: 12_500 } });
    const deps = { ...localDeps, call: s0.call, git: fakeGit(), readSource: fakeSource({ 'agent/src/git.ts': TS }), resolveSymbol: () => okRange(1, 3, 'gitHead'), now: s0.now };
    await expect(addCodeRefFlow(input, deps)).rejects.toThrow(/before its line hashes were written/);
    const res = await addCodeRefFlow(input, { ...deps, git: fakeGit({ hashObject: () => 'sha-edited' }) });
    expect(res).toMatchObject({ existing: true });
    expect(s0.f.calls.map(c => c.name)).toEqual(['addRepoFiles', 'addCodeRef']);
  });

  it('every git call and write gets the time left before the cut-off; writes never under 2 s', async () => {
    const s0 = slow({ writeMs: { add_repo_files: 4000 } });
    const seen: string[] = [];
    const git = fakeGit({
      spelling: (_r, rel, ms) => (seen.push(`spelling ${ms}`), rel),
      isCitable: (_r, _rel, ms) => (seen.push(`isCitable ${ms}`), true),
      hashObject: (_r, rel, _b, ms) => (seen.push(`hashObject ${ms}`), `sha-${rel}`),
    });
    await addCodeRefFlow(input, { ...localDeps, call: s0.call, git, readSource: fakeSource({ 'agent/src/git.ts': TS }), resolveSymbol: () => okRange(1, 3, 'gitHead'), now: s0.now });
    expect(seen).toEqual(['spelling 14000', 'hashObject 14000', 'isCitable 14000']);
    expect(s0.timeouts).toEqual(['add_repo_files 14000', 'add_code_ref 10000', 'set_code_ref_hashes 10000']);
  });

  it('a moved non-TS ref (G18) is not rewritten with under 2 s left', async () => {
    const s0 = slow();
    s0.f.codeRefs.push({ id: 77n, boardId: 1n, targetKind: 'node', targetId: 5n, path: 'README.md', symbol: 'Limiter', startLine: 1, endLine: 2, blobSha: 'old', snippet: 'x', author: '', checkpoint: 1, status: 'ok' });
    const git = fakeGit({
      hashObject: (_r, rel) => {
        s0.clock.t += 12_500;
        return `sha-${rel}`;
      },
    });
    const deps = { ...localDeps, call: s0.call, git, readSource: fakeSource({ 'README.md': '# T\n\n## Limiter\nthe Limiter allows bursts\n' }), now: s0.now };
    await expect(addCodeRefFlow({ ...input, path: 'README.md', symbol: 'Limiter', startLine: 3, endLine: 4 }, deps)).rejects.toThrow(NOTHING);
    expect(s0.f.calls).toEqual([]);
  });

  it('create_edge source evidence: registered within the budget, and stops before the edge write with under 2 s left', async () => {
    const s0 = slow();
    const git = fakeGit({
      spelling: (_r, rel) => {
        s0.clock.t += 6000;
        return rel;
      },
    });
    const ok = flowBudget(s0.now);
    const readSource = fakeSource({ 'src/a.ts': Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n') });
    await expect(prepareSourceEvidence({ ...localDeps, call: s0.call, git, budget: ok, canonicalPath: (_r, p) => p, readSource }, 1n, '/r', 'source:./src/a.ts:12')).resolves.toEqual({ evidence: 'source:./src/a.ts:12', evidenceSnippet: 'line 12', evidenceHash: lineHash('line 12') });
    expect(s0.f.calls.map(c => c.name)).toEqual(['addRepoFiles']);
    // same again, starting late: the path is already registered, but the edge write would have under 2 s
    s0.clock.t = 0;
    const late = flowBudget(s0.now);
    s0.clock.t = 12_500;
    await expect(prepareSourceEvidence({ ...localDeps, call: s0.call, git: fakeGit(), budget: late, canonicalPath: (_r, p) => p, readSource }, 1n, '/r', 'source:./src/a.ts:12')).rejects.toThrow(
      /^\.\/src\/a\.ts is registered for this board, but time ran out before the edge was written; nothing else was written, so calling again is safe$/
    );
    expect(s0.f.calls.map(c => c.name)).toEqual(['addRepoFiles']);
  });

  it('create_edge source evidence: the path stored in the spelling git prints, line kept', async () => {
    const s0 = slow();
    const budget = flowBudget(s0.now);
    const readSource = fakeSource({ 'src/a.ts': Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n') });
    const evidence = await prepareSourceEvidence({ ...localDeps, call: s0.call, git: fakeGit(), budget, canonicalPath: (_r, p) => posix.normalize(p), readSource }, 1n, '/r', 'source:./src//a.ts:12');
    expect(evidence).toEqual({ evidence: 'source:src/a.ts:12', evidenceSnippet: 'line 12', evidenceHash: lineHash('line 12') });
  });

  it.each(['source:a.ts:0', 'source:a.ts:3', 'source:a.ts:2'])('rejects an invalid or blank source line before registering a path: %s', async evidence => {
    const f = fakeConn();
    await expect(prepareSourceEvidence({ ...localDeps, call: f.call, git: fakeGit(), budget: flowBudget(Date.now), readSource: fakeSource({ 'a.ts': 'real line\n  \n' }), canonicalPath: (_r, p) => p }, 1n, '/r', evidence)).rejects.toThrow();
    expect(f.calls).toEqual([]);
  });

  it('rejects a source line over the storage limit before registering its path', async () => {
    const f = fakeConn();
    await expect(prepareSourceEvidence({ ...localDeps, call: f.call, git: fakeGit(), budget: flowBudget(Date.now), readSource: fakeSource({ 'a.ts': 'x'.repeat(4001) }), canonicalPath: (_r, p) => p }, 1n, '/r', 'source:a.ts:1')).rejects.toThrow('longer than 4000');
    expect(f.calls).toEqual([]);
  });

  it.each([1, 2])('rejects duplicated source line %s before registering its path', async line => {
    const f = fakeConn();
    const readSource = fakeSource({ 'a.ts': '  send(request);\n  send(request);\n' });
    await expect(prepareSourceEvidence({ ...localDeps, call: f.call, git: fakeGit(), budget: flowBudget(Date.now), readSource, canonicalPath: (_r, p) => p }, 1n, '/r', `source:a.ts:${line}`)).rejects.toThrow('cite a unique line that establishes the relationship');
    expect(f.calls).toEqual([]);
    expect(f.repoFiles).toEqual([]);
  });

  it('accepts a source line unique by its exact text, preserving indentation', async () => {
    const f = fakeConn();
    const readSource = fakeSource({ 'a.ts': 'send(request);\n  send(request);\n' });
    await expect(prepareSourceEvidence({ ...localDeps, call: f.call, git: fakeGit(), budget: flowBudget(Date.now), readSource, canonicalPath: (_r, p) => p }, 1n, '/r', 'source:a.ts:2')).resolves.toEqual({ evidence: 'source:a.ts:2', evidenceSnippet: '  send(request);', evidenceHash: lineHash('  send(request);') });
    expect(f.calls.map(c => c.name)).toEqual(['addRepoFiles']);
  });
});

describe('source evidence at mark_checkpoint (RC-538)', () => {
  const session: SessionRow = { id: 9n, boardId: 1n, repoRoot: '/r', baseSha: 'a'.repeat(40), headSha: '', checkpoint: 0, coverage: '{}' };
  const edge = (id: bigint, evidence = 'source:a.ts:1', evidenceSnippet = '  send(request);', evidenceStatus = 'ok') => ({ id, boardId: 1n, evidence, evidenceSnippet, evidenceStatus });

  it('indexes a shared source file once for unique and duplicated citations', async () => {
    const rows = [edge(1n, 'source:a.ts:1', 'first();'), edge(2n, 'source:a.ts:1', 'shared();'), edge(3n, 'source:a.ts:1', 'second();')];
    const f = fakeConn({ sessions: [{ ...session }], edges: rows });
    const source = fakeSource({ 'a.ts': '// moved\nfirst();\nshared();\nshared();\nsecond();\n' });
    let inspected = 0;
    const readSource = (root: string, path: string) => {
      const src = source(root, path);
      src.lines = new Proxy(src.lines, {
        get(target, key, receiver) {
          if (typeof key === 'string' && /^\d+$/.test(key)) inspected++;
          return Reflect.get(target, key, receiver);
        },
      });
      return src;
    };
    const res = await markCheckpointFlow({ boardId: 1n }, { ...localDeps, call: f.call, git: fakeGit(), readSource, progress: new Map() });
    expect(rows.map(e => [e.evidence, e.evidenceStatus])).toEqual([
      ['source:a.ts:2', 'ok'], ['source:a.ts:1', 'stale'], ['source:a.ts:5', 'ok'],
    ]);
    expect(res.reanchor).toMatchObject({ shifted: 2, stale: ['edge 2 source:a.ts:1'] });
    expect(inspected).toBe(5);
  });

  it('budgets source file reads and resumes without rereading unchanged files', async () => {
    const rows = ['a.ts', 'b.ts', 'c.ts'].map((path, i) => edge(BigInt(i + 1), `source:${path}:1`));
    const f = fakeConn({ sessions: [{ ...session }], edges: rows });
    const files = Object.fromEntries(['a.ts', 'b.ts', 'c.ts'].map(path => [path, '// moved\n  send(request);\n']));
    const source = fakeSource(files);
    const read: string[] = [];
    let t = 0;
    const deps = {
      ...localDeps,
      call: f.call, git: fakeGit(), now: () => t, progress: new Map(), stamp: (_root: string, path: string) => files[path],
      readSource: (root: string, path: string) => { read.push(path); t += 6500; return source(root, path); },
    };
    await expect(markCheckpointFlow({ boardId: 1n }, deps)).rejects.toThrow('re-anchored 1 of 3 source citations; call again to continue');
    expect(read).toEqual(['a.ts', 'b.ts']);
    expect(f.calls.map(c => c.name)).toEqual(['setEdgeEvidenceCode', 'updateEdgeEvidence']);
    const res = await markCheckpointFlow({ boardId: 1n }, deps);
    expect(read).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect(rows.map(e => e.evidence)).toEqual(['source:a.ts:2', 'source:b.ts:2', 'source:c.ts:2']);
    expect(res).toMatchObject({ checkpoint: 1, reanchor: { shifted: 3 } });
    expect(deps.progress.size).toBe(0);
  });

  it('follows the exact captured line, including indentation, without giving source evidence code-ref coverage', async () => {
    const row = edge(1n);
    const f = fakeConn({ sessions: [{ ...session }], edges: [row] });
    const git = fakeGit({ changed: () => ['a.ts'], hunks: () => [{ start: 1, end: 3 }] });
    const deps = { ...localDeps, call: f.call, git, readSource: fakeSource({ 'a.ts': 'send(request);\n// inserted\n  send(request);\n' }), progress: new Map() };
    const res = await markCheckpointFlow({ boardId: 1n }, deps);
    expect(row).toMatchObject({ evidence: 'source:a.ts:3', evidenceSnippet: '  send(request);', evidenceStatus: 'ok' });
    expect(res.reanchor).toEqual({ shifted: 1, drifted: 0, stale: [], ambiguous: [], restored: [] });
    expect(res.coverage.uncovered).toEqual(['a.ts']);
    expect(git.hashed).toEqual([]); // evidence follows text; no git clean-filter hash is needed
    expect(f.calls.map(c => c.name)).toEqual(['setEdgeEvidenceCode', 'updateEdgeEvidence', 'markCheckpoint']);
    const again = await markCheckpointFlow({ boardId: 1n }, deps);
    expect(again.reanchor.shifted).toBe(0);
    expect(f.calls.filter(c => c.name === 'updateEdgeEvidence')).toHaveLength(1);
  });

  it.each([
    ['edited', '  send(other);\n', '  send(request);'],
    ['ambiguous', '  send(request);\n  send(request);\n', '  send(request);'],
    ['legacy', '  send(request);\n', ''],
  ])('marks %s evidence stale and preserves its original citation and captured text', async (_reason, text, snippet) => {
    const row = edge(1n, 'source:a.ts:1', snippet);
    const f = fakeConn({ sessions: [{ ...session }], edges: [row] });
    const res = await markCheckpointFlow({ boardId: 1n }, { ...localDeps, call: f.call, git: fakeGit(), readSource: fakeSource({ 'a.ts': text }), progress: new Map() });
    expect(row).toMatchObject({ evidence: 'source:a.ts:1', evidenceSnippet: snippet, evidenceStatus: 'stale' });
    expect(res.reanchor).toMatchObject({ shifted: 0, stale: ['edge 1 source:a.ts:1'], ambiguous: [] });
  });

  it.each(['missing', 'unreadable'])('marks evidence stale when its file is %s', async reason => {
    const row = edge(1n);
    const f = fakeConn({ sessions: [{ ...session }], edges: [row] });
    const readSource = () => { throw reason === 'missing' ? new MissingFileError('a.ts') : new Error('binary'); };
    const res = await markCheckpointFlow({ boardId: 1n }, { ...localDeps, call: f.call, git: fakeGit(), readSource, progress: new Map() });
    expect(row.evidenceStatus).toBe('stale');
    expect(res.reanchor.stale).toEqual(['edge 1 source:a.ts:1']);
  });

  it('marks a legacy line-zero citation stale without silently recapturing it', async () => {
    const row = edge(1n, 'source:a.ts:0', '', '');
    const f = fakeConn({ sessions: [{ ...session }], edges: [row] });
    const res = await markCheckpointFlow({ boardId: 1n }, { ...localDeps, call: f.call, git: fakeGit(), readSource: fakeSource({ 'a.ts': '  send(request);\n' }), progress: new Map() });
    expect(row).toMatchObject({ evidence: 'source:a.ts:0', evidenceSnippet: '', evidenceStatus: 'stale' });
    expect(res.reanchor.stale).toEqual(['edge 1 source:a.ts:0']);
    expect(f.calls.map(c => c.name)).toEqual(['updateEdgeEvidence', 'markCheckpoint']);
  });

  it('restores stale evidence when the captured line becomes unique again', async () => {
    const row = edge(1n, 'source:a.ts:1', '  send(request);', 'stale');
    const f = fakeConn({ sessions: [{ ...session }], edges: [row] });
    const res = await markCheckpointFlow({ boardId: 1n }, { ...localDeps, call: f.call, git: fakeGit(), readSource: fakeSource({ 'a.ts': '// restored\n  send(request);\n' }), progress: new Map() });
    expect(row).toMatchObject({ evidence: 'source:a.ts:2', evidenceStatus: 'ok' });
    expect(res.reanchor).toMatchObject({ shifted: 1, restored: ['edge 1 source:a.ts:2'] });
  });

  it('shares files and hashes with refs; non-source and other-board evidence stay untouched', async () => {
    const rows = [edge(1n), edge(2n, 'human:alan', '', ''), { ...edge(3n), boardId: 2n }];
    const ref: CodeRefRow = { id: 1n, boardId: 1n, targetKind: 'edge', targetId: 1n, path: 'a.ts', symbol: 'a', startLine: 1, endLine: 1, blobSha: 'sha-a.ts', snippet: 'function a() {}', author: '', checkpoint: 1, status: 'ok' };
    const f = fakeConn({ sessions: [{ ...session }], edges: rows, codeRefs: [ref] });
    const git = fakeGit();
    const res = await markCheckpointFlow({ boardId: 1n }, { ...localDeps, call: f.call, git, readSource: fakeSource({ 'a.ts': 'function a() {}\n  send(request);\n' }), progress: new Map() });
    expect(git.hashed).toEqual([['a.ts']]);
    expect(rows[1]).toMatchObject({ evidence: 'human:alan', evidenceStatus: '' });
    expect(rows[2]).toMatchObject({ evidence: 'source:a.ts:1', evidenceStatus: 'ok' });
    expect(res.reanchor.shifted).toBe(1);
  });

  it('resumes source evidence writes within the checkpoint deadline and reports the whole summary', async () => {
    const rows = [1n, 2n, 3n].map(id => edge(id));
    const f = fakeConn({ sessions: [{ ...session }], edges: rows });
    let t = 0;
    const call: Call = async (label, fn) => {
      const result = await fn(f.conn);
      if (label === 'update_edge_evidence') t += 6500;
      return result;
    };
    const deps = { ...localDeps, call, git: fakeGit(), readSource: fakeSource({ 'a.ts': '// moved\n  send(request);\n' }, { stamps: true }), now: () => t, progress: new Map() };
    await expect(markCheckpointFlow({ boardId: 1n }, deps)).rejects.toThrow('re-anchored 2 of 3 source citations; call again to continue');
    const cite = ['setEdgeEvidenceCode', 'updateEdgeEvidence']; // the missing hash, then the move
    expect(f.calls.map(c => c.name)).toEqual([...cite, ...cite]);
    const res = await markCheckpointFlow({ boardId: 1n }, deps);
    expect(res).toMatchObject({ checkpoint: 1, reanchor: { shifted: 3 } });
    expect(f.calls.map(c => c.name)).toEqual([...cite, ...cite, ...cite, 'markCheckpoint']);
    expect(deps.progress.size).toBe(0);
  });

  it('rechecks evidence changed between retry calls even when a git clean filter keeps the same blob sha', async () => {
    const rows = [1n, 2n, 3n].map(id => edge(id));
    const f = fakeConn({ sessions: [{ ...session }], edges: rows });
    let t = 0;
    let cost = 6500;
    const files: Record<string, string> = { 'a.ts': '// moved\n  send(request);\n' };
    const call: Call = async (label, fn) => {
      const result = await fn(f.conn);
      if (label === 'update_edge_evidence') t += cost;
      return result;
    };
    const deps = { ...localDeps, call, git: fakeGit(), readSource: fakeSource(files, { stamps: true }), stamp: (_root: string, path: string) => files[path], now: () => t, progress: new Map() };
    await expect(markCheckpointFlow({ boardId: 1n }, deps)).rejects.toThrow('re-anchored 2 of 3 source citations');
    files['a.ts'] = '// moved further\n// moved\n  send(request);\n';
    cost = 0;
    const res = await markCheckpointFlow({ boardId: 1n }, deps);
    expect(rows.map(e => e.evidence)).toEqual(['source:a.ts:3', 'source:a.ts:3', 'source:a.ts:3']);
    expect(res.reanchor.shifted).toBe(3);
  });

  it('validates the bytes read when a file changes after capture, then detects the edit at the next checkpoint', async () => {
    const row = edge(1n);
    const f = fakeConn({ sessions: [{ ...session }], edges: [row] });
    const files = { 'a.ts': '// moved\n  send(request);\n' };
    const read = fakeSource(files);
    const readSource = (root: string, path: string) => {
      const src = read(root, path);
      files['a.ts'] = '// edited after capture\n  send(other);\n';
      return src;
    };
    const deps = { ...localDeps, call: f.call, git: fakeGit(), readSource, progress: new Map() };
    const first = await markCheckpointFlow({ boardId: 1n }, deps);
    expect(row).toMatchObject({ evidence: 'source:a.ts:2', evidenceSnippet: '  send(request);', evidenceStatus: 'ok' });
    expect(first.reanchor.shifted).toBe(1);
    const second = await markCheckpointFlow({ boardId: 1n }, deps);
    expect(row.evidenceStatus).toBe('stale');
    expect(second.reanchor.stale).toEqual(['edge 1 source:a.ts:2']);
  });
});

describe('markCheckpointFlow', () => {
  const S = 'z'.repeat(40);
  const ref = (id: bigint, path: string, symbol: string, startLine: number, endLine: number, snippet: string, blobSha: string, targetId = 5n): CodeRefRow => ({
    id, boardId: 1n, targetKind: 'node', targetId, path, symbol, startLine, endLine, blobSha, snippet, author: '', checkpoint: 1, status: 'ok',
  });
  const session = (checkpoint: number): SessionRow => ({ id: 9n, boardId: 1n, repoRoot: '/r', baseSha: S, headSha: '', checkpoint, coverage: '{}' });

  describe('change notes (spec 2026-10-16 D2, D4)', () => {
    const MIG = 'migrations/0042.sql';
    const READER = 'workers/invoice/src/bill-to.ts';
    const migration = 'ALTER TABLE customers\n  DROP COLUMN name;\n';
    const billTo = (column: string) => `export async function loadBillTo(sql, id) {\n  const [row] = await sql\`\n    SELECT ${column}, email FROM customers\n  \`;\n}\n`;
    const reader = (status = 'stale') => JSON.stringify([{ refId: '7', subject: 0, status, checkpoint: 1 }]);
    const note = (o: Partial<ChangeNoteRow> = {}): ChangeNoteRow => ({
      id: 1n, boardId: 1n, refId: 2n, subjects: '[{"table":"customers","column":"name"}]', readers: reader(), refFileSha: `sha-${MIG}`, ...o,
    });
    // blobSha `sha-<path>` is what fakeGit hashes, so an untouched file keeps its ref as stored
    // gone: a reader whose symbol is no longer in its file, so re-anchoring leaves it stale (D4 b)
    const seed = (readerSnippet: string, o: { gone?: boolean; notes?: ChangeNoteRow[]; files?: Record<string, string> } = {}) => {
      const mainRef = ref(2n, MIG, 'customers', 1, 2, migration.trimEnd(), `sha-${MIG}`);
      const readerRef = o.gone
        ? { ...ref(7n, READER, 'oldLoader', 38, 38, readerSnippet, 'old', 6n), status: 'stale' }
        : ref(7n, READER, 'loadBillTo', 38, 42, readerSnippet, `sha-${READER}`, 6n);
      const f = fakeConn({
        sessions: [session(1)],
        nodes: [{ id: 5n, boardId: 1n }, { id: 6n, boardId: 1n }],
        codeRefs: [mainRef, readerRef],
        changeNotes: o.notes ?? [note()],
      });
      const deps = {
        ...localDeps,
        call: f.call,
        git: fakeGit(),
        readSource: fakeSource(o.files ?? { [MIG]: migration, [READER]: billTo('name') }),
        progress: new Map(),
      };
      return { f, deps };
    };
    const readersOf = (f: ReturnType<typeof fakeConn>) => JSON.parse(f.changeNotes[0].readers);

    it('reader check marks a ref that no longer has the column updated', async () => {
      const { f, deps } = seed(billTo('first_name').trimEnd(), { files: { [MIG]: migration, [READER]: billTo('first_name') } });
      const res = await markCheckpointFlow({ boardId: 1n }, deps);
      expect(f.calls.filter(c => c.name === 'setChangeNoteReaders')).toHaveLength(1);
      expect(readersOf(f)).toEqual([{ refId: '7', subject: 0, status: 'updated', checkpoint: 2 }]);
      expect(res.changeNotes).toBeUndefined();
    });

    it('reader check reports a stale reader', async () => {
      const { f, deps } = seed(billTo('name').trimEnd());
      const res = await markCheckpointFlow({ boardId: 1n }, deps);
      expect(res.changeNotes).toEqual({ staleReaders: [{ note: '1', ref: '7', path: READER, line: 40 }], unconfirmed: [] });
      expect(f.calls.some(c => c.name === 'setChangeNoteReaders')).toBe(false);
    });

    it('reader check uses the whole file for a stale ref', async () => {
      const gone = seed('const old = row.name;', { gone: true, files: { [MIG]: migration, [READER]: billTo('first_name') } });
      await markCheckpointFlow({ boardId: 1n }, gone.deps);
      expect(readersOf(gone.f)[0].status).toBe('updated');
      const still = seed('const old = row.name;', { gone: true, files: { [MIG]: migration, [READER]: billTo('name') } });
      await markCheckpointFlow({ boardId: 1n }, still.deps);
      expect(readersOf(still.f)[0].status).toBe('unknown');
    });

    it('a removed reader stays unknown, and a deleted reader file counts as updated', async () => {
      const removed = seed(billTo('first_name').trimEnd(), {
        notes: [note({ readers: JSON.stringify([{ refId: '7', subject: 0, status: 'unknown', checkpoint: 1, removed: true }]) })],
        files: { [MIG]: migration, [READER]: billTo('first_name') },
      });
      await markCheckpointFlow({ boardId: 1n }, removed.deps);
      expect(removed.f.calls.some(c => c.name === 'setChangeNoteReaders')).toBe(false);
      const deleted = seed('const old = row.name;', { gone: true, files: { [MIG]: migration } });
      await markCheckpointFlow({ boardId: 1n }, deleted.deps);
      expect(readersOf(deleted.f)[0].status).toBe('updated');
    });

    it('reader check reads an ok ref\'s current lines from the file, not its stored text (RC-690)', async () => {
      const { f, deps } = seed('');
      Object.assign(f.codeRefs[1], { startLine: 1, endLine: 5 }); // the reader's lines in billTo('name')
      f.consent.storeCode = false;
      const res = await markCheckpointFlow({ boardId: 1n }, deps);
      expect(res.changeNotes).toEqual({ staleReaders: [{ note: '1', ref: '7', path: READER, line: 3 }], unconfirmed: [] });
      expect(readersOf(f)[0].status).toBe('stale');
      // no text and no readable file: unknown, never a false 'updated'
      const blind = seed('');
      blind.f.consent.storeCode = false;
      const readSource = blind.deps.readSource;
      await markCheckpointFlow({ boardId: 1n }, { ...blind.deps, readSource: (root: string, path: string) => (path === READER ? (() => { throw new Error('binary'); })() : readSource(root, path)) });
      expect(readersOf(blind.f)[0].status).toBe('unknown');
    });

    it('reader check writes nothing when nothing changed', async () => {
      const { f, deps } = seed(billTo('name').trimEnd());
      await markCheckpointFlow({ boardId: 1n }, deps);
      expect(f.calls.map(c => c.name)).toEqual(['setCodeRefHashes', 'markCheckpoint']); // the main ref's missing hashes (RC-690); no note write
    });

    it('unconfirmed lists changed migration paths no note cites', async () => {
      const bare = fakeConn({ sessions: [session(1)] });
      const res = await markCheckpointFlow({ boardId: 1n }, {
        ...localDeps, call: bare.call, git: fakeGit({ changed: () => ['migrations/0043_x.sql', 'src/a.ts'] }), readSource: fakeSource({}), progress: new Map(),
      });
      expect(res.coverage.unconfirmed).toEqual(['migrations/0043_x.sql']);
      expect(JSON.parse(bare.sessions[0].coverage).unconfirmed).toEqual(['migrations/0043_x.sql']);
      expect(res.changeNotes).toEqual({ staleReaders: [], unconfirmed: ['migrations/0043_x.sql'] });

      const { f, deps } = seed(billTo('first_name').trimEnd(), { files: { [MIG]: migration, [READER]: billTo('first_name') } });
      const noted = await markCheckpointFlow({ boardId: 1n }, { ...deps, git: fakeGit({ changed: () => [MIG] }) });
      expect(noted.coverage.unconfirmed).toBeUndefined();
      expect(JSON.parse(f.sessions[0].coverage).unconfirmed).toBeUndefined();
    });

    it('an excluded migration is not unconfirmed', async () => {
      const bare = fakeConn({ sessions: [session(1)] });
      const res = await markCheckpointFlow({ boardId: 1n, exclude: [{ reason: 'additive migrations', glob: 'migrations/**' }] }, {
        ...localDeps, call: bare.call, git: fakeGit({ changed: () => ['migrations/0043_x.sql', 'db/migrate/1_add.rb'] }), readSource: fakeSource({}), progress: new Map(),
      });
      expect(res.coverage.unconfirmed).toEqual(['db/migrate/1_add.rb']);
      expect(res.changeNotes?.unconfirmed).toEqual(['db/migrate/1_add.rb']);
    });

    it('refFileSha comes from the hashed main ref file', async () => {
      const { f, deps } = seed(billTo('name').trimEnd(), { notes: [note({ refFileSha: 'old' })] });
      await markCheckpointFlow({ boardId: 1n }, deps);
      expect(f.calls.filter(c => c.name === 'setChangeNoteReaders').map(c => (c.args as { refFileSha: string }).refFileSha)).toEqual([`sha-${MIG}`]);
      expect(f.changeNotes[0].refFileSha).toBe(`sha-${MIG}`);
    });
  });

  it('commits arrival through the atomic reducer instead of a separate checkpoint', async () => {
    const f = fakeConn({ sessions: [session(3)] });
    const arrivals: unknown[] = [];
    Object.assign(f.conn.reducers, {
      arriveAtCheckpoint: async (args: { headSha: string; coverage: string }) => {
        arrivals.push(args);
        Object.assign(f.sessions[0], { checkpoint: 4, headSha: args.headSha, coverage: args.coverage });
      },
    });
    const res = await markCheckpointFlow(
      { boardId: 1n, arrival: { nodeId: 5n, expectedRevision: 2, expectedCheckpoint: 3 } },
      { ...localDeps, call: f.call, git: fakeGit(), progress: new Map() }
    );
    expect(arrivals).toEqual([{ boardId: 1n, nodeId: 5n, expectedRevision: 2, expectedCheckpoint: 3, headSha: 'a'.repeat(40), coverage: JSON.stringify(res.coverage) }]);
    expect(f.calls.some(c => c.name === 'markCheckpoint')).toBe(false);
    expect(res.checkpoint).toBe(4);
  });

  it('does not record a checkpoint if the atomic arrival rejects concurrent changes', async () => {
    const f = fakeConn({ sessions: [session(3)] });
    Object.assign(f.conn.reducers, { arriveAtCheckpoint: async () => { throw new Error('route changed; read get_board and retry'); } });
    await expect(markCheckpointFlow(
      { boardId: 1n, arrival: { nodeId: 5n, expectedRevision: 2, expectedCheckpoint: 3 } },
      { ...localDeps, call: f.call, git: fakeGit(), progress: new Map() }
    )).rejects.toThrow('route changed');
    expect(f.sessions[0].checkpoint).toBe(3);
    expect(f.calls).toEqual([]);
  });

  it('reports the arrival checkpoint if another checkpoint arrives before the reply read', async () => {
    const f = fakeConn({ sessions: [session(3)] });
    Object.assign(f.conn.db, { visibleRouteEvent: { iter: () => [{ id: 1n, boardId: 1n, kind: 'arrive', revision: 2, nodeId: 5n, nodeIds: [5n, 6n], reason: '', checkpoint: 4 }] } });
    Object.assign(f.conn.reducers, { arriveAtCheckpoint: async () => { f.sessions[0].checkpoint = 5; } });
    const result = await markCheckpointFlow(
      { boardId: 1n, arrival: { nodeId: 5n, expectedRevision: 2, expectedCheckpoint: 3 } },
      { ...localDeps, call: f.call, git: fakeGit(), progress: new Map() }
    );
    expect(result.checkpoint).toBe(4);
  });

  it.each(['stale', 'ambiguous'])('restores %s refs when the captured blob returns, and reports them restored (G24)', async status => {
    const row = { ...ref(1n, 'a.ts', 'fnA', 1, 1, 'function fnA() {}', 'same'), status };
    const f = fakeConn({ sessions: [session(1)], nodes: [{ id: 5n, boardId: 1n }], codeRefs: [row] });
    const res = await markCheckpointFlow({ boardId: 1n }, {
      ...localDeps,
      call: f.call,
      git: fakeGit({ hashObject: () => 'same' }),
      readSource: fakeSource({ 'a.ts': 'function fnA() {}\n' }),
    });
    expect(row.status).toBe('ok');
    expect(row.blobSha).toBe('same');
    expect(res.reanchor).toEqual({ shifted: 0, drifted: 0, stale: [], ambiguous: [], restored: ['fnA a.ts id=1'] });
  });

  it('reports a stale ref whose symbol is found again by name as restored (G24)', async () => {
    const row = { ...ref(1n, 'a.ts', 'fnA', 1, 1, 'function fnA() {}', 'old'), status: 'stale' };
    const f = fakeConn({ sessions: [session(1)], nodes: [{ id: 5n, boardId: 1n }], codeRefs: [row] });
    const res = await markCheckpointFlow({ boardId: 1n }, {
      ...localDeps,
      call: f.call,
      git: fakeGit(),
      readSource: fakeSource({ 'a.ts': '// moved\nfunction fnA() {}\n' }),
    });
    expect(row).toMatchObject({ status: 'ok', startLine: 2, endLine: 2, blobSha: 'sha-a.ts' });
    expect(res.reanchor).toEqual({ shifted: 1, drifted: 0, stale: [], ambiguous: [], restored: ['fnA a.ts id=1'] });
  });

  function scenario() {
    const files = {
      'a.ts': '// new leading comment\nfunction fnA() {\n  return 1;\n}\n',
      'b.ts': 'function fnB() { return 2 }\n',
      'c.ts': 'function somethingElse() {}\n',
      'd.ts': 'function fnD(a: string): void;\nfunction fnD(a: number): void;\nfunction fnD(a: unknown) {}\n',
      'e.ts': 'function fnE() {}\n',
      'f.go': 'func F() {}\n',
      'u.ts': 'function fnU() {}\n',
    };
    const f = fakeConn({
      boards: [{ id: 1n, name: 's' }],
      sessions: [session(0)],
      nodes: [{ id: 5n, boardId: 1n }],
      codeRefs: [
        ref(1n, 'a.ts', 'fnA', 1, 3, 'function fnA() {\n  return 1;\n}', 'old-a'),
        ref(2n, 'b.ts', 'fnB', 1, 1, 'function fnB() {}', 'old-b'),
        ref(3n, 'c.ts', 'fnC', 1, 1, 'function fnC() {}', 'old-c'),
        ref(4n, 'd.ts', 'fnD', 1, 1, 'function fnD() {}', 'old-d'),
        ref(5n, 'e.ts', 'fnE', 1, 1, 'function fnE() {}', 'same'),
        ref(6n, 'f.go', 'F', 1, 1, 'func F() {}', 'old-f'),
        ref(7n, 'a.ts', 'fnA', 1, 3, 'function fnA() {\n  return 1;\n}', 'old-a', 9n), // target node 9 does not exist
        ref(8n, 'u.ts', 'fnU', 1, 1, 'function fnU() {}', 'same'),
      ],
    });
    const git = fakeGit({
      head: () => 'head'.padEnd(40, '0'),
      hashObject: (_r, rel) => (rel === 'e.ts' || rel === 'u.ts' ? 'same' : `new-${rel}`),
      changed: () => ['a.ts', 'b.ts', 'z.ts'],
      untracked: () => ['u.ts', 'gen/x_table.ts'],
      deleted: () => ['old.md'],
      hunks: (_r, _b, rel) => {
        git.log.push(`hunks ${rel}`);
        return rel === 'a.ts' ? [{ start: 2, end: 2 }] : [{ start: 5, end: 6 }];
      },
    });
    const resolveSymbol = vi.fn((_abs: string, _src: string, symbol: string): ResolveResult => {
      switch (symbol) {
        case 'fnA': return okRange(2, 4, 'fnA');
        case 'fnB': return okRange(1, 1, 'fnB');
        case 'fnC': return { ok: false, reason: 'not_found', suggestions: ['somethingElse'] };
        case 'fnD': return { ok: false, reason: 'ambiguous', candidates: [] };
        default: throw new Error(`unexpected resolve of ${symbol}`);
      }
    });
    return { f, git, resolveSymbol, deps: { ...localDeps, call: f.call, git, readSource: fakeSource(files), resolveSymbol } };
  }

  it('re-anchors refs whose blob changed, then computes coverage on live targets only, then marks the checkpoint last', async () => {
    const { f, git, resolveSymbol, deps } = scenario();
    const res = await markCheckpointFlow({ boardId: 1n, exclude: [{ reason: 'generated', glob: 'gen/**' }] }, deps);

    // re-anchor outcomes
    expect(f.codeRefs.find(r => r.id === 1n)).toMatchObject({ startLine: 2, endLine: 4, blobSha: 'new-a.ts', snippet: 'function fnA() {\n  return 1;\n}', status: 'ok' });
    expect(f.codeRefs.find(r => r.id === 2n)).toMatchObject({ startLine: 1, endLine: 1, blobSha: 'new-b.ts', snippet: 'function fnB() { return 2 }', status: 'ok' });
    expect(f.codeRefs.find(r => r.id === 3n)).toMatchObject({ startLine: 1, endLine: 1, blobSha: 'old-c', snippet: 'function fnC() {}', status: 'stale' });
    expect(f.codeRefs.find(r => r.id === 4n)).toMatchObject({ status: 'ambiguous', blobSha: 'old-d' });
    expect(f.codeRefs.find(r => r.id === 5n)).toMatchObject({ status: 'ok', blobSha: 'same' });
    // not resolvable: its captured lines occur once in the changed file, so it follows them (G4)
    expect(f.codeRefs.find(r => r.id === 6n)).toMatchObject({ status: 'ok', startLine: 1, endLine: 1, blobSha: 'new-f.go' });
    expect(f.codeRefs.find(r => r.id === 7n)).toMatchObject({ status: 'ok', blobSha: 'old-a', startLine: 1 }); // orphan: untouched
    expect(resolveSymbol.mock.calls.map(c => c[2])).toEqual(['fnA', 'fnB', 'fnC', 'fnD']);
    expect(res.reanchor).toEqual({ shifted: 2, drifted: 1, stale: ['fnC c.ts id=3'], ambiguous: ['fnD d.ts id=4'], restored: [] });

    // coverage: a.ts covered by the re-anchored range, b.ts not, z.ts has no ref, u.ts untracked+ref, gen/* excluded
    expect(res.coverage).toEqual({
      changed: 5,
      uncovered: ['b.ts', 'z.ts'],
      excluded: [{ reason: 'generated', paths: ['gen/x_table.ts'] }],
      deleted: ['old.md'],
    });
    expect(git.log.filter(l => l.startsWith('hunks'))).toEqual(['hunks a.ts', 'hunks b.ts']);

    // checkpoint is the last write
    const mark = f.calls.find(c => c.name === 'markCheckpoint')!.args as { boardId: bigint; headSha: string; coverage: string };
    expect(mark.boardId).toBe(1n);
    expect(mark.headSha).toBe('head'.padEnd(40, '0'));
    expect(JSON.parse(mark.coverage)).toEqual(res.coverage);
    expect(res).toMatchObject({ checkpoint: 1, headSha: 'head'.padEnd(40, '0') });
    expect(f.calls[f.calls.length - 1].name).toBe('markCheckpoint');
    expect(f.calls.filter(c => c.name === 'markCheckpoint')).toHaveLength(1);
  });

  it('on ambiguous, keeps the ref ok when exactly one candidate has the stored snippet verbatim (F1)', async () => {
    const f = fakeConn({
      boards: [{ id: 1n, name: 's' }],
      sessions: [session(0)],
      nodes: [{ id: 5n, boardId: 1n }],
      codeRefs: [ref(1n, 'i.ts', 'Shape', 1, 1, 'interface Shape { a: 1 }', 'old')],
    });
    const text = '// moved\ninterface Shape { b: 2 }\ninterface Shape { a: 1 }\n';
    const res = await markCheckpointFlow({ boardId: 1n }, { ...localDeps, call: f.call, git: fakeGit(), readSource: fakeSource({ 'i.ts': text }) });
    expect(f.codeRefs[0]).toMatchObject({ status: 'ok', startLine: 3, endLine: 3, blobSha: 'sha-i.ts', snippet: 'interface Shape { a: 1 }' });
    expect(res.reanchor).toEqual({ shifted: 1, drifted: 0, stale: [], ambiguous: [], restored: [] });
  });

  it('counts only ok refs for coverage: a ref gone stale at this checkpoint no longer covers its hunk (F16)', async () => {
    const f = fakeConn({
      boards: [{ id: 1n, name: 's' }],
      sessions: [session(0)],
      nodes: [{ id: 5n, boardId: 1n }],
      codeRefs: [
        ref(1n, 'r.ts', 'oldName', 1, 1, 'function oldName() {}', 'old-r'), // renamed: goes stale, keeps line 1
        // merged interface, neither declaration is the captured text: stays ambiguous
        { ...ref(2n, 'q.ts', 'Q', 1, 1, 'interface Q { a: 1 }', 'old-q'), status: 'ambiguous' },
      ],
    });
    const git = fakeGit({
      changed: () => ['r.ts', 'q.ts'],
      hashObject: (_r, rel) => `new-${rel}`,
      hunks: () => [{ start: 1, end: 1 }],
    });
    const res = await markCheckpointFlow(
      { boardId: 1n },
      {
        ...localDeps,
        call: f.call,
        git,
        readSource: fakeSource({ 'r.ts': 'function newName() {}\n', 'q.ts': 'interface Q { b: 2 }\ninterface Q { c: 3 }\n' }),
      }
    );
    expect(f.codeRefs[1].status).toBe('ambiguous');
    expect(res.reanchor.stale).toEqual(['oldName r.ts id=1']);
    expect(res.coverage).toEqual({ changed: 2, uncovered: ['r.ts', 'q.ts'], excluded: [], deleted: [] });
  });

  it('marks a ref stale when its file is gone', async () => {
    const f = fakeConn({
      boards: [{ id: 1n, name: 's' }],
      sessions: [session(3)],
      nodes: [{ id: 5n, boardId: 1n }],
      codeRefs: [ref(1n, 'gone.ts', 'fnG', 1, 1, 'function fnG() {}', 'old')],
    });
    const res = await markCheckpointFlow({ boardId: 1n }, { ...localDeps, call: f.call, git: fakeGit(), readSource: fakeSource({}) });
    expect(f.codeRefs[0]).toMatchObject({ status: 'stale', blobSha: 'old', startLine: 1, endLine: 1, snippet: 'function fnG() {}' });
    expect(res.reanchor).toEqual({ shifted: 0, drifted: 0, stale: ['fnG gone.ts id=1'], ambiguous: [], restored: [] });
    expect(res.coverage).toEqual({ changed: 0, uncovered: [], excluded: [], deleted: [] });
    expect(res).toMatchObject({ checkpoint: 4, headSha: 'a'.repeat(40) });
    expect(f.calls.map(c => c.name)).toEqual(['updateCodeRef', 'markCheckpoint']);
  });

  it('detects a deleted file by MissingFileError, not by message: other read failures leave the ref untouched', async () => {
    const f = fakeConn({
      boards: [{ id: 1n, name: 's' }],
      sessions: [session(0)],
      nodes: [{ id: 5n, boardId: 1n }],
      codeRefs: [
        ref(1n, 'gone.ts', 'fnG', 1, 1, 'function fnG() {}', 'old-g'),
        ref(2n, 'odd.ts', 'fnO', 1, 1, 'function fnO() {}', 'old-o'),
      ],
    });
    const readSource = (_root: string, rel: string): SourceFile => {
      if (rel === 'gone.ts') throw new MissingFileError(rel);
      throw new Error(`no such file in repo: '${rel}' (but not a MissingFileError)`);
    };
    const res = await markCheckpointFlow({ boardId: 1n }, { ...localDeps, call: f.call, git: fakeGit(), readSource });
    expect(f.codeRefs.find(r => r.id === 1n)).toMatchObject({ status: 'stale', blobSha: 'old-g', startLine: 1, endLine: 1, snippet: 'function fnG() {}' });
    expect(f.codeRefs.find(r => r.id === 2n)).toMatchObject({ status: 'ok', blobSha: 'old-o', startLine: 1, endLine: 1, snippet: 'function fnO() {}' });
    expect(res.reanchor).toEqual({ shifted: 0, drifted: 0, stale: ['fnG gone.ts id=1'], ambiguous: [], restored: [] });
    expect(f.calls.map(c => c.name)).toEqual(['updateCodeRef', 'markCheckpoint']);
  });

  it('reads only what git would list, and no secrets file: a ref or citation planted on one is left alone, its snippet not rewritten', async () => {
    const f = fakeConn({
      boards: [{ id: 1n, name: 's' }],
      sessions: [session(0)],
      nodes: [{ id: 5n, boardId: 1n }],
      codeRefs: [ref(1n, 'config.local.ts', 'config', 1, 1, 'export const config = {};', 'old-c'), ref(2n, 'gone.local.ts', 'g', 1, 1, 'const g = 1;', 'old-g')],
      edges: [
        { id: 7n, boardId: 1n, evidence: 'source:.env:1', evidenceSnippet: 'DATABASE_URL=postgres://u:pass@host', evidenceStatus: 'ok' },
        { id: 8n, boardId: 1n, evidence: 'source:config.local.ts:2', evidenceSnippet: "  token: 'abc',", evidenceStatus: 'ok' },
      ],
    });
    const asked: string[][] = [];
    const git = fakeGit({ listed: (_r, rels) => (asked.push(rels), rels.filter(p => p === '.env')) }); // .env tracked, config.local.ts ignored
    const read: string[] = [];
    const source = fakeSource({ 'config.local.ts': "export const config = {\n  token: 'abc',\n};\n", '.env': 'DATABASE_URL=postgres://u:pass@host\n' });
    const readSource = (root: string, rel: string) => (read.push(rel), source(root, rel));
    const stamp = (_r: string, rel: string) => (rel === 'gone.local.ts' ? undefined : 'here');
    const res = await markCheckpointFlow({ boardId: 1n }, { ...localDeps, call: f.call, git, readSource, stamp, progress: new Map() });
    expect(asked).toEqual([['config.local.ts', 'gone.local.ts', '.env']]); // one git call for every ref and source path
    expect(read).toEqual([]);
    expect(f.codeRefs[0]).toMatchObject({ status: 'ok', blobSha: 'old-c', snippet: 'export const config = {};' });
    expect(f.codeRefs[1]).toMatchObject({ status: 'stale' }); // gone from disk: stale, as before
    expect(f.edges.map(e => [e.evidence, e.evidenceStatus])).toEqual([['source:.env:1', 'stale'], ['source:config.local.ts:2', 'stale']]);
    expect(res.reanchor.stale).toEqual(['g gone.local.ts id=2', 'edge 7 source:.env:1', 'edge 8 source:config.local.ts:2']);
  });

  it('marks a ref stale when its resolved range does not fit a snippet, and still re-anchors the rest', async () => {
    const f = fakeConn({
      boards: [{ id: 1n, name: 's' }],
      sessions: [session(0)],
      nodes: [{ id: 5n, boardId: 1n }],
      codeRefs: [
        ref(1n, 'w.ts', 'fnW', 1, 1, 'function fnW() {}', 'old-w'),
        ref(2n, 'b.ts', 'fnB', 1, 1, 'function fnB() {}', 'old-b'),
      ],
    });
    const wide = `function fnW() { return '${'x'.repeat(4001)}' }\n`;
    const resolveSymbol = vi.fn((_abs: string, _src: string, symbol: string): ResolveResult => okRange(1, 1, symbol));
    const res = await markCheckpointFlow(
      { boardId: 1n },
      { ...localDeps, call: f.call, git: fakeGit(), readSource: fakeSource({ 'w.ts': wide, 'b.ts': 'function fnB() { return 2 }\n' }), resolveSymbol }
    );
    expect(f.codeRefs.find(r => r.id === 1n)).toMatchObject({ status: 'stale', blobSha: 'old-w', startLine: 1, endLine: 1, snippet: 'function fnW() {}' });
    expect(f.codeRefs.find(r => r.id === 2n)).toMatchObject({ status: 'ok', blobSha: 'sha-b.ts', snippet: 'function fnB() { return 2 }' });
    expect(res.reanchor).toEqual({ shifted: 0, drifted: 1, stale: ['fnW w.ts id=1'], ambiguous: [], restored: [] });
    expect(f.calls.map(c => c.name)).toEqual(['updateCodeRef', 'setCodeRefHashes', 'updateCodeRef', 'markCheckpoint']);
  });

  it('ignores a ref whose target was deleted: not re-anchored, not counted for coverage, its path never diffed', async () => {
    const f = fakeConn({
      boards: [{ id: 1n, name: 's' }],
      sessions: [session(0)],
      nodes: [{ id: 5n, boardId: 1n }],
      codeRefs: [ref(1n, 'z.ts', 'fnZ', 1, 1, 'function fnZ() {}', 'old', 9n)], // node 9 was deleted; the cascade has not run
    });
    const git = fakeGit({ changed: () => ['z.ts'] });
    const resolveSymbol = vi.fn(() => okRange(1, 1, 'fnZ'));
    const res = await markCheckpointFlow({ boardId: 1n }, { ...localDeps, call: f.call, git, readSource: fakeSource({ 'z.ts': 'function fnZ() {}\n' }), resolveSymbol });
    expect(res.coverage).toEqual({ changed: 1, uncovered: ['z.ts'], excluded: [], deleted: [] });
    expect(res.reanchor).toEqual({ shifted: 0, drifted: 0, stale: [], ambiguous: [], restored: [] });
    expect(resolveSymbol).not.toHaveBeenCalled();
    expect(git.log).toEqual([]);
    expect(f.codeRefs[0]).toMatchObject({ status: 'ok', blobSha: 'old' });
    expect(f.calls.map(c => c.name)).toEqual(['markCheckpoint']);
  });

  it('already-stale ref is not rewritten (G15), but is still listed', async () => {
    const f = fakeConn({
      boards: [{ id: 1n, name: 's' }],
      sessions: [session(0)],
      nodes: [{ id: 5n, boardId: 1n }],
      codeRefs: [
        { ...ref(1n, 'r.ts', 'oldName', 1, 1, 'function oldName() {}', 'old-r'), status: 'stale' }, // renamed away
        { ...ref(2n, 'gone.ts', 'fnG', 1, 1, 'function fnG() {}', 'old-g'), status: 'stale' }, // file deleted
        { ...ref(3n, 'q.ts', 'Q', 1, 1, 'interface Q { a: 1 }', 'old-q'), status: 'ambiguous' },
      ],
    });
    const res = await markCheckpointFlow(
      { boardId: 1n },
      { ...localDeps, call: f.call, git: fakeGit(), readSource: fakeSource({ 'r.ts': 'function newName() {}\n', 'q.ts': 'interface Q { b: 2 }\ninterface Q { c: 3 }\n' }) }
    );
    expect(f.calls.map(c => c.name)).toEqual(['markCheckpoint']);
    expect(res.reanchor).toEqual({ shifted: 0, drifted: 0, stale: ['oldName r.ts id=1', 'fnG gone.ts id=2'], ambiguous: ['Q q.ts id=3'], restored: [] });
  });

  it('stops re-anchoring at the budget without marking the checkpoint; a second call resumes and reports the whole summary (G15)', async () => {
    const f = fakeConn({
      boards: [{ id: 1n, name: 's' }],
      sessions: [session(0)],
      nodes: [{ id: 5n, boardId: 1n }],
      codeRefs: [1n, 2n, 3n].map(id => ref(id, `${id}.ts`, `fn${id}`, 1, 1, `function fn${id}() {}`, 'old')),
    });
    let t = 0;
    const resolveSymbol = vi.fn((_abs: string, _src: string, symbol: string): ResolveResult => {
      t += 5000; // each resolve takes 5 s
      return okRange(2, 2, symbol);
    });
    const files = Object.fromEntries([1, 2, 3].map(id => [`${id}.ts`, `// moved\nfunction fn${id}() {}\n`]));
    const progress = new Map();
    const deps = { ...localDeps, call: f.call, git: fakeGit(), readSource: fakeSource(files), resolveSymbol, now: () => t, progress };
    await expect(markCheckpointFlow({ boardId: 1n }, deps)).rejects.toThrow(
      're-anchored 2 of 3 refs; call again to continue (no checkpoint is recorded until a call completes)'
    );
    const move = ['setCodeRefHashes', 'updateCodeRef']; // the new lines' hashes, then the lines
    expect(f.calls.map(c => c.name)).toEqual([...move, ...move]);
    expect(f.sessions[0].checkpoint).toBe(0);
    const res = await markCheckpointFlow({ boardId: 1n }, deps);
    expect(res).toMatchObject({ checkpoint: 1, reanchor: { shifted: 3, drifted: 0, stale: [], ambiguous: [], restored: [] } });
    expect(f.calls.map(c => c.name)).toEqual([...move, ...move, ...move, 'markCheckpoint']);
    // fn3 was resolved at 10-15 s, too late to start its write (G15 review): the next call resolves it again
    expect(resolveSymbol.mock.calls.map(c => c[2])).toEqual(['fn1', 'fn2', 'fn3', 'fn3']);
    expect(progress.size).toBe(0); // cleared once the checkpoint is recorded
  });

  it('resumes: stale, ambiguous and unparseable refs are not re-resolved by the next call (G15)', async () => {
    const f = fakeConn({
      boards: [{ id: 1n, name: 's' }],
      sessions: [session(0)],
      nodes: [{ id: 5n, boardId: 1n }],
      codeRefs: [1n, 2n, 3n, 4n].map(id => ref(id, `${id}.ts`, `fn${id}`, 1, 1, `function fn${id}() {}`, 'old')),
    });
    let t = 0;
    const resolveSymbol = vi.fn((_abs: string, _src: string, symbol: string): ResolveResult => {
      t += 5000;
      if (symbol === 'fn1') return { ok: false, reason: 'not_found', suggestions: [] };
      if (symbol === 'fn2') return { ok: false, reason: 'ambiguous', candidates: [] };
      if (symbol === 'fn3') return { ok: false, reason: 'parse_error', message: 'x' };
      return okRange(2, 2, symbol);
    });
    const files = Object.fromEntries([1, 2, 3, 4].map(id => [`${id}.ts`, `// moved\nfunction fn${id}() {}\n`]));
    const progress = new Map();
    const deps = { ...localDeps, call: f.call, git: fakeGit(), readSource: fakeSource(files), resolveSymbol, now: () => t, progress };
    await expect(markCheckpointFlow({ boardId: 1n }, deps)).rejects.toThrow('re-anchored 3 of 4 refs; call again to continue');
    const res = await markCheckpointFlow({ boardId: 1n }, deps);
    expect(resolveSymbol.mock.calls.map(c => c[2])).toEqual(['fn1', 'fn2', 'fn3', 'fn4']); // each once
    expect(res.reanchor).toEqual({ shifted: 1, drifted: 0, stale: ['fn1 1.ts id=1'], ambiguous: ['fn2 2.ts id=2'], restored: [] });
    expect(f.calls.map(c => c.name)).toEqual(['updateCodeRef', 'updateCodeRef', 'setCodeRefHashes', 'updateCodeRef', 'markCheckpoint']);
  });

  it('hashing costs time: one hash call per mark_checkpoint, and the second call finishes (G15)', async () => {
    const f = fakeConn({
      boards: [{ id: 1n, name: 's' }],
      sessions: [session(0)],
      nodes: [{ id: 5n, boardId: 1n }],
      codeRefs: [ref(1n, 'a.ts', 'fnA', 1, 1, 'function fnA() {}', 'old'), ref(2n, 'a.ts', 'fnB', 2, 2, 'function fnB() {}', 'old'), ref(3n, 'c.ts', 'fnC', 1, 1, 'function fnC() {}', 'old')],
    });
    let t = 0;
    const git = fakeGit();
    const hashFiles = git.hashFiles;
    git.hashFiles = (r, rels) => {
      t += 5000; // a slow git: 5 s per call
      return hashFiles(r, rels);
    };
    const resolveSymbol = (_abs: string, _src: string, symbol: string): ResolveResult => {
      t += 3000;
      return symbol === 'fnB' ? okRange(3, 3, symbol) : okRange(2, 2, symbol);
    };
    const files = { 'a.ts': '// moved\nfunction fnA() {}\nfunction fnB() {}\n', 'c.ts': '// moved\nfunction fnC() {}\n' };
    const deps = { ...localDeps, call: f.call, git, readSource: fakeSource(files), resolveSymbol, now: () => t, progress: new Map() };
    await expect(markCheckpointFlow({ boardId: 1n }, deps)).rejects.toThrow('re-anchored 2 of 3 refs; call again to continue');
    const res = await markCheckpointFlow({ boardId: 1n }, deps);
    expect(res).toMatchObject({ checkpoint: 1, reanchor: { shifted: 3 } });
    expect(git.hashed).toEqual([['a.ts', 'c.ts'], ['a.ts', 'c.ts']]);
  });

  it('a ref whose file changed between calls is evaluated again (G15)', async () => {
    const f = fakeConn({
      boards: [{ id: 1n, name: 's' }],
      sessions: [session(0)],
      nodes: [{ id: 5n, boardId: 1n }],
      codeRefs: [ref(1n, 'x.ts', 'fnX', 1, 1, 'function fnX() {}', 'old'), ref(2n, 'y.ts', 'fnY', 1, 1, 'function fnY() {}', 'old'), ref(3n, 'z.ts', 'fnZ', 1, 1, 'function fnZ() {}', 'old')],
    });
    let t = 0;
    let cost = 5000; // slow only in the first call
    const files: Record<string, string> = { 'x.ts': 'function renamed() {}\n', 'y.ts': '// moved\nfunction fnY() {}\n', 'z.ts': '// moved\nfunction fnZ() {}\n' };
    const resolveSymbol = (_abs: string, src: string, symbol: string): ResolveResult => {
      t += cost;
      return src.includes(symbol) ? okRange(2, 2, symbol) : { ok: false, reason: 'not_found', suggestions: [] };
    };
    const git = fakeGit({ hashObject: (_r, rel) => `sha-${rel}-${files[rel].length}` });
    const deps = { ...localDeps, call: f.call, git, readSource: fakeSource(files), resolveSymbol, now: () => t, progress: new Map() };
    await expect(markCheckpointFlow({ boardId: 1n }, deps)).rejects.toThrow('re-anchored 2 of 3 refs; call again to continue');
    expect(f.codeRefs[0].status).toBe('stale');
    files['x.ts'] = '// back\nfunction fnX() {}\n'; // the symbol came back: a new sha
    cost = 0;
    const res = await markCheckpointFlow({ boardId: 1n }, deps);
    expect(f.codeRefs[0]).toMatchObject({ status: 'ok', startLine: 2 });
    expect(res.reanchor).toEqual({ shifted: 3, drifted: 0, stale: [], ambiguous: [], restored: ['fnX x.ts id=1'] });
  });

  // Five changed files, each with an ok ref whose blob is unchanged (no re-anchoring work).
  function coverageScenario(hunkMs: number, paths = ['p1.ts', 'p2.ts', 'p3.ts', 'p4.ts', 'p5.ts']) {
    const f = fakeConn({
      boards: [{ id: 1n, name: 's' }],
      sessions: [session(0)],
      nodes: [{ id: 5n, boardId: 1n }],
      codeRefs: paths.map((p, i) => ref(BigInt(i + 1), p, `fn${i}`, 1, 1, `function fn${i}() {}`, `sha-${p}`)),
      refHashes: paths.map((_p, i) => ({ refId: BigInt(i + 1), boardId: 1n, lineHashes: lineHash(`function fn${i}() {}`) })),
    });
    const clock = { t: 0 };
    const git = fakeGit({
      changed: () => paths,
      hunks: (_r, _b, rel) => {
        clock.t += hunkMs;
        git.log.push(`hunks ${rel}`);
        return [{ start: 1, end: 1 }];
      },
    });
    const files = Object.fromEntries(paths.map((p, i) => [p, `function fn${i}() {}\n`]));
    const deps = { ...localDeps, call: f.call, git, readSource: fakeSource(files), now: () => clock.t, progress: new Map() };
    return { f, git, clock, deps };
  }

  it('one deadline for the whole flow: coverage stops at K of M changed files and the next call resumes from cached hunks (G15)', async () => {
    const { f, git, deps } = coverageScenario(4000); // 4 s per hunks call
    await expect(markCheckpointFlow({ boardId: 1n }, deps)).rejects.toThrow(
      're-anchored all 5 refs; coverage stopped at 4 of 5 changed files; call again to continue (no checkpoint is recorded until a call completes)'
    );
    expect(f.calls.map(c => c.name)).toEqual([]);
    const res = await markCheckpointFlow({ boardId: 1n }, deps);
    expect(res).toMatchObject({ checkpoint: 1, coverage: { changed: 5, uncovered: [] } });
    expect(git.log).toEqual(['hunks p1.ts', 'hunks p2.ts', 'hunks p3.ts', 'hunks p4.ts', 'hunks p5.ts']); // each file diffed once
  });

  it('stops before the final write when coverage ends past the deadline; the next call records it (G15)', async () => {
    const { f, deps } = coverageScenario(4000, ['p1.ts', 'p2.ts', 'p3.ts', 'p4.ts']);
    await expect(markCheckpointFlow({ boardId: 1n }, deps)).rejects.toThrow(
      're-anchored all 4 refs and covered all 4 changed files; call again to record the checkpoint (no checkpoint is recorded until a call completes)'
    );
    expect(f.calls.map(c => c.name)).toEqual([]);
    await expect(markCheckpointFlow({ boardId: 1n }, deps)).resolves.toMatchObject({ checkpoint: 1 });
  });

  it('passes the time left before the cut-off as the timeout to git and to reducer calls (G15)', async () => {
    const f = fakeConn({
      boards: [{ id: 1n, name: 's' }],
      sessions: [session(0)],
      nodes: [{ id: 5n, boardId: 1n }],
      codeRefs: [ref(1n, 'a.ts', 'fnA', 1, 1, 'function fnA() {}', 'old')],
    });
    let t = 0;
    const seen: string[] = [];
    const call: Call = (label, fn, timeoutMs) => {
      if (timeoutMs !== undefined) seen.push(`${label} ${timeoutMs}`);
      return fn(f.conn);
    };
    const git = fakeGit({
      hashFiles: (_r, rels, ms) => {
        seen.push(`hashFiles ${ms}`);
        t += 2000;
        return rels.map(r => `sha-${r}`);
      },
      changed: (_r, _b, ms) => {
        seen.push(`changed ${ms}`);
        t += 1000;
        return ['a.ts'];
      },
      deleted: (_r, _b, ms) => (seen.push(`deleted ${ms}`), []),
      untracked: (_r, ms) => (seen.push(`untracked ${ms}`), []),
      hunks: (_r, _b, _p, ms) => (seen.push(`hunks ${ms}`), [{ start: 2, end: 2 }]),
      head: (_r, ms) => (seen.push(`head ${ms}`), 'h'.repeat(40)),
    });
    const resolveSymbol = (): ResolveResult => {
      t += 3000;
      return okRange(2, 2, 'fnA');
    };
    await markCheckpointFlow({ boardId: 1n }, { ...localDeps, call, git, readSource: fakeSource({ 'a.ts': '// x\nfunction fnA() {}\n' }), resolveSymbol, now: () => t, progress: new Map() });
    // cut-off = entry + 14 s: hashing at 0 s, the write at 5 s, coverage from 5 s, head and mark at 6 s
    expect(seen).toEqual(['hashFiles 14000', 'set_code_ref_hashes 9000', 'update_code_ref 9000', 'changed 9000', 'deleted 8000', 'untracked 8000', 'hunks 8000', 'head 8000', 'mark_checkpoint 8000']);
  });

  it('a file rewritten after its text was read gets the sha of the text that was read; the next checkpoint catches up (G15 review)', async () => {
    const f = fakeConn({
      boards: [{ id: 1n, name: 's' }],
      sessions: [session(0)],
      nodes: [{ id: 5n, boardId: 1n }],
      codeRefs: [ref(1n, 'a.ts', 'fnA', 1, 1, 'function fnA() {}', 'old')],
    });
    const disk: Record<string, string> = { 'a.ts': '// moved\nfunction fnA() {}\n' };
    const shaOf = (text: string) => `sha-${Buffer.byteLength(text)}`;
    const git = fakeGit({
      hashObject: (_r, _rel, bytes) => shaOf(bytes.toString()), // hashes what was read
      hashFiles: (_r, rels) => rels.map(rel => shaOf(disk[rel])), // reads the disk now
    });
    let raced = false;
    const read = fakeSource(disk);
    const racy = (root: string, rel: string): SourceFile => {
      const src = read(root, rel);
      if (!raced) {
        raced = true; // a formatter rewrites the file right after it was read
        disk['a.ts'] = '// moved\n// a formatter wrote here\n\nfunction fnA() { return 2; }\n';
      }
      return src;
    };
    await markCheckpointFlow({ boardId: 1n }, { ...localDeps, call: f.call, git, readSource: racy, progress: new Map() });
    expect(f.codeRefs[0]).toMatchObject({ startLine: 2, endLine: 2, blobSha: shaOf('// moved\nfunction fnA() {}\n'), snippet: 'function fnA() {}' });
    await markCheckpointFlow({ boardId: 1n }, { ...localDeps, call: f.call, git, readSource: read, progress: new Map() });
    expect(f.codeRefs[0]).toMatchObject({ startLine: 4, endLine: 4, blobSha: shaOf(disk['a.ts']), snippet: 'function fnA() { return 2; }' });
  });

  it('a batch hash that fails (a file deleted meanwhile) falls back to hashing what was read (G15 review)', async () => {
    const f = fakeConn({
      boards: [{ id: 1n, name: 's' }],
      sessions: [session(0)],
      nodes: [{ id: 5n, boardId: 1n }],
      codeRefs: [ref(1n, 'a.ts', 'fnA', 1, 1, 'function fnA() {}', 'old')],
    });
    const git = fakeGit({
      hashFiles: () => {
        throw new Error("git unavailable or not a repo: git hash-object in /r: fatal: could not open 'a.ts' for reading");
      },
    });
    const res = await markCheckpointFlow({ boardId: 1n }, { ...localDeps, call: f.call, git, readSource: fakeSource({ 'a.ts': '// moved\nfunction fnA() {}\n' }), progress: new Map() });
    expect(res).toMatchObject({ checkpoint: 1, reanchor: { shifted: 1 } });
    expect(f.codeRefs[0]).toMatchObject({ startLine: 2, blobSha: 'sha-a.ts' });
  });

  // N refs on N files, each moved down one line; hashing costs clock time.
  function hashScenario(n: number) {
    const paths = Array.from({ length: n }, (_, i) => `f${i}.ts`);
    const f = fakeConn({
      boards: [{ id: 1n, name: 's' }],
      sessions: [session(0)],
      nodes: [{ id: 5n, boardId: 1n }],
      codeRefs: paths.map((p, i) => ref(BigInt(i + 1), p, `fn${i}`, 1, 1, `function fn${i}() {}`, 'old')),
    });
    const files = Object.fromEntries(paths.map((p, i) => [p, `// moved\nfunction fn${i}() {}\n`]));
    const clock = { t: 0 };
    const git = fakeGit({ hashObject: (_r, rel) => `sha-${rel}-${files[rel].length}` });
    return { f, files, clock, git, deps: { ...localDeps, call: f.call, git, readSource: fakeSource(files, { stamps: true }), now: () => clock.t, progress: new Map() } };
  }

  it('a slow clean filter: files are hashed in chunks within the budget, and cached by stamp so the next call hashes only the rest (G15 review)', async () => {
    const { f, files, clock, git, deps } = hashScenario(40);
    const hashFiles = git.hashFiles;
    git.hashFiles = (r, rels) => {
      clock.t += 500 * rels.length; // 0.5 s per file
      return hashFiles(r, rels);
    };
    await expect(markCheckpointFlow({ boardId: 1n }, deps)).rejects.toThrow(
      'hashed 32 of 40 ref files; call again to continue (no checkpoint is recorded until a call completes)'
    );
    expect(git.hashed.map(c => c.length)).toEqual([16, 16]);
    files['f0.ts'] = '// moved\n// again\nfunction fn0() {}\n'; // its stamp changes, so it is hashed again
    const res = await markCheckpointFlow({ boardId: 1n }, deps);
    expect(git.hashed.map(c => c.length)).toEqual([16, 16, 9]);
    expect(git.hashed[2]).toEqual(['f0.ts', ...Array.from({ length: 8 }, (_, i) => `f${32 + i}.ts`)]);
    expect(res).toMatchObject({ checkpoint: 1, reanchor: { shifted: 40 } });
    expect(f.codeRefs[0]).toMatchObject({ startLine: 3, blobSha: `sha-f0.ts-${files['f0.ts'].length}` });
  });

  it('a failing batch falls back to one file at a time, within the budget (G15 review)', async () => {
    const { clock, git, deps } = hashScenario(4);
    git.hashFiles = () => {
      throw new Error('git unavailable or not a repo: git hash-object timed out');
    };
    const hashObject = git.hashObject;
    const one: string[] = [];
    git.hashObject = (r, rel, bytes) => {
      clock.t += 5000;
      one.push(rel);
      return hashObject(r, rel, bytes);
    };
    await expect(markCheckpointFlow({ boardId: 1n }, deps)).rejects.toThrow('hashed 3 of 4 ref files; call again to continue');
    await expect(markCheckpointFlow({ boardId: 1n }, deps)).resolves.toMatchObject({ checkpoint: 1, reanchor: { shifted: 4 } });
    expect(one).toEqual(['f0.ts', 'f1.ts', 'f2.ts', 'f3.ts']); // each file hashed once
  });

  it('never starts a reducer write with less than 2 s left; the next call does it (G15 review)', async () => {
    const f = fakeConn({
      boards: [{ id: 1n, name: 's' }],
      sessions: [session(0)],
      nodes: [{ id: 5n, boardId: 1n }],
      codeRefs: [ref(1n, 'a.ts', 'fnA', 1, 1, 'function fnA() {}', 'old')],
    });
    let t = 0;
    let cost = 12500; // the resolve ends 1.5 s before the cut-off
    const timeouts: number[] = [];
    const call: Call = (_label, fn, timeoutMs) => {
      if (timeoutMs !== undefined) timeouts.push(timeoutMs);
      return fn(f.conn);
    };
    const resolveSymbol = (): ResolveResult => {
      t += cost;
      return okRange(2, 2, 'fnA');
    };
    const deps = { ...localDeps, call, git: fakeGit(), readSource: fakeSource({ 'a.ts': '// x\nfunction fnA() {}\n' }), resolveSymbol, now: () => t, progress: new Map() };
    await expect(markCheckpointFlow({ boardId: 1n }, deps)).rejects.toThrow('re-anchored 0 of 1 refs; call again to continue');
    expect(f.calls).toEqual([]);
    cost = 0;
    await expect(markCheckpointFlow({ boardId: 1n }, deps)).resolves.toMatchObject({ checkpoint: 1, reanchor: { shifted: 1 } });
    expect(Math.min(...timeouts)).toBeGreaterThanOrEqual(2000);
  });

  it('does not start the final write with less than 2 s left (G15 review)', async () => {
    const { f, deps } = coverageScenario(12500, ['p1.ts']); // coverage ends at 12.5 s
    await expect(markCheckpointFlow({ boardId: 1n }, deps)).rejects.toThrow('call again to record the checkpoint');
    expect(f.calls).toEqual([]);
    await expect(markCheckpointFlow({ boardId: 1n }, deps)).resolves.toMatchObject({ checkpoint: 1 });
  });

  it('progress from a wiped and recreated session with the same ids is not reused: startedAt differs (G15 review)', async () => {
    const f = fakeConn({
      boards: [{ id: 1n, name: 's' }],
      sessions: [{ ...session(0), startedAt: { microsSinceUnixEpoch: 100n } }],
      nodes: [{ id: 5n, boardId: 1n }],
      codeRefs: [1n, 2n].map(id => ref(id, `${id}.ts`, `fn${id}`, 1, 1, `function fn${id}() {}`, 'old')),
    });
    let t = 0;
    let cost = 14000; // the first call stops after one ref
    const resolveSymbol = vi.fn((_abs: string, _src: string, symbol: string): ResolveResult => {
      t += cost;
      return { ok: false, reason: 'parse_error', message: symbol }; // no write
    });
    const files = { '1.ts': 'x\n', '2.ts': 'y\n' };
    const deps = { ...localDeps, call: f.call, git: fakeGit(), readSource: fakeSource(files), resolveSymbol, now: () => t, progress: new Map() };
    await expect(markCheckpointFlow({ boardId: 1n }, deps)).rejects.toThrow('re-anchored 1 of 2 refs');
    f.sessions[0].startedAt = { microsSinceUnixEpoch: 999n }; // same session id and checkpoint, new incarnation
    cost = 0;
    await markCheckpointFlow({ boardId: 1n }, deps);
    expect(resolveSymbol.mock.calls.map(c => c[2])).toEqual(['fn1', 'fn1', 'fn2']);
  });

  // A README ref on lines 3-4 ("## Limiter" + its sentence); the changed file is the second argument.
  function readmeScenario(text: string, status = 'ok') {
    const snippet = '## Limiter\nthe Limiter allows bursts';
    const f = fakeConn({
      boards: [{ id: 1n, name: 's' }],
      sessions: [session(0)],
      nodes: [{ id: 5n, boardId: 1n }],
      codeRefs: [{ ...ref(1n, 'README.md', 'Limiter', 3, 4, snippet, 'old'), status }],
    });
    const git = fakeGit({ changed: () => ['README.md'], hunks: () => [{ start: 3, end: 4 }] });
    return { f, deps: { ...localDeps, call: f.call, git, readSource: fakeSource({ 'README.md': text }), progress: new Map() } };
  }

  it('non-TS ref, lines inserted above → shifted (G4)', async () => {
    const { f, deps } = readmeScenario('# Title\nnew intro\nmore intro\nintro\n## Limiter\nthe Limiter allows bursts\n');
    const res = await markCheckpointFlow({ boardId: 1n }, deps);
    expect(f.codeRefs[0]).toMatchObject({ status: 'ok', startLine: 5, endLine: 6, blobSha: 'sha-README.md', snippet: '## Limiter\nthe Limiter allows bursts' });
    expect(res.reanchor).toEqual({ shifted: 1, drifted: 0, stale: [], ambiguous: [], restored: [] });
  });

  it('non-TS ref, snippet edited → stale, listed, no longer covers (G4)', async () => {
    const { f, deps } = readmeScenario('# Title\nintro\n## Limiter\nthe Limiter allows short bursts\n');
    const res = await markCheckpointFlow({ boardId: 1n }, deps);
    expect(f.codeRefs[0]).toMatchObject({ status: 'stale', startLine: 3, endLine: 4, blobSha: 'old' });
    expect(res.reanchor).toEqual({ shifted: 0, drifted: 0, stale: ['Limiter README.md id=1'], ambiguous: [], restored: [] });
    expect(res.coverage.uncovered).toEqual(['README.md']); // a stale ref does not cover its old hunk
  });

  it('non-TS ref whose lines now occur twice → stale; found once again later → ok and restored (G4)', async () => {
    const twice = readmeScenario('## Limiter\nthe Limiter allows bursts\n## Limiter\nthe Limiter allows bursts\n');
    await expect(markCheckpointFlow({ boardId: 1n }, twice.deps)).resolves.toMatchObject({ reanchor: { stale: ['Limiter README.md id=1'] } });
    const back = readmeScenario('intro\n## Limiter\nthe Limiter allows bursts\n', 'stale');
    const res = await markCheckpointFlow({ boardId: 1n }, back.deps);
    expect(back.f.codeRefs[0]).toMatchObject({ status: 'ok', startLine: 2, endLine: 3 });
    expect(res.reanchor).toMatchObject({ shifted: 1, restored: ['Limiter README.md id=1'] });
  });

  // 40 stat-dirty candidates git confirms one file at a time (0.5 s each, a slow filter); g0.txt was only touched.
  function confirmScenario() {
    const f = fakeConn({ boards: [{ id: 1n, name: 's' }], sessions: [session(0)], nodes: [{ id: 5n, boardId: 1n }] });
    const paths = Array.from({ length: 40 }, (_, i) => `g${i}.txt`);
    const clock = { t: 0 };
    const offered: number[] = [];
    const processed: number[] = [];
    const stamps: Record<string, string> = {};
    const git = fakeGit({
      changeCandidates: () => [{ path: 'added.txt', sure: true }, ...paths.map(path => ({ path, sure: false }))],
      indexPath: () => '.git/index',
      confirmChanged: (_r, _b, chunk, _ms, more) => {
        offered.push(chunk.length);
        const out = new Map<string, { changed: boolean; reason?: string }>();
        for (const [k, p] of chunk.entries()) {
          if (k > 0 && more && !more()) break;
          clock.t += 500;
          out.set(p, { changed: p !== 'g0.txt' });
        }
        processed.push(out.size);
        return out;
      },
    });
    const deps = { ...localDeps, call: f.call, git, readSource: fakeSource({}), now: () => clock.t, progress: new Map(), stamp: (_r: string, rel: string) => stamps[rel] ?? `st-${rel}` };
    return { paths, offered, processed, stamps, deps };
  }

  it('coverage listing: git confirms stat-dirty files within the budget, kept by stamp across calls; a touched file is not reported (G15 review)', async () => {
    const { paths, offered, processed, deps } = confirmScenario();
    await expect(markCheckpointFlow({ boardId: 1n }, deps)).rejects.toThrow(
      're-anchored all 0 refs; coverage stopped while checking changed files (27 of 40 checked); call again to continue'
    );
    const res = await markCheckpointFlow({ boardId: 1n }, deps);
    expect(offered).toEqual([40, 13]); // each file confirmed once, across calls
    expect(processed).toEqual([27, 13]);
    expect(res.coverage.changed).toBe(40);
    expect(res.coverage.uncovered).toEqual(['added.txt', ...paths.slice(1)]);
  });

  it('coverage listing: a new index (git add, checkout) or a new stamp means confirming again (G15 review)', async () => {
    const { offered, stamps, deps } = confirmScenario();
    await expect(markCheckpointFlow({ boardId: 1n }, deps)).rejects.toThrow('(27 of 40 checked)');
    stamps['.git/index'] = 'st-index-2'; // the index changed: eol and filter answers may too
    await expect(markCheckpointFlow({ boardId: 1n }, deps)).rejects.toThrow('(27 of 40 checked)');
    expect(offered).toEqual([40, 40]);
  });

  // a.ts (with a ref) and b.txt (without) both changed and stat-dirty; git.hunks is the injected step.
  function diffScenario(hunks: GitOps['hunks'], extra: CodeRefRow[] = []) {
    const f = fakeConn({
      boards: [{ id: 1n, name: 's' }],
      sessions: [session(0)],
      nodes: [{ id: 5n, boardId: 1n }],
      codeRefs: [ref(1n, 'a.ts', 'fnA', 2, 2, 'function fnA() {}', 'sha-a.ts'), ...extra],
    });
    const diffed: string[] = [];
    const clock = { t: 0 };
    const git = fakeGit({
      changeCandidates: () => [{ path: 'a.ts', sure: false }, { path: 'b.txt', sure: false }, ...extra.map(r => ({ path: r.path, sure: false }))],
      hunks: (r, b, p, ms) => {
        diffed.push(p);
        return hunks(r, b, p, ms);
      },
    });
    const files = Object.fromEntries([['a.ts', '// x\nfunction fnA() {}\n'], ...extra.map(r => [r.path, `// x\n${r.snippet}\n`])]);
    return { f, diffed, clock, deps: { ...localDeps, call: f.call, git, readSource: fakeSource(files), now: () => clock.t, progress: new Map() } };
  }

  it('the changed-lines diff (-U0) runs only for changed files that have refs (G15 review)', async () => {
    const { diffed, deps } = diffScenario(() => [{ start: 2, end: 2 }]);
    const res = await markCheckpointFlow({ boardId: 1n }, deps);
    expect(diffed).toEqual(['a.ts']);
    expect(res.coverage).toEqual({ changed: 2, uncovered: ['b.txt'], excluded: [], deleted: [] });
    expect(res.notes).toBeUndefined();
  });

  it('a file with refs whose diff is too large counts as uncovered, with the reason; the checkpoint completes (G15 review)', async () => {
    const { diffed, deps } = diffScenario(() => {
      throw new GitOutputTooLargeError('git unavailable or not a repo: git diff output exceeded 64 MiB in /r', 'git diff output exceeded 64 MiB');
    });
    const res = await markCheckpointFlow({ boardId: 1n }, deps);
    expect(res).toMatchObject({ checkpoint: 1, coverage: { changed: 2, uncovered: ['a.ts', 'b.txt'] } });
    expect(res.notes).toEqual(['a.ts: git diff output exceeded 64 MiB; its changed lines are unknown, so it counts as uncovered']);
    expect(diffed).toEqual(['a.ts']);
  });

  it('the full git timeout on that diff is the same; a timeout cut short by the deadline says call again, and nothing is kept (G15 review)', async () => {
    const full = diffScenario(() => {
      throw new GitTimeoutError('git unavailable or not a repo: git diff timed out after 10 s in /r; …', 'git diff timed out after 10 s', false);
    });
    await expect(markCheckpointFlow({ boardId: 1n }, full.deps)).resolves.toMatchObject({
      notes: ['a.ts: git diff timed out after 10 s; its changed lines are unknown, so it counts as uncovered'],
    });
    let cut = true;
    const limited = diffScenario(() => {
      if (cut) throw new GitTimeoutError('git unavailable or not a repo: git diff timed out after 0.5 s in /r; …', 'git diff timed out after 0.5 s', true);
      return [{ start: 2, end: 2 }];
    });
    await expect(markCheckpointFlow({ boardId: 1n }, limited.deps)).rejects.toThrow('re-anchored all 1 refs; coverage stopped at 0 of 2 changed files; call again to continue');
    cut = false;
    await expect(markCheckpointFlow({ boardId: 1n }, limited.deps)).resolves.toMatchObject({ coverage: { uncovered: ['b.txt'] } });
    expect(limited.diffed).toEqual(['a.ts', 'a.ts']);
  });

  it('an unknown range is kept with the sha of the file: a later call of the same checkpoint does not diff it again (G15 review)', async () => {
    const slow = ref(2n, 's.ts', 'fnS', 2, 2, 'function fnS() {}', 'sha-s.ts');
    const { diffed, clock, deps } = diffScenario((_r, _b, p) => {
      if (p === 'a.ts') throw new GitOutputTooLargeError('…', 'git diff output exceeded 64 MiB');
      clock.t += 14_000; // s.ts takes the rest of the budget
      return [{ start: 2, end: 2 }];
    }, [slow]);
    clock.t = 0;
    const first = markCheckpointFlow({ boardId: 1n }, deps);
    await expect(first).rejects.toThrow('call again');
    const res = await markCheckpointFlow({ boardId: 1n }, deps);
    expect(diffed).toEqual(['a.ts', 's.ts']); // neither diffed twice
    expect(res.notes).toEqual(['a.ts: git diff output exceeded 64 MiB; its changed lines are unknown, so it counts as uncovered']);
  });

  it('a file git could not compare in time counts as changed, with the reason (G15 review)', async () => {
    const f = fakeConn({ boards: [{ id: 1n, name: 's' }], sessions: [session(0)], nodes: [{ id: 5n, boardId: 1n }] });
    const git = fakeGit({
      changeCandidates: () => [{ path: 'huge.bin', sure: false }],
      confirmChanged: (_r, _b, paths) => new Map(paths.map(p => [p, { changed: true, reason: 'git diff timed out after 10 s' }])),
    });
    const res = await markCheckpointFlow({ boardId: 1n }, { ...localDeps, call: f.call, git, readSource: fakeSource({}), progress: new Map() });
    expect(res.coverage.uncovered).toEqual(['huge.bin']);
    expect(res.notes).toEqual(['huge.bin: git diff timed out after 10 s; counted as changed']);
  });

  it('leaves a ref untouched when its file no longer parses, to be retried at the next checkpoint', async () => {
    const f = fakeConn({
      boards: [{ id: 1n, name: 's' }],
      sessions: [session(0)],
      nodes: [{ id: 5n, boardId: 1n }],
      codeRefs: [ref(1n, 'p.ts', 'fnP', 1, 1, 'function fnP() {}', 'old')],
    });
    const res = await markCheckpointFlow(
      { boardId: 1n },
      { ...localDeps, call: f.call, git: fakeGit(), readSource: fakeSource({ 'p.ts': 'function fnP( {\n' }), resolveSymbol: () => ({ ok: false, reason: 'parse_error', message: "1:16 '}' expected." }) }
    );
    expect(f.codeRefs[0]).toMatchObject({ status: 'ok', blobSha: 'old', startLine: 1, endLine: 1 });
    expect(res.reanchor).toEqual({ shifted: 0, drifted: 0, stale: [], ambiguous: [], restored: [] });
    expect(f.calls.map(c => c.name)).toEqual(['markCheckpoint']);
  });
});

describe('reanchor — the one re-anchor decision, shared by mark_checkpoint and the eval (G22)', () => {
  // A resolver that keeps an instance and a static member of one name apart
  // (the eval used to call resolveSymbol directly and failed such refs).
  const LIMITER = [
    'class Limiter {',
    '  // moved down by one line',
    '  allow(): boolean {',
    '    return true;',
    '  }',
    '  static allow(): boolean {',
    '    return false;',
    '  }',
    '}',
  ].join('\n');
  const lines = LIMITER.split('\n');
  const twoAllows = (): ResolveResult => ({
    ok: false,
    reason: 'ambiguous',
    candidates: [
      { name: 'Limiter.allow', kind: 'method', startLine: 3, endLine: 5 },
      { name: 'Limiter.allow', kind: 'method', startLine: 6, endLine: 8 },
    ],
  });
  const staticSnippet = '  static allow(): boolean {\n    return false;\n  }';

  it('instance+static same name, hashes match one → shifted', async () => {
    expect(reanchor('l.ts', '/r/l.ts', LIMITER, lines, 'Limiter.allow', lineHashes(staticSnippet.split('\n')), twoAllows)).toEqual({
      ok: true,
      startLine: 6,
      endLine: 8,
      fit: { startLine: 6, endLine: 8, text: staticSnippet, clampedFrom: undefined },
    });
    expect(reanchor('l.ts', '/r/l.ts', LIMITER, lines, 'Limiter.allow', lineHashes(['  allow() {}']), twoAllows)).toEqual({ ok: false, reason: 'ambiguous' });
    expect(reanchor('l.ts', '/r/l.ts', LIMITER, lines, 'Limiter.allow', [], twoAllows)).toEqual({ ok: false, reason: 'ambiguous' }); // no stored code

    const f = fakeConn({
      boards: [{ id: 1n, name: 's' }],
      sessions: [{ id: 9n, boardId: 1n, repoRoot: '/r', baseSha: 'z'.repeat(40), headSha: '', checkpoint: 0, coverage: '{}' }],
      nodes: [{ id: 5n, boardId: 1n }],
      codeRefs: [
        { id: 1n, boardId: 1n, targetKind: 'node', targetId: 5n, path: 'l.ts', symbol: 'Limiter.allow', startLine: 5, endLine: 7, blobSha: 'old', snippet: staticSnippet, author: '', checkpoint: 1, status: 'ok' },
      ],
    });
    const res = await markCheckpointFlow({ boardId: 1n }, { ...localDeps, call: f.call, git: fakeGit(), readSource: fakeSource({ 'l.ts': LIMITER }), resolveSymbol: twoAllows });
    expect(f.codeRefs[0]).toMatchObject({ status: 'ok', startLine: 6, endLine: 8, snippet: staticSnippet, blobSha: 'sha-l.ts' });
    expect(res.reanchor).toEqual({ shifted: 1, drifted: 0, stale: [], ambiguous: [], restored: [] });
  });

  it('names every other outcome by reason', () => {
    const src = 'function a() {}\n';
    const ls = ['function a() {}'];
    // a file the resolver cannot read follows its captured lines, never the resolver (G4)
    const never = () => {
      throw new Error('not called');
    };
    const x = lineHashes(['x']);
    expect(reanchor('a.go', '/r/a.go', src, ls, 'a', x, never)).toEqual({ ok: false, reason: 'snippet_lost' });
    expect(reanchor('a.go', '/r/a.go', src, ls, 'a', lineHashes(['function a() {}']), never)).toMatchObject({ ok: true, startLine: 1, endLine: 1 });
    expect(reanchor('a.ts', '/r/a.ts', src, ls, 'b', x)).toEqual({ ok: false, reason: 'not_found' });
    expect(reanchor('a.ts', '/r/a.ts', 'function a( {', ['function a( {'], 'a', x)).toEqual({ ok: false, reason: 'parse_error' });
    expect(reanchor('a.ts', '/r/a.ts', src, ls, 'a', x, () => ({ ok: true, startLine: 1, endLine: 2, kind: 'function', name: 'a' }))).toEqual({ ok: false, reason: 'unfit' });
    expect(reanchor('a.ts', '/r/a.ts', src, ls, 'zz', x, () => ({ ok: true, startLine: 1, endLine: 1, kind: 'function', name: 'zz' }))).toEqual({ ok: false, reason: 'no_needle' });
    expect(reanchor('a.ts', '/r/a.ts', src, ls, 'a', x)).toMatchObject({ ok: true, startLine: 1, endLine: 1, fit: { text: 'function a() {}' } });
  });

  it('a non-TS ref follows the run of lines its hashes name, exactly once, else snippet_lost (RC-690)', () => {
    const never = () => {
      throw new Error('not called');
    };
    const fn = ['func Run() {', '\treturn', '}'];
    const moved = ['package main', '', '// one', '// two', '// three', ...fn];
    expect(reanchor('a.go', '/r/a.go', moved.join('\n'), moved, 'Run', lineHashes(fn), never)).toEqual({
      ok: true,
      startLine: 6,
      endLine: 8,
      fit: { startLine: 6, endLine: 8, text: fn.join('\n'), clampedFrom: undefined },
    });
    const edited = ['package main', 'func Run() {', '\treturn 1', '}'];
    expect(reanchor('a.go', '/r/a.go', edited.join('\n'), edited, 'Run', lineHashes(fn), never)).toEqual({ ok: false, reason: 'snippet_lost' });
    const twice = [...fn, ...fn];
    expect(reanchor('a.go', '/r/a.go', twice.join('\n'), twice, 'Run', lineHashes(fn), never)).toEqual({ ok: false, reason: 'snippet_lost' });
    expect(reanchor('a.go', '/r/a.go', moved.join('\n'), moved, 'Run', [], never)).toEqual({ ok: false, reason: 'snippet_lost' }); // no stored code
  });
});

describe('code consent and line hashes (RC-690)', () => {
  const TS = 'export function gitHead(root: string): string {\n  return root;\n}\n';
  const TS_HASHES = lineHashes(TS.trimEnd().split('\n')).join(' ');
  const SEND = '  send(request);';
  const session: SessionRow = { id: 9n, boardId: 1n, repoRoot: '/r', baseSha: 'z'.repeat(40), headSha: '', checkpoint: 1, coverage: '{}' };
  const row = (id: bigint, path: string, symbol: string, startLine: number, endLine: number, snippet: string, blobSha: string): CodeRefRow => ({
    id, boardId: 1n, targetKind: 'node', targetId: 5n, path, symbol, startLine, endLine, blobSha, snippet, author: '', checkpoint: 1, status: 'ok',
  });
  const seed = (storeCode: boolean) =>
    fakeConn({ storeCode, boards: [{ id: 1n, name: 's' }], nodes: [{ id: 5n, boardId: 1n }], repoFiles: [{ id: 1n, boardId: 1n, path: 'agent/src/git.ts' }] });
  const add = (f: ReturnType<typeof fakeConn>) =>
    addCodeRefFlow(
      { boardId: 1n, repoRoot: '/r', targetKind: 'node', targetId: 5n, path: 'agent/src/git.ts', symbol: 'gitHead' },
      { ...localDeps, call: f.call, git: fakeGit(), readSource: fakeSource({ 'agent/src/git.ts': TS }), resolveSymbol: () => okRange(1, 3, 'gitHead') }
    );

  it('boardStoresCode reads the board\'s consent row; no row is no', async () => {
    const f = seed(true);
    expect(await boardStoresCode(f.call, 1n)).toBe(true);
    expect(await boardStoresCode(f.call, 2n)).toBe(false);
    f.consent.storeCode = false;
    expect(await boardStoresCode(f.call, 1n)).toBe(false);
  });

  it('add ref without consent: no snippet, then the fitted lines\' hashes', async () => {
    const f = seed(false);
    await add(f);
    expect(f.calls).toEqual([
      { name: 'addCodeRef', args: expect.objectContaining({ snippet: '', startLine: 1, endLine: 3 }) },
      { name: 'setCodeRefHashes', args: { refId: 100n, lineHashes: TS_HASHES } },
    ]);
  });

  it('add ref with consent: the snippet as today, and its hashes', async () => {
    const f = seed(true);
    await add(f);
    expect(f.calls).toEqual([
      { name: 'addCodeRef', args: expect.objectContaining({ snippet: TS.trimEnd(), startLine: 1, endLine: 3 }) },
      { name: 'setCodeRefHashes', args: { refId: 100n, lineHashes: TS_HASHES } },
    ]);
  });

  it('consent turned off while the call was in flight: the module refuses the text, and the ref goes in without it', async () => {
    const f = seed(false);
    f.conn.db.visibleBoardCodeConsent.iter = () => [{ boardId: 1n, storeCode: true }]; // the cache has not seen the change yet
    const res = await add(f);
    expect(f.calls.map(c => [c.name, (c.args as { snippet?: string }).snippet])).toEqual([
      ['addCodeRef', TS.trimEnd()],
      ['addCodeRef', ''],
      ['setCodeRefHashes', undefined],
    ]);
    expect(res).toMatchObject({ id: 100n, existing: false });
    expect(f.codeRefs[0].snippet).toBe('');
  });

  it('a moved non-TS ref gets its new lines\' hashes before the move, so no hashes describe other lines', async () => {
    const md = '# Title\nintro\n## Limiter\nthe Limiter allows bursts\n';
    const f = fakeConn({ storeCode: false, nodes: [{ id: 5n, boardId: 1n }], codeRefs: [row(77n, 'README.md', 'Limiter', 1, 2, '', 'old')] });
    await addCodeRefFlow(
      { boardId: 1n, repoRoot: '/r', targetKind: 'node', targetId: 5n, path: 'README.md', symbol: 'Limiter', startLine: 3, endLine: 4 },
      { ...localDeps, call: f.call, git: fakeGit(), readSource: fakeSource({ 'README.md': md }) }
    );
    expect(f.calls).toEqual([
      { name: 'setCodeRefHashes', args: { refId: 77n, lineHashes: lineHashes(['## Limiter', 'the Limiter allows bursts']).join(' ') } },
      { name: 'updateCodeRef', args: { id: 77n, startLine: 3, endLine: 4, blobSha: 'sha-README.md', snippet: '', status: 'ok' } },
    ]);
  });

  it('prepareSourceEvidence returns the cited line\'s hash beside its text', async () => {
    const f = seed(false);
    const res = await prepareSourceEvidence(
      { ...localDeps, call: f.call, git: fakeGit(), readSource: fakeSource({ 'agent/src/git.ts': TS }), budget: flowBudget(Date.now), canonicalPath: (_r, p) => p },
      1n,
      '/r',
      'source:agent/src/git.ts:2'
    );
    expect(res).toEqual({ evidence: 'source:agent/src/git.ts:2', evidenceSnippet: '  return root;', evidenceHash: lineHash('  return root;') });
  });

  it('legacy refs with neither text nor hashes: a TS ref is re-found by name and gets hashes, a .go ref goes stale, nothing throws', async () => {
    const f = fakeConn({
      storeCode: false,
      sessions: [{ ...session }],
      nodes: [{ id: 5n, boardId: 1n }],
      codeRefs: [row(1n, 'a.ts', 'gitHead', 1, 3, '', 'old'), row(2n, 'b.go', 'Run', 2, 2, '', 'old')],
    });
    const res = await markCheckpointFlow(
      { boardId: 1n },
      {
        ...localDeps,
        call: f.call,
        git: fakeGit(),
        readSource: fakeSource({ 'a.ts': `// moved\n${TS}`, 'b.go': 'package main\nfunc Run() {}\n' }),
        resolveSymbol: () => okRange(2, 4, 'gitHead'),
        progress: new Map(),
      }
    );
    expect(f.codeRefs[0]).toMatchObject({ status: 'ok', startLine: 2, endLine: 4, snippet: '', blobSha: 'sha-a.ts' });
    expect(f.refHashes).toEqual([{ refId: 1n, boardId: 1n, lineHashes: TS_HASHES }]);
    expect(f.codeRefs[1]).toMatchObject({ status: 'stale', startLine: 2, endLine: 2 });
    expect(res.reanchor).toMatchObject({ drifted: 1, stale: ['Run b.go id=2'] });
  });

  it('a ref with hashes and no text drifts or shifts by its hashes', async () => {
    const f = fakeConn({
      storeCode: false,
      sessions: [{ ...session }],
      nodes: [{ id: 5n, boardId: 1n }],
      codeRefs: [row(1n, 'a.ts', 'gitHead', 1, 3, '', 'old')],
      refHashes: [{ refId: 1n, boardId: 1n, lineHashes: TS_HASHES }],
    });
    const deps = { ...localDeps, call: f.call, git: fakeGit(), resolveSymbol: () => okRange(2, 4, 'gitHead'), progress: new Map() };
    const shifted = await markCheckpointFlow({ boardId: 1n }, { ...deps, readSource: fakeSource({ 'a.ts': `// moved\n${TS}` }) });
    expect(shifted.reanchor).toMatchObject({ shifted: 1, drifted: 0 });
    expect(f.calls.some(c => c.name === 'setCodeRefHashes')).toBe(false); // the same lines: the hashes stand
    f.codeRefs[0].blobSha = 'old';
    const drifted = await markCheckpointFlow({ boardId: 1n }, { ...deps, readSource: fakeSource({ 'a.ts': `// moved\n${TS.replace('root;', 'root + 1;')}` }) });
    expect(drifted.reanchor).toMatchObject({ shifted: 0, drifted: 1 });
    expect(f.refHashes[0].lineHashes).not.toBe(TS_HASHES);
  });

  it('a citation follows its line hash, and goes stale when the line appears twice', async () => {
    const edge = { id: 1n, boardId: 1n, evidence: 'source:a.ts:1', evidenceSnippet: '', evidenceStatus: 'ok' };
    const f = fakeConn({ storeCode: false, sessions: [{ ...session }], edges: [edge], edgeHashes: [{ edgeId: 1n, boardId: 1n, lineHash: lineHash(SEND) }] });
    const deps = { ...localDeps, call: f.call, git: fakeGit(), progress: new Map() };
    await markCheckpointFlow({ boardId: 1n }, { ...deps, readSource: fakeSource({ 'a.ts': `// moved\n${SEND}\n` }) });
    expect(f.calls.filter(c => c.name === 'updateEdgeEvidence').map(c => c.args)).toEqual([{ edgeId: 1n, evidence: 'source:a.ts:2', status: 'ok' }]);
    expect(f.calls.some(c => c.name === 'setEdgeEvidenceCode')).toBe(false); // its hash is there, and the board keeps no text
    const res = await markCheckpointFlow({ boardId: 1n }, { ...deps, readSource: fakeSource({ 'a.ts': `${SEND}\n${SEND}\n` }) });
    expect(edge).toMatchObject({ evidence: 'source:a.ts:2', evidenceStatus: 'stale', evidenceSnippet: '' });
    expect(res.reanchor.stale).toEqual(['edge 1 source:a.ts:2']);
  });

  it('fill pass never sends a ref\'s text that looks like a secret: hashes only, and the checkpoint goes on', async () => {
    const key = 'sk_' + 'live_' + 'x1'.repeat(12); // split so no scanner flags this file
    const f = fakeConn({ storeCode: true, sessions: [{ ...session }], nodes: [{ id: 5n, boardId: 1n }], codeRefs: [row(1n, 'a.ts', 'stripeKey', 1, 1, '', 'sha-a.ts')] });
    // the ref was added while the board kept no code, so its line was never checked; then the owner opted in
    const res = await markCheckpointFlow(
      { boardId: 1n },
      { ...localDeps, call: guardSecrets(f.call, true), git: fakeGit(), readSource: fakeSource({ 'a.ts': `export const stripeKey = '${key}';\n` }), progress: new Map() }
    );
    expect(f.calls.map(c => c.name)).toEqual(['setCodeRefHashes', 'markCheckpoint']);
    expect(f.codeRefs[0].snippet).toBe('');
    expect(res.checkpoint).toBe(2);
  });

  it('fill pass on unchanged files: missing hashes everywhere, missing text where the board stores code', async () => {
    const edges = [
      { id: 1n, boardId: 1n, evidence: 'source:a.ts:2', evidenceSnippet: '  return root;', evidenceStatus: 'ok' }, // text, no hash
      { id: 2n, boardId: 1n, evidence: 'source:a.ts:1', evidenceSnippet: '', evidenceStatus: 'ok' }, // hash, no text
    ];
    const seeded = (storeCode: boolean) =>
      fakeConn({
        storeCode,
        sessions: [{ ...session }],
        nodes: [{ id: 5n, boardId: 1n }],
        codeRefs: [row(1n, 'a.ts', 'gitHead', 1, 3, '', 'sha-a.ts')],
        edges: edges.map(e => ({ ...e })),
        edgeHashes: [{ edgeId: 2n, boardId: 1n, lineHash: lineHash('export function gitHead(root: string): string {') }],
      });
    const run = (f: ReturnType<typeof fakeConn>) =>
      markCheckpointFlow({ boardId: 1n }, { ...localDeps, call: f.call, git: fakeGit(), readSource: fakeSource({ 'a.ts': TS }), progress: new Map() });

    const without = seeded(false);
    await run(without);
    expect(without.calls).toEqual([
      { name: 'setCodeRefHashes', args: { refId: 1n, lineHashes: TS_HASHES } },
      { name: 'setEdgeEvidenceCode', args: { edgeId: 1n, lineHash: lineHash('  return root;'), snippet: undefined } },
      expect.objectContaining({ name: 'markCheckpoint' }),
    ]);

    const withText = seeded(true);
    await run(withText);
    expect(withText.calls).toEqual([
      { name: 'setCodeRefHashes', args: { refId: 1n, lineHashes: TS_HASHES } },
      { name: 'updateCodeRef', args: { id: 1n, startLine: 1, endLine: 3, blobSha: 'sha-a.ts', snippet: TS.trimEnd(), status: 'ok' } },
      { name: 'setEdgeEvidenceCode', args: { edgeId: 1n, lineHash: lineHash('  return root;'), snippet: undefined } },
      { name: 'setEdgeEvidenceCode', args: { edgeId: 2n, lineHash: lineHash('export function gitHead(root: string): string {'), snippet: 'export function gitHead(root: string): string {' } },
      expect.objectContaining({ name: 'markCheckpoint' }),
    ]);
    // the next checkpoint has nothing left to fill
    await run(withText);
    expect(withText.calls.slice(5).map(c => c.name)).toEqual(['markCheckpoint']);
  });
});

describe('NFD-named files: the stored path is the one git prints (G17), against a temp repository', () => {
  // macOS keeps the NFD bytes a file was created with; git (core.precomposeunicode)
  // prints NFC. On a filesystem that keeps names as given, both are NFD.
  const NFD = 'cafe\u0301.ts';
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  let repo: string;
  let base: string;
  const sh = (args: string[]) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8' }).trim();
  beforeAll(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'rc-nfd-')));
    sh(['init', '-q', '-b', 'main']);
    writeFileSync(join(repo, NFD), 'export function brew() {\n  return 1;\n}\n');
    sh(['add', '-A']);
    sh(['commit', '-q', '-m', 'one']);
    base = sh(['rev-parse', 'HEAD']);
    writeFileSync(join(repo, NFD), 'export function brew() {\n  return 2;\n}\n');
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  const seeded = () =>
    fakeConn({
      boards: [{ id: 1n, name: 's' }],
      sessions: [{ id: 9n, boardId: 1n, repoRoot: repo, baseSha: base, headSha: '', checkpoint: 0, coverage: '{}' }],
      nodes: [{ id: 5n, boardId: 1n }],
      // what start_session seeds: git ls-files output
      repoFiles: gitListTracked(repo).map((path, i) => ({ id: BigInt(i + 1), boardId: 1n, path })),
    });

  it('NFD-named file: stored path equals git diff --name-only output', async () => {
    const changed = gitChanged(repo, base);
    expect(changed).toHaveLength(1);
    const f = seeded();
    const res = await addCodeRefFlow({ boardId: 1n, repoRoot: repo, targetKind: 'node', targetId: 5n, path: NFD, symbol: 'brew' }, { ...localDeps, call: f.call });
    expect(res.path).toBe(changed[0]);
    expect(f.codeRefs[0].path).toBe(changed[0]);
    expect(f.calls.map(c => c.name)).toEqual(['addCodeRef', 'setCodeRefHashes']); // no second repoFile row under another spelling
    const viaEdge = await ensureRepoPath({ ...localDeps, call: f.call }, 1n, repo, NFD);
    expect(viaEdge).toBe(changed[0]);
    expect(f.calls.map(c => c.name)).toEqual(['addCodeRef', 'setCodeRefHashes']);
  });

  it('NFD-named file: a ref on it then counts as covered at mark_checkpoint', async () => {
    const f = seeded();
    await addCodeRefFlow({ boardId: 1n, repoRoot: repo, targetKind: 'node', targetId: 5n, path: NFD, symbol: 'brew' }, { ...localDeps, call: f.call });
    const res = await markCheckpointFlow({ boardId: 1n }, { ...localDeps, call: f.call });
    expect(res.coverage).toEqual({ changed: 1, uncovered: [], excluded: [], deleted: [] });
  });
});

describe('coverage listing against a temp repository: the same paths git itself lists (G15 review)', () => {
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  let repo: string;
  let base: string;
  const sh = (args: string[]) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8' }).trim();
  beforeAll(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'rc-listing-')));
    sh(['init', '-q', '-b', 'main']);
    sh(['config', 'core.autocrlf', 'false']);
    for (const f of ['m.ts', 't.ts', 'x.sh', 'd.ts', 'same.ts']) writeFileSync(join(repo, f), `// ${f}\n`);
    // committed with CRLF in the blob; the eol rules arrive after the commit
    writeFileSync(join(repo, 'crlf_textauto.txt'), 'a\r\nb\r\n');
    writeFileSync(join(repo, 'crlf_autocrlf.txt'), 'a\r\nb\r\n');
    symlinkSync('same.ts', join(repo, 'link'));
    sh(['add', '-A']);
    sh(['commit', '-q', '-m', 'first']);
    writeFileSync(join(repo, '.gitattributes'), 'crlf_textauto.txt text=auto\n');
    sh(['add', '.gitattributes']);
    sh(['commit', '-q', '-m', 'base']);
    base = sh(['rev-parse', 'HEAD']);
    sh(['config', 'core.autocrlf', 'true']);
    const later = new Date(Date.now() + 5000);
    writeFileSync(join(repo, 'm.ts'), '// m.ts changed\n'); // modified
    writeFileSync(join(repo, 't.ts'), '// t.ts\n'); // rewritten with the same bytes: stat only
    chmodSync(join(repo, 'x.sh'), 0o755); // mode only
    rmSync(join(repo, 'd.ts')); // deleted
    writeFileSync(join(repo, 'n.ts'), '// new\n');
    sh(['add', 'n.ts']); // added
    writeFileSync(join(repo, 'u.ts'), '// untracked\n');
    // touched, not edited: git leaves a CRLF blob alone, whatever text=auto or core.autocrlf says
    utimesSync(join(repo, 'crlf_textauto.txt'), later, later);
    utimesSync(join(repo, 'crlf_autocrlf.txt'), later, later);
    lutimesSync(join(repo, 'link'), later, later); // touch -h
    utimesSync(join(repo, 't.ts'), later, later); // after git add, which refreshed it
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  const seeded = () =>
    fakeConn({
      boards: [{ id: 1n, name: 's' }],
      sessions: [{ id: 9n, boardId: 1n, repoRoot: repo, baseSha: base, headSha: '', checkpoint: 0, coverage: '{}' }],
      nodes: [{ id: 5n, boardId: 1n }],
    });

  it('changed and deleted equal git diff: touched CRLF files (text=auto, core.autocrlf) and a touched symlink are not changes', async () => {
    const f = seeded();
    const candidates = gitChangeCandidates(repo, base).filter(c => !c.sure).map(c => c.path);
    expect(candidates).toEqual(expect.arrayContaining(['crlf_autocrlf.txt', 'crlf_textauto.txt', 'link', 't.ts']));
    const index = readFileSync(join(repo, '.git', 'index'));
    const res = await markCheckpointFlow({ boardId: 1n }, { ...localDeps, call: f.call, progress: new Map() }); // first: git diff below refreshes the index
    expect(readFileSync(join(repo, '.git', 'index')).equals(index)).toBe(true); // the listing never wrote the index
    const git = gitChanged(repo, base);
    expect(git).toEqual(['m.ts', 'n.ts', 'x.sh']);
    expect(res.coverage).toEqual({ changed: 4, uncovered: [...git, 'u.ts'], excluded: [], deleted: ['d.ts'] });
  });
});
