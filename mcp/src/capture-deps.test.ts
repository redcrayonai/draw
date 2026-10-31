import { describe, expect, it } from 'vitest';
import { GitOutputTooLargeError } from '../../agent/src/errors';
import { addCodeRefFlow, markCheckpointFlow, type CodeRefRow, type SessionConn, type SessionDeps } from '../../agent/src/session';
import { MissingFileError } from '../../agent/src/snippet';
import { CaptureRejection, blobSha, claimCapture, type ClaimBoard, type ClaimCall, type ClaimedCapture } from '../../shared/capture';
import { captureDeps } from './capture-deps';

const TOP = '/work/repo';
const BASE = 'b'.repeat(40);
const board: ClaimBoard = { id: 42n, name: 'main', repoRoot: TOP, baseSha: BASE };
const common = { v: 1, helper: '1.0.0', toplevel: TOP, objectFormat: 'sha1', head: 'a'.repeat(40) };
const SERVER = "import { Limiter } from './limiter';\n\nexport function handle(used: number): string {\n  return used < 10 ? 'ok' : 'busy';\n}\n";

const wire = async (path: string, text: string) => ({
  path,
  bytes: Buffer.from(text).toString('base64'),
  sha: await blobSha('sha1', new TextEncoder().encode(text)),
  citable: true,
});
// Through the claim, as the Worker gets them.
async function claimed(body: object, call: ClaimCall): Promise<ClaimedCapture> {
  const r = await claimCapture('cap_AAAAAAAAAAAAAAAAAAAAAA', body, call);
  if (!r.ok) throw new Error(r.text);
  return r.capture;
}
const refCapture = async (asked = './src//server.ts') =>
  claimed({ ...common, kind: 'ref', asked, file: await wire('src/server.ts', SERVER) }, { tool: 'add_code_ref', path: asked, board });
const checkpointCapture = async () =>
  claimed(
    {
      ...common,
      kind: 'checkpoint',
      base: BASE,
      changed: ['src/server.ts', 'src/huge.ts', 'src/slow.ts'],
      uncompared: { 'src/slow.ts': 'git diff timed out after 10 s' },
      untracked: ['src/new.ts'],
      deleted: ['src/gone.ts'],
      hunks: { 'src/server.ts': [[3, 3], [5, 6]], 'src/huge.ts': 'git diff output exceeded 64 MiB' },
      files: [await wire('src/server.ts', SERVER), { path: 'src/gone.ts', missing: true }, { path: 'logo.png', unreadable: true }],
    },
    { tool: 'mark_checkpoint', board }
  );
const rejection = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    if (err instanceof CaptureRejection) return err.message;
    throw err;
  }
  throw new Error('no rejection');
};

