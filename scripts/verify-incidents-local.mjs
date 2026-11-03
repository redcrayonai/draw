// Module integration suite for incident triage: chart pins, the shared time
// window and incident boards. Talks to an ISOLATED SpacetimeDB over the HTTP
// API only, like scripts/verify-icons-local.mjs:
//
//   nix develop --command scripts/stdb-test.sh run   (the suite lists this file; passing it again runs it twice)
//
// Every test mints its own identities and boards; none depends on another.
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

// --- HTTP API (verbatim from verify-icons-local.mjs) ----------------------------

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

const nodeArgs = (boardId, label, o = {}) => [
  boardId, label, '', o.x ?? 0, o.y ?? 0, 160, 96, 'ink', o.focal ?? false, NONE, NONE, NONE, NONE, NONE, NONE, NONE,
];
const TS = 'time,p95\n2026-10-31T14:00:00Z,40\n2026-10-31T14:05:00Z,44\n';

async function boardAs(who, name) {
  await ok(who.token, 'create_board', [name]);
  const rows = await sql(OWNER, `SELECT id FROM board WHERE name = '${name}'`);
  assert.equal(rows.length, 1, `exactly one board named ${name}`);
  return rows[0].id;
}
const nodesOn = boardId => sql(OWNER, `SELECT * FROM node WHERE board_id = ${boardId}`);
const edgesOn = boardId => sql(OWNER, `SELECT * FROM edge WHERE board_id = ${boardId}`);
const anchorsOn = boardId => sql(OWNER, `SELECT * FROM chart_anchor WHERE board_id = ${boardId}`);
const windowOf = async boardId => (await sql(OWNER, `SELECT * FROM board_window WHERE board_id = ${boardId}`))[0];
const incidentsFrom = sourceId => sql(OWNER, `SELECT * FROM incident WHERE source_board_id = ${sourceId}`);
const idOf = async (boardId, label) => (await nodesOn(boardId)).find(n => n.label === label).id;

/** Two services joined by an edge, one of them focal, and a time chart pinned to the edge. */
async function topology(who, name) {
  const B = await boardAs(who, named(name));
  await ok(who.token, 'create_node', nodeArgs(B, 'api', { focal: true }));
  await ok(who.token, 'create_node', nodeArgs(B, 'db', { x: 400 }));
  const api = await idOf(B, 'api'), db = await idOf(B, 'db');
  await ok(who.token, 'create_edge', [B, api, db, 'queries', 'human:test', NONE, NONE, NONE]);
  const edge = (await edgesOn(B))[0].id;
  await ok(who.token, 'create_chart', [B, 'latency', 'ms', 0, 200, 320, 200, 'timeseries', TS, NONE, NONE]);
  const chart = await idOf(B, 'latency');
  return { B, api, db, edge, chart };
}

// --- chart pins ----------------------------------------------------------------

test('IN anchor_chart pins a chart to an edge or a component and moves the pin', async () => {
  const who = await mint();
  const { B, api, edge, chart } = await topology(who, 'in-pin');
  await ok(who.token, 'anchor_chart', [chart, 'edge', edge]);
  assert.deepEqual(await anchorsOn(B), [{ nodeId: chart, boardId: B, targetKind: 'edge', targetId: edge }]);
  await ok(who.token, 'anchor_chart', [chart, 'node', api]);
  assert.deepEqual(await anchorsOn(B), [{ nodeId: chart, boardId: B, targetKind: 'node', targetId: api }]);
  await ok(who.token, 'unanchor_chart', [chart]);
  assert.deepEqual(await anchorsOn(B), []);
});

test('IN anchor_chart refuses a non-chart, a chart target, another board and a reader', async () => {
  const who = await mint();
  const { B, api, edge, chart } = await topology(who, 'in-pin-refuse');
  await rejects(who.token, 'anchor_chart', [api, 'edge', edge], 'pin rule');
  await rejects(who.token, 'anchor_chart', [chart, 'node', chart], 'pin rule');
  await rejects(who.token, 'anchor_chart', [chart, 'route', edge], 'targetKind');
  const other = await topology(who, 'in-pin-other');
  await rejects(who.token, 'anchor_chart', [chart, 'edge', other.edge], 'pin rule');
  const stranger = await mint();
  await rejects(stranger.token, 'anchor_chart', [chart, 'edge', edge], 'not authorized');
  assert.deepEqual(await anchorsOn(B), []);
});

