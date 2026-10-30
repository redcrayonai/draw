// RC-605: a canvas receives only the rows of the boards it opened. Run against
// the isolated server created by scripts/stdb-test.sh, before the other suites
// (see the timing test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { registerHooks } from 'node:module';

// Generated bindings use extensionless TS imports; use the real client SDK.
registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); }
  catch (error) {
    if (specifier.startsWith('.')) return nextResolve(`${specifier}.ts`, context);
    throw error;
  }
} });
const { DbConnection } = await import('../client/src/module_bindings/index.ts');
const groups = await import('../client/src/subscribe.ts');

const BASE = process.env.STDB_URL;
const DB = process.env.STDB_DB;
const OWNER = process.env.STDB_OWNER_TOKEN;
if (!BASE || !DB || !OWNER || DB === 'redcrayon') {
  throw new Error('set STDB_URL, STDB_DB and STDB_OWNER_TOKEN for an isolated test database');
}
const NONE = { none: [] };
const name = prefix => `${prefix}-${randomBytes(8).toString('hex')}`;
const nodeArgs = (B, label) => [B, label, '', 0, 0, 160, 80, 'ink', false, ...Array(7).fill(NONE)];
// Every query the canvas subscribes to.
const queries = keys => keys.flatMap(key => groups[key]).map(table => `SELECT * FROM ${table}`);
const BOARD = queries(['CORE_TABLES', 'COMPANION_TABLES', 'ROUTE_TABLES', 'CHART_TABLES', 'TRACE_TABLES', 'CHANGE_NOTE_TABLES', 'THREAT_TABLES']);
const CANVAS = [...queries(['LIST_TABLES', 'ARCHITECTURE_TABLES', 'LIBRARY_VIEWS']), ...BOARD];
const BOARD_ROWS = ['visibleNode', 'visibleEdge', 'visibleCursor', 'visibleSelection', 'visibleHideSet', 'visibleCodeRef', 'visibleChart'];

