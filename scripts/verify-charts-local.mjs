// Module integration suite for chart objects and the chart library (spec
// docs/superpowers/specs/2026-10-09-chart-library-design.md, "Reducers").
// Talks to an ISOLATED SpacetimeDB over the HTTP API only, like
// scripts/verify-dashboard-local.mjs. scripts/stdb-test.sh sets it up:
//
//   nix develop --command scripts/stdb-test.sh run scripts/verify-charts-local.mjs
//   nix develop --command scripts/stdb-test.sh run --test-name-pattern '^CH ' scripts/verify-charts-local.mjs
//
// Expected parse errors come from the same parseChart the module runs, so the
// "errors surface verbatim" checks cannot drift from the contracts. Every test
// mints its own identities and boards; none depends on another.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseChart,
  CHART_CONTRACTS,
  MAX_CSV_BYTES,
  CHART_KIND_RULE,
  AGENT_SOURCE_RULE,
  SAMPLE_RESERVED,
  SAMPLE_NEEDS_SOURCE,
  HUMAN_DATA_NEEDS_SOURCE,
  HUMAN_SOURCE_RESERVED,
  ARCHITECTURE_CHART_RULE,
} from '../module/src/chart-contracts.ts';

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

// --- HTTP API (verbatim from verify-dashboard-local.mjs) -------------------

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

async function sqlRaw(token, query) {
  const r = await fetch(`${BASE}/v1/database/${DB}/sql`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' },
    body: query,
  });
  return { status: r.status, text: await r.text() };
}

// rows as objects keyed by camelCase column names
async function sql(token, query) {
  const { status, text } = await sqlRaw(token, query);
  assert.equal(status, 200, `sql ${status}: ${text} (${query})`);
  const [res] = JSON.parse(text, bigints);
  const cols = res.schema.elements.map(e => camel(e.name?.some ?? e.name));
  return res.rows.map(row => Object.fromEntries(cols.map((c, i) => [c, row[i]])));
}

// SATS-JSON special products arrive as {"__x__": v} or [v]
const hexOf = v => String(Array.isArray(v) ? v[0] : v.__identity__).replace(/^0x/, '').toLowerCase();
const micros = v => Number(Array.isArray(v) ? v[0] : v.__timestamp_micros_since_unix_epoch__);

// --- fixtures ----------------------------------------------------------------

const TS = CHART_CONTRACTS.timeseries.example;
const PIE = CHART_CONTRACTS.pie.example;
// A second valid timeseries, for data edits: HH:MM ascending, one series.
const TS2 = 'time,p99\n10:00,40\n10:05,44\n10:10,41\n';
const TS_AREA = '{"style":"area"}';

// The expected rejection for an input, from the module's own parser.
function parseError(type, csv, options = '{}') {
  const r = parseChart(type, csv, options);
  assert.equal(r.ok, false, `fixture should not parse: ${type} ${JSON.stringify(csv.slice(0, 60))} ${options}`);
  return r.error;
}

const nodeArgs = (boardId, label) => [boardId, label, '', 0, 0, 160, 80, 'ink', false, NONE, NONE, NONE, NONE, NONE, NONE, NONE];
const nodeKindArgs = (boardId, label, kind) => [boardId, label, '', 0, 0, 160, 80, 'ink', false, some(kind), NONE, NONE, NONE, NONE, NONE, NONE];
// updateNode: nodeId, label, sublabel, token, focal, kind, shape, color, strokeStyle, size
const kindPatch = (nodeId, kind, label = NONE) => [nodeId, label, NONE, NONE, NONE, some(kind), NONE, NONE, NONE, NONE];
// createChart: boardId, label, sublabel, x, y, w, h, type, csv, options, source
const chartArgs = (boardId, label, o = {}) => [
  boardId, label, o.sublabel ?? '', o.x ?? 0, o.y ?? 0, o.w ?? 352, o.h ?? 224,
  o.type ?? 'timeseries', o.csv ?? TS, o.options ?? NONE, o.source ?? NONE,
];
// setChartData: nodeId, type, csv, options, source
const dataArgs = (nodeId, o = {}) => [nodeId, o.type ?? NONE, o.csv ?? NONE, o.options ?? NONE, o.source ?? NONE];

async function boardIdOf(name) {
  const rows = await sql(OWNER, `SELECT id FROM board WHERE name = '${name}'`);
  assert.equal(rows.length, 1, `exactly one board named ${name}`);
  return rows[0].id;
}

async function createBoardAs(who, name) {
  await ok(who.token, 'create_board', [name]);
  return boardIdOf(name);
}

