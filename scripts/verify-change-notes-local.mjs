// Module integration suite for change notes.
// Talks to an ISOLATED database over the HTTP API only, like
// scripts/verify-charts-local.mjs. scripts/stdb-test.sh sets it up:
//
//   nix develop --command scripts/stdb-test.sh run scripts/verify-change-notes-local.mjs
//
// Identities minted here are never account senders, so who may review (D12)
// is tested in scripts/verify-issuers-local.mjs. Every test mints its own
// identities and boards; none depends on another.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { NOTE_ALIAS_RULE, NOTE_JSON_RULE, READER_TERM_RULE, STEP_RANGE_RULE, mergeSchemas, schemaCardHeight } from '../module/src/change-notes.ts';

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
const SHA2 = 'a'.repeat(40);
const RUN = Date.now().toString(36);
const NONE = { none: [] };
const some = v => ({ some: v });
const named = s => `${s}-${RUN}`;

// --- HTTP API (verbatim from verify-charts-local.mjs) ------------------------

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

// --- fixtures ----------------------------------------------------------------

const nodeArgs = (boardId, label) => [boardId, label, '', 0, 0, 160, 80, 'ink', false, NONE, NONE, NONE, NONE, NONE, NONE, NONE];

async function boardIdOf(name) {
  const rows = await sql(OWNER, `SELECT id FROM board WHERE name = '${name}'`);
  assert.equal(rows.length, 1, `exactly one board named ${name}`);
  return rows[0].id;
}

async function createBoardAs(who, name) {
  await ok(who.token, 'create_board', [name]);
  return boardIdOf(name);
}

const nodesOn = boardId => sql(OWNER, `SELECT * FROM node WHERE board_id = ${boardId}`);
const nodeOf = async nodeId => (await sql(OWNER, `SELECT * FROM node WHERE id = ${nodeId}`))[0];
const notesOn = boardId => sql(OWNER, `SELECT * FROM change_note WHERE board_id = ${boardId}`);
const noteOf = async id => (await sql(OWNER, `SELECT * FROM change_note WHERE id = ${id}`))[0];
const refsOn = boardId => sql(OWNER, `SELECT * FROM code_ref WHERE board_id = ${boardId}`);

async function nodeAs(who, boardId, label) {
  await ok(who.token, 'create_node', nodeArgs(boardId, label));
  return (await nodesOn(boardId)).find(n => n.label === label).id;
}

// addCodeRef: boardId, targetKind, targetId, path, symbol, startLine, endLine, blobSha, snippet, author
async function refAs(who, boardId, nodeId, path, symbol, startLine, endLine, snippet, blobSha = SHA) {
  await ok(who.token, 'add_repo_files', [boardId, [path]]); // a ref's path must be in the board's repo
  await ok(who.token, 'add_code_ref', [boardId, 'node', nodeId, path, symbol, startLine, endLine, blobSha, snippet, 'agent']);
  return (await refsOn(boardId)).find(r => r.path === path && r.symbol === symbol && r.targetId === nodeId).id;
}

const MIGRATION = [
  '-- split customers.name',
  'BEGIN;',
  'ALTER TABLE customers',
  '  ADD COLUMN first_name text,',
  '  ADD COLUMN last_name text;',
  '',
  'UPDATE customers',
  "  SET first_name = split_part(name, ' ', 1),",
  "      last_name = split_part(name, ' ', 2)",
  'WHERE first_name IS NULL;',
  '',
  'ALTER TABLE customers DROP COLUMN name;',
  'COMMIT;',
].join('\n');
const SUBJECTS = JSON.stringify([{ table: 'customers', column: 'name' }]);
const STEPS = JSON.stringify([
  { label: 'add columns', startLine: 3, endLine: 5 },
  { label: 'backfill', startLine: 7, endLine: 10 },
  { label: 'drop name', startLine: 12, endLine: 12, irreversible: true },
]);
const SCHEMA = JSON.stringify({
  table: 'customers',
  columns: [
    { name: 'id', type: 'uuid', change: null },
    { name: 'name', type: 'text', change: 'dropped' },
    { name: 'first_name', type: 'text', change: 'added' },
    { name: 'last_name', type: 'text', change: 'added' },
  ],
});
const readersOf = (...ids) => JSON.stringify(ids.map(id => ({ refId: String(id), subject: 0 })));

