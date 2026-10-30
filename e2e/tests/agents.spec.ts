import { randomBytes } from 'node:crypto';
import type { Page } from '@playwright/test';
import { test, expect, openBoard, drawNode, shareBoard, boardIdOf, linkedAgent, boardLink, type Stack } from '../fixtures';

// Agent grants, D6 agent-owned boards, the hosted service grant and agent presence
// (specs 2026-10-10-agent-board-grants-design, hosted-mcp-server-design D17).
// Agents call the module over HTTP as database-minted identities; no MCP Worker here.
type Who = { identity: string; token: string };

const NONE = { none: [] };
const AGENT = 'e2e-agent'; // linkedAgent's display name
const UNAVAILABLE = 'not authorized: board is unavailable';
const READ_ONLY = 'not authorized: board is read only';
const idOf = (hex: string) => ({ __identity__: `0x${hex}` });
const hexOf = (value: unknown) => String(Array.isArray(value) ? value[0] : (value as { __identity__?: string }).__identity__ ?? value).replace(/^0x/, '').toLowerCase();
const unique = (name: string) => `${name} ${randomBytes(3).toString('hex')}`;
const shareToken = () => randomBytes(16).toString('hex');

let spot = 0;
/** create_node as token: boardId, label, sublabel, x, y, w, h, token, focal, then seven options. Each node gets its own spot. */
function createNode(stack: Stack, token: string, boardId: number, label: string) {
  spot += 1;
  return stack.callReducer(token, 'create_node', [boardId, label, '', 1200 + (spot % 5) * 220, 900 + (spot % 3) * 152, 160, 80, 'ink', false, NONE, NONE, NONE, NONE, NONE, NONE, NONE]);
}

/** A new board on this account page with these nodes drawn through the UI. */
async function newBoard(page: Page, stack: Stack, ...labels: string[]) {
  await openBoard(page, `${stack.url}?new=1`);
  for (const label of labels) await drawNode(page, label);
  return boardIdOf(stack, page);
}

async function boardNamed(stack: Stack, name: string) {
  const [row] = await stack.sql(`SELECT id, slug FROM board WHERE name = '${name}'`);
  return { id: Number(row.id), slug: String(row.slug) };
}

const firstNodeId = async (page: Page) => Number(await page.locator('#world g.node').first().getAttribute('data-id'));

/** offer_agent_link by the agent, redeem_agent_link by the person (the /link page). */
async function link(stack: Stack, agent: Who, personToken: string) {
  const code = randomBytes(32).toString('base64url');
  await stack.callReducer(agent.token, 'offer_agent_link', [code]);
  await stack.callReducer(personToken, 'redeem_agent_link', [code]);
}

/**
 * An agent shaped as the hosted MCP leaves one: joined as e2e-agent with no socket
 * (connections 0, lastSeenAt at its join), then a service account so its HTTP calls
 * keep their selection and cursor (module onDisconnect).
 */
async function presentAgent(stack: Stack, agent?: Who) {
  const who = agent ?? await stack.mintIdentity();
  if (!agent) await stack.callReducer(who.token, 'join_board', [AGENT, 'agent']);
  await stack.sql(`INSERT INTO service_account (identity, label) VALUES (0x${who.identity}, 'presence-agent')`);
  return who;
}

/** Whether the page's client holds this identity's participant and selection rows. */
const clientHas = (page: Page, hex: string) => page.evaluate(hex => {
  const db = (window as any).conn.db;
  const mine = (table: any) => [...table.iter()].some((row: any) => row.identity.toHexString() === hex);
  return { participant: mine(db.visibleParticipant), selection: mine(db.visibleSelection) };
}, hex);

const agentChip = (page: Page) => page.locator('#participant-chips .p-chip.agent');
const nodeLabelled = (page: Page, label: string) => page.locator('#world g.node', { hasText: label });

