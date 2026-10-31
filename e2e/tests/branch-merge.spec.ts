import type { Page } from '@playwright/test';
import { test, expect, openBoard, drawNode, drawEdge, shareBoard, boardIdOf, linkedAgent, nodes, chip, status, openReview, act, fork, settledBox } from '../fixtures';

// Branching a hand-drawn board (spec 2026-10-21): what a merge applies and keeps, the merged
// branch, live reach, hide sets, and who may change a branch. Helpers follow branches.spec.ts.

const NONE = { none: [] };
const RULE = 'only an owner or an agent';

/** A branch also paints the base rows it lacks, as diff-removed ghosts. */
const live = (page: Page) => page.locator('#world g.node:not(.diff-removed)');
const named = (page: Page, label: string) => live(page).filter({ hasText: label });
const review = (page: Page) => page.locator('#branch-review');
const hexOf = (page: Page) => page.evaluate(() => (window as any).conn.identity.toHexString() as string);
const labelsOn = async (stack: { sql(q: string): Promise<any[]> }, B: number) =>
  (await stack.sql(`SELECT label FROM node WHERE board_id = ${B}`)).map(r => r.label).sort();

/** Inside the node, clear of its centred label. */
const select = (page: Page, label: string, shift = false) =>
  named(page, label).locator('.node-rect').click({ position: { x: 12, y: 12 }, modifiers: shift ? ['Shift'] : [] });

async function mergeAll(page: Page) {
  await act(page, 'submit', 'In review');
  await act(page, 'accept', 'Accepted');
  await act(page, 'merge', 'Merged');
}

/** The tree's root row is the base. */
async function toBase(page: Page) {
  await chip(page).click();
  await page.locator('#branch-pop .branch-row').first().click();
  await expect(page.locator('#board-title')).not.toContainText('Branch ·');
}

async function toBranch(page: Page, name: string) {
  await chip(page).click();
  await page.locator('#branch-pop .branch-row').filter({ has: page.getByText(name, { exact: true }) }).click();
  await expect(page.locator('#board-title')).toHaveText(`Branch · ${name}`);
}

async function dragBy(page: Page, label: string, dx: number) {
  const box = await settledBox(named(page, label).locator('.node-rect'));
  await page.mouse.move(box.x + 12, box.y + 12);
  await page.mouse.down();
  await page.mouse.move(box.x + 12 + dx, box.y + 12, { steps: 8 });
  await page.mouse.up();
}

test('a merge removes rows deleted on the branch, with their edges', async ({ guest, stack }) => {
  test.setTimeout(120_000);
  const owner = await guest();
  await openBoard(owner, stack.url);
  await drawNode(owner, 'api');
  await drawNode(owner, 'orders');
  await drawEdge(owner, 0, 1);
  await owner.keyboard.press('Escape');
  const B = await boardIdOf(stack, owner);
  await fork(owner, 'drop');
  await select(owner, 'orders');
  await owner.keyboard.press('Delete');
  await expect(live(owner)).toHaveCount(1);
  await expect(owner.locator('#save-status')).toHaveText('Saved');
  // The branch delete has not touched the base: only the merge may.
  expect(await labelsOn(stack, B)).toEqual(['api', 'orders']);
  expect(await stack.sql(`SELECT id FROM edge WHERE board_id = ${B}`)).toHaveLength(1);
  await act(owner, 'submit', 'In review');
  await act(owner, 'accept', 'Accepted');
  // The removal sentence belongs to the merge step.
  await openReview(owner);
  await expect(review(owner).locator('.branch-note')).toContainText('removes 1 node and 1 edge');
  await review(owner).locator('button[data-action="merge"]').click();
  await expect(status(owner)).toHaveText('Merged');

  await toBase(owner);
  await expect(owner.locator('#world')).toContainText('api');
  await expect(nodes(owner)).toHaveCount(1);
  await expect(owner.locator('#world g.edge')).toHaveCount(0);
  await owner.reload();
  await expect(owner.locator('#canvas-wrap')).toHaveAttribute('aria-busy', 'false');
  // The merged branch also shows just 'api': prove the reload reopened the base.
  await expect(owner.locator('#board-title')).not.toBeEmpty();
  await expect(owner.locator('#board-title')).not.toContainText('Branch ·');
  await expect(owner.locator('#world')).toContainText('api');
  await expect(nodes(owner)).toHaveCount(1);
  await expect(owner.locator('#world g.edge')).toHaveCount(0);
  expect(await labelsOn(stack, B)).toEqual(['api']);
  expect(await stack.sql(`SELECT id FROM edge WHERE board_id = ${B}`)).toEqual([]);
});