// addChangeNote: boardId, anchorId, kind, severity, title, summary, refId, steps, schema, subjects, readers, author
const noteArgs = (s, o = {}) => [
  s.B, o.anchorId ?? s.pg, o.kind ?? 'migration', o.severity ?? 'destructive', o.title ?? 'Migration 0042',
  o.summary ?? 'Splits name into first/last, then drops it.', o.refId ?? s.mainRef, o.steps ?? STEPS, o.schema ?? '',
  o.subjects ?? SUBJECTS, o.readers ?? readersOf(s.readerRef), 'agent',
];
// updateChangeNote: id, kind, severity, title, summary, refId, steps, schema, subjects, readers (all optional)
const patch = (id, o = {}) => [
  id, ...['kind', 'severity', 'title', 'summary', 'refId', 'steps', 'schema', 'subjects', 'readers'].map(k => (k in o ? some(o[k]) : NONE)),
];

/** The mockup scenario: Postgres holds the migration ref, Invoice worker a reader that still reads `name`. */
async function scenario(label) {
  const who = await mint();
  await ok(who.token, 'set_code_consent', [true]); // readers are checked against stored snippets (RC-690)
  const B = await createBoardAs(who, named(label));
  const pg = await nodeAs(who, B, 'Postgres');
  const worker = await nodeAs(who, B, 'Invoice worker');
  const mainRef = await refAs(who, B, pg, 'migrations/0042_split_customer_name.sql', 'customers', 1, 13, MIGRATION);
  const readerRef = await refAs(who, B, worker, 'workers/invoice/src/bill-to.ts', 'loadBillTo', 38, 44,
    'export async function loadBillTo(sql, id) {\n  const [row] = await sql`SELECT name, email FROM customers WHERE id = ${id}`;\n  return row.name;\n}');
  return { who, B, pg, worker, mainRef, readerRef };
}

async function noteAs(s, o = {}) {
  await ok(s.who.token, 'add_change_note', noteArgs(s, o));
  const notes = await notesOn(s.B);
  return notes[notes.length - 1].id;
}

let svc;
before(async () => {
  svc = await mint();
  await sql(OWNER, `INSERT INTO service_account (identity, label) VALUES (0x${svc.identity}, 'change-notes-tests')`);
});

// --- add ---------------------------------------------------------------------

test('CN add stores the note and starts readers stale', async () => {
  const s = await scenario('cn-add');
  const id = await noteAs(s);
  const n = await noteOf(id);
  assert.equal(n.boardId, s.B);
  assert.equal(n.anchorId, s.pg);
  assert.equal(n.refId, s.mainRef);
  assert.deepEqual([n.kind, n.severity, n.title], ['migration', 'destructive', 'Migration 0042']);
  assert.deepEqual(JSON.parse(n.readers), [{ refId: String(s.readerRef), subject: 0, status: 'stale', checkpoint: 0 }]);
  // stored relative to the main ref's first line (1), so the steps follow the ref when it moves
  assert.deepEqual(JSON.parse(n.steps)[2], { label: 'drop name', startLine: 11, endLine: 11, irreversible: true });
  assert.equal(n.refFileSha, SHA);
  assert.equal(n.reviewedBy, '');
  assert.equal(n.reviewedSha, '');
  const events = await sql(OWNER, `SELECT * FROM activity_outbox WHERE board_id = ${s.B}`);
  assert.ok(events.some(e => e.type === 'changenote.added' && JSON.parse(e.payload).title === 'Migration 0042'));
});