test('linking alone exposes nothing; a grant puts the agent\'s drawing live in every tab, for that agent only', async ({ account, stack }) => {
  test.setTimeout(90_000);
  const token = stack.accountToken();
  const owner = await account(token);
  const B = await newBoard(owner, stack, 'api');
  const agent = await linkedAgent(stack, token);
  const second = await linkedAgent(stack, token);

  // Linked but not granted: no write, and no read (set_selection is the read probe).
  await expect(createNode(stack, agent.token, B, 'agent-node')).rejects.toThrow(UNAVAILABLE);
  await expect(stack.callReducer(agent.token, 'set_selection', [B, []])).rejects.toThrow(UNAVAILABLE);
  await expect(owner.locator('#world')).toContainText('api');
  await expect(owner.locator('#world g.node')).toHaveCount(1);
  await owner.reload();
  await expect(owner.locator('#world')).toContainText('api');
  await expect(owner.locator('#world g.node')).toHaveCount(1);

  const tab2 = await owner.context().newPage();
  await openBoard(tab2, owner.url());
  const editor = await account();
  await openBoard(editor, await shareBoard(owner, 'edit'));
  await expect(editor.locator('#world')).toContainText('api');
  await stack.callReducer(token, 'grant_agent_board', [B, idOf(agent.identity)]); // the dashboard's action
  await createNode(stack, agent.token, B, 'agent-node');
  for (const page of [owner, tab2, editor]) await expect(page.locator('#world')).toContainText('agent-node');
  await owner.reload();
  await expect(owner.locator('#world')).toContainText('agent-node');
  await expect(owner.locator('#world g.node')).toHaveCount(2);

  // The grant is per agent: the person's other agent still gets nothing.
  await expect(createNode(stack, second.token, B, 'second-node')).rejects.toThrow(UNAVAILABLE);
  for (const page of [owner, tab2, editor]) {
    await expect(page.locator('#world')).toContainText('agent-node');
    await expect(nodeLabelled(page, 'second-node')).toHaveCount(0);
  }
});

test('a grant is not ownership; only the owner grants, and only to their own agent', async ({ account, stack }) => {
  const tokenA = stack.accountToken();
  const owner = await account(tokenA);
  const B = await newBoard(owner, stack, 'api');
  const agent = await linkedAgent(stack, tokenA, B);
  const rule = (verb: string) => `share rule: only an owner of board ${B} can ${verb} it`;

  await expect(stack.callReducer(agent.token, 'rename_board', [B, 'taken'])).rejects.toThrow(rule('rename'));
  await expect(stack.callReducer(agent.token, 'delete_board', [B])).rejects.toThrow(rule('delete'));
  await expect(stack.callReducer(agent.token, 'set_link_share', [B, 'view', shareToken()])).rejects.toThrow(rule('share'));
  await expect(stack.callReducer(agent.token, 'grant_agent_board', [B, idOf(agent.identity)])).rejects.toThrow(rule('share'));
  await expect(stack.callReducer(agent.token, 'revoke_agent_board', [B, idOf(agent.identity)])).rejects.toThrow(rule('unshare'));

  const tokenB = stack.accountToken();
  const agentB = await linkedAgent(stack, tokenB);
  const stranger = await stack.mintIdentity();
  const unlinked = await stack.mintIdentity();
  await expect(stack.callReducer(tokenB, 'grant_agent_board', [B, idOf(agentB.identity)])).rejects.toThrow(rule('share'));
  await expect(stack.callReducer(stranger.token, 'grant_agent_board', [B, idOf(agentB.identity)])).rejects.toThrow(rule('share'));
  await expect(stack.callReducer(tokenA, 'grant_agent_board', [B, idOf(agentB.identity)])).rejects.toThrow(/share rule: agent \w+ is not linked to you/);
  await expect(stack.callReducer(tokenA, 'grant_agent_board', [B, idOf(unlinked.identity)])).rejects.toThrow(/share rule: agent \w+ is not linked to you/);
  await expect(createNode(stack, agentB.token, B, 'agentB-node')).rejects.toThrow(UNAVAILABLE);

  await expect(owner.locator('#board-title')).toContainText('Untitled board');
  await expect(owner.locator('#board-title')).not.toContainText('taken');
  await expect(owner.locator('#access-line')).toHaveText('private');
  await expect(owner.locator('#world')).toContainText('api');
  await expect(owner.locator('#world g.node')).toHaveCount(1);
  expect(await stack.sql(`SELECT id FROM board WHERE id = ${B}`)).toHaveLength(1);
  expect((await stack.sql(`SELECT agent FROM agent_grant WHERE board_id = ${B}`)).map(row => hexOf(row.agent))).toEqual([agent.identity]);
});

