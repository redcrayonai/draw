import { randomBytes } from 'node:crypto';
import type { Page } from '@playwright/test';
import { test, expect, openBoard, shareBoard, linkedAgent, boardWith, armCrayon, send, pill, loops, type Stack } from '../fixtures';

// Red crayon rounds beyond review.spec.ts: concurrent drafters, send guards, banner and
// history, per-person read state, agent claim rules and who receives marks (spec 2026-10-19).
// Agents call the module reducers as database-minted identities, as verify-marks-local.mjs does.
type MarkRow = { id: number; node_id: number; node_label: string; note: string; round: number; status: string; claimed_by: string; claim_gen: number; lease_until: unknown; sent_at: unknown };

const NONE = { none: [] };
const WIDE = { viewport: { width: 1440, height: 900 } };
const NO_LISTENER = 'Sent. No agent is listening — ask your agent to review your marks.';
const LEASE_MICROS = 15 * 60 * 1_000_000;

const seat = () => randomBytes(8).toString('hex'); // 16 characters, like start_session's
const micros = (v: unknown) => Number(Array.isArray(v) ? v[0] : (v as { __timestamp_micros_since_unix_epoch__: number }).__timestamp_micros_since_unix_epoch__);
const marksOn = async (stack: Stack, B: number) =>
  (await stack.sql(`SELECT * FROM mark WHERE board_id = ${B}`) as MarkRow[]).sort((a, b) => a.id - b.id);
const nodeRect = (page: Page, id: number) => page.locator(`#world g[data-id="${id}"] .node-rect`);
/** Inside the node, clear of its centred label (a short label would take the click). */
const clickNode = (page: Page, id: number) => nodeRect(page, id).click({ position: { x: 12, y: 12 } });
/** Mark rows the server sent this page (visible_mark): what the person's browser holds. */
const marksHeld = (page: Page) => page.evaluate(() => [...(window as any).conn.db.visibleMark.iter()].length as number);
/** A second agent linked to the same person, renamed agent-b. */
async function agentB(stack: Stack, token: string, B: number) {
  const agent = await linkedAgent(stack, token, B);
  await stack.callReducer(agent.token, 'join_board', ['agent-b', 'agent']);
  return agent;
}

/** Circle a node with the crayon up and close its note bubble, with an optional typed note. */
async function circle(page: Page, id: number, note = '') {
  await clickNode(page, id);
  await expect(page.locator('.mark-note textarea')).toBeFocused();
  if (note) await page.keyboard.type(note);
  await page.keyboard.press(note ? 'Enter' : 'Escape');
  await expect(page.locator('.mark-note')).toBeHidden();
}

test('two people marking at once each send only their own drafts', async ({ account, stack }) => {
  test.setTimeout(90_000);
  const token = stack.accountToken();
  const owner = await account(token, WIDE);
  const { B, ids: [api, db] } = await boardWith(owner, stack, ['api', 'db']);
  const editor = await account();
  await openBoard(editor, await shareBoard(owner, 'edit'));
  await expect(editor.locator('#world')).toContainText('db');

  await armCrayon(owner);
  await circle(owner, api);
  await armCrayon(editor);
  await circle(editor, db);
  await send(owner, 1);
  await expect.poll(async () => (await marksOn(stack, B)).map(m => [m.node_id, m.round])).toEqual([[api, 1]]);
  await expect(pill(editor)).toHaveText('Send 1 mark'); // the owner's Send took none of the editor's drafts
  await expect(editor.locator(`#crayon .mark[data-node-id="${db}"]`)).toHaveCount(1);

  await send(editor, 1);
  await expect.poll(async () => (await marksOn(stack, B)).map(m => [m.node_id, m.round])).toEqual([[api, 1], [db, 2]]);
  for (const page of [owner, editor]) { // newest first in both panels
    await page.locator('#act-review').click();
    await expect(page.locator('#review-pop .mr-round')).toHaveText([/^Round 2/, /^Round 1/]);
    await expect(page.locator('#review-pop .mark-row .mr-label')).toHaveText(['db', 'api']);
  }
});

