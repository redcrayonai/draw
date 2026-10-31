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

test('only signed-in humans can administer workspaces or accept an invitation', async () => {
  const owner = person(), recipient = person(), g = guest(), a = agent();
  const W = await workspace(owner, 'human-account');
  const code = await invite(owner, W);
  for (const who of [g, a]) {
    await denied(who, 'create_workspace', [named('unauthorized')], 'human account');
    await denied(who, 'ensure_personal_workspace', [], 'human account');
    await denied(who, 'accept_workspace_invite', [code], 'human account');
    assert.deepEqual(await rows(who, 'my_workspaces'), []);
  }
  await ok(recipient, 'accept_workspace_invite', [code]);
  assert.equal((await rows(recipient, 'my_workspaces')).find(row => row.id === W)?.role, 'member');
  if (['staging', 'production'].includes(process.env.MODULE_ENV)) {
    const [budget] = await sql(OWNER, `SELECT * FROM write_budget WHERE identity = 0x${recipient.identity}`);
    assert.equal(budget?.tokens, 299, 'accepting an invitation spends one of the account\'s 300 writes');
  }
});

test('a self-reported human participant does not turn a legacy agent token into an account', async () => {
  const response = await fetch(`${BASE}/v1/identity`, { method: 'POST' });
  assert.equal(response.status, 200);
  const legacy = await response.json();
  // The local variant accepts old DB-minted identities; enforced variants reject them at connection.
  const joined = await call(legacy, 'join_board', ['self-reported human', 'human']);
  assert.ok([200, 401].includes(joined.status), `legacy connection: ${joined.status} ${joined.text}`);
  const created = await call(legacy, 'create_workspace', [named('forged-human')]);
  assert.ok([401, 530].includes(created.status), `legacy token must not create a workspace: ${created.status} ${created.text}`);
  if (created.status === 530) assert.ok(created.text.includes('human account'));
});

test('personal workspace onboarding preserves old board ownership and keeps a single full member', async () => {
  const owner = person(), guestMember = person();
  await ok(owner, 'create_board', [named('before-personal-workspace')]);
  const B = (await rows(owner, 'my_boards')).find(row => row.name === named('before-personal-workspace')).boardId;
  await ok(owner, 'ensure_personal_workspace');
  await ok(owner, 'ensure_personal_workspace');
  const personal = (await rows(owner, 'my_workspaces')).filter(row => row.personal);
  assert.equal(personal.length, 1, 'personal onboarding is idempotent');
  assert.equal(personal[0].role, 'owner');
  assert.equal((await permission(owner, B)).workspaceId, personal[0].id);
  assert.equal((await permission(owner, B)).role, 'manager');
  await rows(guestMember, 'my_workspaces');
  await denied(owner, 'set_workspace_member', [personal[0].id, id(guestMember), 'member'], 'single owner');
  await denied(owner, 'set_workspace_member', [personal[0].id, id(owner), ''], 'single owner');
  const code = await invite(owner, personal[0].id, B, 'viewer');
  await ok(guestMember, 'accept_workspace_invite', [code]);
  assert.equal((await permission(guestMember, B)).role, 'viewer');
  await node(owner, B, 'personal owner still edits');
});

test('a personal-board guest manager can share and edit without transferring ownership', async () => {
  const owner = person(), manager = person();
  await ok(owner, 'ensure_personal_workspace');
  const personal = (await rows(owner, 'my_workspaces')).find(row => row.personal).id;
  const B = await board(owner, personal, 'personal-manager');
  const code = await invite(owner, personal, B, 'manager');
  await ok(manager, 'accept_workspace_invite', [code]);
  assert.equal((await permission(manager, B)).role, 'manager');
  await node(manager, B, 'guest manager edit');
  await ok(manager, 'set_link_share', [B, 'view', token()]);
  const target = await workspace(manager, 'manager-owned-workspace');
  await denied(manager, 'move_board_to_workspace', [B, target], 'workspace administrator');
  assert.equal((await permission(owner, B)).workspaceId, personal, 'the personal workspace retains ownership');
  assert.equal((await permission(manager, B)).workspaceId, personal);
  await ok(owner, 'stop_link_share', [B]);
});

test('native personal boards reject guest claims even when an old unscoped offer survives onboarding', async () => {
  const owner = person(), manager = person(), outsider = person();
  await ok(owner, 'ensure_guest_board', [NONE]);
  const B = (await rows(owner, 'my_guest_board'))[0].boardId;
  const oldClaim = token();
  await ok(owner, 'offer_guest_claim', [B, oldClaim]);
  await ok(owner, 'ensure_personal_workspace');
  const personal = (await rows(owner, 'my_workspaces')).find(row => row.personal).id;
  const code = await invite(owner, personal, B, 'manager');
  await ok(manager, 'accept_workspace_invite', [code]);
  await denied(manager, 'offer_guest_claim', [B, token()]);
  await denied(outsider, 'claim_guest_board', [B, oldClaim]);
  const before = await sql(OWNER, `SELECT * FROM board_grant WHERE board_id = ${B}`);
  await ok(manager, 'claim_guest_board', [B, oldClaim]);
  assert.deepEqual(await sql(OWNER, `SELECT * FROM board_grant WHERE board_id = ${B}`), before, 'an existing manager retry remains a no-op');
  assert.equal(await sees(outsider, B), false, 'an old claim cannot create access outside native membership');
  assert.equal((await permission(owner, B)).workspaceId, personal);
  assert.equal((await permission(owner, B)).role, 'manager');
  assert.equal((await rows(manager, 'my_workspaces')).find(row => row.id === personal)?.role, 'guest');
  const owners = await sql(OWNER, `SELECT * FROM board_grant WHERE board_id = ${B}`);
  assert.deepEqual(owners.filter(row => row.role === 'owner').map(row => hex(row.grantee)), [owner.identity], 'claim reducers cannot add a legacy owner to a native board');
});

test('explicit ownership moves clear legacy organization sharing before a board returns to a personal workspace', async () => {
  const owner = person(), teammate = person();
  const org = named('old-personal-share');
  await ok(service, 'set_org_memberships', [id(owner), [org], ['org:admin']]);
  await ok(service, 'set_org_memberships', [id(teammate), [org], ['org:member']]);
  await ok(owner, 'create_team_board', [named('legacy-personal-share'), org]);
  const B = (await rows(owner, 'my_boards')).find(row => row.name === named('legacy-personal-share')).boardId;
  await ok(owner, 'ensure_personal_workspace');
  const personal = (await rows(owner, 'my_workspaces')).find(row => row.personal).id;
  assert.equal(await sees(teammate, B), true, 'automatic personal onboarding preserves existing sharing');
  const company = await workspace(owner, 'ownership-move-company');
  await ok(owner, 'move_board_to_workspace', [B, company]);
  assert.equal(await sees(teammate, B), false);
  await ok(owner, 'move_board_to_workspace', [B, personal]);
  assert.equal((await permission(owner, B)).workspaceId, personal);
  assert.equal(await sees(teammate, B), false, 'returning to personal ownership cannot revive old organization grants');
  assert.deepEqual(await sql(OWNER, `SELECT * FROM team_grant WHERE board_id = ${B}`), [], 'explicit transfers remove the legacy sharing records');
});

