// Module integration suite for node icons (spec docs/superpowers/specs/2026-10-18-component-library-design.md).
// Talks to an ISOLATED SpacetimeDB over the HTTP API only, like scripts/verify-charts-local.mjs:
//
//   nix develop --command scripts/stdb-test.sh run scripts/verify-icons-local.mjs
//   nix develop --command scripts/stdb-test.sh run --test-name-pattern '^IC ' scripts/verify-icons-local.mjs
//
// Every test mints its own identities and boards; none depends on another.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { ARCHITECTURE_ICON_RULE, ICON_IDS, ICON_KIND_RULE } from '../module/src/node-icons.ts';
import { CHART_KIND_RULE } from '../module/src/chart-contracts.ts';

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
const some = v => ({ some: v });
const named = s => `${s}-${RUN}`;

// --- HTTP API (verbatim from verify-charts-local.mjs) --------------------------

const bigints = (_k, v, ctx) => (typeof v === 'number' && !Number.isSafeInteger(v) ? BigInt(ctx.source) : v);
const camel = s => s.replace(/_([a-z])/g, (_m, c) => c.toUpperCase());

async function mint() {
  const r = await fetch(`${BASE}/v1/identity`, { method: 'POST' });
  assert.equal(r.status, 200, 'POST /v1/identity');
  return r.json();
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

async function sqlRaw(token, query) {
  const r = await fetch(`${BASE}/v1/database/${DB}/sql`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' },
    body: query,
  });
  return { status: r.status, text: await r.text() };
}

async function sql(token, query) {
  const { status, text } = await sqlRaw(token, query);
  assert.equal(status, 200, `sql ${status}: ${text} (${query})`);
  const [res] = JSON.parse(text, bigints);
  const cols = res.schema.elements.map(e => camel(e.name?.some ?? e.name));
  return res.rows.map(row => Object.fromEntries(cols.map((c, i) => [c, row[i]])));
}

// --- fixtures ----------------------------------------------------------------

// createNode: boardId, label, sublabel, x, y, w, h, token, focal, kind, doc, imported, shape, color, strokeStyle, size
const nodeArgs = (boardId, label, o = {}) => [
  boardId, label, o.sublabel ?? '', o.x ?? 0, o.y ?? 0, o.w ?? 160, o.h ?? 96, 'ink', o.focal ?? false,
  o.kind ? some(o.kind) : NONE, NONE, NONE, o.shape ? some(o.shape) : NONE, o.color ? some(o.color) : NONE, NONE, NONE,
];
// createIconNode: createNode's arguments, then icon
const iconNodeArgs = (boardId, label, icon, o = {}) => [...nodeArgs(boardId, label, o), icon];
// updateNode: nodeId, label, sublabel, token, focal, kind, shape, color, strokeStyle, size
const kindPatch = (nodeId, kind) => [nodeId, NONE, NONE, NONE, NONE, some(kind), NONE, NONE, NONE, NONE];
const TS = 'time,p99\n10:00,40\n10:05,44\n10:10,41\n';

async function boardIdOf(name) {
  const rows = await sql(OWNER, `SELECT id FROM board WHERE name = '${name}'`);
  assert.equal(rows.length, 1, `exactly one board named ${name}`);
  return rows[0].id;
}

async function createBoardAs(who, name) {
  await ok(who.token, 'create_board', [name]);
  return boardIdOf(name);
}

const nodesOn = boardId => sql(OWNER, `SELECT * FROM node WHERE board_id = ${boardId}`);
const iconsOn = boardId => sql(OWNER, `SELECT * FROM node_icon WHERE board_id = ${boardId}`);
const iconOf = async nodeId => (await sql(OWNER, `SELECT * FROM node_icon WHERE node_id = ${nodeId}`))[0];
const statsOf = async boardId => (await sql(OWNER, `SELECT * FROM board_stats WHERE board_id = ${boardId}`))[0];
const outboxOf = async boardId => sql(OWNER, `SELECT * FROM activity_outbox WHERE board_id = ${boardId}`);
const idOf = async (boardId, label) => (await nodesOn(boardId)).find(n => n.label === label).id;

async function iconNodeAs(who, boardId, label, icon, o = {}) {
  await ok(who.token, 'create_icon_node', iconNodeArgs(boardId, label, icon, o));
  return idOf(boardId, label);
}

async function nodeAs(who, boardId, label, o = {}) {
  await ok(who.token, 'create_node', nodeArgs(boardId, label, o));
  return idOf(boardId, label);
}

// Architecture fixtures (verify-charts-local.mjs): a service publishes a fact
// snapshot; its owner opens an intent proposal on top of it.
const archNode = key => ({ key, label: key, sublabel: '', kind: 'service' });
const archGraph = () => ({ nodes: [archNode('a'), archNode('b')], edges: [{ from: 'a', to: 'b', label: 'uses', relation: 'import', evidence: 'import' }], files: ['a.ts'] });
let svc;

