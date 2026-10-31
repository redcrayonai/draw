// Module integration suite for deletion (RC-690): deleting
// a board, or a history with its boards, leaves no row about them. The tables come
// from the published schema, so a board table added later fails `seeded` until
// the seed reaches it, and `swept` until deleteBoard removes it. Talks to an
// ISOLATED database over the HTTP API (the open board over a client connection);
// scripts/stdb-test.sh sets it up:
//
//   nix develop --command scripts/stdb-test.sh run scripts/verify-deletion-local.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { registerHooks } from 'node:module';

// Generated bindings use extensionless TS imports (as verify-board-scope-local.mjs).
registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); }
  catch (error) {
    if (specifier.startsWith('.')) return nextResolve(`${specifier}.ts`, context);
    throw error;
  }
} });
const { DbConnection } = await import('../client/src/module_bindings/index.ts');

const BASE = process.env.STDB_URL;
const DB = process.env.STDB_DB;
const OWNER = process.env.STDB_OWNER_TOKEN;
if (!BASE || !DB || !OWNER) {
  throw new Error('set STDB_URL, STDB_DB and STDB_OWNER_TOKEN (scripts/stdb-test.sh run does)');
}
if (DB === 'redcrayon') {
  throw new Error("refusing to run against the shared 'redcrayon' database; use scripts/stdb-test.sh");
}

const FACT_RULE = 'architecture boards must be managed through their history';
const HISTORY_OWNER_RULE = 'only the owner of a history can delete it';
const SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const NONE = { none: [] };
const some = v => ({ some: v });
const RUN = Date.now().toString(36);
const named = s => `${s}-${RUN}-${randomBytes(3).toString('hex')}`;
const code = () => randomBytes(32).toString('base64url');
const identity = who => ({ __identity__: `0x${who.identity}` });
const hexOf = v => String(Array.isArray(v) ? v[0] : v.__identity__).replace(/^0x/, '').toLowerCase();
const hashOf = line => createHash('sha256').update(line).digest('hex').slice(0, 32);

// A board table the seed cannot give a row for B, and why. An entry here is a
// table `swept` does not prove, so each one needs a test of its own.
const EXEMPT = {
  guest_claim_offer: 'offered only on a manual board (B has a session), and SQL cannot write its timestamp: see "a guest claim offer"',
  // Only a signed-in person sends marks, through the browser issuer that verify-marks-local.mjs serves alone.
  mark: 'sent only by a signed-in person: verify-marks-local.mjs "MK deleteBoard deletes marks, waiters, read cursors and node touches"',
  mark_read: 'written only for a signed-in person: same verify-marks-local.mjs test',
  mark_waiter: 'written only for an agent waiting on marks: same verify-marks-local.mjs test',
  node_touch: 'written with the marks scenario\'s agents: same verify-marks-local.mjs test',
  demo_reset: 'only the shared Demo board has one, and every suite reads Demo, so no suite deletes it',
  board_workspace: 'native ownership needs a signed-in human: verify-workspaces-local.mjs "deleting a native board sweeps ownership, direct/team grants and invitations" verifies cleanup',
  workspace_invite: 'created by a signed-in manager, with a server timestamp: the same native board deletion test verifies pending invitation cleanup',
  workspace_service_account: 'board_ids are retained policy references, not owned board data: verify-workspace-service-accounts-local.mjs "machine keys cannot delete histories" proves deleted boards stay inaccessible',
  workspace_api_key: 'retained key audit and scope records: the same machine deletion test proves stale references grant no access',
  incident: 'only an incident board has one (B is a session board): verify-incidents-local.mjs "IN deleting an incident board removes its incident, lifetime and window rows"',
  board_lifetime: 'written for incident boards: the same verify-incidents-local.mjs test',
};

// --- HTTP API (as verify-change-notes-local.mjs) -----------------------------

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

// --- the board tables, from the published schema -----------------------------

const snake = s => s.replace(/([A-Z])/g, '_$1').toLowerCase();

