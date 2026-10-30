import { randomUUID } from 'node:crypto';
import type { Locator, Page } from '@playwright/test';
import { test, expect, openBoard, drawNode, shareBoard, boardIdOf, nodes, chip, status, openReview, fork, settledBox, boardLink, type Stack } from '../fixtures';

// Imported (fact) snapshots: what they refuse and allow, switching and diffing,
// Apply view to history, branches of a snapshot and Check latest import.
// Seeded as an import would be: create_architecture_history, then the service publishes.

const NONE = { none: [] };
const A = 'a'.repeat(40), B = 'b'.repeat(40);
const HINT = 'Factual snapshot. Change the view or create a proposal.';
const HISTORY_RULE = 'architecture boards must be managed through their history';
const LABELS: Record<string, string> = { a: 'gateway', b: 'lodash', c: 'queue' };
const key = (n: string) => `js:src/${n}.ts`;
const graph = (names: string[]) => JSON.stringify({
  nodes: names.map(n => ({ key: key(n), label: LABELS[n], sublabel: '', kind: 'service' })),
  edges: [{ from: key('a'), to: key('b'), label: 'uses', relation: 'import', evidence: 'import' }],
  files: names.map(n => `src/${n}.ts`),
});

const chipName = (page: Page) => chip(page).locator('.branch-name');
const shown = (page: Page) => page.locator('#world g.node:not(.ghost)');
const rail = (page: Page) => page.locator('#architecture-panel');
const nodeEl = (page: Page, id: number) => page.locator(`#world g.node[data-id="${id}"]`);

/** A history pinning main and next, owned by token; publish(i, names) imports ref i as the service and returns its board. */
async function history(stack: Stack, token: string) {
  const svc = await stack.serviceIdentity('e2e-importer');
  const requestKey = randomUUID();
  await stack.callReducer(token, 'create_architecture_history', ['repo', 'https://github.com/example/repo', JSON.stringify([{ ref: 'main', sha: A }, { ref: 'next', sha: B }]), requestKey]);
  const [{ id }] = await stack.sql(`SELECT id FROM architecture_history WHERE request_key = '${requestKey}'`);
  return async (index: 0 | 1, names: string[]) => {
    await stack.callReducer(svc.token, 'publish_architecture_snapshot', [id, index, ['main', 'next'][index], [A, B][index], graph(names)]);
    const rows = await stack.sql(`SELECT * FROM architecture_version WHERE history_id = ${id}`);
    return Number(rows.find(v => v.assertion_mode === 'fact' && Number(v.index) === index)!.board_id);
  };
}

/** The owner on the main snapshot (gateway → lodash), with its node ids by source key. */
async function seedFact(stack: Stack, account: (token?: string, options?: object) => Promise<Page>) {
  const token = stack.accountToken();
  const page = await account(token, { viewport: { width: 1440, height: 900 } });
  const publish = await history(stack, token);
  const F = await publish(0, ['a', 'b']);
  await openBoard(page, await boardLink(stack, F));
  await expect(shown(page)).toHaveCount(2);
  return { token, page, publish, F, ids: await idsByKey(stack, F) };
}

async function idsByKey(stack: Stack, board: number) {
  const rows = await stack.sql(`SELECT id, source_key FROM node WHERE board_id = ${board}`);
  return Object.fromEntries(rows.map(r => [String(r.source_key), Number(r.id)])) as Record<string, number>;
}

const xOf = async (stack: Stack, id: number) => Number((await stack.sql(`SELECT x FROM node WHERE id = ${id}`))[0].x);
const focalOf = async (stack: Stack, id: number) => (await stack.sql(`SELECT focal FROM node WHERE id = ${id}`))[0].focal;
const FOCAL = /(^| )focal( |$)/;

/** Drags a node 160 px right and waits for the database to hold the move; returns its new x. */
async function dragRight(page: Page, stack: Stack, id: number) {
  const x0 = await xOf(stack, id);
  const box = await settledBox(nodeEl(page, id).locator('.node-rect'));
  // Press inside the right edge: a refit can leave the node's centre under the board panel.
  const start = { x: box.x + box.width - 16, y: box.y + box.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 160, start.y, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => xOf(stack, id)).toBeGreaterThan(x0);
  await expect(page.locator('#save-status')).toHaveText('Saved');
  return xOf(stack, id);
}