test('CN add refuses a reader without the term', async () => {
  const s = await scenario('cn-term');
  const other = await refAs(s.who, s.B, s.worker, 'workers/invoice/src/name.ts', 'fullName', 1, 2, 'const fullName = row.first_name;');
  await rejects(s.who.token, 'add_change_note', noteArgs(s, { readers: readersOf(other) }), READER_TERM_RULE);
  // an alias makes the same ref a valid reader
  const aliased = JSON.stringify([{ table: 'customers', column: 'name', aliases: ['fullName'] }]);
  await ok(s.who.token, 'add_change_note', noteArgs(s, { subjects: aliased, readers: readersOf(other) }));
});

test('CN add refuses a step outside the ref, an anchor or a ref on another board', async () => {
  const s = await scenario('cn-refuse');
  const t = await scenario('cn-refuse-other');
  await rejects(s.who.token, 'add_change_note', noteArgs(s, { steps: JSON.stringify([{ label: 'x', startLine: 12, endLine: 14 }]) }), STEP_RANGE_RULE);
  await rejects(s.who.token, 'add_change_note', noteArgs(s, { anchorId: t.pg }), 'change note anchor must be a node on this board');
  await rejects(s.who.token, 'add_change_note', noteArgs(s, { refId: t.mainRef }), 'change note ref must be a code ref on this board');
  await rejects(s.who.token, 'add_change_note', noteArgs(s, { readers: readersOf(t.readerRef) }), 'change note ref must be a code ref on this board');
  await rejects(s.who.token, 'add_change_note', noteArgs(s, { kind: 'refactor' }), 'change note kind must be');
  assert.equal((await notesOn(s.B)).length, 0);
  const stranger = await mint();
  await rejects(stranger.token, 'add_change_note', noteArgs(s), 'not authorized');
});

test('CN add with schema grows the anchor', async () => {
  const s = await scenario('cn-grow');
  const before = await nodeOf(s.pg);
  assert.equal(before.h, 80);
  await noteAs(s, { schema: SCHEMA });
  const grown = await nodeOf(s.pg);
  assert.equal(grown.h, schemaCardHeight(JSON.parse(SCHEMA)));
  assert.equal(grown.h % 4, 0, 'stays on the 4px grid');
  assert.deepEqual([grown.x, grown.y, grown.w], [before.x, before.y, before.w]);
  const small = JSON.stringify({ table: 'customers', columns: [{ name: 'name', type: 'text', change: 'dropped' }] });
  await noteAs(s, { schema: small, title: 'Migration 0043' });
  assert.equal((await nodeOf(s.pg)).h, grown.h, 'a smaller card never shrinks the node');
});

test("CN the anchor grows to fit every note's merged card", async () => {
  const s = await scenario('cn-grow-merged');
  const a = { table: 'customers', columns: [{ name: 'id', type: 'uuid', change: null }, { name: 'a1', type: 'text', change: 'added' }, { name: 'a2', type: 'text', change: 'added' }, { name: 'a3', type: 'text', change: 'added' }] };
  const b = { table: 'orders', columns: [{ name: 'id', type: 'uuid', change: null }, { name: 'legacy', type: 'text', change: 'dropped' }, { name: 'b1', type: 'text', change: 'added' }] };
  await noteAs(s, { schema: JSON.stringify(a) });
  await noteAs(s, { schema: JSON.stringify(b), title: 'Migration 0043' });
  assert.equal((await nodeOf(s.pg)).h, schemaCardHeight(mergeSchemas([a, b])));
});

// --- update ------------------------------------------------------------------

