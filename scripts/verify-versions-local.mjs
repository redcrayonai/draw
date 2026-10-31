// Versions plugin against a real database (PLUGINS.md): the workspace switch, save, list and
// restore with their access rules, consistent capture under concurrent writes, and refused
// bundles. Storage is the dashboard server's (web/src/lib/server/versions.ts); here the test
// plays that server with the service token. Run alone after verify-workspaces-local.mjs: both
// serve the saved ES256 issuer on STDB_TEST_ISSUER_PORT.
//
//   nix develop --command scripts/stdb-test.sh run
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, randomUUID, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { identityFromClaims } from '../shared/identity.ts';

registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); }
  catch (error) {
    if (specifier.startsWith('.')) return nextResolve(`${specifier}.ts`, context);
    throw error;
  }
} });
const { SECTIONS, LEFT_OUT, parseBundle } = await import('../module/src/board-bundle.ts');

const { STDB_URL: BASE, STDB_DB: DB, STDB_OWNER_TOKEN: OWNER, MCP_ORIGIN, BROWSER_ISSUER, APP_ORIGINS, STDB_TEST_ISSUER_KEY: KEY_FILE } = process.env;
if (!BASE || !DB || !OWNER || DB === 'redcrayon' || !MCP_ORIGIN || !BROWSER_ISSUER || !APP_ORIGINS || !KEY_FILE) {
  throw new Error('run through scripts/stdb-test.sh with an isolated database and test issuers');
}
const OURS = `${MCP_ORIGIN}/agent-id`, APP = APP_ORIGINS.split(',')[0];
const RUN = randomBytes(6).toString('hex');
const NONE = { none: [] };
const some = v => ({ some: v });
const SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const named = name => `${name}-${RUN}`;
const key = () => randomBytes(24).toString('hex');
const id = who => ({ __identity__: `0x${who.identity}` });
const hex = value => String(Array.isArray(value) ? value[0] : value.__identity__).replace(/^0x/, '').toLowerCase();
const hashOf = line => createHash('sha256').update(line).digest('hex').slice(0, 32);
const OFF = 'the Versions plugin is off in this workspace';

