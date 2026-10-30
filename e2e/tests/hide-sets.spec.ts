import type { Page } from '@playwright/test';
import { test, expect, openBoard, drawNode, drawEdge, shareBoard, boardIdOf, linkedAgent, settledBox, type Stack } from '../fixtures';

// Visible truth (stage 11): hide sets, the rail chips, the counts tooltip and ghost reveal.

const NONE = { none: [] };
const PROMPT = 'prompt: Hide into set (empty = unsorted):';
const REVEAL = 'Click to reveal this set at low opacity';

const shown = (page: Page) => page.locator('#world g.node:not(.ghost)');
const ghosts = (page: Page) => page.locator('#world g.node.ghost');
const ghostLines = (page: Page) => page.locator('#world .edge-line.ghost');
const edges = (page: Page) => page.locator('#world g.edge');
const chips = (page: Page) => page.locator('#chips-row .chip');
const counts = (page: Page) => page.locator('#board-title');
const idsOf = (page: Page) => shown(page).evaluateAll(nodes => nodes.map(node => Number(node.getAttribute('data-id'))));
const setsOf = async (stack: Stack, B: number) => (await stack.sql(`SELECT name FROM hide_set WHERE board_id = ${B}`)).map(row => row.name).sort();
const membersOf = (stack: Stack, id: number) => stack.sql(`SELECT * FROM hide_set_member WHERE target_kind = 'node' AND target_id = ${id}`);

/** Inside the node, clear of its centred label. */
const select = (page: Page, label: string, shift = false) =>
  shown(page).filter({ hasText: label }).locator('.node-rect').click({ position: { x: 12, y: 12 }, modifiers: shift ? ['Shift'] : [] });

/** Click the middle of the n-th drawn edge: its routed path need not pass through its box's centre (edge-style.spec). */
async function selectEdge(page: Page, n: number, shift = false) {
  const hit = page.locator('#world g.edge .edge-hit').nth(n);
  // A reveal pan can still be gliding the board: aim once the edge has stopped moving.
  await settledBox(hit);
  const point = await hit.evaluate(el => {
    const path = el as SVGPathElement;
    const at = path.getPointAtLength(path.getTotalLength() / 2);
    const m = path.getScreenCTM()!;
    return { x: at.x * m.a + at.y * m.c + m.e, y: at.x * m.b + at.y * m.d + m.f };
  });
  if (shift) await page.keyboard.down('Shift');
  await page.mouse.click(point.x, point.y);
  if (shift) await page.keyboard.up('Shift');
}

/** Clicks an inspector hide button and answers its prompt (null = Cancel); returns what the prompt asked. */
async function hide(page: Page, button: string, answer: string | null) {
  const asked = new Promise<string>(resolve => page.once('dialog', async dialog => {
    resolve(`${dialog.type()}: ${dialog.message()}`);
    await (answer === null ? dialog.dismiss() : dialog.accept(answer));
  }));
  await page.locator('#inspector').getByRole('button', { name: button, exact: true }).click();
  return asked;
}

async function hideNode(page: Page, label: string, set: string) {
  await select(page, label);
  await expect(page.locator('#inspector .insp-title')).toHaveText(label);
  expect(await hide(page, 'hide node…', set)).toBe(PROMPT);
  await expect(page.locator('#world')).not.toContainText(label);
}