// Boards are private to their owner: collaborators edit through a team share.
async function shareWith(owner, boardId, ...members) {
  const org = named(`ch-team-${boardId}`);
  const id = who => ({ __identity__: `0x${who.identity}` });
  await ok(svc.token, 'set_org_memberships', [id(owner), [org], ['org:admin']]);
  for (const m of members) await ok(svc.token, 'set_org_memberships', [id(m), [org], ['org:member']]);
  await ok(owner.token, 'share_board_with_team', [boardId, org]);
}

const nodesOn = boardId => sql(OWNER, `SELECT * FROM node WHERE board_id = ${boardId}`);
const chartsOn = boardId => sql(OWNER, `SELECT * FROM chart WHERE board_id = ${boardId}`);
const nodeOf = async nodeId => (await sql(OWNER, `SELECT * FROM node WHERE id = ${nodeId}`))[0];
const chartOf = async nodeId => (await sql(OWNER, `SELECT * FROM chart WHERE node_id = ${nodeId}`))[0];
const statsOf = async boardId => (await sql(OWNER, `SELECT * FROM board_stats WHERE board_id = ${boardId}`))[0];
const outboxOf = async boardId =>
  (await sql(OWNER, `SELECT * FROM activity_outbox WHERE board_id = ${boardId}`)).sort((a, b) => (a.id < b.id ? -1 : 1));
const selectionOf = async who => (await sql(OWNER, 'SELECT * FROM selection')).find(r => hexOf(r.identity) === who.identity);
const myLibrary = who => sql(who.token, 'SELECT * FROM my_library');

async function nodeAs(who, boardId, label) {
  await ok(who.token, 'create_node', nodeArgs(boardId, label));
  return (await nodesOn(boardId)).find(n => n.label === label).id;
}

async function chartAs(who, boardId, label, o = {}) {
  await ok(who.token, 'create_chart', chartArgs(boardId, label, o));
  return (await nodesOn(boardId)).find(n => n.label === label && n.kind === 'chart').id;
}

// join_board once is enough: an HTTP call's disconnect keeps participant.kind.
async function joined(kind, name = named(kind)) {
  const who = await mint();
  await ok(who.token, 'join_board', [name, kind]);
  return { ...who, name };
}

// See verify-dashboard-local.mjs: a service identity keeps its selection row
// after the HTTP call disconnects, so focus can be read back.
async function focusActor(kind = 'agent') {
  const who = await joined(kind);
  await sql(OWNER, `INSERT INTO service_account (identity, label) VALUES (0x${who.identity}, 'focus-fixture')`);
  return who;
}

async function sessionAs(who, name) {
  await ok(who.token, 'start_session', [name, `/tmp/${name}`, SHA]);
  return boardIdOf(name);
}

// Architecture fixtures (verify-architecture-local.mjs): a service publishes a
// fact snapshot; its owner opens an intent proposal on top of it.
const archNode = key => ({ key, label: key, sublabel: '', kind: 'service' });
const archGraph = () => ({ nodes: [archNode('a'), archNode('b')], edges: [{ from: 'a', to: 'b', label: 'uses', relation: 'import', evidence: 'import' }], files: ['a.ts'] });
let svc;