test('revoke and unlink end a grant but never ownership; an edit link outlives both', async ({ account, stack }) => {
  test.setTimeout(90_000);
  const token = stack.accountToken();
  const owner = await account(token);
  const B = await newBoard(owner, stack, 'api');
  const ownerHex = await owner.evaluate(() => (window as any).myIdentityHex as string);
  const editorToken = stack.accountToken();
  const editor = await account(editorToken);
  await openBoard(editor, await shareBoard(owner, 'edit'));
  await expect(editor.locator('#world')).toContainText('api');
  const agent = await linkedAgent(stack, token, B);
  await createNode(stack, agent.token, B, 'agent-node');
  await expect(owner.locator('#world')).toContainText('agent-node');

  await stack.callReducer(token, 'revoke_agent_board', [B, idOf(agent.identity)]);
  await expect(createNode(stack, agent.token, B, 'late')).rejects.toThrow(UNAVAILABLE);
  await expect(owner.locator('#world')).toContainText('agent-node');
  await expect(nodeLabelled(owner, 'late')).toHaveCount(0);
  await expect(owner.locator('#act-share')).toBeVisible();
  await drawNode(editor, 'editor-node');
  await expect(owner.locator('#world')).toContainText('editor-node');

  // Unlink ends every grant, also on a board the agent made, which stays the person's.
  await stack.callReducer(token, 'grant_agent_board', [B, idOf(agent.identity)]);
  const name = unique('Agent made');
  await stack.callReducer(agent.token, 'create_board', [name]);
  const made = await boardNamed(stack, name);
  const tab2 = await owner.context().newPage();
  await openBoard(tab2, `${stack.url}#b=${made.slug}`);
  await expect(tab2.locator('#board-title')).toContainText(name);
  await stack.callReducer(token, 'unlink_agent', [idOf(agent.identity)]);
  await expect(createNode(stack, agent.token, B, 'after unlink')).rejects.toThrow(UNAVAILABLE);
  await expect(createNode(stack, agent.token, made.id, 'after unlink')).rejects.toThrow(UNAVAILABLE);
  await expect(tab2.locator('#act-share')).toBeVisible();
  await expect(tab2.locator('#access-line')).toHaveText('private');
  await tab2.reload();
  await expect(tab2.locator('#board-title')).toContainText(name);
  await expect(tab2.locator('#act-share')).toBeVisible();
  await expect(owner.locator('#world')).toContainText('agent-node');
  const owned = await stack.sql(`SELECT board_id FROM board_grant WHERE grantee = 0x${ownerHex} AND role = 'owner'`);
  expect(owned.map(row => Number(row.board_id))).toEqual(expect.arrayContaining([B, made.id]));
  // The edit link still writes after the unlink, live in the owner's tab.
  await createNode(stack, editorToken, B, 'editor-after-unlink');
  await expect(owner.locator('#world')).toContainText('editor-after-unlink');

  // Linking again revives no grant.
  await link(stack, agent, token);
  await expect(createNode(stack, agent.token, B, 'after relink')).rejects.toThrow(UNAVAILABLE);
  await expect(createNode(stack, agent.token, made.id, 'after relink')).rejects.toThrow(UNAVAILABLE);
  expect(await stack.sql(`SELECT id FROM agent_grant WHERE agent = 0x${agent.identity}`)).toEqual([]);
});