test('native personal and company board managers read the saved link layer choices', async () => {
  const owner = person(), manager = person(), viewer = person();
  await ok(owner, 'ensure_personal_workspace');
  const personal = (await rows(owner, 'my_workspaces')).find(row => row.personal).id;
  const personalBoard = await board(owner, personal, 'personal-link-layers');
  const code = await invite(owner, personal, personalBoard, 'manager');
  await ok(manager, 'accept_workspace_invite', [code]);
  const company = await workspace(owner, 'company-link-layers');
  await member(owner, company, manager);
  await member(owner, company, viewer);
  const companyBoard = await board(owner, company, 'company-link-layers');
  await ok(owner, 'set_workspace_board_member', [companyBoard, id(manager), 'manager']);
  await ok(owner, 'set_workspace_board_member', [companyBoard, id(viewer), 'viewer']);
  for (const B of [personalBoard, companyBoard]) {
    const share = token();
    await ok(manager, 'set_link_share', [B, 'view', share]);
    await ok(manager, 'set_link_share_includes', [B, true, false]);
    assert.deepEqual(await boardRows(manager, 'my_link_includes', B), [{ boardId: B, threats: true, code: false }]);
    await ok(manager, 'set_link_share', [B, 'edit', share]);
    assert.deepEqual(await boardRows(manager, 'my_link_includes', B), [{ boardId: B, threats: true, code: false }], 'edit-link code visibility does not overwrite the saved code checkbox');
    await ok(manager, 'set_link_share_includes', [B, false, true]);
    assert.deepEqual(await boardRows(manager, 'my_link_includes', B), [{ boardId: B, threats: false, code: true }]);
    await ok(owner, 'stop_link_share', [B]);
    assert.deepEqual(await boardRows(manager, 'my_link_includes', B), []);
  }
  assert.deepEqual(await rows(viewer, 'my_link_includes'), [], 'viewing a board does not reveal its share-management rows');
});

test('private boards distinguish workspace membership, view, edit and management', async () => {
  const owner = person(), admin = person(), creator = person(), reader = person(), stranger = person();
  const W = await workspace(owner, 'private-roles');
  await member(owner, W, admin, 'admin');
  await member(owner, W, creator);
  await member(owner, W, reader);
  const B = await board(creator, W, 'private');
  for (const who of [owner, admin, creator]) {
    const p = await permission(who, B);
    assert.deepEqual([p.workspaceId, p.role, p.canEdit, p.canManage, p.defaultRole], [W, 'manager', true, true, 'none']);
  }
  for (const who of [reader, stranger]) {
    assert.equal(await sees(who, B), false, 'membership alone does not expose a private board');
    assert.equal(await permission(who, B), undefined);
    await denied(who, 'create_node', nodeArgs(B, 'hidden'));
  }
  await ok(creator, 'set_workspace_board_member', [B, id(reader), 'viewer']);
  assert.deepEqual([(await permission(reader, B)).role, (await permission(reader, B)).canEdit], ['viewer', false]);
  await denied(reader, 'create_node', nodeArgs(B, 'viewer write'), 'read only');
  await denied(reader, 'set_workspace_board_access', [B, 'editor'], 'board manager');
  await denied(reader, 'rename_board', [B, 'viewer rename']);
  await ok(creator, 'set_workspace_board_member', [B, id(reader), 'editor']);
  await node(reader, B, 'editor write');
  await denied(reader, 'set_workspace_board_member', [B, id(reader), 'manager'], 'board manager');
  await ok(creator, 'set_workspace_board_member', [B, id(reader), 'manager']);
  await ok(reader, 'rename_board', [B, named('managed')]);
  await ok(reader, 'set_workspace_board_access', [B, 'viewer']);
  assert.equal((await permission(creator, B)).role, 'manager', 'workspace default cannot weaken an explicit manager');
  await denied(reader, 'set_workspace_member', [W, id(stranger), 'member'], 'administrator');
  await denied(stranger, 'set_workspace_board_member', [B, id(stranger), 'manager']);
  for (const view of ['my_workspace_members', 'my_workspace_teams', 'my_workspace_team_members', 'my_workspace_board_grants', 'my_workspace_team_grants', 'my_workspace_invites']) {
    assert.deepEqual(await rows(stranger, view), [], `${view} must not reveal another workspace`);
  }
});

test('workspace board creation retries cannot change their workspace, creator or name', async () => {
  const owner = person(), other = person();
  const W = await workspace(owner, 'creation-retries'), otherW = await workspace(owner, 'other-creation-target');
  await member(owner, W, other);
  const key = token(), name = named('retry-created-board');
  await ok(owner, 'create_workspace_board', [W, name, key]);
  await ok(owner, 'create_workspace_board', [W, name, key]);
  const made = (await rows(owner, 'my_boards')).filter(row => row.name === name);
  assert.equal(made.length, 1, 'a retry creates no duplicate board');
  await denied(owner, 'create_workspace_board', [otherW, name, key], 'request key');
  await denied(owner, 'create_workspace_board', [W, named('different-name'), key], 'request key');
  await denied(other, 'create_workspace_board', [W, name, key], 'request key');
  assert.equal((await permission(owner, made[0].boardId)).workspaceId, W, 'failed retries cannot move the existing board');
});

test('workspace defaults and same-workspace teams apply only to full members', async () => {
  const owner = person(), teammate = person(), guestMember = person(), outsider = person();
  const W = await workspace(owner, 'team-scope'), otherW = await workspace(owner, 'other-team-scope');
  await member(owner, W, teammate);
  const B = await board(owner, W, 'team-board'), hidden = await board(owner, W, 'other-private-board');
  const code = await invite(owner, W, B, 'viewer');
  await ok(guestMember, 'accept_workspace_invite', [code]);
  assert.equal((await rows(guestMember, 'my_workspaces')).find(row => row.id === W)?.role, 'guest');
  assert.equal((await rows(guestMember, 'my_workspace_members')).length, 1, 'guests only list their own membership');
  await ok(owner, 'create_workspace_team', [W, named('engineering')]);
  await ok(owner, 'create_workspace_team', [otherW, named('foreign')]);
  const teams = await rows(owner, 'my_workspace_teams');
  const team = teams.find(row => row.workspaceId === W), foreign = teams.find(row => row.workspaceId === otherW);
  await ok(owner, 'set_workspace_team_member', [team.id, id(teammate), true]);
  await denied(owner, 'set_workspace_team_member', [team.id, id(guestMember), true], 'full workspace member');
  await denied(owner, 'set_workspace_team_member', [team.id, id(outsider), true], 'full workspace member');
  await denied(teammate, 'set_workspace_team_member', [team.id, id(teammate), false], 'administrator');
  await denied(owner, 'set_workspace_board_team', [B, foreign.id, 'editor'], 'same workspace');
  await ok(owner, 'set_workspace_board_access', [B, 'viewer']);
  await ok(owner, 'set_workspace_board_access', [hidden, 'editor']);
  await ok(owner, 'set_workspace_board_team', [B, team.id, 'editor']);
  assert.equal((await permission(teammate, B)).role, 'editor', 'team editor wins over workspace viewer');
  assert.equal((await permission(guestMember, B)).role, 'viewer');
  assert.equal(await sees(guestMember, hidden), false, 'guests do not inherit workspace editor access');
  await denied(guestMember, 'create_workspace_board', [W, named('guest-created'), token()], 'guests');
  await node(teammate, B);
  await ok(owner, 'delete_workspace_team', [team.id]);
  assert.equal((await permission(teammate, B)).role, 'viewer', 'deleting a team removes its board grant');
  assert.equal((await rows(teammate, 'my_workspace_team_members')).some(row => row.teamId === team.id), false);
  await denied(teammate, 'create_node', nodeArgs(B, 'removed team edit'), 'read only');
});