test('hiding a node into a named set clears it from the canvas and shows a chip and counts; cancel does nothing', async ({ guest, stack }) => {
  test.setTimeout(90_000);
  const owner = await guest();
  await openBoard(owner, stack.url);
  await drawNode(owner, 'web');
  await drawNode(owner, 'orders');
  await drawEdge(owner, 0, 1);
  await owner.keyboard.press('Escape');
  const B = await boardIdOf(stack, owner);
  const [, orders] = await idsOf(owner);
  await expect(owner.locator('#hidden-sets-title')).toBeHidden();
  await expect(owner.locator('#rail > .rail-divider')).toBeHidden(); // no session, nothing hidden: no divider either
  await expect(counts(owner)).toHaveAttribute('title', '2 nodes · 2 shown · 0 hidden — 1 edge · 1 shown · 0 hidden');
  const link = await shareBoard(owner, 'view');
  await owner.keyboard.press('Escape');
  const viewer = await guest();
  await openBoard(viewer, link);
  await expect(shown(viewer)).toHaveCount(2);

  // Cancel: nothing written, nothing moves.
  await select(owner, 'orders');
  expect(await hide(owner, 'hide node…', null)).toBe(PROMPT);
  await expect(shown(owner)).toHaveCount(2);
  await expect(owner.locator('#inspector .insp-title')).toHaveText('orders');
  await expect(chips(owner)).toHaveCount(0);
  await expect(owner.locator('#hidden-sets-title')).toBeHidden();
  expect(await setsOf(stack, B)).toEqual([]);

  expect(await hide(owner, 'hide node…', 'vendor libs')).toBe(PROMPT);
  for (const page of [owner, viewer]) {
    await expect(shown(page)).toHaveCount(1);
    await expect(page.locator('#world')).not.toContainText('orders');
    await expect(page.locator('#hidden-sets-title')).toBeVisible();
    await expect(page.locator('#hidden-sets-title')).toHaveText('Hidden sets');
    await expect(page.locator('#rail > .rail-divider')).toBeVisible();
    await expect(chips(page)).toHaveText(['vendor libs 1']); // the edge it took along is not a member
    await expect(chips(page)).not.toHaveClass(/debt/);
    await expect(chips(page)).toHaveAttribute('title', REVEAL);
    await expect(counts(page)).toHaveAttribute('title', '2 nodes · 1 shown · 1 hidden — 1 edge · 0 shown · 1 hidden');
  }
  await expect(owner.locator('#inspector')).toBeHidden();
  await expect(owner.getByRole('heading', { level: 1 })).toHaveAccessibleDescription(/1 hidden/);
  // The row stays in the database, flagged and in one set.
  expect((await stack.sql(`SELECT hidden FROM node WHERE id = ${orders}`))[0].hidden).toBe(true);
  expect(await setsOf(stack, B)).toEqual(['vendor libs']);
  expect(await membersOf(stack, orders)).toHaveLength(1);

  await chips(owner).click();
  await expect(ghosts(owner)).toHaveCount(1);
  await expect(ghosts(viewer)).toHaveCount(0); // a reveal is the owner's own view
});

test('a blank name lands in unsorted, a repeated name reuses its set, and a multi-selection hides as one set', async ({ guest, stack }) => {
  test.setTimeout(90_000);
  const owner = await guest();
  await openBoard(owner, stack.url);
  await drawNode(owner, 'alpha');
  await drawNode(owner, 'bravo');
  await drawNode(owner, 'charlie');
  const B = await boardIdOf(stack, owner);

  await hideNode(owner, 'alpha', '   ');
  const debt = owner.locator('#chips-row .chip.debt');
  await expect(debt).toHaveText('unsorted 1');
  await expect(debt).toHaveAttribute('title', 'Curation debt — hidden without a named set. Click to reveal at low opacity.');
  await debt.click();
  await expect(ghosts(owner).locator('.ghost-caption')).toHaveText('hidden · unsorted');
  await debt.click();
  await expect(ghosts(owner)).toHaveCount(0);

  // Names compare trimmed: ' vendor libs ' is the same set.
  await hideNode(owner, 'bravo', 'vendor libs');
  await hideNode(owner, 'charlie', ' vendor libs ');
  await expect(chips(owner)).toHaveText(['unsorted 1', 'vendor libs 2']);
  expect(await setsOf(stack, B)).toEqual(['unsorted', 'vendor libs']);

  // drawNode places by the shown count, so these land where the hidden ones were.
  await drawNode(owner, 'cron');
  await drawNode(owner, 'queue');
  await drawNode(owner, 'web');
  await owner.keyboard.press('Escape');
  await select(owner, 'cron');
  await select(owner, 'queue', true);
  await expect(owner.locator('#inspector .insp-title')).toHaveText('2 nodes');
  expect(await hide(owner, 'hide as set…', 'schedulers')).toBe(PROMPT);
  await expect(shown(owner)).toHaveCount(1);
  await expect(shown(owner)).toContainText('web');
  // One chip per set, in name order.
  await expect(chips(owner)).toHaveText(['schedulers 2', 'unsorted 1', 'vendor libs 2']);
  expect(await setsOf(stack, B)).toEqual(['schedulers', 'unsorted', 'vendor libs']);
});

