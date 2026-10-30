// Hosted MCP module release (RC-552; spec §8 Items 1, 2 and 5, §12 Fail closed):
// the hosted-agent lifecycle, link_hosted_agent, join_board kinds and the issuer
// allowlist, against the isolated server of scripts/stdb-test.sh.
//
// This file is the test issuer. It serves OIDC discovery and JWKS under
// MCP_ORIGIN for every path (MCP_ORIGIN/agent-id is ours, BROWSER_ISSUER signs
// browser sessions, MCP_ORIGIN/other is listed nowhere) and mints ES256 tokens the database
// accepts, signed with the key at STDB_TEST_ISSUER_KEY (made on first use).
// stdb-test.sh publishes the module with those issuers, and MODULE_ENV
// names the variant: local, staging or production through `run`, none through
// `failclosed`.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, randomUUID, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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
const { identityFromClaims } = await import('../shared/identity.ts');

const { STDB_URL: BASE, STDB_DB: DB, STDB_OWNER_TOKEN: OWNER, MCP_ORIGIN, BROWSER_ISSUER, APP_ORIGINS, STDB_TEST_ISSUER_KEY: KEY_FILE } = process.env;
const VARIANT = process.env.MODULE_ENV ?? 'local';
if (!BASE || !DB || !OWNER || DB === 'redcrayon' || !MCP_ORIGIN || !BROWSER_ISSUER || !APP_ORIGINS || !KEY_FILE) {
  throw new Error('run through scripts/stdb-test.sh: it sets the isolated database and the test issuers');
}
const OURS = `${MCP_ORIGIN}/agent-id`, OTHER = `${MCP_ORIGIN}/other`, APP = APP_ORIGINS.split(',')[0];
const SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const NONE = { none: [] };
const RUN = Date.now().toString(36);
const named = s => `${s}-${RUN}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const open = { skip: VARIANT === 'none' && 'the none variant refuses every sender' };
// stdb-test.sh sets BROWSER_CLIENT_IDS; the hosted service sets none, so BROWSER_CLIENT_IDS= runs its rule.
const CLIENT = (process.env.BROWSER_CLIENT_IDS ?? '').split(',')[0];
const clientIds = { skip: open.skip || (!CLIENT && 'no BROWSER_CLIENT_IDS, as for the hosted service') };
const closed = { skip: VARIANT !== 'none' && 'only the none variant refuses senders' };
// RC-571: staging and production refuse senders outside the allowlist and spend the write budget; local does neither.
const ENFORCE = VARIANT !== 'local';
const audit = { skip: ENFORCE && 'only the local variant logs a sender instead of refusing it' };
const enforced = { skip: !['staging', 'production'].includes(VARIANT) && 'staging and production refuse senders and budget writes' };
const REFUSED = 'issuer rule: tokens from this issuer are not accepted';

// --- the test issuer ---------------------------------------------------------

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
const ours = sub => as(OURS, sub, { aud: 'redcrayon-db' });
const agent = () => ours(`agent:user_${randomUUID()}`);
const guest = () => ours(`guest:${randomUUID()}`);
// a browser session token: the session claim (BROWSER_SESSION_CLAIM) and azp, no aud
const person = (claims = {}) => as(BROWSER_ISSUER, `user_${randomUUID()}`, { sid: `sess_${randomUUID()}`, azp: APP, ...claims });
const svc = ours('service:mcp');

// --- HTTP API ----------------------------------------------------------------

const camel = s => s.replace(/_([a-z])/g, (_m, c) => c.toUpperCase());
const hexOf = v => String(Array.isArray(v) ? v[0] : v.__identity__).replace(/^0x/, '').toLowerCase();
const micros = v => Number(Array.isArray(v) ? v[0] : v.__timestamp_micros_since_unix_epoch__);
const id = hex => ({ __identity__: `0x${hex}` });
const pick = (o, keys) => Object.fromEntries(keys.map(k => [k, o[k]]));

async function mint() {
  const r = await fetch(`${BASE}/v1/identity`, { method: 'POST' });
  assert.equal(r.status, 200, 'POST /v1/identity');
  return r.json();
}
async function call(token, reducer, args = []) {
  const r = await fetch(`${BASE}/v1/database/${DB}/call/${reducer}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(args),
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
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' }, body: query,
  });
  const text = await r.text();
  assert.equal(r.status, 200, `sql ${r.status}: ${text} (${query})`);
  const [res] = JSON.parse(text);
  const cols = res.schema.elements.map(e => camel(e.name?.some ?? e.name));
  return res.rows.map(row => Object.fromEntries(cols.map((c, i) => [c, row[i]])));
}
// the module's log messages (owner only)
async function logLines() {
  const r = await fetch(`${BASE}/v1/database/${DB}/logs?num_lines=100000`, { headers: { Authorization: `Bearer ${OWNER}` } });
  const text = await r.text();
  assert.equal(r.status, 200, `logs ${r.status}: ${text}`);
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line).message);
}
function connect(who, queries) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('subscription timed out')), 10000);
    DbConnection.builder().withUri(BASE).withDatabaseName(DB).withToken(who.token)
      .onConnect(conn => conn.subscriptionBuilder().onApplied(() => { clearTimeout(timeout); resolve(conn); })
        .onError((_ctx, error) => { clearTimeout(timeout); conn.disconnect(); reject(error); }).subscribe(queries))
      .onConnectError((_ctx, error) => { clearTimeout(timeout); reject(error); })
      .onDisconnect((_ctx, error) => { clearTimeout(timeout); reject(error ?? new Error('disconnected')); })
      .build();
  });
}
async function waitFor(predicate, message) {
  const deadline = Date.now() + 5000;
  while (!(await predicate())) {
    assert.ok(Date.now() < deadline, message);
    await sleep(20);
  }
}

const participantsOf = who => sql(OWNER, `SELECT * FROM participant WHERE identity = 0x${who.identity}`);
const participantOf = async who => (await participantsOf(who))[0];
const selectionOf = async who => (await sql(OWNER, `SELECT * FROM selection WHERE identity = 0x${who.identity}`))[0];
const cursorOf = async who => (await sql(OWNER, `SELECT * FROM cursor WHERE identity = 0x${who.identity}`))[0];
const boardIdOf = async name => (await sql(OWNER, `SELECT id FROM board WHERE name = '${name}'`))[0].id;
async function createBoardAs(who, name) { await ok(who.token, 'create_board', [name]); return boardIdOf(name); }
async function sessionAs(who, name) { await ok(who.token, 'start_session', [name, `/tmp/${name}`, SHA]); return boardIdOf(name); }
async function nodeAs(who, boardId, label) {
  await ok(who.token, 'create_node', [boardId, label, '', 0, 0, 160, 80, 'ink', false, ...Array(7).fill(NONE)]);
  return (await sql(OWNER, `SELECT * FROM node WHERE board_id = ${boardId}`)).find(n => n.label === label).id;
}

before(async () => {
  if (VARIANT !== 'none') await sql(OWNER, `INSERT INTO service_account (identity, label) VALUES (0x${svc.identity}, 'mcp')`);
});

// --- Item 1: the hosted-agent lifecycle ----------------------------------------

test('a hosted agent has one participant row, kind agent with no connections, and keeps its selection', open, async () => {
  const a = agent();
  const S = await sessionAs(a, named('hosted'));
  const n = await nodeAs(a, S, 'focus'); // an agent's write on its session board selects the node
  assert.deepEqual((await selectionOf(a))?.nodeIds, [n], 'the call that drew the node left its selection');
  await ok(a.token, 'join_board', ['agent of Ada', 'agent']);
  for (let i = 0; i < 3; i++) await sql(a.token, 'SELECT * FROM my_boards');
  const rows = await participantsOf(a);
  assert.equal(rows.length, 1);
  const [{ kind, connections, displayName, authIssuer }] = rows;
  assert.deepEqual({ kind, connections, displayName, authIssuer }, { kind: 'agent', connections: 0, displayName: 'agent of Ada', authIssuer: OURS });
  assert.deepEqual((await selectionOf(a))?.nodeIds, [n], 'the selection survives the calls after it');
});

