// Module integration suite for red crayon review marks (spec cloud/docs/superpowers/specs/2026-10-19-red-crayon-review-design.md).
// Talks to an ISOLATED database over the HTTP API only, like scripts/verify-threats-local.mjs:
//
//   nix develop --command scripts/stdb-test.sh run
//
// Only a signed-in person sends marks, so this file serves the browser issuer as verify-issuers-local.mjs does
// (same port and key): stdb-test.sh runs it alone, after the suites that include that file.
// Who reads visible_mark (members and edit-link visitors, never view links or public readers) is tested here too,
// as it needs a person to send. The lease and head-start timing is pinned by module/src/marks.test.mjs.
// Every test mints its own identities and boards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, randomUUID, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { identityFromClaims } from '../shared/identity.ts';
import {
  MARK_AGENTS_RULE, MARK_HUMANS_RULE, MARK_RECLAIMED_RULE, MARK_REPLY_RULE, MARK_SEAT_MISMATCH_RULE, MARK_SEAT_RULE, MARK_SEND_RULE,
} from '../module/src/marks.ts';

// Generated bindings use extensionless TS imports; use the real client SDK (as verify-board-scope-local.mjs does).
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

const { MCP_ORIGIN, BROWSER_ISSUER, APP_ORIGINS, STDB_TEST_ISSUER_KEY: KEY_FILE } = process.env;
if (!MCP_ORIGIN || !BROWSER_ISSUER || !APP_ORIGINS || !KEY_FILE) throw new Error('run through scripts/stdb-test.sh: it sets the test issuers');
const RUN = Date.now().toString(36);
const NONE = { none: [] };
const named = s => `${s}-${RUN}`;

// --- the test issuer (verbatim from verify-issuers-local.mjs) ----------------