test('a hidden edge leaves the canvas and reveals as a ghost line; several edges hide as one set', async ({ guest, stack }) => {
  test.setTimeout(90_000);
  const owner = await guest();
  await openBoard(owner, stack.url);
  await drawNode(owner, 'web');
  await drawNode(owner, 'api');
  await drawNode(owner, 'db');
  await drawEdge(owner, 0, 1);
  await drawEdge(owner, 1, 2);
  await owner.keyboard.press('Escape');

  await selectEdge(owner, 0);
  expect(await hide(owner, 'hide edge…', 'plumbing')).toBe(PROMPT);
  await expect(edges(owner)).toHaveCount(1);
  await expect(shown(owner)).toHaveCount(3);
  await expect(chips(owner)).toHaveText(['plumbing 1']);
  await expect(counts(owner)).toHaveAttribute('title', '3 nodes · 3 shown · 0 hidden — 2 edges · 1 shown · 1 hidden');
  await chips(owner).click();
  await expect(ghostLines(owner)).toHaveCount(1);
  await chips(owner).click();
  await expect(ghostLines(owner)).toHaveCount(0);

  // A second web → api edge where the hidden one runs, so two edges are selectable.
  await drawEdge(owner, 0, 1);
  await owner.keyboard.press('Escape');
  await expect(edges(owner)).toHaveCount(2);
  await selectEdge(owner, 0);
  await selectEdge(owner, 1, true);
  await expect(owner.locator('#inspector .insp-title')).toHaveText('2 edges');
  expect(await hide(owner, 'hide as set…', 'plumbing')).toBe(PROMPT);
  await expect(edges(owner)).toHaveCount(0);
  await expect(shown(owner)).toHaveCount(3);
  await expect(chips(owner)).toHaveText(['plumbing 3']);
  await expect(counts(owner)).toHaveAttribute('title', '3 nodes · 3 shown · 0 hidden — 3 edges · 0 shown · 3 hidden');
});