test('a hosted agent writes its participant row at most once a minute, so an open tab sees no churn', open, async () => {
  const a = agent();
  await ok(a.token, 'join_board', ['agent of Bo', 'agent']);
  const first = await participantOf(a);
  const B = await createBoardAs(a, named('quiet'));
  const n = await nodeAs(a, B, 'n');
  const tab = await connect(svc, ['SELECT * FROM visible_participant']);
  const writes = [];
  for (const event of ['onInsert', 'onUpdate', 'onDelete']) {
    tab.db.visibleParticipant[event]((_ctx, row) => { if (row.identity.toHexString() === a.identity) writes.push(event); });
  }
  // every update before a marker's arrives first: wait for a fresh participant to know the tab is current
  const settle = async () => {
    const marker = await mint();
    await ok(marker.token, 'join_board', [named('marker'), 'human']);
    await waitFor(() => [...tab.db.visibleParticipant.iter()].some(row => row.identity.toHexString() === marker.identity), 'the tab sees the marker');
  };
  try {
    for (let i = 0; i < 5; i++) {
      await ok(a.token, 'set_selection', [B, [n]]);
      await ok(a.token, 'join_board', ['agent of Bo', 'agent']);
      await sql(a.token, 'SELECT * FROM my_boards');
    }
    await settle();
    assert.deepEqual(writes, [], '15 calls within the minute wrote nothing');
    assert.equal(micros((await participantOf(a)).lastSeenAt), micros(first.lastSeenAt));
    await sleep(Math.max(0, micros(first.lastSeenAt) / 1000 + 61_000 - Date.now()));
    for (let i = 0; i < 3; i++) await ok(a.token, 'set_selection', [B, [n]]);
    await settle();
    assert.equal(writes.filter(e => e !== 'onDelete').length, 1, `one refresh after the minute, got ${writes}`);
    const later = await participantOf(a);
    assert.ok(micros(later.lastSeenAt) - micros(first.lastSeenAt) > 60e6, 'lastSeenAt moved forward');
    assert.deepEqual({ kind: later.kind, connections: later.connections }, { kind: 'agent', connections: 0 });
  } finally { tab.disconnect(); }
});

test('a guest from our issuer keeps the normal lifecycle: counted while connected, no cursor left after', open, async () => {
  const g = guest();
  const conn = await connect(g, ['SELECT * FROM my_guest_board']);
  try {
    assert.equal((await participantOf(g)).connections, 1, 'a connected guest counts as online');
    await conn.reducers.ensureGuestBoard({ fresh: undefined });
    await waitFor(() => [...conn.db.myGuestBoard.iter()].length === 1, 'the guest gets its board');
    const [{ boardId }] = [...conn.db.myGuestBoard.iter()];
    await conn.reducers.updateCursor({ boardId, x: 4, y: 4 });
    await waitFor(async () => Boolean(await cursorOf(g)), 'the cursor is stored while connected');
  } finally { conn.disconnect(); }
  await waitFor(async () => !(await cursorOf(g)), 'disconnecting removes the cursor');
  const p = await participantOf(g);
  assert.deepEqual({ kind: p.kind, connections: p.connections }, { kind: 'human', connections: 0 });
});

// --- Item 5: link_hosted_agent -------------------------------------------------

test('dev pairing recovers legacy phantom-owned boards without taking another agent\'s boards', { skip: open.skip || VARIANT !== 'local' }, async () => {
  const a = agent(), other = agent(), owner = person();
  const phantom = identityFromClaims('', 'user_dev');
  for (const who of [a, other]) await ok(svc.token, 'link_hosted_agent', [id(who.identity), id(phantom)]);
  const B = await createBoardAs(a, named('legacy-dev'));
  const otherBoard = await createBoardAs(other, named('other-dev'));
  // Simulate old boards: their undrained creation events are the remaining provenance.
  await sql(OWNER, `DELETE FROM board_creation WHERE board_id = ${B}`);
  await sql(OWNER, `DELETE FROM board_creation WHERE board_id = ${otherBoard}`);
  await ok(svc.token, 'grant_hosted_agent_board', [id(a.identity), id(phantom), String(otherBoard)]);
  assert.equal(await sees(a, otherBoard), true, 'an edit grant does not establish who created the board');
  const code = randomBytes(32).toString('base64url');
  await ok(a.token, 'offer_agent_link', [code]);
  await ok(owner.token, 'redeem_agent_link', [code]);
  assert.equal((await sql(owner.token, 'SELECT * FROM my_boards')).find(r => r.boardId === B)?.access, 'owner');
  assert.equal(await sees(a, B), true, 'the agent retains access after redemption');
  assert.equal(await sees(owner, otherBoard), false, 'another dev agent\'s boards stay put');
  assert.equal(await sees(other, otherBoard), true);
  const [stats] = await sql(OWNER, `SELECT * FROM board_stats WHERE board_id = ${B}`);
  assert.equal(hexOf(stats.createdBy), owner.identity);
  await nodeAs(a, B, 'still editable');
  const nextOwner = person(), nextCode = randomBytes(32).toString('base64url');
  await ok(a.token, 'offer_agent_link', [nextCode]);
  await ok(nextOwner.token, 'redeem_agent_link', [nextCode]);
  assert.equal((await sql(owner.token, 'SELECT * FROM my_boards')).find(r => r.boardId === B)?.access, 'owner', 'real ownership stays put on later relinks');
  assert.equal(await sees(nextOwner, B), false);
  assert.equal(await sees(a, B), false);
});

test('dev pairing preserves access when legacy creator history cannot be verified', { skip: open.skip || VARIANT !== 'local' }, async () => {
  const a = agent(), owner = person(), phantom = identityFromClaims('', 'user_dev');
  await ok(svc.token, 'link_hosted_agent', [id(a.identity), id(phantom)]);
  const B = await createBoardAs(a, named('legacy-no-history'));
  await sql(OWNER, `DELETE FROM board_creation WHERE board_id = ${B}`);
  await sql(OWNER, `DELETE FROM activity_outbox WHERE board_id = ${B}`);
  const code = randomBytes(32).toString('base64url');
  await ok(a.token, 'offer_agent_link', [code]);
  await rejects(owner.token, 'redeem_agent_link', [code], `cannot verify who created legacy dev board ${B}`);
  assert.equal(await sees(a, B), true);
  assert.equal(await sees(owner, B), false);
  const [link] = await sql(OWNER, `SELECT * FROM agent_link WHERE agent = 0x${a.identity}`);
  assert.equal(hexOf(link.owner), phantom);
});

test('dev pairing retains creator history after activity is drained', { skip: open.skip || VARIANT !== 'local' }, async () => {
  const a = agent(), owner = person(), phantom = identityFromClaims('', 'user_dev');
  await ok(svc.token, 'link_hosted_agent', [id(a.identity), id(phantom)]);
  const B = await sessionAs(a, named('legacy-session'));
  const [creation] = await sql(OWNER, `SELECT * FROM board_creation WHERE board_id = ${B}`);
  assert.equal(hexOf(creation?.owner), a.identity);
  await sql(OWNER, `DELETE FROM activity_outbox WHERE board_id = ${B}`);
  const code = randomBytes(32).toString('base64url');
  await ok(a.token, 'offer_agent_link', [code]);
  await ok(owner.token, 'redeem_agent_link', [code]);
  assert.equal((await sql(owner.token, 'SELECT * FROM my_boards')).find(r => r.boardId === B)?.access, 'owner');
  assert.equal(await sees(a, B), true);
});

