// Module integration suite for code consent (RC-690): a
// board stores code text (code ref snippets, source citation lines) only when its
// owner opted in; line hashes and the repo remote live in side tables. Talks to an ISOLATED database over the HTTP API only;
// scripts/stdb-test.sh sets it up:
//
//   nix develop --command scripts/stdb-test.sh run scripts/verify-code-consent-local.mjs
//
// Identities minted here are never hosted agents, so "an agent cannot set its
// person's consent" is tested in scripts/verify-issuers-local.mjs. Every test
// mints its own identities and boards; none depends on another.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';

const BASE = process.env.STDB_URL;
const DB = process.env.STDB_DB;
const OWNER = process.env.STDB_OWNER_TOKEN;
if (!BASE || !DB || !OWNER) {
  throw new Error('set STDB_URL, STDB_DB and STDB_OWNER_TOKEN (scripts/stdb-test.sh run does)');
}
if (DB === 'redcrayon') {
  throw new Error("refusing to run against the shared 'redcrayon' database; use scripts/stdb-test.sh");
}

const CODE_CONSENT_RULE = 'code rule: this board does not store code; send the code ref without its snippet';
const READER_TERM_RULE = "a change note reader's code ref must contain its subject's column or an alias";
const CITE_RULE = "only board members can cite this board's code or register its files";
const SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const NONE = { none: [] };
const some = v => ({ some: v });
const RUN = Date.now().toString(36);
const named = s => `${s}-${RUN}`;
const code = () => randomBytes(32).toString('base64url');
const identity = who => ({ __identity__: `0x${who.identity}` });
const hexOf = v => String(Array.isArray(v) ? v[0] : v.__identity__).replace(/^0x/, '').toLowerCase();

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

// --- fixtures ----------------------------------------------------------------

const nodeArgs = (B, label) => [B, label, '', 0, 0, 160, 80, 'ink', false, NONE, NONE, NONE, NONE, NONE, NONE, NONE];
// addCodeRef: boardId, targetKind, targetId, path, symbol, startLine, endLine, blobSha, snippet, author
const refArgs = (B, nodeId, symbol, snippet) => [B, 'node', nodeId, 'src/a.ts', symbol, 1, 1, SHA, snippet, 'test'];
// createEdge: boardId, fromNode, toNode, label, evidence, imported, evidenceSnippet, evidenceStatus
const citeArgs = (B, from, to, snippet) => [B, from, to, 'calls', 'source:src/a.ts:1', NONE, some(snippet), NONE];

async function nodeOn(who, B, label) {
  await ok(who.token, 'create_node', nodeArgs(B, label));
  return (await sql(OWNER, `SELECT * FROM node WHERE board_id = ${B}`)).find(n => n.label === label).id;
}

/** Two nodes and src/a.ts in the board's repo. */
async function furnish(who, B) {
  await ok(who.token, 'add_repo_files', [B, ['src/a.ts']]);
  return { B, a: await nodeOn(who, B, 'a'), b: await nodeOn(who, B, 'b') };
}

async function boardOf(who, label) {
  const name = named(label);
  await ok(who.token, 'create_board', [name]);
  const [{ id }] = await sql(OWNER, `SELECT id FROM board WHERE name = '${name}'`);
  return furnish(who, id);
}

/** A ref with text and a citation with its line: what a board with consent keeps. */
async function storeCode(who, { B, a, b }) {
  await ok(who.token, 'add_code_ref', refArgs(B, a, 'verify', 'function verify() {}'));
  await ok(who.token, 'create_edge', citeArgs(B, a, b, 'verify();'));
}

/** Every code text the database holds for the board: ref snippets, then edge evidence snippets. */
async function storedOn(B) {
  const refs = await sql(OWNER, `SELECT snippet FROM code_ref WHERE board_id = ${B}`);
  const edges = await sql(OWNER, `SELECT evidence_snippet FROM edge WHERE board_id = ${B}`);
  return [...refs.map(r => r.snippet), ...edges.map(e => e.evidenceSnippet)];
}

const myConsent = who => sql(who.token, 'SELECT * FROM my_code_consent');

/** A snapshot board `agent` owns: linking leaves architecture boards with their history's owner. */
async function snapshotBoardOf(agent, label) {
  const name = named(label);
  await ok(agent.token, 'create_architecture_history', [name, 'https://github.com/example/repo', JSON.stringify([{ ref: 'main', sha: SHA }]), name]);
  const h = (await sql(agent.token, 'SELECT * FROM my_architecture_histories')).find(r => r.requestKey === name);
  const graph = {
    nodes: ['a', 'b'].map(key => ({ key, label: key, sublabel: '', kind: 'service' })),
    edges: [{ from: 'a', to: 'b', label: 'uses', relation: 'import', evidence: 'import' }],
    files: ['src/a.ts'],
  };
  await ok(svc.token, 'publish_architecture_snapshot', [h.id, 0, 'main', SHA, JSON.stringify(graph)]);
  const [v] = await sql(OWNER, `SELECT * FROM architecture_version WHERE history_id = ${h.id}`);
  const nodes = await sql(OWNER, `SELECT * FROM node WHERE board_id = ${v.boardId}`);
  return { B: v.boardId, a: nodes.find(n => n.sourceKey === 'a').id };
}