test('a merge keeps base work added since the fork', async ({ guest, stack }) => {
  test.setTimeout(120_000);
  const owner = await guest();
  await openBoard(owner, stack.url);
  await drawNode(owner, 'api');
  const B = await boardIdOf(stack, owner);
  await fork(owner, 'b1');
  await drawNode(owner, 'queue');
  await toBase(owner);
  await drawNode(owner, 'audit');
  await toBranch(owner, 'b1');
  await openReview(owner);
  await expect(review(owner).locator('.branch-change')).toHaveCount(1);
  await expect(review(owner).locator('.branch-change-title')).toContainText('queue');
  await expect(review(owner).locator('.branch-sign.minus')).toHaveCount(0);
  await owner.keyboard.press('Escape');
  await expect(review(owner)).toHaveCount(0);
  await mergeAll(owner);
  await toBase(owner);
  for (const label of ['api', 'queue', 'audit']) await expect(owner.locator('#world')).toContainText(label);
  await expect(nodes(owner)).toHaveCount(3);
  expect(await labelsOn(stack, B)).toEqual(['api', 'audit', 'queue']);
});

test('rows added to the base after a fork are never listed as removed, even after a later fork', async ({ guest, stack }) => {
  // divergent (BR-48): a later fork keys the base's 'audit', so the first branch lists it as '−' (documented shortcut)
  test.fail();
  test.setTimeout(120_000);
  const owner = await guest();
  await openBoard(owner, stack.url);
  await drawNode(owner, 'api');
  await fork(owner, 'b1');
  await drawNode(owner, 'queue');
  await toBase(owner);
  await drawNode(owner, 'audit');
  await fork(owner, 'b2');
  await toBranch(owner, 'b1');
  await expect(owner.locator('#world')).toContainText('queue');
  await openReview(owner);
  await expect(review(owner).locator('.branch-change-title').first()).toBeVisible();
  await expect(review(owner).locator('.branch-sign.minus')).toHaveCount(0);
  await owner.keyboard.press('Escape');
  await expect(review(owner)).toHaveCount(0);
  // Nor on the canvas diff (painted: queue is marked added), nor in the merge sentence.
  await expect(owner.locator('#world g.node.diff-added')).toHaveCount(1);
  await expect(owner.locator('#world g.node.diff-removed')).toHaveCount(0);
  await act(owner, 'submit', 'In review');
  await act(owner, 'accept', 'Accepted');
  await openReview(owner);
  await expect(review(owner).locator('.branch-note')).toContainText('Merging adds 1 node');
  await expect(review(owner).locator('.branch-note')).not.toContainText('removes');
});

test('a merge applies content but keeps the base layout, and cites unevidenced edges to a human', async ({ guest, stack }) => {
  test.setTimeout(120_000);
  const owner = await guest();
  await openBoard(owner, stack.url);
  await drawNode(owner, 'api');
  await drawNode(owner, 'orders');
  await owner.keyboard.press('Escape');
  const B = await boardIdOf(stack, owner);
  const apiId = await named(owner, 'api').getAttribute('data-id');
  const pos = await named(owner, 'api').getAttribute('transform');
  await fork(owner, 'wire');
  const branchId = await boardIdOf(stack, owner);

  await named(owner, 'api').dblclick();
  await owner.locator('#inline-edit').fill('gateway');
  await owner.locator('#inline-edit').press('Enter');
  await expect(owner.locator('#world')).toContainText('gateway');
  await expect(owner.locator('#save-status')).toHaveText('Saved');
  await dragBy(owner, 'gateway', 160);
  await expect(named(owner, 'gateway')).not.toHaveAttribute('transform', pos!);
  await expect(owner.locator('#save-status')).toHaveText('Saved');
  await drawEdge(owner, 0, 1);
  await owner.keyboard.press('Escape');
  expect(await stack.sql(`SELECT evidence FROM edge WHERE board_id = ${branchId}`)).toEqual([{ evidence: '' }]);

  await mergeAll(owner);
  await toBase(owner);
  const merged = owner.locator(`#world g.node[data-id="${apiId}"]`);
  await expect(merged).toContainText('gateway');
  await expect(merged).toHaveAttribute('transform', pos!);
  await expect(owner.locator('#world g.edge')).toHaveCount(1);
  expect(await stack.sql(`SELECT evidence FROM edge WHERE board_id = ${B}`)).toEqual([{ evidence: `human:${await hexOf(owner)}` }]);
});

