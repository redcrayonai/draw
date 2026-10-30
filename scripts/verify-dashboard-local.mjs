// Module integration suite for the live dashboard (RC-530, spec §7 first
// bullet). Talks to an ISOLATED SpacetimeDB over the HTTP API only: identities
// are minted with POST /v1/identity, reducers go through /call, reads through
// /sql (views evaluate as the caller). scripts/stdb-test.sh sets it all up:
//
//   nix develop --command bash -c 'scripts/stdb-test.sh run'
//
// Each test name starts with the plan task that turns it green (M2/M3/M4), so
// one task can run its slice: scripts/stdb-test.sh run --test-name-pattern '^M3 '
// Every test mints its own identities and boards; none depends on another.
// shortcut: views are read as HTTP SQL snapshots, not a live subscription;
// live delivery is the host's view refresh, which the browser e2e covers.
// Subscribe here (as verify-access-local.mjs does) if a dashboard view must be proven live without the e2e.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

const BASE = process.env.STDB_URL;
const DB = process.env.STDB_DB;
const OWNER = process.env.STDB_OWNER_TOKEN;
if (!BASE || !DB || !OWNER) {
  throw new Error('set STDB_URL, STDB_DB and STDB_OWNER_TOKEN (scripts/stdb-test.sh run does)');
}
if (DB === 'redcrayon') {
  throw new Error("refusing to run against the shared 'redcrayon' database; use scripts/stdb-test.sh");
}

const SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const RUN = Date.now().toString(36);
const NONE = { none: [] };
const named = s => `${s}-${RUN}`;

// --- HTTP API --------------------------------------------------------------

const bigints = (_k, v, ctx) => (typeof v === 'number' && !Number.isSafeInteger(v) ? BigInt(ctx.source) : v);
const camel = s => s.replace(/_([a-z])/g, (_m, c) => c.toUpperCase());

async function mint() {
  const r = await fetch(`${BASE}/v1/identity`, { method: 'POST' });
  assert.equal(r.status, 200, 'POST /v1/identity');
  return r.json(); // { identity: '<hex, no 0x>', token }
}