test('IN a pin goes with its edge, its component and its chart', async () => {
  const who = await mint();
  const { B, api, db, edge, chart } = await topology(who, 'in-pin-cascade');
  await ok(who.token, 'anchor_chart', [chart, 'edge', edge]);
  await ok(who.token, 'delete_edge', [edge]);
  assert.deepEqual(await anchorsOn(B), []);
  await ok(who.token, 'anchor_chart', [chart, 'node', db]);
  await ok(who.token, 'delete_node', [db]);
  assert.deepEqual(await anchorsOn(B), []);
  await ok(who.token, 'anchor_chart', [chart, 'node', api]);
  await ok(who.token, 'delete_node', [chart]);
  assert.deepEqual(await anchorsOn(B), []);
});

// --- the shared time window ------------------------------------------------------

test('IN set_board_window stores the window, refuses a bad one and a reader, and clear removes it', async () => {
  const who = await mint();
  const B = await boardAs(who, named('in-window'));
  const start = Date.parse('2026-10-31T14:00:00Z');
  await ok(who.token, 'set_board_window', [B, start, start + 900_000]);
  assert.deepEqual({ ...(await windowOf(B)), updatedAt: undefined }, { boardId: B, startMs: start, endMs: start + 900_000, updatedAt: undefined });
  await rejects(who.token, 'set_board_window', [B, start, start], 'window rule');
  await rejects(who.token, 'set_board_window', [B, start, start + 32 * 24 * 3600_000], 'window rule');
  await rejects(who.token, 'set_board_window', [B, -1, 1], 'window rule');
  await rejects(who.token, 'set_board_window', [B, 8.64e15, 8.64e15 + 1000], 'window rule'); // past the last date a viewer can draw
  const stranger = await mint();
  await rejects(stranger.token, 'set_board_window', [B, start, start + 1000], 'not authorized');
  await ok(who.token, 'clear_board_window', [B]);
  assert.equal(await windowOf(B), undefined);
  await ok(who.token, 'clear_board_window', [B]); // already clear: a no-op
});

// --- incident boards -------------------------------------------------------------

test('IN open_incident copies the drawing with no suspects, flags it ephemeral and opens on the alert', async () => {
  const who = await mint();
  const src = await topology(who, 'in-open');
  await ok(who.token, 'anchor_chart', [src.chart, 'edge', src.edge]);
  const startsAt = Date.parse('2026-10-31T14:32:00Z');
  await ok(who.token, 'open_incident', [src.B, 'group-1', 'Incident: HighLatency', 'firing', startsAt]);
  const [inc] = await incidentsFrom(src.B);
  assert.equal(inc.status, 'firing');
  assert.equal(inc.title, 'Incident: HighLatency');
  const I = inc.boardId;
  const nodes = await nodesOn(I);
  assert.deepEqual(nodes.map(n => n.label).sort(), ['api', 'db', 'latency']);
  assert.ok(nodes.every(n => !n.focal), 'no node starts as a suspect');
  const [edge] = await edgesOn(I);
  const chart = nodes.find(n => n.label === 'latency').id;
  assert.deepEqual(await anchorsOn(I), [{ nodeId: chart, boardId: I, targetKind: 'edge', targetId: edge.id }]);
  assert.equal((await sql(OWNER, `SELECT * FROM chart WHERE node_id = ${chart}`)).length, 1);
  assert.equal((await sql(OWNER, `SELECT * FROM board_lifetime WHERE board_id = ${I}`))[0].isEphemeral, true);
  const w = await windowOf(I);
  assert.deepEqual([w.startMs, w.endMs], [startsAt - 900_000, startsAt + 900_000]);
  const mine = (await sql(who.token, 'SELECT * FROM my_incidents')).filter(r => r.sourceBoardId === src.B);
  const slug = (await sql(OWNER, `SELECT slug FROM board WHERE id = ${I}`))[0].slug;
  assert.deepEqual(mine.map(r => [r.boardId, r.slug, r.groupKey]), [[I, slug, 'group-1']]);
  // The source keeps its suspect.
  assert.ok((await nodesOn(src.B)).find(n => n.label === 'api').focal);
});

test('IN a repeated alert finds the open incident; resolved closes it; firing again within the hour reopens it', async () => {
  const who = await mint();
  const { B } = await topology(who, 'in-repeat');
  await ok(who.token, 'open_incident', [B, 'g', 'Incident: A', 'firing', 0]);
  await ok(who.token, 'open_incident', [B, 'g', 'Incident: A', 'firing', 0]);
  let rows = await incidentsFrom(B);
  assert.equal(rows.length, 1);
  assert.equal(await windowOf(rows[0].boardId), undefined, 'no alert start, no window');
  await ok(who.token, 'open_incident', [B, 'g', 'Incident: A', 'resolved', 0]);
  await ok(who.token, 'open_incident', [B, 'g', 'Incident: A', 'resolved', 0]); // nothing open: a no-op
  rows = await incidentsFrom(B);
  assert.deepEqual(rows.map(r => r.status), ['resolved']);
  await ok(who.token, 'open_incident', [B, 'g', 'Incident: A', 'firing', 0]);
  const reopened = await incidentsFrom(B);
  assert.deepEqual(reopened.map(r => [r.boardId, r.status]), [[rows[0].boardId, 'firing']], 'a flapping alert reuses its board');
  await ok(who.token, 'open_incident', [B, 'other', 'Incident: B', 'resolved', 0]);
  assert.equal((await incidentsFrom(B)).length, 1, 'a resolved alert with nothing open opens nothing');
  await ok(who.token, 'open_incident', [B, 'late', 'Incident: C', 'firing', 8.64e15]);
  const late = (await incidentsFrom(B)).find(r => r.groupKey === 'late');
  assert.equal(await windowOf(late.boardId), undefined, 'a start too late to draw opens without a window');
});

