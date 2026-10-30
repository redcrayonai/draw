// Module integration suite for threats (spec docs/superpowers/specs/2026-10-16-threat-blast-radius-design.md).
// Talks to an ISOLATED database over the HTTP API only, like scripts/verify-change-notes-local.mjs:
//
//   nix develop --command scripts/stdb-test.sh run scripts/verify-threats-local.mjs
//
// Who may contain a threat is tested in scripts/verify-issuers-local.mjs, and the members-only
// view in scripts/verify-access-local.mjs. Every test mints its own identities and boards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  THREAT_STAGE_RULE, THREAT_SEVERITY_RULE, THREAT_TITLE_RULE, THREAT_SUMMARY_RULE,
  THREAT_JSON_RULE, THREAT_FLAGS_RULE, THREAT_URL_RULE, THREAT_STAGE_LOWER_RULE, THREAT_FIELD_RULE,
} from '../module/src/threats.ts';

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
const MEMBERS_RULE = 'only board members can see or change threats';
const ANCHOR_RULE = 'threat anchor must be a service, datastore or external node on this board';

// --- HTTP API (verbatim from verify-change-notes-local.mjs) -------------------

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
const nodeArgs = (boardId, label, kind) => [boardId, label, '', 0, 0, 160, 80, 'ink', false, kind ? some(kind) : NONE, NONE, NONE, NONE, NONE, NONE, NONE];
const CSV = 'time,p99\n10:00,40\n10:05,44\n10:10,41\n';

async function boardIdOf(name) {
  const rows = await sql(OWNER, `SELECT id FROM board WHERE name = '${name}'`);
  assert.equal(rows.length, 1, `exactly one board named ${name}`);
  return rows[0].id;
}

async function createBoardAs(who, name) {
  await ok(who.token, 'create_board', [name]);
  return boardIdOf(name);
}

const nodeOf = async (boardId, label) => (await sql(OWNER, `SELECT * FROM node WHERE board_id = ${boardId} AND label = '${label}'`))[0].id;
const threatsOn = boardId => sql(OWNER, `SELECT * FROM threat WHERE board_id = ${boardId}`);
const threatOf = async id => (await sql(OWNER, `SELECT * FROM threat WHERE id = ${id}`))[0];
const micros = v => Number(Array.isArray(v) ? v[0] : v.__timestamp_micros_since_unix_epoch__);

async function nodeAs(who, boardId, label, kind) {
  await ok(who.token, 'create_node', nodeArgs(boardId, label, kind));
  return nodeOf(boardId, label);
}

const FLAGS = JSON.stringify(['cve', 'rce']);
const SOURCE = JSON.stringify({ system: 'Trivy', ref: 'CVE-2026-1234', url: 'https://example.com/cve' });

/** A board with a service, a note, a boundary and a chart. */
async function scenario(label) {
  const who = await mint();
  const B = await createBoardAs(who, named(label));
  const api = await nodeAs(who, B, 'API');
  const note = await nodeAs(who, B, 'a note', 'note');
  const boundary = await nodeAs(who, B, 'a boundary', 'boundary');
  await ok(who.token, 'create_chart', [B, 'a chart', '', 0, 0, 352, 224, 'timeseries', CSV, NONE, NONE]);
  const chart = await nodeOf(B, 'a chart');
  return { who, B, api, note, boundary, chart };
}

// addThreat: boardId, anchorId, stage, severity, title, summary, cvss, package, fixedIn, flags, source, author
const threatArgs = (s, o = {}) => [
  s.B, o.anchorId ?? s.api, o.stage ?? 'vulnerable', o.severity ?? 'high', o.title ?? 'openssl RCE',
  o.summary ?? 'Heap overflow in the TLS parser.', o.cvss ?? '9.8', o.package ?? 'openssl@3.0.1', o.fixedIn ?? '3.0.7',
  o.flags ?? FLAGS, o.source ?? SOURCE, o.author ?? 'agent',
];
// updateThreat: id, stage, severity, title, summary, cvss, package, fixedIn, flags, source (all optional)
const patch = (id, o = {}) => [
  id, ...['stage', 'severity', 'title', 'summary', 'cvss', 'package', 'fixedIn', 'flags', 'source'].map(k => (k in o ? some(o[k]) : NONE)),
];

async function threatAs(s, o = {}) {
  await ok(s.who.token, 'add_threat', threatArgs(s, o));
  const rows = await threatsOn(s.B);
  return rows[rows.length - 1].id;
}

// --- add ---------------------------------------------------------------------