test('a chip reveals its set as ghosts and hides it again; a reload keeps the hide but not the reveal', async ({ guest, stack }) => {
  test.setTimeout(90_000);
  const owner = await guest();
  await openBoard(owner, stack.url);
  await drawNode(owner, 'web');
  await drawNode(owner, 'orders');
  await drawNode(owner, 'redis');
  await drawEdge(owner, 0, 1);
  await drawEdge(owner, 1, 2);
  await owner.keyboard.press('Escape');
  await hideNode(owner, 'orders', 'vendor libs');
  await expect(edges(owner)).toHaveCount(0);
  const hiddenCounts = '3 nodes · 2 shown · 1 hidden — 2 edges · 0 shown · 2 hidden';
  await expect(counts(owner)).toHaveAttribute('title', hiddenCounts);

  const chip = chips(owner);
  await chip.click();
  await expect(chip).toHaveClass(/active/);
  await expect(chip).toHaveAttribute('title', 'Click to re-hide this set');
  await expect(ghosts(owner)).toHaveCount(1);
  await expect(ghosts(owner)).toContainText('orders');
  await expect(ghosts(owner).locator('.ghost-caption')).toHaveText('hidden · vendor libs');
  await expect.poll(() => ghosts(owner).evaluate(el => getComputedStyle(el).opacity)).toBe('0.5');
  await expect(ghostLines(owner)).toHaveCount(2); // both edges touch the ghost
  await expect(counts(owner)).toHaveAttribute('title', hiddenCounts); // a reveal is not an unhide
  // Ghosts take no pointer: a click there selects nothing.
  expect(await ghosts(owner).evaluate(el => getComputedStyle(el).pointerEvents)).toBe('none');
  await ghosts(owner).click({ force: true });
  await expect(owner.locator('#inspector')).toBeHidden();

  await chip.click();
  await expect(ghosts(owner)).toHaveCount(0);
  await expect(edges(owner)).toHaveCount(0);
  await expect(chip).not.toHaveClass(/active/);
  await expect(chip).toHaveAttribute('title', REVEAL);

  // The hide is stored; the reveal is not.
  await chip.click();
  await expect(ghosts(owner)).toHaveCount(1);
  await owner.reload();
  await expect(owner.locator('#canvas-wrap')).toHaveAttribute('aria-busy', 'false');
  await expect(owner.locator('#world')).toContainText('redis');
  await expect(owner.locator('#world')).not.toContainText('orders');
  await expect(chips(owner)).toHaveText(['vendor libs 1']);
  await expect(chips(owner)).not.toHaveClass(/active/);
  await expect(ghosts(owner)).toHaveCount(0);
  await expect(counts(owner)).toHaveAttribute('title', hiddenCounts);
});

test('hides reach every open canvas live, while reveals stay local and readers can only reveal', async ({ guest, account, stack }) => {
  test.setTimeout(120_000);
  const owner = await guest();
  await openBoard(owner, stack.url);
  await drawNode(owner, 'web');
  await drawNode(owner, 'api');
  await drawNode(owner, 'orders');
  await drawEdge(owner, 0, 1);
  await owner.keyboard.press('Escape');
  const [web] = await idsOf(owner);
  const link = await shareBoard(owner, 'edit');
  await owner.keyboard.press('Escape');
  const editor = await account();
  await openBoard(editor, link);
  const viewer = await guest(); // a guest on an edit link reads only
  await openBoard(viewer, link);
  await expect(shown(viewer)).toHaveCount(3);

  // The reader inspects a node, a selection and an edge: no hide button anywhere.
  const hideButton = (page: Page) => page.locator('#inspector').getByRole('button', { name: /^hide/ });
  await select(viewer, 'web');
  await expect(viewer.locator('#inspector .insp-title')).toHaveText('web');
  await expect(hideButton(viewer)).toHaveCount(0);
  await select(viewer, 'orders', true);
  await expect(viewer.locator('#inspector .insp-title')).toHaveText('2 nodes');
  await expect(hideButton(viewer)).toHaveCount(0);
  await selectEdge(viewer, 0);
  await expect(viewer.locator('#inspector').getByRole('button', { name: 'copy citation' })).toBeVisible();
  await expect(hideButton(viewer)).toHaveCount(0);
  await viewer.keyboard.press('Escape');
  // ... and the module refuses its hide too.
  const viewerToken = await viewer.evaluate(() => Object.entries(localStorage).find(([key]) => key.startsWith('stdb_token:'))?.[1]);
  expect(viewerToken).toBeTruthy();
  await expect(stack.callReducer(viewerToken!, 'set_node_hidden', [web, true, { some: 'x' }])).rejects.toThrow('not authorized: board is read only');

  await expect(editor.locator('#world')).toContainText('orders');
  await hideNode(owner, 'orders', 'vendor libs');
  for (const page of [editor, viewer]) {
    await expect(page.locator('#world')).not.toContainText('orders');
    await expect(chips(page)).toHaveText(['vendor libs 1']);
    await expect(counts(page)).toHaveAttribute('title', /^3 nodes · 2 shown · 1 hidden/);
  }
  await chips(viewer).click();
  await expect(ghosts(viewer)).toContainText('orders');

  // A new member of a revealed set arrives as a ghost; elsewhere it just leaves.
  await hideNode(owner, 'api', 'vendor libs');
  await expect(chips(viewer)).toHaveText(['vendor libs 2']);
  await expect(chips(viewer)).toHaveClass(/active/);
  await expect(ghosts(viewer)).toHaveCount(2);
  await expect(ghostLines(viewer)).toHaveCount(1);
  await expect(chips(editor)).toHaveText(['vendor libs 2']);
  await expect(shown(editor)).toHaveCount(1);
  await expect(ghosts(editor)).toHaveCount(0);
  // The owner's hide went through the server after the viewer's reveal, so a shared reveal would be here by now.
  await expect(chips(owner)).not.toHaveClass(/active/);
  await expect(ghosts(owner)).toHaveCount(0);

  // One person's reveal is theirs alone.
  await chips(editor).click();
  await expect(ghosts(editor)).toHaveCount(2);
  await expect(chips(owner)).toHaveText(['vendor libs 2']);
  await expect(chips(owner)).not.toHaveClass(/active/);
  await expect(ghosts(owner)).toHaveCount(0);

  // A view-link guest: reveals, cannot hide.
  const B = await boardIdOf(stack, owner);
  await owner.locator('#act-share').click();
  const canView = owner.getByRole('button', { name: 'Can view', exact: true });
  await canView.click();
  await expect(canView).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => stack.sql(`SELECT mode FROM link_share WHERE board_id = ${B}`)).toEqual([{ mode: 'view' }]);
  await owner.keyboard.press('Escape');
  const reader = await guest();
  await openBoard(reader, link);
  await expect(reader.locator('#world')).toContainText('web');
  // Opened after the editor's reveal: it starts unrevealed.
  await expect(chips(reader)).toHaveText(['vendor libs 2']);
  await expect(chips(reader)).not.toHaveClass(/active/);
  await expect(ghosts(reader)).toHaveCount(0);
  await select(reader, 'web');
  await expect(reader.locator('#inspector .insp-title')).toHaveText('web');
  await expect(hideButton(reader)).toHaveCount(0);
  await reader.keyboard.press('Escape');
  await chips(reader).click();
  await expect(ghosts(reader)).toHaveCount(2);
});