test('a granted agent keeps editing through a downgrade and a stopped link, while link visitors lose access', async ({ account, stack }) => {
  test.setTimeout(90_000);
  const token = stack.accountToken();
  const owner = await account(token);
  const B = await newBoard(owner, stack, 'api');
  const tab2 = await owner.context().newPage();
  await openBoard(tab2, owner.url());
  const link = await shareBoard(owner, 'edit');
  const editorToken = stack.accountToken();
  const editor = await account(editorToken);
  await openBoard(editor, link);
  await expect(editor.locator('#world')).toContainText('api');
  const agent = await linkedAgent(stack, token, B);

  await owner.getByRole('button', { name: 'Can view', exact: true }).click();
  await expect(editor.locator('#board-title')).toContainText('view only');
  await expect(createNode(stack, editorToken, B, 'editor after downgrade')).rejects.toThrow(READ_ONLY);
  await createNode(stack, agent.token, B, 'after-view');
  for (const page of [owner, tab2]) await expect(page.locator('#world')).toContainText('after-view');

  await owner.getByRole('switch', { name: 'Share with link' }).uncheck();
  await expect(editor.getByText('This link is no longer shared.', { exact: false })).toBeVisible();
  await expect(createNode(stack, editorToken, B, 'editor after stop')).rejects.toThrow(UNAVAILABLE);
  await stack.callReducer(agent.token, 'set_selection', [B, []]); // the agent still reads
  await createNode(stack, agent.token, B, 'after-stop');
  for (const page of [owner, tab2]) await expect(page.locator('#world')).toContainText('after-stop');
  await expect(owner.locator('#world g.node')).toHaveCount(3);
});

test('a person\'s link visit or forwarded link gives their agent no edit rights', async ({ account, stack }) => {
  test.setTimeout(90_000);
  const tokenA = stack.accountToken();
  const owner = await account(tokenA);
  const B = await newBoard(owner, stack, 'A-node');
  const link = await shareBoard(owner, 'edit');
  const s = new URLSearchParams(new URL(link).hash.slice(1)).get('s')!;
  const tokenB = stack.accountToken();
  const recipient = await account(tokenB);
  await openBoard(recipient, link);
  await drawNode(recipient, 'B-node');
  await expect(owner.locator('#world')).toContainText('B-node');
  const agentB = await linkedAgent(stack, tokenB);

  // B's visit gives B's agent nothing, and B cannot grant it the board.
  await expect(stack.callReducer(agentB.token, 'set_selection', [B, []])).rejects.toThrow(UNAVAILABLE);
  await expect(createNode(stack, agentB.token, B, 'agent edit')).rejects.toThrow(UNAVAILABLE);
  await expect(stack.callReducer(tokenB, 'grant_agent_board', [B, idOf(agentB.identity)])).rejects.toThrow(`share rule: only an owner of board ${B} can share it`);

  // Forwarded, the link lets an agent read but never write, in either mode.
  await stack.callReducer(agentB.token, 'open_shared_link', [s]);
  await stack.callReducer(agentB.token, 'set_selection', [B, []]);
  await expect(createNode(stack, agentB.token, B, 'agent edit')).rejects.toThrow(READ_ONLY);
  const bot = await stack.mintIdentity();
  await stack.callReducer(bot.token, 'join_board', ['bot', 'agent']);
  await stack.callReducer(bot.token, 'open_shared_link', [s]);
  await expect(createNode(stack, bot.token, B, 'bot edit')).rejects.toThrow(READ_ONLY);
  const view = owner.getByRole('button', { name: 'Can view', exact: true });
  await view.click();
  await expect(view).toHaveAttribute('aria-pressed', 'true');
  await expect(createNode(stack, agentB.token, B, 'agent edit')).rejects.toThrow(READ_ONLY);
  await expect(createNode(stack, bot.token, B, 'bot edit')).rejects.toThrow(READ_ONLY);

  await expect(owner.locator('#world')).toContainText('B-node');
  await expect(owner.locator('#world g.node')).toHaveCount(2);
  await expect(nodeLabelled(owner, 'edit')).toHaveCount(0);
});