async function link(agent, person) {
  const c = code();
  await ok(agent.token, 'offer_agent_link', [c]);
  await ok(person.token, 'redeem_agent_link', [c]);
}

/** The stored line hash: SHA-256 of the line's UTF-8 text, lowercase hex, first 32 chars. */
const hashOf = line => createHash('sha256').update(line).digest('hex').slice(0, 32);
const refsOf = async B => sql(OWNER, `SELECT * FROM code_ref WHERE board_id = ${B}`);
const edgesOf = async B => sql(OWNER, `SELECT * FROM edge WHERE board_id = ${B}`);
/** Every hash row the database holds for the board: ref hashes, then citation hashes. */
async function hashesOn(B) {
  const refs = await sql(OWNER, `SELECT * FROM code_ref_hash WHERE board_id = ${B}`);
  const edges = await sql(OWNER, `SELECT * FROM edge_evidence_hash WHERE board_id = ${B}`);
  return { refs: refs.map(r => r.refId).sort(), edges: edges.map(e => e.edgeId).sort() };
}

const ownerOf = async B => hexOf((await sql(OWNER, `SELECT * FROM board_grant WHERE board_id = ${B}`)).find(g => g.role === 'owner').grantee);

let svc;
before(async () => {
  svc = await mint();
  await sql(OWNER, `INSERT INTO service_account (identity, label) VALUES (0x${svc.identity}, 'code-consent-tests')`);
});

// --- the setting -------------------------------------------------------------

test('default off: a new member stores no snippet, and refs without one still work', async () => {
  const who = await mint();
  const { B, a } = await boardOf(who, 'cc-off');
  assert.deepEqual(await myConsent(who), [{ storeCode: false, boardsWithCode: 0 }]);
  await rejects(who.token, 'add_code_ref', refArgs(B, a, 'verify', 'function verify() {}'), CODE_CONSENT_RULE);
  await ok(who.token, 'add_code_ref', refArgs(B, a, 'verify', ''));
  const [ref] = await sql(OWNER, `SELECT * FROM code_ref WHERE board_id = ${B}`);
  await rejects(who.token, 'update_code_ref', [ref.id, 2, 2, SHA, 'function verify() {}', 'ok'], CODE_CONSENT_RULE);
  await rejects(who.token, 'update_code_ref_and_focus', [ref.id, 2, 2, SHA, 'function verify() {}', 'ok'], CODE_CONSENT_RULE);
  await ok(who.token, 'update_code_ref', [ref.id, 2, 2, SHA, '', 'ok']);
  assert.deepEqual(await storedOn(B), ['']);
});

test('create_edge text refused: a source citation keeps no captured line without consent', async () => {
  const who = await mint();
  const { B, a, b } = await boardOf(who, 'cc-edge');
  await rejects(who.token, 'create_edge', citeArgs(B, a, b, 'verify();'), CODE_CONSENT_RULE);
  await ok(who.token, 'create_edge', [B, a, b, 'calls', 'source:src/a.ts:1', NONE, NONE, NONE]);
  assert.deepEqual(await storedOn(B), ['']);
});

test('opt in: the member\'s boards store snippets, and my_code_consent counts the boards that hold some', async () => {
  const who = await mint();
  const board = await boardOf(who, 'cc-on');
  await boardOf(who, 'cc-on-empty');
  await ok(who.token, 'set_code_consent', [true]);
  await storeCode(who, board);
  assert.deepEqual(await storedOn(board.B), ['function verify() {}', 'verify();']);
  assert.deepEqual(await myConsent(who), [{ storeCode: true, boardsWithCode: 1 }]);
  const [row] = await sql(OWNER, `SELECT * FROM code_consent WHERE key = 'user:${who.identity}'`);
  assert.deepEqual([row.scope, row.subject, row.storeCode, hexOf(row.updatedBy)], ['user', who.identity, true, who.identity]);
});

test("opt out purges: turning consent off blanks the stored code on every board the member owns, and no one else's", async () => {
  const who = await mint(), other = await mint();
  const one = await boardOf(who, 'cc-purge-1'), two = await boardOf(who, 'cc-purge-2'), theirs = await boardOf(other, 'cc-purge-other');
  for (const [person, board] of [[who, one], [who, two], [other, theirs]]) {
    await ok(person.token, 'set_code_consent', [true]);
    await storeCode(person, board);
  }
  assert.equal((await myConsent(who))[0].boardsWithCode, 2);
  await ok(who.token, 'set_code_consent', [false]);
  assert.deepEqual(await storedOn(one.B), ['', '']);
  assert.deepEqual(await storedOn(two.B), ['', '']);
  assert.deepEqual(await myConsent(who), [{ storeCode: false, boardsWithCode: 0 }]);
  // the ref and the citation stay, without their text
  const [ref] = await sql(OWNER, `SELECT * FROM code_ref WHERE board_id = ${one.B}`);
  const [edge] = await sql(OWNER, `SELECT * FROM edge WHERE board_id = ${one.B}`);
  assert.deepEqual([ref.symbol, ref.startLine, edge.evidence], ['verify', 1, 'source:src/a.ts:1']);
  assert.deepEqual(await storedOn(theirs.B), ['function verify() {}', 'verify();']);
});

// --- agents follow their person ----------------------------------------------

