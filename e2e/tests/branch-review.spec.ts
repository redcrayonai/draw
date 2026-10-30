import { test, expect, openBoard, drawNode, drawEdge, shareBoard, boardIdOf, chip, status, openReview, act, fork, settledBox } from '../fixtures';
import type { Page } from '@playwright/test';

// An owner's branch from fork to review (#155, branch spec): what a fork copies, status
// rules and live updates, the change list and Show changes, palette commands, what blocks
// or allows submit, undo scope, and what link visitors see.

const NONE = { none: [] };
const CHART = ['Latency', 'ms', 0, 320, 320, 192, 'bars', 'route,p50\n/a,12', NONE, NONE];

const title = (page: Page) => page.locator('#board-title');
const review = (page: Page) => page.locator('#branch-review');
/** Show changes also draws removed rows as g.node.diff-removed ghosts. */
const live = (page: Page) => page.locator('#world g.node:not(.diff-removed)');
const node = (page: Page, label: string) => page.locator('#world g.node', { hasText: label });

async function toBase(page: Page) {
  await chip(page).click();
  await page.locator('#branch-pop .branch-row').first().click();
  await expect(title(page)).not.toContainText('Branch ·');
}

async function rename(page: Page, from: string, to: string) {
  await node(page, from).dblclick();
  await page.locator('#inline-edit').fill(to);
  await page.locator('#inline-edit').press('Enter');
  await expect(page.locator('#world')).toContainText(to);
  await expect(page.locator('#save-status')).toHaveText('Saved');
}

/** Places the first library match for query at (x, y) of #board (library-icons.spec placeIcon). */
async function place(page: Page, query: string, x: number, y: number) {
  await page.keyboard.press('l');
  const search = page.getByRole('searchbox', { name: 'Search the library' });
  await search.fill(query);
  await search.press('Enter');
  await page.locator('#board').click({ position: { x, y } });
}

async function placeIcon(page: Page, query: string, x: number, y: number) {
  const count = await page.locator('#world g.node').count();
  await place(page, query, x, y);
  await expect(page.locator('#world g.node')).toHaveCount(count + 1);
  await page.keyboard.press('Escape');
  await expect(page.locator('#save-status')).toHaveText('Saved');
}

/** The branch the page has just switched to (its open_board row follows the switch). */
async function branchIdOf(stack: Parameters<typeof boardIdOf>[0], page: Page, base: number) {
  await expect.poll(() => boardIdOf(stack, page)).not.toBe(base);
  return boardIdOf(stack, page);
}

async function palette(page: Page) {
  await page.keyboard.press('Meta+k');
  await expect(page.locator('#palette-input')).toBeFocused();
  return page.locator('#palette-list');
}

