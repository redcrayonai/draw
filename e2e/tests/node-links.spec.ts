import type { Page } from '@playwright/test';
import { test, expect, boardLink, nodes, openBoard, palette, shareBoard } from '../fixtures';

// Quick add (client/src/quick-add.ts): a click on a node's side handle offers a connected node or a
// link to another board. A board link is a node that opens the board it names; it shares nothing,
// and someone who cannot open that board sees that there is a link, never which board.

const NONE = { none: [] };
const node = (page: Page, label: string) => nodes(page).filter({ hasText: label }).first();
const edges = (page: Page) => page.locator('#world .layer-edges .edge, #world g.edge');

/** Select a node near its top edge. An external node's body is unfilled and takes no pointer events itself:
 *  the canvas picks by position, so the press only has to land there (and clear of a resting cursor). */
const select = (page: Page, label: string) => node(page, label).click({ position: { x: 70, y: 24 }, force: true });

/** Click (not drag) the handle on one side of a node. Handles show while the pointer is on the node. */
async function clickHandle(page: Page, label: string, side: 'right' | 'bottom') {
  const target = node(page, label);
  const id = await target.getAttribute('data-id');
  await target.hover();
  const handles = page.locator(`#world .edge-handle[data-node-id="${id}"]`);
  await expect(handles).toHaveCount(4);
  const boxes = await handles.evaluateAll(all => all.map(el => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }));
  const pick = boxes.reduce((best, box) => ((side === 'right' ? box.x > best.x : box.y > best.y) ? box : best));
  await page.mouse.move(pick.x, pick.y);
  await page.mouse.down();
  await page.mouse.up();
}