/** [table, column] for every table with a board_id column or a board_ids array (V10 describe, as check-wire-compat.mjs reads it). */
function boardTables() {
  const out = execFileSync('spacetime', ['describe', '--json', '--anonymous', '--no-config', '--server', BASE, DB], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const sections = Object.fromEntries(JSON.parse(out).sections.map(s => Object.entries(s)[0]));
  const names = new Map((sections.ExplicitNames?.entries ?? []).flatMap(e => (e.Table ? [[e.Table.source_name, e.Table.canonical_name]] : [])));
  return sections.Tables.flatMap(table => {
    const columns = sections.Typespace.types[table.product_type_ref].Product.elements.map(e => e.name.some);
    const column = columns.find(c => c === 'board_id' || c === 'board_ids');
    return column ? [[names.get(table.source_name) ?? snake(table.source_name), column]] : [];
  });
}

const TABLES = boardTables();

/** Rows of each board table that hold B, by table; empty tables left out. */
async function rowsFor(B) {
  const found = {};
  for (const [table, column] of TABLES) {
    const rows = column === 'board_ids'
      ? (await sql(OWNER, `SELECT * FROM ${table}`)).filter(r => r.boardIds.includes(B))
      : await sql(OWNER, `SELECT * FROM ${table} WHERE board_id = ${B}`);
    if (rows.length) found[table] = rows.length;
  }
  if ((await sql(OWNER, `SELECT * FROM board WHERE id = ${B}`)).length) found.board = 1;
  return found;
}

// --- fixtures ----------------------------------------------------------------

const nodeArgs = (B, label) => [B, label, '', 0, 0, 160, 80, 'ink', false, NONE, NONE, NONE, NONE, NONE, NONE, NONE];
const CSV = 'time,p99\n10:00,40\n10:05,44\n10:10,41\n';
// addThreat: boardId, anchorId, stage, severity, title, summary, cvss, package, fixedIn, flags, source, author
const threatArgs = (B, anchorId) => [B, anchorId, 'vulnerable', 'high', 'openssl RCE', 'Heap overflow in the TLS parser.', '9.8', 'openssl@3.0.1', '3.0.7', '["cve"]', '', 'agent'];

async function boardNamed(name) {
  const [{ id }] = await sql(OWNER, `SELECT id FROM board WHERE name = '${name}'`);
  return id;
}

async function nodeOn(who, B, label) {
  await ok(who.token, 'create_node', nodeArgs(B, label));
  return (await sql(OWNER, `SELECT * FROM node WHERE board_id = ${B}`)).find(n => n.label === label).id;
}

function connect(who) {
  return new Promise((resolve, reject) => {
    let connection;
    const timeout = setTimeout(() => { connection?.disconnect(); reject(new Error('connection timed out')); }, 10000);
    connection = DbConnection.builder().withUri(BASE).withDatabaseName(DB).withToken(who.token)
      .onConnect(conn => { clearTimeout(timeout); resolve(conn); })
      .onConnectError((_ctx, error) => { clearTimeout(timeout); reject(error); }).build();
  });
}

async function link(agent, person) {
  const c = code();
  await ok(agent.token, 'offer_agent_link', [c]);
  await ok(person.token, 'redeem_agent_link', [c]);
}

/** A history `who` owns, with one snapshot the service published. */
async function historyOf(who, label) {
  const name = named(label);
  await ok(who.token, 'create_architecture_history', [name, 'https://github.com/example/repo', JSON.stringify([{ ref: 'main', sha: SHA }]), name]);
  const [h] = await sql(OWNER, `SELECT * FROM architecture_history WHERE request_key = '${name}'`);
  const graph = {
    nodes: ['a', 'b'].map(key => ({ key, label: key, sublabel: '', kind: 'service' })),
    edges: [{ from: 'a', to: 'b', label: 'uses', relation: 'import', evidence: 'import' }],
    files: ['src/a.ts'],
  };
  await ok(svc.token, 'publish_architecture_snapshot', [h.id, 0, 'main', SHA, JSON.stringify(graph)]);
  const [v] = await sql(OWNER, `SELECT * FROM architecture_version WHERE history_id = ${h.id}`);
  return { H: h.id, fact: v.boardId };
}

let svc, owner, viewer, B, A, tab, peer, sets, embedChart;
before(async () => {
  svc = await mint();
  await sql(OWNER, `INSERT INTO service_account (identity, label) VALUES (0x${svc.identity}, 'deletion-tests')`);

  // Board B: a session board with a row in every board table.
  owner = await mint();
  viewer = await mint();
  const agent = await mint();
  await ok(owner.token, 'set_code_consent', [true]);
  const name = named('del-session');
  await ok(owner.token, 'start_session', [name, `/tmp/${name}`, SHA]);
  B = await boardNamed(name);
  await ok(owner.token, 'add_repo_files', [B, ['src/a.ts']]);
  const a = await nodeOn(owner, B, 'a');
  const b = await nodeOn(owner, B, 'b');
  await ok(owner.token, 'create_edge', [B, a, b, 'calls', 'source:src/a.ts:1', NONE, some('verify();'), NONE]);
  const [edge] = await sql(OWNER, `SELECT * FROM edge WHERE board_id = ${B}`);
  await ok(owner.token, 'add_code_ref', [B, 'node', a, 'src/a.ts', 'verify', 1, 2, SHA, 'function verify() {\n  return name;\n}', 'test']);
  const [ref] = await sql(OWNER, `SELECT * FROM code_ref WHERE board_id = ${B}`);
  await ok(owner.token, 'set_code_ref_hashes', [ref.id, `${hashOf('function verify() {')} ${hashOf('  return name;')}`]);
  await ok(owner.token, 'set_edge_evidence_code', [edge.id, hashOf('verify();'), NONE]);
  await ok(owner.token, 'set_session_remote', [B, 'git@github.com:example/repo.git', SHA, ['src/a.ts']]);
  await ok(owner.token, 'add_change_note', [B, a, 'migration', 'destructive', 'Migration 0042', 'Drops name.', ref.id,
    JSON.stringify([{ label: 'drop name', startLine: 1, endLine: 2 }]), '', JSON.stringify([{ table: 'customers', column: 'name' }]), '[]', 'agent']);
  await ok(owner.token, 'add_threat', threatArgs(B, a));
  await ok(owner.token, 'create_chart', [B, 'latency', '', 0, 0, 352, 224, 'timeseries', CSV, NONE, NONE]);
  [ { nodeId: embedChart } ] = await sql(OWNER, `SELECT node_id FROM chart WHERE board_id = ${B}`);
  await ok(owner.token, 'enable_chart_embed', [embedChart, randomBytes(16).toString('hex')]);
  await ok(owner.token, 'enable_board_embed', [B, randomBytes(16).toString('hex'), false, 0]);
  await ok(owner.token, 'set_node_icon', [a, 'queue']);
  await ok(owner.token, 'set_edge_weight', [edge.id, 'bold']);
  await ok(owner.token, 'anchor_chart', [embedChart, 'edge', edge.id]);
  await ok(owner.token, 'set_board_window', [B, Date.parse('2026-10-31T14:00:00Z'), Date.parse('2026-10-31T15:00:00Z')]);
  await ok(owner.token, 'set_node_hidden', [b, true, some('scratch')]);
  sets = (await sql(OWNER, `SELECT * FROM hide_set WHERE board_id = ${B}`)).map(s => s.id);
  await ok(owner.token, 'plan_route', [B, [a, b]]);
  await ok(owner.token, 'play_trace', [B, JSON.stringify([{ id: 's1', node: String(a), startMs: 0, durationMs: 5 }]), 'local', 'checkout']);
  const token = randomBytes(16).toString('hex');
  await ok(owner.token, 'set_link_share', [B, 'view', token]);
  await ok(viewer.token, 'open_shared_link', [token]);
  const org = named('del-org');
  await ok(svc.token, 'set_org_memberships', [identity(owner), [org], ['admin']]);
  await ok(owner.token, 'share_board_with_team', [B, org]);
  await link(agent, owner);
  await ok(owner.token, 'grant_agent_board', [B, identity(agent)]);
  // A canvas showing B beside board A: deleting B leaves it showing A.
  const other = named('del-other');
  await ok(owner.token, 'create_board', [other]);
  A = await boardNamed(other);
  tab = await connect(owner);
  await tab.reducers.openBoards({ boardIds: [BigInt(A), BigInt(B)] });
  // Presence lives while its connection does (every HTTP call ends one): the link visitor's, over a socket.
  peer = await connect(viewer);
  await peer.reducers.updateCursor({ boardId: BigInt(B), x: 1, y: 2 });
  await peer.reducers.setSelection({ boardId: BigInt(B), nodeIds: [BigInt(a)] });
  const [boardEmbed] = await sql(OWNER, `SELECT token FROM board_embed WHERE board_id = ${B}`);
  const [chartEmbed] = await sql(OWNER, `SELECT token FROM chart_embed WHERE board_id = ${B}`);
  await peer.reducers.openChartEmbed({ token: chartEmbed.token });
  await peer.reducers.openBoardEmbed({ token: boardEmbed.token });
  // No reducer puts these on a session board: each comes from a board-making reducer of its own.
  await sql(OWNER, `INSERT INTO board_creation (request_key, owner, board_id) VALUES ('${named('del-key')}', 0x${owner.identity}, ${B})`);
  await sql(OWNER, `INSERT INTO guest_board (identity, board_id) VALUES (0x${viewer.identity}, ${B})`);
  await sql(OWNER, `INSERT INTO public_board (board_id) VALUES (${B})`);
  await sql(OWNER, `INSERT INTO architecture_version (board_id, history_id, index, assertion_mode, base_board_id, ref, sha, status, request_key, reviewed_signature, implemented_board_id) VALUES (${B}, 0, 0, 'intent', 0, 'main', '${SHA}', 'draft', '${named('del-proposal')}', '', 0)`);
  // These private grant tables do not confer rights on an unscoped legacy board,
  // but deletion must still remove their rows. Native ownership/invite cleanup is
  // exercised with authenticated people in verify-workspaces-local.mjs.
  await sql(OWNER, `INSERT INTO workspace_board_grant (id, board_id, member, role) VALUES (0, ${B}, 0x${viewer.identity}, 'viewer')`);
  await sql(OWNER, `INSERT INTO workspace_team_grant (id, board_id, team_id, role) VALUES (0, ${B}, 0, 'viewer')`);
});

after(() => { tab?.disconnect(); peer?.disconnect(); });

test('the schema lists the board tables', () => {
  const names = TABLES.map(([table]) => table);
  for (const table of ['node', 'edge', 'code_ref_hash', 'edge_evidence_hash', 'session_remote', 'open_board']) assert.ok(names.includes(table), `${table} in ${names}`);
  for (const table of Object.keys(EXEMPT)) assert.ok(names.includes(table), `EXEMPT names a board table: ${table}`);
});

test('seeded: every board table holds a row for B', async () => {
  const found = await rowsFor(B);
  const missing = TABLES.map(([table]) => table).filter(table => !(table in EXEMPT) && !found[table]);
  assert.deepEqual(missing, [], 'seed these tables for B, or add them to EXEMPT with a reason');
  assert.ok(sets.length > 0 && (await sql(OWNER, `SELECT * FROM hide_set_member WHERE set_id = ${sets[0]}`)).length > 0);
});

test('swept: after delete_board no table holds a row for B', async () => {
  await ok(owner.token, 'delete_board', [B]);
  assert.deepEqual(await rowsFor(B), {});
  assert.deepEqual(await sql(OWNER, `SELECT * FROM chart_embed_visit WHERE node_id = ${embedChart}`), []);
  for (const set of sets) assert.deepEqual(await sql(OWNER, `SELECT * FROM hide_set_member WHERE set_id = ${set}`), []);
  // the canvas that showed B beside A still shows A
  const open = (await sql(OWNER, 'SELECT * FROM open_board')).filter(r => hexOf(r.identity) === owner.identity);
  assert.deepEqual(open.map(r => r.boardIds), [[A]]);
});

test('a guest claim offer goes with its board', async () => {
  const who = await mint();
  const name = named('del-guest');
  await ok(who.token, 'create_board', [name]);
  const G = await boardNamed(name);
  await ok(who.token, 'offer_guest_claim', [G, code()]);
  assert.equal((await rowsFor(G)).guest_claim_offer, 1);
  await ok(who.token, 'delete_board', [G]);
  assert.deepEqual(await rowsFor(G), {});
});

test('history: its owner deletes it with its versions and boards; another user is refused', async () => {
  const who = await mint(), stranger = await mint();
  const { H, fact } = await historyOf(who, 'del-history');
  await ok(who.token, 'create_architecture_proposal', [fact, named('del-proposal'), named('del-proposal-key')]);
  const boards = (await sql(OWNER, `SELECT * FROM architecture_version WHERE history_id = ${H}`)).map(v => v.boardId);
  assert.equal(boards.length, 2, 'a snapshot and a proposal');
  await rejects(who.token, 'delete_board', [fact], FACT_RULE);
  await rejects(stranger.token, 'delete_architecture_history', [H], HISTORY_OWNER_RULE);
  assert.equal((await sql(OWNER, `SELECT * FROM architecture_history WHERE id = ${H}`)).length, 1);
  await ok(who.token, 'delete_architecture_history', [H]);
  assert.deepEqual(await sql(OWNER, `SELECT * FROM architecture_history WHERE id = ${H}`), []);
  assert.deepEqual(await sql(OWNER, `SELECT * FROM architecture_version WHERE history_id = ${H}`), []);
  for (const board of boards) assert.deepEqual(await rowsFor(board), {}, `board ${board}`);
});

test("history: a person deletes the history their linked agent owns; the agent cannot delete the person's", async () => {
  const person = await mint(), agent = await mint();
  await link(agent, person);
  const theirs = await historyOf(agent, 'del-agent-history');
  const mine = await historyOf(person, 'del-person-history');
  await rejects(agent.token, 'delete_architecture_history', [mine.H], HISTORY_OWNER_RULE);
  await ok(person.token, 'delete_architecture_history', [theirs.H]);
  assert.deepEqual(await sql(OWNER, `SELECT * FROM architecture_history WHERE id = ${theirs.H}`), []);
  assert.deepEqual(await rowsFor(theirs.fact), {});
});