test('IN a reopened incident moves its window to the new alert, and keeps one that already shows it', async () => {
  const who = await mint();
  const { B } = await topology(who, 'in-reopen-window');
  const first = Date.parse('2026-10-31T14:30:00Z'), again = Date.parse('2026-10-31T15:10:00Z');
  await ok(who.token, 'open_incident', [B, 'g', 'Incident: A', 'firing', first]);
  const [inc] = await incidentsFrom(B);
  await ok(who.token, 'open_incident', [B, 'g', 'Incident: A', 'resolved', 0]);
  await ok(who.token, 'open_incident', [B, 'g', 'Incident: A', 'firing', again]);
  let w = await windowOf(inc.boardId);
  assert.deepEqual([w.startMs, w.endMs], [again - 900_000, again + 900_000]);
  await ok(who.token, 'set_board_window', [inc.boardId, again - 3_600_000, again + 3_600_000]); // a responder widens it
  await ok(who.token, 'open_incident', [B, 'g', 'Incident: A', 'resolved', 0]);
  await ok(who.token, 'open_incident', [B, 'g', 'Incident: A', 'firing', again + 600_000]);
  w = await windowOf(inc.boardId);
  assert.deepEqual([w.startMs, w.endMs], [again - 3_600_000, again + 3_600_000]);
});

test('IN a link visitor reads the incident without its alert group key; a member reads it whole', async () => {
  const who = await mint();
  const { B } = await topology(who, 'in-group-key');
  await ok(who.token, 'open_incident', [B, '{}:{instance="10.0.3.4:9100"}', 'Incident: A', 'firing', 0]);
  const [inc] = await incidentsFrom(B);
  const token = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
  await ok(who.token, 'set_link_share', [inc.boardId, 'view', token]);
  const visitor = await mint();
  await ok(visitor.token, 'open_shared_link', [token]);
  const seen = (await sql(visitor.token, 'SELECT * FROM visible_incident')).find(r => r.boardId === inc.boardId);
  assert.deepEqual([seen.status, seen.groupKey], ['firing', '']);
  const own = (await sql(who.token, 'SELECT * FROM visible_incident')).find(r => r.boardId === inc.boardId);
  assert.equal(own.groupKey, '{}:{instance="10.0.3.4:9100"}');
});

test('IN open_incident refuses a reader, bad input and an incident board as the source', async () => {
  const who = await mint();
  const { B } = await topology(who, 'in-refuse');
  const stranger = await mint();
  await rejects(stranger.token, 'open_incident', [B, 'g', 'Incident', 'firing', 0], 'not authorized');
  await rejects(who.token, 'open_incident', [B, 'g', 'Incident', 'paging', 0], 'status');
  await rejects(who.token, 'open_incident', [B, '', 'Incident', 'firing', 0], 'incident rule');
  await rejects(who.token, 'open_incident', [B, 'g', '', 'firing', 0], 'board name');
  await ok(who.token, 'open_incident', [B, 'g', 'Incident', 'firing', 0]);
  const [inc] = await incidentsFrom(B);
  await rejects(who.token, 'open_incident', [inc.boardId, 'g2', 'Incident', 'firing', 0], 'incident rule');
});

test('IN deleting an incident board removes its incident, lifetime and window rows', async () => {
  const who = await mint();
  const { B } = await topology(who, 'in-delete');
  await ok(who.token, 'open_incident', [B, 'g', 'Incident', 'firing', Date.parse('2026-10-31T14:00:00Z')]);
  const [inc] = await incidentsFrom(B);
  await ok(who.token, 'delete_board', [inc.boardId]);
  assert.deepEqual(await incidentsFrom(B), []);
  assert.deepEqual(await sql(OWNER, `SELECT * FROM board_lifetime WHERE board_id = ${inc.boardId}`), []);
  assert.equal(await windowOf(inc.boardId), undefined);
});