async function mint() {
  const response = await fetch(`${BASE}/v1/identity`, { method: 'POST' });
  assert.equal(response.status, 200);
  return response.json();
}
async function call(who, reducer, args = []) {
  const response = await fetch(`${BASE}/v1/database/${DB}/call/${reducer}`, {
    method: 'POST', headers: { Authorization: `Bearer ${who.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args, (_key, value) => (typeof value === 'bigint' ? Number(value) : value)),
  });
  return { status: response.status, text: await response.text() };
}
async function ok(who, reducer, args) {
  const result = await call(who, reducer, args);
  assert.equal(result.status, 200, `${reducer}: ${result.text}`);
}
async function sql(who, query) {
  const response = await fetch(`${BASE}/v1/database/${DB}/sql`, {
    method: 'POST', headers: { Authorization: `Bearer ${who.token}`, 'Content-Type': 'text/plain' }, body: query,
  });
  const text = await response.text();
  assert.equal(response.status, 200, `${query}: ${text}`);
  const [result] = JSON.parse(text);
  const columns = result.schema.elements.map(e => e.name?.some ?? e.name);
  return result.rows.map(row => Object.fromEntries(columns.map((column, i) => [column, row[i]])));
}
const operator = { token: OWNER };
async function board(who, { isPublic = false } = {}) {
  const label = name('scope');
  await ok(who, 'create_board', [label]);
  const id = (await sql(operator, `SELECT * FROM board WHERE name = '${label}'`))[0].id;
  if (isPublic) await sql(operator, `INSERT INTO public_board (board_id) VALUES (${id})`);
  return BigInt(id);
}
async function draw(who, B) {
  for (const label of ['first', 'second']) await ok(who, 'create_node', nodeArgs(B, label));
  const [a, b] = await sql(operator, `SELECT * FROM node WHERE board_id = ${B}`);
  await ok(who, 'create_edge', [B, a.id, b.id, 'uses', 'human:test', NONE, NONE, NONE]);
}

/** A canvas tab: open `open` (none: an agent or the MCP server), then subscribe to the canvas queries.
 *  `received` collects every board row the tab is sent, from the first rows on. */
async function canvas(who, open, subscribe = CANVAS) {
  const received = [];
  const conn = await new Promise((resolve, reject) => {
    let connection;
    const timeout = setTimeout(() => { connection?.disconnect(); reject(new Error('subscription timed out')); }, 10000);
    const fail = error => { clearTimeout(timeout); connection?.disconnect(); reject(error); };
    connection = DbConnection.builder().withUri(BASE).withDatabaseName(DB).withToken(who.token)
      .onConnect(async conn => {
        try {
          for (const table of BOARD_ROWS) conn.db[table].onInsert((_ctx, row) => received.push({ table, row }));
          conn.db.visibleParticipant.onInsert((_ctx, row) => received.push({ table: 'visibleParticipant', row }));
          if (open) await conn.reducers.openBoards({ boardIds: open });
          conn.subscriptionBuilder().onApplied(() => { clearTimeout(timeout); resolve(conn); })
            .onError((_ctx, error) => fail(error)).subscribe(subscribe);
        } catch (error) { fail(error); }
      })
      .onConnectError((_ctx, error) => fail(error)).build();
  });
  return Object.assign(conn, { received });
}
const boardsIn = (conn, table) => new Set([...conn.db[table].iter()].map(row => row.boardId));
const sentFrom = (conn, B) => conn.received.filter(({ row }) => row.boardId === B).map(({ table }) => table);
async function waitFor(predicate, message) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
const settle = () => new Promise(resolve => setTimeout(resolve, 300));

// First, on a fresh database: the views of every sender before it (even
// disconnected ones) still run, and those of a sender that opened no board read
// every public board. The viewers subscribe to the board tables RC-605 scoped;
// the board list (visible_board, my_boards) still reads every public board.
test('update_cursor does not read every public board: 10,000 public_board rows cost it nothing', async t => {
  const mover = await mint();
  const B = await board(mover, { isPublic: true });
  const viewers = [];
  for (let i = 0; i < 5; i++) viewers.push(await canvas(await mint(), [B], BOARD));
  const tab = await canvas(mover, [B], BOARD);
  const median = async () => {
    const times = [];
    for (let i = 0; i < 60; i++) {
      const start = performance.now();
      await tab.reducers.updateCursor({ boardId: B, x: i * 4, y: 4 });
      times.push(performance.now() - start);
    }
    return times.sort((x, y) => x - y)[30];
  };
  const FAKE = 1_000_000_000; // far above any board id this database hands out
  try {
    await median(); // warm up
    const before = await median();
    for (let start = 0; start < 10_000; start += 500) {
      await sql(operator, `INSERT INTO public_board (board_id) VALUES ${Array.from({ length: 500 }, (_, i) => `(${FAKE + start + i})`).join(', ')}`);
    }
    const after = await median();
    t.diagnostic(`update_cursor median with 5 viewers: ${before.toFixed(2)} ms, then ${after.toFixed(2)} ms at 10,000 public boards`);
    // Before RC-605 the reducer and every viewer's views read all of public_board: about 16 ms here.
    assert.ok(after < before * 2 + 4, `update_cursor slowed from ${before.toFixed(2)} ms to ${after.toFixed(2)} ms`);
  } finally {
    await sql(operator, `DELETE FROM public_board WHERE board_id >= ${FAKE}`);
    for (const conn of [...viewers, tab]) conn.disconnect();
  }
});

test('two public boards: A is sent none of B\'s node, edge, cursor, selection or participant rows', async () => {
  const a = await mint(), b = await mint();
  const A = await board(a, { isPublic: true }), B = await board(b, { isPublic: true });
  await draw(a, A);
  await draw(b, B);
  const tabB = await canvas(b, [B]);
  await tabB.reducers.joinBoard({ displayName: 'bee', kind: 'human' });
  await tabB.reducers.updateCursor({ boardId: B, x: 4, y: 4 });
  await tabB.reducers.setSelection({ boardId: B, nodeIds: [] });
  const tabA = await canvas(a, [A]);
  try {
    await tabA.reducers.updateCursor({ boardId: A, x: 8, y: 8 });
    // B keeps working while A watches.
    await ok(b, 'create_node', nodeArgs(B, 'later'));
    for (let i = 1; i <= 5; i++) await tabB.reducers.updateCursor({ boardId: B, x: 4 * i, y: 4 });
    await waitFor(() => [...tabB.db.visibleNode.iter()].some(n => n.label === 'later'), 'B sees its own write');
    await settle();
    assert.deepEqual(sentFrom(tabA, B), [], 'A was sent rows of B\'s board');
    assert.ok(!tabA.received.some(({ table, row }) => table === 'visibleParticipant' && row.identity.toHexString() === b.identity), 'A was sent B\'s participant row');
    // A's own board arrived, through the same callbacks.
    assert.deepEqual(new Set(sentFrom(tabA, A)), new Set(['visibleNode', 'visibleEdge', 'visibleCursor']));
    for (const table of BOARD_ROWS) assert.deepEqual([...boardsIn(tabA, table)].filter(id => id !== A), [], `${table} holds another board`);
    // The switcher and ⌘K still list every board A can read.
    for (const id of [A, B]) {
      assert.ok(tabA.db.visibleBoard.id.find(id), `visible_board lists ${id}`);
      assert.ok([...tabA.db.myBoards.iter()].some(row => row.boardId === id), `my_boards lists ${id}`);
    }
  } finally { tabA.disconnect(); tabB.disconnect(); }
});

test('switching boards swaps the rows on the same connection, and the diff\'s base board can open beside it', async () => {
  const a = await mint(), b = await mint();
  const A = await board(a), B = await board(b, { isPublic: true }), C = await board(a);
  await draw(a, A);
  await draw(b, B);
  await draw(a, C);
  const tab = await canvas(a, [A]);
  try {
    assert.deepEqual(boardsIn(tab, 'visibleNode'), new Set([A]));
    await tab.reducers.openBoards({ boardIds: [B] });
    // The reducer's own update carries the swap: the new board is here when the call returns.
    assert.deepEqual(boardsIn(tab, 'visibleNode'), new Set([B]));
    assert.deepEqual(boardsIn(tab, 'visibleEdge'), new Set([B]));
    await tab.reducers.openBoards({ boardIds: [C, A] });
    assert.deepEqual(boardsIn(tab, 'visibleNode'), new Set([C, A]));
  } finally { tab.disconnect(); }
});

test('a connection that opens nothing reads every readable board, as agents and the MCP server do', async () => {
  const a = await mint(), b = await mint(), agent = await mint();
  const A = await board(a, { isPublic: true }), B = await board(b, { isPublic: true });
  await draw(a, A);
  await draw(b, B);
  const tab = await canvas(agent);
  try {
    for (const id of [A, B]) assert.ok(boardsIn(tab, 'visibleNode').has(id), `an agent reads board ${id}`);
    assert.equal((await sql(agent, `SELECT * FROM visible_node WHERE board_id = ${B}`)).length, 2, 'the HTTP read path filters by board');
  } finally { tab.disconnect(); }
});

test('each tab of one identity gets its board; a closed tab takes its board away', async () => {
  const a = await mint();
  const A = await board(a), B = await board(a);
  await draw(a, A);
  await draw(a, B);
  const first = await canvas(a, [A]);
  const second = await canvas(a, [B]);
  try {
    // Views answer per identity: both tabs get both open boards, and filter to their own.
    await waitFor(() => boardsIn(first, 'visibleNode').has(B), 'the first tab gets the second tab\'s board');
    second.disconnect();
    await waitFor(() => !boardsIn(first, 'visibleNode').has(B), 'a closed tab\'s board leaves the others');
    assert.deepEqual(boardsIn(first, 'visibleNode'), new Set([A]));
  } finally { first.disconnect(); }
});

test('open_boards refuses a board the caller cannot read, more than two boards, and none', async () => {
  const a = await mint(), b = await mint();
  const A = await board(a), A2 = await board(a), A3 = await board(a), B = await board(b);
  const tab = await canvas(a, [A]);
  try {
    await assert.rejects(tab.reducers.openBoards({ boardIds: [B] }), /not authorized: board is unavailable/);
    await assert.rejects(tab.reducers.openBoards({ boardIds: [A, A2, A3] }), /at most the board it is compared with/);
    await assert.rejects(tab.reducers.openBoards({ boardIds: [] }), /open one board/);
    assert.equal((await sql(operator, `SELECT * FROM open_board WHERE identity = 0x${a.identity}`))[0].board_ids.length, 1);
  } finally { tab.disconnect(); }
});

test('an open board whose access is revoked stops sending rows', async () => {
  const owner = await mint(), viewer = await mint();
  const B = await board(owner);
  await draw(owner, B);
  const token = randomBytes(16).toString('hex');
  await ok(owner, 'set_link_share', [B, 'view', token]);
  await ok(viewer, 'open_shared_link', [token]);
  const tab = await canvas(viewer, [B]);
  try {
    assert.ok(boardsIn(tab, 'visibleNode').has(B));
    await ok(owner, 'stop_link_share', [B]);
    await waitFor(() => !boardsIn(tab, 'visibleNode').has(B), 'stopping the link removes the open board\'s rows');
  } finally { tab.disconnect(); }
});

// assertBoardRead checks one board (canReadBoard); the views list readable
// boards (readableBoardIds). Both must answer the same for every access path.
test('update_cursor accepts exactly the boards visible_board lists, for every kind of access', async () => {
  const owner = await mint(), member = await mint(), agent = await mint(), visitor = await mint(), stranger = await mint(), service = await mint();
  await sql(operator, `INSERT INTO service_account (identity, label) VALUES (0x${service.identity}, 'scope-test')`);
  const mine = await board(owner), team = await board(owner), shared = await board(owner), linked = await board(owner), open = await board(owner, { isPublic: true });
  const org = name('scope-org');
  await ok(service, 'set_org_memberships', [{ __identity__: `0x${member.identity}` }, [org], ['member']]);
  await ok(service, 'set_org_memberships', [{ __identity__: `0x${owner.identity}` }, [org], ['admin']]);
  await ok(owner, 'share_board_with_team', [team, org]);
  const code = randomBytes(32).toString('base64url');
  await ok(agent, 'offer_agent_link', [code]);
  await ok(owner, 'redeem_agent_link', [code]);
  await ok(owner, 'grant_agent_board', [shared, { __identity__: `0x${agent.identity}` }]);
  // A board the agent itself owns: its owner reads it through the link.
  await sql(operator, `INSERT INTO board_grant (id, board_id, grantee, role) VALUES (0, ${linked}, 0x${agent.identity}, 'owner')`);
  const token = randomBytes(16).toString('hex');
  await ok(owner, 'set_link_share', [shared, 'view', token]);
  await ok(visitor, 'open_shared_link', [token]);
  const boards = [mine, team, shared, linked, open];
  for (const who of [owner, member, agent, visitor, stranger, service]) {
    for (const B of boards) {
      const listed = (await sql(who, `SELECT * FROM visible_board WHERE id = ${B}`)).length === 1;
      const moved = (await call(who, 'update_cursor', [B, 0, 0])).status === 200;
      assert.equal(moved, listed, `update_cursor on board ${B} by ${who.identity.slice(0, 8)}: ${moved}, listed: ${listed}`);
    }
  }
  assert.equal((await sql(stranger, `SELECT * FROM visible_board WHERE id = ${mine}`)).length, 0, 'the stranger case is a real refusal');
});

// #134 on an open board: code refs, edge snippets and threats follow the link's includes, a public board keeps its code.
test('an open link board sends code and threats only while the owner includes them', async () => {
  const owner = await mint(), visitor = await mint(), reader = await mint();
  const B = await board(owner);
  await draw(owner, B);
  const [a, b] = await sql(operator, `SELECT * FROM node WHERE board_id = ${B}`);
  await ok(owner, 'set_code_consent', [true]); // the board keeps code snippets (RC-690)
  await ok(owner, 'add_repo_files', [B, ['src/auth.ts']]);
  await ok(owner, 'add_code_ref', [B, 'node', a.id, 'src/auth.ts', 'verify', 1, 1, '4b825dc642cb6eb9a060e54bf8d69288fbee4904', 'export function verify() {}', 'owner']);
  await ok(owner, 'create_edge', [B, a.id, b.id, 'verifies', 'source:src/auth.ts:1', NONE, { some: 'export function verify() {}' }, NONE]);
  await ok(owner, 'add_threat', [B, a.id, 'vulnerable', 'high', 'openssl RCE', 'Heap overflow.', '9.8', 'openssl@3.0.1', '3.0.7', '["cve"]', '', 'agent']);
  const token = randomBytes(16).toString('hex');
  await ok(owner, 'set_link_share', [B, 'view', token]);
  await ok(visitor, 'open_shared_link', [token]);
  const tab = await canvas(visitor, [B], BOARD);
  const seen = () => ({
    refs: [...tab.db.visibleCodeRef.iter()].length,
    threats: [...tab.db.visibleThreat.iter()].length,
    snippet: [...tab.db.visibleEdge.iter()].map(e => e.evidenceSnippet).join(''),
  });
  // The dashboard feed follows the same includes: no code-ref paths or threat events while left out.
  const feedTypes = async () => (await sql(visitor, `SELECT * FROM my_activity WHERE board_id = ${B}`)).map(r => r.type).sort();
  try {
    assert.equal([...tab.db.visibleNode.iter()].length, 2);
    assert.deepEqual(seen(), { refs: 0, threats: 0, snippet: '' });
    assert.deepEqual((await feedTypes()).filter(t => /^(coderef|threat)\./.test(t)), [], 'the feed leaves out code and threat events');
    assert.ok((await feedTypes()).includes('node.created'), 'the rest of the feed still reaches the visitor');
    await ok(owner, 'set_link_share_includes', [B, true, true]);
    await waitFor(() => seen().refs === 1 && seen().threats === 1, 'includes reach the open tab');
    assert.equal(seen().snippet, 'export function verify() {}');
    assert.deepEqual((await feedTypes()).filter(t => /^(coderef|threat)\./.test(t)), ['coderef.added', 'threat.added'], 'included layers reach the feed');
    await ok(owner, 'set_link_share_includes', [B, false, false]);
    await waitFor(() => seen().refs === 0 && seen().threats === 0, 'leaving them out takes them back');
  } finally { tab.disconnect(); }
  await sql(operator, `INSERT INTO public_board (board_id) VALUES (${B})`);
  const pub = await canvas(reader, [B], BOARD);
  try {
    assert.equal([...pub.db.visibleCodeRef.iter()].length, 1, 'a public board keeps its code');
    assert.equal([...pub.db.visibleThreat.iter()].length, 0, 'and never its threats');
  } finally { pub.disconnect(); }
});