test('TH add stores the threat open', async () => {
  const s = await scenario('th-add');
  const id = await threatAs(s);
  const r = await threatOf(id);
  assert.equal(r.boardId, s.B);
  assert.equal(r.anchorId, s.api);
  assert.deepEqual(
    [r.stage, r.severity, r.title, r.summary, r.cvss, r.package, r.fixedIn, r.flags, r.source, r.author],
    ['vulnerable', 'high', 'openssl RCE', 'Heap overflow in the TLS parser.', '9.8', 'openssl@3.0.1', '3.0.7', FLAGS, SOURCE, 'agent'],
  );
  assert.equal(r.containedBy, '');
  assert.equal(micros(r.containedAt), 0);
  assert.ok(micros(r.createdAt) > 0, 'createdAt is set');
  const events = await sql(OWNER, `SELECT * FROM activity_outbox WHERE board_id = ${s.B}`);
  // the feed reaches link visitors: the payload carries the stage only, never the title (T15)
  const added = events.filter(e => e.type === 'threat.added');
  assert.deepEqual(added.map(e => JSON.parse(e.payload)), [{ stage: 'vulnerable' }]);
});

test('TH add takes a datastore and an external node, and empty optional fields', async () => {
  const s = await scenario('th-kinds');
  const db = await nodeAs(s.who, s.B, 'Postgres', 'datastore');
  const ext = await nodeAs(s.who, s.B, 'Stripe', 'external');
  await ok(s.who.token, 'add_threat', threatArgs(s, { anchorId: db, flags: '', source: '', cvss: '', package: '', fixedIn: '' }));
  await ok(s.who.token, 'add_threat', threatArgs(s, { anchorId: ext }));
});

test('TH add refuses a note, boundary or chart anchor, and an anchor on another board', async () => {
  const s = await scenario('th-refuse');
  const t = await scenario('th-refuse-other');
  for (const anchorId of [s.note, s.boundary, s.chart, t.api]) {
    await rejects(s.who.token, 'add_threat', threatArgs(s, { anchorId }), ANCHOR_RULE);
  }
  await rejects(s.who.token, 'add_threat', threatArgs(s, { anchorId: 999999999n }), ANCHOR_RULE);
  assert.equal((await threatsOn(s.B)).length, 0);
  const stranger = await mint();
  await rejects(stranger.token, 'add_threat', threatArgs(s), 'not authorized');
});

test('TH add refuses each bad value with its rule', async () => {
  const s = await scenario('th-rules');
  for (const [o, rule] of [
    [{ stage: 'owned' }, THREAT_STAGE_RULE],
    [{ severity: 'severe' }, THREAT_SEVERITY_RULE],
    [{ title: '' }, THREAT_TITLE_RULE],
    [{ title: 'x'.repeat(121) }, THREAT_TITLE_RULE],
    [{ summary: ' ' }, THREAT_SUMMARY_RULE],
    [{ summary: 'x'.repeat(201) }, THREAT_SUMMARY_RULE],
    [{ flags: '{' }, THREAT_JSON_RULE],
    [{ source: '[]' }, THREAT_JSON_RULE],
    [{ flags: JSON.stringify(['a', 'b', 'c', 'd', 'e', 'f', 'g']) }, THREAT_FLAGS_RULE],
    [{ source: JSON.stringify({ system: 'Trivy', ref: 'x', url: 'http://example.com' }) }, THREAT_URL_RULE],
    [{ cvss: 'x'.repeat(9) }, THREAT_FIELD_RULE],
    [{ package: 'x'.repeat(121) }, THREAT_FIELD_RULE],
    [{ fixedIn: 'x'.repeat(41) }, THREAT_FIELD_RULE],
    [{ author: 'x'.repeat(81) }, THREAT_FIELD_RULE],
  ]) {
    await rejects(s.who.token, 'add_threat', threatArgs(s, o), rule);
  }
  assert.equal((await threatsOn(s.B)).length, 0);
});

// --- update ------------------------------------------------------------------

test('TH update merges fields and keeps the containment', async () => {
  const s = await scenario('th-update');
  const id = await threatAs(s);
  await ok(s.who.token, 'update_threat', patch(id, { summary: 'New summary.' }));
  const r = await threatOf(id);
  assert.equal(r.summary, 'New summary.');
  assert.deepEqual([r.stage, r.severity, r.title, r.cvss, r.package, r.fixedIn, r.flags, r.source], ['vulnerable', 'high', 'openssl RCE', '9.8', 'openssl@3.0.1', '3.0.7', FLAGS, SOURCE]);
  await ok(s.who.token, 'update_threat', patch(id, { flags: '', source: '' }));
  assert.deepEqual([(await threatOf(id)).flags, (await threatOf(id)).source], ['', '']);
});

test('TH update raises the stage and never lowers it', async () => {
  const s = await scenario('th-stage');
  const id = await threatAs(s);
  await ok(s.who.token, 'update_threat', patch(id, { stage: 'compromised' }));
  assert.equal((await threatOf(id)).stage, 'compromised');
  await ok(s.who.token, 'update_threat', patch(id, { stage: 'compromised', title: 'openssl RCE (exploited)' }));
  await rejects(s.who.token, 'update_threat', patch(id, { stage: 'vulnerable' }), THREAT_STAGE_LOWER_RULE);
  assert.equal((await threatOf(id)).stage, 'compromised');
});