test('a merged branch is read-only and its dialog says merged', async ({ guest, stack }) => {
  test.setTimeout(120_000);
  const owner = await guest();
  await openBoard(owner, stack.url);
  await drawNode(owner, 'api');
  await fork(owner, 'done');
  const branchId = await boardIdOf(stack, owner);
  await drawNode(owner, 'queue');
  await mergeAll(owner);

  await openReview(owner);
  await expect(review(owner).locator('button[data-action="cancel"]')).toBeVisible();
  await expect(review(owner).locator('button[data-action]:not([data-action="cancel"])')).toHaveCount(0);
  await expect(review(owner).locator('.branch-note')).toHaveText('This branch is merged.');
  await expect(review(owner).locator('.branch-step.now')).toHaveText('Merged');
  await review(owner).locator('button[data-action="cancel"]').click();
  await expect(review(owner)).toHaveCount(0);

  // The canvas offers the tool; the module refuses the write.
  await expect(owner.locator('#world')).toContainText('queue');
  await expect(live(owner)).toHaveCount(2);
  await owner.keyboard.press('1');
  await owner.locator('#board').click({ position: { x: 900, y: 500 } });
  await expect(owner.locator('#error-text')).toContainText('a merged branch is read-only');
  await expect(live(owner)).toHaveCount(2);
  expect(await labelsOn(stack, branchId)).toEqual(['api', 'queue']);
});

test('a merged branch shows no stale diff', async ({ guest, stack }) => {
  // divergent (BR-46): the merged branch keeps its proposal: key, so it shows +queue and a −queue ghost
  test.fail();
  test.setTimeout(120_000);
  const owner = await guest();
  await openBoard(owner, stack.url);
  await drawNode(owner, 'api');
  await fork(owner, 'stale');
  await drawNode(owner, 'queue');
  await mergeAll(owner);
  await expect(owner.locator('#world')).toContainText('queue');
  await expect(owner.locator('#world g.node.diff-removed')).toHaveCount(0);
  await expect(owner.locator('#world g.node.diff-added')).toHaveCount(0);
  await openReview(owner);
  await expect(review(owner).locator('.branch-empty')).toHaveText('No changes yet.');
});

test('a merge adds back rows the base deleted after the fork, as the review promised', async ({ guest, stack }) => {
  // divergent (BR-45): merge skips keys in the fork record that the base deleted, so 'orders' never returns (PR #170 unmerged)
  test.fail();
  test.setTimeout(120_000);
  const owner = await guest();
  await openBoard(owner, stack.url);
  await drawNode(owner, 'api');
  await drawNode(owner, 'orders');
  await owner.keyboard.press('Escape');
  const B = await boardIdOf(stack, owner);
  await fork(owner, 'keep');
  await toBase(owner);
  await select(owner, 'orders');
  await owner.keyboard.press('Delete');
  await expect(nodes(owner)).toHaveCount(1);
  await expect(owner.locator('#save-status')).toHaveText('Saved');
  await toBranch(owner, 'keep');
  await act(owner, 'submit', 'In review');
  await act(owner, 'accept', 'Accepted');
  await openReview(owner);
  await expect(review(owner).locator('.branch-note')).toContainText('Merging adds 1 node');
  await review(owner).locator('button[data-action="merge"]').click();
  await expect(status(owner)).toHaveText('Merged');
  await toBase(owner);
  await expect(owner.locator('#world')).toContainText('api');
  await expect(owner.locator('#world')).toContainText('orders');
  await expect(nodes(owner)).toHaveCount(2);
  expect(await labelsOn(stack, B)).toEqual(['api', 'orders']);
});

