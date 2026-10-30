// The parity fixture through the HTTP path (Decision 18) against a real local
// DB: the snapshot SessionConn and shared/db-http, first with this machine's
// git and files, then on captures as the hosted tools run it: the helper's
// bodies (buildCapture, in-process, no upload), claimed, as captureDeps.
// Rows must equal the golden rows from today's path. Needs STDB_URL and
// STDB_DB: scripts/stdb-test.sh parity.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dbHttp, type DbHttp } from '../../shared/db-http';
import { claimCapture, newCaptureId, type ClaimCall } from '../../shared/capture';
import { buildCapture } from '../../helper/src/capture';
import { idsOf, newIds } from '../../agent/src/ids';
import { localDeps } from '../../agent/src/local-deps';
import { PARITY_SESSION, runParity, type ParityPath } from '../../agent/src/parity';
import type { GitOps, MachineDeps } from '../../agent/src/session';
import { captureDeps } from './capture-deps';
import { decodeRows } from './decode';
import { createSnapshot } from './snapshot';

const url = process.env.STDB_URL;
const db = process.env.STDB_DB;
const NONE = { none: [] };
const GOLDEN = new URL('../../agent/src/parity.golden.json', import.meta.url);

async function agent(http: DbHttp): Promise<string> {
  const res = await fetch(`${url}/v1/identity`, { method: 'POST' });
  const { token } = (await res.json()) as { token: string };
  await http.callAs(token, 'join_board', ['parity', 'agent']);
  await http.callAs(token, 'set_code_consent', [true]); // the golden rows keep snippets (RC-690)
  return token;
}

// The hosted path never reads this machine: every question goes to a capture.
const nowhere = (): never => {
  throw new Error('the hosted path asked this machine instead of a capture');
};
const NOWHERE: MachineDeps = { git: new Proxy({} as GitOps, { get: () => nowhere }), readSource: nowhere, realpath: nowhere, diskPath: nowhere, stamp: nowhere };

function httpPath(http: DbHttp, token: string, machine: MachineDeps = localDeps): ParityPath {
  const one = (ids: bigint[]) => {
    if (ids.length !== 1) throw new Error(`expected one new row, got ${ids.length}`);
    return ids[0];
  };
  const start = createSnapshot(http, token, mine => mine.find(b => b.access === 'owner' && b.name === PARITY_SESSION && b.isSession)?.boardId);
  return {
    start: { ...machine, call: start.call },
    board: boardId => {
      const { call, write } = createSnapshot(http, token, boardId);
      const create = async (table: 'visibleNode' | 'visibleEdge', reducer: string, args: unknown[]) => {
        const before = await call('read', async c => idsOf(c.db[table].iter(), boardId));
        await call(reducer, () => write(reducer, args));
        return call('read', async c => one(newIds(before, c.db[table].iter(), boardId)));
      };
      return {
        deps: { ...machine, call },
        node: label => create('visibleNode', 'create_node', [boardId, label, '', 0, 0, 160, 64, 'ink', false, NONE, NONE, NONE, NONE, NONE, NONE, NONE]),
        edge: (from, to, label, evidence, evidenceSnippet) =>
          create('visibleEdge', 'create_edge', [boardId, from, to, label, evidence, NONE, { some: evidenceSnippet }, NONE]),
      };
    },
  };
}

describe.skipIf(!url || !db)('parity', () => {
  it('the HTTP path leaves the golden rows', async () => {
    const http = dbHttp(url!, db!);
    const rows = await runParity(httpPath(http, await agent(http)), db!);
    expect(`${JSON.stringify(rows, null, 2)}\n`).toBe(readFileSync(GOLDEN, 'utf8'));
  }, 120_000);

  it('the hosted path on captures leaves the golden rows', async () => {
    const http = dbHttp(url!, db!);
    const token = await agent(http);
    const kinds: string[] = [];
    const path: ParityPath = {
      ...httpPath(http, token, NOWHERE),
      capture: async (kind, at) => {
        // What the Worker claims against: the session row, as the board's tool call reads it.
        const session = async (boardId: bigint) => {
          const [row] = decodeRows(await http.sqlTypedAs(token, `SELECT * FROM visible_session WHERE board_id = ${boardId}`));
          return { id: boardId, name: PARITY_SESSION, repoRoot: row.repoRoot as string, baseSha: row.baseSha as string };
        };
        const board = at.boardId === undefined ? undefined : await session(at.boardId);
        // As the hook runs it: --board on every capture, --base from the recorded start_session result.
        const body = buildCapture(kind, { cwd: at.root, path: at.path, board: at.boardId?.toString(), base: board?.baseSha });
        const call: ClaimCall =
          kind === 'start'
            ? { tool: 'start_session' }
            : kind === 'checkpoint'
              ? { tool: 'mark_checkpoint', board: board! }
              : { tool: kind === 'ref' ? 'add_code_ref' : 'create_edge', path: at.path!, board: board! };
        const claimed = await claimCapture(newCaptureId(), JSON.parse(JSON.stringify(body)), call);
        if (!claimed.ok) throw new Error(claimed.text);
        kinds.push(kind);
        return captureDeps(claimed.capture, at.boardId);
      },
    };
    const rows = await runParity(path, db!);
    expect(`${JSON.stringify(rows, null, 2)}\n`).toBe(readFileSync(GOLDEN, 'utf8'));
    // start, 3 cites, 6 refs, 3 checkpoints, 3 arrivals: every flow call ran on a capture
    expect(kinds.join(' ')).toBe(['start', 'cite', 'cite', 'cite', 'ref', 'ref', 'ref', 'ref', 'ref', 'ref', ...Array(6).fill('checkpoint')].join(' '));
  }, 120_000);
});