test('a linked agent\'s new board is its person\'s: owner controls for the person, edits but no sharing for the agent', async ({ account, stack }) => {
  const token = stack.accountToken();
  const agent = await linkedAgent(stack, token);
  const name = unique('Agent made');
  await stack.callReducer(agent.token, 'create_board', [name]);
  const made = await boardNamed(stack, name);
  const owner = await account(token);
  await openBoard(owner, `${stack.url}#b=${made.slug}`);
  await expect(owner.locator('#board-title')).toContainText(name);
  await expect(owner.locator('#act-share')).toBeVisible();
  await expect(owner.locator('#access-line')).toHaveText('private');
  const ownerHex = await owner.evaluate(() => (window as any).myIdentityHex as string);
  expect((await stack.sql(`SELECT grantee FROM board_grant WHERE board_id = ${made.id} AND role = 'owner'`)).map(row => hexOf(row.grantee))).toEqual([ownerHex]);

  await owner.keyboard.press('ControlOrMeta+k');
  await expect(owner.locator('#palette-input')).toBeFocused();
  await owner.locator('#palette-input').fill('board');
  await expect(owner.locator('#palette-list')).toContainText('Rename board');
  await expect(owner.locator('#palette-list')).toContainText('Delete this board');
  await owner.keyboard.press('Escape');

  await createNode(stack, agent.token, made.id, 'agent-node');
  await expect(owner.locator('#world')).toContainText('agent-node');
  await expect(stack.callReducer(agent.token, 'set_link_share', [made.id, 'view', shareToken()])).rejects.toThrow(`share rule: only an owner of board ${made.id} can share it`);
  expect(await shareBoard(owner, 'view')).toContain('#s=');
});

test('an unlinked agent owns and shares its board until the link moves it to the person, and its link keeps working', async ({ account, guest, stack }) => {
  test.setTimeout(90_000);
  const token = stack.accountToken();
  const legacy = await stack.mintIdentity();
  const name = unique('Legacy');
  await stack.callReducer(legacy.token, 'create_board', [name]);
  const board = await boardNamed(stack, name);
  await createNode(stack, legacy.token, board.id, 'legacy-node');
  const tok = shareToken();
  await stack.callReducer(legacy.token, 'set_link_share', [board.id, 'view', tok]);
  const visitor = await guest();
  await openBoard(visitor, `${stack.url}#s=${tok}`);
  await expect(visitor.locator('#world')).toContainText('legacy-node');

  const owner = await account(token);
  await owner.goto(`${stack.url}#b=${board.slug}`);
  await expect(owner.getByRole('heading', { name: 'This board is unavailable' })).toBeVisible();
  await expect(createNode(stack, token, board.id, 'person-node')).rejects.toThrow(UNAVAILABLE);
  const ownerOf = async () => (await stack.sql(`SELECT grantee FROM board_grant WHERE board_id = ${board.id} AND role = 'owner'`)).map(row => hexOf(row.grantee));
  expect(await ownerOf()).toEqual([legacy.identity]);

  await link(stack, legacy, token);
  await owner.reload();
  await expect(owner.locator('#canvas-wrap')).toHaveAttribute('aria-busy', 'false');
  await expect(owner.locator('#world')).toContainText('legacy-node');
  expect(await ownerOf()).toEqual([await owner.evaluate(() => (window as any).myIdentityHex as string)]);
  await expect(owner.locator('#act-share')).toBeVisible();
  await owner.locator('#act-share').click();
  await expect(owner.locator('#share-url')).toHaveValue(new RegExp(`#s=${tok}`));
  await createNode(stack, legacy.token, board.id, 'after-link');
  await expect(owner.locator('#world')).toContainText('after-link');
  await visitor.reload();
  await expect(visitor.locator('#world')).toContainText('after-link');
});

