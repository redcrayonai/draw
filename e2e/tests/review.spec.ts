import { randomBytes } from 'node:crypto';
import type { Browser, Page } from '@playwright/test';
import { test, expect, openBoard, shareBoard, linkedAgent, boardWith, armCrayon, send, pill, loops } from '../fixtures';
import type { withStack } from '../stack';

// Red crayon review (spec 2026-10-19). The agent side calls the module reducers as a
// database-minted agent identity, as scripts/verify-marks-local.mjs does; no MCP Worker here.
type Stack = Parameters<Parameters<typeof withStack>[0]>[0];
type MarkRow = { id: number; node_id: number; node_label: string; note: string; round: number; status: string; claimed_by: string; claim_gen: number };

const AGENT = 'e2e-agent'; // linkedAgent's display name
const NONE = { none: [] };

/** An account page whose token the test also uses for reducer calls. */
async function ownerPage(browser: Browser, token: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(value => { Object.assign(window, { __e2eAccountToken: value }); }, token);
  return context.newPage();
}

const seat = () => randomBytes(8).toString('hex'); // 16 characters, like start_session's
const marksOn = async (stack: Stack, B: number) =>
  (await stack.sql(`SELECT * FROM mark WHERE board_id = ${B}`) as MarkRow[]).sort((a, b) => a.id - b.id);
const nodeRect = (page: Page, id: number) => page.locator(`#world g[data-id="${id}"] .node-rect`);
/** Inside the node, clear of its centred label (a short label would take the click). */
const clickNode = (page: Page, id: number) => nodeRect(page, id).click({ position: { x: 12, y: 12 } });

/** Circle a node with the crayon up and close its note bubble without a note. */
async function circle(page: Page, id: number) {
  await clickNode(page, id);
  const note = page.locator('.mark-note textarea');
  await expect(note).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('.mark-note')).toBeHidden();
}

test('mark and send: two circles, one typed note, one round in the database', async ({ browser, stack }) => {
  const token = stack.accountToken();
  const page = await ownerPage(browser, token);
  const { B, ids: [api, db] } = await boardWith(page, stack, ['api', 'db']);
  await armCrayon(page);
  await clickNode(page, api);
  await expect(page.locator('.mark-note textarea')).toBeFocused();
  await page.keyboard.type('retry here');
  await page.keyboard.press('Enter');
  await circle(page, db);
  await expect(loops(page)).toHaveCount(2);
  await send(page, 2);
  await expect.poll(async () => (await marksOn(stack, B)).map(m => [m.node_id, m.node_label, m.note, m.status, m.round])).toEqual([
    [api, 'api', 'retry here', 'sent', 1],
    [db, 'db', '', 'sent', 1],
  ]);
});

test('taking circles back: undo, re-click, chip + Delete, the bubble trash', async ({ browser, stack }) => {
  const token = stack.accountToken();
  const page = await ownerPage(browser, token);
  const { B, ids: [a, b, c] } = await boardWith(page, stack, ['alpha', 'beta', 'gamma']);
  await armCrayon(page);
  for (const id of [a, b, c]) await circle(page, id);
  await expect(pill(page)).toHaveText('Send 3 marks');
  await page.keyboard.press('ControlOrMeta+z'); // interactions.ts binds metaKey || ctrlKey
  await expect(pill(page)).toHaveText('Send 2 marks');
  await expect(page.locator(`#crayon .mark[data-node-id="${c}"]`)).toHaveCount(0);
  await expect(page.locator('#world g.node')).toHaveCount(3); // ⌘Z took the circle, not a board edit
  await clickNode(page, b);
  await expect(pill(page)).toHaveText('Send 1 mark');
  await circle(page, b);
  await circle(page, c);
  await expect(pill(page)).toHaveText('Send 3 marks');

  await page.keyboard.press('c'); // put the crayon down: the select tool picks marks by their chip
  await expect(page.locator('#tool-crayon')).not.toHaveClass(/armed/);
  await page.locator(`#crayon .mark[data-node-id="${a}"] .mark-chip`).click();
  await expect(page.locator(`#crayon .mark[data-node-id="${a}"]`)).toHaveClass(/selected/);
  await page.keyboard.press('Delete');
  await expect(pill(page)).toHaveText('Send 2 marks');
  await expect(page.locator('#world g.node')).toHaveCount(3); // Delete removed the mark, not the node

  await page.locator(`#crayon .mark[data-node-id="${b}"] .mark-chip`).click();
  await page.getByRole('button', { name: 'Remove mark 1', exact: true }).click();
  await expect(pill(page)).toHaveText('Send 1 mark');
  await expect(loops(page)).toHaveCount(1);
  await expect(page.locator(`#crayon .mark[data-node-id="${c}"] .mark-chip text`)).toHaveText('1');
  expect(await marksOn(stack, B)).toEqual([]); // drafts never reach the database
});