describe('captureDeps', () => {
  it('a start capture answers the top level and HEAD, and lists no repo files (D10)', async () => {
    const deps = captureDeps(await claimed({ ...common, kind: 'start' }, { tool: 'start_session' }));
    expect(deps.git.topLevel('/anything')).toBe(TOP);
    expect(deps.realpath(TOP)).toBe(TOP);
    expect(deps.git.head(TOP)).toBe('a'.repeat(40));
    expect(deps.git.listTracked(TOP)).toEqual([]);
    expect(rejection(() => deps.readSource(TOP, 'src/a.ts'))).toBe(
      'REJECTED: this start capture holds no src/a.ts. Nothing was written. Run the capture for this call and pass the new id.'
    );
  });

  it('a ref capture reads its file under the spelling asked and git spelling, with the claimed sha', async () => {
    const deps = captureDeps(await refCapture());
    const src = deps.readSource(TOP, './src//server.ts');
    expect(src).toMatchObject({ abs: `${TOP}/src/server.ts`, rel: 'src/server.ts', text: SERVER, stamp: undefined });
    expect(src.lines).toHaveLength(5);
    expect(deps.readSource(TOP, 'src/server.ts').bytes.equals(src.bytes)).toBe(true);
    expect(deps.git.spelling(TOP, src.rel)).toBe('src/server.ts');
    expect(deps.diskPath(TOP, './src//server.ts')).toBe('src/server.ts');
    expect(deps.git.hashObject(TOP, 'src/server.ts', src.bytes)).toBe(await blobSha('sha1', new TextEncoder().encode(SERVER)));
    expect(deps.git.isCitable(TOP, 'src/server.ts')).toBe(true);
    expect(deps.stamp(TOP, 'src/server.ts')).toBeUndefined();
  });

  it('a ref capture refuses any other file and every checkpoint question', async () => {
    const deps = captureDeps(await refCapture());
    expect(rejection(() => deps.readSource(TOP, 'src/limiter.ts'))).toBe(
      'REJECTED: this ref capture holds no src/limiter.ts. Nothing was written. Run the capture for this call and pass the new id.'
    );
    expect(rejection(() => deps.git.isCitable(TOP, 'src/limiter.ts'))).toMatch(/holds no src\/limiter\.ts/);
    expect(rejection(() => deps.git.changeCandidates(TOP, BASE))).toMatch(/holds no changed paths/);
    expect(rejection(() => deps.git.hunks(TOP, BASE, 'src/server.ts'))).toMatch(/holds no hunks/);
  });

  it('a checkpoint capture answers the lists, hunks and the files it holds', async () => {
    const deps = captureDeps(await checkpointCapture(), 42n);
    expect(deps.git.changeCandidates(TOP, BASE)).toEqual([
      { path: 'src/server.ts', sure: true },
      { path: 'src/huge.ts', sure: true },
      { path: 'src/slow.ts', sure: false },
    ]);
    expect(deps.git.confirmChanged(TOP, BASE, ['src/slow.ts'])).toEqual(new Map([['src/slow.ts', { changed: true, reason: 'git diff timed out after 10 s' }]]));
    expect(rejection(() => deps.git.confirmChanged(TOP, BASE, ['src/server.ts']))).toMatch(/holds no answer for src\/server\.ts/);
    expect(deps.git.deleted(TOP, BASE)).toEqual(['src/gone.ts']);
    expect(deps.git.untracked(TOP)).toEqual(['src/new.ts']);
    expect(deps.git.hunks(TOP, BASE, 'src/server.ts')).toEqual([{ start: 3, end: 3 }, { start: 5, end: 6 }]);
    expect(() => deps.git.hunks(TOP, BASE, 'src/huge.ts')).toThrow(GitOutputTooLargeError);
    expect(deps.git.hashFiles(TOP, ['src/server.ts'])).toEqual([await blobSha('sha1', new TextEncoder().encode(SERVER))]);
    expect(() => deps.readSource(TOP, 'src/gone.ts')).toThrow(MissingFileError);
    expect(() => deps.readSource(TOP, 'logo.png')).toThrow(/could not be read as text/);
    expect(() => deps.readSource(TOP, 'logo.png')).not.toThrow(MissingFileError);
    expect(deps.git.isCitable(TOP, 'src/gone.ts')).toBe(false);
  });

  it('a checkpoint missing a cited file refuses with the files and the --also command', async () => {
    const deps = captureDeps(await checkpointCapture(), 42n);
    const text = `REJECTED: the checkpoint needs these cited files: src/a.ts, src/b.ts. Nothing was written. Run \`npx -y @redcrayonai/draw@1 capture checkpoint --board 42 --base ${BASE} --also src/a.ts src/b.ts\` and pass the new id.`;
    expect(rejection(() => deps.need!(TOP, ['src/server.ts', 'src/a.ts', 'src/gone.ts', 'src/b.ts']))).toBe(text);
    expect(() => deps.need!(TOP, ['src/server.ts', 'src/gone.ts', 'logo.png'])).not.toThrow();
    expect(rejection(() => deps.git.hunks(TOP, BASE, 'src/new.ts'))).toMatch(/needs these cited files: src\/new\.ts\./);
  });
});

// ---------- the flows on a capture ----------

