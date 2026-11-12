// Module integration suite for tellings (save_telling, remove_telling).
// Talks to an ISOLATED database over the HTTP API only, like scripts/verify-threats-local.mjs:
//
//   nix develop --command scripts/stdb-test.sh run scripts/verify-tellings-local.mjs
//
// Who reads visible_telling is tested in scripts/verify-access-local.mjs, restore in
// scripts/verify-versions-local.mjs. Every test mints its own identities and boards.
import { test } from 'node:test';
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

const RUN = Date.now().toString(36);
const NONE = { none: [] };
const named = s => `${s}-${RUN}`;

// --- HTTP API (verbatim from verify-threats-local.mjs) -----------------------

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
const nodeArgs = (boardId, label) => [boardId, label, '', 0, 0, 160, 80, 'ink', false, NONE, NONE, NONE, NONE, NONE, NONE, NONE];

async function createBoardAs(who, name) {
  await ok(who.token, 'create_board', [name]);
  const rows = await sql(OWNER, `SELECT id FROM board WHERE name = '${name}'`);
  assert.equal(rows.length, 1, `exactly one board named ${name}`);
  return rows[0].id;
}

async function nodeAs(who, boardId, label) {
  await ok(who.token, 'create_node', nodeArgs(boardId, label));
  return (await sql(OWNER, `SELECT * FROM node WHERE board_id = ${boardId} AND label = '${label}'`))[0].id;
}

const tellingsOn = boardId => sql(OWNER, `SELECT * FROM telling WHERE board_id = ${boardId}`);

/** A board with two nodes. */
async function scenario(label) {
  const who = await mint();
  const B = await createBoardAs(who, named(label));
  const api = await nodeAs(who, B, 'API');
  const db = await nodeAs(who, B, 'DB');
  return { who, B, api, db };
}

const stepsOf = (...steps) => JSON.stringify(steps);
// saveTelling: boardId, audience, title, steps, author
const saveArgs = (s, o = {}) => [
  s.B, o.audience ?? 'product', o.title ?? 'How checkout works',
  o.steps ?? stepsOf({ nodes: [String(s.api)], title: 'The API', body: 'Every request starts here.' }), o.author ?? 'agent',
];

// --- save ----------------------------------------------------------------------

test('TL save stores one row with the normalised steps', async () => {
  const s = await scenario('tl-save');
  const steps = stepsOf({ nodes: [String(s.api), String(s.api)], title: '  The API ', body: 'Every request starts here.' });
  await ok(s.who.token, 'save_telling', saveArgs(s, { audience: ' product ', title: ' Checkout ', steps }));
  const rows = await tellingsOn(s.B);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].audience, rows[0].title, rows[0].author], ['product', 'Checkout', 'agent']);
  assert.deepEqual(JSON.parse(rows[0].steps), [{ nodes: [String(s.api)], frame: [], title: 'The API', body: 'Every request starts here.', source: '' }]);
});

test('TL saving the same audience again replaces the row in place, with the new spelling', async () => {
  const s = await scenario('tl-replace');
  await ok(s.who.token, 'save_telling', saveArgs(s, { audience: 'Product', title: 'First' }));
  const [first] = await tellingsOn(s.B);
  await ok(s.who.token, 'save_telling', saveArgs(s, { audience: 'product', title: 'Second' }));
  const rows = await tellingsOn(s.B);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].id, rows[0].audience, rows[0].title], [first.id, 'product', 'Second']);
});

test('TL a seventh audience is refused', async () => {
  const s = await scenario('tl-limit');
  for (let i = 1; i <= 6; i++) await ok(s.who.token, 'save_telling', saveArgs(s, { audience: `audience ${i}` }));
  await rejects(s.who.token, 'save_telling', saveArgs(s, { audience: 'audience 7' }),
    'telling rule: at most 6 tellings on a board; this board has: audience 1, audience 2, audience 3, audience 4, audience 5, audience 6');
  // Replacing one of the six still works.
  await ok(s.who.token, 'save_telling', saveArgs(s, { audience: 'AUDIENCE 6', title: 'again' }));
  assert.equal((await tellingsOn(s.B)).length, 6);
});

test('TL a node from another board is refused', async () => {
  const s = await scenario('tl-other');
  const other = await scenario('tl-other-b');
  const steps = stepsOf({ nodes: [String(other.api)], title: 'Elsewhere', body: 'Not on this board.' });
  await rejects(s.who.token, 'save_telling', saveArgs(s, { steps }), 'which is not on this board');
  assert.deepEqual(await tellingsOn(s.B), []);
});

test('TL head and author rules', async () => {
  const s = await scenario('tl-head');
  await rejects(s.who.token, 'save_telling', saveArgs(s, { audience: '  ' }), 'telling rule: audience must be 1 to 40 characters');
  await rejects(s.who.token, 'save_telling', saveArgs(s, { title: '' }), 'telling rule: title must be 1 to 120 characters');
  await rejects(s.who.token, 'save_telling', saveArgs(s, { author: 'a'.repeat(81) }), 'telling rule: author must be at most 80 characters');
  await rejects(s.who.token, 'save_telling', saveArgs(s, { steps: '[]' }), 'telling rule: steps must be a non-empty array');
});

test('TL a stranger is refused', async () => {
  const s = await scenario('tl-stranger');
  const stranger = await mint();
  await rejects(stranger.token, 'save_telling', saveArgs(s), 'not authorized');
  await ok(s.who.token, 'save_telling', saveArgs(s));
  await rejects(stranger.token, 'remove_telling', [s.B, 'product'], 'not authorized');
  assert.equal((await tellingsOn(s.B)).length, 1);
});

// --- remove --------------------------------------------------------------------

test('TL remove deletes the row; removing again is refused', async () => {
  const s = await scenario('tl-remove');
  await ok(s.who.token, 'save_telling', saveArgs(s, { audience: 'Product' }));
  await ok(s.who.token, 'remove_telling', [s.B, ' PRODUCT ']);
  assert.deepEqual(await tellingsOn(s.B), []);
  await rejects(s.who.token, 'remove_telling', [s.B, 'product'], 'telling rule: no telling for that audience on this board; this board has none');
});

test('TL removing an unknown audience names the audiences the board has', async () => {
  const s = await scenario('tl-remove-list');
  await ok(s.who.token, 'save_telling', saveArgs(s, { audience: 'Product' }));
  await ok(s.who.token, 'save_telling', saveArgs(s, { audience: 'Engineers' }));
  await rejects(s.who.token, 'remove_telling', [s.B, 'sales'], 'telling rule: no telling for that audience on this board; this board has: Product, Engineers');
});

// --- lifecycle -----------------------------------------------------------------

test('TL deleting a named node leaves the telling unchanged', async () => {
  const s = await scenario('tl-node');
  const steps = stepsOf({ nodes: [String(s.api), String(s.db)], title: 'Both', body: 'The API reads the DB.' });
  await ok(s.who.token, 'save_telling', saveArgs(s, { steps }));
  const before = await tellingsOn(s.B);
  await ok(s.who.token, 'delete_node', [s.db]);
  assert.deepEqual(await tellingsOn(s.B), before);
});