test('a double-click on Send makes one round; a refused Send keeps the drafts; reload drops drafts', async ({ account, stack }) => {
  test.setTimeout(90_000);
  const token = stack.accountToken();
  const owner = await account(token, WIDE);
  const { B, ids: [api, db] } = await boardWith(owner, stack, ['api', 'db']);
  await armCrayon(owner);
  await circle(owner, api);
  await circle(owner, db);
  await expect(pill(owner)).toHaveText('Send 2 marks');
  await pill(owner).dblclick();
  await expect(pill(owner)).toBeHidden();
  await expect(owner.locator('#mark-banner')).toHaveText('No agent listening');
  await expect.poll(async () => (await marksOn(stack, B)).map(m => [m.node_id, m.round])).toEqual([[api, 1], [db, 1]]);

  // RV-16: drafts live in the tab only.
  await circle(owner, db);
  await expect(pill(owner)).toHaveText('Send 1 mark');
  await owner.reload();
  await expect(owner.locator('#canvas-wrap')).toHaveAttribute('aria-busy', 'false');
  await expect(owner.locator('#world')).toContainText('db');
  await expect(owner.locator('#mark-banner')).toHaveText('No agent listening'); // the sent round arrived
  await expect(pill(owner)).toBeHidden();
  await expect(loops(owner)).toHaveCount(0);
  expect((await marksOn(stack, B)).length).toBe(2);

  // RV-15: a live downgrade under an armed crayon; the module refuses the Send.
  const editorToken = stack.accountToken();
  const editor = await account(editorToken);
  await openBoard(editor, await shareBoard(owner, 'edit'));
  await armCrayon(editor);
  await circle(editor, api);
  await owner.getByRole('button', { name: 'Can view', exact: true }).click();
  await expect(editor.locator('#board-title')).toContainText('view only');
  await pill(editor).click();
  await expect(editor.locator('#error-text')).toContainText('not authorized: board is read only');
  await expect(pill(editor)).toHaveText('Send 1 mark');
  await expect(loops(editor)).toHaveCount(1);
  await expect(stack.callReducer(editorToken, 'send_marks', [B, [api], ['']])).rejects.toThrow('not authorized: board is read only');
  expect((await marksOn(stack, B)).length).toBe(2);
});

test('the banner names a waiting agent, counts down while working, and shows answered', async ({ account, stack }) => {
  test.setTimeout(90_000);
  const token = stack.accountToken();
  const page = await account(token, WIDE);
  const banner = page.locator('#mark-banner');
  const { B, ids: [api, db] } = await boardWith(page, stack, ['api', 'db']);
  await armCrayon(page);
  await circle(page, api);
  await circle(page, db);
  await send(page, 2);

  const agent = await linkedAgent(stack, token, B);
  const mine = seat();
  await stack.callReducer(agent.token, 'claim_marks', [B, mine]);
  await expect(banner).toHaveText('Working on 2 marks');
  const [m1, m2] = await marksOn(stack, B);
  await stack.callReducer(agent.token, 'reply_mark', [m1.id, mine, m1.claim_gen, 'fixed', 'Added the retry.', []]);
  await expect(banner).toHaveText('Working on 1 mark'); // RV-22
  await stack.callReducer(agent.token, 'reply_mark', [m2.id, mine, m2.claim_gen, 'kept', 'Already indexed.', []]);
  await expect(banner).toHaveText('e2e-agent is waiting for your marks'); // all answered, the agent still listens
  // RV-23: the agent stops listening.
  await stack.sql(`DELETE FROM mark_waiter WHERE board_id = ${B}`);
  await expect(banner).toHaveText('2 of 2 answered');
  await expect(banner).toHaveAttribute('data-state', 'answered');

  // RV-21: agents waiting on a board with no marks.
  const other = await boardWith(page, stack, ['queue']);
  await stack.callReducer(token, 'grant_agent_board', [other.B, { __identity__: `0x${agent.identity}` }]);
  await stack.callReducer(agent.token, 'claim_marks', [other.B, seat()]);
  await expect(banner).toHaveText('e2e-agent is waiting for your marks');
  const second = await agentB(stack, token, other.B);
  await stack.callReducer(second.token, 'claim_marks', [other.B, seat()]);
  await expect(banner).toHaveText('e2e-agent and 1 more are waiting for your marks'); // the first waiter is named
  await expect(banner).toHaveAttribute('data-state', 'waiting');
});