test("agent board follows its person: a linked agent's own board stores code only with its person's consent", async () => {
  const person = await mint(), agent = await mint();
  const board = await snapshotBoardOf(agent, 'cc-agent');
  await link(agent, person);
  assert.equal(await ownerOf(board.B), agent.identity, 'the agent still owns its snapshot board');
  // the agent's own row does not count while it is linked
  await ok(agent.token, 'set_code_consent', [true]);
  await rejects(agent.token, 'add_code_ref', refArgs(board.B, board.a, 'verify', 'function verify() {}'), CODE_CONSENT_RULE);
  await ok(person.token, 'set_code_consent', [true]);
  await ok(agent.token, 'add_code_ref', refArgs(board.B, board.a, 'verify', 'function verify() {}'));
  assert.deepEqual(await myConsent(person), [{ storeCode: true, boardsWithCode: 1 }]);
  assert.deepEqual(await storedOn(board.B), ['function verify() {}', '']); // the ref, then the snapshot's import edge
  await ok(person.token, 'set_code_consent', [false]);
  assert.deepEqual(await storedOn(board.B), ['', '']);
});

test('unlinked agent board: without a person the board takes no code, and unlinking blanks what it kept', async () => {
  const person = await mint(), agent = await mint();
  const board = await snapshotBoardOf(agent, 'cc-unlinked');
  await rejects(agent.token, 'add_code_ref', refArgs(board.B, board.a, 'verify', 'function verify() {}'), CODE_CONSENT_RULE);
  await link(agent, person);
  await ok(person.token, 'set_code_consent', [true]);
  await ok(agent.token, 'add_code_ref', refArgs(board.B, board.a, 'verify', 'function verify() {}'));
  assert.deepEqual(await storedOn(board.B), ['function verify() {}', '']);
  await ok(person.token, 'unlink_agent', [identity(agent)]);
  assert.deepEqual(await storedOn(board.B), ['', '']);
  await rejects(agent.token, 'add_code_ref', refArgs(board.B, board.a, 'other', 'function other() {}'), CODE_CONSENT_RULE);
});

// --- owner changes -----------------------------------------------------------

test('owner change purges: a guest board claimed by an account without consent keeps no code', async () => {
  const guest = await mint(), account = await mint();
  await ok(guest.token, 'set_code_consent', [true]);
  await ok(guest.token, 'ensure_guest_board', [NONE]);
  const [{ boardId }] = await sql(guest.token, 'SELECT * FROM my_guest_board');
  const board = await furnish(guest, boardId);
  await storeCode(guest, board);
  assert.deepEqual(await storedOn(board.B), ['function verify() {}', 'verify();']);
  const c = code();
  await ok(guest.token, 'offer_guest_claim', [board.B, c]);
  await ok(account.token, 'claim_guest_board', [board.B, c]);
  assert.equal(await ownerOf(board.B), account.identity);
  assert.deepEqual(await storedOn(board.B), ['', '']);
});

test('owner change purges: an agent board adopted by a person without consent keeps no code', async () => {
  const agent = await mint(), person = await mint();
  const board = await boardOf(agent, 'cc-adopt');
  await ok(agent.token, 'set_code_consent', [true]); // an unlinked agent's boards follow its own row
  await storeCode(agent, board);
  await link(agent, person);
  assert.equal(await ownerOf(board.B), person.identity);
  assert.deepEqual(await storedOn(board.B), ['', '']);
});

test("owner change purges: relinking an agent to a person without consent blanks the board it keeps", async () => {
  const relinks = {
    redeem_agent_link: (agent, person) => link(agent, person),
    link_hosted_agent: (agent, person) => ok(svc.token, 'link_hosted_agent', [identity(agent), identity(person)]),
  };
  for (const [label, relink] of Object.entries(relinks)) {
    const agent = await mint(), on = await mint(), off = await mint();
    const board = await snapshotBoardOf(agent, `cc-relink-${label}`);
    await link(agent, on);
    await ok(on.token, 'set_code_consent', [true]);
    await ok(agent.token, 'add_code_ref', refArgs(board.B, board.a, 'verify', 'function verify() {}'));
    await relink(agent, off);
    assert.deepEqual(await storedOn(board.B), ['', ''], label);
  }
});

test("an unchanged link blanks nothing: start_session and a repeated link keep the text on the agent's own board", async () => {
  const person = await mint(), agent = await mint();
  const board = await snapshotBoardOf(agent, 'cc-same-link');
  await link(agent, person);
  await ok(agent.token, 'add_code_ref', refArgs(board.B, board.a, 'verify', ''));
  // text stored before consent existed: it stays until the person chooses, or the wipe
  await sql(OWNER, `UPDATE code_ref SET snippet = 'function verify() {}' WHERE board_id = ${board.B}`);
  await ok(agent.token, 'start_session', [named('cc-same-link'), '/tmp/cc-same-link', SHA]);
  await ok(svc.token, 'link_hosted_agent', [identity(agent), identity(person)]);
  await link(agent, person);
  assert.deepEqual(await storedOn(board.B), ['function verify() {}', '']);
  assert.deepEqual(await myConsent(person), [{ storeCode: false, boardsWithCode: 0 }], 'boards are counted only while consent is on');
});

// --- hashes and remote (Decisions 2-4) -------------------------------------------