test('edit links combine with viewer membership and survive explicit workspace moves', async () => {
  const creator = person(), companyOwner = person(), viewer = person(), visitor = person();
  await ok(creator, 'create_board', [named('link-before-move')]);
  const B = (await rows(creator, 'my_boards')).find(row => row.name === named('link-before-move')).boardId;
  const share = token();
  await ok(creator, 'set_link_share', [B, 'edit', share]);
  await ok(visitor, 'open_shared_link', [share]);
  const W = await workspace(companyOwner, 'link-company');
  await member(companyOwner, W, creator);
  await member(companyOwner, W, viewer);
  await ok(creator, 'move_board_to_workspace', [B, W]);
  await ok(companyOwner, 'set_workspace_board_member', [B, id(viewer), 'viewer']);
  await ok(viewer, 'open_shared_link', [share]);
  assert.equal((await permission(viewer, B)).role, 'editor', 'an explicit edit link remains stronger than a direct viewer grant');
  await node(viewer, B, 'overlapping editor');
  await node(visitor, B, 'existing visitor after move');
  await member(companyOwner, W, creator, '');
  await node(visitor, B, 'independent link after creator departure');
  assert.equal((await boardRows(visitor, 'my_boards', B))[0].linkToken, share, 'the same token remains attached to the board');
  await ok(companyOwner, 'stop_link_share', [B]);
  assert.equal((await permission(viewer, B)).role, 'viewer', 'link revocation leaves the independent viewer grant');
  assert.equal(await sees(visitor, B), false);
  await denied(viewer, 'create_node', nodeArgs(B, 'viewer after revocation'), 'read only');
});

test('invitations are private, seven-day, one-use links with cancellation', async () => {
  const owner = person(), recipient = person(), other = person(), stranger = person();
  const W = await workspace(owner, 'one-use-invites');
  const started = Date.now() * 1000;
  const code = await invite(owner, W);
  const finished = Date.now() * 1000;
  const pending = (await rows(owner, 'my_workspace_invites')).find(row => row.token === code);
  assert.ok(micros(pending.expiresAt) >= started + 7 * 86400e6 - 1e6 && micros(pending.expiresAt) <= finished + 7 * 86400e6 + 1e6, 'the deadline is seven days after creation');
  assert.deepEqual(await rows(stranger, 'my_workspace_invites'), [], 'workspace invite tokens are administrator-only');
  await denied(stranger, 'revoke_workspace_invite', [code]);
  await ok(recipient, 'accept_workspace_invite', [code]);
  await denied(other, 'accept_workspace_invite', [code], 'expired or is unavailable');
  await denied(recipient, 'accept_workspace_invite', [code], 'expired or is unavailable');
  assert.equal((await rows(owner, 'my_workspace_invites')).some(row => row.token === code), false);
  const cancelled = await invite(owner, W);
  await ok(owner, 'revoke_workspace_invite', [cancelled]);
  await denied(other, 'accept_workspace_invite', [cancelled], 'expired or is unavailable');
  await denied(owner, 'create_workspace_invite', [W, 0, 'member', 'guessable'], 'invalid invitation');
  await denied(owner, 'create_workspace_invite', [W, 0, 'owner', token()], 'invalid invitation');
});

test('invitations lose authority when their inviter is demoted or removed', async () => {
  const owner = person(), admin = person(), manager = person(), recipient = person();
  const W = await workspace(owner, 'revoked-inviter');
  await member(owner, W, admin, 'admin');
  await member(owner, W, manager);
  await denied(admin, 'create_workspace_invite', [W, 0, 'admin', token()], 'only an owner');
  const demoted = await invite(admin, W);
  await member(owner, W, admin, 'member');
  await denied(recipient, 'accept_workspace_invite', [demoted], 'no longer authorized');
  await member(owner, W, admin, 'admin');
  const removed = await invite(admin, W);
  await member(owner, W, admin, '');
  await denied(recipient, 'accept_workspace_invite', [removed]);
  const B = await board(manager, W, 'inviting-manager');
  const boardInvite = await invite(manager, W, B, 'editor');
  await ok(owner, 'set_workspace_board_member', [B, id(manager), 'viewer']);
  await denied(recipient, 'accept_workspace_invite', [boardInvite], 'no longer authorized');
  assert.equal((await rows(recipient, 'my_workspaces')).some(row => row.id === W), false, 'rejected invitations create no membership');
  const authorized = await invite(owner, W, 0, 'admin');
  await ok(recipient, 'accept_workspace_invite', [authorized]);
  assert.equal((await rows(recipient, 'my_workspaces')).find(row => row.id === W)?.role, 'admin');
});

test('board invitations preserve an existing full membership and its stronger board role', async () => {
  const owner = person(), full = person();
  const W = await workspace(owner, 'invite-no-downgrade');
  await member(owner, W, full);
  const B = await board(owner, W, 'invite-role');
  await ok(owner, 'set_workspace_board_member', [B, id(full), 'editor']);
  const code = await invite(owner, W, B, 'viewer');
  await ok(full, 'accept_workspace_invite', [code]);
  assert.equal((await rows(full, 'my_workspaces')).find(row => row.id === W)?.role, 'member');
  assert.equal((await permission(full, B)).role, 'editor');
});