test('a fork copies icons and charts without counting them as changes, and keeps its fork record on the server', async ({ account, stack }) => {
  test.setTimeout(90_000);
  const token = stack.accountToken();
  const owner = await account(token);
  await openBoard(owner, `${stack.url}?new=1`);
  await placeIcon(owner, 'k8s', 400, 200);
  await drawNode(owner, 'api');
  // BR-19: the counts left the header for the title's tooltip
  await expect(title(owner)).toHaveAttribute('title', /^2 nodes · 2 shown · 0 hidden — 0 edges/);
  const B = await boardIdOf(stack, owner);
  await stack.callReducer(token, 'create_chart', [B, ...CHART]);
  await expect(owner.locator('#world g.node.node-chart')).toHaveCount(1);
  const t = (await title(owner).textContent()) as string;

  // BR-02: the dialog prefills the name and names the base; empty disables Create; Cancel creates nothing
  await chip(owner).click();
  await owner.locator('#branch-pop .branch-new').click();
  const create = owner.locator('#branch-create');
  await expect(create.locator('#branch-create-name')).toHaveValue(`${t}-branch`);
  await expect(create.locator('.branch-from')).toContainText(`from ${t}`);
  await expect(create.locator('.branch-from')).toContainText('3 nodes · 0 edges');
  await create.locator('#branch-create-name').fill('');
  await expect(create.locator('button[type="submit"]')).toBeDisabled();
  await create.locator('button.ctl').click();
  await expect(create).toHaveCount(0);
  expect(await stack.sql(`SELECT * FROM architecture_version WHERE base_board_id = ${B}`)).toHaveLength(0);

  // BR-03: the copy has the icon and the chart, and neither is a change
  await fork(owner, 'look');
  await expect(owner.getByRole('img', { name: 'Kubernetes' })).toHaveCount(1);
  await expect(owner.locator('#world g.node.node-chart')).toHaveCount(1);
  await expect(owner.locator('#world')).toContainText('api');
  await openReview(owner);
  await expect(review(owner).locator('.branch-empty')).toHaveText('No changes yet.');
  await review(owner).locator('button[data-action="cancel"]').click();

  // BR-60: the fork-time signature stays on the server; the client gets ''
  const rows = await stack.sql(`SELECT * FROM architecture_version WHERE base_board_id = ${B}`);
  expect(rows).toHaveLength(1);
  expect(String(rows[0].sha)).toMatch(/^\{"nodes"/);
  expect(await owner.evaluate(() => [...(window as any).conn.db.visibleArchitectureVersion.iter()].map((v: any) => v.sha))).toEqual(['']);
});

test('a branch cannot be branched, and ⌘⇧B waits while a label is being typed', async ({ account, stack }) => {
  test.setTimeout(90_000);
  const token = stack.accountToken();
  const owner = await account(token);
  await openBoard(owner, `${stack.url}?new=1`);
  await drawNode(owner, 'api');

  // BR-09: typing in the inline editor keeps the shortcut out; outside it, ⌘⇧B opens the dialog
  await node(owner, 'api').dblclick();
  await expect(owner.locator('#inline-edit')).toBeFocused();
  await owner.keyboard.press('Meta+Shift+B');
  await expect(owner.locator('#branch-create')).toHaveCount(0);
  await expect(owner.locator('#inline-edit')).toBeFocused();
  await owner.keyboard.press('Escape');
  await expect(owner.locator('#inline-edit')).toHaveCount(0);
  await owner.keyboard.press('Meta+Shift+B');
  await expect(owner.locator('#branch-create')).toBeVisible();
  await owner.keyboard.press('Escape');
  await expect(owner.locator('#branch-create')).toHaveCount(0);

  // BR-07
  const base = await boardIdOf(stack, owner);
  await fork(owner, 'b1');
  const branch = await branchIdOf(stack, owner, base);
  await chip(owner).click();
  await expect(owner.locator('#branch-pop .branch-row')).toHaveCount(2);
  await expect(owner.locator('#branch-pop .branch-new')).toBeHidden();
  await owner.keyboard.press('Escape');
  const list = await palette(owner);
  await expect(list).toContainText('Show changes');
  await expect(list).not.toContainText('New branch');
  await owner.keyboard.press('Escape');
  await owner.keyboard.press('Meta+Shift+B');
  await expect(owner.locator('#error-text')).toHaveText('Branch the board itself, not a branch.');
  await expect(owner.locator('#branch-create')).toHaveCount(0);
  await expect(stack.callReducer(token, 'create_architecture_proposal', [branch, 'b2', 'e2e-b2']))
    .rejects.toThrow('a branch forks a board or a snapshot, not another branch');
});

test('a new branch and its status changes reach another open tab live, and a reload keeps them', async ({ guest, stack }) => {
  test.setTimeout(120_000);
  const a = await guest();
  await openBoard(a, stack.url);
  await drawNode(a, 'api');
  const b = await a.context().newPage();
  await openBoard(b, a.url());
  await expect(b.locator('#world')).toContainText('api');

  // BR-15: B, still on the base, sees the new Draft row without a reload
  await a.bringToFront();
  await fork(a, 'live-b');
  await b.bringToFront();
  await chip(b).click();
  await expect(b.locator('#branch-pop .branch-row')).toHaveCount(2);
  const row = b.locator('#branch-pop .branch-row', { hasText: 'live-b' });
  await expect(row).toContainText('Draft');
  await row.click();
  await expect(title(b)).toHaveText('Branch · live-b');
  await expect(status(b)).toHaveText('Draft');

  // BR-16: submit and accept in A reach B's chip live
  await a.bringToFront();
  await drawNode(a, 'queue');
  await act(a, 'submit', 'In review');
  await expect(status(b)).toHaveText('In review');
  await act(a, 'accept', 'Accepted');
  await expect(status(b)).toHaveText('Accepted');

  // BR-17
  await a.reload();
  await expect(a.locator('#canvas-wrap')).toHaveAttribute('aria-busy', 'false');
  await expect(title(a)).toHaveText('Branch · live-b');
  await expect(status(a)).toHaveText('Accepted');
  await openReview(a);
  await expect(review(a).locator('.branch-change')).toHaveCount(1);
  await expect(review(a).locator('.branch-change-title')).toContainText('queue');
  await expect(review(a).locator('.branch-step.now')).toHaveText('Accepted');
});

test('graph and label edits return an accepted branch to Draft; moves keep it accepted', async ({ guest, stack }) => {
  test.setTimeout(120_000);
  const owner = await guest();
  await openBoard(owner, stack.url);
  await drawNode(owner, 'api');
  const base = await boardIdOf(stack, owner);
  await fork(owner, 'accepted');
  const branch = await branchIdOf(stack, owner, base);
  await drawNode(owner, 'queue');
  await act(owner, 'submit', 'In review');
  await act(owner, 'accept', 'Accepted');

  // BR-22: a move is saved and keeps the acceptance and Merge
  const xOf = async () => Number((await stack.sql(`SELECT x FROM node WHERE board_id = ${branch} AND label = 'queue'`))[0].x);
  const before = await xOf();
  const box = await settledBox(node(owner, 'queue').locator('.node-rect'));
  await owner.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await owner.mouse.down();
  await owner.mouse.move(box.x + box.width / 2 + 160, box.y + box.height / 2, { steps: 8 });
  await owner.mouse.up();
  await expect.poll(xOf).toBeGreaterThan(before + 100);
  await expect(owner.locator('#save-status')).toHaveText('Saved');
  // The move and any status change commit together, so the row is the truth the chip may lag.
  expect((await stack.sql(`SELECT status FROM architecture_version WHERE board_id = ${branch}`))[0].status).toBe('accepted');
  await expect(status(owner)).toHaveText('Accepted');
  await openReview(owner);
  await expect(review(owner).locator('button[data-action="merge"]')).toBeVisible();
  await review(owner).locator('button[data-action="cancel"]').click();

  // BR-21: a label edit returns it to Draft
  await rename(owner, 'api', 'gateway');
  await expect(status(owner)).toHaveText('Draft');

  // BR-20: so does drawing; the dialog then offers Submit, not Merge
  await act(owner, 'submit', 'In review');
  await act(owner, 'accept', 'Accepted');
  await drawNode(owner, 'cache');
  await expect(status(owner)).toHaveText('Draft');
  await openReview(owner);
  await expect(review(owner).locator('button[data-action="submit"]')).toBeVisible();
  await expect(review(owner).locator('button[data-action="merge"]')).toHaveCount(0);
  expect((await stack.sql(`SELECT status FROM architecture_version WHERE board_id = ${branch}`))[0].status).toBe('draft');
});

test('the review lists added, removed and changed rows, and Show changes marks them on the canvas', async ({ guest, stack }) => {
  test.setTimeout(120_000);
  const owner = await guest();
  await openBoard(owner, stack.url);
  await drawNode(owner, 'api');
  await drawNode(owner, 'orders');
  await drawEdge(owner, 0, 1);
  await fork(owner, 'mix');

  // BR-36: a branch of a plain board has only the toggle and the summary in the rail
  const rail = owner.locator('#architecture-panel');
  await expect(rail).toBeVisible();
  await expect(rail.locator('.architecture-mode')).toHaveText(/^Branch of .* · Draft$/);
  await expect(rail.locator('select[aria-label="Architecture snapshot"]')).toBeHidden();
  await expect(rail.locator('input[aria-label="Architecture timeline"]')).toBeHidden();
  await expect(rail.locator('select[aria-label="Architecture branch"]')).toBeHidden();
  await expect(rail.locator('.architecture-diff input')).toBeChecked();

  // Draw before the delete: drawNode labels the last g.node, and a removed node's ghost comes last.
  await drawNode(owner, 'queue');
  await rename(owner, 'api', 'gateway');
  await node(owner, 'orders').locator('.node-rect').click();
  await owner.keyboard.press('Delete');
  await expect(live(owner)).toHaveCount(2);
  await expect(owner.locator('#save-status')).toHaveText('Saved');

  // BR-33
  await openReview(owner);
  const changes = review(owner).locator('.branch-change');
  const added = changes.filter({ has: owner.locator('.branch-sign.plus') });
  const removed = changes.filter({ has: owner.locator('.branch-sign.minus') });
  const changed = changes.filter({ has: owner.locator('.branch-sign.tilde') });
  await expect(added).toHaveCount(1);
  await expect(added).toContainText('queue');
  await expect(added).toContainText('service');
  await expect(removed).toHaveCount(2);
  await expect(removed.filter({ hasText: 'orders' })).toHaveCount(2); // the node and its edge
  await expect(removed.filter({ hasText: '→' })).toHaveCount(1);
  await expect(changed).toHaveCount(1);
  await expect(changed).toContainText('gateway');
  await review(owner).locator('button[data-action="cancel"]').click();

  // BR-35: on by default; the toggle clears the marks
  await expect(owner.locator('#world g.node.diff-added')).toHaveCount(1);
  await expect(owner.locator('#world g.node.diff-added')).toContainText('queue');
  await expect(owner.locator('#world g.node.diff-removed')).toHaveCount(1);
  await expect(owner.locator('#world g.node.diff-removed')).toContainText('orders');
  await expect(owner.locator('#world g.node.diff-changed')).toHaveCount(1);
  await expect(owner.locator('#world g.node.diff-changed')).toContainText('gateway');
  await expect(rail.locator('.architecture-summary')).toContainText('Nodes +1 −1');
  await rail.locator('.architecture-diff input').uncheck();
  await expect(owner.locator('#world')).toContainText('queue');
  await expect(owner.locator('#world g.node')).toHaveCount(2);
  await expect(owner.locator('#world g.node.diff-added, #world g.node.diff-removed, #world g.node.diff-changed')).toHaveCount(0);
});

test('the palette offers only the branch commands valid now', async ({ guest, stack }) => {
  test.setTimeout(90_000);
  const owner = await guest();
  await openBoard(owner, stack.url);
  await drawNode(owner, 'api');
  const base = (await title(owner).textContent()) as string;
  await fork(owner, 'pal');

  // BR-31
  await owner.keyboard.press('Escape');
  await palette(owner);
  await expect(owner.locator('#palette-ctx')).toHaveText(`Branch of ${base} · Draft`);
  await owner.keyboard.press('Escape');

  // BR-30: a submitted branch's owner gets Accept and Reject, not Merge or New branch
  await drawNode(owner, 'q');
  await act(owner, 'submit', 'In review');
  const list = await palette(owner);
  const command = (name: string) => list.locator('.palette-title').getByText(name, { exact: true });
  for (const name of ['Accept', 'Reject', `Switch to ${base}`, 'Show changes']) await expect(command(name)).toHaveCount(1);
  await expect(command('New branch')).toHaveCount(0);
  await expect(command('Merge')).toHaveCount(0);
  await owner.keyboard.press('Escape');

  // BR-32
  await openReview(owner);
  await expect(review(owner).locator('.branch-sub')).toHaveText(`Branch of ${base}`);
  await expect(review(owner).locator('.branch-step.now')).toHaveText('In review');
  await review(owner).locator('button[data-action="accept"]').click();
  await expect(status(owner)).toHaveText('Accepted');
  await openReview(owner);
  await expect(review(owner).locator('.branch-step.now')).toHaveText('Accepted');
  await expect(review(owner).locator('.branch-step.done')).toHaveCount(2);
});

test('icons and charts on a branch are saved and never block submit', async ({ account, stack }) => {
  test.setTimeout(90_000);
  const token = stack.accountToken();
  const owner = await account(token);
  await openBoard(owner, `${stack.url}?new=1`);
  await drawNode(owner, 'api');
  const base = await boardIdOf(stack, owner);
  await fork(owner, 'iconic');
  const branch = await branchIdOf(stack, owner, base);

  // BR-26 (server path; library placement is the expected-fail case below): saved, shown after a reload
  await stack.callReducer(token, 'create_icon_node', [branch, 'Kubernetes', '', 700, 400, 160, 96, 'ink', false, NONE, NONE, NONE, NONE, NONE, NONE, NONE, 'kubernetes']);
  // BR-27
  await stack.callReducer(token, 'create_chart', [branch, ...CHART]);
  await expect(owner.getByRole('img', { name: 'Kubernetes' })).toHaveCount(1);
  await expect(owner.locator('#world g.node.node-chart')).toHaveCount(1);
  await owner.reload();
  await expect(owner.locator('#canvas-wrap')).toHaveAttribute('aria-busy', 'false');
  await expect(title(owner)).toHaveText('Branch · iconic');
  await expect(owner.getByRole('img', { name: 'Kubernetes' })).toHaveCount(1);
  await expect(owner.locator('#world g.node.node-chart')).toHaveCount(1);
  await act(owner, 'submit', 'In review');
  expect((await stack.sql(`SELECT status FROM architecture_version WHERE board_id = ${branch}`))[0].status).toBe('submitted');
});

test('a free-text block can be branched and submitted', async ({ guest, stack }) => {
  // divergent (BR-28): submit refuses with 'graph node kind text is invalid' (validateGraph KINDS lacks 'text')
  test.fail();
  test.setTimeout(60_000);
  const owner = await guest();
  await openBoard(owner, stack.url);
  await drawNode(owner, 'api');
  await owner.keyboard.press('6');
  await owner.locator('#board').click({ position: { x: 700, y: 500 } });
  await owner.locator('#inline-edit').fill('Notes');
  await owner.keyboard.press('Escape'); // Escape saves free text; Enter breaks the line
  await expect(owner.locator('#world')).toContainText('Notes');
  await expect(owner.locator('#save-status')).toHaveText('Saved');
  await fork(owner, 'with-text');
  await openReview(owner);
  await review(owner).locator('button[data-action="submit"]').click();
  // Whichever answer comes first: the dialog's refusal or the new status.
  await expect(review(owner).locator('[role="alert"]:visible').or(status(owner).filter({ hasText: 'In review' }))).toHaveText('In review');
  await expect(review(owner)).toHaveCount(0);
});

test('an icon placed from the library on a branch is saved and shown after a reload', async ({ guest, stack }) => {
  // divergent (BR-26, CH-24): the client refuses 'icons are not supported on architecture boards yet' on any versioned board
  test.fail();
  test.setTimeout(60_000);
  const owner = await guest();
  await openBoard(owner, stack.url);
  await drawNode(owner, 'api');
  await fork(owner, 'iconic');
  await place(owner, 'orchestrator', 700, 400);
  await expect(owner.locator('#error-strip:visible').or(owner.getByRole('img', { name: 'Orchestrator' })).first()).toBeVisible(); // placed or refused
  await expect(owner.locator('#error-text')).toHaveText('');
  await expect(owner.getByRole('img', { name: 'Orchestrator' })).toHaveCount(1);
  await owner.reload();
  await expect(owner.locator('#canvas-wrap')).toHaveAttribute('aria-busy', 'false');
  await expect(owner.getByRole('img', { name: 'Orchestrator' })).toHaveCount(1);
});

test('a chart placed from the library on a branch lands on the canvas', async ({ guest, stack }) => {
  // divergent (CH-24): the client refuses 'charts are not supported on architecture boards yet' on any versioned board
  test.fail();
  test.setTimeout(60_000);
  const owner = await guest();
  await openBoard(owner, stack.url);
  await drawNode(owner, 'api');
  await fork(owner, 'charts');
  await place(owner, 'stat', 520, 420);
  await expect(owner.locator('#error-strip:visible').or(owner.locator('#world g.node.node-chart')).first()).toBeVisible(); // placed or refused
  await expect(owner.locator('#error-text')).toHaveText('');
  await expect(owner.locator('#world g.node.node-chart')).toHaveCount(1);
});

test('switching to a branch clears undo for the board left', async ({ guest, stack }) => {
  test.setTimeout(90_000);
  const owner = await guest();
  await openBoard(owner, stack.url);
  await drawNode(owner, 'api');
  await drawNode(owner, 'orders');
  const base = await boardIdOf(stack, owner);
  await fork(owner, 'u');
  const branch = await branchIdOf(stack, owner, base);
  // Focus the canvas as for the anchor below, so these presses do reach the undo handler.
  await node(owner, 'orders').locator('.node-rect').click();
  await owner.keyboard.press('ControlOrMeta+z');
  await owner.keyboard.press('ControlOrMeta+z');
  await expect(live(owner)).toHaveCount(2);
  await expect(owner.locator('#world')).toContainText('orders');

  // ⌘Z still works on the branch's own edits
  await node(owner, 'api').locator('.node-rect').click();
  await owner.keyboard.press('Delete');
  await expect(live(owner)).toHaveCount(1);
  await owner.keyboard.press('ControlOrMeta+z');
  await expect(live(owner)).toHaveCount(2);
  await expect(owner.locator('#save-status')).toHaveText('Saved');
  // One connection's calls run in order, so any delete the two presses sent has landed by now.
  const labels = async (id: number) => (await stack.sql(`SELECT label FROM node WHERE board_id = ${id}`)).map(r => r.label).sort();
  expect(await labels(base)).toEqual(['api', 'orders']);
  expect(await labels(branch)).toEqual(['api', 'orders']);

  await toBase(owner);
  await expect(owner.locator('#world g.node')).toHaveCount(2);
  await expect(owner.locator('#world')).toContainText('orders');
  await expect(owner.locator('#world')).toContainText('api');
});

test('a base view-link visitor never sees the owner\'s branches', async ({ guest, account, stack }) => {
  test.setTimeout(90_000);
  const owner = await guest();
  await openBoard(owner, stack.url);
  await drawNode(owner, 'api');
  const base = await boardIdOf(stack, owner);
  await fork(owner, 'secret-plan');
  const branch = await branchIdOf(stack, owner, base);
  await toBase(owner);
  const link = await shareBoard(owner, 'view');

  const viewer = await account();
  await viewer.goto(link);
  await expect(viewer.locator('#canvas-wrap')).toHaveAttribute('aria-busy', 'false');
  await expect(viewer.locator('#world')).toContainText('api');
  await chip(viewer).click();
  await expect(viewer.locator('#branch-pop .branch-row')).toHaveCount(1);
  await expect(viewer.locator('#branch-pop')).not.toContainText('secret-plan');
  await viewer.keyboard.press('Escape');
  const list = await palette(viewer);
  await expect(list.locator('[role="option"]').first()).toBeVisible();
  await expect(list).not.toContainText('secret-plan');
  await expect(list.locator('.palette-title').getByText('New branch', { exact: true })).toHaveCount(0); // BR-30: a visitor cannot branch
  await viewer.keyboard.press('Escape');
  // The server never sent the branch: no board, node or version row of it reaches this reader.
  const seen = await viewer.evaluate(() => ({
    boards: [...(window as any).conn.db.visibleBoard.iter()].map((b: any) => Number(b.id)),
    nodes: [...(window as any).conn.db.visibleNode.iter()].map((n: any) => Number(n.boardId)),
    versions: [...(window as any).conn.db.visibleArchitectureVersion.iter()].length,
  }));
  expect(seen.boards).toContain(base);
  expect(seen.nodes).toContain(base);
  expect(seen.boards).not.toContain(branch);
  expect(seen.nodes).not.toContain(branch);
  expect(seen.versions).toBe(0);
});

test('a view-link visitor of a branch sees its status but cannot review', async ({ guest, account, stack }) => {
  test.setTimeout(90_000);
  const owner = await guest();
  await openBoard(owner, stack.url);
  await drawNode(owner, 'api');
  const base = await boardIdOf(stack, owner);
  await fork(owner, 'rv');
  const branch = await branchIdOf(stack, owner, base);
  await drawNode(owner, 'queue');
  await act(owner, 'submit', 'In review');
  const link = await shareBoard(owner, 'view');

  const token = stack.accountToken();
  const viewer = await account(token);
  await viewer.goto(link);
  await expect(viewer.locator('#canvas-wrap')).toHaveAttribute('aria-busy', 'false');
  await expect(viewer.locator('#world')).toContainText('queue');
  await expect(status(viewer)).toHaveText('In review');
  await openReview(viewer);
  await expect(review(viewer).locator('button[data-action="cancel"]')).toBeVisible();
  await expect(review(viewer).locator('button[data-action]:not([data-action="cancel"])')).toHaveCount(0);
  await expect(review(viewer).locator('.branch-note')).toHaveText('Waiting for the owner to review.');
  await review(viewer).locator('button[data-action="cancel"]').click();
  await chip(viewer).click();
  await expect(viewer.locator('#branch-pop .branch-row.current')).toBeVisible();
  await expect(viewer.locator('#branch-pop .branch-new')).toBeHidden();
  // The module refuses the visitor's review and submit too.
  await expect(stack.callReducer(token, 'review_architecture_proposal', [branch, 'accept'])).rejects.toThrow(`only an owner of board ${branch} can review it`);
  await expect(stack.callReducer(token, 'submit_architecture_proposal', [branch])).rejects.toThrow('only an owner or an agent');
  expect((await stack.sql(`SELECT status FROM architecture_version WHERE board_id = ${branch}`))[0].status).toBe('submitted');
});