before(async () => {
  svc = await mint();
  await sql(OWNER, `INSERT INTO service_account (identity, label) VALUES (0x${svc.identity}, 'charts-tests')`);
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

const payload = (extra = {}) => JSON.stringify({ version: 1, nodes: [], edges: [], ...extra });

// --- createChart -------------------------------------------------------------

test('CH createChart writes the chart node and its chart row in one call', async () => {
  const human = await joined('human');
  const B = await createBoardAs(human, named('ch-create'));
  const id = await chartAs(human, B, 'p99 latency', { sublabel: 'checkout', x: 40, y: 80, w: 352, h: 224 });
  const n = await nodeOf(id);
  assert.deepEqual(
    { kind: n.kind, label: n.label, sublabel: n.sublabel, x: n.x, y: n.y, w: n.w, h: n.h, token: n.token, focal: n.focal, doc: n.doc, hidden: n.hidden, imported: n.imported, sourceKey: n.sourceKey, shape: n.shape, color: n.color, strokeStyle: n.strokeStyle, size: n.size },
    { kind: 'chart', label: 'p99 latency', sublabel: 'checkout', x: 40, y: 80, w: 352, h: 224, token: 'ink', focal: false, doc: '', hidden: false, imported: false, sourceKey: '', shape: 'rect', color: '', strokeStyle: 'solid', size: 'm' }
  );
  const c = await chartOf(id);
  assert.deepEqual(
    { boardId: c.boardId, type: c.type, csv: c.csv, options: c.options, source: c.source },
    { boardId: B, type: 'timeseries', csv: TS, options: '{}', source: `human:${human.name}` }
  );
  assert.ok(micros(c.updatedAt) > 0);
  assert.equal((await statsOf(B)).nodes, 1);
  const last = (await outboxOf(B)).pop();
  assert.equal(last.type, 'node.created');
  assert.deepEqual(JSON.parse(last.payload), { label: 'p99 latency', kind: 'chart' });
});

test('CH createChart stores options as given, and blank options as {}', async () => {
  const human = await joined('human');
  const B = await createBoardAs(human, named('ch-options'));
  assert.equal(parseChart('timeseries', TS, TS_AREA).ok, true, 'fixture parses');
  const area = await chartAs(human, B, 'area', { options: some(TS_AREA) });
  const blank = await chartAs(human, B, 'blank', { options: some('  ') });
  assert.equal((await chartOf(area)).options, TS_AREA);
  assert.equal((await chartOf(blank)).options, '{}');
});

test('CH createChart rejects bad input verbatim and writes nothing', async () => {
  const human = await joined('human');
  const B = await createBoardAs(human, named('ch-atomic'));
  const seven = 'time,a,b,c,d,e,f,g\n10:00,1,2,3,4,5,6,7\n10:05,1,2,3,4,5,6,7\n';
  const unit = 'time,p99\n10:00,12ms\n10:05,14\n';
  const big = `time,v\n${'10:00,1\n'.repeat(Math.ceil(MAX_CSV_BYTES / 8) + 1)}`;
  await rejects(human.token, 'create_chart', chartArgs(B, 'seven', { csv: seven }), parseError('timeseries', seven));
  await rejects(human.token, 'create_chart', chartArgs(B, 'unit', { csv: unit }), parseError('timeseries', unit));
  await rejects(human.token, 'create_chart', chartArgs(B, 'big', { csv: big }), parseError('timeseries', big));
  await rejects(human.token, 'create_chart', chartArgs(B, 'heat', { type: 'heatmap' }), parseError('heatmap', TS));
  await rejects(human.token, 'create_chart', chartArgs(B, 'opt', { options: some('{"nope":1}') }), parseError('timeseries', TS, '{"nope":1}'));
  await rejects(human.token, 'create_chart', chartArgs(B, 'grid', { x: 3 }), 'grid rule: x = 3 is not divisible by 4');
  // a missing board answers like an unreadable one: ids are not an existence oracle
  await rejects(human.token, 'create_chart', chartArgs(999999999, 'nowhere'), 'not authorized: board is unavailable');
  assert.deepEqual(await nodesOn(B), []);
  assert.deepEqual(await chartsOn(B), []);
  assert.equal((await statsOf(B)).nodes, 0);
});

test('CH createChart and resizeNode keep charts at 224x144 or larger', async () => {
  const human = await joined('human');
  const B = await createBoardAs(human, named('ch-size'));
  await rejects(human.token, 'create_chart', chartArgs(B, 'narrow', { w: 220, h: 144 }), 'chart size rule: charts must be at least 224x144; got 220x144');
  await rejects(human.token, 'create_chart', chartArgs(B, 'short', { w: 224, h: 140 }), 'chart size rule: charts must be at least 224x144; got 224x140');
  const id = await chartAs(human, B, 'smallest', { w: 224, h: 144 });
  await rejects(human.token, 'resize_node', [id, 0, 0, 220, 144], 'chart size rule: charts must be at least 224x144; got 220x144');
  await rejects(human.token, 'resize_node', [id, 0, 0, 400, 140], 'chart size rule: charts must be at least 224x144; got 400x140');
  await ok(human.token, 'resize_node', [id, 8, 8, 400, 240]);
  const n = await nodeOf(id);
  assert.deepEqual([n.x, n.y, n.w, n.h], [8, 8, 400, 240]);
  // other kinds keep the 64x48 floor
  const plain = await nodeAs(human, B, 'plain');
  await ok(human.token, 'resize_node', [plain, 0, 0, 64, 48]);
  assert.deepEqual([(await nodeOf(plain)).w, (await nodeOf(plain)).h], [64, 48]);
});

// --- kind guards and delete -----------------------------------------------------

test('CH createNode and updateNode refuse kind chart; a chart keeps its kind', async () => {
  const human = await joined('human');
  const B = await createBoardAs(human, named('ch-kind'));
  await rejects(human.token, 'create_node', nodeKindArgs(B, 'fake', 'chart'), CHART_KIND_RULE);
  const plain = await nodeAs(human, B, 'plain');
  await rejects(human.token, 'update_node', kindPatch(plain, 'chart'), CHART_KIND_RULE);
  assert.equal((await nodeOf(plain)).kind, 'service');
  const id = await chartAs(human, B, 'chart');
  await rejects(human.token, 'update_node', kindPatch(id, 'service'), 'a chart cannot change kind; delete it and create a node instead');
  // sending the same kind back (MCP update_node, client undo) is a no-op that passes
  await ok(human.token, 'update_node', kindPatch(id, 'chart', some('renamed')));
  const n = await nodeOf(id);
  assert.deepEqual([n.kind, n.label], ['chart', 'renamed']);
  // the allowlist still names every kind for other values
  await rejects(human.token, 'create_node', nodeKindArgs(B, 'odd', 'gauge'), "kind 'gauge' is not allowed; must be one of: service, datastore, external, boundary, note, text, chart");
  assert.equal((await nodesOn(B)).length, 2);
});

test('CH deleteNode removes the chart row with the node', async () => {
  const human = await joined('human');
  const B = await createBoardAs(human, named('ch-delete'));
  const id = await chartAs(human, B, 'gone');
  const keep = await chartAs(human, B, 'kept');
  const plain = await nodeAs(human, B, 'plain');
  await ok(human.token, 'delete_node', [id]);
  assert.equal(await nodeOf(id), undefined);
  assert.equal(await chartOf(id), undefined);
  assert.equal((await chartOf(keep)).nodeId, keep);
  await ok(human.token, 'delete_node', [plain]); // no chart row: still fine
  assert.deepEqual((await nodesOn(B)).map(n => n.id), [keep]);
  assert.equal((await statsOf(B)).nodes, 1);
});

test('CH access: chart rows follow board access; strangers cannot read or write them; delete_board removes them', async () => {
  const owner = await joined('human');
  const stranger = await joined('human');
  const B = await createBoardAs(owner, named('ch-access'));
  const id = await chartAs(owner, B, 'private chart');
  assert.equal((await sql(owner.token, `SELECT * FROM visible_chart WHERE board_id = ${B}`)).length, 1);
  assert.deepEqual(await sql(stranger.token, `SELECT * FROM visible_chart WHERE board_id = ${B}`), []);
  const raw = await sqlRaw(stranger.token, 'SELECT * FROM chart');
  assert.equal(raw.status, 400, raw.text);
  await rejects(stranger.token, 'create_chart', chartArgs(B, 'stolen'), 'not authorized');
  await rejects(stranger.token, 'set_chart_data', dataArgs(id, { csv: some(TS2) }), 'not authorized');
  assert.equal((await chartOf(id)).csv, TS);
  await ok(owner.token, 'delete_board', [B]);
  assert.deepEqual(await chartsOn(B), []);
});

// --- setChartData --------------------------------------------------------------

test('CH setChartData merges omitted fields, re-parses, and moves updatedAt', async () => {
  const human = await joined('human');
  const B = await createBoardAs(human, named('ch-set'));
  assert.equal(parseChart('timeseries', TS2, TS_AREA).ok, true, 'fixture parses');
  const id = await chartAs(human, B, 'latency', { source: some('ci: bench') });
  const c0 = await chartOf(id);

  await ok(human.token, 'set_chart_data', dataArgs(id, { options: some(TS_AREA) }));
  const c1 = await chartOf(id);
  assert.deepEqual([c1.type, c1.csv, c1.options, c1.source], ['timeseries', TS, TS_AREA, 'ci: bench']);
  assert.ok(micros(c1.updatedAt) > micros(c0.updatedAt), 'updatedAt moves');

  // new numbers without a source: the stored one no longer describes them
  await ok(human.token, 'set_chart_data', dataArgs(id, { csv: some(TS2) }));
  const c2 = await chartOf(id);
  assert.deepEqual([c2.type, c2.csv, c2.options, c2.source], ['timeseries', TS2, TS_AREA, `human:${human.name}`]);
  assert.ok(micros(c2.updatedAt) > micros(c1.updatedAt));

  await ok(human.token, 'set_chart_data', dataArgs(id, { type: some('pie'), csv: some(PIE), options: some('') }));
  const c3 = await chartOf(id);
  assert.deepEqual([c3.type, c3.csv, c3.options], ['pie', PIE, '{}']);
  assert.equal((await nodeOf(id)).kind, 'chart');
});

test('CH setChartData rejects the merged result verbatim and keeps the row', async () => {
  const human = await joined('human');
  const B = await createBoardAs(human, named('ch-set-bad'));
  const id = await chartAs(human, B, 'latency', { options: some(TS_AREA) });
  const before = await chartOf(id);
  // a type switch alone keeps the old csv and options; the parser decides
  await rejects(human.token, 'set_chart_data', dataArgs(id, { type: some('waterfall') }), parseError('waterfall', TS, TS_AREA));
  const unit = 'time,p99\n10:00,12ms\n10:05,14\n';
  await rejects(human.token, 'set_chart_data', dataArgs(id, { csv: some(unit) }), parseError('timeseries', unit, TS_AREA));
  await rejects(human.token, 'set_chart_data', dataArgs(id, { options: some('{"nope":1}') }), parseError('timeseries', TS, '{"nope":1}'));
  assert.deepEqual(await chartOf(id), before);
});

test('CH setChartData answers for nodes that are not charts', async () => {
  const human = await joined('human');
  const B = await createBoardAs(human, named('ch-not-chart'));
  const plain = await nodeAs(human, B, 'plain');
  await rejects(human.token, 'set_chart_data', dataArgs(plain, { csv: some(TS) }), `node ${plain} is not a chart`);
  await rejects(human.token, 'set_chart_data', dataArgs(999999999, { csv: some(TS) }), 'node 999999999 does not exist');
  assert.deepEqual(await chartsOn(B), []);
});

// --- the source rule ---------------------------------------------------------------

test('CH source: an agent must say where the data came from, and cannot claim sample', async () => {
  const agent = await joined('agent');
  const B = await createBoardAs(agent, named('ch-agent-src'));
  await rejects(agent.token, 'create_chart', chartArgs(B, 'none'), AGENT_SOURCE_RULE);
  await rejects(agent.token, 'create_chart', chartArgs(B, 'blank', { source: some('   ') }), AGENT_SOURCE_RULE);
  await rejects(agent.token, 'create_chart', chartArgs(B, 'sample', { source: some('sample') }), SAMPLE_RESERVED);
  // an agent cannot credit its numbers to a person, whatever the case or padding
  await rejects(agent.token, 'create_chart', chartArgs(B, 'forged', { source: some('human:alice') }), HUMAN_SOURCE_RESERVED);
  await rejects(agent.token, 'create_chart', chartArgs(B, 'forged-2', { source: some('  HUMAN: alice') }), HUMAN_SOURCE_RESERVED);
  assert.deepEqual(await nodesOn(B), []);
  const id = await chartAs(agent, B, 'bench', { source: some('agent: npm run bench @ 4b825dc') });
  assert.equal((await chartOf(id)).source, 'agent: npm run bench @ 4b825dc');
  // a data edit with source omitted keeps it; a blank or sample one is refused
  await ok(agent.token, 'set_chart_data', dataArgs(id, { csv: some(TS2) }));
  assert.equal((await chartOf(id)).source, 'agent: npm run bench @ 4b825dc');
  await rejects(agent.token, 'set_chart_data', dataArgs(id, { csv: some(TS), source: some('') }), AGENT_SOURCE_RULE);
  await rejects(agent.token, 'set_chart_data', dataArgs(id, { source: some('sample') }), SAMPLE_RESERVED);
  await rejects(agent.token, 'set_chart_data', dataArgs(id, { csv: some(TS), source: some('Human:bob') }), HUMAN_SOURCE_RESERVED);
  await ok(agent.token, 'set_chart_data', dataArgs(id, { source: some('agent: npm run bench @ e3b0c44') }));
  assert.equal((await chartOf(id)).source, 'agent: npm run bench @ e3b0c44');
});

test('CH source: a human gets human:<displayName>, or the identity prefix before joining', async () => {
  const human = await joined('human');
  const B = await createBoardAs(human, named('ch-human-src'));
  const a = await chartAs(human, B, 'omitted');
  const b = await chartAs(human, B, 'blank', { source: some('  ') });
  const c = await chartAs(human, B, 'given', { source: some('  grafana export, 9 Oct  ') });
  assert.equal((await chartOf(a)).source, `human:${human.name}`);
  assert.equal((await chartOf(b)).source, `human:${human.name}`);
  assert.equal((await chartOf(c)).source, 'grafana export, 9 Oct');
  // a bare HTTP caller has the onConnect stub row with an empty name
  const bare = await mint();
  const long = await joined('human', 'n'.repeat(250));
  await shareWith(human, B, bare, long);
  const d = await chartAs(bare, B, 'bare');
  assert.equal((await chartOf(d)).source, `human:${bare.identity.slice(0, 12)}`);
  // join_board caps names at 100 code points; undo can replay that attribution.
  const e = await chartAs(long, B, 'long-name');
  assert.equal((await chartOf(e)).source, `human:${'n'.repeat(100)}`);
  await ok(long.token, 'set_chart_data', dataArgs(e, { csv: some(TS2), source: some(`human:${'n'.repeat(100)}`) }));
  assert.equal((await chartOf(e)).source, `human:${'n'.repeat(100)}`);
  await ok(long.token, 'join_board', ['😀'.repeat(100), 'human']);
  const f = await chartAs(long, B, 'unicode-name');
  assert.equal((await chartOf(f)).source, `human:${'😀'.repeat(97)}`, 'the 200-character source cap keeps whole Unicode characters');
});

test('CH source: at most 200 characters', async () => {
  const human = await joined('human');
  const B = await createBoardAs(human, named('ch-src-cap'));
  await rejects(human.token, 'create_chart', chartArgs(B, 'long', { source: some('s'.repeat(201)) }), 'source is 201 characters; the limit is 200');
  const id = await chartAs(human, B, 'edge', { source: some('s'.repeat(200)) });
  assert.equal((await chartOf(id)).source.length, 200);
  await rejects(human.token, 'set_chart_data', dataArgs(id, { source: some('t'.repeat(250)) }), 'source is 250 characters; the limit is 200');
  assert.equal((await chartOf(id)).source, 's'.repeat(200));
});

test('CH source: a data edit replaces sample for a human and needs a source from an agent', async () => {
  const human = await joined('human');
  const agent = await joined('agent');
  const B = await createBoardAs(human, named('ch-sample'));
  await shareWith(human, B, agent);
  // humans place library examples with source 'sample'
  const h = await chartAs(human, B, 'from-library-1', { type: 'pie', csv: PIE, source: some('sample') });
  const g = await chartAs(human, B, 'from-library-2', { type: 'pie', csv: PIE, source: some('sample') });
  assert.equal((await chartOf(h)).source, 'sample');
  // no data change (same csv), or options only: sample stays
  await ok(human.token, 'set_chart_data', dataArgs(h, { csv: some(PIE) }));
  await ok(human.token, 'set_chart_data', dataArgs(h, { options: some('{"donut":false}') }));
  assert.equal((await chartOf(h)).source, 'sample');
  // a real data edit: the human default replaces it
  await ok(human.token, 'set_chart_data', dataArgs(h, { type: some('timeseries'), csv: some(TS), options: some('{}') }));
  assert.equal((await chartOf(h)).source, `human:${human.name}`);
  // an undo may replay sample explicitly
  await ok(human.token, 'set_chart_data', dataArgs(h, { type: some('pie'), csv: some(PIE), source: some('sample') }));
  assert.equal((await chartOf(h)).source, 'sample');
  // an agent editing sample data must say where the new data came from
  await rejects(agent.token, 'set_chart_data', dataArgs(g, { type: some('timeseries'), csv: some(TS) }), SAMPLE_NEEDS_SOURCE);
  assert.equal((await chartOf(g)).type, 'pie');
  await ok(agent.token, 'set_chart_data', dataArgs(g, { options: some('{"donut":false}') }));
  assert.equal((await chartOf(g)).source, 'sample');
  await ok(agent.token, 'set_chart_data', dataArgs(g, { type: some('timeseries'), csv: some(TS), options: some('{}'), source: some('agent: k6 run @ 4b825dc') }));
  assert.deepEqual([(await chartOf(g)).type, (await chartOf(g)).source], ['timeseries', 'agent: k6 run @ 4b825dc']);
});

test('CH source: new numbers without a source credit the editing human, or need one from an agent', async () => {
  const alice = await joined('human', named('alice'));
  const bob = await joined('human', named('bob'));
  const agent = await joined('agent');
  const B = await createBoardAs(alice, named('ch-provenance'));
  await shareWith(alice, B, bob, agent);
  const AGENT_SRC = 'agent: npm run bench @ 4b825dc';
  // an agent's chart: an options-only edit keeps the agent source; new numbers become the human's
  const a = await chartAs(agent, B, 'bench', { source: some(AGENT_SRC) });
  await ok(alice.token, 'set_chart_data', dataArgs(a, { options: some(TS_AREA) }));
  assert.equal((await chartOf(a)).source, AGENT_SRC);
  await ok(alice.token, 'set_chart_data', dataArgs(a, { csv: some(TS2) }));
  assert.equal((await chartOf(a)).source, `human:${alice.name}`);
  // a person's data is credited to the person who edited it: another human's new numbers become theirs
  await ok(bob.token, 'set_chart_data', dataArgs(a, { csv: some(TS) }));
  assert.equal((await chartOf(a)).source, `human:${bob.name}`);
  // an agent must say where new numbers on a person's chart came from
  await rejects(agent.token, 'set_chart_data', dataArgs(a, { csv: some(TS2) }), HUMAN_DATA_NEEDS_SOURCE);
  await rejects(agent.token, 'set_chart_data', dataArgs(a, { type: some('bars'), options: some('{}') }), HUMAN_DATA_NEEDS_SOURCE);
  assert.deepEqual([(await chartOf(a)).csv, (await chartOf(a)).source], [TS, `human:${bob.name}`]);
  await ok(agent.token, 'set_chart_data', dataArgs(a, { options: some('{}') }));
  assert.equal((await chartOf(a)).source, `human:${bob.name}`);
  await ok(agent.token, 'set_chart_data', dataArgs(a, { csv: some(TS2), source: some(AGENT_SRC) }));
  assert.equal((await chartOf(a)).source, AGENT_SRC);
  // an agent's own edits keep its stored source
  await ok(agent.token, 'set_chart_data', dataArgs(a, { csv: some(TS) }));
  assert.equal((await chartOf(a)).source, AGENT_SRC);
});

test('CH source: a human keeps a source that still names them, and loses one that names someone else', async () => {
  const alice = await joined('human', named('alice'));
  const bob = await joined('human', named('bob'));
  const B = await createBoardAs(alice, named('ch-own-source'));
  await shareWith(alice, B, bob);
  // alice's own words after her name: her edit without a source keeps them
  const own = `human:${alice.name} — grafana export`;
  const a = await chartAs(alice, B, 'export', { source: some(own) });
  await ok(alice.token, 'set_chart_data', dataArgs(a, { csv: some(TS2) }));
  assert.equal((await chartOf(a)).source, own);
  // a free-form source belongs to nobody in particular: new numbers become the editor's
  const free = await chartAs(alice, B, 'free', { source: some('k6 on staging') });
  await ok(alice.token, 'set_chart_data', dataArgs(free, { csv: some(TS2) }));
  assert.equal((await chartOf(free)).source, `human:${alice.name}`);
  // another person's name that merely starts with this name is not this name
  const longer = await chartAs(alice, B, 'longer', { source: some(`human:${bob.name}x — export`) });
  await ok(bob.token, 'set_chart_data', dataArgs(longer, { csv: some(TS2) }));
  assert.equal((await chartOf(longer)).source, `human:${bob.name}`);
  // options only: no new numbers, so nothing changes
  await ok(bob.token, 'set_chart_data', dataArgs(a, { options: some(TS_AREA) }));
  assert.equal((await chartOf(a)).source, own);
});

test('CH createChart and setChartData move an agent\'s focus on its session board', async () => {
  const agent = await focusActor();
  const B = await sessionAs(agent, named('ch-focus'));
  const id = await chartAs(agent, B, 'bench', { source: some('agent: bench @ 4b825dc') });
  assert.deepEqual((await selectionOf(agent))?.nodeIds, [id]);
  const other = await nodeAs(agent, B, 'other');
  assert.deepEqual((await selectionOf(agent))?.nodeIds, [other]);
  await ok(agent.token, 'set_chart_data', dataArgs(id, { csv: some(TS2) }));
  assert.deepEqual((await selectionOf(agent))?.nodeIds, [id]);
});

// --- architecture boards ---------------------------------------------------------

test('CH charts are rejected on fact snapshots and allowed on branches', async () => {
  const user = await mint();
  const fact = await factBoard(user, 'ch-arch');
  const intent = await proposalBoard(user, fact, 'ch-arch-proposal');
  await rejects(user.token, 'create_chart', chartArgs(fact.boardId, 'on-fact'), ARCHITECTURE_CHART_RULE);
  assert.deepEqual(await chartsOn(fact.boardId), []);
  await ok(user.token, 'create_chart', chartArgs(intent.boardId, 'on-branch'));
  assert.equal((await chartsOn(intent.boardId)).length, 1);
  // a chart is presentation: the branch still submits
  await ok(user.token, 'submit_architecture_proposal', [intent.boardId]);
});

// --- the library -------------------------------------------------------------------

test('CH library: save, rename and delete belong to the owner; my_library shows only theirs', async () => {
  const a = await mint();
  const b = await mint();
  await ok(a.token, 'save_library_item', ['  latency pair  ', payload({ nodes: [{ key: 1 }] })]);
  await ok(b.token, 'save_library_item', ['b item', payload()]);
  const mine = await myLibrary(a);
  assert.equal(mine.length, 1);
  const [item] = mine;
  assert.deepEqual([item.name, item.orgId, item.payload], ['latency pair', '', payload({ nodes: [{ key: 1 }] })]);
  assert.equal(hexOf(item.owner), a.identity);
  assert.ok(micros(item.createdAt) > 0);
  assert.deepEqual((await myLibrary(b)).map(r => r.name), ['b item']);

  // another owner's id answers exactly like a missing one
  await rejects(b.token, 'rename_library_item', [item.id, 'stolen'], `library item ${item.id} does not exist`);
  await rejects(b.token, 'delete_library_item', [item.id], `library item ${item.id} does not exist`);
  assert.equal((await myLibrary(a))[0].name, 'latency pair');

  await ok(a.token, 'rename_library_item', [item.id, ' p99 pair ']);
  assert.equal((await myLibrary(a))[0].name, 'p99 pair');
  await ok(a.token, 'delete_library_item', [item.id]);
  assert.deepEqual(await myLibrary(a), []);
  assert.deepEqual(await sql(OWNER, `SELECT * FROM library_item WHERE id = ${item.id}`), []);
  await rejects(a.token, 'rename_library_item', [item.id, 'again'], `library item ${item.id} does not exist`);
  await rejects(a.token, 'delete_library_item', [item.id], `library item ${item.id} does not exist`);
  assert.equal((await myLibrary(b)).length, 1);
});

test('CH library: library_item is private; callers read it only through my_library', async () => {
  const a = await mint();
  await ok(a.token, 'save_library_item', ['private', payload()]);
  const r = await sqlRaw(a.token, 'SELECT * FROM library_item');
  assert.equal(r.status, 400, r.text);
  assert.ok(r.text.includes('library_item'), r.text);
  const all = await sql(OWNER, 'SELECT * FROM library_item');
  assert.ok(all.some(row => hexOf(row.owner) === a.identity && row.name === 'private'));
});

test('CH library: names are 1–80 characters after trimming', async () => {
  const a = await mint();
  await rejects(a.token, 'save_library_item', ['   ', payload()], 'library item name must be 1–80 characters; got 0');
  await rejects(a.token, 'save_library_item', ['n'.repeat(81), payload()], 'library item name must be 1–80 characters; got 81');
  await ok(a.token, 'save_library_item', [` ${'n'.repeat(80)} `, payload()]);
  const [item] = await myLibrary(a);
  assert.equal(item.name, 'n'.repeat(80));
  await rejects(a.token, 'rename_library_item', [item.id, ''], 'library item name must be 1–80 characters; got 0');
  await rejects(a.token, 'rename_library_item', [item.id, 'r'.repeat(81)], 'library item name must be 1–80 characters; got 81');
  assert.equal((await myLibrary(a))[0].name, 'n'.repeat(80));
});

test('CH library: the payload is a JSON object with version 1, at most 262144 bytes', async () => {
  const a = await mint();
  const shape = 'library item payload must be a JSON object with version 1';
  for (const bad of ['not json', '[]', 'null', '1', '"x"', '{}', '{"version":2}', '{"version":"1"}']) {
    await rejects(a.token, 'save_library_item', ['bad', bad], shape);
  }
  // bytes, not characters: 'é' is 2 bytes in UTF-8
  const wide = JSON.stringify({ version: 1, pad: 'é'.repeat(131072) });
  assert.ok(wide.length < 262144 && Buffer.byteLength(wide) > 262144);
  await rejects(a.token, 'save_library_item', ['wide', wide], `library item is ${Buffer.byteLength(wide)} bytes; the limit is 262144 bytes (256 KB)`);
  const head = JSON.stringify({ version: 1, pad: '' });
  const exact = JSON.stringify({ version: 1, pad: 'x'.repeat(262144 - Buffer.byteLength(head)) });
  assert.equal(Buffer.byteLength(exact), 262144);
  await ok(a.token, 'save_library_item', ['exact', exact]);
  assert.deepEqual((await myLibrary(a)).map(r => r.name), ['exact']);
});

test('CH library: an owner holds at most 200 items', async () => {
  const a = await mint();
  const b = await mint();
  // 200 saves at once: as a service account, which the write budget (RC-571) never limits
  await sql(OWNER, `INSERT INTO service_account (identity, label) VALUES (0x${a.identity}, 'library-cap')`);
  for (let start = 0; start < 200; start += 25) {
    await Promise.all(Array.from({ length: 25 }, (_v, i) => ok(a.token, 'save_library_item', [`item ${start + i}`, payload()])));
  }
  const held = await myLibrary(a);
  assert.equal(held.length, 200);
  await rejects(a.token, 'save_library_item', ['one more', payload()], 'your library holds 200 items; delete one before saving another');
  await ok(b.token, 'save_library_item', ['b is unaffected', payload()]);
  await ok(a.token, 'delete_library_item', [held[0].id]);
  await ok(a.token, 'save_library_item', ['after a delete', payload()]);
  assert.equal((await myLibrary(a)).length, 200);
});