const select = (node: Locator) => node.locator('.node-rect').click({ position: { x: 12, y: 12 } });

async function act(page: Page, action: 'submit' | 'accept', word: string) {
  await openReview(page);
  await page.locator(`#branch-review button[data-action="${action}"]`).click();
  await expect(page.locator('#branch-review')).toHaveCount(0);
  await expect(status(page)).toHaveText(word);
}

/** Selects the node and answers the rail's Set source key prompt. */
async function setSourceKey(page: Page, node: Locator, value: string) {
  await select(node);
  page.once('dialog', dialog => dialog.accept(value));
  await rail(page).getByRole('button', { name: 'Set source key' }).click();
}

/** The branch adds queue (keyed js:src/c.ts), is submitted and accepted. */
async function acceptedBranch(page: Page, stack: Stack, name: string) {
  await fork(page, name);
  await drawNode(page, 'queue');
  const branch = await boardIdOf(stack, page);
  const queue = nodes(page).filter({ hasText: 'queue' });
  await setSourceKey(page, queue, key('c'));
  await expect.poll(async () => (await idsByKey(stack, branch))[key('c')]).toBeDefined();
  await act(page, 'submit', 'In review');
  await act(page, 'accept', 'Accepted');
  return branch;
}

test('a snapshot shows its ref and commit and refuses graph edits', async ({ account, stack }) => {
  test.setTimeout(60_000);
  const { token, page, F, ids } = await seedFact(stack, account);
  await expect(chipName(page)).toHaveText('main · aaaaaaa');
  await expect(status(page)).toBeEmpty();
  await chip(page).click();
  await expect(page.locator('#branch-pop .branch-new')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#rail-hint')).toHaveText(HINT);

  // The node tool places nothing: 1 does not arm (the hint would read 'armed · service') and the rows are disabled.
  await expect(page.locator('.add-row[data-kind="service"]')).toBeDisabled();
  await page.keyboard.press('1');
  await page.locator('#board').click({ position: { x: 900, y: 500 } });
  await expect(page.locator('#rail-hint')).toHaveText(HINT);
  await page.keyboard.press('Escape');
  await expect(nodes(page)).toHaveCount(2);
  expect(await stack.sql(`SELECT id FROM node WHERE board_id = ${F}`)).toHaveLength(2);

  // The palette offers no duplicate or delete for a selected node.
  await select(nodeEl(page, ids[key('a')]));
  await expect(page.locator('#inspector .insp-title')).toHaveText('gateway');
  await page.keyboard.press('Meta+k');
  await expect(page.locator('#palette-list')).toContainText('Mark focal');
  await expect(page.locator('#palette-list')).not.toContainText('Duplicate selection');
  await expect(page.locator('#palette-list')).not.toContainText('Delete selection');
  await page.keyboard.press('Escape');

  await expect(stack.callReducer(token, 'create_node', [F, 'x', '', 0, 640, 160, 80, 'ink', false, NONE, NONE, NONE, NONE, NONE, NONE, NONE]))
    .rejects.toThrow(/factual snapshots reject graph edits/);
  await expect(stack.callReducer(token, 'delete_node', [ids[key('b')]])).rejects.toThrow(/factual snapshots reject graph edits/);
  expect(await stack.sql(`SELECT id FROM node WHERE board_id = ${F}`)).toHaveLength(2);
});

test('a snapshot keeps presentation edits', async ({ account, stack }) => {
  test.setTimeout(60_000);
  const { page, ids } = await seedFact(stack, account);
  const gateway = nodeEl(page, ids[key('a')]);
  await gateway.dblclick();
  await page.locator('#inline-edit').fill('A curated');
  await page.locator('#inline-edit').press('Enter');
  await expect(page.locator('#save-status')).toHaveText('Saved');
  await expect.poll(async () => (await stack.sql(`SELECT label FROM node WHERE id = ${ids[key('a')]}`))[0].label).toBe('A curated');
  const x1 = await dragRight(page, stack, ids[key('b')]);
  const moved = await nodeEl(page, ids[key('b')]).getAttribute('transform');
  expect(moved).toMatch(new RegExp(`^translate\\(${x1} `));

  await page.reload();
  await expect(page.locator('#world')).toContainText('A curated');
  await expect(nodeEl(page, ids[key('b')])).toHaveAttribute('transform', moved!);
});

test('a snapshot cannot be link-shared, while a branch of it can', async ({ account, stack }) => {
  test.setTimeout(90_000);
  const { token, page, F } = await seedFact(stack, account);
  await expect(chipName(page)).toHaveText('main · aaaaaaa');
  // New branch proves the owner row has loaded, so a hidden Share is a decision, not a late paint.
  await chip(page).click();
  await expect(page.locator('#branch-pop .branch-new')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#act-share')).toBeHidden();
  await expect(stack.callReducer(token, 'set_link_share', [F, 'view', 'ab'.repeat(16)])).rejects.toThrow(HISTORY_RULE);
  expect(await stack.sql(`SELECT * FROM link_share WHERE board_id = ${F}`)).toHaveLength(0);

  await fork(page, 'fb');
  const branch = await boardIdOf(stack, page);
  await expect(page.locator('#act-share')).toBeVisible();
  const link = await shareBoard(page, 'edit');
  await page.keyboard.press('Escape');
  // In review, the owner's dialog offers Accept and Reject: the editor's must not.
  await act(page, 'submit', 'In review');
  await openReview(page);
  await expect(page.locator('#branch-review button[data-action="accept"]')).toBeVisible();
  await expect(page.locator('#branch-review button[data-action="reject"]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#branch-review')).toHaveCount(0);

  // AG-45: a link editor of the branch makes no proposal edits and gets no review controls.
  const editorToken = stack.accountToken();
  const editor = await account(editorToken, { viewport: { width: 1440, height: 900 } });
  await openBoard(editor, link);
  await expect(editor.locator('#board-title')).toHaveText('Branch · fb');
  await expect(status(editor)).toHaveText('In review');
  await expect(nodes(editor)).toHaveCount(2);
  await editor.keyboard.press('1');
  await editor.locator('#board').click({ position: { x: 900, y: 600 } });
  await editor.keyboard.press('Escape');
  await expect(editor.locator('#error-text')).toContainText('architecture rule');
  await expect(nodes(editor)).toHaveCount(2);
  const editorButtons = editor.locator('#branch-review button[data-action]');
  await openReview(editor);
  await expect(editorButtons).toHaveCount(1);
  await expect(editorButtons).toHaveAttribute('data-action', 'cancel');
  await editor.keyboard.press('Escape');
  await expect(editor.locator('#branch-review')).toHaveCount(0);

  // Once accepted, the editor's open page gets no merge or Check latest import either.
  await act(page, 'accept', 'Accepted');
  await expect(status(editor)).toHaveText('Accepted');
  await openReview(editor);
  await expect(editorButtons).toHaveCount(1);
  await expect(editorButtons).toHaveAttribute('data-action', 'cancel');

  const ONLY_OWNER = /only an owner or an agent they shared this board with/;
  await expect(stack.callReducer(editorToken, 'create_node', [branch, 'x', '', 0, 640, 160, 80, 'ink', false, NONE, NONE, NONE, NONE, NONE, NONE, NONE])).rejects.toThrow(ONLY_OWNER);
  await expect(stack.callReducer(editorToken, 'submit_architecture_proposal', [branch])).rejects.toThrow(ONLY_OWNER);
  await expect(stack.callReducer(editorToken, 'review_architecture_proposal', [branch, 'reject'])).rejects.toThrow(`only an owner of board ${branch} can review it`);
  await expect(stack.callReducer(editorToken, 'merge_architecture_proposal', [branch])).rejects.toThrow(`only an owner of board ${branch} can merge it`);
  await expect(stack.callReducer(editorToken, 'reconcile_architecture_proposal', [branch, F])).rejects.toThrow(`only an owner of board ${branch} can reconcile it`);
  expect(await stack.sql(`SELECT id FROM node WHERE board_id = ${branch}`)).toHaveLength(2);
  // The editor's refused edits did not send the branch back to draft.
  expect((await stack.sql(`SELECT status FROM architecture_version WHERE board_id = ${branch}`))[0].status).toBe('accepted');

  // Back on the snapshot, Share goes away again.
  await chip(page).click();
  await page.locator('#branch-pop .branch-row').first().click();
  await expect(chipName(page)).toHaveText('main · aaaaaaa');
  await expect(page.locator('#act-share')).toBeHidden();
});

test('the snapshot menu and timeline switch revisions in place, and Show changes diffs against the previous one', async ({ account, stack }) => {
  test.setTimeout(90_000);
  const { page, publish, ids } = await seedFact(stack, account);
  const next = await publish(1, ['a', 'b', 'c']);
  await page.evaluate(() => { (window as any).__samePage = true; });
  // A move on main gives ⌘Z something to undo there; undo and redo prove ⌘Z reaches it.
  const x0 = await xOf(stack, ids[key('a')]);
  const x1 = await dragRight(page, stack, ids[key('a')]);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => xOf(stack, ids[key('a')])).toBe(x0);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(() => xOf(stack, ids[key('a')])).toBe(x1);
  await expect(page.locator('#inspector .insp-title')).toHaveText('gateway');

  const snapshotSelect = rail(page).getByLabel('Architecture snapshot');
  await snapshotSelect.selectOption({ label: 'next · bbbbbbb' });
  await expect(chipName(page)).toHaveText('next · bbbbbbb');
  await expect(page.locator('#board-title')).toHaveText('repo · next');
  await expect(nodes(page)).toHaveCount(3);
  expect(await boardIdOf(stack, page)).toBe(next);
  await expect(page.locator('#inspector')).toBeHidden();
  // Shortcuts ignore a focused select: blur it so ⌘Z reaches the canvas.
  await snapshotSelect.blur();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(nodes(page)).toHaveCount(3);
  expect(await page.evaluate(() => (window as any).__samePage)).toBe(true);

  // Show changes is off on a snapshot; on, it marks what next added since main.
  const diff = rail(page).locator('.architecture-diff input');
  await expect(diff).not.toBeChecked();
  await expect(page.locator('#world g.node.diff-added')).toHaveCount(0);
  await diff.check();
  await expect(page.locator('#world g.node.diff-added')).toHaveCount(1);
  await expect(page.locator('#world g.node.diff-added')).toContainText('queue');
  await expect(rail(page).locator('.architecture-summary')).toContainText('Nodes +1 −0');

  await rail(page).getByLabel('Architecture timeline').fill('0');
  await expect(chipName(page)).toHaveText('main · aaaaaaa');
  await expect(nodes(page)).toHaveCount(2);
  await expect(rail(page).locator('.architecture-summary')).toHaveText('First snapshot');
  // ⌘Z on next did not reach the move made on main.
  await expect(nodeEl(page, ids[key('a')])).toHaveAttribute('transform', new RegExp(`^translate\\(${x1} `));
  expect(await xOf(stack, ids[key('a')])).toBe(x1);
  expect(await page.evaluate(() => (window as any).__samePage)).toBe(true);
});

test('Apply view to history copies positions, styles and named hide sets to the other snapshots', async ({ account, stack }) => {
  test.setTimeout(90_000);
  const { page, publish, ids } = await seedFact(stack, account);
  const next = await publish(1, ['a', 'b', 'c']);
  const nextIds = await idsByKey(stack, next);
  // Hide first: gateway's drag would land on lodash.
  await select(nodeEl(page, ids[key('b')]));
  await expect(page.locator('#inspector .insp-title')).toHaveText('lodash');
  page.once('dialog', dialog => dialog.accept('vendor libs'));
  await page.locator('#inspector').getByRole('button', { name: 'hide node…', exact: true }).click();
  await expect(page.locator('#world')).not.toContainText('lodash');
  await expect(page.locator('#chips-row .chip')).toHaveText(['vendor libs 1']);
  const x1 = await dragRight(page, stack, ids[key('a')]);
  const t = await nodeEl(page, ids[key('a')]).getAttribute('transform');
  // A style too: the dragged gateway is selected, F marks it focal.
  await expect(page.locator('#inspector .insp-title')).toHaveText('gateway');
  await page.keyboard.press('f');
  await expect(nodeEl(page, ids[key('a')])).toHaveClass(FOCAL);
  await expect.poll(() => focalOf(stack, ids[key('a')])).toBe(true);
  expect(await xOf(stack, nextIds[key('a')])).not.toBe(x1);
  expect(await focalOf(stack, nextIds[key('a')])).toBe(false);
  expect((await stack.sql(`SELECT hidden FROM node WHERE id = ${nextIds[key('b')]}`))[0].hidden).toBe(false);

  await rail(page).getByRole('button', { name: 'Apply view to history' }).click();
  await expect.poll(() => xOf(stack, nextIds[key('a')])).toBe(x1);
  expect(await focalOf(stack, nextIds[key('a')])).toBe(true);

  await rail(page).getByLabel('Architecture snapshot').selectOption({ label: 'next · bbbbbbb' });
  await expect(chipName(page)).toHaveText('next · bbbbbbb');
  await expect(page.locator('#world')).toContainText('queue');
  await expect(nodeEl(page, nextIds[key('a')])).toHaveAttribute('transform', t!);
  await expect(nodeEl(page, nextIds[key('a')])).toHaveClass(FOCAL);
  await expect(shown(page)).toHaveCount(2);
  await expect(page.locator('#world')).not.toContainText('lodash');
  await expect(page.locator('#chips-row .chip')).toHaveText(['vendor libs 1']);
  expect((await stack.sql(`SELECT hidden FROM node WHERE id = ${nextIds[key('b')]}`))[0].hidden).toBe(true);
});

test('a branch of a snapshot keeps its source keys, styles, files and history controls, and takes new source keys', async ({ account, stack }) => {
  test.setTimeout(90_000);
  const { page, ids } = await seedFact(stack, account);
  // A style on the snapshot, for the fork to carry.
  await select(nodeEl(page, ids[key('a')]));
  await expect(page.locator('#inspector .insp-title')).toHaveText('gateway');
  await page.keyboard.press('f');
  await expect.poll(() => focalOf(stack, ids[key('a')])).toBe(true);
  await fork(page, 'fb');
  const branch = await boardIdOf(stack, page);
  await expect(nodes(page)).toHaveCount(2);
  await expect(page.locator('#world g.edge')).toHaveCount(1);
  const keys = async () => Object.keys(await idsByKey(stack, branch)).sort();
  expect(await keys()).toEqual([key('a'), key('b')]);
  const branchIds = await idsByKey(stack, branch);
  await expect(nodeEl(page, branchIds[key('a')])).toHaveClass(FOCAL);
  expect(await focalOf(stack, branchIds[key('a')])).toBe(true);
  expect(await focalOf(stack, branchIds[key('b')])).toBe(false);
  expect((await stack.sql(`SELECT path FROM repo_file WHERE board_id = ${branch}`)).map(r => r.path).sort()).toEqual(['src/a.ts', 'src/b.ts']);
  await expect(rail(page).getByLabel('Architecture snapshot')).toBeVisible();
  await expect(rail(page).getByLabel('Architecture snapshot').locator('option')).toHaveText(['main · aaaaaaa']);
  await expect(rail(page).getByLabel('Architecture branch').locator('option')).toContainText(['fb · Draft']);

  // BR-68: a new node takes a source key from the rail; a key already on the board is refused.
  await drawNode(page, 'queue');
  const queue = nodes(page).filter({ hasText: 'queue' });
  await setSourceKey(page, queue, key('c'));
  await expect.poll(keys).toEqual([key('a'), key('b'), key('c')]);
  await expect(rail(page).locator('.architecture-actions small')).toHaveText(key('c'));
  await setSourceKey(page, queue, key('a'));
  await expect(page.locator('#error-text')).toContainText('architecture source key already exists');
  expect(await keys()).toEqual([key('a'), key('b'), key('c')]);
});

test('an accepted snapshot branch is checked against a newer import, not merged', async ({ account, stack }) => {
  test.setTimeout(120_000);
  const { token, page, publish, F } = await seedFact(stack, account);
  const branch = await acceptedBranch(page, stack, 'fb');
  await openReview(page);
  const review = page.locator('#branch-review');
  await expect(review.locator('button[data-action="reconcile"]')).toHaveText('Check latest import');
  await expect(review.locator('button[data-action="merge"]')).toHaveCount(0);
  await review.locator('button[data-action="reconcile"]').click();
  await expect(review.locator('[role="alert"]')).toHaveText('Import a new ref before checking this branch.');
  await expect(stack.callReducer(token, 'merge_architecture_proposal', [branch])).rejects.toThrow(/newer import, not merged/);
  await page.keyboard.press('Escape');
  await expect(review).toHaveCount(0);
  await expect(status(page)).toHaveText('Accepted');

  // next imports queue: the check marks the branch Merged.
  await publish(1, ['a', 'b', 'c']);
  await openReview(page);
  await review.locator('button[data-action="reconcile"]').click();
  await expect(review).toHaveCount(0);
  await expect(status(page)).toHaveText('Merged');
  expect((await stack.sql(`SELECT status FROM architecture_version WHERE board_id = ${branch}`))[0].status).toBe('implemented');

  // A second branch of main wants a node next does not have: refused in the dialog.
  const requestKey = randomUUID();
  await stack.callReducer(token, 'create_architecture_proposal', [F, 'fb2', requestKey]);
  const other = Number((await stack.sql(`SELECT * FROM architecture_version WHERE request_key = '${requestKey}'`))[0].board_id);
  await stack.callReducer(token, 'create_node', [other, 'dash', '', 0, 640, 160, 80, 'ink', false, NONE, NONE, NONE, NONE, NONE, NONE, NONE]);
  const dashId = Object.entries(await idsByKey(stack, other)).find(([k]) => k.startsWith('proposal:'))![1];
  await stack.callReducer(token, 'set_architecture_node_key', [dashId, 'js:src/d.ts']);
  await stack.callReducer(token, 'submit_architecture_proposal', [other]);
  await stack.callReducer(token, 'review_architecture_proposal', [other, 'accept']);
  await openBoard(page, await boardLink(stack, other));
  await expect(status(page)).toHaveText('Accepted');
  await openReview(page);
  await review.locator('button[data-action="reconcile"]').click();
  await expect(review.locator('[role="alert"]')).toContainText('not satisfied by this snapshot');
  expect((await stack.sql(`SELECT status FROM architecture_version WHERE board_id = ${other}`))[0].status).toBe('accepted');
});

test('library picks are refused on a snapshot', async ({ account, stack }) => {
  test.setTimeout(60_000);
  const { token, page, F } = await seedFact(stack, account);
  await page.keyboard.press('l');
  const search = page.getByRole('searchbox', { name: 'Search the library' });
  await search.fill('stat');
  await search.press('Enter');
  await expect(page.locator('#error-text')).toHaveText(HINT);
  await page.locator('#board').click({ position: { x: 900, y: 600 } });
  await expect(nodes(page)).toHaveCount(2);
  await expect(page.locator('#world g.node.node-chart')).toHaveCount(0);
  expect(await stack.sql(`SELECT node_id FROM chart WHERE board_id = ${F}`)).toHaveLength(0);

  // An icon pick is refused the same way: dismiss the strip so the refusal must show it again.
  await page.locator('#error-dismiss').click();
  await expect(page.locator('#error-strip')).toBeHidden();
  await page.keyboard.press('l');
  await search.fill('k8s');
  await search.press('Enter');
  await expect(page.locator('#error-strip')).toBeVisible();
  await expect(page.locator('#error-text')).toHaveText(HINT);
  await page.locator('#board').click({ position: { x: 900, y: 600 } });
  await expect(nodes(page)).toHaveCount(2);
  await expect(page.getByRole('img', { name: 'Kubernetes' })).toHaveCount(0);
  expect(await stack.sql(`SELECT node_id FROM node_icon WHERE board_id = ${F}`)).toHaveLength(0);
  await expect(stack.callReducer(token, 'create_chart', [F, 'Latency', 'ms', 0, 320, 320, 192, 'bars', 'route,p50\n/a,12', NONE, NONE]))
    .rejects.toThrow('charts are not supported on architecture boards yet');
  await expect(stack.callReducer(token, 'create_icon_node', [F, 'k8s', '', 0, 640, 160, 80, 'ink', false, NONE, NONE, NONE, NONE, NONE, NONE, NONE, 'kubernetes']))
    .rejects.toThrow('icons are not supported on architecture boards yet');
});