test('a handle click adds a connected node or links a board; the link opens it and back returns', async ({ stack, account, guest }) => {
  test.setTimeout(90_000); // two people, two boards, a dozen steps
  const token = stack.accountToken();
  const stamp = Date.now();
  // No spaces: a label that wraps is drawn as separate lines, and its text then reads without the space.
  const source = `acme-${stamp}`, target = `billing-${stamp}`;
  for (const name of [source, target]) await stack.callReducer(token, 'create_board', [name]);
  const boardId = async (name: string) => Number((await stack.sql(`SELECT id FROM board WHERE name = '${name}'`))[0].id);
  const A = await boardId(source), B = await boardId(target);
  const add = (board: number, label: string) =>
    stack.callReducer(token, 'create_node', [board, label, '', 320, 160, 160, 80, 'ink', false, { some: 'service' }, NONE, NONE, NONE, NONE, NONE, NONE]);
  await add(A, 'api');
  await add(B, 'invoices');

  const page = await account(token);
  page.setDefaultTimeout(10_000);
  await page.goto(await boardLink(stack, A));
  await expect(nodes(page)).toHaveCount(1);
  const menu = page.locator('#quick-add');

  // The menu at the handle offers both; Escape puts it away and adds nothing.
  await clickHandle(page, 'api', 'right');
  await expect(menu.getByRole('menuitem')).toHaveText(['Add connected node', 'Link a board…']);
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(nodes(page)).toHaveCount(1);

  // A connected node: placed on that side, joined by an edge, its name ready to type.
  await clickHandle(page, 'api', 'right');
  await menu.getByRole('menuitem', { name: 'Add connected node' }).click();
  await expect(nodes(page)).toHaveCount(2);
  const edit = page.locator('#inline-edit');
  await expect(edit).toBeVisible();
  await edit.fill('worker');
  await edit.press('Enter');
  await expect(node(page, 'worker')).toBeVisible();
  await expect(page.locator('#world g.edge')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await page.locator('#hud-fit').click(); // a one-node board opens zoomed right in: bring both nodes on screen
  const apiBox = (await node(page, 'api').boundingBox())!, workerBox = (await node(page, 'worker').boundingBox())!;
  expect(workerBox.x).toBeGreaterThan(apiBox.x + apiBox.width);

  // A board link: the palette is the picker, and lists only other boards this person can open.
  await clickHandle(page, 'api', 'right');
  await menu.getByRole('menuitem', { name: 'Link a board…' }).click();
  await expect(page.locator('#palette-ctx')).toHaveText('Link a board');
  await page.locator('#palette-input').fill('billing');
  await expect(page.locator('#palette-list')).toContainText(target);
  await expect(page.locator('#palette-list')).not.toContainText(source);
  await page.keyboard.press('Enter');
  await expect(nodes(page)).toHaveCount(3);
  await expect(page.locator('#world g.edge')).toHaveCount(2);
  const link = node(page, target);
  await expect(link.locator('.node-link')).toHaveCount(1);
  await expect(link.locator('.node-link-private')).toHaveCount(0);
  // It stepped past the node already on that side.
  await page.keyboard.press('Escape');
  await page.locator('#hud-fit').click();
  const linkBox = (await link.boundingBox())!, workerNow = (await node(page, 'worker').boundingBox())!;
  expect(linkBox.y).toBeGreaterThan(workerNow.y + workerNow.height - 1);
  expect(Math.abs(linkBox.x - workerNow.x)).toBeLessThan(2);

  // The board's name is shown, not stored: the node itself is saved as plain "Board".
  await expect(link).toContainText('Board');
  expect((await stack.sql(`SELECT label, sublabel FROM node WHERE board_id = ${A} AND kind = 'external'`))).toEqual([{ label: 'Board', sublabel: '' }]);

  // One step back takes the node, its edge and its link; one step forward brings all three again.
  await page.keyboard.press('ControlOrMeta+z');
  await expect(nodes(page)).toHaveCount(2);
  await expect(page.locator('#world g.edge')).toHaveCount(1);
  expect(await stack.sql(`SELECT node_id FROM node_link WHERE board_id = ${A}`)).toEqual([]);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(nodes(page)).toHaveCount(3);
  await expect(page.locator('#world g.edge')).toHaveCount(2);
  await expect(link.locator('.node-link')).toHaveCount(1);

  // Sharing the board shares no link target: a visitor sees a link to a board they cannot open, unnamed.
  const shared = await shareBoard(page, 'view');
  await page.keyboard.press('Escape');
  const visitor = await guest();
  visitor.setDefaultTimeout(10_000);
  await openBoard(visitor, shared);
  await expect(nodes(visitor)).toHaveCount(3);
  await expect(node(visitor, 'private').locator('.node-link-private')).toHaveCount(1);
  await expect(node(visitor, 'private')).toContainText('Board');
  await select(visitor, 'private');
  await expect(visitor.locator('#tb-open-board')).toHaveText('A board you cannot open');
  // Nowhere on the visitor's page: not the canvas, not the inspector, not a tooltip's text.
  await expect(visitor.locator('body')).not.toContainText(target);
  expect(await visitor.content()).not.toContain(target);
  const seen = await visitor.evaluate(() => [...(window as any).conn.db.visibleNodeLink.iter()].map((row: any) => [String(row.targetBoardId), row.name, row.slug]));
  expect(seen).toEqual([['0', '', '']]);

  // The owner follows the link with the labeled action; the browser's back returns to the board it came from.
  await select(page, target);
  await expect(page.locator('#tb-open-board')).toHaveText(`Open ${target}`);
  await page.locator('#tb-open-board').click();
  await expect(page.locator('#board-title')).toHaveText(target);
  await expect(node(page, 'invoices')).toBeVisible();
  await page.goBack();
  await expect(page.locator('#board-title')).toHaveText(source);
  await expect(nodes(page)).toHaveCount(3);

  // The glyph in the link's corner is clicked to follow it, with nothing selected first. A drag that
  // starts on the glyph moves the node and goes nowhere.
  await page.keyboard.press('Escape');
  const glyph = (await link.locator('.node-link').boundingBox())!, before = (await link.boundingBox())!;
  await page.mouse.move(glyph.x + glyph.width / 2, glyph.y + glyph.height / 2);
  await page.mouse.down();
  await page.mouse.move(glyph.x + glyph.width / 2 + 60, glyph.y + glyph.height / 2 + 40, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator('#board-title')).toHaveText(source);
  await expect.poll(async () => (await link.boundingBox())!.x).toBeGreaterThan(before.x + 30);
  await page.keyboard.press('Escape');
  await link.locator('.node-link').click();
  await expect(page.locator('#board-title')).toHaveText(target);
  await page.goBack();
  await expect(page.locator('#board-title')).toHaveText(source);

  // Enter follows it too; ⌘K removes the link and leaves the node.
  await select(page, target);
  await page.keyboard.press('Enter');
  await expect(page.locator('#board-title')).toHaveText(target);
  await page.goBack();
  await expect(page.locator('#board-title')).toHaveText(source);
  await select(page, target);
  await palette(page, 'Remove the board link');
  await page.keyboard.press('Enter');
  await expect(page.locator('#world .node-link')).toHaveCount(0);
  await expect(nodes(page)).toHaveCount(3);
  await expect(visitor.locator('#world .node-link')).toHaveCount(0);
});