test('only owners change administrators and simultaneous owner departures retain one owner', async () => {
  const owner = person(), second = person(), admin = person(), ordinary = person();
  const W = await workspace(owner, 'last-owner');
  await member(owner, W, admin, 'admin');
  await member(owner, W, ordinary);
  await denied(admin, 'set_workspace_member', [W, id(ordinary), 'admin'], 'only an owner');
  await denied(admin, 'set_workspace_member', [W, id(owner), 'member'], 'only an owner');
  await denied(ordinary, 'set_workspace_member', [W, id(admin), ''], 'administrator');
  await denied(owner, 'set_workspace_member', [W, id(owner), ''], 'at least one owner');
  await denied(owner, 'set_workspace_member', [W, id(owner), 'member'], 'at least one owner');
  await member(owner, W, second, 'owner');
  const results = await Promise.all([call(owner, 'set_workspace_member', [W, id(owner), '']), call(second, 'set_workspace_member', [W, id(second), ''])]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 530], 'one departure commits and the other protects the last owner');
  const remaining = (await sql(OWNER, `SELECT * FROM workspace_member WHERE workspace_id = ${W}`)).filter(row => row.role === 'owner');
  assert.equal(remaining.length, 1);
  const last = hex(remaining[0].member) === owner.identity ? owner : second;
  await ok(last, 'rename_workspace', [W, named('still-administered')]);
  await ok(ordinary, 'set_workspace_member', [W, id(ordinary), '']);
  assert.equal((await rows(ordinary, 'my_workspaces')).some(row => row.id === W), false, 'ordinary members can leave themselves');
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

test('revoking a human editor removes delegated agent content from live and HTTP reads', async () => {
  const owner = person(), editor = person(), a = agent(), otherAgent = agent();
  const W = await workspace(owner, 'delegation-revocation');
  await member(owner, W, editor);
  const B = await board(owner, W, 'delegated');
  await node(owner, B, 'private content');
  await ok(owner, 'set_workspace_board_member', [B, id(editor), 'editor']);
  await ok(service, 'link_hosted_agent', [id(a), id(editor)]);
  await ok(service, 'link_hosted_agent', [id(otherAgent), id(owner)]);
  assert.equal(await sees(a, B), false, 'linkage alone grants no board access');
  await ok(editor, 'grant_agent_board', [B, id(a)]);
  await denied(editor, 'grant_agent_board', [B, id(otherAgent)], 'not linked to you');
  await node(a, B, 'agent write');
  await denied(a, 'set_workspace_board_access', [B, 'editor'], 'human account');
  await denied(a, 'set_link_share', [B, 'edit', token()]);
  const tab = await connect(a, ['SELECT * FROM visible_board', 'SELECT * FROM visible_node', 'SELECT * FROM my_boards']);
  try {
    assert.ok([...tab.db.visibleNode.iter()].some(row => row.boardId === BigInt(B)));
    await ok(owner, 'set_workspace_board_member', [B, id(editor), 'viewer']);
    await waitFor(() => ![...tab.db.visibleBoard.iter()].some(row => row.id === BigInt(B)) && ![...tab.db.visibleNode.iter()].some(row => row.boardId === BigInt(B)) && ![...tab.db.myBoards.iter()].some(row => row.boardId === BigInt(B)), 'delegated content disappears live without an openBoards scope');
    assert.equal(await sees(a, B), false);
    assert.deepEqual(await boardRows(a, 'visible_node', B), []);
    assert.equal(await permission(a, B), undefined);
    await denied(a, 'create_node', nodeArgs(B, 'revoked agent'));
    await denied(editor, 'grant_agent_board', [B, id(a)]);
    await denied(service, 'grant_hosted_agent_board', [id(a), id(editor), String(B)], 'unavailable');
    await node(owner, B, 'owner retained access');
  } finally { tab.disconnect(); }
});

test('assigning an agent workspace membership cannot replace an explicit board delegation', async () => {
  const owner = person(), a = agent(), unlinked = agent();
  const W = await workspace(owner, 'agent-membership');
  const B = await board(owner, W, 'agent-needs-grant');
  await node(owner, B, 'private until delegated');
  await ok(service, 'link_hosted_agent', [id(a), id(owner)]);
  await ok(owner, 'set_workspace_board_access', [B, 'editor']);
  for (const candidate of [a, unlinked]) {
    await ok(candidate, 'join_board', ['claims to be human', 'human']);
    const assigned = await call(owner, 'set_workspace_member', [W, id(candidate), 'member']);
    assert.ok([200, 530].includes(assigned.status), `agent membership: ${assigned.status} ${assigned.text}`);
    assert.equal(await sees(candidate, B), false, 'linked and unlinked agents do not inherit workspace-wide access');
    assert.equal(await permission(candidate, B), undefined);
    await denied(candidate, 'create_node', nodeArgs(B, 'implicit agent write'));
  }
  await ok(owner, 'grant_agent_board', [B, id(a)]);
  await node(a, B, 'explicitly delegated agent');
});

test('demotion to guest preserves direct board grants while removing inherited access', async () => {
  const owner = person(), former = person(), recipient = person();
  const W = await workspace(owner, 'demote-member');
  await member(owner, W, former);
  const direct = await board(owner, W, 'demote-direct'), managed = await board(owner, W, 'demote-managed');
  const inherited = await board(owner, W, 'demote-inherited'), teamOnly = await board(owner, W, 'demote-team');
  await ok(owner, 'set_workspace_board_member', [direct, id(former), 'editor']);
  await ok(owner, 'set_workspace_board_member', [managed, id(former), 'manager']);
  await ok(owner, 'set_workspace_board_access', [inherited, 'editor']);
  await ok(owner, 'create_workspace_team', [W, named('demote-team')]);
  const team = (await rows(owner, 'my_workspace_teams')).find(row => row.workspaceId === W);
  await ok(owner, 'set_workspace_team_member', [team.id, id(former), true]);
  await ok(owner, 'set_workspace_board_team', [teamOnly, team.id, 'editor']);
  const issued = await invite(former, W, managed, 'viewer');
  await node(former, teamOnly, 'before demotion');
  await ok(owner, 'set_workspace_member', [W, id(former), 'guest']);
  assert.equal((await rows(former, 'my_workspaces')).find(row => row.id === W).role, 'guest');
  assert.equal((await permission(former, direct))?.role, 'editor', 'direct editing survives demotion');
  assert.equal((await permission(former, managed))?.role, 'manager', 'direct management survives demotion');
  await node(former, direct, 'after demotion');
  for (const B of [inherited, teamOnly]) assert.equal(await sees(former, B), false, 'guests lose workspace and team access');
  assert.equal((await sql(OWNER, `SELECT * FROM workspace_team_member WHERE member = 0x${former.identity}`)).length, 0);
  await denied(recipient, 'accept_workspace_invite', [issued], 'unavailable');
  await denied(former, 'create_workspace_board', [W, named('guest-create'), token()], 'guests');
});

for (const entry of ['ensurePersonalWorkspace', 'createWorkspace']) {
  test(`existing connections register missing accounts through ${entry} without reconnecting`, async () => {
    const owner = person(), existing = person();
    const W = await workspace(owner, 'upgrade-add-member');
    const tab = await connect(existing, ['SELECT * FROM my_workspaces', 'SELECT * FROM my_board_permissions']);
    try {
      // A publish adds this table without rerunning onConnect for already-open sockets.
      await sql(OWNER, `DELETE FROM workspace_account WHERE identity = 0x${existing.identity}`);
      await tab.reducers[entry](entry === 'createWorkspace' ? { name: named('upgrade-created') } : {});
      const [account] = await sql(OWNER, `SELECT * FROM workspace_account WHERE identity = 0x${existing.identity}`);
      assert.equal(account?.disabled, false, 'a verified reducer registers the existing socket');
      await ok(owner, 'set_workspace_member', [W, id(existing), 'member']);
      const created = (await sql(OWNER, `SELECT * FROM workspace WHERE owner = 0x${existing.identity}`))[0];
      const key = token();
      await tab.reducers.createWorkspaceBoard({ workspaceId: BigInt(created.id), name: named('upgrade-board'), requestKey: key });
      const receipt = (await sql(OWNER, `SELECT * FROM board_creation WHERE request_key = '${key}'`))[0];
      await waitFor(() => [...tab.db.myBoardPermissions.iter()].some(row => row.boardId === BigInt(receipt.boardId) && row.role === 'manager'), 'existing socket sees its new board');
      await ok(service, 'deactivate_workspace_identity', [id(existing)]);
      await assert.rejects(tab.reducers.ensurePersonalWorkspace({}), /human account/);
      assert.equal((await sql(OWNER, `SELECT * FROM workspace_account WHERE identity = 0x${existing.identity}`))[0].disabled, true, 'onboarding never re-enables a deactivated identity');
    } finally { tab.disconnect(); }
  });
}

test('leaving an imported workspace preserves direct grants belonging to another workspace', async () => {
  const owner = person(), former = person();
  const org = named('independent-personal-access');
  await ok(service, 'set_org_memberships', [id(owner), [org], ['org:admin']]);
  await ok(service, 'set_org_memberships', [id(former), [org], ['org:member']]);
  await ok(owner, 'create_team_board', [named('independently-shared'), org]);
  const B = (await rows(owner, 'my_boards')).find(row => row.name === named('independently-shared')).boardId;
  await ok(service, 'migrate_legacy_workspaces');
  const W = (await rows(owner, 'my_workspaces')).find(row => row.name === org).id;
  await ok(owner, 'ensure_personal_workspace');
  const personal = (await rows(owner, 'my_workspaces')).find(row => row.personal).id;
  await ok(former, 'accept_workspace_invite', [await invite(owner, personal, B, 'editor')]);
  await ok(owner, 'set_workspace_member', [W, id(former), '']);
  assert.equal((await permission(former, B))?.role, 'editor', 'company removal cannot delete an independent personal-workspace grant');
  await node(former, B, 'independent guest access');
});

test('removal clears direct and team grants so a later guest invitation cannot revive them', async () => {
  const owner = person(), former = person(), a = agent();
  const W = await workspace(owner, 'membership-reset');
  await member(owner, W, former);
  const old = await board(owner, W, 'old-manager'), fresh = await board(owner, W, 'new-guest');
  await ok(owner, 'set_workspace_board_member', [old, id(former), 'manager']);
  await ok(owner, 'create_workspace_team', [W, named('old-team')]);
  const team = (await rows(owner, 'my_workspace_teams')).find(row => row.workspaceId === W);
  await ok(owner, 'set_workspace_team_member', [team.id, id(former), true]);
  await ok(owner, 'set_workspace_board_team', [old, team.id, 'editor']);
  await ok(service, 'link_hosted_agent', [id(a), id(former)]);
  await ok(former, 'grant_agent_board', [old, id(a)]);
  await member(owner, W, former, '');
  assert.equal(await sees(former, old), false);
  assert.equal(await sees(a, old), false);
  const code = await invite(owner, W, fresh, 'viewer');
  await ok(former, 'accept_workspace_invite', [code]);
  assert.equal((await permission(former, fresh)).role, 'viewer');
  assert.equal(await sees(former, old), false, 'former manager grants do not revive');
  assert.equal(await sees(a, old), false, 'former agent grants do not revive');
  assert.equal((await rows(owner, 'my_workspace_team_members')).some(row => hex(row.member) === former.identity), false);
  assert.equal((await rows(owner, 'my_workspace_board_grants')).some(row => row.boardId === old && hex(row.member) === former.identity), false);
});

test('branches inherit workspace ownership and move with their base without changing links', async () => {
  const creator = person(), companyOwner = person(), editor = person();
  await ok(creator, 'create_board', [named('personal-base')]);
  const base = (await rows(creator, 'my_boards')).find(row => row.name === named('personal-base')).boardId;
  await node(creator, base, 'base content');
  await ok(creator, 'create_architecture_proposal', [base, named('personal-branch'), token()]);
  const branch = (await rows(creator, 'my_boards')).find(row => row.name === named('personal-branch')).boardId;
  const slugs = await rows(creator, 'my_board_slugs');
  const W = await workspace(companyOwner, 'company-family');
  await member(companyOwner, W, creator);
  await member(companyOwner, W, editor);
  await ok(creator, 'move_board_to_workspace', [branch, W]);
  for (const boardId of [base, branch]) {
    assert.equal((await permission(companyOwner, boardId)).workspaceId, W);
    assert.equal((await permission(creator, boardId)).role, 'manager');
    assert.equal((await rows(companyOwner, 'my_board_slugs')).find(row => row.boardId === boardId)?.slug, slugs.find(row => row.boardId === boardId)?.slug);
    assert.equal((await sql(OWNER, `SELECT * FROM board_grant WHERE board_id = ${boardId}`)).length, 0, 'the former personal ownership row is removed');
  }
  await ok(companyOwner, 'set_workspace_board_member', [base, id(editor), 'editor']);
  await ok(editor, 'create_architecture_proposal', [base, named('company-branch'), token()]);
  const inherited = (await rows(editor, 'my_boards')).find(row => row.name === named('company-branch')).boardId;
  assert.equal((await permission(companyOwner, inherited)).workspaceId, W, 'new branches inherit the company workspace');
  await ok(companyOwner, 'set_workspace_board_access', [base, 'viewer']);
  const pending = await invite(companyOwner, W, base, 'viewer');
  const grants = await rows(companyOwner, 'my_workspace_board_grants');
  await ok(companyOwner, 'move_board_to_workspace', [base, W]);
  assert.equal((await permission(editor, base)).role, 'editor', 'moving to the current workspace preserves explicit access');
  assert.equal((await permission(companyOwner, base)).defaultRole, 'viewer');
  assert.deepEqual(await rows(companyOwner, 'my_workspace_board_grants'), grants, 'an idempotent move does not rewrite grants');
  assert.equal((await rows(companyOwner, 'my_workspace_invites')).some(row => row.token === pending), true, 'an idempotent move preserves pending invitations');
  await denied(creator, 'move_board_to_workspace', [base, await workspace(creator, 'creator-company')], 'administrator');
  await member(companyOwner, W, creator, '');
  await member(companyOwner, W, editor, '');
  for (const boardId of [base, branch, inherited]) {
    assert.equal(await sees(creator, boardId), false);
    assert.equal(await sees(editor, boardId), false);
    assert.equal(await sees(companyOwner, boardId), true);
  }
});

test('legacy organization editors can read and edit branches of a personal board without gaining review authority', async () => {
  const owner = person(), editor = person();
  const org = named('legacy-branch-team');
  await ok(service, 'set_org_memberships', [id(owner), [org], ['org:admin']]);
  await ok(service, 'set_org_memberships', [id(editor), [org], ['org:member']]);
  await ok(owner, 'create_team_board', [named('legacy-branch-base'), org]);
  const base = (await rows(owner, 'my_boards')).find(row => row.name === named('legacy-branch-base')).boardId;
  await node(owner, base, 'shared base');
  await ok(service, 'migrate_legacy_workspaces');
  await ok(owner, 'ensure_personal_workspace');
  const personal = (await rows(owner, 'my_workspaces')).find(row => row.personal).id;
  assert.equal((await rows(editor, 'my_workspaces')).some(row => row.id === personal), false, 'the editor belongs to the imported organization, not the owner\'s personal workspace');
  assert.equal((await permission(editor, base)).role, 'editor');
  const requestKey = token();
  await ok(editor, 'create_architecture_proposal', [base, named('legacy-editor-branch'), requestKey]);
  const branch = (await rows(OWNER, 'architecture_version')).find(row => row.requestKey === requestKey).boardId;
  assert.equal(await sees(editor, branch), true, 'the branch retains the base\'s legacy organization access');
  assert.equal((await permission(editor, branch)).workspaceId, personal);
  assert.equal((await permission(editor, branch)).role, 'editor');
  await ok(editor, 'create_architecture_proposal', [base, named('legacy-editor-branch'), requestKey]);
  assert.equal((await rows(OWNER, 'architecture_version')).filter(row => row.requestKey === requestKey).length, 1, 'a retry by the editor creates no duplicate branch');
  await node(editor, branch, 'editor proposal change');
  await ok(editor, 'submit_architecture_proposal', [branch]);
  await denied(editor, 'review_architecture_proposal', [branch, 'accept']);
  await ok(owner, 'review_architecture_proposal', [branch, 'accept']);
  await denied(editor, 'merge_architecture_proposal', [branch]);
});

test('history moves include all snapshots and proposals, and creator metadata never bypasses membership', async () => {
  const creator = person(), companyOwner = person();
  const sha = 'a'.repeat(40), otherSha = 'b'.repeat(40), key = token();
  const refs = JSON.stringify([{ ref: 'main', sha }, { ref: 'next', sha: otherSha }]);
  await ok(creator, 'create_architecture_history', [named('history-family'), 'https://github.com/acme/example', refs, key]);
  const H = (await rows(creator, 'my_architecture_histories')).find(row => row.requestKey === key).id;
  const graph = JSON.stringify({ nodes: [{ key: 'service:a', label: 'A', sublabel: '', kind: 'service' }], edges: [], files: ['src/a.ts'] });
  await ok(service, 'publish_architecture_snapshot', [H, 0, 'main', sha, graph]);
  const first = (await rows(creator, 'visible_architecture_version')).find(row => row.historyId === H && row.assertionMode === 'fact').boardId;
  await ok(creator, 'create_architecture_proposal', [first, named('history-proposal'), token()]);
  const proposal = (await rows(creator, 'my_boards')).find(row => row.name === named('history-proposal')).boardId;
  const W = await workspace(companyOwner, 'history-company');
  await member(companyOwner, W, creator);
  await ok(creator, 'move_board_to_workspace', [first, W]);
  for (const boardId of [first, proposal]) assert.equal((await permission(companyOwner, boardId)).workspaceId, W);
  await ok(companyOwner, 'propagate_architecture_curation', [first]);
  await member(companyOwner, W, creator, '');
  for (const view of ['my_architecture_histories', 'visible_architecture_history']) {
    assert.equal((await rows(creator, view)).some(row => row.id === H), false, `${view} cannot expose the removed creator's history`);
    assert.equal((await rows(companyOwner, view)).some(row => row.id === H), true, `${view} follows current workspace administration`);
  }
  await denied(creator, 'propagate_architecture_curation', [first]);
  await ok(service, 'publish_architecture_snapshot', [H, 1, 'next', otherSha, graph]);
  const next = (await rows(companyOwner, 'visible_architecture_version')).find(row => row.historyId === H && row.index === 1 && row.assertionMode === 'fact').boardId;
  assert.equal((await permission(companyOwner, next)).workspaceId, W, 'snapshots published after a move inherit the workspace');
  assert.equal(await sees(creator, next), false, 'the original history owner receives no new personal ownership grant');
  assert.deepEqual(await boardRows(creator, 'visible_repo_file', next), []);
});

test('native workspace imports expose queued metadata to administrators and scope request-key retries', async () => {
  const owner = person(), creator = person(), bystander = person(), stranger = person();
  const W = await workspace(owner, 'native-history');
  await member(owner, W, creator);
  await member(owner, W, bystander);
  const otherW = await workspace(creator, 'other-history-workspace');
  const key = token(), sha = 'c'.repeat(40), name = named('queued-native-history');
  const details = [name, 'https://github.com/acme/native-import', JSON.stringify([{ ref: 'main', sha }]), key];
  await denied(stranger, 'create_workspace_architecture_history', [W, ...details], 'full workspace member');
  await ok(creator, 'create_workspace_architecture_history', [W, ...details]);
  await ok(creator, 'create_workspace_architecture_history', [W, ...details]);
  const histories = (await rows(creator, 'my_architecture_histories')).filter(row => row.requestKey === key);
  assert.equal(histories.length, 1, 'same-workspace retries create exactly one history');
  assert.equal(histories[0].status, 'queued');
  const H = histories[0].id;
  for (const view of ['my_architecture_histories', 'visible_architecture_history']) {
    assert.equal((await rows(owner, view)).some(row => row.id === H), true, 'workspace administrators can inspect a queued import before it has snapshots');
    assert.equal((await rows(bystander, view)).some(row => row.id === H), false, 'ordinary membership does not expose a private import');
    assert.equal((await rows(stranger, view)).some(row => row.id === H), false);
  }
  await denied(creator, 'create_workspace_architecture_history', [otherW, ...details], 'another workspace');
  await denied(creator, 'create_architecture_history', details, 'another workspace');
  await member(owner, W, creator, '');
  assert.equal((await rows(creator, 'visible_architecture_history')).some(row => row.id === H), false, 'queued creator metadata is revoked with membership');
  const graph = JSON.stringify({ nodes: [{ key: 'service:native', label: 'Native', sublabel: '', kind: 'service' }], edges: [], files: [] });
  await ok(service, 'publish_architecture_snapshot', [H, 0, 'main', sha, graph]);
  const snapshot = (await rows(owner, 'visible_architecture_version')).find(row => row.historyId === H).boardId;
  assert.equal((await permission(owner, snapshot)).workspaceId, W);
  assert.equal(await sees(creator, snapshot), false, 'publication cannot restore a removed creator');
});

test('history reading does not grant the management view used to authorize import retries', async () => {
  const owner = person(), admin = person(), viewer = person(), editor = person(), guestViewer = person();
  const W = await workspace(owner, 'history-management-scope');
  await member(owner, W, admin, 'admin');
  await member(owner, W, viewer);
  await member(owner, W, editor);
  const key = token(), sha = 'd'.repeat(40);
  await ok(owner, 'create_workspace_architecture_history', [W, named('history-management'), 'https://github.com/acme/history-management', JSON.stringify([{ ref: 'main', sha }]), key]);
  const H = (await rows(owner, 'my_architecture_histories')).find(row => row.requestKey === key).id;
  const graph = JSON.stringify({ nodes: [{ key: 'service:management', label: 'Management', sublabel: '', kind: 'service' }], edges: [], files: [] });
  await ok(service, 'publish_architecture_snapshot', [H, 0, 'main', sha, graph]);
  const B = (await rows(owner, 'visible_architecture_version')).find(row => row.historyId === H).boardId;
  await ok(owner, 'set_workspace_board_member', [B, id(viewer), 'viewer']);
  await ok(owner, 'set_workspace_board_member', [B, id(editor), 'editor']);
  const code = await invite(owner, W, B, 'viewer');
  await ok(guestViewer, 'accept_workspace_invite', [code]);
  for (const who of [viewer, editor, guestViewer]) {
    assert.equal(await sees(who, B), true);
    assert.equal((await rows(who, 'visible_architecture_history')).some(row => row.id === H), true, 'readable snapshots still expose the metadata needed for their history rail');
    assert.equal((await rows(who, 'my_architecture_histories')).some(row => row.id === H), false, 'read access cannot authorize the import retry endpoint');
  }
  for (const who of [owner, admin]) assert.equal((await rows(who, 'my_architecture_histories')).some(row => row.id === H), true, 'workspace administrators retain import management');
});

test('legacy organization import is one-time and native removal wins over future synchronization', async () => {
  const owner = person(), oldMember = person(), newMember = person();
  const org = named('legacy-org');
  await ok(service, 'set_org_memberships', [id(owner), [org], ['org:admin']]);
  await ok(service, 'set_org_memberships', [id(oldMember), [org], ['org:member']]);
  await ok(owner, 'create_team_board', [named('legacy-shared'), org]);
  const B = (await rows(owner, 'my_boards')).find(row => row.name === named('legacy-shared')).boardId;
  assert.equal(await sees(oldMember, B), true);
  await denied(owner, 'migrate_legacy_workspaces', [], 'service account');
  await ok(service, 'migrate_legacy_workspaces');
  const imported = (await rows(owner, 'my_workspaces')).find(row => row.name === org);
  assert.equal(imported.role, 'owner');
  assert.equal((await rows(oldMember, 'my_workspaces')).find(row => row.id === imported.id)?.role, 'member');
  assert.equal((await permission(owner, B)).workspaceId, 0, 'import keeps legacy boards personally owned');
  await member(owner, imported.id, oldMember, '');
  await ok(service, 'set_org_memberships', [id(oldMember), [org], ['org:admin']]);
  await ok(service, 'set_org_memberships', [id(newMember), [org], ['org:member']]);
  await ok(service, 'migrate_legacy_workspaces');
  assert.equal(await sees(oldMember, B), false, 'resynchronized legacy rows cannot undo native removal');
  assert.equal(await sees(newMember, B), false, 'new legacy rows are not imported after native authority begins');
  await denied(oldMember, 'create_team_board', [named('stale-org-authority'), org], 'not a member');
  await member(owner, imported.id, newMember);
  assert.equal(await sees(newMember, B), true, 'native membership grants legacy organization shares');
  await ok(service, 'set_org_memberships', [id(newMember), [], []]);
  await ok(newMember, 'create_team_board', [named('native-org-authority'), org]);
  await ok(service, 'drop_org', [org]);
  assert.equal(await sees(newMember, B), true, 'legacy synchronization and organization deletion cannot erase native shares');
  assert.equal((await rows(owner, 'my_workspaces')).filter(row => row.id === imported.id).length, 1);
});

test('provider identity deactivation clears membership and delegation without removing company control', async () => {
  const owner = person(), departed = person(), a = agent();
  const W = await workspace(owner, 'deactivated-identity');
  await member(owner, W, departed);
  const B = await board(departed, W, 'departed-created');
  await ok(service, 'link_hosted_agent', [id(a), id(departed)]);
  await ok(departed, 'grant_agent_board', [B, id(a)]);
  await denied(owner, 'deactivate_workspace_identity', [id(departed)], 'service account');
  await ok(service, 'deactivate_workspace_identity', [id(departed)]);
  assert.equal(await sees(departed, B), false);
  assert.equal(await sees(a, B), false);
  assert.equal((await permission(owner, B)).role, 'manager');
  await node(owner, B, 'company retained board');
});

test('deactivating a personal workspace owner keeps their current token disabled across reconnects', async () => {
  const owner = person();
  await ok(owner, 'ensure_personal_workspace');
  const personal = (await rows(owner, 'my_workspaces')).find(row => row.personal).id;
  const B = await board(owner, personal, 'deactivated-personal');
  await node(owner, B, 'personal content');
  await ok(service, 'deactivate_workspace_identity', [id(owner)]);
  assert.equal(await sees(owner, B), false, 'legacy personal owner metadata cannot bypass a disabled account');
  assert.deepEqual(await rows(owner, 'my_workspaces'), []);
  await denied(owner, 'ensure_personal_workspace', [], 'human account');
  await denied(owner, 'create_workspace', [named('disabled-owner-reconnect')], 'human account');
  assert.equal(await sees(owner, B), false, 'repeated authenticated calls cannot reactivate provider-deleted identities');
});

test('disabled owners of unscoped legacy boards cannot rename, delete or restore agent grants', async () => {
  const owner = person(), a = agent();
  await ok(owner, 'create_board', [named('disabled-unscoped')]);
  const B = (await rows(owner, 'my_boards')).find(row => row.name === named('disabled-unscoped')).boardId;
  assert.equal((await permission(owner, B)).workspaceId, 0, 'the regression uses a board with only legacy ownership');
  await ok(service, 'link_hosted_agent', [id(a), id(owner)]);
  await ok(owner, 'grant_agent_board', [B, id(a)]);
  await node(a, B, 'agent before provider deletion');
  await ok(service, 'deactivate_workspace_identity', [id(owner)]);
  assert.equal(await sees(owner, B), false);
  assert.equal(await sees(a, B), false);
  await denied(owner, 'rename_board', [B, named('disabled-rename')]);
  await denied(owner, 'delete_board', [B]);
  await denied(owner, 'grant_agent_board', [B, id(a)]);
  await denied(service, 'grant_hosted_agent_board', [id(a), id(owner), String(B)]);
  assert.equal(await sees(a, B), false, 'a service regrant cannot revive a deleted human account');
  assert.deepEqual(await sql(OWNER, `SELECT * FROM agent_grant WHERE board_id = ${B}`), []);
  assert.equal((await sql(OWNER, `SELECT name FROM board WHERE id = ${B}`))[0].name, named('disabled-unscoped'), 'disabled mutations leave the retained board intact');
});

test('native board managers publish and list embeds, and losing management withdraws board publication', async () => {
  const owner = person(), manager = person(), W = await workspace(owner, 'native-embed-manager');
  await member(owner, W, manager);
  const B = await board(owner, W, 'native-embed');
  await ok(owner, 'set_workspace_board_member', [B, id(manager), 'manager']);
  await ok(manager, 'create_chart', [B, 'managed chart', '', 0, 0, 352, 224, 'timeseries', 'time,p99\n10:00,40\n10:05,44\n', NONE, NONE]);
  const chartId = (await sql(OWNER, `SELECT * FROM chart WHERE board_id = ${B}`))[0].nodeId;
  const chartToken = token(), boardToken = token();
  await ok(manager, 'enable_chart_embed', [chartId, chartToken]);
  await ok(manager, 'enable_board_embed', [B, boardToken, false, 0]);
  for (const who of [owner, manager]) {
    assert.equal((await rows(who, 'my_chart_embeds')).find(row => row.nodeId === chartId)?.token, chartToken);
    assert.equal((await rows(who, 'my_board_embeds')).find(row => row.boardId === B)?.token, boardToken);
  }
  const tab = await connect(guest(), ['SELECT * FROM embedded_board']);
  try {
    await tab.reducers.openBoardEmbed({ token: boardToken });
    await waitFor(() => [...tab.db.embeddedBoard.iter()].some(row => row.token === boardToken), 'a native manager can publish the board');
    await ok(owner, 'set_workspace_board_member', [B, id(manager), 'viewer']);
    await waitFor(() => [...tab.db.embeddedBoard.iter()].length === 0, 'publication follows the publisher\'s current management rights');
    assert.equal((await rows(manager, 'my_board_embeds')).some(row => row.boardId === B), false);
    assert.equal((await rows(manager, 'my_chart_embeds')).some(row => row.nodeId === chartId), false);
    await ok(owner, 'disable_chart_embed', [chartId]);
    await ok(owner, 'disable_board_embed', [B]);
  } finally { tab.disconnect(); }
});

test('deactivated viewers lose open embed capabilities and cannot reopen them', async () => {
  const owner = person(), viewer = person();
  await rows(viewer, 'my_workspaces');
  await ok(owner, 'create_board', [named('disabled-embed-viewer')]);
  const B = (await rows(owner, 'my_boards')).find(row => row.name === named('disabled-embed-viewer')).boardId;
  await ok(owner, 'create_chart', [B, 'published chart', '', 0, 0, 352, 224, 'timeseries', 'time,p99\n10:00,40\n10:05,44\n', NONE, NONE]);
  const chartId = (await sql(OWNER, `SELECT * FROM chart WHERE board_id = ${B}`))[0].nodeId;
  const chartToken = token(), boardToken = token();
  await ok(owner, 'enable_chart_embed', [chartId, chartToken]);
  await ok(owner, 'enable_board_embed', [B, boardToken, false, 0]);
  const tab = await connect(viewer, ['SELECT * FROM embedded_chart', 'SELECT * FROM embedded_board']);
  try {
    await tab.reducers.openChartEmbed({ token: chartToken });
    await tab.reducers.openBoardEmbed({ token: boardToken });
    await waitFor(() => [...tab.db.embeddedChart.iter()].length === 1 && [...tab.db.embeddedBoard.iter()].length === 1, 'both projections are visible before deactivation');
    await ok(service, 'deactivate_workspace_identity', [id(viewer)]);
    await waitFor(() => [...tab.db.embeddedChart.iter()].length === 0 && [...tab.db.embeddedBoard.iter()].length === 0, 'deactivation removes existing capabilities live');
    await denied(viewer, 'open_chart_embed', [chartToken]);
    await denied(viewer, 'open_board_embed', [boardToken]);
    assert.deepEqual(await rows(viewer, 'embedded_chart'), []);
    assert.deepEqual(await rows(viewer, 'embedded_board'), []);
  } finally { tab.disconnect(); }
});

test('deactivation blocks public and retained edit-link fallback reads and consent changes', async () => {
  const owner = person(), viewer = person(), visitor = guest();
  await rows(viewer, 'my_workspaces');
  await ok(owner, 'create_board', [named('disabled-capability-fallback')]);
  const B = (await rows(owner, 'my_boards')).find(row => row.name === named('disabled-capability-fallback')).boardId;
  await node(owner, B, 'published content');
  const share = token();
  await ok(owner, 'set_link_share', [B, 'edit', share]);
  await ok(viewer, 'open_shared_link', [share]);
  await ok(visitor, 'open_shared_link', [share]);
  await sql(OWNER, `INSERT INTO public_board (board_id) VALUES (${B})`);
  assert.equal(await sees(viewer, B), true);
  await ok(service, 'deactivate_workspace_identity', [id(viewer)]);
  assert.equal(await sees(viewer, B), false, 'public visibility cannot override deactivation');
  assert.deepEqual(await rows(viewer, 'my_boards'), [], 'public listings cannot override deactivation');
  assert.deepEqual(await boardRows(viewer, 'visible_node', B), []);
  assert.deepEqual(await boardRows(viewer, 'visible_board_code_consent', B), []);
  await sql(OWNER, `DELETE FROM public_board WHERE board_id = ${B}`);
  // Deactivation cleans ordinary visits; a retained row must also fail closed.
  await sql(OWNER, `UPDATE link_visit SET viewer = 0x${viewer.identity} WHERE viewer = 0x${visitor.identity}`);
  assert.equal(await sees(viewer, B), false, 'retained link visits cannot override deactivation');
  await denied(viewer, 'create_node', nodeArgs(B, 'disabled write'));
  await denied(viewer, 'set_code_consent', [true]);
  assert.deepEqual(await rows(viewer, 'my_code_consent'), []);
});

test('removed and deactivated history creators cannot delete company history, while current administrators can', async () => {
  for (const reason of ['removed', 'deactivated']) {
    const owner = person(), creator = person(), W = await workspace(owner, `history-delete-${reason}`);
    await member(owner, W, creator);
    const request = token(), sha = 'f'.repeat(40);
    await ok(creator, 'create_workspace_architecture_history', [W, named(`history-delete-${reason}`), 'https://github.com/acme/history-delete', JSON.stringify([{ ref: 'main', sha }]), request]);
    const H = (await rows(owner, 'my_architecture_histories')).find(row => row.requestKey === request).id;
    const graph = JSON.stringify({ nodes: [{ key: 'service:delete', label: 'Retained', sublabel: '', kind: 'service' }], edges: [], files: [] });
    await ok(service, 'publish_architecture_snapshot', [H, 0, 'main', sha, graph]);
    const B = (await rows(owner, 'visible_architecture_version')).find(row => row.historyId === H).boardId;
    const pending = await invite(owner, W, B, 'viewer');
    if (reason === 'removed') await member(owner, W, creator, '');
    else await ok(service, 'deactivate_workspace_identity', [id(creator)]);
    await denied(creator, 'delete_architecture_history', [H]);
    assert.equal((await sql(OWNER, `SELECT * FROM architecture_history WHERE id = ${H}`)).length, 1);
    await ok(owner, 'delete_architecture_history', [H]);
    assert.deepEqual(await sql(OWNER, `SELECT * FROM architecture_history WHERE id = ${H}`), []);
    assert.deepEqual(await sql(OWNER, `SELECT * FROM history_workspace WHERE history_id = ${H}`), []);
    assert.deepEqual(await sql(OWNER, `SELECT * FROM board_workspace WHERE board_id = ${B}`), []);
    assert.deepEqual(await sql(OWNER, `SELECT * FROM workspace_invite WHERE token = '${pending}'`), []);
    assert.equal(await sees(owner, B), false);
  }
});

test('deleting a native board sweeps ownership, direct/team grants and invitations', async () => {
  const owner = person(), W = await workspace(owner, 'native-board-deletion');
  const B = await board(owner, W, 'native-delete'), teamName = named('native-delete-team');
  await ok(owner, 'create_workspace_team', [W, teamName]);
  const team = (await rows(owner, 'my_workspace_teams')).find(row => row.name === teamName);
  await ok(owner, 'set_workspace_board_team', [B, team.id, 'viewer']);
  const pending = await invite(owner, W, B, 'viewer');
  const tables = ['board_workspace', 'workspace_board_grant', 'workspace_team_grant', 'workspace_invite'];
  for (const table of tables) assert.ok((await sql(OWNER, `SELECT * FROM ${table} WHERE board_id = ${B}`)).length > 0, `${table} seeded`);
  await ok(owner, 'delete_board', [B]);
  for (const table of tables) assert.deepEqual(await sql(OWNER, `SELECT * FROM ${table} WHERE board_id = ${B}`), [], `${table} swept`);
  assert.equal((await rows(owner, 'my_workspace_invites')).some(row => row.token === pending), false);
  assert.equal(await sees(owner, B), false);
});

test('browser identities and their stale pairing offers cannot transfer personal ownership as agents', async () => {
  const browser = person(), recipient = person(), realAgent = agent();
  await ok(browser, 'create_board', [named('browser-is-not-agent')]);
  const B = (await rows(browser, 'my_boards')).find(row => row.name === named('browser-is-not-agent')).boardId;
  await rows(recipient, 'my_workspaces');
  await denied(browser, 'offer_agent_link', [token()]);
  const stale = token();
  await ok(realAgent, 'offer_agent_link', [stale]);
  // Model an offer created before account classification existed; its real expiry stays unchanged.
  await sql(OWNER, `UPDATE agent_link_offer SET agent = 0x${browser.identity} WHERE code = '${stale}'`);
  await denied(recipient, 'redeem_agent_link', [stale]);
  await denied(service, 'link_hosted_agent', [id(browser), id(recipient)]);
  assert.equal((await permission(browser, B)).role, 'manager');
  assert.equal(await sees(recipient, B), false, 'rejected pairing cannot adopt another browser account\'s boards');
  await ok(service, 'deactivate_workspace_identity', [id(browser)]);
  await denied(browser, 'offer_agent_link', [token()]);
  await denied(recipient, 'redeem_agent_link', [stale]);
  await denied(service, 'link_hosted_agent', [id(browser), id(recipient)]);
  await denied(service, 'link_hosted_agent', [id(realAgent), id(browser)]);
  const owners = await sql(OWNER, `SELECT * FROM board_grant WHERE board_id = ${B}`);
  assert.deepEqual(owners.filter(row => row.role === 'owner').map(row => hex(row.grantee)), [browser.identity]);
  assert.equal(await sees(recipient, B), false, 'provider deletion cannot turn old account ownership into agent adoption');
});

// RC-690: a board in a shared workspace has no owner whose consent it follows, so a move there blanks its stored code.
test('moving a board into a shared workspace blanks the code text it stored under its owner consent', async () => {
  const creator = person();
  await ok(creator, 'set_code_consent', [true]);
  await ok(creator, 'create_board', [named('consent-move')]);
  const B = (await rows(creator, 'my_boards')).find(row => row.name === named('consent-move')).boardId;
  await ok(creator, 'add_repo_files', [B, ['src/a.ts']]);
  await node(creator, B, 'a');
  await node(creator, B, 'b');
  const [a, b] = await sql(OWNER, `SELECT * FROM node WHERE board_id = ${B}`);
  await ok(creator, 'add_code_ref', [B, 'node', a.id, 'src/a.ts', 'verify', 1, 1, '4b825dc642cb6eb9a060e54bf8d69288fbee4904', 'function verify() {}', 'test']);
  await ok(creator, 'create_edge', [B, a.id, b.id, 'calls', 'source:src/a.ts:1', NONE, { some: 'verify();' }, NONE]);
  const stored = async () => [
    ...(await sql(OWNER, `SELECT snippet FROM code_ref WHERE board_id = ${B}`)).map(r => r.snippet),
    ...(await sql(OWNER, `SELECT evidence_snippet FROM edge WHERE board_id = ${B}`)).map(e => e.evidenceSnippet),
  ];
  assert.deepEqual(await stored(), ['function verify() {}', 'verify();']);
  await ok(creator, 'move_board_to_workspace', [B, await workspace(creator, 'consent-move')]);
  assert.deepEqual(await stored(), ['', ''], 'the move leaves no code text behind');
});