test('review history lists rounds newest first with notes and survives reload', async ({ account, stack }) => {
  const token = stack.accountToken();
  const page = await account(token, WIDE);
  const { ids: [api, db] } = await boardWith(page, stack, ['api', 'db']);
  await armCrayon(page);
  await circle(page, api, 'retry here');
  await send(page, 1);
  await circle(page, db, 'why?');
  await send(page, 1);

  const pop = page.locator('#review-pop');
  const check = async () => {
    await page.locator('#act-review').click();
    await expect(pop.locator('.mr-round')).toHaveCount(2);
    await expect(pop.locator('.mr-round').nth(0)).toHaveText(/^Round 2 · just now$/);
    await expect(pop.locator('.mr-round').nth(1)).toHaveText(/^Round 1 · just now$/);
    await expect(pop.locator('.review-sum')).toHaveText('round 2 · 0 answered');
    await expect(pop.locator('.mark-row .mr-label')).toHaveText(['db', 'api']);
    await expect(pop.locator('.mark-row', { has: page.locator('.mr-label', { hasText: 'api' }) }).locator('.mr-note')).toHaveText('retry here');
    await expect(pop.locator('.mark-row', { has: page.locator('.mr-label', { hasText: 'db' }) }).locator('.mr-note')).toHaveText('why?');
    await expect(pop.locator('.mark-row.sent .mr-tag')).toHaveText(['sent', 'sent']);
  };
  await check();
  await page.reload();
  await expect(page.locator('#canvas-wrap')).toHaveAttribute('aria-busy', 'false');
  await expect(pop).toBeHidden();
  await check();

  await openBoard(page, `${stack.url}?new=1`);
  await page.locator('#act-review').click();
  await expect(pop.locator('.review-empty')).toHaveText('No marks yet. Circle a node with the red crayon (C) and Send.');
  await expect(pop.locator('.mark-row')).toHaveCount(0);
});

test("an agent's reply reaches a second writer live, and each person's unread badge is their own", async ({ account, stack }) => {
  test.setTimeout(90_000);
  const token = stack.accountToken();
  const owner = await account(token, WIDE);
  const { B, ids: [api] } = await boardWith(owner, stack, ['api']);
  const editor = await account();
  await openBoard(editor, await shareBoard(owner, 'edit'));
  await expect(editor.locator('#world')).toContainText('api');
  await armCrayon(owner);
  await circle(owner, api);
  await send(owner, 1);
  await expect(editor.locator('#mark-banner')).toHaveText('No agent listening');

  const agent = await linkedAgent(stack, token, B);
  const mine = seat();
  await stack.callReducer(agent.token, 'claim_marks', [B, mine]);
  const [m] = await marksOn(stack, B);
  await stack.callReducer(agent.token, 'reply_mark', [m.id, mine, m.claim_gen, 'fixed', 'Added the retry.', ['api/retry.ts', 'api/client.ts']]);
  await expect(owner.locator('#review-badge')).toHaveText('1');
  await expect(editor.locator('#review-badge')).toHaveText('1'); // live, no reload

  await owner.locator('#act-review').click();
  await expect(owner.locator('#review-badge')).toBeHidden();
  await expect.poll(async () => (await stack.sql(`SELECT * FROM mark_read WHERE board_id = ${B}`)).length).toBe(1);
  await expect(editor.locator('#review-badge')).toHaveText('1');
  await editor.reload();
  await expect(editor.locator('#canvas-wrap')).toHaveAttribute('aria-busy', 'false');
  await expect(editor.locator('#review-badge')).toHaveText('1');

  await editor.locator('#act-review').click();
  const fixed = editor.locator('#review-pop .mark-row.fixed');
  await expect(fixed.locator('.mr-reply')).toHaveText('Added the retry.');
  await expect(fixed.locator('.mr-files')).toHaveText('api/retry.ts · api/client.ts'); // RV-24: files once answered
  await expect(editor.locator('#review-pop .review-sum')).toHaveText('round 1 · 1 answered');
  await expect(editor.locator('#review-badge')).toBeHidden();
  await expect.poll(async () => (await stack.sql(`SELECT * FROM mark_read WHERE board_id = ${B}`)).length).toBe(2);
});