test('link_hosted_agent is service only, upserts the link, and a new owner drops the old grants', open, async () => {
  const a = agent(), ann = person(), bob = person();
  await rejects(ann.token, 'link_hosted_agent', [id(a.identity), id(ann.identity)], 'not authorized: service account only');
  await rejects(a.token, 'link_hosted_agent', [id(a.identity), id(ann.identity)], 'not authorized: service account only');
  const S = await sessionAs(a, named('agent-own'));
  const A = await createBoardAs(ann, named('ann-own'));
  await ok(svc.token, 'link_hosted_agent', [id(a.identity), id(ann.identity)]);
  const access = async (who, boardId) => (await sql(who.token, 'SELECT * FROM my_boards')).find(r => r.boardId === boardId)?.access;
  assert.equal(await access(ann, S), 'owner', 'the link moves the board the agent made to its owner');
  assert.equal(await access(a, S), 'grant', 'and the agent keeps editing it');
  assert.equal(await access(a, A), undefined, "linking alone shares none of the owner's boards");
  await ok(ann.token, 'grant_agent_board', [A, id(a.identity)]);
  assert.equal((await sql(a.token, `SELECT * FROM visible_board WHERE id = ${A}`)).length, 1, 'a granted board is readable');
  const [link] = await sql(OWNER, `SELECT * FROM agent_link WHERE agent = 0x${a.identity}`);
  await ok(svc.token, 'link_hosted_agent', [id(a.identity), id(ann.identity)]); // the same owner again
  assert.deepEqual(await sql(OWNER, `SELECT * FROM agent_link WHERE agent = 0x${a.identity}`), [link], 'a repeated link writes nothing');
  assert.equal((await sql(OWNER, `SELECT * FROM agent_grant WHERE agent = 0x${a.identity}`)).length, 2, 'and keeps the grants');
  await ok(svc.token, 'link_hosted_agent', [id(a.identity), id(bob.identity)]);
  assert.deepEqual(await sql(OWNER, `SELECT * FROM agent_grant WHERE agent = 0x${a.identity}`), [], "a new owner drops the old owner's grants");
  assert.deepEqual(await sql(a.token, `SELECT * FROM visible_board WHERE id = ${A}`), []);
  assert.equal(await access(ann, S), 'owner', 'the board stays with the owner it was made for');
  assert.equal(await access(bob, S), undefined);
  assert.equal(await access(a, S), undefined);
  assert.deepEqual((await sql(bob.token, 'SELECT * FROM my_agent_links')).map(r => [hexOf(r.agent), hexOf(r.owner)]), [[a.identity, bob.identity]]);
});

test("grant_hosted_agent_board: service only, the owner's own board by id or slug, never another's", open, async () => {
  const a = agent(), ann = person(), bob = person();
  const A = await createBoardAs(ann, named('ann-link'));
  const B = await createBoardAs(bob, named('bob-link'));
  const [{ slug }] = await sql(OWNER, `SELECT * FROM board WHERE id = ${A}`);
  const readable = async boardId => (await sql(a.token, `SELECT * FROM visible_board WHERE id = ${boardId}`)).length === 1;
  await rejects(svc.token, 'grant_hosted_agent_board', [id(a.identity), id(ann.identity), String(A)], 'not authorized: board is unavailable'); // not linked yet
  await ok(svc.token, 'link_hosted_agent', [id(a.identity), id(ann.identity)]);
  await rejects(ann.token, 'grant_hosted_agent_board', [id(a.identity), id(ann.identity), String(A)], 'not authorized: service account only');
  await rejects(a.token, 'grant_hosted_agent_board', [id(a.identity), id(ann.identity), String(A)], 'not authorized: service account only');
  await rejects(svc.token, 'grant_hosted_agent_board', [id(a.identity), id(ann.identity), String(B)], 'not authorized: board is unavailable');
  await rejects(svc.token, 'grant_hosted_agent_board', [id(a.identity), id(bob.identity), String(B)], 'not authorized: board is unavailable');
  await rejects(svc.token, 'grant_hosted_agent_board', [id(a.identity), id(ann.identity), 'nosuchslug'], 'not authorized: board is unavailable');
  assert.equal(await readable(A), false);
  await ok(svc.token, 'grant_hosted_agent_board', [id(a.identity), id(ann.identity), slug]);
  assert.equal(await readable(A), true, 'the slug grants the board');
  await ok(svc.token, 'grant_hosted_agent_board', [id(a.identity), id(ann.identity), String(A)]); // by id, again
  assert.equal((await sql(OWNER, `SELECT * FROM agent_grant WHERE agent = 0x${a.identity}`)).length, 1, 'a repeat writes nothing');
  assert.equal(await readable(B), false);
  const C = await createBoardAs(ann, named('ann-digits'));
  await sql(OWNER, `UPDATE board SET slug = '12345678901234567890' WHERE id = ${C}`);
  await ok(svc.token, 'grant_hosted_agent_board', [id(a.identity), id(ann.identity), '12345678901234567890']);
  assert.equal(await readable(C), true, 'an all-digit slug is a slug, not an id');
});

// --- Item 1: join_board kinds ----------------------------------------------------

test('join_board: our tokens take the kind from the subject, browser sessions are people, other identities keep theirs', open, async () => {
  const a = agent(), g = guest(), p = person(), stdio = await mint();
  await ok(a.token, 'join_board', ['agent of Cy', 'human']);
  await ok(g.token, 'join_board', ['Guest', 'agent']);
  await ok(p.token, 'join_board', ['Cy', 'agent']);
  await ok(stdio.token, 'join_board', ['stdio agent', 'agent']);
  const kinds = await Promise.all([a, g, p, stdio].map(async who => (await participantOf(who)).kind));
  assert.deepEqual(kinds, ['agent', 'human', 'human', 'agent']);
  await rejects(a.token, 'join_board', ['agent of Cy', 'robot'], "kind 'robot' is not allowed");
});

// --- edge evidence: human: is the human's -----------------------------------------

test('edge evidence: an agent cannot cite human:, so an uncited flow never passes as human-drawn; a person can', open, async () => {
  const stdio = await mint();
  await ok(stdio.token, 'join_board', [named('stdio agent'), 'agent']);
  for (const [a, label] of [[agent(), 'human-ev-hosted'], [stdio, 'human-ev-stdio']]) {
    const S = await sessionAs(a, named(label));
    const x = await nodeAs(a, S, 'x'), y = await nodeAs(a, S, 'y');
    await rejects(a.token, 'create_edge', [S, x, y, 'uses', 'human:alice', NONE, NONE, NONE], 'agents cannot use human: evidence');
    await ok(a.token, 'create_edge', [S, x, y, 'uses', 'import', NONE, NONE, NONE]);
    await ok(a.token, 'create_edge', [S, y, x, 'uses', 'agent:user described the topology', NONE, NONE, NONE]);
  }
  const p = person();
  const B = await createBoardAs(p, named('human-ev-person'));
  await ok(p.token, 'create_edge', [B, await nodeAs(p, B, 'x'), await nodeAs(p, B, 'y'), 'uses', 'human:Ada', NONE, NONE, NONE]);
});

// --- Item 2: the issuer allowlist ------------------------------------------------

// What the allowlist refuses (RC-571): (d) a foreign issuer, (f) a browser-issuer token without the
// session claim (an OAuth access token a third-party client holds), (g) a token issued to another app,
// and tokens of ours for another audience or a subject kind we never mint.
const refusedSenders = () => [
  [as(OTHER, 'user_x'), OTHER], // (d)
  [person({ sid: undefined }), BROWSER_ISSUER], // (f)
  [person({ azp: 'https://elsewhere.example' }), BROWSER_ISSUER], // (g)
  [as(OURS, `agent:user_${randomUUID()}`, { aud: 'someone-else' }), OURS],
  [ours(`user:${randomUUID()}`), OURS],
];
// Accepted: our agent, guest and service tokens, a browser session, and an identity the database
// mints (canvas guests; run (e), refusing those, waits for our own guest mint).
const acceptedSenders = async () => [agent(), guest(), svc, person(), await mint()];
const issOf = who => JSON.parse(Buffer.from(who.token.split('.')[1], 'base64url')).iss;
const logCount = (logs, iss, word) => logs.filter(message => message === `issuer rule: ${word} ${iss}`).length;

test('issuer rule (local): listed senders connect quietly; others still connect, and the log names only their issuer', audit, async () => {
  const count = (logs, iss) => logCount(logs, iss, 'would refuse');
  const accepted = await acceptedSenders();
  for (const who of accepted) await sql(who.token, 'SELECT * FROM my_boards');
  const before = await logLines();
  for (const iss of [OURS, BROWSER_ISSUER, issOf(accepted[4])]) assert.equal(count(before, iss), 0, `no accepted sender of ${iss} is logged`);
  const refused = refusedSenders();
  for (const [who] of refused) await ok(who.token, 'join_board', [named('refused'), 'human']);
  const after = await logLines();
  // one line per refused connection; only this file signs tokens, while the other suites mint identities
  for (const iss of [OTHER, BROWSER_ISSUER, OURS]) {
    assert.equal(count(after, iss) - count(before, iss), refused.filter(([, i]) => i === iss).length, `refusals logged for ${iss}`);
  }
  for (const [who] of refused) assert.ok(!after.some(message => message.includes(who.token.split('.')[2])), 'no token reaches the log');
  const wrongAudience = await participantOf(refused[3][0]);
  assert.equal(wrongAudience.kind, 'human', 'a token of ours for another audience is no hosted agent');
});

