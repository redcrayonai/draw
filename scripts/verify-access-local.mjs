// Run against the isolated server created by scripts/stdb-test.sh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

// Generated bindings use extensionless TS imports; use the real client SDK.
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
if (!BASE || !DB || !OWNER || DB === 'redcrayon') {
  throw new Error('set STDB_URL, STDB_DB and STDB_OWNER_TOKEN for an isolated test database');
}
const NONE = { none: [] };
const SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const name = prefix => `${prefix}-${randomBytes(8).toString('hex')}`;
const code = () => randomBytes(32).toString('base64url');
const identity = who => ({ __identity__: `0x${who.identity}` });
const nodeArgs = (B, label = 'private node') => [B, label, '', 0, 0, 160, 80, 'ink', false, ...Array(7).fill(NONE)];
const CSV = 'time,p99\n10:00,40\n10:05,44\n10:10,41\n';
const chartArgs = (B, label = 'private chart') => [B, label, '', 0, 0, 352, 224, 'timeseries', CSV, NONE, NONE];
const dataArgs = id => [id, NONE, { some: 'time,p99\n10:00,7\n10:05,8\n10:10,9\n' }, NONE, NONE];
async function mint() {
  const response = await fetch(`${BASE}/v1/identity`, { method: 'POST' });
  assert.equal(response.status, 200);
  return response.json();
}
async function call(who, reducer, args = []) {
  const response = await fetch(`${BASE}/v1/database/${DB}/call/${reducer}`, {
    method: 'POST', headers: { Authorization: `Bearer ${who.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  return { status: response.status, text: await response.text() };
}
async function ok(who, reducer, args) {
  const result = await call(who, reducer, args);
  assert.equal(result.status, 200, `${reducer}: ${result.text}`);
}
async function denied(who, reducer, args, message = 'not authorized') {
  const result = await call(who, reducer, args);
  assert.equal(result.status, 530, `${reducer} unexpectedly succeeded: ${result.text}`);
  assert.ok(result.text.includes(message), `${reducer}: ${result.text}`);
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
async function create(who, session = false) {
  await ok(who, 'set_code_consent', [true]); // its boards keep code snippets (RC-690)
  const label = name('access');
  await ok(who, session ? 'start_session' : 'create_board', session ? [label, `/tmp/${label}`, SHA] : [label]);
  return (await sql(operator, `SELECT * FROM board WHERE name = '${label}'`))[0].id;
}
async function chart(who, B) {
  const label = name('chart');
  await ok(who, 'create_chart', chartArgs(B, label));
  return (await sql(operator, `SELECT * FROM node WHERE board_id = ${B} AND label = '${label}'`))[0].id;
}
async function nodes(who, B) {
  await ok(who, 'create_node', nodeArgs(B, 'first'));
  await ok(who, 'create_node', nodeArgs(B, 'second'));
  return sql(operator, `SELECT * FROM node WHERE board_id = ${B}`);
}

async function connect(who, queries) {
  return new Promise((resolve, reject) => {
    let connection;
    const timeout = setTimeout(() => { connection?.disconnect(); reject(new Error('subscription timed out')); }, 10000);
    connection = DbConnection.builder().withUri(BASE).withDatabaseName(DB).withToken(who.token)
      .onConnect(conn => conn.subscriptionBuilder().onApplied(() => { clearTimeout(timeout); resolve(conn); })
        .onError((_ctx, error) => { clearTimeout(timeout); conn.disconnect(); reject(error); }).subscribe(queries))
      .onConnectError((_ctx, error) => { clearTimeout(timeout); reject(error); }).build();
  });
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test('live subscriptions enforce private reads and react to revocation', async () => {
  const owner = await mint(), stranger = await mint(), service = await mint();
  await sql(operator, `INSERT INTO service_account (identity, label) VALUES (0x${service.identity}, 'live-access-test')`);
  const B = await create(owner);
  await ok(owner, 'create_node', nodeArgs(B));
  await chart(owner, B);
  const queries = [...['board', 'node', 'edge', 'hide_set', 'hide_set_member', 'repo_file', 'cursor', 'selection', 'participant', 'session', 'session_route', 'route_event', 'code_ref', 'architecture_version', 'architecture_history', 'chart', 'change_note', 'threat', 'mark', 'mark_waiter', 'mark_read', 'board_people'].map(table => `SELECT * FROM visible_${table}`)];
  const mine = await connect(owner, queries), other = await connect(stranger, queries);
  try {
    assert.ok([...mine.db.visibleNode.iter()].some(row => row.boardId === BigInt(B)));
    assert.ok(![...other.db.visibleNode.iter()].some(row => row.boardId === BigInt(B)));
    assert.ok([...mine.db.visibleChart.iter()].some(row => row.boardId === BigInt(B)));
    assert.ok(![...other.db.visibleChart.iter()].some(row => row.boardId === BigInt(B)));
    const org = name('live-org');
    await ok(service, 'set_org_memberships', [identity(owner), [org], ['admin']]);
    await ok(service, 'set_org_memberships', [identity(stranger), [org], ['member']]);
    await ok(owner, 'share_board_with_team', [B, org]);
    await waitFor(() => [...other.db.visibleNode.iter()].some(row => row.boardId === BigInt(B)), 'sharing delivers nodes to existing subscriptions');
    await waitFor(() => [...other.db.visibleChart.iter()].some(row => row.boardId === BigInt(B)), 'sharing delivers charts to existing subscriptions');
    await ok(owner, 'unshare_board_from_team', [B, org]);
    await waitFor(() => ![...other.db.visibleNode.iter()].some(row => row.boardId === BigInt(B)), 'unsharing removes cached private nodes');
    await waitFor(() => ![...other.db.visibleChart.iter()].some(row => row.boardId === BigInt(B)), 'unsharing removes cached private charts');
  } finally { mine.disconnect(); other.disconnect(); }
});

test('private graph, hide sets and session data are unreadable to unrelated identities', async () => {
  const owner = await mint(), stranger = await mint();
  const B = await create(owner, true);
  const [a, b] = await nodes(owner, B);
  await ok(owner, 'create_edge', [B, a.id, b.id, 'uses', 'human:test', NONE, NONE, NONE]);
  await ok(owner, 'set_node_hidden', [a.id, true, { some: 'private set' }]);
  await ok(owner, 'add_repo_files', [B, ['secret.ts']]);
  await ok(owner, 'add_code_ref', [B, 'node', a.id, 'secret.ts', 'secret', 1, 1, SHA, 'function secret() {}', 'owner']);
  await ok(owner, 'plan_route', [B, [a.id, b.id]]);
  const set = (await sql(operator, `SELECT * FROM hide_set WHERE board_id = ${B}`))[0];
  await sql(operator, `INSERT INTO cursor (identity, board_id, x, y) VALUES (0x${owner.identity}, ${B}, 0, 0)`);
  for (const [table, key, value] of [
    ...['node', 'edge', 'hide_set', 'repo_file', 'session', 'session_route', 'route_event', 'code_ref'].map(t => [t, 'board_id', B]),
    ['board', 'id', B], ['hide_set_member', 'set_id', set.id],
  ]) {
    assert.ok((await sql(owner, `SELECT * FROM visible_${table} WHERE ${key} = ${value}`)).length > 0, `owner reads ${table}`);
    assert.deepEqual(await sql(stranger, `SELECT * FROM visible_${table} WHERE ${key} = ${value}`), [], `stranger cannot read ${table}`);
  }
  assert.deepEqual(await sql(stranger, `SELECT * FROM visible_cursor WHERE board_id = ${B}`), []);
  assert.equal((await sql(stranger, 'SELECT * FROM visible_participant')).some(row => (row.identity.__identity__ ?? row.identity[0]).replace(/^0x/, '') === owner.identity), false);
  for (const table of ['board', 'node', 'edge', 'hide_set', 'hide_set_member', 'repo_file', 'session', 'session_route', 'route_event', 'code_ref', 'cursor', 'selection', 'participant', 'architecture_history', 'architecture_version', 'chart', 'library_item']) {
    const response = await fetch(`${BASE}/v1/database/${DB}/sql`, { method: 'POST', headers: { Authorization: `Bearer ${stranger.token}` }, body: `SELECT * FROM ${table}` });
    assert.equal(response.status, 400, `${table} is private`);
  }
});

test('every ordinary graph and companion reducer rejects an unrelated identity', async () => {
  const owner = await mint(), stranger = await mint();
  const B = await create(owner, true), [a, b] = await nodes(owner, B);
  await ok(owner, 'create_edge', [B, a.id, b.id, 'uses', 'human:test', NONE, NONE, NONE]);
  await ok(owner, 'add_repo_files', [B, ['secret.ts']]);
  await ok(owner, 'add_code_ref', [B, 'node', a.id, 'secret.ts', 'secret', 1, 1, SHA, 'secret()', 'owner']);
  const edge = (await sql(operator, `SELECT * FROM edge WHERE board_id = ${B}`))[0];
  const ref = (await sql(operator, `SELECT * FROM code_ref WHERE board_id = ${B}`))[0];
  const c = await chart(owner, B);
  for (const [reducer, args] of [
    ['create_node', nodeArgs(B)], ['move_node', [a.id, 4, 4]], ['resize_node', [a.id, 4, 4, 160, 80]],
    ['update_node', [a.id, { some: 'stolen' }, ...Array(8).fill(NONE)]], ['set_node_doc', [a.id, 'stolen']],
    ['set_node_hidden', [a.id, true, NONE]], ['delete_node', [a.id]],
    ['create_edge', [B, a.id, b.id, 'stolen', 'human:test', NONE, NONE, NONE]],
    ['set_edge_hidden', [edge.id, true, NONE]], ['update_edge_style', [edge.id, { some: 'red' }, NONE]], ['set_edge_weight', [edge.id, 'bold']],
    ['update_edge_evidence', [edge.id, 'source:secret.ts:1', 'stale']], ['delete_edge', [edge.id]],
    ['add_repo_files', [B, ['stolen.ts']]], ['mark_checkpoint', [B, SHA, '{}']], ['plan_route', [B, [a.id]]],
    ['reroute', [B, [], [], [], 'stolen']], ['arrive_at_checkpoint', [B, a.id, 1, 0, SHA, '{}']],
    ['add_code_ref', [B, 'node', b.id, 'secret.ts', 'other', 1, 1, SHA, 'other()', 'stolen']],
    ['update_code_ref', [ref.id, 1, 1, SHA, 'secret()', 'stale']], ['update_code_ref_and_focus', [ref.id, 1, 1, SHA, 'secret()', 'stale']],
    ['remove_code_ref', [ref.id]], ['update_cursor', [B, 0, 0]], ['set_selection', [B, [a.id]]],
    ['create_chart', chartArgs(B)], ['set_chart_data', dataArgs(c)],
  ]) await denied(stranger, reducer, args);
});

test('create_chart answers a missing board exactly like a board the caller cannot read', async () => {
  const owner = await mint(), stranger = await mint();
  const B = await create(owner);
  const unreadable = await call(stranger, 'create_chart', chartArgs(B));
  const missing = await call(stranger, 'create_chart', chartArgs(Number.MAX_SAFE_INTEGER));
  assert.equal(unreadable.status, 530, unreadable.text);
  assert.ok(unreadable.text.includes('board is unavailable'), unreadable.text);
  assert.deepEqual(missing, unreadable);
});

test('guest creation is isolated, repeatable, and claims transfer existing content once', async () => {
  const guest = await mint(), second = await mint(), account = await mint(), thief = await mint();
  await ok(guest, 'ensure_guest_board', [NONE]);
  const [first] = await sql(guest, 'SELECT * FROM my_guest_board');
  assert.ok(first?.board_id);
  await ok(guest, 'ensure_guest_board', [NONE]);
  assert.deepEqual(await sql(guest, 'SELECT * FROM my_guest_board'), [first]);
  await ok(second, 'ensure_guest_board', [NONE]);
  assert.notEqual((await sql(second, 'SELECT * FROM my_guest_board'))[0].board_id, first.board_id);
  const B = first.board_id;
  await ok(guest, 'create_node', nodeArgs(B, 'kept drawing'));
  const capability = code();
  await denied(thief, 'offer_guest_claim', [B, capability], 'guest');
  await denied(guest, 'offer_guest_claim', [B, 'short'], 'code');
  await ok(guest, 'offer_guest_claim', [B, capability]);
  await denied(thief, 'claim_guest_board', [B, code()], 'invalid or expired');
  await ok(account, 'claim_guest_board', [B, capability]);
  await ok(account, 'claim_guest_board', [B, capability]);
  await denied(thief, 'claim_guest_board', [B, capability], 'invalid or expired');
  assert.equal((await sql(account, `SELECT * FROM visible_node WHERE board_id = ${B}`))[0].label, 'kept drawing');
  assert.deepEqual(await sql(guest, `SELECT * FROM visible_node WHERE board_id = ${B}`), []);
  assert.deepEqual(await sql(guest, 'SELECT * FROM my_guest_board'), []);
  await denied(guest, 'create_node', nodeArgs(B));
  await ok(guest, 'ensure_guest_board', [NONE]);
  assert.notEqual((await sql(guest, 'SELECT * FROM my_guest_board'))[0].board_id, B);
});

test('fresh guest boards preserve previous drawings and claim offers are scoped and replaceable', async () => {
  const guest = await mint(), account = await mint();
  await ok(guest, 'ensure_guest_board', [NONE]);
  const old = (await sql(guest, 'SELECT * FROM my_guest_board'))[0].board_id;
  await ok(guest, 'create_node', nodeArgs(old, 'previous drawing'));
  await ok(guest, 'ensure_guest_board', [{ some: true }]);
  const B = (await sql(guest, 'SELECT * FROM my_guest_board'))[0].board_id;
  assert.notEqual(B, old);
  assert.equal((await sql(guest, `SELECT * FROM visible_node WHERE board_id = ${old}`))[0].label, 'previous drawing');
  const first = code(), next = code();
  await ok(guest, 'offer_guest_claim', [B, first]);
  await ok(guest, 'offer_guest_claim', [B, next]);
  await denied(account, 'claim_guest_board', [B, first], 'invalid or expired');
  await denied(account, 'claim_guest_board', [old, next], 'invalid or expired');
  await denied(guest, 'claim_guest_board', [B, next], 'different account');
  const [offer] = await sql(operator, `SELECT * FROM guest_claim_offer WHERE board_id = ${B}`);
  const expiry = offer.expires_at.__timestamp_micros_since_unix_epoch__ ?? offer.expires_at[0];
  assert.ok(Math.abs(Number(expiry) - Date.now() * 1000 - 30 * 60 * 1e6) < 2e6, 'claim expiry is 30 minutes');
  await ok(account, 'claim_guest_board', [B, next]);
  assert.deepEqual(await sql(operator, `SELECT * FROM guest_claim_offer WHERE board_id = ${B}`), []);
});

test('claiming an older owned guest drawing preserves the newer guest home', async () => {
  const guest = await mint(), account = await mint();
  await ok(guest, 'ensure_guest_board', [NONE]);
  const A = (await sql(guest, 'SELECT * FROM my_guest_board'))[0].board_id;
  await ok(guest, 'create_node', nodeArgs(A, 'older drawing'));
  await ok(guest, 'ensure_guest_board', [{ some: true }]);
  const B = (await sql(guest, 'SELECT * FROM my_guest_board'))[0].board_id;
  await ok(guest, 'create_node', nodeArgs(B, 'newer drawing'));
  const capability = code();
  await ok(guest, 'offer_guest_claim', [A, capability]);
  await ok(account, 'claim_guest_board', [A, capability]);
  await ok(account, 'claim_guest_board', [A, capability]);
  assert.equal((await sql(account, `SELECT * FROM my_boards WHERE board_id = ${A}`))[0].access, 'owner');
  assert.equal((await sql(account, `SELECT * FROM visible_node WHERE board_id = ${A}`))[0].label, 'older drawing');
  assert.deepEqual(await sql(guest, `SELECT * FROM visible_node WHERE board_id = ${A}`), []);
  await denied(guest, 'create_node', nodeArgs(A));
  assert.deepEqual(await sql(guest, 'SELECT * FROM my_guest_board'), [{ board_id: B }]);
  assert.equal((await sql(guest, `SELECT * FROM my_boards WHERE board_id = ${B}`))[0].access, 'owner');
  await ok(guest, 'create_node', nodeArgs(B));
  assert.deepEqual(await sql(account, `SELECT * FROM visible_node WHERE board_id = ${B}`), []);
});

test('claim offers accept owned manual boards and reject sessions and public examples', async () => {
  const owner = await mint(), account = await mint();
  const manual = await create(owner), session = await create(owner, true);
  const capability = code();
  await ok(owner, 'offer_guest_claim', [manual, capability]);
  await ok(account, 'claim_guest_board', [manual, capability]);
  assert.equal((await sql(account, `SELECT * FROM my_boards WHERE board_id = ${manual}`))[0].access, 'owner');
  await denied(owner, 'offer_guest_claim', [session, code()], 'ordinary manual');
  // a public example, like Demo (whose owner is whichever service seeded it first)
  const example = await create(owner);
  await sql(operator, `INSERT INTO public_board (board_id) VALUES (${example})`);
  await denied(owner, 'offer_guest_claim', [example, code()], 'ordinary manual');
});

test('team membership and services retain access and revocation removes it', async () => {
  const owner = await mint(), member = await mint(), service = await mint();
  await sql(operator, `INSERT INTO service_account (identity, label) VALUES (0x${service.identity}, 'access-test')`);
  const B = await create(owner);
  await ok(owner, 'create_node', nodeArgs(B));
  const org = name('org');
  await ok(service, 'set_org_memberships', [identity(owner), [org], ['admin']]);
  await ok(service, 'set_org_memberships', [identity(member), [org], ['member']]);
  await ok(owner, 'share_board_with_team', [B, org]);
  assert.equal((await sql(member, `SELECT * FROM visible_node WHERE board_id = ${B}`)).length, 1);
  await ok(member, 'create_node', nodeArgs(B));
  const c = await chart(member, B);
  await ok(member, 'set_chart_data', dataArgs(c));
  await denied(member, 'delete_board', [B], 'owner');
  await ok(owner, 'unshare_board_from_team', [B, org]);
  assert.deepEqual(await sql(member, `SELECT * FROM visible_node WHERE board_id = ${B}`), []);
  await denied(member, 'create_node', nodeArgs(B));
  await denied(member, 'create_chart', chartArgs(B));
  await denied(member, 'set_chart_data', dataArgs(c));
  await ok(service, 'create_node', nodeArgs(B));
  assert.equal((await sql(service, `SELECT * FROM visible_node WHERE board_id = ${B}`)).length, 4);
});

const hex = cell => (cell.__identity__ ?? cell[0]).replace(/^0x/, '');
async function linkAgent(agent, owner) {
  const link = code();
  await ok(agent, 'offer_agent_link', [link]);
  await ok(owner, 'redeem_agent_link', [link]);
}

test('a linked agent reaches only the boards its owner shares with it', async () => {
  const owner = await mint(), agent = await mint(), second = await mint(), stranger = await mint();
  const B = await create(owner), C = await create(owner), own = await create(agent);
  await ok(owner, 'create_node', nodeArgs(B));
  await ok(owner, 'create_node', nodeArgs(C));
  await linkAgent(agent, owner);
  await linkAgent(second, owner);
  // a link alone grants nothing
  assert.deepEqual(await sql(agent, `SELECT * FROM visible_node WHERE board_id = ${B}`), []);
  await denied(agent, 'create_node', nodeArgs(B));
  await denied(agent, 'create_chart', chartArgs(B));
  // who may grant, and to whom
  await denied(stranger, 'grant_agent_board', [B, identity(agent)], 'owner');
  await denied(agent, 'grant_agent_board', [B, identity(agent)], 'owner');
  await denied(agent, 'grant_agent_board', [own, identity(agent)], 'owner'); // its board is its owner's since the link
  await denied(owner, 'grant_agent_board', [B, identity(stranger)], 'not linked');
  // a grant gives read and edit on that board only, and only to that agent
  await ok(owner, 'grant_agent_board', [B, identity(agent)]);
  await ok(owner, 'grant_agent_board', [B, identity(agent)]);
  assert.equal((await sql(operator, `SELECT * FROM agent_grant WHERE board_id = ${B}`)).length, 1);
  await ok(agent, 'create_node', nodeArgs(B));
  assert.equal((await sql(agent, `SELECT * FROM visible_node WHERE board_id = ${B}`)).length, 2);
  const c = await chart(agent, B);
  await ok(agent, 'set_chart_data', dataArgs(c));
  assert.deepEqual(await sql(agent, `SELECT * FROM visible_node WHERE board_id = ${C}`), []);
  await denied(agent, 'create_node', nodeArgs(C));
  await denied(agent, 'create_chart', chartArgs(C));
  assert.deepEqual(await sql(second, `SELECT * FROM visible_node WHERE board_id = ${B}`), []);
  await denied(second, 'create_node', nodeArgs(B));
  // a grant is not ownership
  for (const [reducer, args] of [
    ['rename_board', [B, 'taken']],
    ['delete_board', [B]],
    ['share_board_with_team', [B, 'org']],
    ['revoke_agent_board', [B, identity(agent)]],
  ]) await denied(agent, reducer, args, 'owner');
  // the view shows the grant to the owner and to the agent, to nobody else
  const pairs = rows => rows.map(r => [r.board_id, hex(r.agent)]).sort((a, b) => Number(a[0]) - Number(b[0]));
  // `own` is there too: the link moved it to the owner and left the agent a grant
  assert.deepEqual(pairs(await sql(owner, 'SELECT * FROM my_agent_grants')), [[B, agent.identity], [own, agent.identity]]);
  assert.deepEqual(pairs(await sql(agent, 'SELECT * FROM my_agent_grants')), [[B, agent.identity], [own, agent.identity]]);
  assert.deepEqual(await sql(second, 'SELECT * FROM my_agent_grants'), []);
  assert.deepEqual(await sql(stranger, 'SELECT * FROM my_agent_grants'), []);
  // the owner reads and edits what the agent made before the link, as its owner now
  await ok(owner, 'create_node', nodeArgs(own));
  assert.equal((await sql(owner, `SELECT * FROM my_boards WHERE board_id = ${own}`))[0].access, 'owner');
  await chart(owner, own);
  // a grant works only while the link exists, even if an operator removes the link by SQL
  await sql(operator, `DELETE FROM agent_link WHERE agent = 0x${agent.identity}`);
  assert.deepEqual(await sql(agent, `SELECT * FROM visible_node WHERE board_id = ${B}`), []);
  await denied(agent, 'create_node', nodeArgs(B));
  await denied(agent, 'create_chart', chartArgs(B));
  await denied(agent, 'set_chart_data', dataArgs(c));
  await linkAgent(agent, owner);
  // revoke: only the owner, twice is fine, and access ends
  await ok(owner, 'grant_agent_board', [B, identity(agent)]);
  await denied(stranger, 'revoke_agent_board', [B, identity(agent)], 'owner');
  await ok(owner, 'revoke_agent_board', [B, identity(agent)]);
  await ok(owner, 'revoke_agent_board', [B, identity(agent)]);
  assert.deepEqual(await sql(agent, `SELECT * FROM visible_node WHERE board_id = ${B}`), []);
  await denied(agent, 'create_node', nodeArgs(B));
  await denied(agent, 'create_chart', chartArgs(B));
  await denied(agent, 'set_chart_data', dataArgs(c));
});

test("a linked agent's boards are its owner's, and stay the owner's when the agent leaves", async () => {
  const owner = await mint(), agent = await mint(), second = await mint();
  const access = async (who, board) => (await sql(who, `SELECT * FROM my_boards WHERE board_id = ${board}`))[0]?.access;
  // made before the link: the agent's until it is linked, then the owner's
  const early = await create(agent, true);
  assert.equal(await access(agent, early), 'owner');
  await linkAgent(agent, owner);
  assert.equal(await access(owner, early), 'owner');
  assert.equal(await access(agent, early), 'grant');
  // made after the link: the owner's from the start, edited by the agent through a grant
  const S = await create(agent, true), M = await create(agent);
  for (const board of [S, M]) {
    assert.equal(await access(owner, board), 'owner');
    assert.equal(await access(agent, board), 'grant');
  }
  await ok(agent, 'create_node', nodeArgs(S));
  // so is a guest board it asks for, and asking again keeps that one
  await ok(agent, 'ensure_guest_board', [NONE]);
  const [guest] = await sql(agent, 'SELECT * FROM my_guest_board');
  assert.equal(await access(owner, guest.board_id), 'owner');
  await ok(agent, 'ensure_guest_board', [NONE]);
  assert.deepEqual(await sql(agent, 'SELECT * FROM my_guest_board'), [guest]);
  // start_session re-adopts the session board it edits instead of making another
  const label = (await sql(operator, `SELECT * FROM board WHERE id = ${S}`))[0].name;
  await ok(agent, 'start_session', [label, `/tmp/${label}`, SHA]);
  assert.equal((await sql(operator, `SELECT * FROM board WHERE name = '${label}'`)).length, 1);
  // owner actions are the owner's, not the agent's
  await denied(agent, 'rename_board', [S, 'taken'], 'owner');
  await denied(agent, 'delete_board', [M], 'owner');
  await ok(owner, 'rename_board', [S, name('renamed')]);
  await ok(owner, 'delete_board', [M]);
  // unlinking removes the agent, never the owner's boards
  await ok(owner, 'unlink_agent', [identity(agent)]);
  for (const board of [early, S, guest.board_id]) {
    assert.equal(await access(owner, board), 'owner');
    assert.equal(await access(agent, board), undefined);
  }
  assert.deepEqual(await sql(agent, 'SELECT * FROM my_guest_board'), []);
  await denied(agent, 'create_node', nodeArgs(S));
  // and a link to someone else takes none of them
  await linkAgent(agent, second);
  assert.equal(await access(second, S), undefined);
  assert.equal(await access(owner, S), 'owner');
});

test('agent grants end with an unlink, a new owner, a deleted board or a claim', async () => {
  const owner = await mint(), second = await mint(), agent = await mint();
  const grantsOn = board => sql(operator, `SELECT * FROM agent_grant WHERE board_id = ${board}`);
  const A = await create(owner), B = await create(owner), D = await create(owner);
  const grantAll = async boards => { for (const board of boards) await ok(owner, 'grant_agent_board', [board, identity(agent)]); };
  // unlink removes every grant, and a new link starts with none
  await linkAgent(agent, owner);
  await grantAll([A, B, D]);
  await ok(owner, 'unlink_agent', [identity(agent)]);
  for (const board of [A, B, D]) assert.deepEqual(await grantsOn(board), []);
  await linkAgent(agent, owner);
  assert.deepEqual(await sql(agent, `SELECT * FROM visible_board WHERE id = ${A}`), []);
  // a link that moves to a new owner takes the old owner's grants with it
  await grantAll([A]);
  await linkAgent(agent, second);
  assert.deepEqual(await grantsOn(A), []);
  assert.deepEqual(await sql(agent, `SELECT * FROM visible_board WHERE id = ${A}`), []);
  // a link an operator removed by SQL leaves no grant to revive on the next link
  await ok(second, 'unlink_agent', [identity(agent)]);
  await linkAgent(agent, owner);
  await grantAll([B]);
  await sql(operator, `DELETE FROM agent_link WHERE agent = 0x${agent.identity}`);
  await linkAgent(agent, owner);
  assert.deepEqual(await grantsOn(B), []);
  assert.deepEqual(await sql(agent, `SELECT * FROM visible_board WHERE id = ${B}`), []);
  // deleting the board removes its grants
  await grantAll([D]);
  await ok(owner, 'delete_board', [D]);
  assert.deepEqual(await grantsOn(D), []);
  // a grant also needs its owner to still own the board (an operator removed the owner grant by SQL)
  const E = await create(owner);
  await grantAll([E]);
  await ok(agent, 'create_node', nodeArgs(E));
  await sql(operator, `DELETE FROM board_grant WHERE board_id = ${E}`);
  assert.deepEqual(await sql(agent, `SELECT * FROM visible_board WHERE id = ${E}`), []);
  await denied(agent, 'create_node', nodeArgs(E));
  await denied(agent, 'submit_architecture_proposal', [E], 'shared this board');
  // a claimed guest board loses the previous owner's agent
  const guest = await mint(), account = await mint(), guestAgent = await mint();
  const G = await create(guest);
  await linkAgent(guestAgent, guest);
  await ok(guest, 'grant_agent_board', [G, identity(guestAgent)]);
  const capability = code();
  await ok(guest, 'offer_guest_claim', [G, capability]);
  await ok(account, 'claim_guest_board', [G, capability]);
  assert.deepEqual(await grantsOn(G), []);
  assert.deepEqual(await sql(guestAgent, `SELECT * FROM visible_board WHERE id = ${G}`), []);
});

test('participants are listed to people who share a board with them, and to nobody else', async () => {
  const owner = await mint(), member = await mint(), stranger = await mint(), service = await mint();
  await sql(operator, `INSERT INTO service_account (identity, label) VALUES (0x${service.identity}, 'participant-test')`);
  const B = await create(owner);
  const org = name('participants');
  await ok(service, 'set_org_memberships', [identity(owner), [org], ['admin']]);
  await ok(service, 'set_org_memberships', [identity(member), [org], ['member']]);
  await ok(owner, 'share_board_with_team', [B, org]);
  await ok(owner, 'join_board', ['Olive Owner', 'human']);
  await ok(member, 'join_board', ['Mo Member', 'human']);
  await ok(stranger, 'join_board', ['Sam Stranger', 'human']);
  // a cursor lives only while its connection does, and every HTTP call ends its caller's connection,
  // so each look re-seats the two cursors by SQL first
  const seat = async () => {
    for (const who of [owner, member]) {
      await sql(operator, `DELETE FROM cursor WHERE identity = 0x${who.identity}`);
      await sql(operator, `INSERT INTO cursor (identity, board_id, x, y) VALUES (0x${who.identity}, ${B}, 0, 0)`);
    }
  };
  const seenBy = async person => { await seat(); return (await sql(person, 'SELECT * FROM visible_participant')).map(row => row.display_name).sort(); };
  assert.deepEqual(await seenBy(owner), ['Mo Member', 'Olive Owner']);
  assert.deepEqual(await seenBy(member), ['Mo Member', 'Olive Owner']);
  assert.deepEqual(await seenBy(stranger), ['Sam Stranger']);
  const everyone = await seenBy(service);
  for (const display of ['Mo Member', 'Olive Owner', 'Sam Stranger']) assert.ok(everyone.includes(display), `the service sees ${display}`);
});

test('a selection holds at most as many ids as its board has nodes: any reader may set one, and every viewer receives it', async () => {
  const owner = await mint(), reader = await mint();
  const B = await create(owner), [a, b] = await nodes(owner, B);
  await sql(operator, `INSERT INTO public_board (board_id) VALUES (${B})`);
  const rule = 'a selection holds at most as many nodes as its board';
  await ok(reader, 'set_selection', [B, [a.id, b.id]]); // select all
  await ok(reader, 'set_selection', [B, []]);
  await denied(reader, 'set_selection', [B, [a.id, b.id, a.id]], rule);
  await denied(reader, 'set_selection', [B, Array.from({ length: 50000 }, (_, i) => i + 1)], rule);
});

test('delete_node removes the node with its edges, their code refs and hide memberships, and nothing else', async () => {
  const owner = await mint();
  const B = await create(owner, true), C = await create(owner, true);
  const [a, b] = await nodes(owner, B), [c, d] = await nodes(owner, C);
  await ok(owner, 'create_edge', [B, a.id, b.id, 'uses', 'human:test', NONE, NONE, NONE]);
  await ok(owner, 'create_edge', [B, b.id, a.id, 'calls back', 'human:test', NONE, NONE, NONE]); // ends at the deleted node
  await ok(owner, 'create_edge', [C, c.id, d.id, 'uses', 'human:test', NONE, NONE, NONE]);
  const [edge] = await sql(operator, `SELECT * FROM edge WHERE board_id = ${B} AND label = 'uses'`);
  await ok(owner, 'set_edge_hidden', [edge.id, true, { some: 'plumbing' }]);
  await ok(owner, 'add_repo_files', [B, ['a.ts']]);
  await ok(owner, 'add_code_ref', [B, 'edge', edge.id, 'a.ts', 'link', 1, 1, SHA, 'link()', 'owner']);
  await ok(owner, 'delete_node', [a.id]);
  assert.deepEqual(await sql(operator, `SELECT * FROM edge WHERE board_id = ${B}`), []);
  assert.deepEqual(await sql(operator, `SELECT * FROM code_ref WHERE board_id = ${B}`), []);
  assert.deepEqual(await sql(operator, `SELECT * FROM hide_set_member WHERE target_kind = 'edge' AND target_id = ${edge.id}`), []);
  assert.equal((await sql(operator, `SELECT * FROM node WHERE board_id = ${B}`)).length, 1);
  assert.equal((await sql(operator, `SELECT * FROM edge WHERE board_id = ${C}`)).length, 1);
  assert.equal((await sql(operator, `SELECT * FROM node WHERE board_id = ${C}`)).length, 2);
});

test('edge style (RC-688): colour, line and weight are stored, read by every reader, refused to view-link visitors and strangers, and go with their edge', async () => {
  const owner = await mint(), viewer = await mint(), stranger = await mint();
  const B = await create(owner), [a, b] = await nodes(owner, B);
  await ok(owner, 'create_edge', [B, a.id, b.id, 'uses', 'human:test', NONE, NONE, NONE]);
  await ok(owner, 'create_edge', [B, b.id, a.id, 'calls back', 'human:test', NONE, NONE, NONE]);
  const edgeOf = async label => (await sql(operator, `SELECT * FROM edge WHERE board_id = ${B} AND label = '${label}'`))[0];
  const weights = who => sql(who, `SELECT * FROM visible_edge_weight WHERE board_id = ${B}`);
  const e = await edgeOf('uses');
  // a new edge has the default style and no weight row
  assert.deepEqual([e.color, e.stroke_style], ['', 'solid']);
  assert.deepEqual(await weights(owner), []);
  await ok(owner, 'update_edge_style', [e.id, { some: 'blue' }, { some: 'dotted' }]);
  await ok(owner, 'set_edge_weight', [e.id, 'bold']);
  const styled = await edgeOf('uses');
  assert.deepEqual([styled.color, styled.stroke_style], ['blue', 'dotted']);
  assert.deepEqual(await weights(owner), [{ edge_id: e.id, board_id: B, weight: 'bold' }]);
  // the allowlists name what is allowed; a node border still cannot be dotted
  await denied(owner, 'set_edge_weight', [e.id, 'heavy'], "weight 'heavy' is not allowed; must be one of: regular, medium, bold");
  await denied(owner, 'update_edge_style', [e.id, NONE, { some: 'wavy' }], "strokeStyle 'wavy' is not allowed; must be one of: solid, dashed, dotted");
  await denied(owner, 'update_node', [a.id, ...Array(7).fill(NONE), { some: 'dotted' }, NONE], "strokeStyle 'dotted' is not allowed; must be one of: solid, dashed");
  await denied(owner, 'set_edge_weight', [Number.MAX_SAFE_INTEGER, 'bold'], 'does not exist');
  // a view link reads the style and cannot change it (verify-issuers-local.mjs: an edit link can)
  const token = randomBytes(16).toString('hex');
  await ok(owner, 'set_link_share', [B, 'view', token]);
  await ok(viewer, 'open_shared_link', [token]);
  assert.deepEqual(await weights(viewer), [{ edge_id: e.id, board_id: B, weight: 'bold' }]);
  assert.equal((await sql(viewer, `SELECT * FROM visible_edge WHERE board_id = ${B}`)).find(r => r.id === e.id)?.stroke_style, 'dotted');
  await denied(viewer, 'set_edge_weight', [e.id, 'regular'], 'read only');
  await denied(viewer, 'update_edge_style', [e.id, { some: 'red' }, NONE], 'read only');
  await denied(stranger, 'set_edge_weight', [e.id, 'regular']);
  assert.deepEqual(await weights(stranger), []);
  // back to regular is no row; setting the same weight twice is one row
  await ok(owner, 'set_edge_weight', [e.id, 'regular']);
  await ok(owner, 'set_edge_weight', [e.id, 'regular']);
  assert.deepEqual(await weights(owner), []);
  await ok(owner, 'set_edge_weight', [e.id, 'bold']);
  await ok(owner, 'set_edge_weight', [e.id, 'bold']);
  assert.equal((await weights(owner)).length, 1);
  // delete_edge, delete_node and delete_board each take the weight with the edge
  const back = await edgeOf('calls back');
  await ok(owner, 'set_edge_weight', [back.id, 'medium']);
  await ok(owner, 'delete_edge', [e.id]);
  assert.deepEqual(await sql(operator, `SELECT * FROM edge_weight WHERE edge_id = ${e.id}`), []);
  await ok(owner, 'delete_node', [a.id]);
  assert.deepEqual(await sql(operator, `SELECT * FROM edge_weight WHERE board_id = ${B}`), []);
  const C = await create(owner), [c, d] = await nodes(owner, C);
  await ok(owner, 'create_edge', [C, c.id, d.id, 'uses', 'human:test', NONE, NONE, NONE]);
  const [onC] = await sql(operator, `SELECT * FROM edge WHERE board_id = ${C}`);
  await ok(owner, 'set_edge_weight', [onC.id, 'bold']);
  await ok(owner, 'delete_board', [C]);
  assert.deepEqual(await sql(operator, `SELECT * FROM edge_weight WHERE board_id = ${C}`), []);
});

test('text the app itself stored can always be stored again, so undo can restore any existing row', async () => {
  const owner = await mint();
  const B = await create(owner);
  const long = n => 'x'.repeat(n);
  // undo of a delete re-creates a node and its edges with the text they were saved with, and the canvas
  // puts no limit on that text: imports save paths of up to 4000 characters, notes hold prose
  await ok(owner, 'create_node', [B, long(5000), long(5000), 0, 0, 160, 80, 'ink', false, NONE, { some: long(30000) }, NONE, NONE, NONE, NONE, NONE]);
  await ok(owner, 'create_node', nodeArgs(B, 'second'));
  const [first, second] = await sql(operator, `SELECT * FROM node WHERE board_id = ${B}`);
  await ok(owner, 'update_node', [first.id, { some: long(6000) }, { some: long(6000) }, ...Array(7).fill(NONE)]);
  await ok(owner, 'set_node_doc', [first.id, long(40000)]);
  await ok(owner, 'create_edge', [B, first.id, second.id, long(5000), 'human:test', NONE, NONE, NONE]);
  await ok(owner, 'set_node_hidden', [first.id, true, { some: long(300) }]);
});

test('a code ref symbol is at most 200 characters; its path is any path the import registered', async () => {
  const owner = await mint();
  const B = await create(owner, true);
  const [a] = await nodes(owner, B);
  const path = `${'dir/'.repeat(375)}deep.ts`; // 1507 characters: imports register every path git lists
  await ok(owner, 'add_repo_files', [B, [path]]);
  const symbol = n => 's'.repeat(n);
  await denied(owner, 'add_code_ref', [B, 'node', a.id, path, symbol(201), 1, 1, SHA, symbol(201), 'owner'], 'size rule: symbol is 201 characters; the limit is 200');
  await ok(owner, 'add_code_ref', [B, 'node', a.id, path, symbol(200), 1, 1, SHA, symbol(200), 'owner']);
});

test('a display name is shortened, not refused, so a long sign-in name cannot stop the canvas starting', async () => {
  const owner = await mint();
  await ok(owner, 'join_board', ['n'.repeat(150), 'human']);
  const [me] = await sql(operator, `SELECT * FROM participant WHERE identity = 0x${owner.identity}`);
  assert.equal(me.display_name.length, 100);
  await ok(owner, 'join_board', ['😀'.repeat(60), 'human']); // 60 code points, 120 UTF-16 units: cut on a code point, never inside one
  const [emoji] = await sql(operator, `SELECT * FROM participant WHERE identity = 0x${owner.identity}`);
  assert.equal([...emoji.display_name].length, 60);
});

test('delete_node still cascades an edge from before RC-530 that sits on another board', async () => {
  const owner = await mint(), other = await mint();
  const A = await create(owner, true), B = await create(owner, true), C = await create(other);
  const [a1, a2] = await nodes(owner, A);
  const [b1] = await nodes(owner, B);
  // before RC-530 create_edge let an edge sit on one board and end on a node of another; only SQL can write one now
  const legacy = (board, from, to, label) => sql(operator, `INSERT INTO edge (id, board_id, from_node, to_node, label, evidence, hidden, imported, color, stroke_style, evidence_snippet, evidence_status, relation, latency_ms, latency_source) VALUES (0, ${board}, ${from}, ${to}, '${label}', 'human:old', false, false, '', 'solid', '', '', '', -1, '')`);
  await legacy(B, a1.id, b1.id, 'legacy-on-b');
  const [edge] = await sql(operator, `SELECT * FROM edge WHERE label = 'legacy-on-b'`);
  await ok(owner, 'set_edge_hidden', [edge.id, true, { some: 'plumbing' }]);
  await ok(owner, 'add_repo_files', [B, ['a.ts']]);
  await ok(owner, 'add_code_ref', [B, 'edge', edge.id, 'a.ts', 'link', 1, 1, SHA, 'link()', 'owner']);
  // an edge on a board the caller cannot write blocks the delete, as before
  const [c1] = await nodes(other, C);
  await legacy(C, a2.id, c1.id, 'legacy-on-c');
  await denied(owner, 'delete_node', [a2.id]);
  assert.equal((await sql(operator, `SELECT * FROM node WHERE id = ${a2.id}`)).length, 1);
  // an edge on another board the caller can write is removed with the node, with its code refs and hide membership
  await ok(owner, 'delete_node', [a1.id]);
  assert.deepEqual(await sql(operator, `SELECT * FROM edge WHERE label = 'legacy-on-b'`), []);
  assert.deepEqual(await sql(operator, `SELECT * FROM code_ref WHERE board_id = ${B}`), []);
  assert.deepEqual(await sql(operator, `SELECT * FROM hide_set_member WHERE target_kind = 'edge' AND target_id = ${edge.id}`), []);
  assert.equal((await sql(operator, `SELECT * FROM node WHERE board_id = ${B}`)).length, 2);
});

test('public Demo is readable and rejects ordinary visitor edits', async () => {
  const visitor = await mint(), seeder = await mint();
  // a visitor who seeded Demo would own a board every dashboard lists
  await denied(visitor, 'seed_demo_board', [], 'service account only');
  await denied(operator, 'seed_demo_board', [], 'service account only');
  await sql(operator, `INSERT INTO service_account (identity, label) VALUES (0x${seeder.identity}, 'demo-seed-test')`);
  await ok(seeder, 'seed_demo_board');
  const B = (await sql(operator, "SELECT * FROM board WHERE name = 'Demo'"))[0].id;
  const rows = await sql(visitor, `SELECT * FROM visible_node WHERE board_id = ${B}`);
  assert.ok(rows.length > 0);
  assert.equal((await sql(visitor, `SELECT * FROM my_boards WHERE board_id = ${B}`))[0].access, 'public');
  await denied(visitor, 'create_node', nodeArgs(B));
  await denied(visitor, 'move_node', [rows[0].id, 4, 4]);
  await denied(visitor, 'delete_board', [B], 'owner');
  // A chart on a public example: readable, and refused by the write guard. A
  // separate board, because the dashboard suite pins Demo's node count.
  const owner = await mint(), example = await create(owner), c = await chart(owner, example);
  await sql(operator, `INSERT INTO public_board (board_id) VALUES (${example})`);
  assert.equal((await sql(visitor, `SELECT * FROM visible_chart WHERE board_id = ${example}`)).length, 1);
  await denied(visitor, 'create_chart', chartArgs(example), 'read only');
  await denied(visitor, 'set_chart_data', dataArgs(c), 'read only');
  assert.equal((await sql(operator, `SELECT * FROM chart WHERE node_id = ${c}`))[0].csv, CSV);
});

// addThreat: boardId, anchorId, stage, severity, title, summary, cvss, package, fixedIn, flags, source, author
const threatArgs = (B, anchorId) => [B, anchorId, 'vulnerable', 'high', 'openssl RCE', 'Heap overflow in the TLS parser.', '9.8', 'openssl@3.0.1', '3.0.7', '["cve"]', '', 'agent'];
const threatsSeenBy = (who, B) => sql(who, `SELECT * FROM visible_threat WHERE board_id = ${B}`);

test('threats are visible to board members only, never to link visitors or public readers', async () => {
  const owner = await mint(), member = await mint(), viewer = await mint(), reader = await mint(), stranger = await mint(), service = await mint();
  await sql(operator, `INSERT INTO service_account (identity, label) VALUES (0x${service.identity}, 'threat-access-test')`);
  const B = await create(owner), [a] = await nodes(owner, B);
  await ok(owner, 'add_threat', threatArgs(B, a.id));
  assert.equal((await threatsSeenBy(owner, B)).length, 1);
  assert.equal((await threatsSeenBy(service, B)).length, 1, 'a service sees every board');
  assert.deepEqual(await threatsSeenBy(stranger, B), []);
  // a team grant is membership
  const org = name('threat-org');
  await ok(service, 'set_org_memberships', [identity(owner), [org], ['admin']]);
  await ok(service, 'set_org_memberships', [identity(member), [org], ['member']]);
  await ok(owner, 'share_board_with_team', [B, org]);
  assert.equal((await threatsSeenBy(member, B)).length, 1);
  await ok(owner, 'unshare_board_from_team', [B, org]);
  assert.deepEqual(await threatsSeenBy(member, B), []);
  // a view link shows the nodes and no threat
  const token = randomBytes(16).toString('hex');
  await ok(owner, 'set_link_share', [B, 'view', token]);
  await ok(viewer, 'open_shared_link', [token]);
  assert.ok((await sql(viewer, `SELECT * FROM visible_node WHERE board_id = ${B}`)).length > 0);
  assert.deepEqual(await threatsSeenBy(viewer, B), []);
  await denied(viewer, 'add_threat', threatArgs(B, a.id), 'read only');
  // a public board shows the nodes and no threat
  await sql(operator, `INSERT INTO public_board (board_id) VALUES (${B})`);
  assert.ok((await sql(reader, `SELECT * FROM visible_node WHERE board_id = ${B}`)).length > 0);
  assert.deepEqual(await threatsSeenBy(reader, B), []);
  await denied(reader, 'add_threat', threatArgs(B, a.id), 'read only');
  const [row] = await sql(operator, `SELECT * FROM threat WHERE board_id = ${B}`);
  for (const who of [viewer, reader, stranger]) {
    await denied(who, 'update_threat', [row.id, ...Array(9).fill(NONE)]);
    await denied(who, 'remove_threat', [row.id]);
    await denied(who, 'set_threat_contained', [row.id, true]);
  }
  assert.equal((await sql(operator, `SELECT * FROM threat WHERE board_id = ${B}`)).length, 1);
});

test("a stranger forks a public board with a cited edge: the copy registers only the paths its citations show", async () => {
  const owner = await mint();
  const B = await create(owner);
  const [a, b] = await nodes(owner, B);
  await ok(owner, 'add_repo_files', [B, ['a.ts', 'customers/acme/contract.ts']]);
  await ok(owner, 'create_edge', [B, a.id, b.id, 'reads', 'source:a.ts:1', NONE, NONE, NONE]);
  await sql(operator, `INSERT INTO public_board (board_id) VALUES (${B})`);
  const from = (await sql(operator, `SELECT * FROM board WHERE id = ${B}`))[0].name, to = name('fork');
  // a fresh token file: the fork mints its own identity, a reader of the public board and no member
  const env = { ...process.env, SOURCE_URI: BASE.replace(/^http/, 'ws'), SOURCE_DB: DB, SOURCE_TOKEN_FILE: join(mkdtempSync(join(tmpdir(), 'fork-')), 'token') };
  await promisify(execFile)('node', ['--import', 'tsx', 'src/fork-board.ts', '--board', from, '--to', to], { cwd: new URL('../importer/', import.meta.url), env, timeout: 60_000 });
  const [copy] = await sql(operator, `SELECT * FROM board WHERE name = '${to}'`);
  assert.deepEqual((await sql(operator, `SELECT * FROM edge WHERE board_id = ${copy.id}`)).map(e => e.evidence), ['source:a.ts:1']);
  assert.deepEqual((await sql(operator, `SELECT * FROM repo_file WHERE board_id = ${copy.id}`)).map(f => f.path), ['a.ts']);
});

test("a session's checkout path, file list and sign-in issuers reach board members only, never link visitors or public readers", async () => {
  const owner = await mint(), member = await mint(), viewer = await mint(), reader = await mint(), service = await mint();
  await sql(operator, `INSERT INTO service_account (identity, label) VALUES (0x${service.identity}, 'session-redaction-test')`);
  const B = await create(owner, true);
  await ok(owner, 'add_repo_files', [B, ['customers/acme/contract.ts']]);
  const root = async who => (await sql(who, `SELECT * FROM visible_session WHERE board_id = ${B}`))[0]?.repo_root;
  const files = async who => (await sql(who, `SELECT * FROM visible_repo_file WHERE board_id = ${B}`)).length;
  // a cursor lives only while its connection does, so each look re-seats the owner's by SQL first
  const issuer = async who => {
    await sql(operator, `DELETE FROM cursor WHERE identity = 0x${owner.identity}`);
    await sql(operator, `INSERT INTO cursor (identity, board_id, x, y) VALUES (0x${owner.identity}, ${B}, 0, 0)`);
    return (await sql(who, 'SELECT * FROM visible_participant')).find(row => hex(row.identity) === owner.identity)?.auth_issuer;
  };
  const [{ auth_issuer: raw }] = await sql(operator, `SELECT * FROM participant WHERE identity = 0x${owner.identity}`);
  assert.notEqual(raw, '');
  // members: the owner (who also sees its own issuer), a team member and a service
  assert.equal(await root(owner), `/tmp/${(await sql(operator, `SELECT * FROM board WHERE id = ${B}`))[0].name}`);
  assert.equal(await files(owner), 1);
  assert.equal(await issuer(owner), raw);
  const org = name('session-redaction');
  await ok(service, 'set_org_memberships', [identity(owner), [org], ['admin']]);
  await ok(service, 'set_org_memberships', [identity(member), [org], ['member']]);
  await ok(owner, 'share_board_with_team', [B, org]);
  assert.match(await root(member), /^\/tmp\//);
  assert.equal(await files(member), 1);
  assert.equal(await issuer(member), '', "another person's issuer");
  assert.match(await root(service), /^\/tmp\//);
  assert.equal(await files(service), 1);
  // a view link and a public board show the session, without the path, the files or the issuer
  const token = randomBytes(16).toString('hex');
  await ok(owner, 'set_link_share', [B, 'view', token]);
  await ok(viewer, 'open_shared_link', [token]);
  await sql(operator, `INSERT INTO public_board (board_id) VALUES (${B})`);
  for (const who of [viewer, reader]) {
    assert.equal(await root(who), '');
    assert.equal(await files(who), 0);
    assert.equal(await issuer(who), '');
  }
});

test('a link carries threats and code only when the owner includes them, and stops the moment they are left out', async () => {
  const owner = await mint(), viewer = await mint(), reader = await mint(), stranger = await mint();
  const B = await create(owner), [a, b] = await nodes(owner, B);
  await ok(owner, 'add_threat', threatArgs(B, a.id));
  await ok(owner, 'add_repo_files', [B, ['src/auth.ts']]);
  await ok(owner, 'add_code_ref', [B, 'node', a.id, 'src/auth.ts', 'verify', 1, 1, SHA, 'export function verify() {}', 'owner']);
  await ok(owner, 'create_edge', [B, a.id, b.id, 'verifies', 'source:src/auth.ts:1', NONE, { some: 'export function verify() {}' }, NONE]);
  const seen = async who => ({
    threats: (await threatsSeenBy(who, B)).length,
    refs: (await sql(who, `SELECT * FROM visible_code_ref WHERE board_id = ${B}`)).length,
    snippet: (await sql(who, `SELECT * FROM visible_edge WHERE board_id = ${B}`)).map(e => e.evidence_snippet).join(''),
  });
  const everything = { threats: 1, refs: 1, snippet: 'export function verify() {}' };
  assert.deepEqual(await seen(owner), everything);
  // includes need a link, and only the owner sets them
  await denied(owner, 'set_link_share_includes', [B, true, true], 'turn on the link before choosing what it includes');
  const token = randomBytes(16).toString('hex');
  await ok(owner, 'set_link_share', [B, 'view', token]);
  await ok(viewer, 'open_shared_link', [token]);
  await denied(viewer, 'set_link_share_includes', [B, true, true], 'only an owner');
  // a new link carries the graph, and neither threats nor code
  assert.ok((await sql(viewer, `SELECT * FROM visible_node WHERE board_id = ${B}`)).length > 0);
  assert.deepEqual(await seen(viewer), { threats: 0, refs: 0, snippet: '' });
  assert.equal((await sql(viewer, `SELECT * FROM visible_edge WHERE board_id = ${B}`))[0].evidence, 'source:src/auth.ts:1', 'the citation stays; its captured line does not');
  await ok(owner, 'set_link_share_includes', [B, true, false]);
  assert.deepEqual(await seen(viewer), { threats: 1, refs: 0, snippet: '' });
  await ok(owner, 'set_link_share_includes', [B, true, true]);
  assert.deepEqual(await seen(viewer), everything);
  assert.deepEqual(await seen(stranger), { threats: 0, refs: 0, snippet: '' }, 'an include is for people who opened the link');
  await denied(viewer, 'add_threat', threatArgs(B, a.id), 'read only');
  // leaving a layer out takes it back at once; a new link starts with nothing again
  await ok(owner, 'set_link_share_includes', [B, false, true]);
  assert.deepEqual(await seen(viewer), { threats: 0, refs: 1, snippet: everything.snippet });
  await ok(owner, 'stop_link_share', [B]);
  const again = randomBytes(16).toString('hex');
  await ok(owner, 'set_link_share', [B, 'view', again]);
  await ok(viewer, 'open_shared_link', [again]);
  assert.deepEqual(await seen(viewer), { threats: 0, refs: 0, snippet: '' });
  // the owner reads the stored choices; nobody else has a row
  const includesOf = async who => (await sql(who, `SELECT * FROM my_link_includes WHERE board_id = ${B}`)).map(r => [r.threats, r.code]);
  assert.deepEqual(await includesOf(owner), [[false, false]]);
  assert.deepEqual(await includesOf(viewer), []);
  // an edit link always carries code (undo writes it back), without storing it as chosen
  await ok(owner, 'set_link_share', [B, 'edit', again]);
  assert.deepEqual(await seen(viewer), { threats: 0, refs: 1, snippet: everything.snippet });
  assert.deepEqual(await includesOf(owner), [[false, false]]);
  await ok(owner, 'set_link_share', [B, 'view', again]);
  assert.deepEqual(await seen(viewer), { threats: 0, refs: 0, snippet: '' });
  // a public board publishes its code as before, and never its threats
  await sql(operator, `INSERT INTO public_board (board_id) VALUES (${B})`);
  assert.deepEqual(await seen(reader), { threats: 0, refs: 1, snippet: everything.snippet });
});

test('architecture history and versions stay private and architecture deletion is guarded', async () => {
  const owner = await mint(), stranger = await mint(), service = await mint();
  await sql(operator, `INSERT INTO service_account (identity, label) VALUES (0x${service.identity}, 'architecture-test')`);
  const label = name('history');
  await ok(owner, 'create_architecture_history', [label, 'https://github.com/test/repository', JSON.stringify([{ ref: 'main', sha: SHA }]), label]);
  const [history] = await sql(owner, `SELECT * FROM visible_architecture_history WHERE name = '${label}'`);
  assert.ok(history?.id);
  assert.deepEqual(await sql(stranger, `SELECT * FROM visible_architecture_history WHERE id = ${history.id}`), []);
  const graph = JSON.stringify({ nodes: [{ key: 'main', label: 'private architecture', sublabel: '', kind: 'service' }], edges: [], files: ['main.ts'] });
  await ok(service, 'publish_architecture_snapshot', [history.id, 0, 'main', SHA, graph]);
  const [version] = await sql(owner, `SELECT * FROM visible_architecture_version WHERE history_id = ${history.id}`);
  assert.ok(version?.board_id);
  assert.deepEqual(await sql(stranger, `SELECT * FROM visible_architecture_version WHERE history_id = ${history.id}`), []);
  assert.equal((await sql(service, `SELECT * FROM visible_architecture_history WHERE id = ${history.id}`)).length, 1);
  assert.equal((await sql(service, `SELECT * FROM visible_architecture_version WHERE history_id = ${history.id}`)).length, 1);
  await denied(owner, 'delete_board', [version.board_id], 'architecture');
  await denied(owner, 'offer_guest_claim', [version.board_id, code()], 'ordinary manual');
  const org = name('architecture-team');
  await ok(service, 'set_org_memberships', [identity(owner), [org], ['admin']]);
  await ok(service, 'set_org_memberships', [identity(stranger), [org], ['member']]);
  await ok(owner, 'share_board_with_team', [version.board_id, org]);
  assert.equal((await sql(stranger, `SELECT * FROM visible_architecture_history WHERE id = ${history.id}`)).length, 1, 'team readers see the history of authorized snapshots');
  await ok(owner, 'unshare_board_from_team', [version.board_id, org]);
  assert.deepEqual(await sql(stranger, `SELECT * FROM visible_architecture_history WHERE id = ${history.id}`), []);
});

test('reconciliation cannot inspect an unrelated private architecture snapshot', async () => {
  const owner = await mint(), stranger = await mint(), service = await mint();
  await sql(operator, `INSERT INTO service_account (identity, label) VALUES (0x${service.identity}, 'reconcile-test')`);
  const graph = JSON.stringify({ nodes: [{ key: 'main', label: 'main', sublabel: '', kind: 'service' }], edges: [], files: ['main.ts'] });
  async function snapshot(who, sha) {
    const label = name('reconcile');
    await ok(who, 'create_architecture_history', [label, 'https://github.com/test/repository', JSON.stringify([{ ref: 'main', sha }]), label]);
    const [history] = await sql(who, `SELECT * FROM visible_architecture_history WHERE name = '${label}'`);
    await ok(service, 'publish_architecture_snapshot', [history.id, 0, 'main', sha, graph]);
    return (await sql(who, `SELECT * FROM visible_architecture_version WHERE history_id = ${history.id}`))[0].board_id;
  }
  const base = await snapshot(owner, SHA);
  const label = name('proposal');
  await ok(owner, 'create_architecture_proposal', [base, label, label]);
  const proposal = (await sql(owner, `SELECT * FROM visible_board WHERE name = '${label}'`))[0].id;
  await ok(owner, 'submit_architecture_proposal', [proposal]);
  await ok(owner, 'review_architecture_proposal', [proposal, 'accept']);
  const other = await snapshot(stranger, '1'.repeat(40));
  await denied(owner, 'reconcile_architecture_proposal', [proposal, other]);
});

test('rename and deletion require ownership and deletion cleans board data', async () => {
  const owner = await mint(), stranger = await mint();
  const B = await create(owner, true), [a, b] = await nodes(owner, B);
  await ok(owner, 'create_edge', [B, a.id, b.id, 'uses', 'human:test', NONE, NONE, NONE]);
  await ok(owner, 'set_node_hidden', [a.id, true, { some: 'private set' }]);
  await ok(owner, 'add_repo_files', [B, ['secret.ts']]);
  await ok(owner, 'add_code_ref', [B, 'node', a.id, 'secret.ts', 'secret', 1, 1, SHA, 'secret()', 'owner']);
  await ok(owner, 'plan_route', [B, [a.id]]);
  await chart(owner, B);
  await ok(owner, 'add_threat', threatArgs(B, a.id));
  const set = (await sql(operator, `SELECT * FROM hide_set WHERE board_id = ${B}`))[0];
  await denied(stranger, 'rename_board', [B, 'stolen'], 'owner');
  await denied(stranger, 'delete_board', [B], 'owner');
  await denied(owner, 'rename_board', [B, ''], 'name');
  await ok(owner, 'rename_board', [B, 'renamed']);
  assert.equal((await sql(owner, `SELECT * FROM visible_board WHERE id = ${B}`))[0].name, 'renamed');
  await ok(owner, 'delete_board', [B]);
  for (const table of ['node', 'edge', 'hide_set', 'repo_file', 'session', 'session_route', 'route_event', 'code_ref', 'board_stats', 'board_grant', 'team_grant', 'public_board', 'activity_outbox', 'chart', 'change_note', 'threat']) {
    assert.deepEqual(await sql(operator, `SELECT * FROM ${table} WHERE board_id = ${B}`), [], `${table} cleanup`);
  }
  assert.deepEqual(await sql(operator, `SELECT * FROM hide_set_member WHERE set_id = ${set.id}`), []);
  assert.deepEqual(await sql(operator, `SELECT * FROM board WHERE id = ${B}`), []);
});

test('requested personal boards correlate exactly and retries create only one board', async () => {
  const owner = await mint(), stranger = await mint();
  const label = name('requested'), requestKey = code();
  await ok(owner, 'create_requested_board', [label, '', requestKey]);
  const rows = await sql(owner, `SELECT * FROM my_board_creations WHERE request_key = '${requestKey}'`);
  assert.equal(rows.length, 1);
  const B = rows[0].board_id;
  assert.equal((await sql(owner, `SELECT * FROM my_boards WHERE board_id = ${B}`))[0].name, label);
  assert.deepEqual(await sql(stranger, `SELECT * FROM my_board_creations WHERE request_key = '${requestKey}'`), []);
  await ok(owner, 'create_requested_board', [label, '', requestKey]);
  assert.deepEqual(await sql(owner, `SELECT * FROM my_board_creations WHERE request_key = '${requestKey}'`), rows);
  assert.equal((await sql(operator, `SELECT * FROM board WHERE name = '${label}'`)).length, 1);
  await denied(stranger, 'create_requested_board', [label, '', requestKey]);
  await denied(owner, 'create_requested_board', [label, '', 'short'], 'request key');
  await denied(owner, 'create_requested_board', ['', '', code()], 'name');
  await ok(owner, 'delete_board', [B]);
  assert.deepEqual(await sql(owner, `SELECT * FROM my_board_creations WHERE request_key = '${requestKey}'`), []);
  assert.deepEqual(await sql(operator, `SELECT * FROM board_creation WHERE board_id = ${B}`), []);
});

test('requested team boards require membership and retain exact retry correlation', async () => {
  const owner = await mint(), stranger = await mint(), service = await mint();
  await sql(operator, `INSERT INTO service_account (identity, label) VALUES (0x${service.identity}, 'requested-team-test')`);
  const org = name('requested-org'), requestKey = code(), label = name('requested-team');
  await denied(owner, 'create_requested_board', [label, org, requestKey], 'member');
  assert.deepEqual(await sql(owner, `SELECT * FROM my_board_creations WHERE request_key = '${requestKey}'`), []);
  await ok(service, 'set_org_memberships', [identity(owner), [org], ['admin']]);
  await ok(service, 'set_org_memberships', [identity(stranger), [org], ['member']]);
  await ok(owner, 'create_requested_board', [label, org, requestKey]);
  const [creation] = await sql(owner, `SELECT * FROM my_board_creations WHERE request_key = '${requestKey}'`);
  assert.ok(creation?.board_id);
  const B = creation.board_id;
  assert.equal((await sql(owner, `SELECT * FROM my_boards WHERE board_id = ${B}`))[0].access, 'owner');
  assert.equal((await sql(stranger, `SELECT * FROM my_boards WHERE board_id = ${B}`))[0].access, 'team');
  assert.deepEqual(await sql(stranger, `SELECT * FROM my_board_creations WHERE request_key = '${requestKey}'`), []);
  await ok(owner, 'create_requested_board', [label, org, requestKey]);
  assert.equal((await sql(operator, `SELECT * FROM board WHERE name = '${label}'`)).length, 1);
  assert.deepEqual(await sql(owner, `SELECT * FROM my_board_creations WHERE request_key = '${requestKey}'`), [creation]);
  await denied(stranger, 'create_requested_board', [label, org, requestKey]);
});