test('hovering a history row lights its node and a click pans to it', async ({ account, stack }) => {
  const token = stack.accountToken();
  const page = await account(token, WIDE);
  const { ids: [api] } = await boardWith(page, stack, ['api', 'db']);
  const crayon = page.locator('#tool-crayon');

  // RV-01: the dock button and C pick it up; Esc and another tool put it down.
  await crayon.click();
  await expect(crayon).toHaveClass(/armed/);
  await page.keyboard.press('Escape');
  await expect(crayon).not.toHaveClass(/armed/);
  await expect(page.locator('#tool-select')).toHaveClass(/armed/);
  await armCrayon(page);
  await page.keyboard.press('1');
  await expect(crayon).not.toHaveClass(/armed/);
  await expect(page.locator('.add-row[data-kind="service"]')).toHaveClass(/armed/);
  await page.keyboard.press('Escape');
  await expect(page.locator('#tool-select')).toHaveClass(/armed/);

  await armCrayon(page);
  await circle(page, api);
  await send(page, 1);
  await page.keyboard.press('c');
  await expect(crayon).not.toHaveClass(/armed/);
  await page.mouse.move(700, 450);
  await page.mouse.wheel(0, 3000); // the wheel pans
  await expect(nodeRect(page, api)).not.toBeInViewport();

  await page.locator('#act-review').click();
  const row = page.locator('#review-pop .mark-row');
  await row.hover();
  await expect(page.locator(`#world g.node[data-id="${api}"]`)).toHaveClass(/tc-lit/);
  await expect(page.locator('#world g.node.tc-lit')).toHaveCount(1); // db stays unlit
  await row.click();
  await expect(nodeRect(page, api)).toBeInViewport();
  await expect(page.locator('#world .selection-outline')).toHaveCount(1);
  await expect(page.locator('#inspector .insp-title')).toHaveText('api'); // the selection is api
});

test('a mark on a deleted node still takes the agent\'s reply', async ({ account, stack }) => {
  const token = stack.accountToken();
  const page = await account(token, WIDE);
  const { B, ids: [api] } = await boardWith(page, stack, ['api', 'db']);
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
  await page.locator('#act-review').click();
  await expect(page.locator('#review-pop')).toBeHidden();

  const agent = await linkedAgent(stack, token, B);
  const mine = seat();
  await stack.callReducer(agent.token, 'claim_marks', [B, mine]);
  const [m] = await marksOn(stack, B);
  expect(m.status).toBe('claimed');
  await stack.callReducer(agent.token, 'reply_mark', [m.id, mine, m.claim_gen, 'kept', 'Node was removed on purpose.', []]);
  await expect(page.locator('#review-badge')).toHaveText('1');
  await page.locator('#act-review').click();
  await expect(page.locator('#review-pop .mark-row.gone.kept')).toContainText('Node was removed on purpose.');
});

test('a guest on an edit link gets no marks', async ({ account, guest, stack }) => {
  // divergent (RV-32): markBoardIds admits edit-link guests, so the guest holds the round and sees 'No agent listening'
  test.fail();
  const token = stack.accountToken();
  const owner = await account(token, WIDE);
  const { ids: [api] } = await boardWith(owner, stack, ['api']);
  await armCrayon(owner);
  await circle(owner, api);
  await send(owner, 1);
  const editLink = await shareBoard(owner, 'edit');

  const anon = await guest();
  await openBoard(anon, editLink);
  await expect(anon.locator('#world')).toContainText('api');
  await expect(anon.locator('#tool-crayon')).toHaveAttribute('title', 'Sign in to mark');
  await expect(anon.locator('#act-review')).toBeHidden();
  await expect.soft(anon.locator('#mark-banner')).toBeHidden();
  expect.soft(await marksHeld(anon)).toBe(0);
});

