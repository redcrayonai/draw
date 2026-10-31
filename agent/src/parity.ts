/**
 * The parity fixture (spec Decision 18): one scripted session over a fixture
 * repo. Whatever path runs it, today's (local git, the SDK connection) or the
 * hosted one, must leave the same rows: code refs, edge evidence and coverage,
 * ids normalised to names. parity.golden.json holds the rows the SDK path
 * left; that path and its writer (golden.ts) were retired with the stdio
 * server (RC-571), so the file is frozen: the hosted path is checked against
 * it (mcp/src/parity.db.test.ts), and a deliberate change edits it by hand.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  addCodeRefFlow,
  flowBudget,
  markCheckpointFlow,
  prepareSourceEvidence,
  startSessionFlow,
  type AddCodeRefResult,
  type MachineDeps,
  type MarkCheckpointResult,
  type SessionDeps,
} from './session';
import { arriveFlow, routeSnapshot } from './routes';

/** How one path creates nodes and edges (not session flows) and reads rows back. */
export interface ParityPath {
  /** deps for start_session, before the board id is known */
  start: SessionDeps;
  /** deps and drawing on the session board */
  board(boardId: bigint): {
    deps: SessionDeps;
    node(label: string): Promise<bigint>;
    edge(from: bigint, to: bigint, label: string, evidence: string, evidenceSnippet: string): Promise<bigint>;
  };
  /**
   * The hosted path's machine for one flow call: a capture of the fixture
   * checkout made for that call, as the plugin hook makes it (start for
   * start_session, cite for a source: edge, ref for add_code_ref, checkpoint
   * for mark_checkpoint and arrive). Without it every call runs on the deps above.
   */
  capture?(kind: 'start' | 'ref' | 'cite' | 'checkpoint', at: { root: string; boardId?: bigint; path?: string }): Promise<MachineDeps>;
}

export const PARITY_SESSION = 'parity';