test('a merge reaches an open view-link visitor live', async ({ guest, account, stack }) => {
  test.setTimeout(120_000);
  const owner = await guest();
  await openBoard(owner, stack.url);
  await drawNode(owner, 'api');
  const link = await shareBoard(owner, 'view');
  await owner.keyboard.press('Escape');
  const viewer = await account();
  await openBoard(viewer, link);
  await expect(viewer.locator('#world')).toContainText('api');
  await expect(nodes(viewer)).toHaveCount(1);

  await fork(owner, 'live');
  await drawNode(owner, 'queue');
  await mergeAll(owner);
  // No reload: the merge arrives over the viewer's subscription.
  await expect(viewer.locator('#world')).toContainText('queue');
  await expect(nodes(viewer)).toHaveCount(2);
  await chip(viewer).click();
  await expect(viewer.locator('#branch-pop .branch-row')).toHaveCount(1);
  await expect(viewer.locator('#branch-pop .branch-tag')).toHaveText('base');
});

test('a merge does not carry the branch hide sets', async ({ guest, stack }) => {
  test.setTimeout(120_000);
  const owner = await guest();
  await openBoard(owner, stack.url);
  await drawNode(owner, 'api');
  await drawNode(owner, 'orders');
  const B = await boardIdOf(stack, owner);
  await fork(owner, 'tidy');
  const branchId = await boardIdOf(stack, owner);
  await drawNode(owner, 'queue');
  await owner.keyboard.press('Escape');
  await select(owner, 'queue');
  await select(owner, 'orders', true);
  await expect(owner.locator('#inspector .insp-title')).toHaveText('2 nodes');
  owner.once('dialog', dialog => dialog.accept('scratch'));
  await owner.locator('#inspector').getByRole('button', { name: 'hide as set…', exact: true }).click();
  await expect(owner.locator('#chips-row .chip')).toHaveText(['scratch 2']);
  await expect(owner.locator('#hidden-sets-title')).toBeVisible();
  await expect(owner.locator('#world')).not.toContainText('queue');
  expect((await stack.sql(`SELECT hidden FROM node WHERE board_id = ${branchId}`)).filter(r => r.hidden)).toHaveLength(2);
  expect((await stack.sql(`SELECT name FROM hide_set WHERE board_id = ${branchId}`)).map(r => r.name)).toEqual(['scratch']);

  await mergeAll(owner);
  await toBase(owner);
  for (const label of ['api', 'orders', 'queue']) await expect(owner.locator('#world')).toContainText(label);
  await expect(nodes(owner)).toHaveCount(3);
  await expect(owner.locator('#chips-row .chip')).toHaveCount(0);
  await expect(owner.locator('#hidden-sets-title')).toBeHidden();
  expect(await stack.sql(`SELECT id FROM hide_set WHERE board_id = ${B}`)).toEqual([]);
  expect((await stack.sql(`SELECT hidden FROM node WHERE board_id = ${B}`)).map(r => r.hidden)).toEqual([false, false, false]);
});