test('the server refuses hides from readers and strangers; a refused hide keeps the selection', async ({ account, stack }) => {
  test.setTimeout(120_000);
  const T = stack.accountToken();
  const owner = await account(T);
  await openBoard(owner, `${stack.url}?new=1`);
  await drawNode(owner, 'web');
  await drawNode(owner, 'api');
  await drawEdge(owner, 0, 1);
  await owner.keyboard.press('Escape');
  const B = await boardIdOf(stack, owner);
  const [web, api] = await idsOf(owner);
  const [{ id: edgeId }] = await stack.sql(`SELECT id FROM edge WHERE board_id = ${B}`);
  const link = await shareBoard(owner, 'view');

  const R = stack.accountToken();
  const reader = await account(R);
  await openBoard(reader, link); // records the visit that lets R read
  await expect(reader.locator('#world')).toContainText('api');
  await expect(stack.callReducer(R, 'set_node_hidden', [api, true, { some: 'x' }])).rejects.toThrow('not authorized: board is read only');
  await expect(stack.callReducer(R, 'set_edge_hidden', [Number(edgeId), true, { some: 'x' }])).rejects.toThrow('not authorized: board is read only');
  const S = stack.accountToken();
  await expect(stack.callReducer(S, 'set_node_hidden', [api, true, { some: 'x' }])).rejects.toThrow('not authorized: board is unavailable');
  await expect(stack.callReducer(S, 'set_edge_hidden', [Number(edgeId), true, { some: 'x' }])).rejects.toThrow('not authorized: board is unavailable');
  await expect(owner.locator('#world')).toContainText('api');
  await expect(chips(owner)).toHaveCount(0);
  expect(await setsOf(stack, B)).toEqual([]);

  // The owner downgrades the link while the editor's prompt is open: both ids are refused.
  const canEdit = owner.getByRole('button', { name: 'Can edit', exact: true });
  await canEdit.click();
  await expect(canEdit).toHaveAttribute('aria-pressed', 'true');
  const editor = await account();
  await openBoard(editor, link);
  await select(editor, 'web');
  await select(editor, 'api', true);
  await expect(editor.locator('#inspector .insp-title')).toHaveText('2 nodes');
  editor.once('dialog', async dialog => {
    await stack.callReducer(T, 'set_link_share', [B, 'view', '']);
    await dialog.accept('schedulers');
  });
  await editor.locator('#inspector').getByRole('button', { name: 'hide as set…', exact: true }).click();
  await expect(editor.locator('#error-text')).toContainText('not authorized: board is read only');
  await expect(shown(editor)).toHaveCount(2);
  await expect(editor.locator('#inspector .insp-title')).toHaveText('2 nodes');
  await expect(chips(editor)).toHaveCount(0);
  expect(await membersOf(stack, web)).toEqual([]);
  expect(await membersOf(stack, api)).toEqual([]);
});