test('a live downgrade hides the marks, and switching back restores them', async ({ account, stack }) => {
  test.setTimeout(90_000);
  const token = stack.accountToken();
  const owner = await account(token, WIDE);
  const { ids: [api] } = await boardWith(owner, stack, ['api']);
  await armCrayon(owner);
  await circle(owner, api);
  await send(owner, 1);
  await owner.keyboard.press('c'); // crayon down before the Share menu
  const editLink = await shareBoard(owner, 'edit');
  const editor = await account();
  await openBoard(editor, editLink);
  const banner = editor.locator('#mark-banner');
  await expect(editor.locator('#act-review')).toBeVisible();
  await expect(banner).toHaveText('No agent listening');
  expect(await marksHeld(editor)).toBe(1);

  await owner.getByRole('button', { name: 'Can view', exact: true }).click();
  await expect(editor.locator('#board-title')).toContainText('view only');
  await expect(banner).toBeHidden();
  await expect(editor.locator('#act-review')).toBeHidden();
  await expect(editor.locator('#tool-crayon')).toBeDisabled();
  await expect.poll(() => marksHeld(editor)).toBe(0); // the server took the rows back

  await owner.getByRole('button', { name: 'Can edit', exact: true }).click();
  await expect(banner).toHaveText('No agent listening');
  await expect(editor.locator('#act-review')).toBeVisible();
  await expect(editor.locator('#tool-crayon')).toBeEnabled();
  await expect.poll(() => marksHeld(editor)).toBe(1);
});

test('the agent that touched a node gets first dibs, and others wait 20 s', async ({ account, stack }) => {
  test.setTimeout(90_000);
  const token = stack.accountToken();
  const page = await account(token, WIDE);
  const { B } = await boardWith(page, stack, ['api']);
  const a = await linkedAgent(stack, token, B);
  const b = await agentB(stack, token, B);
  // createNode: boardId, label, sublabel, x, y, w, h, token, focal, kind, doc, imported, shape, color, strokeStyle, size
  for (const [label, x] of [['cache', 300], ['queue', 520]] as const) {
    await stack.callReducer(a.token, 'create_node', [B, label, '', x, 600, 160, 80, 'ink', false, NONE, NONE, NONE, NONE, NONE, NONE, NONE]);
  }
  await expect(page.locator('#world g.node')).toHaveCount(3);
  await page.keyboard.press('Shift+Digit1'); // fit the board
  const [{ id: cache }] = await stack.sql(`SELECT id FROM node WHERE board_id = ${B} AND label = 'cache'`);
  const [{ id: queue }] = await stack.sql(`SELECT id FROM node WHERE board_id = ${B} AND label = 'queue'`);
  const sa = seat(), sb = seat();
  const banner = page.locator('#mark-banner');

  // Round 1: the toucher claims at once, after the other agent got nothing.
  await armCrayon(page);
  await circle(page, Number(cache));
  await send(page, 1);
  await stack.callReducer(b.token, 'claim_marks', [B, sb]);
  expect((await marksOn(stack, B)).map(m => m.status)).toEqual(['sent']);
  await stack.callReducer(a.token, 'claim_marks', [B, sa]);
  expect((await marksOn(stack, B)).map(m => [m.status, m.claimed_by])).toEqual([['claimed', `${a.identity}/${sa}`]]);

  // Round 2: A does not claim; B gets the mark only after the 20 s head start.
  await circle(page, Number(queue));
  await send(page, 1);
  await stack.callReducer(b.token, 'claim_marks', [B, sb]);
  const latest = async () => (await marksOn(stack, B)).at(-1)!;
  expect((await latest()).status).toBe('sent');
  await expect(banner).toHaveText('Working on 1 mark');
  await expect.poll(async () => {
    await stack.callReducer(b.token, 'claim_marks', [B, sb]);
    const m = await latest();
    return [m.status, m.claimed_by];
  }, { intervals: [2_000], timeout: 35_000 }).toEqual(['claimed', `${b.identity}/${sb}`]);
  const m = await latest();
  expect(micros(m.lease_until) - LEASE_MICROS - micros(m.sent_at)).toBeGreaterThanOrEqual(20_000_000); // claimed at lease_until - lease
  await page.locator('#act-review').click();
  const queueRow = page.locator('#review-pop .mark-row', { has: page.locator('.mr-label', { hasText: 'queue' }) });
  await expect(queueRow).toContainText('claimed by agent-b');
  await expect(page.locator('#review-pop .mark-row', { has: page.locator('.mr-label', { hasText: 'cache' }) })).toContainText('claimed by e2e-agent');
});