test('a link editor may move nodes on a branch, but the module refuses forks, graph edits and submit', async ({ guest, account, stack }) => {
  test.setTimeout(120_000);
  const owner = await guest();
  await openBoard(owner, stack.url);
  await drawNode(owner, 'api');
  const B = await boardIdOf(stack, owner);
  const baseLink = await shareBoard(owner, 'edit');
  await owner.keyboard.press('Escape');
  const editorToken = stack.accountToken();
  const editor = await account(editorToken);
  await openBoard(editor, baseLink);
  await expect(editor.locator('#world')).toContainText('api');

  // BR-04: an editor is offered New branch; the module's refusal stays in the dialog.
  await chip(editor).click();
  await expect(editor.locator('#branch-pop .branch-new')).toBeVisible();
  await editor.locator('#branch-pop .branch-new').click();
  await editor.locator('#branch-create button[type="submit"]').click();
  await expect(editor.locator('#branch-create [role="alert"]')).toContainText(RULE);
  await expect(editor.locator('#branch-create')).toBeVisible();
  expect(await stack.sql(`SELECT board_id FROM architecture_version WHERE base_board_id = ${B}`)).toEqual([]);
  await editor.locator('#branch-create button[type="button"]').click();

  // The owner shares the branch itself by an edit link.
  await fork(owner, 'shared');
  const branchId = await boardIdOf(stack, owner);
  const branchLink = await shareBoard(owner, 'edit');
  await owner.keyboard.press('Escape');
  // The canvas reads the link once per load: open it in a new tab of the same person.
  const onBranch = await editor.context().newPage();
  await openBoard(onBranch, branchLink);
  await expect(onBranch.locator('#board-title')).toContainText('Branch · shared');
  await expect(onBranch.locator('#world')).toContainText('api');
  await expect(live(onBranch)).toHaveCount(1);

  // BR-23, AG-45: a graph edit is refused.
  await onBranch.keyboard.press('1');
  await onBranch.locator('#board').click({ position: { x: 700, y: 400 } });
  await expect(onBranch.locator('#error-text')).toContainText(RULE);
  await expect(live(onBranch)).toHaveCount(1);
  expect(await labelsOn(stack, branchId)).toEqual(['api']);
  await onBranch.keyboard.press('Escape');
  await onBranch.locator('#error-dismiss').click();

  // A move is layout, not a proposal edit.
  const [{ id, x: x0 }] = await stack.sql(`SELECT id, x FROM node WHERE board_id = ${branchId}`);
  await dragBy(onBranch, 'api', 160);
  await expect.poll(async () => Number((await stack.sql(`SELECT x FROM node WHERE id = ${id}`))[0].x)).toBeGreaterThan(Number(x0));
  await expect(onBranch.locator('#save-status')).toHaveText('Saved');

  // BR-24: Submit is offered and refused in the review dialog.
  await openReview(onBranch);
  await onBranch.locator('#branch-review button[data-action="submit"]').click();
  await expect(onBranch.locator('#branch-review [role="alert"]')).toContainText(RULE);
  await expect(review(onBranch)).toBeVisible();
  await expect(status(owner)).toHaveText('Draft');
  expect(await stack.sql(`SELECT status FROM architecture_version WHERE board_id = ${branchId}`)).toEqual([{ status: 'draft' }]);
  await onBranch.locator('#branch-review button[data-action="cancel"]').click();
  await expect(review(onBranch)).toHaveCount(0);

  // AG-45: once the owner submits, the editor is offered no review control and the module refuses one.
  await act(owner, 'submit', 'In review');
  await expect(status(onBranch)).toHaveText('In review');
  await openReview(onBranch);
  await expect(review(onBranch).locator('.branch-step.now')).toHaveText('In review');
  await expect(review(onBranch).locator('button[data-action="cancel"]')).toBeVisible();
  await expect(review(onBranch).locator('button[data-action]:not([data-action="cancel"])')).toHaveCount(0);
  await expect(stack.callReducer(editorToken, 'review_architecture_proposal', [branchId, 'accept'])).rejects.toThrow(`only an owner of board ${branchId}`);
  await expect(stack.callReducer(editorToken, 'merge_architecture_proposal', [branchId])).rejects.toThrow(`only an owner of board ${branchId}`);
  expect(await stack.sql(`SELECT status FROM architecture_version WHERE board_id = ${branchId}`)).toEqual([{ status: 'submitted' }]);
  await expect(status(owner)).toHaveText('In review');
});