test('an unhide restores the row live and removes its chip when nothing else is hidden', async ({ account, stack }) => {
  test.setTimeout(90_000);
  const T = stack.accountToken();
  const owner = await account(T);
  await openBoard(owner, `${stack.url}?new=1`);
  await drawNode(owner, 'web');
  await drawNode(owner, 'orders');
  const [, orders] = await idsOf(owner);
  await hideNode(owner, 'orders', 'vendor libs');
  const link = await shareBoard(owner, 'edit');
  await owner.keyboard.press('Escape');
  const editor = await account();
  await openBoard(editor, link);
  await expect(chips(editor)).toHaveText(['vendor libs 1']);
  await expect(editor.locator('#hidden-sets-title')).toBeVisible();
  await expect(editor.locator('#world')).not.toContainText('orders');

  // No canvas control unhides: this is the MCP hide_node with hidden false.
  await stack.callReducer(T, 'set_node_hidden', [orders, false, NONE]);
  for (const page of [owner, editor]) {
    await expect(page.locator('#world')).toContainText('orders');
    await expect(chips(page)).toHaveCount(0);
    await expect(page.locator('#hidden-sets-title')).toBeHidden();
    await expect(page.locator('#rail > .rail-divider')).toBeHidden();
  }
  expect(await membersOf(stack, orders)).toEqual([]);
});

test('agents hide imported rows but cannot delete them', async ({ account, stack }) => {
  test.setTimeout(90_000);
  const T = stack.accountToken();
  const owner = await account(T);
  await openBoard(owner, `${stack.url}?new=1`);
  await drawNode(owner, 'web');
  await drawNode(owner, 'api');
  const B = await boardIdOf(stack, owner);
  const [web, api] = await idsOf(owner);
  const agent = await linkedAgent(stack, T, B);
  await stack.callReducer(T, 'create_node', [B, 'lodash', '', 300, 600, 160, 80, 'ink', false, NONE, NONE, { some: true }, NONE, NONE, NONE, NONE]);
  await stack.callReducer(T, 'create_edge', [B, web, api, '', 'import', { some: true }, NONE, NONE]);
  const [{ id: lodashId }] = await stack.sql(`SELECT id FROM node WHERE board_id = ${B} AND label = 'lodash'`);
  const [{ id: edgeId }] = await stack.sql(`SELECT id FROM edge WHERE board_id = ${B}`);
  const id = Number(lodashId), edge = Number(edgeId);
  await expect(owner.locator('#world')).toContainText('lodash');
  await expect(edges(owner)).toHaveCount(1);

  await expect(stack.callReducer(agent.token, 'delete_node', [id])).rejects.toThrow(`provenance rule: node ${id} ("lodash") was imported`);
  await stack.callReducer(agent.token, 'set_node_hidden', [id, true, { some: 'vendor libs' }]);
  await expect(owner.locator('#world')).not.toContainText('lodash');
  await expect(chips(owner)).toHaveText(['vendor libs 1']);

  await expect(stack.callReducer(agent.token, 'delete_edge', [edge])).rejects.toThrow(`provenance rule: edge ${edge} was imported`);
  await stack.callReducer(agent.token, 'set_edge_hidden', [edge, true, { some: 'vendor libs' }]);
  await expect(edges(owner)).toHaveCount(0);
  await expect(chips(owner)).toHaveText(['vendor libs 2']);
  // Both rows are still there, hidden.
  expect((await stack.sql(`SELECT hidden FROM node WHERE id = ${id}`))[0].hidden).toBe(true);
  expect((await stack.sql(`SELECT hidden FROM edge WHERE id = ${edge}`))[0].hidden).toBe(true);
});