// The database keeps an issuer's keys for 5 minutes and never re-fetches for an
// unknown kid, so every run against one test server signs with one saved key.
if (!existsSync(KEY_FILE)) {
  writeFileSync(KEY_FILE, generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
}
const privateKey = createPrivateKey(readFileSync(KEY_FILE));
const JWK = { ...createPublicKey(privateKey).export({ format: 'jwk' }), kid: 'test-issuer', alg: 'ES256', use: 'sig' };
const DISCOVERY = '/.well-known/openid-configuration';
const issuerServer = createServer((req, res) => {
  const { pathname } = new URL(req.url, MCP_ORIGIN);
  const iss = MCP_ORIGIN + pathname.slice(0, -DISCOVERY.length);
  const body = pathname.endsWith(DISCOVERY)
    ? { issuer: iss, jwks_uri: `${iss}/jwks.json`, id_token_signing_alg_values_supported: ['ES256'], response_types_supported: ['id_token'], subject_types_supported: ['public'] }
    : pathname.endsWith('/jwks.json') ? { keys: [JWK] } : null;
  res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' }).end(JSON.stringify(body));
});
issuerServer.listen(Number(new URL(MCP_ORIGIN).port), '127.0.0.1').unref();
await once(issuerServer, 'listening');

const b64u = value => Buffer.from(JSON.stringify(value)).toString('base64url');
function jwt(claims) {
  const now = Math.floor(Date.now() / 1000);
  const input = `${b64u({ alg: 'ES256', typ: 'JWT', kid: JWK.kid })}.${b64u({ iat: now, exp: now + 900, ...claims })}`;
  return `${input}.${sign('sha256', Buffer.from(input), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}
// { token, identity } like POST /v1/identity; the identity is the database's blake3(iss|sub)
const as = (iss, sub, claims = {}) => ({ token: jwt({ iss, sub, ...claims }), identity: identityFromClaims(iss, sub) });
// a browser session token: the session claim (BROWSER_SESSION_CLAIM) and azp, no aud
const person = (claims = {}) => as(BROWSER_ISSUER, `user_${randomUUID()}`, { sid: `sess_${randomUUID()}`, azp: APP_ORIGINS.split(',')[0], ...claims });

// --- HTTP API (verbatim from verify-threats-local.mjs) ------------------------

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

// --- fixtures ----------------------------------------------------------------

// createNode: boardId, label, sublabel, x, y, w, h, token, focal, kind, doc, imported, shape, color, strokeStyle, size
const nodeArgs = (boardId, label, sublabel = '') => [boardId, label, sublabel, 0, 0, 160, 80, 'ink', false, NONE, NONE, NONE, NONE, NONE, NONE, NONE];
const micros = v => Number(Array.isArray(v) ? v[0] : v.__timestamp_micros_since_unix_epoch__);
const hexOf = cell => (cell.__identity__ ?? cell[0]).replace(/^0x/, '');
const seat = () => randomBytes(8).toString('hex'); // 16 characters, like start_session's
const ownerOf = (who, s) => `${who.identity}/${s}`;

async function boardIdOf(name) {
  const rows = await sql(OWNER, `SELECT id FROM board WHERE name = '${name}'`);
  assert.equal(rows.length, 1, `exactly one board named ${name}`);
  return rows[0].id;
}

async function nodeAs(who, boardId, label) {
  await ok(who.token, 'create_node', nodeArgs(boardId, label));
  return (await sql(OWNER, `SELECT * FROM node WHERE board_id = ${boardId} AND label = '${label}'`))[0].id;
}

// An agent linked to `human` and granted board B (join_board once is enough: an HTTP call's disconnect keeps participant.kind).
async function agentOn(human, B) {
  const agent = await mint();
  await ok(agent.token, 'join_board', [named('agent'), 'agent']);
  const link = randomBytes(32).toString('base64url');
  await ok(agent.token, 'offer_agent_link', [link]);
  await ok(human.token, 'redeem_agent_link', [link]);
  await ok(human.token, 'grant_agent_board', [B, { __identity__: `0x${agent.identity}` }]);
  return agent;
}

/** A signed-in person's board with two nodes and two of their agents. */
async function scenario(label) {
  const human = person();
  const name = named(label);
  await ok(human.token, 'create_board', [name]);
  const B = await boardIdOf(name);
  const api = await nodeAs(human, B, 'api');
  const db = await nodeAs(human, B, 'db');
  return { human, B, api, db, a: await agentOn(human, B), b: await agentOn(human, B) };
}

const marksOn = async B => (await sql(OWNER, `SELECT * FROM mark WHERE board_id = ${B}`)).sort((x, y) => x.id - y.id);
const markOf = async id => (await sql(OWNER, `SELECT * FROM mark WHERE id = ${id}`))[0];
// replyMark: markId, seat, claimGen, status, reply, files
const reply = (m, s, o = {}) => [m.id, s, o.claimGen ?? m.claimGen, o.status ?? 'fixed', o.reply ?? 'Added the retry.', o.files ?? ['api/retry.ts']];

// --- send --------------------------------------------------------------------

test('MK a person sends a round; the next send is the next round', async () => {
  const s = await scenario('mk-send');
  await ok(s.human.token, 'send_marks', [s.B, [s.api, s.db], ['retry here', 'index this']]);
  const rows = await marksOn(s.B);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(r => [r.nodeId, r.nodeLabel, r.note, r.status, r.round]), [
    [s.api, 'api', 'retry here', 'sent', 1],
    [s.db, 'db', 'index this', 'sent', 1],
  ]);
  for (const r of rows) {
    assert.equal(hexOf(r.author), s.human.identity);
    assert.deepEqual([r.preferredAgent, r.claimedBy, r.claimGen, r.reply, r.files], ['', '', 0, '', '[]']);
    assert.equal(micros(r.leaseUntil), 0);
    assert.equal(micros(r.answeredAt), 0);
    assert.ok(micros(r.sentAt) > 0, 'sentAt is set');
  }
  await ok(s.human.token, 'send_marks', [s.B, [s.api], ['']]);
  assert.deepEqual((await marksOn(s.B)).map(r => r.round), [1, 1, 2]);
});

test('MK refusals: agents cannot send, people cannot claim, a seat must be a seat, nodes must be on the board', async () => {
  const s = await scenario('mk-refuse');
  const other = await scenario('mk-refuse-other');
  await rejects(s.a.token, 'send_marks', [s.B, [s.api], ['x']], MARK_HUMANS_RULE);
  await rejects(s.human.token, 'claim_marks', [s.B, seat()], MARK_AGENTS_RULE);
  for (const bad of ['', 'short', 'x'.repeat(17), 'abcdefgh-1234567']) {
    await rejects(s.a.token, 'claim_marks', [s.B, bad], MARK_SEAT_RULE);
  }
  for (const [nodeIds, notes] of [[[], []], [[s.api, s.api], ['', '']], [[s.api], []], [[other.api], ['x']], [[999999999], ['x']]]) {
    await rejects(s.human.token, 'send_marks', [s.B, nodeIds, notes], MARK_SEND_RULE);
  }
  await rejects((await mint()).token, 'send_marks', [s.B, [s.api], ['x']], 'not authorized');
  assert.equal((await marksOn(s.B)).length, 0);
});

// --- claim -------------------------------------------------------------------

test('MK two seats of one identity: every mark gets exactly one owner', async () => {
  const s = await scenario('mk-seats');
  await ok(s.human.token, 'send_marks', [s.B, [s.api, s.db], ['one', 'two']]);
  const first = seat(), second = seat();
  await ok(s.a.token, 'claim_marks', [s.B, first]);
  await ok(s.a.token, 'claim_marks', [s.B, second]);
  const rows = await marksOn(s.B);
  assert.deepEqual(rows.map(r => [r.status, r.claimedBy, r.claimGen]), [
    ['claimed', ownerOf(s.a, first), 1],
    ['claimed', ownerOf(s.a, first), 1],
  ]);
  for (const r of rows) assert.ok(micros(r.leaseUntil) > micros(r.sentAt), 'the lease runs from the claim');
  const waiters = await sql(s.human.token, `SELECT * FROM visible_mark_waiter WHERE board_id = ${s.B}`);
  assert.deepEqual(waiters.map(w => w.owner).sort(), [ownerOf(s.a, first), ownerOf(s.a, second)].sort());
  // claiming again renews the owner's lease and takes nothing new
  await new Promise(resolve => setTimeout(resolve, 5));
  await ok(s.a.token, 'claim_marks', [s.B, first]);
  const renewed = await marksOn(s.B);
  assert.deepEqual(renewed.map(r => r.claimGen), [1, 1]);
  renewed.forEach((r, i) => assert.ok(micros(r.leaseUntil) > micros(rows[i].leaseUntil), 'claim_marks moves the lease forward'));
});

test('MK first dibs: the agent that drew the node claims it at once, others wait the head start', async () => {
  const s = await scenario('mk-dibs');
  const drawn = await nodeAs(s.a, s.B, 'queue');
  await ok(s.human.token, 'send_marks', [s.B, [drawn], ['why a queue?']]);
  const [m] = await marksOn(s.B);
  assert.equal(m.preferredAgent, s.a.identity);
  await ok(s.b.token, 'claim_marks', [s.B, seat()]);
  assert.equal((await markOf(m.id)).status, 'sent');
  const mine = seat();
  await ok(s.a.token, 'claim_marks', [s.B, mine]);
  assert.equal((await markOf(m.id)).claimedBy, ownerOf(s.a, mine));
});

// --- reply -------------------------------------------------------------------

test('MK reply: only the owner seat with the current claimGen answers', async () => {
  const s = await scenario('mk-reply');
  await ok(s.human.token, 'send_marks', [s.B, [s.api], ['retry here']]);
  const mine = seat();
  await ok(s.a.token, 'claim_marks', [s.B, mine]);
  const [m] = await marksOn(s.B);
  await rejects(s.a.token, 'reply_mark', reply(m, seat()), MARK_SEAT_MISMATCH_RULE);
  await rejects(s.a.token, 'reply_mark', reply(m, mine, { claimGen: 0 }), MARK_RECLAIMED_RULE);
  await rejects(s.b.token, 'reply_mark', reply(m, mine), MARK_RECLAIMED_RULE);
  await rejects(s.a.token, 'reply_mark', reply(m, mine, { status: 'done' }), MARK_REPLY_RULE);
  await rejects(s.a.token, 'reply_mark', reply(m, mine, { reply: ' ' }), MARK_REPLY_RULE);
  await ok(s.a.token, 'reply_mark', reply(m, mine));
  const r = await markOf(m.id);
  assert.deepEqual([r.status, r.reply, r.files], ['fixed', 'Added the retry.', '["api/retry.ts"]']);
  assert.ok(micros(r.answeredAt) > 0, 'answeredAt is set');
  // answered: a second reply is refused
  await rejects(s.a.token, 'reply_mark', reply(r, mine, { status: 'kept' }), MARK_RECLAIMED_RULE);
});

test('MK a deleted node keeps its marks; the owner still answers', async () => {
  const s = await scenario('mk-del-node');
  await ok(s.human.token, 'send_marks', [s.B, [s.api], ['retry here']]);
  await ok(s.human.token, 'delete_node', [s.api]);
  const seen = await sql(s.human.token, `SELECT * FROM visible_mark WHERE board_id = ${s.B}`);
  assert.deepEqual(seen.map(r => r.nodeLabel), ['api']);
  const mine = seat();
  await ok(s.a.token, 'claim_marks', [s.B, mine]);
  const [m] = await marksOn(s.B);
  await ok(s.a.token, 'reply_mark', reply(m, mine, { status: 'kept', files: [] }));
  assert.equal((await markOf(m.id)).status, 'kept');
});

test('MK a reply renews the seat\'s other leases', async () => {
  const s = await scenario('mk-reply-renew');
  await ok(s.human.token, 'send_marks', [s.B, [s.api, s.db], ['one', 'two']]);
  const mine = seat();
  await ok(s.a.token, 'claim_marks', [s.B, mine]);
  const [m, other] = await marksOn(s.B);
  await new Promise(resolve => setTimeout(resolve, 5));
  await ok(s.a.token, 'reply_mark', reply(m, mine));
  const after = await markOf(other.id);
  assert.equal(after.status, 'claimed');
  assert.ok(micros(after.leaseUntil) > micros(other.leaseUntil), 'reply_mark moves the other lease forward');
});

test('MK a node without a label is marked by its sublabel', async () => {
  const s = await scenario('mk-sublabel');
  await ok(s.human.token, 'create_node', nodeArgs(s.B, '', 'cache'));
  const [n] = await sql(OWNER, `SELECT * FROM node WHERE board_id = ${s.B} AND sublabel = 'cache'`);
  await ok(s.human.token, 'send_marks', [s.B, [n.id], ['evict?']]);
  assert.equal((await marksOn(s.B))[0].nodeLabel, 'cache');
});

// --- read cursor and cascade -------------------------------------------------

test('MK mark_replies_read keeps one cursor row per person and board', async () => {
  const s = await scenario('mk-read');
  await ok(s.human.token, 'mark_replies_read', [s.B]);
  const [first] = await sql(s.human.token, 'SELECT * FROM visible_mark_read');
  assert.equal(hexOf(first.identity), s.human.identity);
  assert.equal(first.boardId, s.B);
  await new Promise(resolve => setTimeout(resolve, 5));
  await ok(s.human.token, 'mark_replies_read', [s.B]);
  const rows = await sql(s.human.token, 'SELECT * FROM visible_mark_read');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, first.id);
  assert.ok(micros(rows[0].lastReadAt) > micros(first.lastReadAt), 'the cursor moves');
  assert.deepEqual(await sql(s.a.token, 'SELECT * FROM visible_mark_read'), [], 'only your own cursor');
  await rejects((await mint()).token, 'mark_replies_read', [s.B], 'not authorized');
});

test('MK deleteBoard deletes marks, waiters, read cursors and node touches', async () => {
  const s = await scenario('mk-del-board');
  await nodeAs(s.a, s.B, 'queue');
  await ok(s.human.token, 'send_marks', [s.B, [s.api], ['x']]);
  await ok(s.a.token, 'claim_marks', [s.B, seat()]);
  await ok(s.human.token, 'mark_replies_read', [s.B]);
  await ok(s.human.token, 'delete_board', [s.B]);
  for (const table of ['mark', 'mark_waiter', 'mark_read', 'node_touch']) {
    assert.deepEqual(await sql(OWNER, `SELECT * FROM ${table} WHERE board_id = ${s.B}`), [], `${table} is empty`);
  }
});

// --- who reads marks (D14) -----------------------------------------------------

// Here, not in verify-access-local.mjs: only a signed-in person sends marks, and this file serves that issuer.
const marksSeenBy = async (who, B) => (await sql(who.token, `SELECT * FROM visible_mark WHERE board_id = ${B}`)).length
  + (await sql(who.token, `SELECT * FROM visible_mark_waiter WHERE board_id = ${B}`)).length;

test('MK marks reach members and edit-link visitors, never view-link visitors or public readers', async () => {
  const s = await scenario('mk-access');
  await ok(s.human.token, 'send_marks', [s.B, [s.api], ['retry here']]);
  await ok(s.a.token, 'claim_marks', [s.B, seat()]);
  const editor = person(), viewer = await mint(), reader = await mint(), stranger = await mint();
  assert.equal(await marksSeenBy(s.human, s.B), 2);
  assert.equal(await marksSeenBy(s.b, s.B), 2, 'a granted agent is a member');
  assert.equal(await marksSeenBy(stranger, s.B), 0);
  // a view link and a public board show the nodes and no mark
  const link = randomBytes(16).toString('hex');
  await ok(s.human.token, 'set_link_share', [s.B, 'view', link]);
  await ok(viewer.token, 'open_shared_link', [link]);
  assert.ok((await sql(viewer.token, `SELECT * FROM visible_node WHERE board_id = ${s.B}`)).length > 0);
  assert.equal(await marksSeenBy(viewer, s.B), 0);
  await rejects(viewer.token, 'mark_replies_read', [s.B], 'read only');
  await sql(OWNER, `INSERT INTO public_board (board_id) VALUES (${s.B})`);
  assert.ok((await sql(reader.token, `SELECT * FROM visible_node WHERE board_id = ${s.B}`)).length > 0);
  assert.equal(await marksSeenBy(reader, s.B), 0);
  // the link made an edit link shows them to a visitor who opened it, and lets a person send
  await ok(s.human.token, 'set_link_share', [s.B, 'edit', link]);
  await ok(editor.token, 'open_shared_link', [link]);
  assert.equal(await marksSeenBy(editor, s.B), 2);
  await ok(editor.token, 'send_marks', [s.B, [s.db], ['and here']]);
  assert.equal(await marksSeenBy(viewer, s.B), 3, 'the view visitor now holds an edit link');
  assert.equal(await marksSeenBy(reader, s.B), 0);
  for (const table of ['mark', 'mark_waiter', 'mark_read', 'node_touch']) {
    const r = await fetch(`${BASE}/v1/database/${DB}/sql`, { method: 'POST', headers: { Authorization: `Bearer ${stranger.token}` }, body: `SELECT * FROM ${table}` });
    assert.equal(r.status, 400, `${table} is private`);
  }
});

// --- who has the board open (the watcher stops when nobody does) -------------

/** A canvas tab: a live connection that opened `boardIds` (an HTTP call's disconnect would close them at once). */
async function tab(who, boardIds) {
  const conn = await new Promise((resolve, reject) => {
    DbConnection.builder().withUri(BASE).withDatabaseName(DB).withToken(who.token)
      .onConnect(resolve).onConnectError((_ctx, error) => reject(error)).build();
  });
  await conn.reducers.openBoards({ boardIds: boardIds.map(BigInt) });
  return conn;
}
const peopleSeenBy = async who => (await sql(who.token, 'SELECT * FROM visible_board_people')).map(r => hexOf(r.identity));

test('MK visible_board_people: an agent granted the board sees who has it open, a stranger sees nobody', async () => {
  const s = await scenario('mk-people');
  const stranger = await mint();
  assert.deepEqual(await peopleSeenBy(s.a), [], 'nobody has it open yet');
  const conn = await tab(s.human, [s.B]);
  try {
    assert.deepEqual(await peopleSeenBy(s.a), [s.human.identity]);
    assert.deepEqual(await peopleSeenBy(stranger), []);
  } finally { conn.disconnect(); }
  const deadline = Date.now() + 5000;
  while ((await peopleSeenBy(s.a)).length) {
    assert.ok(Date.now() < deadline, 'closing the tab closes the board');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
});

test('MK visible_board_people: a row shows only the open boards the agent may mark on', async () => {
  const s = await scenario('mk-people-private');
  const privateName = named('mk-people-c');
  await ok(s.human.token, 'create_board', [privateName]);
  const C = await boardIdOf(privateName);
  const conn = await tab(s.human, [s.B, C]);
  try {
    const rows = await sql(s.a.token, 'SELECT * FROM visible_board_people');
    assert.deepEqual(rows.map(r => r.boardIds.map(String)), [[String(s.B)]], 'only B, never C');
  } finally { conn.disconnect(); }
});