test('CN update merges fields and keeps reader status', async () => {
  const s = await scenario('cn-update');
  const id = await noteAs(s);
  await ok(s.who.token, 'set_change_note_readers', [id, JSON.stringify([{ refId: String(s.readerRef), subject: 0, status: 'updated', checkpoint: 3 }]), SHA]);
  await ok(s.who.token, 'update_change_note', patch(id, { summary: 'New summary.' }));
  let n = await noteOf(id);
  assert.equal(n.summary, 'New summary.');
  assert.equal(n.title, 'Migration 0042');
  assert.deepEqual(JSON.parse(n.readers), [{ refId: String(s.readerRef), subject: 0, status: 'updated', checkpoint: 3 }]);
  const second = await refAs(s.who, s.B, s.worker, 'workers/invoice/src/pdf.ts', 'renderPdf', 1, 3, 'function renderPdf(row) { return row.name; }');
  await ok(s.who.token, 'update_change_note', patch(id, { readers: readersOf(s.readerRef, second) }));
  n = await noteOf(id);
  assert.deepEqual(JSON.parse(n.readers), [
    { refId: String(s.readerRef), subject: 0, status: 'updated', checkpoint: 3 },
    { refId: String(second), subject: 0, status: 'stale', checkpoint: 0 },
  ]);
  await rejects(s.who.token, 'update_change_note', patch(id, { severity: 'caution' }), 'change note severity must be');
  await rejects(s.who.token, 'update_change_note', patch(424242424242n), 'change note 424242424242 does not exist');
});

test('CN update with a new main ref resets refFileSha', async () => {
  const s = await scenario('cn-reref');
  const id = await noteAs(s);
  const next = await refAs(s.who, s.B, s.pg, 'migrations/0042_v2.sql', 'customers', 1, 13, MIGRATION, SHA2);
  await ok(s.who.token, 'update_change_note', patch(id, { refId: next }));
  const n = await noteOf(id);
  assert.equal(n.refId, next);
  assert.equal(n.refFileSha, SHA2);
});

// --- refs going away (D9a) ---------------------------------------------------

test('CN removeCodeRef refuses the main ref', async () => {
  const s = await scenario('cn-main');
  const id = await noteAs(s);
  await rejects(s.who.token, 'remove_code_ref', [s.mainRef], `code ref ${s.mainRef} is the main ref of change note ${id}`);
  assert.ok((await refsOn(s.B)).some(r => r.id === s.mainRef));
});

test('CN the refusal names a route that works: re-add under another symbol, point the note at it, remove the old ref', async () => {
  const s = await scenario('cn-replace');
  const id = await noteAs(s);
  const r = await call(s.who.token, 'remove_code_ref', [s.mainRef]);
  assert.ok(r.text.includes('add_code_ref the migration again under another symbol'), r.text);
  const again = await refAs(s.who, s.B, s.pg, 'migrations/0042_split_customer_name.sql', 'ALTER', 1, 13, MIGRATION, SHA2);
  await ok(s.who.token, 'update_change_note', patch(id, { refId: again }));
  await ok(s.who.token, 'remove_code_ref', [s.mainRef]);
  assert.equal((await noteOf(id)).refId, again);
});

test('CN a new main ref keeps the steps on the lines they name', async () => {
  const s = await scenario('cn-reref-steps');
  const id = await noteAs(s); // drop name at line 12 of a ref on lines 1-13
  const lines = MIGRATION.split('\n');
  const later = await refAs(s.who, s.B, s.pg, 'migrations/0042_split_customer_name.sql', 'ALTER', 5, 13, lines.slice(4).join('\n'), SHA2);
  await ok(s.who.token, 'update_change_note', patch(id, { refId: later }));
  const stored = JSON.parse((await noteOf(id)).steps);
  assert.deepEqual(stored.find(st => st.irreversible), { label: 'drop name', startLine: 7, endLine: 7, irreversible: true }, 'line 12 is offset 7 from line 5');
});

test('CN an update that leaves steps out still works after the main ref shrank', async () => {
  const s = await scenario('cn-shrink');
  const id = await noteAs(s);
  await ok(s.who.token, 'update_code_ref', [s.mainRef, 1, 5, SHA2, MIGRATION.split('\n').slice(0, 5).join('\n'), 'ok']);
  await ok(s.who.token, 'update_change_note', patch(id, { summary: 'Still drops name.' }));
  assert.equal((await noteOf(id)).summary, 'Still drops name.');
  await rejects(s.who.token, 'update_change_note', patch(id, { steps: STEPS }), STEP_RANGE_RULE);
});