// RV-37 server half (reclaim after expiry, fenced late reply) is not reachable here: the SQL endpoint
// refuses timestamp literals in UPDATE and INSERT, and no reducer shortens a lease. Only the panel half runs.
test('a lapsed lease shows the mark as sent again in the panel', async ({ account, stack }) => {
  const token = stack.accountToken();
  const page = await account(token, WIDE);
  await page.clock.install(); // ticks in real time until moved; only the browser's clock
  const { B, ids: [api] } = await boardWith(page, stack, ['api']);
  await armCrayon(page);
  await circle(page, api);
  await send(page, 1);
  const a = await linkedAgent(stack, token, B);
  const b = await agentB(stack, token, B);
  const sa = seat();
  await stack.callReducer(a.token, 'claim_marks', [B, sa]);
  await page.locator('#act-review').click();
  const row = page.locator('#review-pop .mark-row');
  await expect(row).toContainText('claimed by e2e-agent');

  await page.clock.setSystemTime(Date.now() + LEASE_MICROS / 1000 + 60_000);
  await stack.callReducer(b.token, 'claim_marks', [B, seat()]); // a waiter row repaints the panel
  await expect(row).toHaveClass(/\bsent\b/);
  await expect(row).not.toContainText('claimed by');
  expect((await marksOn(stack, B)).map(m => [m.status, m.claimed_by])).toEqual([['claimed', `${a.identity}/${sa}`]]); // the module's lease still runs
});

test('a new Send while an agent is working starts a new round that the agent claims next', async ({ account, stack }) => {
  test.setTimeout(90_000);
  const token = stack.accountToken();
  const page = await account(token, WIDE);
  const banner = page.locator('#mark-banner');
  const { B, ids: [api, db] } = await boardWith(page, stack, ['api', 'db']);
  await armCrayon(page);
  await circle(page, api);
  await send(page, 1);
  await expect(page.locator('#error-text')).toHaveText(NO_LISTENER);
  await page.locator('#error-dismiss').click();
  await expect(page.locator('#error-strip')).toBeHidden();

  const agent = await linkedAgent(stack, token, B);
  const mine = seat();
  await stack.callReducer(agent.token, 'claim_marks', [B, mine]);
  await expect(banner).toHaveText('Working on 1 mark');

  await circle(page, db);
  await send(page, 1);
  await expect.poll(async () => (await marksOn(stack, B)).map(m => [m.node_id, m.round, m.status])).toEqual([[api, 1, 'claimed'], [db, 2, 'sent']]);
  await expect(page.locator('#error-strip')).toBeHidden(); // RV-18: an agent is listening, so no notice
  await expect(banner).toHaveText('Working on 1 mark');

  const [m1] = await marksOn(stack, B);
  await stack.callReducer(agent.token, 'reply_mark', [m1.id, mine, m1.claim_gen, 'fixed', 'Added the retry.', []]);
  await expect(page.locator('#review-badge')).toHaveText('1'); // the reply arrived
  // Round 1 is all answered: a banner on round 1 would now say the agent is waiting.
  await expect(banner).toHaveText('Working on 1 mark');
  await stack.callReducer(agent.token, 'claim_marks', [B, mine]);
  const [, m2] = await marksOn(stack, B);
  expect([m2.status, m2.claimed_by, m2.round]).toEqual(['claimed', `${agent.identity}/${mine}`, 2]);
  await page.locator('#act-review').click();
  await expect(page.locator('#review-pop .mr-round').nth(0)).toHaveText(/^Round 2/);
  await expect(page.locator('#review-pop .review-sum')).toHaveText('round 2 · 0 answered');
});