// --- issuer (as verify-workspaces-local.mjs) ------------------------------------
if (!existsSync(KEY_FILE)) writeFileSync(KEY_FILE, generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
const privateKey = createPrivateKey(readFileSync(KEY_FILE));
const JWK = { ...createPublicKey(privateKey).export({ format: 'jwk' }), kid: 'test-issuer', alg: 'ES256', use: 'sig' };
const DISCOVERY = '/.well-known/openid-configuration';
const issuerServer = createServer((req, res) => {
  const { pathname } = new URL(req.url, MCP_ORIGIN);
  const issuer = MCP_ORIGIN + pathname.slice(0, -DISCOVERY.length);
  const body = pathname.endsWith(DISCOVERY)
    ? { issuer, jwks_uri: `${issuer}/jwks.json`, id_token_signing_alg_values_supported: ['ES256'], response_types_supported: ['id_token'], subject_types_supported: ['public'] }
    : pathname.endsWith('/jwks.json') ? { keys: [JWK] } : null;
  res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' }).end(JSON.stringify(body));
});
issuerServer.listen(Number(new URL(MCP_ORIGIN).port), '127.0.0.1').unref();
await once(issuerServer, 'listening');
after(() => issuerServer.close());
const b64u = value => Buffer.from(JSON.stringify(value)).toString('base64url');
function as(issuer, subject, claims = {}) {
  const now = Math.floor(Date.now() / 1000);
  const input = `${b64u({ alg: 'ES256', typ: 'JWT', kid: JWK.kid })}.${b64u({ iat: now, exp: now + 900, iss: issuer, sub: subject, ...claims })}`;
  return {
    token: `${input}.${sign('sha256', Buffer.from(input), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`,
    identity: identityFromClaims(issuer, subject),
  };
}
const person = () => as(BROWSER_ISSUER, `user_${randomUUID()}`, { sid: `sess_${randomUUID()}`, azp: APP });
const agent = () => as(OURS, `agent:user_${randomUUID()}`, { aud: 'redcrayon-db' });
const service = as(OURS, 'service:version-tests', { aud: 'redcrayon-db' });

// --- HTTP API --------------------------------------------------------------------
const camel = value => value.replace(/_([a-z])/g, (_m, c) => c.toUpperCase());
async function call(who, reducer, args = []) {
  const response = await fetch(`${BASE}/v1/database/${DB}/call/${reducer}`, {
    method: 'POST', headers: { Authorization: `Bearer ${who.token ?? who}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args, (_key, value) => typeof value === 'bigint' ? JSON.rawJSON(value.toString()) : value),
  });
  return { status: response.status, text: await response.text() };
}
async function ok(who, reducer, args = []) {
  const response = await call(who, reducer, args);
  assert.equal(response.status, 200, `${reducer} should succeed: ${response.status} ${response.text}`);
}
async function denied(who, reducer, args, message) {
  const response = await call(who, reducer, args);
  assert.equal(response.status, 530, `${reducer} should reject: ${response.status} ${response.text}`);
  assert.ok(response.text.includes(message), `${reducer}: expected "${message}"; got ${response.text}`);
}
async function sql(who, query) {
  const response = await fetch(`${BASE}/v1/database/${DB}/sql`, {
    method: 'POST', headers: { Authorization: `Bearer ${who.token ?? who}`, 'Content-Type': 'text/plain' }, body: query,
  });
  const text = await response.text();
  assert.equal(response.status, 200, `sql ${response.status}: ${text} (${query})`);
  const [result] = JSON.parse(text, (_k, v, ctx) => (typeof v === 'number' && !Number.isSafeInteger(v) && /^-?\d+$/.test(ctx.source) ? BigInt(ctx.source) : v));
  const columns = result.schema.elements.map(column => camel(column.name?.some ?? column.name));
  return result.rows.map(row => Object.fromEntries(columns.map((column, index) => [column, row[index]])));
}
const rows = (who, view) => sql(who, `SELECT * FROM ${view}`);

// --- the plugin, as the dashboard server drives it --------------------------------
/** Save step 1: the procedure's JSON ({ error } on refusal). */
async function capture(who, boardId) {
  const r = await call(who, 'capture_board_version', [boardId]);
  assert.equal(r.status, 200, `capture_board_version: ${r.status} ${r.text}`);
  return JSON.parse(JSON.parse(r.text));
}
/** A whole save: capture, "store" (kept in `stored`), publish. Returns the version id. */
const stored = new Map();
async function save(who, boardId) {
  const c = await capture(who, boardId);
  assert.equal(c.error, undefined, c.error);
  stored.set(c.versionId, c.bundle);
  await ok(service, 'publish_board_version', [BigInt(c.versionId), c.sha256]);
  return Number(c.versionId); // as /sql returns ids
}
/** restore_board_version, a charged procedure: { boardId } or { error, refused }. */
async function restoreCall(who, args) {
  const r = await call(who, 'restore_board_version', args);
  assert.equal(r.status, 200, `restore_board_version: ${r.status} ${r.text}`);
  return JSON.parse(JSON.parse(r.text));
}
function refused(out, message) {
  assert.equal(out.refused, true, JSON.stringify(out));
  assert.ok(out.error.includes(message), `expected "${message}"; got ${out.error}`);
}
/** A whole restore through staged pieces. Returns the new board id. */
async function restore(who, versionId, { text = stored.get(String(versionId)), size = 64 * 1024, request = key(), name = '' } = {}) {
  for (let i = 0, at = 0; at < text.length || i === 0; i++, at += size) await ok(who, 'stage_board_version_chunk', [versionId, request, i, text.slice(at, at + size)]);
  const out = await restoreCall(who, [versionId, request, name]);
  assert.equal(out.error, undefined, out.error);
  assert.equal(Number(out.boardId), (await rows(who, 'my_board_creations')).find(r => r.requestKey === request).boardId);
  return Number(out.boardId);
}
const listed = async (who, boardId) => (await rows(who, 'my_board_versions')).filter(s => boardId === undefined || s.boardId === boardId);

async function workspace(who, label) {
  const name = named(label);
  await ok(who, 'create_workspace', [name]);
  return (await rows(who, 'my_workspaces')).find(row => row.name === name).id;
}
async function member(who, workspaceId, target, role = 'member') {
  await rows(target, 'my_workspaces');
  await ok(who, 'set_workspace_member', [workspaceId, id(target), role]);
}
async function board(who, workspaceId, label) {
  const name = named(label);
  await ok(who, 'create_workspace_board', [workspaceId, name, key()]);
  return (await rows(who, 'my_boards')).find(row => row.name === name).boardId;
}
const enable = (who, W, on = true) => ok(who, 'set_workspace_plugin', [W, 'versions', on]);
/** A new owner and workspace with Versions on: tests that write a lot get a write budget of their own. */
async function ownWorkspace(label) {
  const who = person();
  const W = await workspace(who, label);
  await enable(who, W);
  return { who, W };
}
const nodeArgs = (B, label, x = 0) => [B, label, '', x, 0, 160, 80, 'ink', false, NONE, NONE, NONE, NONE, NONE, NONE, NONE];
async function nodeOn(who, B, label, x) {
  await ok(who, 'create_node', nodeArgs(B, label, x));
  return (await sql(OWNER, `SELECT * FROM node WHERE board_id = ${B}`)).find(n => n.label === label).id;
}

const hideMembers = async B => (await Promise.all((await sql(OWNER, `SELECT id FROM hide_set WHERE board_id = ${B}`)).map(s => sql(OWNER, `SELECT * FROM hide_set_member WHERE set_id = ${s.id}`)))).flat();
/** How many rows each bundle section has for board B, straight from its table. */
async function contents(B) {
  const out = {};
  for (const [section, { table }] of Object.entries(SECTIONS)) {
    out[section] = section === 'hideSetMembers' ? (await hideMembers(B)).length
      : (await sql(OWNER, `SELECT * FROM ${table.replace(/([A-Z])/g, '_$1').toLowerCase()} WHERE board_id = ${B}`)).length;
  }
  return out;
}

let O, W, B, a, b, c, edge, ref;
before(async () => {
  if (!(await rows(OWNER, 'service_account')).some(row => hex(row.identity) === service.identity)) {
    await sql(OWNER, `INSERT INTO service_account (identity, label) VALUES (0x${service.identity}, 'version-tests')`);
  }
  // Board B: a session board in workspace W with a row in every bundle section.
  O = person();
  W = await workspace(O, 'snap');
  const name = named('snap-session');
  await ok(O, 'start_session', [name, `/tmp/${name}`, SHA]);
  B = (await sql(OWNER, `SELECT id FROM board WHERE name = '${name}'`))[0].id;
  await ok(O, 'move_board_to_workspace', [B, W]);
  await ok(O, 'add_repo_files', [B, ['src/a.ts', 'src/b.ts']]);
  a = await nodeOn(O, B, 'a');
  b = await nodeOn(O, B, 'b', 240);
  c = await nodeOn(O, B, 'c', 480);
  await ok(O, 'set_node_doc', [a, 'The **payment** service.']);
  // A shared workspace stores no code text (code consent): line hashes only.
  await ok(O, 'create_edge', [B, a, b, 'calls', 'source:src/a.ts:1', NONE, NONE, NONE]);
  [edge] = await sql(OWNER, `SELECT * FROM edge WHERE board_id = ${B}`);
  await ok(O, 'create_edge', [B, b, c, 'reads', 'human:test', NONE, NONE, NONE]);
  await ok(O, 'set_edge_latency', [edge.id, 12.5, 'local']);
  await ok(O, 'add_code_ref', [B, 'node', a, 'src/a.ts', 'verify', 1, 2, SHA, '', 'test']);
  [ref] = await sql(OWNER, `SELECT * FROM code_ref WHERE board_id = ${B}`);
  await ok(O, 'set_code_ref_hashes', [ref.id, `${hashOf('function verify() {')} ${hashOf('  return name;')}`]);
  await ok(O, 'set_edge_evidence_code', [edge.id, hashOf('verify();'), NONE]);
  await ok(O, 'set_session_remote', [B, 'git@github.com:example/repo.git', SHA, ['src/a.ts']]);
  await ok(O, 'add_change_note', [B, a, 'migration', 'destructive', 'Migration 0042', 'Drops name.', ref.id,
    JSON.stringify([{ label: 'drop name', startLine: 1, endLine: 2 }]), '', JSON.stringify([{ table: 'customers', column: 'name' }]), '[]', 'agent']);
  await ok(O, 'add_threat', [B, a, 'vulnerable', 'high', 'openssl RCE', 'Heap overflow.', '9.8', 'openssl@3.0.1', '3.0.7', '["cve"]', '', 'agent']);
  await ok(O, 'create_chart', [B, 'latency', '', 0, 160, 352, 224, 'timeseries', 'time,p99\n10:00,40\n10:05,44\n', NONE, NONE]);
  await ok(O, 'set_node_icon', [a, 'queue']);
  await ok(O, 'set_edge_weight', [edge.id, 'bold']);
  await ok(O, 'set_node_hidden', [c, true, some('scratch')]);
  await ok(O, 'set_edge_hidden', [edge.id, true, some('scratch')]);
  await ok(O, 'plan_route', [B, [a, b]]);
  await ok(O, 'play_trace', [B, JSON.stringify([{ id: 's1', node: String(a), startMs: 0, durationMs: 5 }]), 'local', 'checkout']);
  await ok(O, 'mark_checkpoint', [B, SHA, '{"changed":[],"onBoard":[],"excluded":[],"uncovered":[],"deleted":[]}']);
  await ok(O, 'send_marks', [B, [b], ['why does b read c?']]);
  // Authorization a restore must not copy.
  await ok(O, 'set_link_share', [B, 'edit', randomBytes(16).toString('hex')]);
  await ok(O, 'enable_board_embed', [B, randomBytes(16).toString('hex'), false, 0]);
});

test('every published table is in a bundle section or left out with a reason', () => {
  const out = execFileSync('spacetime', ['describe', '--json', '--anonymous', '--no-config', '--server', BASE, DB], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const sections = Object.fromEntries(JSON.parse(out).sections.map(s => Object.entries(s)[0]));
  const tables = sections.Tables.map(t => t.source_name);
  const covered = new Set([...Object.values(SECTIONS).map(s => s.table), ...Object.keys(LEFT_OUT)]);
  assert.deepEqual(tables.filter(t => !covered.has(t)), [], 'add each table to SECTIONS or LEFT_OUT (module/src/board-bundle.ts)');
  assert.deepEqual([...covered].filter(t => !tables.includes(t)), [], 'SECTIONS and LEFT_OUT name only published tables');
});

test('the plugin is off by default and only a workspace owner or admin turns it on', async () => {
  const admin = person(), plain = person(), bot = agent();
  await member(O, W, admin, 'admin');
  await member(O, W, plain);
  assert.equal((await capture(O, B)).error, `version rule: ${OFF}; a workspace owner or admin can turn it on`);
  await denied(plain, 'set_workspace_plugin', [W, 'versions', true], 'only a workspace owner or admin');
  await denied(bot, 'set_workspace_plugin', [W, 'versions', true], 'human account');
  await denied(O, 'set_workspace_plugin', [W, 'nope', true], "there is no plugin 'nope'");
  await enable(admin, W);
  assert.deepEqual((await rows(plain, 'my_workspace_plugins')).filter(p => p.workspaceId === W).map(p => [p.plugin, p.enabled]), [['versions', true]]);
});

test('save, list and restore a complete board into a new private board; the original stays untouched', async () => {
  const before = await contents(B);
  for (const [section, n] of Object.entries(before)) assert.ok(n > 0, `seed ${section}`);
  const original = await sql(OWNER, `SELECT * FROM node WHERE board_id = ${B}`);
  const S = await save(O, B);
  const bundle = parseBundle(stored.get(String(S)));
  assert.equal(Number(bundle.source.workspaceId), W);
  const [row] = await listed(O, B);
  assert.equal(row.id, S);
  assert.equal(hex(row.createdBy), O.identity);
  assert.ok(Number(row.createdAt.__timestamp_micros_since_unix_epoch__ ?? row.createdAt[0]) > 0);

  const R = await restore(O, S, { size: 1500 }); // many pieces
  assert.notEqual(R, B);
  assert.deepEqual(await contents(R), before, 'every section restored');
  assert.deepEqual(await sql(OWNER, `SELECT * FROM node WHERE board_id = ${B}`), original, 'original untouched');
  // Same content, new ids, all relationships remapped onto the new board.
  const nodes = await sql(OWNER, `SELECT * FROM node WHERE board_id = ${R}`);
  const byLabel = Object.fromEntries(nodes.map(n => [n.label, n]));
  assert.equal(byLabel.c.hidden, true);
  assert.equal(byLabel.a.doc, 'The **payment** service.');
  const edges = await sql(OWNER, `SELECT * FROM edge WHERE board_id = ${R}`);
  const calls = edges.find(e => e.label === 'calls');
  assert.deepEqual([calls.fromNode, calls.toNode, calls.hidden, calls.latencyMs, calls.evidenceSnippet], [byLabel.a.id, byLabel.b.id, true, 12.5, '']);
  assert.equal((await sql(OWNER, `SELECT * FROM edge_weight WHERE edge_id = ${calls.id}`))[0].weight, 'bold');
  assert.equal((await sql(OWNER, `SELECT * FROM edge_evidence_hash WHERE edge_id = ${calls.id}`))[0].lineHash, hashOf('verify();'));
  const [chart] = await sql(OWNER, `SELECT * FROM chart WHERE board_id = ${R}`);
  assert.equal(chart.nodeId, byLabel.latency.id);
  assert.equal(chart.csv, 'time,p99\n10:00,40\n10:05,44\n');
  const [newRef] = await sql(OWNER, `SELECT * FROM code_ref WHERE board_id = ${R}`);
  assert.deepEqual([newRef.targetId, newRef.snippet, newRef.symbol], [byLabel.a.id, '', 'verify']);
  const [note] = await sql(OWNER, `SELECT * FROM change_note WHERE board_id = ${R}`);
  assert.deepEqual([note.anchorId, note.refId], [byLabel.a.id, newRef.id]);
  const [mark] = await sql(OWNER, `SELECT * FROM mark WHERE board_id = ${R}`);
  assert.deepEqual([mark.nodeId, mark.note, mark.claimedBy], [byLabel.b.id, 'why does b read c?', '']);
  const [route] = await sql(OWNER, `SELECT * FROM session_route WHERE board_id = ${R}`);
  assert.deepEqual(route.nodeIds, [byLabel.a.id, byLabel.b.id]);
  const [trace] = await sql(OWNER, `SELECT * FROM trace_playback WHERE board_id = ${R}`);
  assert.equal(JSON.parse(trace.spans)[0].node, String(byLabel.a.id));
  assert.deepEqual((await hideMembers(R)).map(m => m.targetId).sort(), [byLabel.c.id, calls.id].sort());
  // Private: in W, default none, the restorer the only grant; no link, embed or agent grant came back.
  assert.deepEqual((await sql(OWNER, `SELECT * FROM board_workspace WHERE board_id = ${R}`)).map(s => [s.workspaceId, s.defaultRole]), [[W, 'none']]);
  assert.deepEqual((await sql(OWNER, `SELECT * FROM workspace_board_grant WHERE board_id = ${R}`)).map(g => [hex(g.member), g.role]), [[O.identity, 'manager']]);
  for (const table of ['link_share', 'board_embed', 'agent_grant', 'team_grant', 'workspace_team_grant', 'architecture_version', 'public_board']) {
    assert.deepEqual(await sql(OWNER, `SELECT * FROM ${table} WHERE board_id = ${R}`), [], `${table} on the restored board`);
  }
  const slug = (await sql(OWNER, `SELECT slug FROM board WHERE id = ${R}`))[0].slug;
  assert.notEqual(slug, (await sql(OWNER, `SELECT slug FROM board WHERE id = ${B}`))[0].slug);
  assert.equal((await sql(OWNER, `SELECT name FROM board WHERE id = ${R}`))[0].name, `${named('snap-session')} (restored)`);
});

test('code text stays out of a version even where the board stores it', async () => {
  const P = person();
  await ok(P, 'ensure_personal_workspace', []);
  const mine = (await rows(P, 'my_workspaces')).find(w => w.personal).id;
  await enable(P, mine);
  await ok(P, 'set_code_consent', [true]);
  const K = await board(P, mine, 'snap-code');
  await ok(P, 'add_repo_files', [K, ['src/a.ts']]);
  const x = await nodeOn(P, K, 'x'), y = await nodeOn(P, K, 'y', 240);
  await ok(P, 'create_edge', [K, x, y, 'calls', 'source:src/a.ts:1', NONE, some('verify();'), NONE]);
  await ok(P, 'add_code_ref', [K, 'node', x, 'src/a.ts', 'verify', 1, 2, SHA, 'function verify() {\n  return name;\n}', 'test']);
  assert.equal((await sql(OWNER, `SELECT snippet FROM code_ref WHERE board_id = ${K}`))[0].snippet.length > 0, true, 'the board keeps it');
  const S = await save(P, K);
  const text = stored.get(String(S));
  assert.ok(!text.includes('return name;') && !text.includes('verify();'), 'no code text in the bundle');
  const R = await restore(P, S);
  assert.deepEqual((await sql(OWNER, `SELECT snippet FROM code_ref WHERE board_id = ${R}`)).map(r => r.snippet), ['']);
  assert.deepEqual((await sql(OWNER, `SELECT evidence_snippet FROM edge WHERE board_id = ${R}`)).map(r => r.evidenceSnippet), ['']);
});

test('two restores by one person at once both finish (two tabs)', async () => {
  const S1 = await save(O, B), S2 = await save(O, B);
  const [k1, k2] = [key(), key()];
  const halves = text => [text.slice(0, text.length >> 1), text.slice(text.length >> 1)];
  const [a0, a1] = halves(stored.get(String(S1))), [b0, b1] = halves(stored.get(String(S2)));
  await ok(O, 'stage_board_version_chunk', [S1, k1, 0, a0]);
  await ok(O, 'stage_board_version_chunk', [S2, k2, 0, b0]); // piece 0 of another restore keeps the first's pieces
  await ok(O, 'stage_board_version_chunk', [S1, k1, 1, a1]);
  await ok(O, 'stage_board_version_chunk', [S2, k2, 1, b1]);
  const [r1, r2] = [await restoreCall(O, [S1, k1, '']), await restoreCall(O, [S2, k2, ''])];
  assert.equal(r1.error, undefined, r1.error);
  assert.equal(r2.error, undefined, r2.error);
  assert.notEqual(r1.boardId, r2.boardId);
});

test('a retried restore makes one board; a failed one leaves none and can be retried', async () => {
  const S = await save(O, B);
  const request = key();
  const count = async () => (await sql(OWNER, 'SELECT id FROM board')).length;
  const text = stored.get(String(S));
  await ok(O, 'stage_board_version_chunk', [S, request, 0, text]);
  const n = await count();
  refused(await restoreCall(O, [S, request, 'bad\u0001name']), 'board name');
  assert.equal(await count(), n, 'no partial board');
  const first = await restoreCall(O, [S, request, 'Second try']); // the staged bundle survived the rollback
  assert.deepEqual(await restoreCall(O, [S, request, 'Second try']), first);
  assert.equal(await count(), n + 1);
});

test('corrupt, oversized and out-of-order bundles are refused before any board exists', async () => {
  const S = await save(O, B);
  const text = stored.get(String(S));
  const boards = (await sql(OWNER, 'SELECT id FROM board')).length;
  const flipped = text.replace('"label":"a"', '"label":"z"');
  let request = key();
  await ok(O, 'stage_board_version_chunk', [S, request, 0, flipped]);
  refused(await restoreCall(O, [S, request, '']), 'does not match the stored version');
  request = key();
  await ok(O, 'stage_board_version_chunk', [S, request, 0, text.slice(0, 100)]);
  refused(await restoreCall(O, [S, request, '']), 'does not match the stored version'); // incomplete
  await denied(O, 'stage_board_version_chunk', [S, request, 5, 'x'], 'expected piece 1');
  await denied(O, 'stage_board_version_chunk', [S, key(), 0, `${text} `], 'larger than the stored version');
  assert.equal((await sql(OWNER, 'SELECT id FROM board')).length, boards);
});

test('only the storage server publishes, and an unpublished version is never listed', async () => {
  const c = await capture(O, B);
  await denied(O, 'publish_board_version', [BigInt(c.versionId), c.sha256], 'service account only');
  assert.ok(!(await listed(O, B)).some(s => s.id === BigInt(c.versionId)), 'pending stays out of the list');
  await denied(service, 'publish_board_version', [BigInt(c.versionId), 'f'.repeat(64)], 'unavailable');
  await denied(O, 'stage_board_version_chunk', [BigInt(c.versionId), key(), 0, c.bundle], 'unavailable');
  const keys = new Set((await sql(OWNER, 'SELECT object_key FROM board_version')).map(r => r.objectKey));
  assert.equal(keys.size, (await sql(OWNER, 'SELECT id FROM board_version')).length, 'every version has its own object key');
});

test('access is checked now, per action: roles, revocation and other workspaces', async () => {
  const editor = person(), viewer = person(), outsider = person();
  await member(O, W, editor);
  await member(O, W, viewer);
  await ok(O, 'set_workspace_board_member', [B, id(editor), 'editor']);
  await ok(O, 'set_workspace_board_member', [B, id(viewer), 'viewer']);
  const W2 = await workspace(outsider, 'snap-other');
  await enable(outsider, W2);
  const S = await save(editor, B);
  // A viewer lists but neither saves nor restores; an outsider sees nothing, even as an admin elsewhere.
  assert.ok((await listed(viewer, B)).some(s => s.id === S));
  assert.match((await capture(viewer, B)).error, /needs edit access/);
  await denied(viewer, 'stage_board_version_chunk', [S, key(), 0, 'x'], 'needs edit access');
  assert.deepEqual(await listed(outsider, B), []);
  assert.match((await capture(outsider, B)).error, /needs edit access/);
  await denied(outsider, 'stage_board_version_chunk', [S, key(), 0, 'x'], 'unavailable');
  // A pending save whose author loses access is never published; listed ones stop working for them at once.
  const pending = await capture(editor, B);
  await ok(O, 'set_workspace_board_member', [B, id(editor), 'viewer']);
  await denied(service, 'publish_board_version', [BigInt(pending.versionId), pending.sha256], 'lost edit access');
  await denied(editor, 'stage_board_version_chunk', [S, key(), 0, 'x'], 'needs edit access');
  await ok(O, 'set_workspace_member', [W, id(editor), '']);
  assert.deepEqual(await listed(editor, B), []);
  await denied(editor, 'stage_board_version_chunk', [S, key(), 0, 'x'], 'unavailable');
  // Agents never act on versions.
  assert.match((await capture(agent(), B)).error, /human account/);
});

test('a refused capture or restore still spends a write', { skip: (process.env.MODULE_ENV ?? 'local') === 'local' && 'the local variant has no write budget' }, async () => {
  const P = person();
  const tokens = async () => (await sql(OWNER, `SELECT tokens FROM write_budget WHERE identity = 0x${P.identity}`))[0].tokens;
  const first = await capture(P, B); // not a member: refused, and makes P's budget row
  assert.equal(first.refused, true);
  const before = await tokens();
  assert.equal((await capture(P, B)).refused, true);
  refused(await restoreCall(P, [1, key(), '']), 'unavailable');
  assert.ok(await tokens() <= before - 1.5, `two refused calls spent ${before - await tokens()} writes`);
});

test('turning the plugin off stops every action and keeps the data; on again brings it back', async () => {
  const S = await save(O, B);
  await enable(O, W, false);
  assert.deepEqual(await listed(O, B), []);
  assert.equal((await capture(O, B)).error, `version rule: ${OFF}; a workspace owner or admin can turn it on`);
  await denied(O, 'stage_board_version_chunk', [S, key(), 0, 'x'], OFF);
  assert.equal((await sql(OWNER, `SELECT * FROM board_version WHERE id = ${S}`)).length, 1, 'the index row stays');
  await enable(O, W);
  assert.ok((await listed(O, B)).some(s => s.id === S));
  assert.ok(await restore(O, S));
});

test('a deleted board keeps its versions for workspace owners and admins only', async () => {
  const editor = person();
  await member(O, W, editor);
  const D = await board(O, W, 'snap-doomed');
  await ok(O, 'set_workspace_board_member', [D, id(editor), 'editor']);
  await nodeOn(O, D, 'only');
  const S = await save(editor, D);
  await ok(O, 'delete_board', [D]);
  assert.deepEqual(await listed(editor, D), []);
  await denied(editor, 'stage_board_version_chunk', [S, key(), 0, 'x'], 'needs edit access');
  const R = await restore(O, S);
  assert.deepEqual((await sql(OWNER, `SELECT label FROM node WHERE board_id = ${R}`)).map(n => n.label), ['only']);
});

test('an architecture snapshot restores as a plain board; its history is provenance only', async () => {
  const graph = { nodes: ['x', 'y'].map(k => ({ key: k, label: k, sublabel: '', kind: 'service' })), edges: [{ from: 'x', to: 'y', label: 'uses', relation: 'import', evidence: 'import' }], files: ['src/x.ts'] };
  const request = named('snap-history');
  await ok(O, 'create_workspace_architecture_history', [W, request, 'https://github.com/example/repo', JSON.stringify([{ ref: 'main', sha: SHA }]), request]);
  const [h] = await sql(OWNER, `SELECT * FROM architecture_history WHERE request_key = '${request}'`);
  await ok(service, 'publish_architecture_snapshot', [h.id, 0, 'main', SHA, JSON.stringify(graph)]);
  const [v] = await sql(OWNER, `SELECT * FROM architecture_version WHERE history_id = ${h.id}`);
  const S = await save(O, v.boardId);
  const bundle = parseBundle(stored.get(String(S)));
  assert.deepEqual([bundle.architecture.assertionMode, Number(bundle.architecture.historyId), bundle.architecture.repository], ['fact', h.id, 'https://github.com/example/repo']);
  const R = await restore(O, S);
  assert.deepEqual(await sql(OWNER, `SELECT * FROM architecture_version WHERE board_id = ${R}`), []);
  assert.deepEqual((await sql(OWNER, `SELECT source_key FROM node WHERE board_id = ${R}`)).map(n => n.sourceKey).sort(), ['x', 'y']);
  await ok(O, 'create_node', nodeArgs(R, 'editable')); // a fact version refuses edits; its restored copy does not
});

test('capture is one consistent state while others write', async () => {
  const { who: O, W } = await ownWorkspace('snap-busy');
  const C = await board(O, W, 'snap-busy');
  let writing = true;
  // Writer: each step adds a chart (node and chart row in one write), links it to the last one and
  // deletes the one before (its edges go in the same write).
  const writer = (async () => {
    const ids = [];
    for (let i = 0; i < 30; i++) {
      await ok(O, 'create_chart', [C, `chart ${i}`, '', (i % 8) * 240, Math.floor(i / 8) * 160, 224, 144, 'stat', 'value\n1\n', NONE, NONE]);
      ids.push((await sql(OWNER, `SELECT id FROM node WHERE board_id = ${C} AND label = 'chart ${i}'`))[0].id);
      if (i > 0) await ok(O, 'create_edge', [C, ids[i - 1], ids[i], 'next', 'human:test', NONE, NONE, NONE]);
      if (i > 1) await ok(O, 'delete_node', [ids[i - 2]]);
    }
    writing = false;
  })();
  let captures = 0;
  while (writing) {
    const r = await capture(O, C);
    assert.equal(r.error, undefined, r.error);
    const board = parseBundle(r.bundle); // refuses an edge, hide set or chart naming a row of another state
    const charted = new Set(board.charts.map(row => row.nodeId));
    assert.deepEqual(board.nodes.filter(n => n.kind === 'chart' && !charted.has(n.id)).map(n => n.label), [], 'a chart node without its chart row');
    captures++;
  }
  await writer;
  assert.ok(captures > 3, `${captures} captures ran during the writes`);
});

test('a board bigger than one call restores through pieces', async () => {
  const { who: O, W } = await ownWorkspace('snap-large');
  const L = await board(O, W, 'snap-large');
  const paths = Array.from({ length: 40_000 }, (_, i) => `packages/feature-${i % 97}/src/components/deeply/nested/module-${i}.ts`);
  for (let i = 0; i < paths.length; i += 5000) await ok(O, 'add_repo_files', [L, paths.slice(i, i + 5000)]);
  await nodeOn(O, L, 'root');
  const t0 = Date.now();
  const S = await save(O, L);
  const ms = Date.now() - t0;
  const bytes = Buffer.byteLength(stored.get(String(S)));
  assert.ok(bytes > 2 * 1024 * 1024, `bundle is ${bytes} bytes`);
  // A second large save right away waits about a second per MiB; a restore is counted apart.
  const again = await capture(O, L);
  assert.equal(again.refused, true);
  assert.match(again.error, /a large version was just saved; try again in [1-9]\d* s/);
  const R = await restore(O, S, { size: 600_000 });
  assert.equal((await sql(OWNER, `SELECT id FROM repo_file WHERE board_id = ${R}`)).length, paths.length);
  console.log(`large board: ${(bytes / 1048576).toFixed(1)} MiB bundle, save ${ms} ms`);
});