test('cap: a 21st circle in one round is refused', async ({ browser, stack }) => {
  test.setTimeout(90_000);
  const token = stack.accountToken();
  const page = await ownerPage(browser, token);
  const { B, ids: [first] } = await boardWith(page, stack, ['n0']);
  // createNode: boardId, label, sublabel, x, y, w, h, token, focal, kind, doc, imported, shape, color, strokeStyle, size
  for (let i = 1; i <= 20; i++) {
    await stack.callReducer(token, 'create_node', [B, `n${i}`, '', 300 + (i % 7) * 220, 600 + Math.floor(i / 7) * 152, 160, 80, 'ink', false, NONE, NONE, NONE, NONE, NONE, NONE, NONE]);
  }
  await expect(page.locator('#world g.node')).toHaveCount(21);
  await page.keyboard.press('Shift+Digit1'); // fit the board
  const ids = await page.locator('#world g.node').evaluateAll(nodes => nodes.map(node => Number(node.getAttribute('data-id'))));
  expect(ids).toContain(first);
  await armCrayon(page);
  for (const id of ids.slice(0, 20)) await circle(page, id);
  await expect(pill(page)).toHaveText('Send 20 marks');
  await clickNode(page, ids[20]);
  await expect(page.locator('#error-text')).toHaveText('20 marks at most in one round; send these first');
  await expect(pill(page)).toHaveText('Send 20 marks');
  await expect(loops(page)).toHaveCount(20);
});

test('agent lifecycle: no listener, claimed, answered, badge read and kept read', async ({ browser, stack }) => {
  test.setTimeout(90_000);
  const token = stack.accountToken();
  const page = await ownerPage(browser, token);
  const { B, ids: [api, db] } = await boardWith(page, stack, ['api', 'db']);
  const banner = page.locator('#mark-banner');
  const badge = page.locator('#review-badge');
  const pop = page.locator('#review-pop');
  await armCrayon(page);
  await circle(page, api);
  await circle(page, db);
  await send(page, 2);
  await expect(page.locator('#error-text')).toHaveText('Sent. No agent is listening — ask your agent to review your marks.');
  await expect(banner).toHaveText('No agent listening');

  const agent = await linkedAgent(stack, token, B);
  const mine = seat();
  await stack.callReducer(agent.token, 'claim_marks', [B, mine]);
  await expect(banner).toHaveText('Working on 2 marks');
  await page.locator('#act-review').click();
  await expect(pop.locator('.mark-row.claimed')).toHaveCount(2);
  for (const row of await pop.locator('.mark-row').all()) await expect(row).toContainText(new RegExp(`claimed by (${AGENT}|an agent)`));
  await page.locator('#act-review').click();
  await expect(pop).toBeHidden();

  const [m1, m2] = await marksOn(stack, B);
  await stack.callReducer(agent.token, 'reply_mark', [m1.id, mine, m1.claim_gen, 'fixed', 'Added the retry.', ['api/retry.ts', 'api/client.ts']]);
  await stack.callReducer(agent.token, 'reply_mark', [m2.id, mine, m2.claim_gen, 'kept', 'The index already exists.', []]);
  await expect(badge).toBeVisible();
  await expect(badge).toHaveText('2');
  await expect(page.locator('#act-review')).toHaveAttribute('aria-label', 'Review, 2 unread');

  await page.locator('#act-review').click();
  await expect(pop.locator('.mark-row')).toHaveCount(2);
  await expect(pop.locator('.mark-row.fixed')).toContainText('Added the retry.');
  await expect(pop.locator('.mark-row.fixed .mr-files')).toHaveText('api/retry.ts · api/client.ts');
  await expect(pop.locator('.mark-row.kept')).toContainText('The index already exists.');
  await expect(badge).toBeHidden();

  await page.reload();
  await expect(page.locator('#canvas-wrap')).toHaveAttribute('aria-busy', 'false');
  await expect(banner).toBeVisible(); // the marks arrived
  await expect(badge).toBeHidden();
  await expect(page.locator('#act-review')).toHaveAttribute('aria-label', 'Review');

  // An agent that only waits, on a board with no marks.
  const other = await boardWith(page, stack, ['queue']);
  await stack.callReducer(token, 'grant_agent_board', [other.B, { __identity__: `0x${agent.identity}` }]);
  await stack.callReducer(agent.token, 'claim_marks', [other.B, seat()]);
  await expect(banner).toHaveText(new RegExp(`^(${AGENT}|an agent) is waiting for your marks$`));
});