before(async () => {
  svc = await mint();
  await sql(OWNER, `INSERT INTO service_account (identity, label) VALUES (0x${svc.identity}, 'icons-tests')`);
});

async function factBoard(who, name) {
  await ok(who.token, 'create_architecture_history', [named(name), 'https://github.com/example/repo', JSON.stringify([{ ref: 'main', sha: SHA }]), named(name)]);
  const h = (await sql(who.token, 'SELECT * FROM my_architecture_histories')).find(r => r.requestKey === named(name));
  await ok(svc.token, 'publish_architecture_snapshot', [h.id, 0, 'main', SHA, JSON.stringify(archGraph())]);
  return (await sql(OWNER, `SELECT * FROM architecture_version WHERE history_id = ${h.id}`)).find(v => v.assertionMode === 'fact');
}

async function proposalBoard(who, fact, name) {
  await ok(who.token, 'create_architecture_proposal', [fact.boardId, named(name), named(name)]);
  return (await sql(OWNER, `SELECT * FROM architecture_version WHERE history_id = ${fact.historyId}`)).find(v => v.requestKey === named(name));
}

// --- createIconNode -------------------------------------------------------------

test('IC create_icon_node writes the node and its icon row in one call', async () => {
  const who = await mint();
  const B = await createBoardAs(who, named('ic-create'));
  const id = await iconNodeAs(who, B, 'Planner', 'agent', { sublabel: 'agent', x: 40, y: 80, color: 'blue' });
  const n = (await nodesOn(B)).find(r => r.id === id);
  assert.deepEqual(
    { label: n.label, sublabel: n.sublabel, x: n.x, y: n.y, w: n.w, h: n.h, kind: n.kind, color: n.color },
    { label: 'Planner', sublabel: 'agent', x: 40, y: 80, w: 160, h: 96, kind: 'service', color: 'blue' }
  );
  assert.deepEqual(await iconOf(id), { nodeId: id, boardId: B, icon: 'agent' });
  assert.equal((await statsOf(B)).nodes, 1);
  assert.ok((await outboxOf(B)).some(r => r.type === 'node.created'), 'node.created is emitted once');
});

test('IC every id in the registry is accepted; kinds service, datastore, external and boundary take an icon', async () => {
  const who = await mint();
  const B = await createBoardAs(who, named('ic-ids'));
  for (const [i, icon] of ICON_IDS.entries()) {
    await ok(who.token, 'create_icon_node', iconNodeArgs(B, `n${i}`, icon, { x: (i % 10) * 200, y: Math.floor(i / 10) * 120 }));
  }
  for (const kind of ['datastore', 'external', 'boundary']) {
    await ok(who.token, 'create_icon_node', iconNodeArgs(B, kind, 'vercel', { kind, y: 2000 }));
  }
  assert.equal((await iconsOn(B)).length, ICON_IDS.length + 3);
});

test('IC refusals leave nothing behind: unknown icon, note and chart kinds, bad kind, off-grid, focal limit', async () => {
  const who = await mint();
  const B = await createBoardAs(who, named('ic-refuse'));
  await rejects(who.token, 'create_icon_node', iconNodeArgs(B, 'x', 'clippy'), "icon 'clippy' is not allowed; must be one of: agent, orchestrator");
  await rejects(who.token, 'create_icon_node', iconNodeArgs(B, 'x', ''), "icon '' is not allowed");
  await rejects(who.token, 'create_icon_node', iconNodeArgs(B, 'x', 'agent', { kind: 'note' }), ICON_KIND_RULE);
  await rejects(who.token, 'create_icon_node', iconNodeArgs(B, 'x', 'agent', { kind: 'chart' }), ICON_KIND_RULE);
  await rejects(who.token, 'create_icon_node', iconNodeArgs(B, 'x', 'agent', { kind: 'robot' }), "kind 'robot' is not allowed");
  await rejects(who.token, 'create_icon_node', iconNodeArgs(B, 'x', 'agent', { x: 2 }), 'grid rule: x = 2');
  await ok(who.token, 'create_icon_node', iconNodeArgs(B, 'f1', 'agent', { focal: true }));
  await ok(who.token, 'create_icon_node', iconNodeArgs(B, 'f2', 'agent', { focal: true }));
  await rejects(who.token, 'create_icon_node', iconNodeArgs(B, 'f3', 'agent', { focal: true }), 'focal limit');
  assert.deepEqual((await nodesOn(B)).map(n => n.label).sort(), ['f1', 'f2']);
  assert.equal((await iconsOn(B)).length, 2);
});

test('IC create_node is unchanged and still refuses charts with its own rule', async () => {
  const who = await mint();
  const B = await createBoardAs(who, named('ic-plain'));
  const id = await nodeAs(who, B, 'plain');
  assert.equal(await iconOf(id), undefined);
  await rejects(who.token, 'create_node', nodeArgs(B, 'c', { kind: 'chart' }), CHART_KIND_RULE);
});