test('CN changing subjects re-checks every reader against the new terms (D4a)', async () => {
  const s = await scenario('cn-subjects');
  const id = await noteAs(s);
  await ok(s.who.token, 'set_change_note_readers', [id, JSON.stringify([{ refId: String(s.readerRef), subject: 0, status: 'updated', checkpoint: 3 }]), SHA]);
  await rejects(s.who.token, 'update_change_note', patch(id, { subjects: JSON.stringify([{ table: 'customers', column: 'full_name' }]) }), READER_TERM_RULE);
  await ok(s.who.token, 'update_change_note', patch(id, { subjects: JSON.stringify([{ table: 'customers', column: 'name', aliases: ['fullName'] }]) }));
  assert.equal(JSON.parse((await noteOf(id)).readers)[0].status, 'stale', 'a new baseline starts stale, never green');
});

test('CN the alias cap holds on caller subjects only: a stored over-cap note still takes a title update (U8)', async () => {
  const s = await scenario('cn-alias-cap');
  const id = await noteAs(s);
  const over = JSON.stringify([{ table: 'customers', column: 'name', aliases: Array.from({ length: 17 }, (_, i) => `alias${i}`) }]);
  await rejects(s.who.token, 'add_change_note', noteArgs(s, { subjects: over }), NOTE_ALIAS_RULE);
  await rejects(s.who.token, 'update_change_note', patch(id, { subjects: over }), NOTE_ALIAS_RULE);
  await sql(OWNER, `UPDATE change_note SET subjects = '${over}' WHERE id = ${id}`); // as a module before the cap stored it
  await ok(s.who.token, 'update_change_note', patch(id, { title: 'Migration 0042b' }));
  const n = await noteOf(id);
  assert.equal(n.title, 'Migration 0042b');
  assert.equal(n.subjects, over);
});

test('CN removeCodeRef marks a reader removed', async () => {
  const s = await scenario('cn-reader');
  const id = await noteAs(s);
  await ok(s.who.token, 'remove_code_ref', [s.readerRef]);
  assert.deepEqual(JSON.parse((await noteOf(id)).readers), [{ refId: String(s.readerRef), subject: 0, status: 'unknown', checkpoint: 0, removed: true }]);
});

test('CN deleteNode of the anchor deletes its notes', async () => {
  const s = await scenario('cn-del-anchor');
  await noteAs(s);
  await ok(s.who.token, 'delete_node', [s.pg]);
  assert.equal((await notesOn(s.B)).length, 0);
});

test('CN deleting the node that holds the main ref deletes the note', async () => {
  const s = await scenario('cn-del-main');
  const file = await nodeAs(s.who, s.B, 'migration file');
  const fileRef = await refAs(s.who, s.B, file, 'migrations/0043.sql', 'customers', 1, 13, MIGRATION);
  await noteAs(s, { refId: fileRef });
  await ok(s.who.token, 'delete_node', [file]);
  assert.equal((await notesOn(s.B)).length, 0);
});

test('CN deleting the reader node keeps the note and marks the reader removed', async () => {
  const s = await scenario('cn-del-reader');
  const id = await noteAs(s);
  await ok(s.who.token, 'delete_node', [s.worker]);
  assert.deepEqual(JSON.parse((await noteOf(id)).readers), [{ refId: String(s.readerRef), subject: 0, status: 'unknown', checkpoint: 0, removed: true }]);
});

test('CN deleteBoard deletes notes', async () => {
  const s = await scenario('cn-del-board');
  await noteAs(s);
  await ok(s.who.token, 'delete_board', [s.B]);
  assert.equal((await notesOn(s.B)).length, 0);
});

test('CN removeChangeNote deletes one note and emits an event', async () => {
  const s = await scenario('cn-remove');
  const id = await noteAs(s);
  await rejects((await mint()).token, 'remove_change_note', [id], 'not authorized');
  await ok(s.who.token, 'remove_change_note', [id]);
  assert.equal(await noteOf(id), undefined);
  const events = await sql(OWNER, `SELECT * FROM activity_outbox WHERE board_id = ${s.B}`);
  assert.ok(events.some(e => e.type === 'changenote.removed'));
});

// --- checkpoint writes -------------------------------------------------------