test('a linked agent forks and submits; the owner reviews live; the agent cannot review or merge', async ({ account, stack }) => {
  test.setTimeout(120_000);
  const token = stack.accountToken();
  const owner = await account(token);
  await openBoard(owner, `${stack.url}?new=1`);
  await drawNode(owner, 'api');
  await owner.keyboard.press('Escape');
  const B = await boardIdOf(stack, owner);
  const agent = await linkedAgent(stack, token, B);

  // BR-54: the agent's branch shows up in the owner's open tree as Draft.
  await chip(owner).click();
  const rows = owner.locator('#branch-pop .branch-row');
  await expect(rows).toHaveCount(1);
  await stack.callReducer(agent.token, 'create_architecture_proposal', [B, 'agent-plan', 'agent-plan-key']);
  const row = rows.filter({ hasText: 'agent-plan' });
  await expect(row.locator('.branch-row-status')).toHaveText('Draft');
  const [{ board_id }] = await stack.sql(`SELECT board_id FROM architecture_version WHERE base_board_id = ${B} AND request_key = 'agent-plan-key'`);
  const branchId = Number(board_id);
  expect(await stack.sql(`SELECT role FROM board_grant WHERE board_id = ${branchId} AND grantee = 0x${await hexOf(owner)}`)).toEqual([{ role: 'owner' }]);
  expect(await stack.sql(`SELECT role FROM board_grant WHERE board_id = ${branchId} AND grantee = 0x${agent.identity}`)).toEqual([]);

  // BR-55: the agent keeps editing its branch and submits it, with an agent: citation.
  const [api] = await stack.sql(`SELECT id FROM node WHERE board_id = ${branchId}`);
  await stack.callReducer(agent.token, 'create_node', [branchId, 'cache', '', 0, 320, 160, 80, 'ink', false, NONE, NONE, NONE, NONE, NONE, NONE, NONE]);
  const [cache] = await stack.sql(`SELECT id FROM node WHERE board_id = ${branchId} AND label = 'cache'`);
  await stack.callReducer(agent.token, 'create_edge', [branchId, Number(api.id), Number(cache.id), 'reads', 'agent: read api.ts', NONE, NONE, NONE]);
  await stack.callReducer(agent.token, 'submit_architecture_proposal', [branchId]);
  await expect(row.locator('.branch-row-status')).toHaveText('In review');

  // BR-56: review is a human owner's.
  await expect(stack.callReducer(agent.token, 'review_architecture_proposal', [branchId, 'accept'])).rejects.toThrow(`only an owner of board ${branchId}`);
  await expect(stack.callReducer(agent.token, 'review_architecture_proposal', [branchId, 'reject'])).rejects.toThrow(`only an owner of board ${branchId}`);
  expect(await stack.sql(`SELECT status FROM architecture_version WHERE board_id = ${branchId}`)).toEqual([{ status: 'submitted' }]);
  await expect(row.locator('.branch-row-status')).toHaveText('In review');
  await row.click();
  await expect(owner.locator('#board-title')).toHaveText('Branch · agent-plan');
  await expect(owner.locator('#world')).toContainText('cache');
  await expect(status(owner)).toHaveText('In review');
  await openReview(owner);
  await expect(review(owner).locator('.branch-change')).toHaveCount(2);
  await review(owner).locator('button[data-action="accept"]').click();
  await expect(status(owner)).toHaveText('Accepted');
  await expect(stack.callReducer(agent.token, 'merge_architecture_proposal', [branchId])).rejects.toThrow('architecture proposal merge requires a human owner');
  await expect(status(owner)).toHaveText('Accepted');
  expect(await stack.sql(`SELECT status FROM architecture_version WHERE board_id = ${branchId}`)).toEqual([{ status: 'accepted' }]);
  await act(owner, 'merge', 'Merged');
  await toBase(owner);
  await expect(owner.locator('#world')).toContainText('cache');
  await expect(nodes(owner)).toHaveCount(2);
  await expect(owner.locator('#world g.edge')).toHaveCount(1);
  expect(await labelsOn(stack, B)).toEqual(['api', 'cache']);
  // The agent's own citation survives the merge (only empty evidence becomes human:).
  expect(await stack.sql(`SELECT evidence FROM edge WHERE board_id = ${B}`)).toEqual([{ evidence: 'agent: read api.ts' }]);
});