function fakeConn(refs: CodeRefRow[] = [], edges: { id: bigint; boardId: bigint; evidence?: string; evidenceSnippet?: string; evidenceStatus?: string }[] = []) {
  const writes: string[] = [];
  const repoFiles: { id: bigint; boardId: bigint; path: string }[] = [];
  const session = { id: 1n, boardId: 42n, repoRoot: TOP, baseSha: BASE, headSha: '', checkpoint: 0, coverage: '{}' };
  const none = { iter: () => [] };
  const record = (name: string) => async () => void writes.push(name);
  const conn: SessionConn = {
    db: {
      visibleBoard: { iter: () => [{ id: 42n, name: 'main', slug: 'c4bb879c7355360696d9' }] },
      myBoards: none,
      visibleSession: { iter: () => [session] },
      visibleRepoFile: { iter: () => repoFiles },
      visibleCodeRef: { iter: () => refs },
      visibleNode: { iter: () => [{ id: 7n, boardId: 42n }] },
      visibleEdge: { iter: () => edges },
      visibleSessionRoute: none,
      visibleRouteEvent: none,
      visibleChangeNote: none,
      visibleBoardCodeConsent: none, // the board keeps no code text (RC-690)
      visibleCodeRefHash: none,
      visibleEdgeEvidenceHash: none,
    },
    reducers: {
      startSession: record('startSession'),
      addRepoFiles: async a => {
        writes.push(`addRepoFiles ${a.paths.join(',')}`);
        for (const path of a.paths) repoFiles.push({ id: 1n, boardId: a.boardId, path });
      },
      addCodeRef: async a => {
        writes.push('addCodeRef');
        refs.push({ id: 9n, ...a, checkpoint: 0, status: 'ok' });
      },
      updateCodeRef: record('updateCodeRef'),
      updateEdgeEvidence: record('updateEdgeEvidence'),
      markCheckpoint: record('markCheckpoint'),
      setChangeNoteReaders: record('setChangeNoteReaders'),
      planRoute: record('planRoute'),
      reroute: record('reroute'),
      arriveAtCheckpoint: record('arriveAtCheckpoint'),
      setCodeRefHashes: record('setCodeRefHashes'),
      setEdgeEvidenceCode: record('setEdgeEvidenceCode'),
      setSessionRemote: record('setSessionRemote'),
    },
  };
  return { writes, refs, deps: (machine: ReturnType<typeof captureDeps>): SessionDeps => ({ ...machine, call: (_l, fn) => fn(conn), progress: new Map() }) };
}

describe('the session flows on a capture', () => {
  it('add_code_ref resolves the TS symbol on the captured text, registers git spelling and stores the claimed sha', async () => {
    const f = fakeConn();
    const res = await addCodeRefFlow(
      { boardId: 42n, repoRoot: TOP, targetKind: 'node', targetId: 7n, path: './src//server.ts', symbol: 'handle' },
      f.deps(captureDeps(await refCapture()))
    );
    expect(res).toMatchObject({ path: 'src/server.ts', startLine: 3, endLine: 5, existing: false });
    expect(f.writes).toEqual(['addRepoFiles src/server.ts', 'addCodeRef', 'setCodeRefHashes']);
    expect(f.refs[0].snippet).toBe(''); // no consent row: no code text
  });

  it('add_code_ref still refuses a range for TS/JS', async () => {
    const f = fakeConn();
    await expect(
      addCodeRefFlow({ boardId: 42n, repoRoot: TOP, targetKind: 'node', targetId: 7n, path: 'src/server.ts', symbol: 'handle', startLine: 3, endLine: 4 }, f.deps(captureDeps(await refCapture('src/server.ts'))))
    ).rejects.toThrow(/startLine\/endLine are not accepted for \.ts files/);
    expect(f.writes).toEqual([]);
  });

  it('mark_checkpoint whose capture lacks a cited file writes nothing', async () => {
    const ref = (id: bigint, path: string): CodeRefRow => ({
      id, boardId: 42n, targetKind: 'node', targetId: 7n, path, symbol: 'handle', startLine: 3, endLine: 5, blobSha: 'c'.repeat(40), snippet: '', author: '', checkpoint: 0, status: 'ok',
    });
    const f = fakeConn([ref(1n, 'src/server.ts'), ref(2n, 'src/limiter.ts')], [{ id: 3n, boardId: 42n, evidence: 'source:README.md:1', evidenceSnippet: '# x', evidenceStatus: 'ok' }]);
    await expect(markCheckpointFlow({ boardId: 42n }, f.deps(captureDeps(await checkpointCapture(), 42n)))).rejects.toThrow(
      `REJECTED: the checkpoint needs these cited files: src/limiter.ts, README.md. Nothing was written. Run \`npx -y @redcrayonai/draw@1 capture checkpoint --board 42 --base ${BASE} --also src/limiter.ts README.md\` and pass the new id.`
    );
    expect(f.writes).toEqual([]);
  });
});