test('two seats race: every mark gets exactly one owner', async ({ browser, stack }) => {
  const token = stack.accountToken();
  const page = await ownerPage(browser, token);
  const { B, ids } = await boardWith(page, stack, ['web', 'api', 'db']);
  const agent = await linkedAgent(stack, token, B);
  await armCrayon(page);
  for (const id of ids) await circle(page, id);
  await send(page, 3);
  await expect.poll(async () => (await marksOn(stack, B)).length).toBe(3);
  const first = seat(), second = seat();
  await Promise.all([
    stack.callReducer(agent.token, 'claim_marks', [B, first]),
    stack.callReducer(agent.token, 'claim_marks', [B, second]),
  ]);
  const rows = await marksOn(stack, B);
  const owners = new Set(rows.map(m => m.claimed_by));
  expect(rows.map(m => m.status)).toEqual(['claimed', 'claimed', 'claimed']);
  expect(owners.size).toBe(1); // one transaction took all three; the other seat found none open
  expect([`${agent.identity}/${first}`, `${agent.identity}/${second}`]).toContain([...owners][0]);
  await page.locator('#act-review').click();
  await expect(page.locator('#review-pop .mark-row.claimed')).toHaveCount(3);
  for (const row of await page.locator('#review-pop .mark-row').all()) await expect(row).toContainText('claimed by');
});

test('permissions: view link sees nothing, edit-link account marks, guest must sign in', async ({ browser, guest, account, stack }) => {
  test.setTimeout(90_000);
  const token = stack.accountToken();
  const page = await ownerPage(browser, token);
  const { B, ids: [api, db] } = await boardWith(page, stack, ['api', 'db']);
  await armCrayon(page);
  await circle(page, api);
  await send(page, 1);
  await expect(page.locator('#mark-banner')).toHaveText('No agent listening');

  const viewLink = await shareBoard(page, 'view');
  const viewer = await account();
  await openBoard(viewer, viewLink);
  await expect(viewer.locator('#world')).toContainText('api');
  await expect(viewer.locator('#tool-crayon')).toBeDisabled();
  await expect(viewer.locator('#act-review')).toBeHidden();
  await viewer.keyboard.press('c');
  await expect(viewer.locator('#tool-crayon')).not.toHaveClass(/armed/);
  await expect(viewer.locator('#mark-banner')).toBeHidden(); // the round the owner sent never reaches this reader

  // The same link, switched to edit in the still-open Share menu.
  const canEdit = page.getByRole('button', { name: 'Can edit', exact: true });
  await canEdit.click();
  await expect(canEdit).toHaveAttribute('aria-pressed', 'true');
  const editLink = await page.locator('#share-url').inputValue();
  const editor = await account();
  await openBoard(editor, editLink);
  await expect(editor.locator('#act-review')).toBeVisible();
  await armCrayon(editor);
  await circle(editor, db);
  await send(editor, 1);
  await expect.poll(async () => (await marksOn(stack, B)).map(m => [m.node_id, m.round])).toEqual([[api, 1], [db, 2]]);

  const anon = await guest();
  await openBoard(anon, editLink);
  await expect(anon.locator('#tool-crayon')).toBeDisabled();
  await expect(anon.locator('#tool-crayon')).toHaveAttribute('title', 'Sign in to mark');
});

test('node deleted after Send: the row stays and does not pan', async ({ browser, stack }) => {
  const token = stack.accountToken();
  const page = await ownerPage(browser, token);
  const errors: Error[] = [];
  page.on('pageerror', err => errors.push(err));
  const { ids: [api] } = await boardWith(page, stack, ['api', 'db']);
  await armCrayon(page);
  await circle(page, api);
  await send(page, 1);
  await page.keyboard.press('c');
  await clickNode(page, api);
  await page.keyboard.press('Delete');
  await expect(page.locator('#world g.node')).toHaveCount(1);
  await expect(page.locator('#save-status')).toHaveText('Saved');

  await page.locator('#act-review').click();
  const row = page.locator('#review-pop .mark-row');
  await expect(row).toHaveCount(1);
  await expect(row).toHaveClass(/gone/);
  await expect(row.locator('.mr-label')).toHaveText('api');
  const before = await page.locator('#world').getAttribute('transform');
  await row.click();
  await page.waitForTimeout(400); // longer than the 200 ms reveal glide
  expect(await page.locator('#world').getAttribute('transform')).toBe(before);
  expect(errors).toEqual([]);
});

test('private drafts: another editor sees the round only after Send', async ({ browser, account, stack }) => {
  test.setTimeout(90_000);
  const token = stack.accountToken();
  const page = await ownerPage(browser, token);
  const { B, ids: [api] } = await boardWith(page, stack, ['api', 'db']);
  const editor = await account();
  await openBoard(editor, await shareBoard(page, 'edit'));
  await expect(editor.locator('#world')).toContainText('db');

  await armCrayon(page);
  await circle(page, api);
  await expect(loops(page)).toHaveCount(1);
  await page.waitForTimeout(500); // room for anything that would leak to arrive
  await expect(loops(editor)).toHaveCount(0);
  await expect(pill(editor)).toBeHidden();
  expect(await marksOn(stack, B)).toEqual([]);

  await send(page, 1);
  await editor.locator('#act-review').click();
  await expect(editor.locator('#review-pop')).toContainText('Round 1');
  await expect(editor.locator('#review-pop .mark-row')).toHaveCount(1);
  await expect(editor.locator('#review-pop .mark-row .mr-label')).toHaveText('api');
  await expect(loops(editor)).toHaveCount(0);
});