test('hash rows: members and links that carry code read line hashes and the remote; a link without code does not', async () => {
  const owner = await mint(), viewer = await mint(), stranger = await mint();
  const { B, a, b } = await boardOf(owner, 'cc-hash');
  await ok(owner.token, 'add_code_ref', refArgs(B, a, 'verify', ''));
  await ok(owner.token, 'create_edge', [B, a, b, 'calls', 'source:src/a.ts:1', NONE, NONE, some('ok')]);
  const [ref] = await refsOf(B), [edge] = await edgesOf(B);
  const lines = [hashOf('function verify() {'), hashOf('}')].join(' ');
  await ok(owner.token, 'set_code_ref_hashes', [ref.id, hashOf('stale')]);
  await ok(owner.token, 'set_code_ref_hashes', [ref.id, lines]); // replaces, one row per ref
  await ok(owner.token, 'set_edge_evidence_code', [edge.id, hashOf('verify();'), NONE]);
  await ok(owner.token, 'set_session_remote', [B, 'git@github.com:example/repo.git', SHA, ['src/a.ts']]);
  const seen = async who => ({
    refs: (await sql(who.token, `SELECT * FROM visible_code_ref_hash WHERE board_id = ${B}`)).map(r => r.lineHashes),
    edges: (await sql(who.token, `SELECT * FROM visible_edge_evidence_hash WHERE board_id = ${B}`)).map(e => e.lineHash),
    remote: (await sql(who.token, `SELECT * FROM visible_session_remote WHERE board_id = ${B}`)).map(r => [r.remoteUrl, r.pushedHead, r.dirtyPaths]),
  });
  const everything = { refs: [lines], edges: [hashOf('verify();')], remote: [['git@github.com:example/repo.git', SHA, ['src/a.ts']]] };
  const nothing = { refs: [], edges: [], remote: [] };
  assert.deepEqual(await seen(owner), everything);
  assert.deepEqual(await seen(stranger), nothing);
  const token = randomBytes(16).toString('hex');
  await ok(owner.token, 'set_link_share', [B, 'view', token]);
  await ok(viewer.token, 'open_shared_link', [token]);
  assert.deepEqual(await seen(viewer), nothing, 'a new link carries no code');
  await rejects(viewer.token, 'set_code_ref_hashes', [ref.id, lines], 'read only');
  await rejects(viewer.token, 'set_session_remote', [B, 'https://github.com/example/repo', '', []], 'read only');
  await ok(owner.token, 'set_link_share_includes', [B, false, true]);
  assert.deepEqual(await seen(viewer), everything);
  await ok(owner.token, 'set_link_share_includes', [B, false, false]);
  await ok(owner.token, 'set_link_share', [B, 'edit', token]);
  assert.deepEqual(await seen(viewer), everything, 'an edit link carries code: undo replays the hashes');
  // the module stores what writers send, in the agreed shape
  const many = Array.from({ length: 61 }, (_, i) => hashOf(String(i))).join(' ');
  for (const bad of ['', 'abc', hashOf('x').toUpperCase(), `${lines} `, many]) {
    await rejects(owner.token, 'set_code_ref_hashes', [ref.id, bad], 'code ref rule: lineHashes');
  }
  await rejects(owner.token, 'set_edge_evidence_code', [edge.id, `${hashOf('x')} ${hashOf('y')}`, NONE], 'evidence rule: lineHash');
  await rejects(owner.token, 'set_session_remote', [B, 'https://ghp_secret@github.com/example/repo', '', []], 'remote rule');
  await rejects(owner.token, 'set_session_remote', [B, 'https://github.com/example/repo', 'main', []], 'pushedHead');
});

test('checkpoint bump follows line hashes: other hashes are new code; a first insert, the same hashes, or text appearing or vanishing are not', async () => {
  const who = await mint();
  const name = named('cc-bump');
  await ok(who.token, 'start_session', [name, `/tmp/${name}`, SHA]);
  const [{ id }] = await sql(OWNER, `SELECT id FROM board WHERE name = '${name}'`);
  const { B, a } = await furnish(who, id);
  await ok(who.token, 'add_code_ref', refArgs(B, a, 'verify', '')); // belongs to checkpoint 1
  const [ref] = await refsOf(B);
  const at = async () => (await refsOf(B))[0].checkpoint;
  const advance = () => ok(who.token, 'mark_checkpoint', [B, SHA, '{}']); // new code now belongs to the next one
  assert.equal(await at(), 1);
  await advance();
  await ok(who.token, 'set_code_ref_hashes', [ref.id, hashOf('function verify() {}')]); // the first row: a fill
  assert.equal(await at(), 1);
  await ok(who.token, 'set_code_ref_hashes', [ref.id, hashOf('function verify() {}')]); // the same lines
  assert.equal(await at(), 1);
  await ok(who.token, 'set_code_ref_hashes', [ref.id, hashOf('function verify() { return 1; }')]); // other lines
  assert.equal(await at(), 2);
  await advance();
  await ok(who.token, 'set_code_consent', [true]);
  await ok(who.token, 'update_code_ref', [ref.id, 1, 1, SHA, 'function verify() { return 1; }', 'ok']); // '' -> text: consent turned on
  assert.equal(await at(), 2);
  await ok(who.token, 'update_code_ref', [ref.id, 1, 1, SHA, 'function verify() { return 2; }', 'ok']); // other text: as before
  assert.equal(await at(), 3);
  await advance();
  await ok(who.token, 'update_code_ref', [ref.id, 1, 1, SHA, '', 'ok']); // text -> '': kept none
  assert.equal(await at(), 3);
});

