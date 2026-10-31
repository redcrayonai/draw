// Real database workspace boundaries. Run alone after verify-issuers-local.mjs:
// both suites serve the saved ES256 issuer on STDB_TEST_ISSUER_PORT.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, randomUUID, randomBytes } from 'node:crypto';
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
const { DbConnection } = await import('../client/src/module_bindings/index.ts');

const { STDB_URL: BASE, STDB_DB: DB, STDB_OWNER_TOKEN: OWNER, MCP_ORIGIN, BROWSER_ISSUER, APP_ORIGINS, STDB_TEST_ISSUER_KEY: KEY_FILE } = process.env;
if (!BASE || !DB || !OWNER || DB === 'redcrayon' || !MCP_ORIGIN || !BROWSER_ISSUER || !APP_ORIGINS || !KEY_FILE) {
  throw new Error('run through scripts/stdb-test.sh with an isolated database and test issuers');
}
const OURS = `${MCP_ORIGIN}/agent-id`, APP = APP_ORIGINS.split(',')[0];
const RUN = randomBytes(6).toString('hex');
const NONE = { none: [] };
const named = name => `${name}-${RUN}`;
const token = () => randomBytes(16).toString('hex');
const id = who => ({ __identity__: `0x${who.identity}` });
const hex = value => String(Array.isArray(value) ? value[0] : value.__identity__).replace(/^0x/, '').toLowerCase();
const micros = value => Number(Array.isArray(value) ? value[0] : value.__timestamp_micros_since_unix_epoch__);

// Keep the issuer key stable: SpacetimeDB caches its JWKS between suites.
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
const guest = () => as(OURS, `guest:${randomUUID()}`, { aud: 'redcrayon-db' });
const service = as(OURS, 'service:workspace-tests', { aud: 'redcrayon-db' });
const camel = value => value.replace(/_([a-z])/g, (_m, c) => c.toUpperCase());