test('issuer rule (staging, production): every other sender is refused, a call and a live connection alike', enforced, async () => {
  const count = (logs, iss) => logCount(logs, iss, 'refused');
  const accepted = await acceptedSenders();
  for (const who of accepted) await sql(who.token, 'SELECT * FROM my_boards');
  for (const who of accepted.filter(who => who !== svc)) await ok(who.token, 'join_board', [named('accepted'), 'human']);
  const before = await logLines();
  const refused = refusedSenders();
  for (const [who] of refused) {
    const result = await call(who.token, 'join_board', [named('refused'), 'human']);
    assert.deepEqual([result.status, result.text], [403, REFUSED], `${issOf(who)} is refused`);
    assert.equal(await participantOf(who), undefined, 'a refused sender leaves no row');
  }
  await assert.rejects(connect(person({ sid: undefined }), ['SELECT * FROM my_boards']), 'an OAuth access token cannot open a live connection');
  const after = await logLines();
  for (const iss of [OTHER, OURS]) {
    assert.equal(count(after, iss) - count(before, iss), refused.filter(([, i]) => i === iss).length, `refusals logged for ${iss}`);
  }
  assert.ok(count(after, BROWSER_ISSUER) - count(before, BROWSER_ISSUER) >= 2, 'refusals logged for the browser issuer');
  for (const [who] of refused) assert.ok(!after.some(message => message.includes(who.token.split('.')[2])), 'no token reaches the log');
});

test('issuer rule: a session naming our client id in azp, or in aud without azp, is a person; another client is refused', clientIds, async () => {
  const count = logs => logCount(logs, BROWSER_ISSUER, ENFORCE ? 'refused' : 'would refuse');
  const keycloak = person({ azp: CLIENT }), noAzp = person({ azp: undefined, aud: CLIENT });
  const before = count(await logLines());
  for (const who of [keycloak, noAzp]) await ok(who.token, 'join_board', [named('client'), 'agent']);
  assert.equal(count(await logLines()), before, 'no accepted session is logged');
  for (const who of [keycloak, noAzp]) assert.equal((await participantOf(who)).kind, 'human');
  const other = await call(person({ azp: undefined, aud: 'other-client' }).token, 'join_board', [named('client'), 'human']);
  assert.equal(other.status, ENFORCE ? 403 : 200, other.text);
  assert.equal(count(await logLines()), before + 1, 'a token for another client is logged');
});

// --- RC-571: the write budget ------------------------------------------------------

const WRITE_RULE = 'write rule: too many writes from this identity; wait a minute';

/** `who` owns a board with one node; two writes spent. */
async function noteNode(who, label) {
  const B = await createBoardAs(who, named(label));
  return nodeAs(who, B, 'note');
}
/** n set_node_doc calls at once: how many landed, the refusals' texts, and how long it took (for the refill). */
async function burst(who, nodeId, n) {
  const started = Date.now();
  const results = await Promise.all(Array.from({ length: n }, (_, i) => call(who.token, 'set_node_doc', [nodeId, `write ${i}`])));
  return { landed: results.filter(r => r.status === 200).length, refusals: results.filter(r => r.status !== 200).map(r => r.text), seconds: (Date.now() - started) / 1000 };
}
/** Up to `perMinute` writes a minute: the bucket holds that many, refilled continuously while the burst runs. */
async function assertBudget(who, perMinute, label) {
  const nodeId = await noteNode(who, label);
  const sent = perMinute * 1.5;
  const { landed, refusals, seconds } = await burst(who, nodeId, sent);
  const most = perMinute - 2 + Math.ceil((seconds * perMinute) / 60);
  assert.ok(landed >= perMinute - 2 && landed <= most, `${landed} of ${sent} landed in ${seconds} s, want ${perMinute - 2}..${most}`);
  assert.ok(refusals.length > 0 && refusals.every(text => text === WRITE_RULE), `refused with the write rule: ${refusals[0]}`);
  // the write after the burst: a refused call spent nothing, and the bucket refills
  await sleep((60_000 / perMinute) * 1.5);
  await ok(who.token, 'set_node_doc', [nodeId, 'after']);
}

test('write budget: a guest gets 60 writes a minute, then the write rule', enforced, async () => {
  await assertBudget(await mint(), 60, 'budget-db-guest'); // a database-minted identity
  await assertBudget(guest(), 60, 'budget-our-guest'); // a guest: token of ours
});

test('write budget: a person and a hosted agent get 300 writes a minute', enforced, async () => {
  await assertBudget(person(), 300, 'budget-person');
  await assertBudget(agent(), 300, 'budget-agent');
});

test('write budget: a service account is never limited; presence and geometry spend nothing', enforced, async () => {
  const owner = person();
  const nodeId = await noteNode(owner, 'budget-service');
  const { landed } = await burst(svc, nodeId, 400);
  assert.equal(landed, 400);
  const g = await mint();
  const own = await noteNode(g, 'budget-geometry');
  const [{ boardId }] = await sql(OWNER, `SELECT board_id FROM node WHERE id = ${own}`);
  const moves = await Promise.all(Array.from({ length: 80 }, (_, i) => call(g.token, 'move_node', [own, 4 * i, 0])));
  const selections = await Promise.all(Array.from({ length: 80 }, () => call(g.token, 'set_selection', [boardId, [own]])));
  assert.deepEqual([...moves, ...selections].filter(r => r.status !== 200).map(r => r.text), [], 'a guest drags and selects past 60 calls');
});

test('fail closed: the committed none variant refuses a browser session, an agent and a DB-minted identity', closed, async () => {
  for (const who of [person(), agent(), await mint()]) {
    const result = await call(who.token, 'create_board', [named('closed')]);
    assert.equal(result.status, 403, result.text);
    assert.equal(result.text, 'issuer rule: tokens from this issuer are not accepted');
  }
  await assert.rejects(connect(person(), ['SELECT * FROM my_boards']), 'a live connection is refused too');
  const logs = await logLines();
  for (const iss of [BROWSER_ISSUER, OURS]) assert.ok(logs.includes(`issuer rule: refused ${iss}`), `the log names ${iss}`);
});

// --- Link sharing (docs/superpowers/specs/2026-10-15-link-sharing-design.md) ----

const linkToken = () => randomBytes(16).toString('hex');
const nodeArgs = (boardId, label) => [boardId, label, '', 0, 0, 160, 80, 'ink', false, ...Array(7).fill(NONE)];
const sees = async (who, B) => (await sql(who.token, `SELECT * FROM visible_board WHERE id = ${B}`)).length > 0;

test('link sharing: a view link lets anyone read after opening it, and nobody write', open, async () => {
  const owner = person(), anon = await mint(), signedIn = person();
  const B = await createBoardAs(owner, named('link-view'));
  const T = linkToken();
  await ok(owner.token, 'set_link_share', [B, 'view', T]);
  assert.equal(await sees(anon, B), false, 'the link exists, but an unopened link grants nothing');
  for (const who of [anon, signedIn]) {
    await ok(who.token, 'open_shared_link', [T]);
    await ok(who.token, 'open_shared_link', [T]); // idempotent
    assert.equal(await sees(who, B), true);
    await rejects(who.token, 'create_node', nodeArgs(B, 'x'), 'board is read only');
  }
  assert.equal((await sql(OWNER, `SELECT * FROM link_visit WHERE board_id = ${B}`)).length, 2, 'one visit row per viewer');
});

test('link sharing: an edit link lets signed-in visitors write; guests and DB identities stay read-only', open, async () => {
  const owner = person(), visitor = person(), g = guest(), anon = await mint();
  const B = await createBoardAs(owner, named('link-edit'));
  const T = linkToken();
  await ok(owner.token, 'set_link_share', [B, 'edit', T]);
  for (const who of [visitor, g, anon]) await ok(who.token, 'open_shared_link', [T]);
  await nodeAs(visitor, B, 'by visitor');
  for (const who of [g, anon]) await rejects(who.token, 'create_node', nodeArgs(B, 'x'), 'board is read only');
  await ok(owner.token, 'set_link_share', [B, 'view', linkToken()]);
  assert.equal((await sql(OWNER, `SELECT * FROM link_share WHERE board_id = ${B}`))[0].token, T, 'changing the mode keeps the token');
  await rejects(visitor.token, 'create_node', nodeArgs(B, 'y'), 'board is read only');
});