test('set_edge_evidence_code: the line hash always, the captured line only with consent', async () => {
  const who = await mint();
  const { B, a, b } = await boardOf(who, 'cc-edge-code');
  await ok(who.token, 'create_edge', [B, a, b, 'calls', 'source:src/a.ts:1', NONE, NONE, some('ok')]);
  await ok(who.token, 'create_edge', [B, b, a, 'calls back', 'import', NONE, NONE, NONE]);
  const edges = await edgesOf(B), cited = edges.find(e => e.label === 'calls'), plain = edges.find(e => e.label === 'calls back');
  await rejects(who.token, 'set_edge_evidence_code', [cited.id, hashOf('verify();'), some('verify();')], CODE_CONSENT_RULE);
  assert.deepEqual(await hashesOn(B), { refs: [], edges: [] }, 'a refused call writes no hash');
  await ok(who.token, 'set_edge_evidence_code', [cited.id, hashOf('verify();'), some('')]);
  await ok(who.token, 'set_edge_evidence_code', [cited.id, hashOf('verify();'), NONE]);
  assert.deepEqual(await hashesOn(B), { refs: [], edges: [cited.id] });
  await rejects(who.token, 'set_edge_evidence_code', [plain.id, hashOf('x'), NONE], 'only source citations carry captured evidence');
  await ok(who.token, 'set_code_consent', [true]);
  await rejects(who.token, 'set_edge_evidence_code', [cited.id, hashOf('a'), some('a\nb')], 'captured source line must be one nonblank line');
  await ok(who.token, 'set_edge_evidence_code', [cited.id, hashOf('verify();'), some('verify();')]);
  assert.equal((await edgesOf(B)).find(e => e.id === cited.id).evidenceSnippet, 'verify();');
  const stranger = await mint();
  await rejects(stranger.token, 'set_edge_evidence_code', [cited.id, hashOf('x'), NONE], 'not authorized');
});

test('ok without text: a citation is ok without its line where the board keeps no code; where it does, only a new one is (undo restores it)', async () => {
  const who = await mint();
  const { B, a, b } = await boardOf(who, 'cc-ok-off');
  const okCite = (line, label = 'calls') => [B, a, b, label, `source:src/a.ts:${line}`, NONE, NONE, some('ok')];
  await ok(who.token, 'create_edge', okCite(1));
  const [edge] = await edgesOf(B);
  assert.deepEqual([edge.evidenceStatus, edge.evidenceSnippet], ['ok', '']);
  await ok(who.token, 'update_edge_evidence', [edge.id, 'source:src/a.ts:2', 'ok']);
  await rejects(who.token, 'create_edge', okCite(0, 'line zero'), 'must be a positive integer');
  await ok(who.token, 'set_code_consent', [true]);
  // undo restores a wiped or never-filled citation as ok with no text; its hash follows through set_edge_evidence_code
  await ok(who.token, 'create_edge', okCite(3, 'with consent'));
  assert.deepEqual((await edgesOf(B)).filter(e => e.label === 'with consent').map(e => [e.evidenceStatus, e.evidenceSnippet]), [['ok', '']]);
  await rejects(who.token, 'update_edge_evidence', [edge.id, 'source:src/a.ts:3', 'ok'], 'ok source evidence requires a captured line');
  // a citation whose hash is stored can move without its line (it fills in at the next checkpoint)
  await ok(who.token, 'set_edge_evidence_code', [edge.id, hashOf('verify();'), NONE]);
  await ok(who.token, 'update_edge_evidence', [edge.id, 'source:src/a.ts:3', 'ok']);
});

test('reader check skips missing text: a reader ref without stored text is accepted; one whose text lacks the term is not', async () => {
  const who = await mint();
  const { B, a, b } = await boardOf(who, 'cc-reader');
  const subjects = JSON.stringify([{ table: 'customers', column: 'name' }]);
  const readers = (...ids) => JSON.stringify(ids.map(id => ({ refId: String(id), subject: 0 })));
  await ok(who.token, 'add_code_ref', refArgs(B, a, 'customers', ''));
  await ok(who.token, 'add_code_ref', refArgs(B, b, 'loadBillTo', ''));
  const refId = symbol => refsOf(B).then(refs => refs.find(r => r.symbol === symbol).id);
  const main = await refId('customers'), reader = await refId('loadBillTo');
  // addChangeNote: boardId, anchorId, kind, severity, title, summary, refId, steps, schema, subjects, readers, author
  const note = rs => [B, a, 'migration', 'destructive', 'Migration 1', 'Drops name.', main, '[]', '', subjects, rs, 'agent'];
  await ok(who.token, 'add_change_note', note(readers(reader)));
  const [{ id }] = await sql(OWNER, `SELECT * FROM change_note WHERE board_id = ${B}`);
  // updateChangeNote: id, kind, severity, title, summary, refId, steps, schema, subjects, readers (all optional)
  const patch = (subjectsJson, readersJson) => [id, NONE, NONE, NONE, NONE, NONE, NONE, NONE, subjectsJson ? some(subjectsJson) : NONE, readersJson ? some(readersJson) : NONE];
  await ok(who.token, 'update_change_note', patch(JSON.stringify([{ table: 'customers', column: 'full_name' }])));
  await ok(who.token, 'set_code_consent', [true]);
  await ok(who.token, 'add_code_ref', refArgs(B, b, 'fullName', 'const fullName = row.first_name;'));
  const lacking = await refId('fullName');
  await rejects(who.token, 'add_change_note', note(readers(lacking)), READER_TERM_RULE);
  await rejects(who.token, 'update_change_note', patch(undefined, readers(reader, lacking)), READER_TERM_RULE);
});