async function call(who, reducer, args = []) {
  const response = await fetch(`${BASE}/v1/database/${DB}/call/${reducer}`, {
    method: 'POST', headers: { Authorization: `Bearer ${who.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args, (_key, value) => typeof value === 'bigint' ? JSON.rawJSON(value.toString()) : value),
  });
  return { status: response.status, text: await response.text() };
}
async function ok(who, reducer, args = []) {
  const response = await call(who, reducer, args);
  assert.equal(response.status, 200, `${reducer} should succeed: ${response.status} ${response.text}`);
}
async function denied(who, reducer, args = [], message) {
  const response = await call(who, reducer, args);
  assert.equal(response.status, 530, `${reducer} should reject: ${response.status} ${response.text}`);
  if (message) assert.ok(response.text.includes(message), `${reducer}: expected ${message}; got ${response.text}`);
}
async function sql(who, query) {
  const response = await fetch(`${BASE}/v1/database/${DB}/sql`, {
    method: 'POST', headers: { Authorization: `Bearer ${typeof who === 'string' ? who : who.token}`, 'Content-Type': 'text/plain' }, body: query,
  });
  const text = await response.text();
  assert.equal(response.status, 200, `sql ${response.status}: ${text} (${query})`);
  const [result] = JSON.parse(text);
  const columns = result.schema.elements.map(column => camel(column.name?.some ?? column.name));
  return result.rows.map(row => Object.fromEntries(columns.map((column, index) => [column, row[index]])));
}
const rows = (who, view) => sql(who, `SELECT * FROM ${view}`);
const boardRows = (who, view, boardId) => sql(who, `SELECT * FROM ${view} WHERE ${view === 'visible_board' ? 'id' : 'board_id'} = ${boardId}`);
const permission = async (who, boardId) => (await boardRows(who, 'my_board_permissions', boardId))[0];
const sees = async (who, boardId) => (await boardRows(who, 'visible_board', boardId)).length > 0;
const nodeArgs = (boardId, label) => [boardId, label, '', 0, 0, 160, 80, 'ink', false, ...Array(7).fill(NONE)];
const node = (who, boardId, label = 'node') => ok(who, 'create_node', nodeArgs(boardId, label));
async function workspace(who, label) {
  const name = named(label);
  await ok(who, 'create_workspace', [name]);
  return (await rows(who, 'my_workspaces')).find(row => row.name === name).id;
}
async function member(who, workspaceId, target, role = 'member') {
  // Direct membership edits identify a person who has already signed in; newcomers use invitations.
  await rows(target, 'my_workspaces');
  await ok(who, 'set_workspace_member', [workspaceId, id(target), role]);
}
async function board(who, workspaceId, label) {
  const name = named(label);
  await ok(who, 'create_workspace_board', [workspaceId, name, token()]);
  return (await rows(who, 'my_boards')).find(row => row.name === name).boardId;
}
async function invite(who, workspaceId, boardId = 0, role = 'member') {
  const code = token();
  await ok(who, 'create_workspace_invite', [workspaceId, boardId, role, code]);
  return code;
}
before(async () => {
  if (!(await rows(OWNER, 'service_account')).some(row => hex(row.identity) === service.identity)) {
    await sql(OWNER, `INSERT INTO service_account (identity, label) VALUES (0x${service.identity}, 'workspace-tests')`);
  }
});


const machine = keyId => as(OURS, `machine:${keyId}`, { aud: 'redcrayon-db' });
const some = value => ({ some: [value] });
const grant = (role = 'editor', allBoards = true, boardIds = []) => [role, allBoards, boardIds];
async function account(who, workspaceId, scope = grant(), label = 'automation') {
  const name = named(label);
  await ok(who, 'create_workspace_service_account', [workspaceId, name, ...scope]);
  return (await rows(who, 'my_workspace_service_accounts')).find(row => row.name === name);
}
async function key(who, serviceAccountId, scope = grant(), expiresAt = NONE) {
  const keyId = token(), hash = randomBytes(32).toString('hex');
  await ok(who, 'create_workspace_api_key', [serviceAccountId, keyId, hash, named('key'), ...scope, expiresAt]);
  return { keyId, hash, who: machine(keyId) };
}

test('only workspace owners and admins manage machine accounts and hashes remain private', async () => {
  const owner = person(), full = person(), other = person();
  const W = await workspace(owner, 'service-owner');
  await member(owner, W, full);
  await denied(full, 'create_workspace_service_account', [W, named('forbidden'), ...grant()], 'administrator');
  const a = await account(owner, W);
  const k = await key(owner, a.id);
  assert.equal((await rows(owner, 'my_workspace_api_keys')).find(row => row.id === k.keyId)?.keyHash, undefined);
  assert.deepEqual(await rows(full, 'my_workspace_service_accounts'), []);
  assert.deepEqual(await rows(full, 'my_workspace_api_keys'), []);
  assert.deepEqual(await rows(other, 'service_workspace_api_keys'), []);
  const privateKey = (await rows(service, 'service_workspace_api_keys')).find(row => row.keyId === k.keyId);
  assert.equal(privateKey.keyHash, k.hash);
  await denied(full, 'revoke_workspace_api_key', [k.keyId], 'administrator');
  await ok(owner, 'ensure_personal_workspace');
  const personal = (await rows(owner, 'my_workspaces')).find(row => row.personal);
  await denied(owner, 'create_workspace_service_account', [personal.id, named('personal'), ...grant()], 'shared workspace');
});

test('per-key board and role permissions are intersected with current account permissions', async () => {
  const owner = person(), W = await workspace(owner, 'service-scopes');
  const B = await board(owner, W, 'scoped'), B2 = await board(owner, W, 'second');
  const elsewhere = await workspace(owner, 'other-workspace'), outside = await board(owner, elsewhere, 'outside');
  const a = await account(owner, W);
  const inheritedAccount = await account(owner, W, grant('editor', false, [B]), 'inherited-scope');
  const inherited = await key(owner, inheritedAccount.id);
  assert.equal(await sees(inherited.who, B), true);
  assert.equal(await sees(inherited.who, B2), false, 'all account boards cannot exceed a selected account');
  await ok(owner, 'update_workspace_service_account', [inheritedAccount.id, inheritedAccount.name, ...grant('editor', false, [B2]), false]);
  assert.equal(await sees(inherited.who, B), false);
  assert.equal(await sees(inherited.who, B2), true, 'inherited key follows the current account selection');
  const read = await key(owner, a.id, grant('viewer', false, [B]));
  const edit = await key(owner, a.id, grant('editor', false, [B2]));
  assert.equal(await sees(read.who, B), true);
  assert.equal(await sees(read.who, B2), false);
  assert.equal(await sees(edit.who, B), false);
  await denied(read.who, 'create_node', nodeArgs(B, 'no write'));
  await node(edit.who, B2, 'machine edit');
  await denied(owner, 'create_workspace_api_key', [a.id, token(), randomBytes(32).toString('hex'), 'outside', ...grant('editor', false, [outside]), NONE], 'same workspace');
  await ok(owner, 'update_workspace_service_account', [a.id, a.name, ...grant('viewer', false, [B2]), false]);
  assert.equal(await sees(read.who, B), false);
  assert.equal(await sees(edit.who, B2), true);
  await denied(edit.who, 'create_node', nodeArgs(B2, 'downgraded'));
  await denied(owner, 'create_workspace_api_key', [a.id, token(), randomBytes(32).toString('hex'), 'wide', ...grant(), NONE], 'exceed');
  await ok(owner, 'move_board_to_workspace', [B2, elsewhere]);
  assert.equal(await sees(edit.who, B2), false);
});

test('machines cannot create boards, administer workspaces or obtain access through human pairing', async () => {
  const owner = person(), W = await workspace(owner, 'machine-human-boundary');
  const B = await board(owner, W, 'machine-board');
  const a = await account(owner, W), k = await key(owner, a.id);
  await node(k.who, B);
  await denied(k.who, 'create_board', ['forbidden']);
  await denied(k.who, 'create_requested_board', ['forbidden', '', token()]);
  await denied(k.who, 'create_workspace', ['forbidden'], 'human');
  await denied(k.who, 'create_workspace_board', [W, 'forbidden', token()], 'human');
  await denied(k.who, 'set_workspace_board_access', [B, 'editor']);
  await denied(k.who, 'set_workspace_member', [W, id(k.who), 'admin']);
  await denied(k.who, 'offer_agent_link', [token()]);
  await denied(k.who, 'offer_guest_claim', [B, token()]);
  await denied(k.who, 'claim_guest_board', [B, token()]);
  const pairCode = token(), pairingAgent = agent();
  await ok(pairingAgent, 'offer_agent_link', [pairCode]);
  await denied(k.who, 'redeem_agent_link', [pairCode]);
  await denied(service, 'link_hosted_agent', [id(k.who), id(owner)]);
  await denied(service, 'link_hosted_agent', [id(pairingAgent), id(k.who)]);
  await denied(k.who, 'create_architecture_proposal', [B, named('forbidden-proposal'), token()]);
  const branchName = named('review-boundary');
  await ok(owner, 'create_architecture_proposal', [B, branchName, token()]);
  const branch = (await rows(owner, 'my_boards')).find(row => row.name === branchName).boardId;
  await denied(k.who, 'review_architecture_proposal', [branch, 'accept']);
  await denied(k.who, 'merge_architecture_proposal', [branch], 'human owner');
  await denied(owner, 'set_workspace_member', [W, id(k.who), 'member']);
  assert.deepEqual(await rows(k.who, 'my_workspace_service_accounts'), []);
  assert.deepEqual(await rows(k.who, 'service_workspace_api_keys'), []);
});

test('revocation and account disable reject stale machine JWTs without employee ownership', async () => {
  const owner = person(), admin = person(), W = await workspace(owner, 'machine-lifecycle');
  await member(owner, W, admin, 'admin');
  const B = await board(owner, W, 'lifecycle'), a = await account(admin, W);
  const old = await key(admin, a.id), replacement = await key(admin, a.id);
  await ok(service, 'deactivate_workspace_identity', [id(admin)]);
  assert.deepEqual(await rows(admin, 'my_workspace_service_accounts'), []);
  assert.deepEqual(await rows(admin, 'my_workspace_api_keys'), []);
  await node(old.who, B, 'survives employee');
  await ok(owner, 'revoke_workspace_api_key', [old.keyId]);
  await denied(owner, 'create_workspace_api_key', [a.id, old.keyId, randomBytes(32).toString('hex'), 'reused', ...grant(), NONE], 'already in use');
  assert.equal(await sees(old.who, B), false);
  await denied(old.who, 'create_node', nodeArgs(B, 'revoked'));
  await node(replacement.who, B, 'replacement works');
  await ok(owner, 'update_workspace_service_account', [a.id, a.name, ...grant(), true]);
  assert.equal(await sees(replacement.who, B), false);
  await denied(replacement.who, 'create_node', nodeArgs(B, 'disabled'));
  assert.equal((await rows(service, 'service_workspace_api_keys')).some(row => row.serviceAccountId === a.id), false);
});

test('public boards and share links never expand machine scope, including revoked identities', async () => {
  const owner = person(), W = await workspace(owner, 'machine-share');
  const B = await board(owner, W, 'allowed'), outside = await board(owner, W, 'not-allowed');
  const a = await account(owner, W), k = await key(owner, a.id, grant('editor', false, [B]));
  await sql(OWNER, `INSERT INTO public_board (board_id) VALUES (${outside})`);
  const share = token();
  await ok(owner, 'set_link_share', [outside, 'edit', share]);
  await denied(k.who, 'open_shared_link', [share]);
  assert.equal(await sees(k.who, outside), false);
  await denied(k.who, 'create_node', nodeArgs(outside, 'public escape'));
  await ok(owner, 'revoke_workspace_api_key', [k.keyId]);
  await sql(OWNER, `INSERT INTO public_board (board_id) VALUES (${B})`);
  assert.equal(await sees(k.who, B), false);
  await denied(k.who, 'create_node', nodeArgs(B, 'revoked public escape'));
});
function connect(who, queries) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('workspace subscription timed out')), 10000);
    DbConnection.builder().withUri(BASE).withDatabaseName(DB).withToken(who.token)
      .onConnect(connection => connection.subscriptionBuilder().onApplied(() => { clearTimeout(timeout); resolve(connection); })
        .onError((_ctx, error) => { clearTimeout(timeout); connection.disconnect(); reject(error); }).subscribe(queries))
      .onConnectError((_ctx, error) => { clearTimeout(timeout); reject(error); })
      .onDisconnect((_ctx, error) => { clearTimeout(timeout); if (error) reject(error); })
      .build();
  });
}
async function waitFor(predicate, message) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}


for (const reason of ['revoke', 'disable', 'narrow', 'expiry']) {
  test(`${reason} removes a machine's content from an already-open subscription`, async () => {
    const owner = person(), W = await workspace(owner, `live-machine-${reason}`);
    const B = await board(owner, W, 'live-content'), second = await board(owner, W, 'remaining');
    await node(owner, B, 'private machine data');
    const a = await account(owner, W);
    const expires = reason === 'expiry' ? some(BigInt(Date.now() + 1500) * 1000n) : NONE;
    const k = await key(owner, a.id, grant(), expires);
    const tab = await connect(k.who, ['SELECT * FROM visible_board', 'SELECT * FROM visible_node', 'SELECT * FROM my_boards']);
    try {
      assert.ok([...tab.db.visibleBoard.iter()].some(row => row.id === BigInt(B)));
      if (reason === 'revoke') await ok(owner, 'revoke_workspace_api_key', [k.keyId]);
      if (reason === 'disable') await ok(owner, 'update_workspace_service_account', [a.id, a.name, ...grant(), true]);
      if (reason === 'narrow') await ok(owner, 'update_workspace_service_account', [a.id, a.name, ...grant('editor', false, [second]), false]);
      await waitFor(() => ![...tab.db.visibleBoard.iter()].some(row => row.id === BigInt(B)) && ![...tab.db.visibleNode.iter()].some(row => row.boardId === BigInt(B)) && ![...tab.db.myBoards.iter()].some(row => row.boardId === BigInt(B)), `${reason} removes live private content`);
      assert.equal(await sees(k.who, B), false, 'stale JWT cannot read on reconnect');
      await denied(k.who, 'create_node', nodeArgs(B, `stale ${reason}`));
      assert.equal((await sql(OWNER, `SELECT * FROM workspace_machine_identity WHERE identity = 0x${k.who.identity}`))[0].keyId, k.keyId, 'revocation never removes classification');
      if (reason === 'expiry') {
        const row = (await sql(OWNER, `SELECT * FROM workspace_api_key WHERE id = '${k.keyId}'`))[0];
        assert.equal(row.revoked, true, 'scheduler materializes expiry for subscriptions');
      }
    } finally { tab.disconnect(); }
  });
}

test('unknown machine keys remain classified and cannot borrow public or share access', async () => {
  const owner = person(), W = await workspace(owner, 'unknown-key-machine'), B = await board(owner, W, 'public-target');
  await sql(OWNER, `INSERT INTO public_board (board_id) VALUES (${B})`);
  const k = token(), unknown = machine(k), share = token();
  await ok(owner, 'set_link_share', [B, 'edit', share]);
  assert.equal(await sees(unknown, B), false);
  await denied(unknown, 'open_shared_link', [share]);
  await denied(unknown, 'create_node', nodeArgs(B, 'unknown machine'));
  const classification = await sql(OWNER, `SELECT * FROM workspace_machine_identity WHERE identity = 0x${unknown.identity}`);
  assert.equal(classification[0]?.keyId, k);
});

test('active, revoked and unknown machine keys cannot use embed capabilities or retained visits', async () => {
  const owner = person(), W = await workspace(owner, 'machine-embeds');
  const allowed = await board(owner, W, 'allowed-embed-machine');
  await ok(owner, 'create_board', [named('outside-embed-machine')]);
  const outside = (await rows(owner, 'my_boards')).find(row => row.name === named('outside-embed-machine')).boardId;
  await ok(owner, 'create_chart', [outside, 'published chart', '', 0, 0, 352, 224, 'timeseries', 'time,p99\n10:00,40\n10:05,44\n', NONE, NONE]);
  const chartId = (await sql(OWNER, `SELECT * FROM chart WHERE board_id = ${outside}`))[0].nodeId;
  const chartToken = token(), boardToken = token();
  await ok(owner, 'enable_chart_embed', [chartId, chartToken]);
  await ok(owner, 'enable_board_embed', [outside, boardToken, false, 0]);
  const a = await account(owner, W), active = await key(owner, a.id, grant('editor', false, [allowed]));
  const revoked = await key(owner, a.id);
  await ok(owner, 'revoke_workspace_api_key', [revoked.keyId]);
  for (const who of [active.who, revoked.who, machine(token())]) {
    await denied(who, 'open_chart_embed', [chartToken]);
    await denied(who, 'open_board_embed', [boardToken]);
    // Model visits left by an older deployment, independently of the open reducer's guard.
    const visitor = guest(), tab = await connect(visitor, ['SELECT * FROM embedded_chart', 'SELECT * FROM embedded_board']);
    try {
      await tab.reducers.openChartEmbed({ token: chartToken });
      await tab.reducers.openBoardEmbed({ token: boardToken });
      await sql(OWNER, `UPDATE chart_embed_visit SET viewer = 0x${who.identity} WHERE viewer = 0x${visitor.identity}`);
      await sql(OWNER, `UPDATE board_embed_visit SET viewer = 0x${who.identity} WHERE viewer = 0x${visitor.identity}`);
      assert.deepEqual(await rows(who, 'embedded_chart'), [], 'machine policy dominates a retained chart capability');
      assert.deepEqual(await rows(who, 'embedded_board'), [], 'machine policy dominates a retained board capability');
      assert.deepEqual(await rows(who, 'my_chart_embeds'), []);
      assert.deepEqual(await rows(who, 'my_board_embeds'), []);
    } finally { tab.disconnect(); }
  }
});

test('machine keys cannot delete histories and deleted boards leave harmless retained scope references', async () => {
  const owner = person(), W = await workspace(owner, 'machine-deletion'), B = await board(owner, W, 'deleted-machine-board');
  const a = await account(owner, W, grant('editor', false, [B]));
  const k = await key(owner, a.id, grant('editor', false, [B]));
  const request = token(), sha = 'e'.repeat(40);
  await ok(owner, 'create_workspace_architecture_history', [W, named('machine-history'), 'https://github.com/acme/machine-history', JSON.stringify([{ ref: 'main', sha }]), request]);
  const H = (await rows(owner, 'my_architecture_histories')).find(row => row.requestKey === request).id;
  await denied(k.who, 'delete_architecture_history', [H]);
  assert.equal((await sql(OWNER, `SELECT * FROM architecture_history WHERE id = ${H}`)).length, 1);
  await ok(owner, 'delete_board', [B]);
  assert.equal(await sees(k.who, B), false);
  await denied(k.who, 'create_node', nodeArgs(B, 'deleted board'));
  assert.deepEqual((await rows(owner, 'my_workspace_service_accounts')).find(row => row.id === a.id).boardIds, [B]);
  assert.deepEqual((await rows(owner, 'my_workspace_api_keys')).find(row => row.id === k.keyId).boardIds, [B]);
});

test('machine subject text without the trusted issuer and audience cannot classify a key', async () => {
  const owner = person(), W = await workspace(owner, 'machine-jwt-boundary'), B = await board(owner, W, 'machine-private');
  const a = await account(owner, W), k = await key(owner, a.id);
  for (const forged of [as(BROWSER_ISSUER, `machine:${k.keyId}`, { sid: 'fake-browser-session', azp: APP }), as(OURS, `machine:${k.keyId}`, { aud: 'wrong-audience' })]) {
    const response = await fetch(`${BASE}/v1/database/${DB}/sql`, { method: 'POST', headers: { Authorization: `Bearer ${forged.token}`, 'Content-Type': 'text/plain' }, body: `SELECT * FROM visible_board WHERE id = ${B}` });
    const body = await response.text();
    assert.ok([200, 401, 403].includes(response.status), `untrusted machine request: ${response.status} ${body}`);
    if (response.status === 200) assert.equal(JSON.parse(body)[0].rows.length, 0, 'untrusted claims cannot read machine content');
    assert.deepEqual(await sql(OWNER, `SELECT * FROM workspace_machine_identity WHERE identity = 0x${forged.identity}`), []);
  }
});

test('an administrator can disable an account after its selected board moves away', async () => {
  const owner = person(), W = await workspace(owner, 'disable-stale-selection'), other = await workspace(owner, 'stale-selection-destination');
  const B = await board(owner, W, 'moving-selection');
  const a = await account(owner, W, grant('editor', false, [B]));
  const k = await key(owner, a.id);
  await ok(owner, 'move_board_to_workspace', [B, other]);
  assert.equal(await sees(k.who, B), false);
  await ok(owner, 'update_workspace_service_account', [a.id, a.name, ...grant('editor', false, [B]), true]);
  assert.equal((await rows(owner, 'my_workspace_service_accounts')).find(row => row.id === a.id).disabled, true);
  await denied(owner, 'update_workspace_service_account', [a.id, a.name, ...grant('editor', false, [B]), false], 'same workspace');
});