test('link sharing: a guest owner can share view/edit while retaining owner permissions', open, async () => {
  const owner = await mint(), visitor = person(), guestVisitor = guest();
  const B = await createBoardAs(owner, named('guest-share'));
  const T = linkToken();
  await ok(owner.token, 'set_link_share', [B, 'view', T]);
  for (const who of [owner, visitor, guestVisitor]) await ok(who.token, 'open_shared_link', [T]);
  await nodeAs(owner, B, 'guest owner on view link');
  for (const who of [visitor, guestVisitor]) {
    assert.equal(await sees(who, B), true);
    await rejects(who.token, 'create_node', nodeArgs(B, 'view edit'), 'board is read only');
  }
  assert.equal((await sql(owner.token, `SELECT * FROM my_boards WHERE board_id = ${B}`))[0].access, 'owner');

  await ok(owner.token, 'set_link_share', [B, 'edit', linkToken()]);
  await nodeAs(owner, B, 'guest owner on edit link');
  await nodeAs(visitor, B, 'account recipient on edit link');
  await rejects(guestVisitor.token, 'create_node', nodeArgs(B, 'guest edit'), 'board is read only');
  await ok(owner.token, 'stop_link_share', [B]);
  for (const who of [visitor, guestVisitor]) assert.equal(await sees(who, B), false);
  await nodeAs(owner, B, 'guest owner after revocation');
});

test('link sharing: owner agent grants survive downgrade/revoke and recipient agents inherit nothing', open, async () => {
  const owner = person(), visitor = person(), ownerAgent = agent(), visitorAgent = agent();
  const B = await createBoardAs(owner, named('agent-share'));
  await ok(svc.token, 'link_hosted_agent', [id(ownerAgent.identity), id(owner.identity)]);
  await ok(svc.token, 'link_hosted_agent', [id(visitorAgent.identity), id(visitor.identity)]);
  await ok(owner.token, 'grant_agent_board', [B, id(ownerAgent.identity)]);
  const grants = await sql(OWNER, `SELECT * FROM agent_grant WHERE board_id = ${B}`);
  const T = linkToken();
  await ok(owner.token, 'set_link_share', [B, 'edit', T]);
  await ok(visitor.token, 'open_shared_link', [T]);
  await nodeAs(visitor, B, 'account recipient');
  assert.equal(await sees(visitorAgent, B), false, 'a person opening the link grants nothing to their agent');
  await rejects(visitorAgent.token, 'create_node', nodeArgs(B, 'inherited edit'), 'board is unavailable');
  await rejects(visitor.token, 'grant_agent_board', [B, id(visitorAgent.identity)], 'only an owner');
  await rejects(owner.token, 'grant_agent_board', [B, id(visitorAgent.identity)], 'not linked to you');
  for (const who of [ownerAgent, visitorAgent]) {
    await ok(who.token, 'open_shared_link', [T]);
    await rejects(who.token, 'set_link_share', [B, 'edit', linkToken()], 'only an owner');
    await rejects(who.token, 'stop_link_share', [B], 'only an owner');
    await rejects(who.token, 'grant_agent_board', [B, id(who.identity)], 'only an owner');
    await rejects(who.token, 'revoke_agent_board', [B, id(who.identity)], 'only an owner');
  }
  await rejects(visitorAgent.token, 'create_node', nodeArgs(B, 'agent link edit'), 'board is read only');
  await nodeAs(ownerAgent, B, 'granted agent on edit link');
  const tabs = [];
  try {
    for (const who of [ownerAgent, visitor, visitorAgent]) tabs.push(await connect(who, ['SELECT * FROM visible_board', 'SELECT * FROM my_boards']));
    await ok(owner.token, 'set_link_share', [B, 'view', linkToken()]);
    await waitFor(() => [...tabs[1].db.myBoards.iter()].some(r => r.boardId === BigInt(B) && r.linkMode === 'view'), 'the recipient sees the downgrade live');
    await rejects(visitor.token, 'create_node', nodeArgs(B, 'downgraded edit'), 'board is read only');
    await nodeAs(ownerAgent, B, 'granted agent on view link');
    await ok(owner.token, 'stop_link_share', [B]);
    await waitFor(() => tabs.slice(1).every(tab => ![...tab.db.visibleBoard.iter()].some(b => b.id === BigInt(B))), 'both link-only identities lose live access');
    assert.ok([...tabs[0].db.visibleBoard.iter()].some(b => b.id === BigInt(B)), 'the independent agent grant keeps its live board');
    await nodeAs(ownerAgent, B, 'granted agent after revocation');
    await rejects(visitor.token, 'create_node', nodeArgs(B, 'revoked edit'), 'board is unavailable');
    await rejects(visitorAgent.token, 'create_node', nodeArgs(B, 'revoked agent edit'), 'board is unavailable');
    assert.deepEqual(await sql(OWNER, `SELECT * FROM agent_grant WHERE board_id = ${B}`), grants);
  } finally { for (const tab of tabs) tab.disconnect(); }
});

test('link sharing: a guest claim preserves shared visits and clears previous-owner agent grants', open, async () => {
  const owner = await mint(), account = person(), visitor = person(), guestVisitor = guest(), oldAgent = agent();
  await ok(owner.token, 'ensure_guest_board', [NONE]);
  const B = (await sql(owner.token, 'SELECT * FROM my_guest_board'))[0].boardId;
  await nodeAs(owner, B, 'drawing before claim');
  await ok(svc.token, 'link_hosted_agent', [id(oldAgent.identity), id(owner.identity)]);
  await ok(owner.token, 'grant_agent_board', [B, id(oldAgent.identity)]);
  await nodeAs(oldAgent, B, 'agent before claim');
  const T = linkToken();
  await ok(owner.token, 'set_link_share', [B, 'edit', T]);
  for (const who of [owner, visitor, guestVisitor]) await ok(who.token, 'open_shared_link', [T]);
  const shares = await sql(OWNER, `SELECT * FROM link_share WHERE board_id = ${B}`);
  const visits = await sql(OWNER, `SELECT * FROM link_visit WHERE board_id = ${B}`);
  const code = randomBytes(32).toString('hex');
  await ok(owner.token, 'offer_guest_claim', [B, code]);
  await ok(account.token, 'claim_guest_board', [B, code]);
  await ok(account.token, 'claim_guest_board', [B, code]);

  assert.deepEqual(await sql(OWNER, `SELECT * FROM link_share WHERE board_id = ${B}`), shares);
  assert.deepEqual(await sql(OWNER, `SELECT * FROM link_visit WHERE board_id = ${B}`), visits);
  assert.deepEqual(await sql(OWNER, `SELECT * FROM agent_grant WHERE board_id = ${B}`), []);
  assert.equal((await sql(account.token, `SELECT * FROM my_boards WHERE board_id = ${B}`))[0].access, 'owner');
  assert.equal((await sql(owner.token, `SELECT * FROM my_boards WHERE board_id = ${B}`))[0].access, 'link', 'the old guest retains only its separate link visit');
  assert.equal((await sql(account.token, `SELECT * FROM visible_node WHERE board_id = ${B}`)).length, 2, 'claiming retains the drawing');
  await nodeAs(account, B, 'account after claim');
  await nodeAs(visitor, B, 'recipient after claim');
  for (const who of [owner, guestVisitor]) await rejects(who.token, 'create_node', nodeArgs(B, 'guest after claim'), 'board is read only');
  assert.equal(await sees(oldAgent, B), false);
  await rejects(oldAgent.token, 'create_node', nodeArgs(B, 'agent after claim'), 'board is unavailable');
  await rejects(owner.token, 'stop_link_share', [B], 'only an owner');
  await ok(account.token, 'stop_link_share', [B]);
  for (const who of [owner, visitor, guestVisitor]) assert.equal(await sees(who, B), false);
});