test('CN setChangeNoteReaders stores statuses and refFileSha', async () => {
  const s = await scenario('cn-set');
  const id = await noteAs(s);
  const updated = JSON.stringify([{ refId: String(s.readerRef), subject: 0, status: 'updated', checkpoint: 2 }]);
  await ok(s.who.token, 'set_change_note_readers', [id, updated, SHA2]);
  const n = await noteOf(id);
  assert.deepEqual(JSON.parse(n.readers), JSON.parse(updated));
  assert.equal(n.refFileSha, SHA2);
  await rejects(s.who.token, 'set_change_note_readers', [id, JSON.stringify([{ refId: '999', subject: 0, status: 'updated', checkpoint: 2 }]), SHA2], NOTE_JSON_RULE);
  await rejects(s.who.token, 'set_change_note_readers', [id, '[]', SHA2], NOTE_JSON_RULE);
  await rejects(s.who.token, 'set_change_note_readers', [id, JSON.stringify([{ refId: String(s.readerRef), subject: 0, status: 'green', checkpoint: 2 }]), SHA2], NOTE_JSON_RULE);
});

// --- proposal copy -----------------------------------------------------------

const archNode = key => ({ key, label: key, sublabel: '', kind: 'service' });
const archGraph = () => ({ nodes: [archNode('a'), archNode('b')], edges: [{ from: 'a', to: 'b', label: 'uses', relation: 'import', evidence: 'import' }], files: ['a.ts'] });

test('CN proposal copy remaps anchorId, refId and readers[].refId', async () => {
  const who = await mint();
  await ok(who.token, 'set_code_consent', [true]);
  await ok(who.token, 'create_architecture_history', [named('cn-copy'), 'https://github.com/example/repo', JSON.stringify([{ ref: 'main', sha: SHA }]), named('cn-copy')]);
  const h = (await sql(who.token, 'SELECT * FROM my_architecture_histories')).find(r => r.requestKey === named('cn-copy'));
  await ok(svc.token, 'publish_architecture_snapshot', [h.id, 0, 'main', SHA, JSON.stringify(archGraph())]);
  const fact = (await sql(OWNER, `SELECT * FROM architecture_version WHERE history_id = ${h.id}`)).find(v => v.assertionMode === 'fact');
  const nodes = await nodesOn(fact.boardId);
  const na = nodes.find(n => n.sourceKey === 'a').id, nb = nodes.find(n => n.sourceKey === 'b').id;
  // a fact board's repo is its snapshot's files: both refs cite a.ts
  const ref = async (nodeId, symbol, endLine, snippet) => {
    await ok(who.token, 'add_code_ref', [fact.boardId, 'node', nodeId, 'a.ts', symbol, 1, endLine, SHA, snippet, 'agent']);
    return (await refsOn(fact.boardId)).find(r => r.symbol === symbol).id;
  };
  const s = {
    who, B: fact.boardId, pg: na, worker: nb,
    mainRef: await ref(na, 'customers', 13, MIGRATION),
    readerRef: await ref(nb, 'loadB', 1, 'function loadB(row) { return row.name; }'),
  };
  await noteAs(s);
  await ok(who.token, 'create_architecture_proposal', [fact.boardId, named('cn-copy-p'), named('cn-copy-p')]);
  const p = (await sql(OWNER, `SELECT * FROM architecture_version WHERE history_id = ${h.id}`)).find(v => v.requestKey === named('cn-copy-p'));
  const [copy] = await notesOn(p.boardId);
  assert.ok(copy, 'the note is copied');
  const copiedNodes = await nodesOn(p.boardId);
  const copiedRefs = await refsOn(p.boardId);
  assert.equal(copy.anchorId, copiedNodes.find(n => n.sourceKey === 'a').id);
  assert.equal(copy.refId, copiedRefs.find(r => r.symbol === 'customers').id);
  assert.deepEqual(JSON.parse(copy.readers).map(r => r.refId), [String(copiedRefs.find(r => r.symbol === 'loadB').id)]);
  assert.equal(copy.reviewedBy, '');
});