test('TH update revalidates and refuses a missing threat', async () => {
  const s = await scenario('th-revalidate');
  const id = await threatAs(s);
  await rejects(s.who.token, 'update_threat', patch(id, { severity: 'severe' }), THREAT_SEVERITY_RULE);
  await rejects(s.who.token, 'update_threat', patch(id, { title: '' }), THREAT_TITLE_RULE);
  await rejects(s.who.token, 'update_threat', patch(id, { source: JSON.stringify({ system: 'a', ref: 'b', url: 'http://x' }) }), THREAT_URL_RULE);
  await rejects(s.who.token, 'update_threat', patch(id, { package: 'x'.repeat(121) }), THREAT_FIELD_RULE);
  await rejects(s.who.token, 'update_threat', patch(999999999n, { title: 'x' }), 'threat 999999999 does not exist');
  const stranger = await mint();
  await rejects(stranger.token, 'update_threat', patch(id, { title: 'x' }), 'not authorized');
  assert.equal((await threatOf(id)).title, 'openssl RCE');
});

// --- remove and cascades -----------------------------------------------------

test('TH removeThreat deletes one threat and emits an event', async () => {
  const s = await scenario('th-remove');
  const id = await threatAs(s);
  await rejects((await mint()).token, 'remove_threat', [id], 'not authorized');
  await ok(s.who.token, 'remove_threat', [id]);
  assert.equal(await threatOf(id), undefined);
  await rejects(s.who.token, 'remove_threat', [id], `threat ${id} does not exist`);
  const events = await sql(OWNER, `SELECT * FROM activity_outbox WHERE board_id = ${s.B}`);
  assert.deepEqual(events.filter(e => e.type === 'threat.removed').map(e => JSON.parse(e.payload)), [{}]);
});

test('TH deleteNode of the anchor deletes its threats', async () => {
  const s = await scenario('th-del-node');
  const other = await nodeAs(s.who, s.B, 'Worker');
  await threatAs(s);
  await threatAs(s, { title: 'second' });
  const kept = await threatAs(s, { anchorId: other, title: 'kept' });
  await ok(s.who.token, 'delete_node', [s.api]);
  assert.deepEqual((await threatsOn(s.B)).map(r => r.id), [kept]);
});

test('TH deleteBoard deletes threats', async () => {
  const s = await scenario('th-del-board');
  await threatAs(s);
  await ok(s.who.token, 'delete_board', [s.B]);
  assert.equal((await threatsOn(s.B)).length, 0);
});

// --- proposal copy -----------------------------------------------------------

const archNode = key => ({ key, label: key, sublabel: '', kind: 'service' });
const archGraph = () => ({ nodes: [archNode('a'), archNode('b')], edges: [{ from: 'a', to: 'b', label: 'uses', relation: 'import', evidence: 'import' }], files: ['a.ts'] });

test('TH proposal copy does not copy threats', async () => {
  const svc = await mint();
  await sql(OWNER, `INSERT INTO service_account (identity, label) VALUES (0x${svc.identity}, 'threat-tests')`);
  const who = await mint();
  await ok(who.token, 'create_architecture_history', [named('th-copy'), 'https://github.com/example/repo', JSON.stringify([{ ref: 'main', sha: SHA }]), named('th-copy')]);
  const h = (await sql(who.token, 'SELECT * FROM my_architecture_histories')).find(r => r.requestKey === named('th-copy'));
  await ok(svc.token, 'publish_architecture_snapshot', [h.id, 0, 'main', SHA, JSON.stringify(archGraph())]);
  const fact = (await sql(OWNER, `SELECT * FROM architecture_version WHERE history_id = ${h.id}`)).find(v => v.assertionMode === 'fact');
  const na = (await sql(OWNER, `SELECT * FROM node WHERE board_id = ${fact.boardId}`)).find(n => n.sourceKey === 'a').id;
  await ok(who.token, 'add_threat', [fact.boardId, na, 'vulnerable', 'high', 'openssl RCE', 'Heap overflow.', '', '', '', '', '', 'agent']);
  assert.equal((await threatsOn(fact.boardId)).length, 1);
  await ok(who.token, 'create_architecture_proposal', [fact.boardId, named('th-copy-p'), named('th-copy-p')]);
  const p = (await sql(OWNER, `SELECT * FROM architecture_version WHERE history_id = ${h.id}`)).find(v => v.requestKey === named('th-copy-p'));
  assert.ok((await sql(OWNER, `SELECT * FROM node WHERE board_id = ${p.boardId}`)).length > 0, 'the proposal has its nodes');
  assert.equal((await threatsOn(p.boardId)).length, 0);
});