test('link sharing: opening a link reaches visible_board while another tab is subscribed', open, async () => {
  const owner = person(), visitor = person();
  const B = await createBoardAs(owner, named('link-live'));
  const T = linkToken();
  await ok(owner.token, 'set_link_share', [B, 'view', T]);
  // The visitor already has a tab open, so their visible_board view is live before the visit.
  const before = await connect(visitor, ['SELECT * FROM visible_board', 'SELECT * FROM my_boards']);
  let after;
  try {
    await ok(visitor.token, 'open_shared_link', [T]);
    await waitFor(() => [...before.db.myBoards.iter()].some(r => r.boardId === BigInt(B)), 'my_boards gains the link row');
    await waitFor(() => [...before.db.visibleBoard.iter()].some(b => b.id === BigInt(B)), 'the open tab sees the board');
    after = await connect(visitor, ['SELECT * FROM visible_board']);
    assert.ok([...after.db.visibleBoard.iter()].some(b => b.id === BigInt(B)), 'a new tab sees the board');
  } finally { before.disconnect(); after?.disconnect(); }
});

test('link sharing: stopping ends access at once, even for a live subscription, and old links stay dead', open, async () => {
  const owner = person(), visitor = person();
  const B = await createBoardAs(owner, named('link-stop'));
  const T1 = linkToken(), T2 = linkToken();
  await ok(owner.token, 'set_link_share', [B, 'edit', T1]);
  await ok(visitor.token, 'open_shared_link', [T1]);
  const conn = await connect(visitor, ['SELECT * FROM visible_board']);
  try {
    await waitFor(() => [...conn.db.visibleBoard.iter()].some(b => b.id === BigInt(B)), 'the visitor sees the board');
    await ok(owner.token, 'stop_link_share', [B]);
    await waitFor(() => ![...conn.db.visibleBoard.iter()].some(b => b.id === BigInt(B)), 'stopping removes the board from a live subscription');
  } finally { conn.disconnect(); }
  await rejects(visitor.token, 'open_shared_link', [T1], 'This link is no longer shared.');
  await ok(owner.token, 'stop_link_share', [B]); // nothing to stop: no error
  await ok(owner.token, 'set_link_share', [B, 'view', T2]);
  await rejects(visitor.token, 'open_shared_link', [T1], 'This link is no longer shared.');
  assert.equal(await sees(visitor, B), false, 'the old visit row went with the old link');
  await ok(visitor.token, 'open_shared_link', [T2]);
  assert.equal(await sees(visitor, B), true);
});

test('link sharing: only the owner sets or stops a link; modes and tokens are checked', open, async () => {
  const owner = person(), other = person();
  const B = await createBoardAs(owner, named('link-owner'));
  const C = await createBoardAs(owner, named('link-owner-2'));
  const T = linkToken();
  const UPPER = '0123456789ABCDEF0123456789ABCDEF'; // T.toUpperCase() equals T when T has no a-f
  await rejects(other.token, 'set_link_share', [B, 'view', linkToken()], 'share rule: only an owner');
  await rejects(owner.token, 'set_link_share', [B, 'comment', T], "share rule: link mode must be 'view' or 'edit'");
  for (const bad of ['ABC', UPPER, '']) {
    await rejects(owner.token, 'set_link_share', [B, 'view', bad], 'share rule: link token must be 32 lowercase hex characters');
  }
  await ok(owner.token, 'set_link_share', [B, 'view', T]);
  await rejects(owner.token, 'set_link_share', [C, 'view', T], 'share rule: link token is already in use');
  await rejects(other.token, 'stop_link_share', [B], 'share rule: only an owner');
  for (const bad of ['0'.repeat(32), '', '../x', UPPER]) {
    await rejects(other.token, 'open_shared_link', [bad], 'This link is no longer shared.');
  }
});

test('link sharing: delete_board removes the link and its visits', open, async () => {
  const owner = person(), visitor = await mint();
  const B = await createBoardAs(owner, named('link-delete'));
  await ok(owner.token, 'set_link_share', [B, 'view', linkToken()]);
  const T = (await sql(OWNER, `SELECT * FROM link_share WHERE board_id = ${B}`))[0].token;
  await ok(visitor.token, 'open_shared_link', [T]);
  await ok(owner.token, 'delete_board', [B]);
  assert.deepEqual(await sql(OWNER, `SELECT * FROM link_share WHERE board_id = ${B}`), []);
  assert.deepEqual(await sql(OWNER, `SELECT * FROM link_visit WHERE board_id = ${B}`), []);
});

test('link sharing: my_boards lists opened links as access link; the token only for its holders', open, async () => {
  const owner = person(), visitor = person(), teammate = person(), stranger = person();
  const org = named('org-link');
  await ok(svc.token, 'set_org_memberships', [id(owner.identity), [org], ['org:admin']]);
  await ok(svc.token, 'set_org_memberships', [id(teammate.identity), [org], ['org:member']]);
  const B = await createBoardAs(owner, named('link-list'));
  await ok(owner.token, 'share_board_with_team', [B, org]);
  const T = linkToken();
  await ok(owner.token, 'set_link_share', [B, 'edit', T]);
  const row = async who => (await sql(who.token, 'SELECT * FROM my_boards')).find(r => String(r.boardId) === String(B));

  assert.deepEqual(pick(await row(owner), ['access', 'linkMode', 'linkToken']), { access: 'owner', linkMode: 'edit', linkToken: T });
  assert.deepEqual(pick(await row(teammate), ['access', 'linkMode', 'linkToken']), { access: 'team', linkMode: '', linkToken: '' }, 'no token before opening');
  assert.equal(await row(stranger), undefined);

  await ok(visitor.token, 'open_shared_link', [T]);
  await ok(teammate.token, 'open_shared_link', [T]);
  await ok(owner.token, 'open_shared_link', [T]);
  assert.deepEqual(pick(await row(visitor), ['access', 'linkMode', 'linkToken']), { access: 'link', linkMode: 'edit', linkToken: T });
  assert.deepEqual(pick(await row(teammate), ['access', 'linkToken']), { access: 'team', linkToken: T }, 'a stronger grant wins, and the token is now theirs');
  assert.equal((await row(owner)).access, 'owner');

  await ok(owner.token, 'stop_link_share', [B]);
  assert.equal(await row(visitor), undefined, 'the board leaves "Shared with you"');
  assert.deepEqual(pick(await row(owner), ['linkMode', 'linkToken']), { linkMode: '', linkToken: '' });
});

// --- code citations: members choose which of the owner's files are cited ---------

test("code citations: an edit-link visitor edits the board but never picks which of the owner's files are cited", open, async () => {
  const owner = person(), visitor = person(), member = person();
  await ok(owner.token, 'set_code_consent', [true]); // the refs below carry snippets
  const S = await sessionAs(owner, named('cite-link'));
  const a = await nodeAs(owner, S, 'billing'), b = await nodeAs(owner, S, 'ledger');
  await ok(owner.token, 'add_repo_files', [S, ['src/billing/charge.ts']]);
  await ok(owner.token, 'create_edge', [S, a, b, 'writes', 'source:src/billing/charge.ts:1', NONE, NONE, NONE]);
  const [edge] = await sql(OWNER, `SELECT * FROM edge WHERE board_id = ${S}`);
  const T = linkToken();
  await ok(owner.token, 'set_link_share', [S, 'edit', T]);
  await ok(visitor.token, 'open_shared_link', [T]);
  await nodeAs(visitor, S, 'by visitor'); // the link does let them edit
  await ok(visitor.token, 'create_edge', [S, a, b, 'drawn', 'human:Vi', NONE, NONE, NONE]);
  // a cited path is a file the owner's helper uploads at the next checkpoint
  const CITE = 'only board members can cite';
  const ref = (path, symbol, node = a) => [S, 'node', node, path, symbol, 1, 1, SHA, `function ${symbol}() {}`, 'test'];
  await rejects(visitor.token, 'add_repo_files', [S, ['src/secrets.ts']], CITE);
  await rejects(visitor.token, 'add_code_ref', ref('src/billing/charge.ts', 'chargeCustomer'), CITE);
  await rejects(visitor.token, 'create_edge', [S, a, b, 'planted', 'source:src/billing/charge.ts:2', NONE, NONE, NONE], CITE);
  await rejects(visitor.token, 'update_edge_evidence', [edge.id, 'source:src/billing/charge.ts:3', 'stale'], CITE);
  // line hashes and the repo remote are the owner's code too (RC-690)
  const H = 'a'.repeat(32);
  await rejects(visitor.token, 'set_edge_evidence_code', [edge.id, H, NONE], CITE);
  await rejects(visitor.token, 'set_session_remote', [S, 'https://github.com/example/repo', '', []], CITE);
  assert.deepEqual(await sql(OWNER, `SELECT * FROM code_ref WHERE board_id = ${S}`), []);
  assert.deepEqual((await sql(OWNER, `SELECT * FROM repo_file WHERE board_id = ${S}`)).map(f => f.path), ['src/billing/charge.ts']);
  // the owner, a team member and a service still cite
  const org = named('cite-org');
  await ok(svc.token, 'set_org_memberships', [id(owner.identity), [org], ['admin']]);
  await ok(svc.token, 'set_org_memberships', [id(member.identity), [org], ['member']]);
  await ok(owner.token, 'share_board_with_team', [S, org]);
  await ok(member.token, 'add_repo_files', [S, ['src/billing/refund.ts']]);
  await ok(member.token, 'add_code_ref', ref('src/billing/refund.ts', 'refund', b));
  await ok(owner.token, 'add_code_ref', ref('src/billing/charge.ts', 'chargeCustomer'));
  const charge = (await sql(OWNER, `SELECT * FROM code_ref WHERE board_id = ${S}`)).find(r => r.symbol === 'chargeCustomer');
  await rejects(visitor.token, 'set_code_ref_hashes', [charge.id, H], CITE);
  await ok(svc.token, 'create_edge', [S, b, a, 'reads', 'source:src/billing/refund.ts:1', NONE, NONE, NONE]);
  await ok(member.token, 'update_edge_evidence', [edge.id, 'source:src/billing/charge.ts:3', 'stale']);
});