test('cascade: removing a code ref, an edge or a node removes their hash rows', async () => {
  const who = await mint();
  const { B, a, b } = await boardOf(who, 'cc-cascade');
  const c = await nodeOn(who, B, 'c');
  const cite = (from, to, label) => ok(who.token, 'create_edge', [B, from, to, label, 'source:src/a.ts:1', NONE, NONE, some('ok')]);
  await cite(a, b, 'a-b');
  await cite(b, c, 'b-c');
  const edges = await edgesOf(B), ab = edges.find(e => e.label === 'a-b').id, bc = edges.find(e => e.label === 'b-c').id;
  await ok(who.token, 'add_code_ref', refArgs(B, a, 'onA', ''));
  await ok(who.token, 'add_code_ref', refArgs(B, b, 'onB', ''));
  await ok(who.token, 'add_code_ref', [B, 'edge', bc, 'src/a.ts', 'onBC', 1, 1, SHA, '', 'test']);
  const refs = await refsOf(B), ref = symbol => refs.find(r => r.symbol === symbol).id;
  for (const r of refs) await ok(who.token, 'set_code_ref_hashes', [r.id, hashOf(r.symbol)]);
  for (const e of [ab, bc]) await ok(who.token, 'set_edge_evidence_code', [e, hashOf('x'), NONE]);
  const sorted = ids => [...ids].sort();
  assert.deepEqual(await hashesOn(B), { refs: sorted([ref('onA'), ref('onB'), ref('onBC')]), edges: sorted([ab, bc]) });
  await ok(who.token, 'remove_code_ref', [ref('onA')]);
  assert.deepEqual(await hashesOn(B), { refs: sorted([ref('onB'), ref('onBC')]), edges: sorted([ab, bc]) });
  await ok(who.token, 'delete_edge', [ab]);
  assert.deepEqual(await hashesOn(B), { refs: sorted([ref('onB'), ref('onBC')]), edges: [bc] });
  // b's ref, its edge b-c and that edge's ref go with it
  await ok(who.token, 'delete_node', [b]);
  assert.deepEqual(await hashesOn(B), { refs: [], edges: [] });
});

test('a proposal copies its base board\'s hash rows onto its own refs and edges', async () => {
  const who = await mint();
  const name = named('cc-proposal');
  await ok(who.token, 'create_architecture_history', [name, 'https://github.com/example/repo', JSON.stringify([{ ref: 'main', sha: SHA }]), name]);
  const h = (await sql(who.token, 'SELECT * FROM my_architecture_histories')).find(r => r.requestKey === name);
  const graph = {
    nodes: ['a', 'b'].map(key => ({ key, label: key, sublabel: '', kind: 'service' })),
    edges: [{ from: 'a', to: 'b', label: 'uses', relation: 'import', evidence: 'import' }],
    files: ['src/a.ts'],
  };
  await ok(svc.token, 'publish_architecture_snapshot', [h.id, 0, 'main', SHA, JSON.stringify(graph)]);
  const [{ boardId: base }] = await sql(OWNER, `SELECT * FROM architecture_version WHERE history_id = ${h.id}`);
  const a = (await sql(OWNER, `SELECT * FROM node WHERE board_id = ${base}`)).find(n => n.sourceKey === 'a').id;
  await ok(who.token, 'add_code_ref', refArgs(base, a, 'verify', ''));
  const [ref] = await refsOf(base), [edge] = await edgesOf(base);
  await ok(who.token, 'set_code_ref_hashes', [ref.id, hashOf('function verify() {}')]);
  // a fact snapshot cites imports only, so its citation hash is planted
  await sql(OWNER, `INSERT INTO edge_evidence_hash (edge_id, board_id, line_hash) VALUES (${edge.id}, ${base}, '${hashOf('verify();')}')`);
  await ok(who.token, 'create_architecture_proposal', [base, named('cc-proposal-draft'), named('cc-proposal-key')]);
  const [{ boardId: P }] = (await sql(OWNER, `SELECT * FROM architecture_version WHERE base_board_id = ${base}`));
  const [copiedRef] = await refsOf(P), [copiedEdge] = await edgesOf(P);
  const refHashes = await sql(OWNER, `SELECT * FROM code_ref_hash WHERE board_id = ${P}`);
  const edgeHashes = await sql(OWNER, `SELECT * FROM edge_evidence_hash WHERE board_id = ${P}`);
  assert.deepEqual(refHashes.map(r => [r.refId, r.lineHashes]), [[copiedRef.id, hashOf('function verify() {}')]]);
  assert.deepEqual(edgeHashes.map(e => [e.edgeId, e.lineHash]), [[copiedEdge.id, hashOf('verify();')]]);
  assert.deepEqual(await hashesOn(base), { refs: [ref.id], edges: [edge.id] }, 'the base keeps its own');
});