test('the service grant opens a person\'s own board by slug, id or all-digit slug, never another\'s', async ({ account, stack }) => {
  test.setTimeout(120_000);
  const svc = await stack.serviceIdentity('e2e-hosted');
  const token = stack.accountToken();
  const owner = await account(token);
  const ids: number[] = [];
  for (const label of ['one', 'two', 'three']) ids.push(await newBoard(owner, stack, label));
  const person = idOf(await owner.evaluate(() => (window as any).myIdentityHex as string));
  const agent = await stack.mintIdentity();
  const agentId = idOf(agent.identity);
  await stack.callReducer(svc.token, 'link_hosted_agent', [agentId, person]);
  await expect(createNode(stack, agent.token, ids[0], 'too early')).rejects.toThrow(UNAVAILABLE);

  const digits = '12345678901234567890';
  await stack.sql(`UPDATE board SET slug = '${digits}' WHERE id = ${ids[2]}`);
  const [{ slug }] = await stack.sql(`SELECT slug FROM board WHERE id = ${ids[0]}`);
  const locators = [String(slug), String(ids[1]), digits];
  const labels = ['by-slug', 'by-id', 'by-digits'];
  for (const [i, id] of ids.entries()) {
    await openBoard(owner, await boardLink(stack, id));
    await stack.callReducer(svc.token, 'grant_hosted_agent_board', [agentId, person, locators[i]]);
    await createNode(stack, agent.token, id, labels[i]);
    await expect(owner.locator('#world')).toContainText(labels[i]);
  }

  const theirToken = stack.accountToken();
  const theirName = unique('Not yours');
  await stack.callReducer(theirToken, 'create_board', [theirName]);
  const theirs = await boardNamed(stack, theirName);
  for (const locator of [theirs.slug, String(theirs.id)]) {
    await expect(stack.callReducer(svc.token, 'grant_hosted_agent_board', [agentId, person, locator])).rejects.toThrow(UNAVAILABLE);
  }
  expect(await stack.sql(`SELECT id FROM agent_grant WHERE board_id = ${theirs.id}`)).toEqual([]);
  await expect(createNode(stack, agent.token, theirs.id, 'not yours')).rejects.toThrow(UNAVAILABLE);

  // A relink to the same person keeps the grants; one to another person drops them.
  await stack.callReducer(svc.token, 'link_hosted_agent', [agentId, person]);
  await createNode(stack, agent.token, ids[2], 'relinked');
  await expect(owner.locator('#world')).toContainText('relinked');
  const [{ grantee }] = await stack.sql(`SELECT grantee FROM board_grant WHERE board_id = ${theirs.id} AND role = 'owner'`);
  await stack.callReducer(svc.token, 'link_hosted_agent', [agentId, idOf(hexOf(grantee))]);
  await expect(createNode(stack, agent.token, ids[2], 'after move')).rejects.toThrow(UNAVAILABLE);
  await expect(createNode(stack, agent.token, ids[0], 'after move')).rejects.toThrow(UNAVAILABLE);
  for (const id of ids) expect(await stack.sql(`SELECT id FROM agent_grant WHERE board_id = ${id}`)).toEqual([]);
  await expect(owner.locator('#world g.node')).toHaveCount(3);
});