// --- code consent (RC-690): a person sets their own, never their agent -------------

test("code consent: a person turns it on for their boards, which their hosted agent then fills; the agent cannot set it", open, async () => {
  const a = agent(), ann = person();
  await ok(svc.token, 'link_hosted_agent', [id(a.identity), id(ann.identity)]);
  await rejects(a.token, 'set_code_consent', [true], 'not authorized: an agent cannot change whether boards store code');
  assert.deepEqual(await sql(ann.token, 'SELECT * FROM my_code_consent'), [{ storeCode: false, boardsWithCode: 0 }]);
  await ok(ann.token, 'set_code_consent', [true]);
  // the agent's session board is Ann's, so it stores what the agent cites
  const S = await sessionAs(a, named('consent'));
  await ok(a.token, 'add_repo_files', [S, ['src/a.ts']]);
  await ok(a.token, 'add_code_ref', [S, 'node', await nodeAs(a, S, 'api'), 'src/a.ts', 'verify', 1, 1, SHA, 'function verify() {}', 'agent']);
  assert.deepEqual(await sql(ann.token, 'SELECT * FROM my_code_consent'), [{ storeCode: true, boardsWithCode: 1 }]);
});

// --- threats: who may contain one, and members only (blast radius spec 2026-10-16) ----

const CONTAIN_RULE = 'only a signed-in person with edit access can contain a threat';
const MEMBERS_RULE = 'only board members can see or change threats';
const threatOn = async threatId => (await sql(OWNER, `SELECT * FROM threat WHERE id = ${threatId}`))[0];
// addThreat: boardId, anchorId, stage, severity, title, summary, cvss, package, fixedIn, flags, source, author
const threatArgs = (B, anchorId) => [B, anchorId, 'vulnerable', 'high', 'openssl RCE', 'Heap overflow in the TLS parser.', '9.8', 'openssl@3.0.1', '3.0.7', '["cve"]', '', 'agent'];

/** A board `who` owns with one open threat on its only node. */
async function threatened(who, label) {
  const B = await createBoardAs(who, named(label));
  const api = await nodeAs(who, B, 'API');
  await ok(who.token, 'add_threat', threatArgs(B, api));
  const [row] = await sql(OWNER, `SELECT * FROM threat WHERE board_id = ${B}`);
  return { B, api, threat: row.id };
}

test('threats: a signed-in person with edit access contains a threat and reopens it', open, async () => {
  const owner = person();
  await ok(owner.token, 'join_board', ['Ada Responder', 'human']);
  const r = await threatened(owner, 'th-contain');
  await ok(owner.token, 'set_threat_contained', [r.threat, true]);
  let row = await threatOn(r.threat);
  assert.equal(row.containedBy, 'Ada Responder');
  assert.ok(micros(row.containedAt) > 0);
  const events = await sql(OWNER, `SELECT * FROM activity_outbox WHERE board_id = ${r.B}`);
  assert.deepEqual(events.filter(e => e.type === 'threat.contained').map(e => JSON.parse(e.payload)), [{}]);
  await ok(owner.token, 'set_threat_contained', [r.threat, false]);
  row = await threatOn(r.threat);
  assert.deepEqual([row.containedBy, micros(row.containedAt)], ['', 0]);
});

test('threats: agents and guests cannot contain a threat', open, async () => {
  const a = agent();
  const own = await threatened(a, 'th-contain-agent');
  await rejects(a.token, 'set_threat_contained', [own.threat, true], CONTAIN_RULE);
  const g = guest();
  const guestBoard = await threatened(g, 'th-contain-guest');
  await rejects(g.token, 'set_threat_contained', [guestBoard.threat, true], CONTAIN_RULE);
  const stdio = await mint();
  await ok(stdio.token, 'join_board', [named('stdio agent'), 'agent']);
  const local = await threatened(stdio, 'th-contain-stdio');
  await rejects(stdio.token, 'set_threat_contained', [local.threat, true], CONTAIN_RULE);
  for (const r of [own, guestBoard, local]) assert.equal((await threatOn(r.threat)).containedBy, '');
});

test('threats: an edit-link visitor can edit the board but not see or change its threats', open, async () => {
  const owner = person(), visitor = person();
  const r = await threatened(owner, 'th-edit-link');
  const T = linkToken();
  await ok(owner.token, 'set_link_share', [r.B, 'edit', T]);
  await ok(visitor.token, 'open_shared_link', [T]);
  await nodeAs(visitor, r.B, 'by visitor'); // the link does let them edit
  assert.deepEqual(await sql(visitor.token, `SELECT * FROM visible_threat WHERE board_id = ${r.B}`), []);
  await rejects(visitor.token, 'add_threat', threatArgs(r.B, r.api), MEMBERS_RULE);
  await rejects(visitor.token, 'update_threat', [r.threat, ...Array(9).fill(NONE)], MEMBERS_RULE);
  await rejects(visitor.token, 'remove_threat', [r.threat], MEMBERS_RULE);
  await rejects(visitor.token, 'set_threat_contained', [r.threat, true], MEMBERS_RULE);
  assert.equal((await threatOn(r.threat)).containedBy, '');
  assert.equal((await sql(OWNER, `SELECT * FROM threat WHERE board_id = ${r.B}`)).length, 1);
});

test('edge style (RC-688): a signed-in edit-link visitor styles an edge, which the owner sees', open, async () => {
  const owner = person(), visitor = person();
  const B = await createBoardAs(owner, named('style-link'));
  const a = await nodeAs(owner, B, 'api'), b = await nodeAs(owner, B, 'db');
  await ok(owner.token, 'create_edge', [B, a, b, 'reads', 'human:Ow', NONE, NONE, NONE]);
  const [edge] = await sql(OWNER, `SELECT * FROM edge WHERE board_id = ${B}`);
  const T = linkToken();
  await ok(owner.token, 'set_link_share', [B, 'edit', T]);
  await ok(visitor.token, 'open_shared_link', [T]);
  await ok(visitor.token, 'update_edge_style', [edge.id, { some: 'green' }, { some: 'dashed' }]);
  await ok(visitor.token, 'set_edge_weight', [edge.id, 'medium']);
  const [seen] = (await sql(owner.token, `SELECT * FROM visible_edge WHERE board_id = ${B}`));
  assert.deepEqual([seen.color, seen.strokeStyle], ['green', 'dashed']);
  assert.deepEqual(await sql(owner.token, `SELECT * FROM visible_edge_weight WHERE board_id = ${B}`), [{ edgeId: edge.id, boardId: B, weight: 'medium' }]);
  // the same link back to view: the visitor reads the style and can no longer change it
  await ok(owner.token, 'set_link_share', [B, 'view', T]);
  await rejects(visitor.token, 'set_edge_weight', [edge.id, 'bold'], 'read only');
  assert.equal((await sql(visitor.token, `SELECT * FROM visible_edge_weight WHERE board_id = ${B}`))[0]?.weight, 'medium');
});