// --- Demo --------------------------------------------------------------------

test('demo keeps code: seeding Demo opts its owner in, also on a database where Demo already exists', async () => {
  await ok(svc.token, 'seed_demo_board', []);
  const [demo] = await sql(OWNER, "SELECT id FROM board WHERE name = 'Demo'");
  const key = `user:${await ownerOf(demo.id)}`;
  const consent = async () => (await sql(OWNER, `SELECT * FROM code_consent WHERE key = '${key}'`)).map(r => r.storeCode);
  assert.deepEqual(await consent(), [true]);
  const edges = await sql(OWNER, `SELECT * FROM edge WHERE board_id = ${demo.id}`);
  assert.ok(edges.some(e => e.evidence.startsWith('source:') && e.evidenceSnippet !== ''), 'Demo keeps its sample source line');
  await ok(svc.token, 'seed_demo_board', []);
  assert.deepEqual(await consent(), [true]);
  // a database whose Demo predates consent gets the row on the next seed
  await sql(OWNER, `DELETE FROM code_consent WHERE key = '${key}'`);
  await ok(svc.token, 'seed_demo_board', []);
  assert.deepEqual(await consent(), [true]);
});

test("demo seeding: a member's own board named Demo is not Demo, so its owner is not opted in and the real Demo is still seeded", async () => {
  await ok(svc.token, 'seed_demo_board', []);
  const who = await mint();
  const name = named('cc-demo-name');
  await ok(who.token, 'create_board', [name]);
  const [{ id: mine }] = await sql(OWNER, `SELECT id FROM board WHERE name = '${name}'`);
  const parked = (await sql(OWNER, "SELECT id FROM board WHERE name = 'Demo'")).map(b => b.id);
  assert.ok(parked.length > 0, 'a Demo exists to step aside');
  const rename = (ids, to) => Promise.all(ids.map(id => sql(OWNER, `UPDATE board SET name = '${to}' WHERE id = ${id}`)));
  let seeded = [];
  // The reducer walks boards by id, so the member's board must be the only one called Demo for the old check to reach it first.
  // Put every other Demo aside for the length of one call, and put it back.
  try {
    await rename(parked, named('Demo-parked'));
    await rename([mine], 'Demo');
    await ok(svc.token, 'seed_demo_board', []);
    seeded = (await sql(OWNER, "SELECT id FROM board WHERE name = 'Demo'")).map(b => b.id).filter(id => id !== mine);
    assert.equal(seeded.length, 1, 'the real Demo was seeded');
    assert.ok((await sql(OWNER, 'SELECT * FROM public_board')).some(r => r.boardId === seeded[0]), 'and is public');
    assert.equal(await ownerOf(seeded[0]), svc.identity, 'and belongs to the service that seeded it');
    assert.deepEqual(await sql(OWNER, `SELECT * FROM code_consent WHERE key = 'user:${who.identity}'`), [], "the member's row was not created");
    assert.deepEqual(await myConsent(who), [{ storeCode: false, boardsWithCode: 0 }]);
  } finally {
    await rename([mine], name);
    await rename(parked, 'Demo');
    for (const id of seeded) await ok(svc.token, 'delete_board', [id]);
  }
});

// --- the one-time wipe (scripts/wipe-stored-code.mjs) ------------------------

const WIPE_SCRIPT = new URL('./wipe-stored-code.mjs', import.meta.url).pathname;
/** The script as the runbook runs it, against this database; rejects when it exits non-zero. */
const runWipeScript = (flags = [], token = svc.token) =>
  promisify(execFile)(process.execPath, ['--experimental-strip-types', '--no-warnings', WIPE_SCRIPT, '--url', BASE, '--db', DB, ...flags], {
    env: { ...process.env, STDB_OWNER_TOKEN: OWNER, STDB_SERVICE_TOKEN: token },
  });

/** The script acts on every board in the database, so two runs of this file against one database (the suite lists it twice) take turns. */
async function alone(run) {
  const dir = `${tmpdir()}/wipe-stored-code-${DB}.lock`;
  for (;;) {
    try { mkdirSync(dir); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - statSync(dir).mtimeMs > 60_000) rmSync(dir, { recursive: true }); } catch {} // left by a killed run
      await new Promise(r => setTimeout(r, 50));
    }
  }
  try { await run(); } finally { rmSync(dir, { recursive: true, force: true }); }
}

const REF_LINES = ['function verify() {', '  return 1;', '}'];
const WRITTEN = [REF_LINES.join('\n'), 'verify();'];

/** A board holding code text, as every board does when this ships: its owner opted in once, and has no row now unless `optedIn`. */
async function boardHoldingCode(label, { optedIn = false } = {}) {
  const who = await mint();
  const board = await boardOf(who, label);
  const { B, a, b } = board;
  await ok(who.token, 'set_code_consent', [true]);
  await ok(who.token, 'add_code_ref', [B, 'node', a, 'src/a.ts', 'verify', 1, 3, SHA, REF_LINES.join('\n'), 'test']);
  await ok(who.token, 'create_edge', citeArgs(B, a, b, 'verify();'));
  await ok(who.token, 'create_edge', [B, a, b, 'no line', 'source:src/a.ts:2', NONE, NONE, some('stale')]);
  await ok(who.token, 'create_edge', [B, b, a, 'plain', 'import', NONE, NONE, NONE]);
  if (!optedIn) await sql(OWNER, `DELETE FROM code_consent WHERE key = 'user:${who.identity}'`);
  return board;
}