test('a branch copies hide sets, and switching boards drops any reveal', async ({ guest, stack }) => {
  test.setTimeout(90_000);
  const owner = await guest();
  await openBoard(owner, stack.url);
  await drawNode(owner, 'api');
  await drawNode(owner, 'orders');
  const [, orders] = await idsOf(owner);
  await hideNode(owner, 'orders', 'vendor libs');
  await chips(owner).click();
  await expect(chips(owner)).toHaveClass(/active/);
  await expect(ghosts(owner)).toHaveCount(1);
  const base = owner.url();
  const baseId = await boardIdOf(stack, owner);
  // Marks this document: a reload would drop reveals for the wrong reason.
  await owner.evaluate(() => { (window as any).__sameDocument = true; });
  const sameDocument = () => owner.evaluate(() => (window as any).__sameDocument === true);

  await owner.locator('#branch-chip').click();
  await owner.locator('#branch-pop .branch-new').click();
  await owner.locator('#branch-create #branch-create-name').fill('curated');
  await owner.locator('#branch-create button[type="submit"]').click();
  await expect(counts(owner)).toHaveText('Branch · curated');
  await expect(shown(owner)).toHaveCount(1);
  await expect(chips(owner)).toHaveText(['vendor libs 1']);
  await expect(chips(owner)).not.toHaveClass(/active/);
  await expect(ghosts(owner)).toHaveCount(0);
  await expect(counts(owner)).toHaveAttribute('title', /^2 nodes · 1 shown · 1 hidden/);
  expect(await sameDocument()).toBe(true);
  // The copy's set holds the branch's own orders row, not the base's.
  const branch = await boardIdOf(stack, owner);
  expect(branch).not.toBe(baseId);
  const [{ id: setId }] = await stack.sql(`SELECT id FROM hide_set WHERE board_id = ${branch} AND name = 'vendor libs'`);
  const [{ id: copied }] = await stack.sql(`SELECT id FROM node WHERE board_id = ${branch} AND label = 'orders'`);
  expect(Number(copied)).not.toBe(orders);
  expect((await stack.sql(`SELECT target_id FROM hide_set_member WHERE set_id = ${setId}`)).map(row => Number(row.target_id))).toEqual([Number(copied)]);
  await chips(owner).click();
  await expect(ghosts(owner)).toContainText('orders');
  await expect(ghosts(owner).locator('.ghost-caption')).toHaveText('hidden · vendor libs');

  // Back to the base in the same document: its same-named set starts hidden.
  await owner.evaluate(href => { history.pushState(null, '', href); dispatchEvent(new PopStateEvent('popstate')); }, base);
  await expect(counts(owner)).not.toContainText('Branch ·');
  await expect.poll(() => boardIdOf(stack, owner)).toBe(baseId);
  await expect(owner.locator('#world')).toContainText('api');
  await expect(chips(owner)).toHaveText(['vendor libs 1']);
  await expect(chips(owner)).not.toHaveClass(/active/);
  await expect(ghosts(owner)).toHaveCount(0);
  expect(await sameDocument()).toBe(true);
});