async function call(token, reducer, args = []) {
  const r = await fetch(`${BASE}/v1/database/${DB}/call/${reducer}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args, (_k, v) => (typeof v === 'bigint' ? JSON.rawJSON(v.toString()) : v)),
  });
  return { status: r.status, text: await r.text() };
}

async function ok(token, reducer, args) {
  const r = await call(token, reducer, args);
  assert.equal(r.status, 200, `${reducer} should succeed, got ${r.status}: ${r.text}`);
}

async function rejects(token, reducer, args, needle) {
  const r = await call(token, reducer, args);
  assert.equal(r.status, 530, `${reducer} should fail with "${needle}", got ${r.status}: ${r.text}`);
  assert.ok(r.text.includes(needle), `${reducer}: expected "${needle}" in "${r.text}"`);
}

// rows as objects keyed by camelCase column names
async function sql(token, query) {
  const r = await fetch(`${BASE}/v1/database/${DB}/sql`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' },
    body: query,
  });
  const text = await r.text();
  assert.equal(r.status, 200, `sql ${r.status}: ${text} (${query})`);
  const [res] = JSON.parse(text, bigints);
  const cols = res.schema.elements.map(e => camel(e.name?.some ?? e.name));
  return res.rows.map(row => Object.fromEntries(cols.map((c, i) => [c, row[i]])));
}

// SATS-JSON special products arrive as {"__x__": v} or [v]
const hexOf = v => String(Array.isArray(v) ? v[0] : v.__identity__).replace(/^0x/, '').toLowerCase();
const micros = v => Number(Array.isArray(v) ? v[0] : v.__timestamp_micros_since_unix_epoch__);
const id = hex => ({ __identity__: `0x${hex}` });
const pick = (o, keys) => Object.fromEntries(keys.map(k => [k, o[k]]));

// --- fixtures ----------------------------------------------------------------

const nodeArgs = (boardId, label) => [boardId, label, '', 0, 0, 160, 80, 'ink', false, NONE, NONE, NONE, NONE, NONE, NONE, NONE];

async function boardIdOf(name) {
  const rows = await sql(OWNER, `SELECT id FROM board WHERE name = '${name}'`);
  assert.equal(rows.length, 1, `exactly one board named ${name}`);
  return rows[0].id;
}

async function createBoardAs(who, name) {
  await ok(who.token, 'create_board', [name]);
  return boardIdOf(name);
}

async function nodeAs(who, boardId, label) {
  await ok(who.token, 'create_node', nodeArgs(boardId, label));
  return (await sql(OWNER, `SELECT * FROM node WHERE board_id = ${boardId}`)).find(n => n.label === label).id;
}

const myBoards = who => sql(who.token, 'SELECT * FROM my_boards');
const statsOf = async boardId => (await sql(OWNER, `SELECT * FROM board_stats WHERE board_id = ${boardId}`))[0];
const outboxOf = async boardId =>
  (await sql(OWNER, `SELECT * FROM activity_outbox WHERE board_id = ${boardId}`)).sort((a, b) => (a.id < b.id ? -1 : 1));

// HTTP reducer calls disconnect immediately. Service identities skip ephemeral
// cleanup, so these isolated fixtures can inspect the selection written by a
// reducer while still using real participant kind and session checks.
async function focusActor(kind = 'agent') {
  const who = await mint();
  await ok(who.token, 'join_board', [named(kind), kind]);
  await sql(OWNER, `INSERT INTO service_account (identity, label) VALUES (0x${who.identity}, 'focus-fixture')`);
  return who;
}

async function sessionAs(who, name) {
  await ok(who.token, 'start_session', [name, `/tmp/${name}`, SHA]);
  return boardIdOf(name);
}

const selectionOf = async who => (await sql(OWNER, 'SELECT * FROM selection')).find(r => hexOf(r.identity) === who.identity);
const routeOf = async boardId => (await sql(OWNER, `SELECT * FROM session_route WHERE board_id = ${boardId}`))[0];
const sessionOf = async boardId => (await sql(OWNER, `SELECT * FROM session WHERE board_id = ${boardId}`))[0];
const routeEvents = async boardId =>
  (await sql(OWNER, `SELECT * FROM route_event WHERE board_id = ${boardId}`)).sort((a, b) => (a.id < b.id ? -1 : 1));
const updateNodeArgs = (nodeId, label) => [nodeId, { some: label }, ...Array(8).fill(NONE)];
const arrivalArgs = (boardId, nodeId, revision, checkpoint, headSha = SHA) => [boardId, nodeId, revision, checkpoint, headSha, '{"changed":1,"uncovered":[]}'];

test('RC-539 agent session node writes focus the caller, preserving human and ordinary board selection', async () => {
  const agent = await focusActor();
  const human = await focusActor('human');
  const B = await sessionAs(agent, named('focus'));
  const n1 = await nodeAs(agent, B, 'first');
  assert.deepEqual((await selectionOf(agent))?.nodeIds, [n1]);
  const n2 = await nodeAs(agent, B, 'second');
  assert.deepEqual((await selectionOf(agent))?.nodeIds, [n2]);
  await ok(agent.token, 'set_selection', [B, [n2]]);
  await ok(agent.token, 'update_node', updateNodeArgs(n1, 'edited'));
  assert.deepEqual((await selectionOf(agent))?.nodeIds, [n1]);
  await rejects(agent.token, 'update_node', [n2, NONE, NONE, { some: 'bad' }, ...Array(6).fill(NONE)], "token 'bad'");
  assert.deepEqual((await selectionOf(agent))?.nodeIds, [n1]);
  await ok(human.token, 'set_selection', [B, [n1]]);
  await nodeAs(human, B, 'human-created');
  await ok(human.token, 'update_node', updateNodeArgs(n2, 'human-edited'));
  assert.deepEqual((await selectionOf(human))?.nodeIds, [n1]);
  const plain = await createBoardAs(agent, named('plain-focus'));
  await nodeAs(agent, plain, 'ordinary');
  assert.deepEqual(pick(await selectionOf(agent), ['boardId', 'nodeIds']), { boardId: B, nodeIds: [n1] });
});

test('RC-539 node code ref writes focus once; duplicate, edge and checkpoint refresh calls preserve override', async () => {
  const agent = await focusActor();
  await ok(agent.token, 'set_code_consent', [true]); // its refs carry snippets (RC-690)
  const B = await sessionAs(agent, named('refs-focus'));
  const n1 = await nodeAs(agent, B, 'one');
  const n2 = await nodeAs(agent, B, 'two');
  await ok(agent.token, 'add_repo_files', [B, ['a.ts']]);
  const args = [B, 'node', n1, 'a.ts', 'one', 1, 1, SHA, 'function one() {}', 'agent'];
  await ok(agent.token, 'add_code_ref', args);
  assert.deepEqual((await selectionOf(agent))?.nodeIds, [n1]);
  const ref = (await sql(OWNER, `SELECT * FROM code_ref WHERE board_id = ${B}`))[0];
  await ok(agent.token, 'set_selection', [B, [n2]]);
  await rejects(agent.token, 'add_code_ref', args, 'already attached');
  assert.deepEqual((await selectionOf(agent))?.nodeIds, [n2]);
  await ok(agent.token, 'update_code_ref', [ref.id, 2, 2, SHA, 'function one() {}', 'ok']);
  assert.deepEqual((await selectionOf(agent))?.nodeIds, [n2]);
  await ok(agent.token, 'update_code_ref_and_focus', [ref.id, 3, 3, SHA, 'function one() { return 1; }', 'ok']);
  assert.deepEqual((await selectionOf(agent))?.nodeIds, [n1]);
  await ok(agent.token, 'set_selection', [B, [n2]]);
  await rejects(agent.token, 'update_code_ref_and_focus', [ref.id, 0, 0, SHA, 'one', 'ok'], 'range 0-0 is invalid');
  assert.deepEqual((await selectionOf(agent))?.nodeIds, [n2]);
  await rejects(agent.token, 'create_edge', [B, n1, n2, 'forged', 'human:test', NONE, NONE, NONE], 'agents cannot use human: evidence');
  await rejects(agent.token, 'create_edge', [B, n1, n2, 'bare', 'agent: ', NONE, NONE, NONE], "'agent:' must be followed");
  await ok(agent.token, 'create_edge', [B, n1, n2, 'edge', 'agent:test', NONE, NONE, NONE]);
  const edge = (await sql(OWNER, `SELECT * FROM edge WHERE board_id = ${B}`))[0];
  await ok(agent.token, 'add_code_ref', [B, 'edge', edge.id, 'a.ts', 'link', 1, 1, SHA, 'link()', 'agent']);
  const edgeRef = (await sql(OWNER, `SELECT * FROM code_ref WHERE target_id = ${edge.id}`)).find(r => r.targetKind === 'edge');
  await ok(agent.token, 'update_code_ref_and_focus', [edgeRef.id, 2, 2, SHA, 'link(2)', 'ok']);
  assert.deepEqual((await selectionOf(agent))?.nodeIds, [n2]);
});

test('RC-540 plan validates session waypoints and identical plans preserve route history', async () => {
  const actor = await focusActor();
  const B = await sessionAs(actor, named('route-plan'));
  const n1 = await nodeAs(actor, B, 'one');
  const n2 = await nodeAs(actor, B, 'destination');
  const X = await createBoardAs(actor, named('route-other'));
  const nx = await nodeAs(actor, X, 'foreign');
  await rejects(actor.token, 'plan_route', [X, [nx]], 'has no session');
  await rejects(actor.token, 'plan_route', [B, []], 'route must contain at least one waypoint');
  await rejects(actor.token, 'plan_route', [B, [n1, n1]], 'duplicate waypoint');
  await rejects(actor.token, 'plan_route', [B, [nx]], 'belongs to board');
  await rejects(actor.token, 'plan_route', [B, [999999]], 'does not exist');
  await ok(actor.token, 'plan_route', [B, [n1, n2]]);
  assert.deepEqual(pick(await routeOf(B), ['nodeIds', 'currentIndex', 'revision', 'currentCheckpoint']), { nodeIds: [n1, n2], currentIndex: -1, revision: 1, currentCheckpoint: 0 });
  await ok(actor.token, 'plan_route', [B, [n1, n2]]);
  await rejects(actor.token, 'plan_route', [B, [n2, n1]], 'already planned');
  const events = await routeEvents(B);
  assert.deepEqual(events.map(r => [r.kind, r.revision, r.nodeIds, r.checkpoint]), [['plan', 1, [n1, n2], 0]]);
});

test('RC-540 arrival commits route, checkpoint, focus and event atomically; retries preserve overrides', async () => {
  const actor = await focusActor();
  const B = await sessionAs(actor, named('route-arrive'));
  const n1 = await nodeAs(actor, B, 'one');
  const n2 = await nodeAs(actor, B, 'destination');
  await ok(actor.token, 'plan_route', [B, [n1, n2]]);
  await rejects(actor.token, 'arrive_at_checkpoint', arrivalArgs(B, n2, 1, 0), 'next pending waypoint');
  await rejects(actor.token, 'arrive_at_checkpoint', arrivalArgs(B, n1, 1, 0, 'bad'), 'headSha');
  assert.equal((await sessionOf(B)).checkpoint, 0);
  assert.equal((await routeOf(B)).currentIndex, -1);
  assert.equal((await routeEvents(B)).length, 1);
  await ok(actor.token, 'arrive_at_checkpoint', arrivalArgs(B, n1, 1, 0));
  assert.deepEqual(pick(await routeOf(B), ['currentIndex', 'revision', 'currentCheckpoint']), { currentIndex: 0, revision: 1, currentCheckpoint: 1 });
  assert.equal((await sessionOf(B)).checkpoint, 1);
  assert.deepEqual((await selectionOf(actor))?.nodeIds, [n1]);
  assert.equal((await statsOf(B)).sessionCheckpoint, 1);
  await ok(actor.token, 'set_selection', [B, [n2]]);
  await ok(actor.token, 'arrive_at_checkpoint', arrivalArgs(B, n1, 1, 0));
  assert.equal((await sessionOf(B)).checkpoint, 1);
  assert.deepEqual((await selectionOf(actor))?.nodeIds, [n2]);
  await ok(actor.token, 'arrive_at_checkpoint', arrivalArgs(B, n2, 1, 1));
  assert.equal((await routeOf(B)).currentIndex, 1);
  assert.equal((await sessionOf(B)).checkpoint, 2);
  await rejects(actor.token, 'arrive_at_checkpoint', arrivalArgs(B, n1, 1, 2), 'already done');
  assert.deepEqual((await routeEvents(B)).map(r => [r.kind, r.checkpoint]), [['plan', 0], ['arrive', 1], ['arrive', 2]]);
  assert.equal((await sql(OWNER, `SELECT * FROM edge WHERE board_id = ${B}`)).length, 0);
});

test('RC-540 stale revision, checkpoint and invisible arrival reject without partial progress', async () => {
  const actor = await focusActor();
  const B = await sessionAs(actor, named('route-atomic'));
  const n1 = await nodeAs(actor, B, 'one');
  const n2 = await nodeAs(actor, B, 'two');
  await ok(actor.token, 'plan_route', [B, [n1, n2]]);
  await ok(actor.token, 'mark_checkpoint', [B, SHA, '{}']);
  await rejects(actor.token, 'arrive_at_checkpoint', arrivalArgs(B, n1, 1, 0), 'checkpoint changed');
  await ok(actor.token, 'reroute', [B, [n2], [0], [], 'move destination first']);
  await rejects(actor.token, 'arrive_at_checkpoint', arrivalArgs(B, n2, 1, 1), 'route revision changed');
  await ok(actor.token, 'set_node_hidden', [n2, true, NONE]);
  await rejects(actor.token, 'arrive_at_checkpoint', arrivalArgs(B, n2, 2, 1), 'hidden');
  await sql(OWNER, `DELETE FROM node WHERE id = ${n2}`);
  await rejects(actor.token, 'arrive_at_checkpoint', arrivalArgs(B, n2, 2, 1), 'does not exist');
  assert.equal((await sessionOf(B)).checkpoint, 1);
  assert.equal((await routeOf(B)).currentIndex, -1);
  assert.deepEqual((await routeEvents(B)).map(r => r.kind), ['plan', 'reroute']);
});

test('RC-540 reroute preserves visited prefix, inserts sequentially and safely reopens completion', async () => {
  const actor = await focusActor();
  const B = await sessionAs(actor, named('route-reroute'));
  const ids = [];
  for (const label of ['one', 'two', 'three', 'four']) ids.push(await nodeAs(actor, B, label));
  const [n1, n2, n3, n4] = ids;
  await ok(actor.token, 'plan_route', [B, [n1, n2, n3]]);
  await ok(actor.token, 'arrive_at_checkpoint', arrivalArgs(B, n1, 1, 0));
  await rejects(actor.token, 'reroute', [B, [n1], [0], [], 'edit current'], 'visited waypoint');
  await rejects(actor.token, 'reroute', [B, [], [], [n1], 'remove current'], 'visited waypoint');
  await rejects(actor.token, 'reroute', [B, [n4, n4], [0, 1], [], 'duplicate'], 'duplicate waypoint');
  await rejects(actor.token, 'reroute', [B, [], [], [n2, n2], 'duplicate'], 'duplicate waypoint');
  await rejects(actor.token, 'reroute', [B, [n4], [], [], 'bad lengths'], 'same length');
  await rejects(actor.token, 'reroute', [B, [n4], [4], [], 'bad index'], 'pending index');
  await rejects(actor.token, 'reroute', [B, [], [], [], '  '], 'reason is empty');
  await ok(actor.token, 'reroute', [B, [n4, n3], [0, 1], [n2], 'new test path']);
  assert.deepEqual(pick(await routeOf(B), ['nodeIds', 'currentIndex', 'revision', 'currentCheckpoint']), { nodeIds: [n1, n4, n3], currentIndex: 0, revision: 2, currentCheckpoint: 1 });
  await ok(actor.token, 'reroute', [B, [n4, n3], [0, 1], [n2], 'new test path']);
  assert.equal((await routeEvents(B)).length, 3);
  await ok(actor.token, 'set_selection', [B, [n3]]);
  await ok(actor.token, 'arrive_at_checkpoint', arrivalArgs(B, n1, 1, 0));
  assert.deepEqual((await selectionOf(actor))?.nodeIds, [n3]);
  await ok(actor.token, 'arrive_at_checkpoint', arrivalArgs(B, n4, 2, 1));
  await ok(actor.token, 'arrive_at_checkpoint', arrivalArgs(B, n3, 2, 2));
  await ok(actor.token, 'reroute', [B, [n2], [0], [999999], 'extend completed destination']);
  assert.deepEqual(pick(await routeOf(B), ['nodeIds', 'currentIndex', 'revision', 'currentCheckpoint']), { nodeIds: [n1, n4, n3, n2], currentIndex: 2, revision: 3, currentCheckpoint: 3 });
  await ok(actor.token, 'arrive_at_checkpoint', arrivalArgs(B, n2, 3, 3));
  assert.equal((await sessionOf(B)).checkpoint, 4);
  const events = await routeEvents(B);
  assert.deepEqual(events.filter(r => r.kind === 'reroute').map(r => [r.nodeIds, r.reason, r.checkpoint]), [[[n1, n4, n3], 'new test path', 1], [[n1, n4, n3, n2], 'extend completed destination', 3]]);
});

test('RC-540 reroute cannot erase an unstarted route or add foreign and missing nodes', async () => {
  const actor = await focusActor();
  const B = await sessionAs(actor, named('route-empty'));
  const n1 = await nodeAs(actor, B, 'one');
  const X = await createBoardAs(actor, named('reroute-foreign'));
  const nx = await nodeAs(actor, X, 'foreign');
  await ok(actor.token, 'plan_route', [B, [n1]]);
  await rejects(actor.token, 'reroute', [B, [], [], [n1], 'erase'], 'at least one waypoint');
  await rejects(actor.token, 'reroute', [B, [nx], [0], [], 'foreign'], 'belongs to board');
  await rejects(actor.token, 'reroute', [B, [999999], [0], [], 'missing'], 'does not exist');
  await ok(actor.token, 'reroute', [B, [], [], [999999], 'already absent']);
  assert.equal((await routeEvents(B)).length, 1);
  assert.equal((await routeOf(B)).revision, 1);
});

// spec §1.3 acceptance fixture: the seeded Demo board
const DEMO_STATS = {
  nodes: 9, shownNodes: 8, edges: 6, shownEdges: 5,
  evImport: 1, evSource: 1, evStale: 0, evTest: 1, evHuman: 1, evNone: 1,
  refsOk: 0, refsStale: 0, refsAmbiguous: 0, repoFiles: 6,
  isSession: false, sessionCheckpoint: 0,
  covChanged: 0, covOnBoard: 0, covExcluded: 0, covUncovered: 0, covDeleted: 0,
};

let svc; // a minted identity the owner seeds into service_account
let demoId;

before(async () => {
  svc = await mint();
  await sql(OWNER, `INSERT INTO service_account (identity, label) VALUES (0x${svc.identity}, 'test')`);
  await ok(svc.token, 'seed_demo_board'); // service only
  demoId = await boardIdOf('Demo');
});

// --- M2: board health and the activity outbox ------------------------------

test('M2 health: the seeded Demo board carries the acceptance stats', async () => {
  const s = await statsOf(demoId);
  assert.ok(s, 'Demo has a board_stats row');
  assert.deepEqual(pick(s, Object.keys(DEMO_STATS)), DEMO_STATS);
});

test('M2 health: counters follow node, edge and hide edits; evidence counts shown edges only', async () => {
  const a = await mint();
  const X = await createBoardAs(a, named('health'));
  const n1 = await nodeAs(a, X, 'n1');
  const n2 = await nodeAs(a, X, 'n2');
  const n3 = await nodeAs(a, X, 'n3');
  await ok(a.token, 'create_edge', [X, n1, n2, 'h', 'human:test', NONE, NONE, NONE]);
  await ok(a.token, 'create_edge', [X, n2, n3, 'i', 'import', NONE, NONE, NONE]);
  await ok(a.token, 'set_node_hidden', [n3, true, NONE]);
  const s = await statsOf(X);
  assert.deepEqual(pick(s, ['nodes', 'shownNodes', 'edges', 'shownEdges', 'evHuman', 'evImport', 'evNone']), {
    nodes: 3, shownNodes: 2, edges: 2, shownEdges: 1, evHuman: 1, evImport: 0, evNone: 0,
  });
  assert.equal(hexOf(s.createdBy), a.identity);
  assert.ok(micros(s.createdAt) > 0, 'createdAt is the creation time, not the epoch');
});

test('M2 health: a source citation that is not ok counts as stale, never as proven (RC-538)', async () => {
  const a = await mint();
  await ok(a.token, 'set_code_consent', [true]); // a captured line is stored only with consent (RC-690)
  const X = await createBoardAs(a, named('stale'));
  const n1 = await nodeAs(a, X, 'n1');
  const n2 = await nodeAs(a, X, 'n2');
  await ok(a.token, 'add_repo_files', [X, ['src/a.ts']]);
  // no captured line: createEdge stores the citation as stale
  await ok(a.token, 'create_edge', [X, n1, n2, 'uncaptured', 'source:src/a.ts:3', NONE, NONE, NONE]);
  const created = (await outboxOf(X)).find(r => r.type === 'edge.created');
  assert.deepEqual(JSON.parse(created.payload), { from: 'n1', to: 'n2', evidence: 'stale' });
  await ok(a.token, 'create_edge', [X, n2, n1, 'captured', 'source:src/a.ts:4', NONE, { some: 'return a' }, NONE]);
  const edges = await sql(OWNER, `SELECT * FROM edge WHERE board_id = ${X}`);
  const byLabel = Object.fromEntries(edges.map(e => [e.label, e]));
  assert.deepEqual([byLabel.uncaptured.evidenceStatus, byLabel.captured.evidenceStatus], ['stale', 'ok']);
  const keys = ['shownEdges', 'evImport', 'evSource', 'evStale'];
  assert.deepEqual(pick(await statsOf(X), keys), { shownEdges: 2, evImport: 0, evSource: 1, evStale: 1 });
  // a checkpoint flagging the captured line moves it from source to stale
  await ok(a.token, 'update_edge_evidence', [byLabel.captured.id, 'source:src/a.ts:4', 'stale']);
  assert.deepEqual(pick(await statsOf(X), keys), { shownEdges: 2, evImport: 0, evSource: 0, evStale: 2 });
  const row = (await myBoards(a)).find(r => r.boardId === X);
  assert.deepEqual(pick(row, keys), { shownEdges: 2, evImport: 0, evSource: 0, evStale: 2 });
});

test('M2 health: a checkpoint stores parsed coverage and emits session.checkpoint', async () => {
  const s1 = await mint();
  const n = named('cov');
  await ok(s1.token, 'start_session', [n, `/tmp/${n}`, SHA]);
  const B = await boardIdOf(n);
  assert.equal((await statsOf(B)).isSession, true);
  const coverage = JSON.stringify({
    changed: 5,
    uncovered: ['a.ts'],
    excluded: [{ reason: 'lockfiles', paths: ['x.lock', 'y.lock'] }],
    deleted: ['d.ts'],
  });
  await ok(s1.token, 'mark_checkpoint', [B, SHA, coverage]);
  const keys = ['isSession', 'sessionCheckpoint', 'covChanged', 'covOnBoard', 'covExcluded', 'covUncovered', 'covDeleted'];
  assert.deepEqual(pick(await statsOf(B), keys), {
    isSession: true, sessionCheckpoint: 1, covChanged: 5, covOnBoard: 2, covExcluded: 2, covUncovered: 1, covDeleted: 1,
  });
  await ok(s1.token, 'mark_checkpoint', [B, SHA, 'not json']); // malformed coverage collapses to zeros
  assert.deepEqual(pick(await statsOf(B), ['sessionCheckpoint', 'covChanged', 'covOnBoard']), {
    sessionCheckpoint: 2, covChanged: 0, covOnBoard: 0,
  });
  // No board.stats history is written, so the second checkpoint within a minute merges into the first.
  const rows = await outboxOf(B);
  assert.deepEqual(rows.map(r => [r.type, r.count]), [['board.created', 1], ['session.started', 1], ['session.checkpoint', 2]]);
  assert.deepEqual(JSON.parse(rows[1].payload), { repo: n });
  assert.deepEqual(JSON.parse(rows[2].payload), { checkpoint: 2, changed: 0, onBoard: 0, uncovered: 0 });
});

test("M2 my_activity: the caller's own boards' bursts, without boards they only see as public", async () => {
  const a = await mint();
  const b = await mint();
  const X = await createBoardAs(a, named('feed-mine'));
  await ok(a.token, 'create_node', nodeArgs(X, 'mine'));
  const P = await createBoardAs(b, named('feed-public'));
  await ok(b.token, 'create_node', nodeArgs(P, 'theirs'));
  await sql(OWNER, `INSERT INTO public_board (board_id) VALUES (${P})`);
  assert.ok((await myBoards(a)).some(r => r.boardId === P && r.access === 'public'), 'a can open the public board');
  const feed = await sql(a.token, 'SELECT * FROM my_activity');
  assert.deepEqual(feed.map(r => [r.boardId, r.type]).sort(), [[X, 'board.created'], [X, 'node.created']]);
  assert.deepEqual((await sql(b.token, 'SELECT * FROM my_activity')).map(r => r.boardId).sort(), [P, P], 'the owner still sees it');
  await sql(OWNER, `DELETE FROM public_board WHERE board_id = ${P}`);
});

test('M2 outbox cap: a board keeps its newest 100 bursts and its board.created row', async () => {
  const a = await mint();
  const b = await mint();
  const X = await createBoardAs(a, named('cap'));
  await sql(OWNER, `INSERT INTO board_grant (id, board_id, grantee, role) VALUES (0, ${X}, 0x${b.identity}, 'owner')`);
  // alternating actors keep every create a burst of its own
  for (let i = 0; i < 105; i++) await ok((i % 2 ? b : a).token, 'create_node', nodeArgs(X, `n${i}`));
  const rows = await outboxOf(X);
  assert.equal(rows.length, 101);
  assert.equal(rows[0].type, 'board.created');
  assert.deepEqual(JSON.parse(rows[1].payload).label, 'n5', 'the five oldest bursts were dropped');
  assert.deepEqual(JSON.parse(rows.at(-1).payload).label, 'n104');
});

test("M2 events: one actor's burst of same-type edits merges into one outbox row", async () => {
  const a = await mint();
  const b = await mint();
  await ok(a.token, 'join_board', ['Alice', 'human']);
  const X = await createBoardAs(a, named('burst'));
  // Explicitly authorize the second fixture actor; personal boards are private.
  await sql(OWNER, `INSERT INTO board_grant (id, board_id, grantee, role) VALUES (0, ${X}, 0x${b.identity}, 'owner')`);
  for (const label of ['n1', 'n2', 'n3']) {
    await ok(a.token, 'create_node', nodeArgs(X, label));
  }
  await ok(b.token, 'create_node', nodeArgs(X, 'b1'));
  await ok(a.token, 'create_node', nodeArgs(X, 'n4'));
  const rows = await outboxOf(X);
  assert.deepEqual(rows.map(r => [r.type, hexOf(r.actor), r.count]), [
    ['board.created', a.identity, 1],
    ['node.created', a.identity, 3],
    ['node.created', b.identity, 1],
    ['node.created', a.identity, 1],
  ]);
  assert.deepEqual([rows[1].actorName, rows[1].actorKind], ['Alice', 'human']);
  assert.deepEqual(JSON.parse(rows[1].payload), { label: 'n3', kind: 'service' });
  assert.deepEqual(JSON.parse(rows[0].payload), { name: named('burst'), via: 'manual' });
  assert.ok(micros(rows[1].lastAt) >= micros(rows[1].at));
});

test('M2 createBoard: the name must be one short line', async () => {
  const a = await mint();
  for (const bad of ['', '   ', 'two\nlines', 'x'.repeat(101)]) {
    await rejects(a.token, 'create_board', [bad], 'board name must be one short line (1–100 characters)');
  }
});

test('M2 backfill_board_stats: rebuilds missing stats, service only', async () => {
  const a = await mint();
  const L = await createBoardAs(a, named('legacy'));
  await ok(a.token, 'create_node', nodeArgs(L, 'l1'));
  await ok(a.token, 'create_node', nodeArgs(L, 'l2'));
  await sql(OWNER, `DELETE FROM board_stats WHERE board_id = ${L}`); // a board made before RC-530
  assert.equal(await statsOf(L), undefined);
  await rejects(a.token, 'backfill_board_stats', [], 'not authorized: service account only');
  await ok(svc.token, 'backfill_board_stats', []);
  const s = await statsOf(L);
  assert.equal(s.nodes, 2);
  assert.equal(micros(s.createdAt), 0, 'a rebuilt row has an unknown (epoch) createdAt');
});

test('backfill_board_slugs: boards made before slugs get unique ones, service only, idempotent; my_board_slugs lists them', async () => {
  const a = await mint(), b = await mint();
  const L1 = await createBoardAs(a, named('pre-slug-1'));
  const L2 = await createBoardAs(a, named('pre-slug-2'));
  const slugOf = async id => (await sql(OWNER, `SELECT * FROM board WHERE id = ${id}`))[0].slug;
  assert.match(await slugOf(L1), /^[0-9a-f]{20}$/, 'a new board has its slug');
  await sql(OWNER, `UPDATE board SET slug = '' WHERE id = ${L1}`); // boards made before 2026-10-14
  await sql(OWNER, `UPDATE board SET slug = '' WHERE id = ${L2}`);
  await rejects(a.token, 'backfill_board_slugs', [], 'not authorized: service account only');
  await ok(svc.token, 'backfill_board_slugs', []);
  assert.deepEqual(await sql(OWNER, "SELECT * FROM board WHERE slug = ''"), [], 'no board is left without a slug');
  const [s1, s2] = [await slugOf(L1), await slugOf(L2)];
  assert.match(s1, /^[0-9a-f]{20}$/);
  assert.notEqual(s1, s2);
  await ok(svc.token, 'backfill_board_slugs', []);
  assert.deepEqual([await slugOf(L1), await slugOf(L2)], [s1, s2], 'a second run changes nothing');
  // the dashboard links the caller's boards by these slugs; another caller sees none of them
  const mine = new Map((await sql(a.token, 'SELECT * FROM my_board_slugs')).map(r => [String(r.boardId), r.slug]));
  assert.equal(mine.get(String(L1)), s1);
  assert.equal(mine.get(String(L2)), s2);
  const theirs = (await sql(b.token, 'SELECT * FROM my_board_slugs')).map(r => String(r.boardId));
  assert.ok(!theirs.includes(String(L1)) && !theirs.includes(String(L2)));
});

// --- M3: access, views, the drain, agent links ------------------------------

test("M3 my_boards: each caller sees their own boards, not each other's", async () => {
  const a = await mint();
  const b = await mint();
  const XA = await createBoardAs(a, named('mine-a'));
  const XB = await createBoardAs(b, named('mine-b'));
  const ma = await myBoards(a);
  const mb = await myBoards(b);
  assert.equal(ma.find(r => r.boardId === XB), undefined);
  assert.equal(mb.find(r => r.boardId === XA), undefined);
  assert.equal(mb.find(r => r.boardId === XB)?.access, 'owner');
  const row = ma.find(r => r.boardId === XA);
  assert.deepEqual(pick(row, ['name', 'access', 'orgId', 'sharedWith', 'statsReady', 'nodes']), {
    name: named('mine-a'), access: 'owner', orgId: '', sharedWith: [], statsReady: true, nodes: 0,
  });
  assert.ok(micros(row.createdAt) > 0 && micros(row.updatedAt) >= micros(row.createdAt));
  // the Worker's authz query (spec §2.4) runs as the caller
  const ids = (await sql(a.token, 'SELECT board_id FROM my_boards')).map(r => r.boardId);
  assert.ok(ids.includes(XA) && !ids.includes(XB));
});

test('M3 my_boards: the public Demo board is listed for a brand-new identity with its stats', async () => {
  const c = await mint();
  const demo = (await myBoards(c)).find(r => r.boardId === demoId);
  assert.ok(demo, 'Demo is listed');
  assert.deepEqual([demo.access, demo.statsReady], ['public', true]);
  assert.deepEqual(pick(demo, Object.keys(DEMO_STATS)), DEMO_STATS);
});

test('M3 my_boards: a board without stats is listed with statsReady false and zeros', async () => {
  const a = await mint();
  const L = await createBoardAs(a, named('nostats'));
  await ok(a.token, 'create_node', nodeArgs(L, 'n1'));
  await sql(OWNER, `DELETE FROM board_stats WHERE board_id = ${L}`);
  const row = (await myBoards(a)).find(r => r.boardId === L);
  assert.deepEqual([row.statsReady, row.nodes, micros(row.createdAt), micros(row.updatedAt)], [false, 0, 0, 0]);
});

test('M3 team: a team grant follows service-synced membership, unshare and drop_org', async () => {
  const a = await mint();
  const b = await mint();
  const org = named('org');
  const X = await createBoardAs(a, named('team-x'));
  await rejects(b.token, 'create_team_board', [named('tb'), org], `team rule: you are not a member of org ${org}; sync your teams and retry`);
  await rejects(a.token, 'share_board_with_team', [X, org], `team rule: you are not a member of org ${org}`);
  await rejects(svc.token, 'set_org_memberships', [id(a.identity), [org], []], 'orgIds and roles must have the same length');
  await ok(svc.token, 'set_org_memberships', [id(a.identity), [org], ['org:admin']]);
  await ok(svc.token, 'set_org_memberships', [id(b.identity), [org], ['org:member']]);
  await rejects(b.token, 'share_board_with_team', [X, org], `share rule: only an owner of board ${X} can share it`);
  await ok(a.token, 'share_board_with_team', [X, org]);
  await ok(a.token, 'share_board_with_team', [X, org]); // idempotent
  assert.equal((await sql(OWNER, `SELECT * FROM team_grant WHERE board_id = ${X}`)).length, 1);
  const seen = (await myBoards(b)).find(r => r.boardId === X);
  assert.deepEqual([seen?.access, seen?.orgId], ['team', org]);
  assert.deepEqual((await myBoards(a)).find(r => r.boardId === X).sharedWith, [org]);

  // a team board: owner for its creator, team for the other member
  await ok(b.token, 'create_team_board', [named('tb'), org]);
  const TB = await boardIdOf(named('tb'));
  assert.equal((await myBoards(b)).find(r => r.boardId === TB)?.access, 'owner');
  assert.equal((await myBoards(a)).find(r => r.boardId === TB)?.access, 'team');

  // revoke: the service replaces b's memberships with none
  await ok(svc.token, 'set_org_memberships', [id(b.identity), [], []]);
  assert.equal((await myBoards(b)).find(r => r.boardId === X), undefined);

  // unshare
  await ok(svc.token, 'set_org_memberships', [id(b.identity), [org], ['org:member']]);
  assert.ok((await myBoards(b)).find(r => r.boardId === X));
  await ok(a.token, 'unshare_board_from_team', [X, org]);
  assert.equal((await myBoards(b)).find(r => r.boardId === X), undefined);
  assert.deepEqual((await myBoards(a)).find(r => r.boardId === X).sharedWith, []);

  // drop_org: memberships and grants of the org go
  await ok(svc.token, 'drop_org', [org]);
  assert.equal((await myBoards(a)).find(r => r.boardId === TB), undefined);
  assert.equal((await sql(OWNER, `SELECT * FROM org_member WHERE org_id = '${org}'`)).length, 0);

  const types = (await outboxOf(X)).map(r => r.type);
  assert.ok(types.includes('board.shared') && types.includes('board.unshared'), types.join(', '));
});

test('M3 my_boards: a board reachable two ways is listed once, with the strongest access', async () => {
  const a = await mint();
  const org = named('dup');
  const X = await createBoardAs(a, named('dup-x'));
  await ok(svc.token, 'set_org_memberships', [id(a.identity), [org], ['org:admin']]);
  await ok(a.token, 'share_board_with_team', [X, org]);
  const rows = (await myBoards(a)).filter(r => r.boardId === X);
  assert.deepEqual(rows.map(r => [r.access, r.sharedWith]), [['owner', [org]]]);
});

test('M3 service reducers reject every other caller, the owner included', async () => {
  const a = await mint();
  const msg = 'not authorized: service account only';
  await rejects(a.token, 'set_org_memberships', [id(a.identity), ['org-x'], ['admin']], msg);
  await rejects(a.token, 'drop_org', ['org-x'], msg);
  await rejects(a.token, 'ack_activity', [[1], [1]], msg);
  await rejects(a.token, 'backfill_board_stats', [], msg);
  await rejects(OWNER, 'set_org_memberships', [id(a.identity), ['org-x'], ['admin']], msg);
});

test('M3 service_outbox: service only; ack deletes only rows whose count still matches', async () => {
  // drain first, like the Worker does, so the 500-row read cap cannot hide this board's rows
  for (let rows; (rows = await sql(svc.token, 'SELECT * FROM service_outbox')).length > 0; ) {
    await ok(svc.token, 'ack_activity', [rows.map(r => r.id), rows.map(r => r.count)]);
  }
  const a = await mint();
  const X = await createBoardAs(a, named('ack'));
  for (const label of ['n1', 'n2', 'n3']) {
    await ok(a.token, 'create_node', nodeArgs(X, label));
  }
  assert.deepEqual(await sql(a.token, 'SELECT * FROM service_outbox'), [], 'other callers see nothing');
  const read = async () =>
    (await sql(svc.token, 'SELECT * FROM service_outbox')).filter(r => r.boardId === X).sort((p, q) => (p.id < q.id ? -1 : 1));
  const [created, burst] = await read();
  assert.deepEqual([created.type, burst.type, burst.count], ['board.created', 'node.created', 3]);
  await ok(a.token, 'create_node', nodeArgs(X, 'n4')); // merges into the burst after the read
  await ok(svc.token, 'ack_activity', [[created.id, burst.id], [1, 3]]);
  assert.deepEqual((await read()).map(r => [r.id, r.count]), [[burst.id, 4]], 'the merged row survives a stale ack');
  await ok(svc.token, 'ack_activity', [[burst.id], [4]]);
  assert.deepEqual(await read(), []);
  await rejects(svc.token, 'ack_activity', [[burst.id], []], 'ids and counts must have the same length');
});

test('M3 agent link: offer with a 30-minute deadline, redeem once, refusals, unlink', async () => {
  const g = await mint(); // the agent
  const h = await mint(); // its human
  const other = await mint();
  await ok(g.token, 'join_board', ['crayon-agent', 'agent']);
  const n = named('agent-sess');
  await ok(g.token, 'start_session', [n, `/tmp/${n}`, SHA]);
  const S = await boardIdOf(n);
  await rejects(g.token, 'offer_agent_link', ['too-short'], 'link code must be 32–128 characters');
  const code1 = randomBytes(32).toString('base64url');
  const code2 = randomBytes(32).toString('base64url');
  await ok(g.token, 'offer_agent_link', [code1]);
  const t0 = Date.now() * 1000;
  await ok(g.token, 'offer_agent_link', [code2]); // replaces code1
  const t1 = Date.now() * 1000;
  // expiry: SQL DML cannot write a timestamp column (2.8.1), so the offer
  // cannot be backdated; check its stored deadline instead. The test server
  // shares this machine's clock.
  const [offer] = await sql(OWNER, `SELECT * FROM agent_link_offer WHERE code = '${code2}'`);
  const ttl = 30 * 60 * 1e6;
  assert.ok(
    micros(offer.expiresAt) >= t0 + ttl - 1e6 && micros(offer.expiresAt) <= t1 + ttl + 1e6,
    `the offer should expire 30 minutes after it was made, got ${micros(offer.expiresAt)} for an offer made in [${t0}, ${t1}]`
  );
  await rejects(h.token, 'redeem_agent_link', [code1], 'link code is invalid or expired');
  await rejects(h.token, 'redeem_agent_link', ['x'.repeat(40)], 'link code is invalid or expired');
  await rejects(g.token, 'redeem_agent_link', [code2], 'you cannot link an identity to itself');
  await ok(h.token, 'redeem_agent_link', [code2]);
  await rejects(h.token, 'redeem_agent_link', [code2], 'link code is invalid or expired'); // one use

  const row = (await myBoards(h)).find(r => r.boardId === S);
  assert.deepEqual([row?.access, row?.isSession], ['owner', true]); // the link moved it to its human
  const pairs = rows => rows.map(r => [hexOf(r.agent), hexOf(r.owner)]);
  assert.deepEqual(pairs(await sql(h.token, 'SELECT * FROM my_agent_links')), [[g.identity, h.identity]]);
  assert.deepEqual(pairs(await sql(g.token, 'SELECT * FROM my_agent_links')), [[g.identity, h.identity]]);
  assert.deepEqual(await sql(other.token, 'SELECT * FROM my_agent_links'), []);

  await rejects(other.token, 'unlink_agent', [id(g.identity)], `agent ${g.identity} is not linked to you`);
  await ok(h.token, 'unlink_agent', [id(g.identity)]);
  assert.equal((await myBoards(h)).find(r => r.boardId === S)?.access, 'owner'); // the human keeps it
  assert.equal((await myBoards(g)).find(r => r.boardId === S), undefined);
  assert.deepEqual(await sql(h.token, 'SELECT * FROM my_agent_links'), []);
});

// --- M4: reducer rules and the lifecycle ------------------------------------

test("M4 createEdge: both endpoints must be on the edge's board", async () => {
  const a = await mint();
  const X = await createBoardAs(a, named('edge-x'));
  const Y = await createBoardAs(a, named('edge-y'));
  const nx = await nodeAs(a, X, 'x1');
  const ny = await nodeAs(a, Y, 'y1');
  const msg = `edge rule: node ${ny} belongs to board ${Y}, not board ${X}`;
  await rejects(a.token, 'create_edge', [X, nx, ny, 'l', 'human:test', NONE, NONE, NONE], msg);
  await rejects(a.token, 'create_edge', [X, ny, nx, 'l', 'human:test', NONE, NONE, NONE], msg);
  assert.equal((await statsOf(X)).edges, 0);
});

test("M4 startSession: the name lookup is scoped to the caller's boards", async () => {
  const s1 = await mint();
  const s2 = await mint();
  const n = named('main');
  const plain = named('plain');
  await ok(s1.token, 'start_session', [n, '/workspace', SHA]);
  await ok(s2.token, 'start_session', [n, '/workspace', SHA]); // same name and root, other caller: its own board
  await ok(s1.token, 'start_session', [n, '/workspace', SHA]); // restart: re-adopts, no new board
  const sessions = async who =>
    (await myBoards(who)).filter(r => r.name === n && r.isSession && r.access === 'owner');
  const mine1 = await sessions(s1);
  const mine2 = await sessions(s2);
  assert.equal(mine1.length, 1);
  assert.equal(mine2.length, 1);
  assert.notEqual(mine1[0].boardId, mine2[0].boardId);
  assert.equal((await sql(OWNER, `SELECT id FROM board WHERE name = '${n}'`)).length, 2);
  await rejects(s2.token, 'start_session', [n, '/elsewhere', SHA], `session board '${n}' belongs to /workspace`);
  await ok(s1.token, 'create_board', [plain]);
  await ok(s2.token, 'start_session', [plain, '/workspace', SHA]); // s1's hand-made board is not s2's
  await rejects(s1.token, 'start_session', [plain, '/workspace', SHA], `board '${plain}' already exists without a session`);
});

test('M4 texts name the reducer to call as agents call it (snake_case)', async () => {
  const a = await mint();
  const X = await createBoardAs(a, named('words-plain'));
  await rejects(a.token, 'mark_checkpoint', [X, SHA, '{}'], `board ${X} has no session; call start_session first`);
  const S = await sessionAs(a, named('words-session'));
  await rejects(a.token, 'reroute', [S, [], [], [], 'why'], `board ${S} has no route; call plan_route first`);
});

test("M4 disconnect clears the caller's cursor and selection while other connections stay open (D6)", async () => {
  const a = await mint();
  const X = await createBoardAs(a, named('ghost'));
  const n1 = await nodeAs(a, X, 'n1');
  // pretend two canvas tabs are open: each HTTP call adds and drops one more
  await sql(OWNER, `UPDATE participant SET connections = 2 WHERE identity = 0x${a.identity}`);
  await ok(a.token, 'update_cursor', [X, 8, 8]);
  await ok(a.token, 'set_selection', [X, [n1]]);
  const mine = rows => rows.filter(r => hexOf(r.identity) === a.identity);
  assert.deepEqual(mine(await sql(OWNER, 'SELECT * FROM cursor')), []);
  assert.deepEqual(mine(await sql(OWNER, 'SELECT * FROM selection')), []);
  assert.equal(mine(await sql(OWNER, 'SELECT * FROM participant'))[0].connections, 2, 'the refcount still counts tabs');
});

test('M4 service calls leave no participant row', async () => {
  await ok(svc.token, 'backfill_board_stats', []);
  await sql(svc.token, 'SELECT * FROM service_outbox');
  const rows = (await sql(OWNER, 'SELECT * FROM participant')).filter(r => hexOf(r.identity) === svc.identity);
  assert.deepEqual(rows, []);
});