// Fixed identity, dates and no user or system git config: the same commits,
// shas and git answers on every machine.
const GIT_ENV = {
  GIT_AUTHOR_NAME: 'parity',
  GIT_AUTHOR_EMAIL: 'parity@example.com',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
  GIT_COMMITTER_NAME: 'parity',
  GIT_COMMITTER_EMAIL: 'parity@example.com',
  GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

const LIMITER = `export class Limiter {
  constructor(private readonly max: number) {}

  allow(used: number): boolean {
    return used < this.max;
  }
}

export function parseLimit(text: string): number {
  return Number.parseInt(text, 10);
}
`;
const SERVER = `import { Limiter } from './limiter';
import { legacy } from './legacy';

export function handle(used: number): string {
  const limiter = new Limiter(10 + legacy);
  return limiter.allow(used) ? 'ok' : 'busy';
}
`;
const LEGACY = 'export const legacy = 1;\n';
const README = "# Fixture\n\n## Limits\nEach caller gets 10 calls.\n\n## Errors\nBusy callers get 'busy'.\n";

/**
 * Run the session on a fresh fixture repo and return its rows after each
 * checkpoint. Sets the git environment above for this process (the flows'
 * git calls inherit it).
 */
export async function runParity(path: ParityPath, dbName: string): Promise<unknown> {
  Object.assign(process.env, GIT_ENV);
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'rc-parity-')));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  const write = (rel: string, text: string) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  try {
    git('init', '-q', '-b', 'main');
    write('src/limiter.ts', LIMITER);
    write('src/server.ts', SERVER);
    write('src/legacy.ts', LEGACY);
    write('README.md', README);
    write('docs/guide.md', '# Guide\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'base');

    const machine = async <D extends SessionDeps>(deps: D, ...call: Parameters<NonNullable<ParityPath['capture']>>): Promise<D> =>
      path.capture ? { ...deps, ...(await path.capture(...call)) } : deps;
    const started = await startSessionFlow(
      { name: PARITY_SESSION, repoRoot: root, force: false, activeBoardId: undefined, clientUrl: 'http://localhost:5173', dbName, myBoards: true },
      await machine(path.start, 'start', { root })
    );
    const board = path.board(started.boardId);
    const { deps } = board;
    const boardId = started.boardId;

    // ids -> names, per table: each table numbers its rows on its own
    const names: Names = { node: new Map(), edge: new Map(), ref: new Map() };
    const node = async (label: string) => {
      const id = await board.node(label);
      names.node.set(id, label);
      return id;
    };
    const server = await node('Server');
    const limiter = await node('Limiter');
    const legacy = await node('Legacy');
    const docs = await node('Docs');
    const edge = async (from: bigint, to: bigint, label: string, citation: string) => {
      const cited = citation.slice('source:'.length, citation.lastIndexOf(':'));
      const source = await prepareSourceEvidence({ ...(await machine(deps, 'cite', { root, boardId, path: cited })), budget: flowBudget(Date.now) }, boardId, root, citation);
      const id = await board.edge(from, to, label, source.evidence, source.evidenceSnippet);
      names.edge.set(id, `${names.node.get(from)} ${label} ${names.node.get(to)}`);
    };
    await edge(server, limiter, 'uses', 'source:src/server.ts:1');
    await edge(server, legacy, 'reads', 'source:src/legacy.ts:1');
    await edge(docs, server, 'documents', 'source:README.md:7');

    const ref = async (targetId: bigint, path: string, symbol: string, lines?: [number, number]) => {
      const res = await addCodeRefFlow(
        { boardId, repoRoot: root, targetKind: 'node', targetId, path, symbol, startLine: lines?.[0], endLine: lines?.[1], author: 'parity' },
        await machine(deps, 'ref', { root, boardId, path })
      );
      names.ref.set(res.id, `${names.node.get(targetId)} ${symbol}`);
      return res;
    };
    const added: AddCodeRefResult[] = [];
    added.push(await ref(limiter, 'src/limiter.ts', 'Limiter.allow'));
    added.push(await ref(limiter, 'src/limiter.ts', 'parseLimit'));
    added.push(await ref(server, './src//server.ts', 'handle'));
    added.push(await ref(legacy, 'src/legacy.ts', 'legacy'));
    added.push(await ref(docs, 'README.md', 'Limits', [3, 4]));
    added.push(await ref(limiter, 'src/limiter.ts', 'Limiter.allow')); // already attached

    const steps: unknown[] = [{ step: 'add_code_ref', results: added.map(({ id: _id, ...r }) => r) }];
    const checkpoint = async (step: string, exclude?: { reason: string; glob: string }[]) => {
      const result = await markCheckpointFlow({ boardId, exclude }, await machine(deps, 'checkpoint', { root, boardId }));
      steps.push({ step, ...(await rows(deps, boardId, names, result)) });
    };

    await checkpoint('checkpoint 1: nothing changed');

    // Shift, drift, delete, edit and add, half of it committed: refs and
    // citations shift or drift, the deleted file's go stale, as does the
    // edited README line; the untracked file is uncovered, docs/ excluded.
    write('src/limiter.ts', `// Token limits.\n${LIMITER.replace('10);', '10) || 0;')}`);
    write('src/server.ts', `// Entry point.\n${SERVER}`);
    git('commit', '-q', '-am', 'edit');
    unlinkSync(join(root, 'src/legacy.ts'));
    write('README.md', README.replace('# Fixture\n', '# Fixture\n\nRead this first.\n').replace("'busy'", 'a retry hint'));
    write('docs/guide.md', '# Guide\n\nMore.\n');
    write('src/new.ts', 'export const fresh = true;\n');
    await checkpoint('checkpoint 2: edited', [{ reason: 'docs', glob: 'docs/**' }]);

    // The deleted file comes back: its ref and its citation are ok again.
    git('checkout', '--', 'src/legacy.ts');
    await checkpoint('checkpoint 3: restored', [{ reason: 'docs', glob: 'docs/**' }]);

    // A route: plan it, arrive (a checkpoint), reroute the pending stops,
    // arrive again, then retry that arrival, which writes nothing.
    const nodeName = (id: string | undefined) => (id === undefined ? undefined : names.node.get(BigInt(id)) ?? '?');
    const named = (route: ReturnType<typeof routeSnapshot>) =>
      route && {
        ...route,
        destinationId: nodeName(route.destinationId),
        waypoints: route.waypoints.map(w => ({ ...w, nodeId: nodeName(w.nodeId) })),
        history: route.history.map(({ id: _id, ...e }) => ({ ...e, nodeId: nodeName(e.nodeId), nodeIds: e.nodeIds.map(nodeName) })),
      };
    const routeStep = async (step: string, write: () => Promise<unknown>) => {
      await write();
      steps.push({ step, route: named(await deps.call('read route', async conn => routeSnapshot(conn, boardId))) });
    };
    const arrive = async (step: string, nodeId: bigint) => {
      // A new arrival carries its checkpoint's result; a retried one only its number.
      const res: Awaited<ReturnType<typeof arriveFlow>> & Partial<MarkCheckpointResult> = await arriveFlow(
        { boardId, nodeId, exclude: [{ reason: 'docs', glob: 'docs/**' }] },
        await machine(deps, 'checkpoint', { root, boardId })
      );
      const checkpointRows = res.reanchor ? await rows(deps, boardId, names, { reanchor: res.reanchor, notes: res.notes }) : {};
      steps.push({ step, existing: res.existing, checkpoint: res.checkpoint, route: named(res.route), ...checkpointRows });
    };
    await routeStep('plan_route', () => deps.call('plan_route', conn => conn.reducers.planRoute({ boardId, nodeIds: [server, limiter, docs] })));
    await arrive('arrive: Server', server);
    await routeStep('reroute: Legacy first', () =>
      deps.call('reroute', conn =>
        conn.reducers.reroute({ boardId, addNodeIds: [legacy], addIndices: [0], removeNodeIds: [], reason: 'legacy first' })
      )
    );
    await arrive('arrive: Legacy', legacy);
    await arrive('arrive: Legacy again', legacy);

    return { session: PARITY_SESSION, steps };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

type Names = Record<'node' | 'edge' | 'ref', Map<bigint, string>>;
const byKey = <T>(key: (t: T) => string) => (a: T, b: T) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);

// The board's rows with every id replaced by the name the scenario gave it.
async function rows(deps: SessionDeps, boardId: bigint, names: Names, result: Pick<MarkCheckpointResult, 'reanchor' | 'notes'>) {
  // reanchor labels: "<symbol> <path> id=<ref id>" and "edge <edge id> <citation>"
  const named = (text: string) =>
    text
      .replace(/\bid=(\d+)$/, (_m, id) => `ref=<${names.ref.get(BigInt(id)) ?? '?'}>`)
      .replace(/^edge (\d+) /, (_m, id) => `edge <${names.edge.get(BigInt(id)) ?? '?'}> `);
  const { session, codeRefs, edges, refHashes, edgeHashes } = await deps.call('read parity rows', async conn => ({
    session: [...conn.db.visibleSession.iter()].find(s => s.boardId === boardId)!,
    codeRefs: [...conn.db.visibleCodeRef.iter()].filter(r => r.boardId === boardId),
    edges: [...conn.db.visibleEdge.iter()].filter(e => e.boardId === boardId),
    refHashes: new Map([...conn.db.visibleCodeRefHash.iter()].map(h => [h.refId, h.lineHashes])),
    edgeHashes: new Map([...conn.db.visibleEdgeEvidenceHash.iter()].map(h => [h.edgeId, h.lineHash])),
  }));
  const r = result.reanchor;
  return {
    reanchor: { ...r, stale: r.stale.map(named), ambiguous: r.ambiguous.map(named), restored: r.restored.map(named) },
    ...(result.notes ? { notes: result.notes } : {}),
    session: { checkpoint: session.checkpoint, baseSha: session.baseSha, headSha: session.headSha, coverage: JSON.parse(session.coverage) },
    codeRefs: codeRefs
      .map(c => ({
        target: `${c.targetKind} ${names[c.targetKind === 'edge' ? 'edge' : 'node'].get(c.targetId) ?? '?'}`,
        path: c.path,
        symbol: c.symbol,
        startLine: c.startLine,
        endLine: c.endLine,
        blobSha: c.blobSha,
        snippet: c.snippet,
        lineHashes: refHashes.get(c.id) ?? '',
        author: c.author,
        checkpoint: c.checkpoint,
        status: c.status,
      }))
      .sort(byKey(c => `${c.target} ${c.symbol}`)),
    edges: edges
      .map(e => ({ edge: names.edge.get(e.id) ?? '?', evidence: e.evidence, evidenceSnippet: e.evidenceSnippet, lineHash: edgeHashes.get(e.id) ?? '', evidenceStatus: e.evidenceStatus }))
      .sort(byKey(e => e.edge)),
  };
}
