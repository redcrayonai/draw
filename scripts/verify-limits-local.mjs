// The storage limits (module/src/limits.ts) on a published module.
// Run through scripts/stdb-test.sh: it skips unless the module was published
// with REDCRAYON_LIMITS=on (module-tests sets it for staging and production).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

const { STDB_URL: BASE, STDB_DB: DB, STDB_OWNER_TOKEN: OWNER, REDCRAYON_LIMITS } = process.env;
if (!BASE || !DB || !OWNER || DB === 'redcrayon') throw new Error('run through scripts/stdb-test.sh with an isolated database');
const skip = REDCRAYON_LIMITS === 'on' ? false : 'the module was published without REDCRAYON_LIMITS=on';

const NONE = { none: [] };
const RUN = randomBytes(6).toString('hex');
const named = name => `${name}-${RUN}`;
const nodeArgs = (B, label) => [B, label, '', 0, 0, 160, 80, 'ink', false, ...Array(7).fill(NONE)];

async function mint() {
  const r = await fetch(`${BASE}/v1/identity`, { method: 'POST' });
  assert.equal(r.status, 200);
  return r.json();
}
async function call(who, reducer, args = []) {
  const r = await fetch(`${BASE}/v1/database/${DB}/call/${reducer}`, {
    method: 'POST', headers: { Authorization: `Bearer ${who.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args, (_k, v) => (typeof v === 'bigint' ? JSON.rawJSON(v.toString()) : v)),
  });
  return { status: r.status, text: await r.text() };
}
async function ok(who, reducer, args) {
  const r = await call(who, reducer, args);
  assert.equal(r.status, 200, `${reducer}: ${r.text}`);
}
async function refused(who, reducer, args, needle) {
  const r = await call(who, reducer, args);
  assert.equal(r.status, 530, `${reducer} should be refused: ${r.status} ${r.text}`);
  assert.ok(r.text.includes(needle), `${reducer}: expected "${needle}" in "${r.text}"`);
}
async function sql(token, query) {
  const r = await fetch(`${BASE}/v1/database/${DB}/sql`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' }, body: query });
  const text = await r.text();
  assert.equal(r.status, 200, `${query}: ${text}`);
  const [res] = JSON.parse(text);
  const cols = res.schema.elements.map(e => e.name?.some ?? e.name);
  return res.rows.map(row => Object.fromEntries(cols.map((c, i) => [c, row[i]])));
}
async function boardOf(who, label) {
  await ok(who, 'create_board', [named(label)]);
  return (await sql(OWNER, `SELECT id FROM board WHERE name = '${named(label)}'`))[0].id;
}
const paths = (n, from = 0) => Array.from({ length: n }, (_, i) => `src/f${from + i}.ts`);

test('repo files: at most 5000 paths per call, 4096 characters per path, 50000 per board', { skip }, async () => {
  const who = await mint();
  const B = await boardOf(who, 'limit-files');
  await refused(who, 'add_repo_files', [B, paths(5001)], 'at most 5000 repo files per call');
  await refused(who, 'add_repo_files', [B, [`src/${'a'.repeat(4093)}`]], 'at most 4096 characters');
  for (let i = 0; i < 10; i++) await ok(who, 'add_repo_files', [B, paths(5000, i * 5000)]);
  await ok(who, 'add_repo_files', [B, paths(10)]); // repeats are skipped, not counted
  await refused(who, 'add_repo_files', [B, ['src/one-more.ts']], 'at most 50000 repo files');
});

test('a node doc holds at most 65536 characters', { skip }, async () => {
  const who = await mint();
  const B = await boardOf(who, 'limit-doc');
  await ok(who, 'create_node', nodeArgs(B, 'a'));
  const [n] = await sql(OWNER, `SELECT id FROM node WHERE board_id = ${B}`);
  await ok(who, 'set_node_doc', [n.id, 'x'.repeat(65536)]);
  await refused(who, 'set_node_doc', [n.id, 'x'.repeat(65537)], 'at most 65536 characters');
});

test('a guest owns at most 20 boards', { skip }, async () => {
  const who = await mint();
  for (let i = 0; i < 20; i++) await ok(who, 'create_board', [named(`limit-guest-${i}`)]);
  await refused(who, 'create_board', [named('limit-guest-20')], 'at most 20 boards');
});

test('a board has at most 20 branches; a repeated request still answers', { skip }, async () => {
  const base = await mint(), co = await mint();
  const B = await boardOf(base, 'limit-fork');
  await ok(base, 'create_node', nodeArgs(B, 'a'));
  // A branch belongs to whoever forks it: two owners keep each under the 20-board guest allowance.
  await sql(OWNER, `INSERT INTO board_grant (id, board_id, grantee, role) VALUES (0, ${B}, 0x${co.identity}, 'owner')`);
  for (let i = 0; i < 20; i++) await ok(i < 10 ? base : co, 'create_architecture_proposal', [B, named(`fork-${i}`), named(`fork-${i}`)]);
  await ok(base, 'create_architecture_proposal', [B, named('fork-0'), named('fork-0')]);
  await refused(base, 'create_architecture_proposal', [B, named('fork-20'), named('fork-20')], 'at most 20 branches');
});

test('an identity keeps at most 4 waiting mark seats on a board; a new seat replaces the oldest', { skip }, async () => {
  const who = await mint();
  const B = await boardOf(who, 'limit-seats');
  await ok(who, 'join_board', ['seat tester', 'agent']);
  const seats = Array.from({ length: 6 }, (_, i) => `seat${String(i).padStart(12, '0')}`);
  for (const seat of seats) await ok(who, 'claim_marks', [B, seat]);
  const rows = (await sql(OWNER, `SELECT * FROM mark_waiter WHERE board_id = ${B}`)).map(r => r.owner.split('/')[1]).sort();
  assert.deepEqual(rows, seats.slice(2));
});