// --- change notes: who may review (spec 2026-10-16, D12) ------------------------

const REVIEW_RULE = 'only a signed-in person with edit access can review a change note';
const SHA2 = 'b'.repeat(40);
const noteOn = async noteId => (await sql(OWNER, `SELECT * FROM change_note WHERE id = ${noteId}`))[0];
// patch for updateChangeNote: id, kind, severity, title, summary, refId, steps, schema, subjects, readers
const notePatch = (noteId, o = {}) => [
  noteId, ...['kind', 'severity', 'title', 'summary', 'refId', 'steps', 'schema', 'subjects', 'readers'].map(k => (k in o ? { some: o[k] } : NONE)),
];

/** A board `who` makes with a migration note on Postgres and one reader. Its refs carry snippets, so `consent` opts in (RC-690). */
async function reviewable(who, label, consent = who) {
  await ok(consent.token, 'set_code_consent', [true]);
  const B = await createBoardAs(who, named(label));
  const pg = await nodeAs(who, B, 'Postgres');
  const worker = await nodeAs(who, B, 'Invoice worker');
  await ok(who.token, 'add_repo_files', [B, ['migrations/0042.sql', 'migrations/0042_v2.sql', 'bill-to.ts']]);
  await ok(who.token, 'add_code_ref', [B, 'node', pg, 'migrations/0042.sql', 'customers', 1, 3, SHA, 'ALTER TABLE customers\n  DROP COLUMN name;\n', 'agent']);
  await ok(who.token, 'add_code_ref', [B, 'node', worker, 'bill-to.ts', 'loadBillTo', 1, 1, SHA, 'function loadBillTo(row) { return row.name; }', 'agent']);
  await ok(who.token, 'add_code_ref', [B, 'node', pg, 'migrations/0042_v2.sql', 'customers', 1, 3, SHA, 'ALTER TABLE customers\n  DROP COLUMN name;\n', 'agent']);
  const refs = await sql(OWNER, `SELECT * FROM code_ref WHERE board_id = ${B}`);
  const mainRef = refs.find(r => r.path === 'migrations/0042.sql').id, readerRef = refs.find(r => r.path === 'bill-to.ts').id;
  const altRef = refs.find(r => r.path === 'migrations/0042_v2.sql').id;
  await ok(who.token, 'add_change_note', [
    B, pg, 'migration', 'destructive', 'Migration 0042', 'Drops customers.name.', mainRef,
    JSON.stringify([{ label: 'drop name', startLine: 2, endLine: 2, irreversible: true }]), '',
    JSON.stringify([{ table: 'customers', column: 'name' }]), JSON.stringify([{ refId: String(readerRef), subject: 0 }]), 'agent',
  ]);
  const [note] = await sql(OWNER, `SELECT * FROM change_note WHERE board_id = ${B}`);
  return { B, pg, mainRef, altRef, readerRef, note: note.id };
}

test('change notes: a signed-in person with edit access marks a note reviewed and clears it', open, async () => {
  const owner = person();
  await ok(owner.token, 'join_board', ['Ada Reviewer', 'human']);
  const r = await reviewable(owner, 'cn-review');
  await ok(owner.token, 'mark_change_note_reviewed', [r.note, true]);
  let n = await noteOn(r.note);
  assert.equal(n.reviewedBy, `Ada Reviewer (${owner.identity.slice(0, 12)})`);
  assert.ok(micros(n.reviewedAt) > 0);
  assert.equal(n.reviewedSha, n.refFileSha);
  const events = await sql(OWNER, `SELECT * FROM activity_outbox WHERE board_id = ${r.B}`);
  assert.ok(events.some(e => e.type === 'changenote.reviewed'));
  await ok(owner.token, 'mark_change_note_reviewed', [r.note, false]);
  n = await noteOn(r.note);
  assert.deepEqual([n.reviewedBy, micros(n.reviewedAt), n.reviewedSha], ['', 0, '']);
});

test('change notes: a review names its reviewer by identity, so an edit-link visitor cannot sign as someone else', open, async () => {
  const owner = person(), impostor = person();
  await ok(owner.token, 'join_board', ['Ada Reviewer', 'human']);
  const r = await reviewable(owner, 'cn-review-impostor');
  await ok(owner.token, 'mark_change_note_reviewed', [r.note, true]);
  const real = (await noteOn(r.note)).reviewedBy;
  await ok(owner.token, 'mark_change_note_reviewed', [r.note, false]);
  const T = linkToken();
  await ok(owner.token, 'set_link_share', [r.B, 'edit', T]);
  await ok(impostor.token, 'open_shared_link', [T]);
  await ok(impostor.token, 'join_board', ['Ada Reviewer', 'human']);
  await ok(impostor.token, 'mark_change_note_reviewed', [r.note, true]);
  assert.notEqual((await noteOn(r.note)).reviewedBy, real);
});

test('change notes: agents, guests and view-link visitors cannot review', open, async () => {
  // a hosted agent cannot opt in to stored code; its person does, and the board it makes is theirs
  const a = agent(), ann = person();
  await ok(svc.token, 'link_hosted_agent', [id(a.identity), id(ann.identity)]);
  const drawn = await reviewable(a, 'cn-review-agent', ann);
  await rejects(a.token, 'mark_change_note_reviewed', [drawn.note, true], REVIEW_RULE);
  const stdio = await mint();
  await ok(stdio.token, 'join_board', [named('stdio agent'), 'agent']);
  const local = await reviewable(stdio, 'cn-review-stdio');
  await rejects(stdio.token, 'mark_change_note_reviewed', [local.note, true], REVIEW_RULE);
  const g = guest();
  const guestBoard = await reviewable(g, 'cn-review-guest');
  await rejects(g.token, 'mark_change_note_reviewed', [guestBoard.note, true], REVIEW_RULE);
  const owner = person(), viewer = person();
  const r = await reviewable(owner, 'cn-review-view');
  const T = linkToken();
  await ok(owner.token, 'set_link_share', [r.B, 'view', T]);
  await ok(viewer.token, 'open_shared_link', [T]);
  await rejects(viewer.token, 'mark_change_note_reviewed', [r.note, true], 'board is read only');
  assert.equal((await noteOn(r.note)).reviewedBy, '');
});

test('change notes: the review clears when what was reviewed changes', open, async () => {
  const owner = person();
  await ok(owner.token, 'join_board', ['Bo Reviewer', 'human']);
  const r = await reviewable(owner, 'cn-review-clear');
  const reviewed = async () => (await noteOn(r.note)).reviewedBy !== '';
  const review = () => ok(owner.token, 'mark_change_note_reviewed', [r.note, true]);
  await review();
  await ok(owner.token, 'update_change_note', notePatch(r.note, { title: 'Migration 0042 (split)', summary: 'Still drops customers.name.' }));
  assert.equal(await reviewed(), true, 'title and summary keep the review');
  for (const change of [
    { severity: 'notable' },
    { steps: JSON.stringify([{ label: 'drop', startLine: 1, endLine: 2 }]) },
    { schema: JSON.stringify({ table: 'customers', columns: [{ name: 'name', type: 'text', change: 'dropped' }] }) },
    { subjects: JSON.stringify([{ table: 'customers', column: 'name', aliases: ['fullName'] }]) },
    { refId: r.altRef },
  ]) {
    await review();
    await ok(owner.token, 'update_change_note', notePatch(r.note, change));
    assert.equal(await reviewed(), false, `${Object.keys(change)[0]} clears the review`);
  }
  await review();
  const readers = JSON.stringify([{ refId: String(r.readerRef), subject: 0, status: 'stale', checkpoint: 1 }]);
  await ok(owner.token, 'set_change_note_readers', [r.note, readers, (await noteOn(r.note)).refFileSha]);
  assert.equal(await reviewed(), true, 'the same file keeps the review');
  await ok(owner.token, 'set_change_note_readers', [r.note, readers, SHA2]);
  assert.equal(await reviewed(), false, 'an edited migration file clears the review');
});