const nonEmpty = list => list.filter(s => s !== '');

test('wipe_stored_code is for service accounts only', async () => {
  const who = await mint();
  await rejects(who.token, 'wipe_stored_code', [], 'service account only');
});

test('wipe script: pass 1 hashes every ref and source citation with text and leaves the text; --wipe then blanks boards without consent only', () => alone(async () => {
  await ok(svc.token, 'seed_demo_board', []);
  const W = await boardHoldingCode('cc-wipe');
  const K = await boardHoldingCode('cc-wipe-kept', { optedIn: true });
  const [{ id: D }] = await sql(OWNER, "SELECT id FROM board WHERE name = 'Demo'");
  assert.deepEqual(nonEmpty(await storedOn(W.B)), WRITTEN);

  const first = await runWipeScript();
  assert.match(first.stdout, /code refs with text: \d+ \(hashed now: [1-9]\d*, already hashed: \d+, failed: 0\)/);
  assert.match(first.stdout, /source citations with text: \d+ \(hashed now: [1-9]\d*, already hashed: \d+, failed: 0\)/);
  for (const B of [W.B, K.B]) {
    assert.deepEqual(nonEmpty(await storedOn(B)), WRITTEN, 'pass 1 leaves the text');
    const [ref] = await sql(OWNER, `SELECT * FROM code_ref_hash WHERE board_id = ${B}`);
    assert.equal(ref.lineHashes, REF_LINES.map(hashOf).join(' '));
    const [edge] = await sql(OWNER, `SELECT * FROM edge_evidence_hash WHERE board_id = ${B}`);
    assert.equal(edge.lineHash, hashOf('verify();'));
    assert.equal((await hashesOn(B)).edges.length, 1, 'a citation without a line, and a plain edge, get no hash');
  }
  const demoRefs = (await refsOf(D)).filter(r => r.snippet !== ''), demoEdges = (await edgesOf(D)).filter(e => e.evidence.startsWith('source:') && e.evidenceSnippet !== '');
  assert.ok(demoEdges.length > 0, 'Demo holds a sample source line');
  const demoHashes = await hashesOn(D);
  for (const r of demoRefs) assert.ok(demoHashes.refs.includes(r.id), `Demo ref ${r.symbol} has hashes`);
  for (const e of demoEdges) assert.ok(demoHashes.edges.includes(e.id), `Demo edge ${e.label} has a hash`);

  assert.match((await runWipeScript(['--wipe'])).stdout, /wiped/);
  assert.deepEqual(nonEmpty(await storedOn(W.B)), [], 'a board without consent keeps no text');
  assert.equal((await hashesOn(W.B)).refs.length, 1, 'its hashes stay');
  assert.deepEqual(nonEmpty(await storedOn(K.B)), WRITTEN, 'a board whose owner opted in keeps its text');
  assert.ok((await edgesOf(D)).some(e => e.evidenceSnippet !== ''), 'Demo keeps its sample source line');
}));

test('wipe script: a hash that cannot be written stops --wipe, so no text is lost', () => alone(async () => {
  const W = await boardHoldingCode('cc-wipe-fail');
  // not a service account, so not a member of W: every hash write is refused
  const stranger = await mint();
  await assert.rejects(runWipeScript(['--wipe'], stranger.token), err => err.code === 1 && /failed: [1-9]/.test(err.stdout) && /no text was wiped/.test(err.stderr));
  assert.deepEqual(nonEmpty(await storedOn(W.B)), WRITTEN);
}));

test('branch merge: a cited edge added on the branch reaches the base with its line hash', async () => {
  const user = await mint();
  await ok(user.token, 'set_code_consent', [true]);
  const { B } = await boardOf(user, 'merge-hash');
  await ok(user.token, 'create_architecture_proposal', [B, named('merge-hash'), named('merge-hash')]);
  const [v] = await sql(OWNER, `SELECT * FROM architecture_version WHERE base_board_id = ${B}`);
  const branchNodes = await sql(OWNER, `SELECT * FROM node WHERE board_id = ${v.boardId}`);
  const [a, b] = ['a', 'b'].map(l => branchNodes.find(n => n.label === l));
  await ok(user.token, 'create_edge', citeArgs(v.boardId, a.id, b.id, 'verify();'));
  const [cited] = await sql(OWNER, `SELECT * FROM edge WHERE board_id = ${v.boardId}`);
  await ok(user.token, 'set_edge_evidence_code', [cited.id, hashOf('verify();'), NONE]);
  await ok(user.token, 'submit_architecture_proposal', [v.boardId]);
  await ok(user.token, 'review_architecture_proposal', [v.boardId, 'accept']);
  await ok(user.token, 'merge_architecture_proposal', [v.boardId]);
  const merged = (await sql(OWNER, `SELECT * FROM edge WHERE board_id = ${B}`)).find(e => e.evidence === 'source:src/a.ts:1');
  assert.equal(merged.evidenceSnippet, 'verify();');
  const [hash] = await sql(OWNER, `SELECT * FROM edge_evidence_hash WHERE edge_id = ${merged.id}`);
  assert.equal(hash?.lineHash, hashOf('verify();'));
  assert.equal(hash?.boardId, B);
});