// --- setNodeIcon -------------------------------------------------------------------

test('IC set_node_icon adds, replaces and removes an icon; removing none is fine', async () => {
  const who = await mint();
  const B = await createBoardAs(who, named('ic-set'));
  const id = await nodeAs(who, B, 'queue');
  await ok(who.token, 'set_node_icon', [id, 'queue']);
  assert.equal((await iconOf(id)).icon, 'queue');
  await ok(who.token, 'set_node_icon', [id, 'cache']);
  assert.equal((await iconOf(id)).icon, 'cache');
  assert.equal((await iconsOn(B)).length, 1);
  await ok(who.token, 'set_node_icon', [id, '']);
  assert.equal(await iconOf(id), undefined);
  await ok(who.token, 'set_node_icon', [id, '']);
  await rejects(who.token, 'set_node_icon', [id, 'nope'], "icon 'nope' is not allowed");
  const note = await nodeAs(who, B, 'a note', { kind: 'note' });
  await rejects(who.token, 'set_node_icon', [note, 'agent'], ICON_KIND_RULE);
  await rejects(who.token, 'set_node_icon', [987654321n, 'agent'], 'node 987654321 does not exist');
});

test('IC a change to another box kind keeps the icon; a change to a note drops it', async () => {
  const who = await mint();
  const B = await createBoardAs(who, named('ic-kind'));
  const a = await iconNodeAs(who, B, 'a', 'model', { kind: 'external' });
  for (const kind of ['service', 'datastore', 'boundary', 'external']) {
    await ok(who.token, 'update_node', kindPatch(a, kind));
    assert.equal((await iconOf(a))?.icon, 'model', kind);
  }
  await ok(who.token, 'update_node', kindPatch(a, 'note'));
  assert.equal(await iconOf(a), undefined);
  // back to a box: no icon until one is set again, and setting it works
  await ok(who.token, 'update_node', kindPatch(a, 'service'));
  assert.equal(await iconOf(a), undefined);
  await ok(who.token, 'set_node_icon', [a, 'model']);
  assert.equal((await iconOf(a)).icon, 'model');
});

test('IC a kind change keeps the icon; delete_node and delete_board remove icon rows', async () => {
  const who = await mint();
  const B = await createBoardAs(who, named('ic-cascade'));
  const a = await iconNodeAs(who, B, 'a', 'model', { kind: 'external' });
  const b = await iconNodeAs(who, B, 'b', 'memory', { kind: 'datastore', x: 200 });
  await ok(who.token, 'update_node', kindPatch(a, 'service'));
  assert.equal((await iconOf(a)).icon, 'model');
  await ok(who.token, 'delete_node', [a]);
  assert.equal(await iconOf(a), undefined);
  assert.equal((await iconOf(b)).icon, 'memory');
  await ok(who.token, 'delete_board', [B]);
  assert.deepEqual(await iconsOn(B), []);
});

// --- access ---------------------------------------------------------------------------

test('IC access: icon rows follow board access; strangers can neither read nor write them', async () => {
  const owner = await mint();
  const stranger = await mint();
  const B = await createBoardAs(owner, named('ic-access'));
  const id = await iconNodeAs(owner, B, 'secret agent', 'agent');
  assert.equal((await sql(owner.token, `SELECT * FROM visible_node_icon WHERE board_id = ${B}`)).length, 1);
  assert.deepEqual(await sql(stranger.token, `SELECT * FROM visible_node_icon WHERE board_id = ${B}`), []);
  const raw = await sqlRaw(stranger.token, 'SELECT * FROM node_icon');
  assert.equal(raw.status, 400, raw.text);
  await rejects(stranger.token, 'create_icon_node', iconNodeArgs(B, 'intruder', 'agent'), 'not authorized');
  await rejects(stranger.token, 'set_node_icon', [id, 'human'], 'not authorized');
  assert.equal((await iconOf(id)).icon, 'agent');
});

// --- architecture boards -----------------------------------------------------------------

test('IC icons are refused on fact snapshots and allowed on branches', async () => {
  const user = await mint();
  const fact = await factBoard(user, 'ic-arch');
  const intent = await proposalBoard(user, fact, 'ic-arch-proposal');
  await rejects(user.token, 'create_icon_node', iconNodeArgs(fact.boardId, 'on-fact', 'agent'), ARCHITECTURE_ICON_RULE);
  const factNode = (await nodesOn(fact.boardId))[0].id;
  await rejects(user.token, 'set_node_icon', [factNode, 'agent'], ARCHITECTURE_ICON_RULE);
  assert.deepEqual(await iconsOn(fact.boardId), []);
  const plain = (await nodesOn(intent.boardId))[0].id;
  await ok(user.token, 'set_node_icon', [plain, 'agent']);
  assert.equal((await iconsOn(intent.boardId)).length, 1);
});