test('an agent shows as a bot chip in every open tab, and its popover row never says joined', async ({ account, stack }) => {
  test.setTimeout(90_000);
  const owner = await account();
  const B = await newBoard(owner, stack, 'api');
  const apiId = await firstNodeId(owner);
  const editor = await account();
  await openBoard(editor, await shareBoard(owner, 'edit'));
  await expect(editor.locator('#world')).toContainText('api');
  const agent = await presentAgent(stack);
  const [{ x, y }] = await stack.sql(`SELECT x, y FROM node WHERE id = ${apiId}`);
  await stack.callReducer(agent.token, 'set_selection', [B, [apiId]]);
  await stack.callReducer(agent.token, 'update_cursor', [B, Number(x) + 10, Number(y) + 10]);

  for (const page of [owner, editor]) {
    await expect(agentChip(page)).toHaveAttribute('aria-label', `${AGENT}, active now`);
    await expect(agentChip(page).locator('svg[viewBox="0 0 16 16"]')).toHaveCount(1);
    await expect(agentChip(page)).toHaveText('');
  }
  await expect(owner.locator('#presence > rect')).toHaveCount(1);
  await expect(owner.locator('#presence > g text')).toHaveText(AGENT);
  // The editor selects the same node: its outline and cursor match the agent's but for colour.
  await editor.locator('#world g.node', { hasText: 'api' }).click();
  await expect(owner.locator('#presence > rect')).toHaveCount(2);
  await expect(owner.locator('#presence > g text')).toHaveCount(2);
  const drawn = (selector: string, skip: string[]) => owner.locator(selector).evaluateAll((els, skip) =>
    els.map(e => e.getAttributeNames().filter(n => !skip.includes(n)).map(n => `${n}=${e.getAttribute(n)}`).join(' ')), skip);
  const outlines = await drawn('#presence > rect', ['stroke']);
  expect(outlines[0]).toContain('stroke-dasharray=2 3');
  expect(outlines[1]).toBe(outlines[0]);
  const arrows = await drawn('#presence > g > path', ['fill']);
  expect(arrows[1]).toBe(arrows[0]);

  await owner.locator('#participants-label').click();
  const status = owner.locator('#presence-pop .pp-row.agent .pp-status');
  await expect(status).toHaveText('selecting api');
  await stack.callReducer(agent.token, 'set_selection', [B, []]);
  await expect(status).toHaveText('active now');
  await expect(owner.locator('#presence-pop .pp-row.agent')).not.toContainText('joined');
  await expect(owner.locator('#presence > rect')).toHaveCount(1); // the editor's
  await expect(owner.locator('#presence-pop .pp-row:not(.agent) .pp-status').first()).toContainText(/joined .* ago/);
});

test('an agent on an empty board says it is here; an empty session board waits for the agent', async ({ account, stack }) => {
  test.setTimeout(90_000);
  const token = stack.accountToken();
  const name = unique('Empty');
  await stack.callReducer(token, 'create_board', [name]);
  const board = await boardNamed(stack, name);
  const owner = await account(token);
  await openBoard(owner, await boardLink(stack, board.id));
  const empty = owner.locator('#empty-state');
  await expect(empty).toHaveAttribute('data-mode', 'board');
  await expect(empty.getByText('Start with your first node.')).toBeVisible();
  await expect(empty.getByText('Click to place.', { exact: false })).toBeVisible();
  await expect(owner.locator('#empty-orb')).toBeHidden();

  const agent = await presentAgent(stack);
  await stack.callReducer(agent.token, 'set_selection', [board.id, []]);
  await expect(empty).toHaveAttribute('data-mode', 'agent');
  await expect(owner.locator('#empty-agent')).toHaveText(`${AGENT} is here. Nothing drawn yet.`);
  await expect(owner.locator('#empty-orb')).toBeVisible();
  // The board-only parts go. This build has no MCP URL, so #empty-connect is never rendered here.
  await expect(empty.getByText('Start with your first node.')).toBeHidden();
  await expect(empty.getByText('Click to place.', { exact: false })).toBeHidden();
  await expect(agentChip(owner)).toBeVisible();
  await drawNode(owner, 'First');
  await expect(empty).toBeHidden();

  // A session board with no agent present waits for its first checkpoint.
  const sessionAgent = await linkedAgent(stack, token);
  const sessionName = unique('e2e-session');
  await stack.callReducer(sessionAgent.token, 'start_session', [sessionName, '/tmp/e2e-repo', '0'.repeat(40)]);
  const session = await boardNamed(stack, sessionName);
  await openBoard(owner, await boardLink(stack, session.id));
  await expect(empty).toHaveAttribute('data-mode', 'session');
  await expect(empty.getByText('Waiting for the agent to draw')).toBeVisible();
  await expect(empty.getByText('The board fills in at each checkpoint.')).toBeVisible();
  await expect(owner.locator('#empty-orb')).toBeVisible();
  await expect(empty.getByText('Start with your first node.')).toBeHidden();
  // A linked agent's session board is its person's (D6).
  const ownerHex = await owner.evaluate(() => (window as any).myIdentityHex as string);
  expect((await stack.sql(`SELECT grantee FROM board_grant WHERE board_id = ${session.id} AND role = 'owner'`)).map(row => hexOf(row.grantee))).toEqual([ownerHex]);
  await createNode(stack, sessionAgent.token, session.id, 'agent-first');
  await expect(owner.locator('#world')).toContainText('agent-first');
  await expect(empty).toBeHidden();
});

