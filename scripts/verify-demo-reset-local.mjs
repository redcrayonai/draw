// Module integration suite for Demo's upkeep (RC-568): reset_demo puts the
// public Demo back to its seed once nobody wrote to it for 10 minutes. HTTP API
// only, as verify-dashboard-local.mjs. scripts/stdb-test.sh runs it last and
// alone: it rewrites Demo, which the dashboard and access suites read. Tests
// run in order and share Demo. SQL cannot write a timestamp, so instead of
// waiting 10 minutes the owner deletes Demo's stats row: no recorded write
// (a board from before RC-530) counts as idle.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.STDB_URL;
const DB = process.env.STDB_DB;
const OWNER = process.env.STDB_OWNER_TOKEN;
if (!BASE || !DB || !OWNER) {
  throw new Error('set STDB_URL, STDB_DB and STDB_OWNER_TOKEN (scripts/stdb-test.sh run does)');
}
if (DB === 'redcrayon') {
  throw new Error("refusing to run against the shared 'redcrayon' database; use scripts/stdb-test.sh");
}

const NONE = { none: [] };
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

const micros = v => BigInt(Array.isArray(v) ? v[0] : v.__timestamp_micros_since_unix_epoch__);

let svc;
let demo;

// Demo's rows without ids: nodes by label, edges and hide-set members by the labels they join.
async function drawing() {
  const rows = table => sql(OWNER, `SELECT * FROM ${table} WHERE board_id = ${demo}`);
  const strip = ({ id: _id, boardId: _b, ...rest }) => rest;
  const nodes = await rows('node');
  const label = new Map(nodes.map(n => [n.id, n.label]));
  const edges = (await rows('edge')).map(e => ({ ...strip(e), fromNode: label.get(e.fromNode), toNode: label.get(e.toNode), id: e.id }));
  const edgeName = new Map(edges.map(e => [e.id, `${e.fromNode}->${e.toNode}`]));
  const sets = [];
  for (const set of await rows('hide_set')) {
    const members = await sql(OWNER, `SELECT * FROM hide_set_member WHERE set_id = ${set.id}`);
    sets.push({ ...strip(set), members: members.map(m => `${m.targetKind}:${m.targetKind === 'node' ? label.get(m.targetId) : edgeName.get(m.targetId)}`).sort() });
  }
  const others = {};
  for (const table of ['code_ref', 'change_note', 'threat', 'chart', 'edge_weight', 'node_icon', 'route_event']) others[table] = (await rows(table)).length;
  const key = o => `${o.label}|${o.fromNode ?? ''}|${o.toNode ?? ''}`;
  return {
    nodes: nodes.map(strip).sort((a, b) => key(a).localeCompare(key(b))),
    edges: edges.map(({ id: _id, ...e }) => strip(e)).sort((a, b) => key(a).localeCompare(key(b))),
    repoFiles: (await rows('repo_file')).map(r => r.path).sort(),
    sets,
    others,
  };
}

const nodeIds = async () => (await sql(OWNER, `SELECT id FROM node WHERE board_id = ${demo}`)).map(n => n.id).sort();
const idle = () => sql(OWNER, `DELETE FROM board_stats WHERE board_id = ${demo}`);

let seed;

before(async () => {
  svc = await mint();
  await sql(OWNER, `INSERT INTO service_account (identity, label) VALUES (0x${svc.identity}, 'demo-reset-test')`);
  await ok(svc.token, 'seed_demo_board');
  const publics = new Set((await sql(OWNER, 'SELECT * FROM public_board')).map(r => r.boardId));
  demo = (await sql(OWNER, "SELECT * FROM board WHERE name = 'Demo'")).find(b => publics.has(b.id)).id;
  // The other suites only read Demo, so this is the seed seedDemoBoard wrote.
  seed = await drawing();
  assert.equal(seed.nodes.length, 9);
});

test('reset_demo is service only', async () => {
  const stranger = await mint(), owner = await mint();
  await ok(owner.token, 'create_board', [`own-${Date.now().toString(36)}`]);
  await rejects(stranger.token, 'reset_demo', [], 'service account only');
  await rejects(owner.token, 'reset_demo', [], 'service account only');
  assert.deepEqual(await sql(stranger.token, 'SELECT * FROM service_demo_reset'), []);
});

test('a recent write defers the reset; an idle changed Demo goes back to the seed, row for row', async () => {
  const node = (await sql(OWNER, `SELECT * FROM node WHERE board_id = ${demo}`)).find(n => n.label === 'Web Client');
  const edge = (await sql(OWNER, `SELECT * FROM edge WHERE board_id = ${demo}`))[0];
  await ok(svc.token, 'create_node', [demo, 'stray', '', 0, 0, 160, 80, 'ink', false, NONE, NONE, NONE, NONE, NONE, NONE, NONE]);
  await ok(svc.token, 'move_node', [node.id, 900, 900]);
  await ok(svc.token, 'delete_edge', [edge.id]);
  await ok(svc.token, 'add_threat', [demo, node.id, 'vulnerable', 'high', 'openssl RCE', 'Heap overflow.', '9.8', 'openssl@3.0.1', '3.0.7', '[]', '', 'agent']);
  const changed = await drawing();
  assert.notDeepEqual(changed, seed);

  await ok(svc.token, 'reset_demo');
  assert.deepEqual(await drawing(), changed, 'a write under 10 minutes ago is kept');

  await idle();
  await ok(svc.token, 'reset_demo');
  assert.deepEqual(await drawing(), seed);
  // The board, its link, grant and public row stay; stats count the seed again but keep the last write's time.
  const [board] = await sql(OWNER, `SELECT * FROM board WHERE id = ${demo}`);
  assert.equal(board.name, 'Demo');
  assert.equal((await sql(OWNER, `SELECT * FROM public_board WHERE board_id = ${demo}`)).length, 1);
  assert.equal((await sql(OWNER, `SELECT * FROM board_grant WHERE board_id = ${demo}`)).filter(g => g.role === 'owner').length, 1);
  const [stats] = await sql(OWNER, `SELECT * FROM board_stats WHERE board_id = ${demo}`);
  assert.deepEqual([stats.nodes, stats.shownNodes, stats.edges, stats.shownEdges], [9, 8, 6, 5]);
  assert.equal(micros(stats.updatedAt), 0n, 'the last write was never recorded, and a reset is not one');
  const [row] = await sql(svc.token, 'SELECT * FROM service_demo_reset');
  assert.equal(row.boardId, demo);
});

test('an unchanged Demo is not reset again; a write after the reset waits out its 10 minutes', async () => {
  const ids = await nodeIds();
  await ok(svc.token, 'reset_demo');
  assert.deepEqual(await nodeIds(), ids, 'nothing changed since the reset, so its rows stay');

  const node = (await sql(OWNER, `SELECT * FROM node WHERE board_id = ${demo}`))[0];
  await ok(svc.token, 'move_node', [node.id, node.x + 8, node.y]);
  const [{ resetAt }] = await sql(OWNER, `SELECT * FROM demo_reset WHERE board_id = ${demo}`);
  const [stats] = await sql(OWNER, `SELECT * FROM board_stats WHERE board_id = ${demo}`);
  assert.ok(micros(stats.updatedAt) > micros(resetAt), 'the move is recorded although the reset just ran');
  await ok(svc.token, 'reset_demo');
  assert.equal((await sql(OWNER, `SELECT * FROM node WHERE id = ${node.id}`))[0].x, node.x + 8, 'the move is recent');
});