test('an agent selecting on another board stays off this one until that board is open', async ({ account, stack }) => {
  const token = stack.accountToken();
  const owner = await account(token);
  const A = await newBoard(owner, stack, 'alpha');
  const B = await newBoard(owner, stack, 'beta');
  const urlB = owner.url();
  const betaId = await firstNodeId(owner);
  const agent = await presentAgent(stack, await linkedAgent(stack, token, B));
  await stack.callReducer(agent.token, 'set_selection', [B, [betaId]]);

  await openBoard(owner, await boardLink(stack, A));
  await expect(owner.locator('#world')).toContainText('alpha');
  // Its participant and selection rows are here (the Connect dialog names the agent's board), but not on this board.
  await expect.poll(() => clientHas(owner, agent.identity)).toEqual({ participant: true, selection: true });
  await expect(owner.locator('#participant-chips .p-chip')).toHaveCount(1); // the owner's own
  await expect(agentChip(owner)).toHaveCount(0);
  await expect(owner.locator('#presence > rect')).toHaveCount(0);

  await owner.evaluate(href => { history.pushState(null, '', href); dispatchEvent(new PopStateEvent('popstate')); }, urlB);
  await expect(owner.locator('#world')).toContainText('beta');
  await expect(agentChip(owner)).toHaveAttribute('aria-label', `${AGENT}, active now`);
  await expect(owner.locator('#presence > rect')).toHaveCount(1);
});

test('an idle agent dims after 2 minutes and leaves after 30', async ({ account, stack }) => {
  test.setTimeout(90_000);
  const owner = await account();
  await owner.clock.install();
  const B = await newBoard(owner, stack, 'api');
  const agent = await presentAgent(stack);
  await stack.callReducer(agent.token, 'set_selection', [B, [await firstNodeId(owner)]]);
  await expect(agentChip(owner)).toHaveAttribute('aria-label', `${AGENT}, active now`);
  await expect(owner.locator('#presence > rect')).toHaveCount(1);

  // The canvas re-renders presence every 30 s; fastForward fires that timer.
  await owner.clock.fastForward('01:30');
  await expect(owner.locator('#participant-chips .p-chip.agent:not(.idle)')).toHaveAttribute('aria-label', `${AGENT}, active now`);
  await owner.clock.fastForward('03:30');
  await expect(owner.locator('#participant-chips .p-chip.agent.idle')).toHaveAttribute('aria-label', `${AGENT}, idle · active 5m ago`);
  await owner.locator('#participants-label').click();
  await expect(owner.locator('#presence-pop .pp-row.agent.idle .pp-status')).toHaveText('idle · active 5m ago');
  await expect(owner.locator('#presence-pop .pp-row.agent')).not.toContainText('joined');

  await owner.clock.fastForward('26:30');
  await expect(agentChip(owner)).toHaveCount(0);
  await expect(owner.locator('#participant-chips .p-chip')).toHaveCount(1); // the owner's own
  await expect(owner.locator('#presence > rect')).toHaveCount(0);
  await expect(owner.locator('#world')).toContainText('api');
  // Gone by the client's clock alone: the rows are still there.
  expect(await stack.sql(`SELECT * FROM selection WHERE identity = 0x${agent.identity}`)).toHaveLength(1);
  expect(await clientHas(owner, agent.identity)).toEqual({ participant: true, selection: true });
});
