import type { Page } from '@playwright/test';
import { test, expect, boardLink, fingers, nodes, palette, type Stack } from '../fixtures';

// Stepping inside a frame (client/src/depth.ts): one board read at several depths. A node with nodes
// drawn inside it is a frame; stepping in frames the view on it, dims the rest and shows the depth
// trail on the canvas. Nothing is stored, and nothing about who can read the board changes.

const NONE = { none: [] };
const trail = (page: Page) => page.locator('#depth-trail');
const crumbs = (page: Page) => trail(page).locator('.depth-crumb');
const node = (page: Page, label: string) => nodes(page).filter({ hasText: label }).first();
/** Select a frame by its top-left corner, where nothing drawn inside it reaches. */
const pick = (page: Page, label: string) => node(page, label).click({ position: { x: 8, y: 8 } });

/** Payments holds checkout-api (which holds three handlers), ledger and payments-db; Identity and Search sit outside. */
async function seedDepthBoard(stack: Stack, token: string, name: string) {
  await stack.callReducer(token, 'create_board', [name]);
  const board = Number((await stack.sql(`SELECT id FROM board WHERE name = '${name}'`))[0].id);
  const add = (label: string, kind: string, x: number, y: number, w = 160, h = 80, color: unknown = NONE) =>
    stack.callReducer(token, 'create_node', [board, label, '', x, y, w, h, 'ink', false, { some: kind }, NONE, NONE, NONE, color, NONE, NONE]);
  await add('Payments', 'boundary', 0, 0, 960, 480, { some: 'blue' });
  await add('checkout-api', 'boundary', 48, 96, 432, 304);
  await add('handler', 'service', 96, 176);
  await add('validator', 'service', 288, 176);
  await add('queue', 'service', 96, 288);
  await add('ledger', 'service', 592, 128);
  await add('payments-db', 'datastore', 592, 304);
  await add('Identity', 'service', 1120, 128);
  await add('Search', 'service', 1120, 304);
  const id = Object.fromEntries((await stack.sql(`SELECT id, label FROM node WHERE board_id = ${board}`)).map(row => [String(row.label), Number(row.id)]));
  const edge = (from: string, to: string) => stack.callReducer(token, 'create_edge', [board, id[from], id[to], 'calls', 'human:e2e', NONE, NONE, NONE]);
  await edge('handler', 'validator');
  await edge('validator', 'ledger');
  await edge('ledger', 'payments-db');
  await edge('ledger', 'Identity');
  return board;
}

test('step inside a frame, deeper, and back out: the trail names each level and lights the one in view', async ({ stack, account }) => {
  const token = stack.accountToken();
  const name = `Acme ${Date.now()}`;
  const board = await seedDepthBoard(stack, token, name);
  const page = await account(token);
  await page.goto(await boardLink(stack, board));
  await expect(nodes(page)).toHaveCount(9);
  const dimmed = () => page.locator('#world g.node.depth-out');

  // The two frames carry the layers glyph; plain nodes do not.
  await expect(page.locator('#world g.node .node-layers')).toHaveCount(2);
  await expect(node(page, 'Payments').locator('.node-layers')).toHaveCount(1);
  await expect(node(page, 'Identity').locator('.node-layers')).toHaveCount(0);

  // On the whole board there is no trail, and the action shows only for a frame.
  await expect(trail(page)).toBeHidden();
  await node(page, 'Identity').click();
  await expect(page.locator('#toolbar')).toBeVisible();
  await expect(page.locator('#tb-step-in')).toBeHidden();
  await page.keyboard.press('Escape');
  await page.locator('#hud-fit').click(); // the selection panned the view: bring every frame's corner back on screen
  await pick(page, 'Payments');
  await expect(page.locator('#tb-step-in')).toHaveText('Step inside');

  // Depth 1: the view frames Payments, the rest steps back, the trail lights where we are.
  const zoomBefore = await page.locator('#hud-zoom').textContent();
  await page.locator('#tb-step-in').click();
  await expect(trail(page)).toBeVisible();
  await expect(crumbs(page)).toHaveText([name, 'Payments']);
  await expect(trail(page).locator('[aria-current="location"]')).toHaveText(/Payments/);
  await expect(node(page, 'Payments')).toHaveClass(/depth-frame/);
  await expect(dimmed()).toHaveCount(2); // Identity and Search
  await expect(node(page, 'ledger')).not.toHaveClass(/depth-out/);
  await expect(page.locator('#hud-zoom')).not.toHaveText(zoomBefore!);
  await expect(page.locator('#toolbar')).toBeHidden(); // stepping in puts the selection down

  // What is outside cannot be picked from inside: not by a click, not by a box dragged across it.
  await node(page, 'Identity').click({ force: true });
  await expect(page.locator('#toolbar')).toBeHidden();
  const top = (await node(page, 'Identity').boundingBox())!, bottom = (await node(page, 'Search').boundingBox())!;
  await page.mouse.move(top.x - 24, top.y - 24);
  await page.mouse.down();
  await page.mouse.move(bottom.x + bottom.width + 24, bottom.y + bottom.height + 24, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator('#toolbar')).toBeHidden();
  await expect(page.locator('#world g.node.selected')).toHaveCount(0);

  // Enter after a click on a toolbar control is that control's key, not a step inside the selected frame.
  await pick(page, 'checkout-api');
  await page.locator('#tb-style-menu summary').click();
  await page.keyboard.press('Enter');
  await expect(crumbs(page)).toHaveText([name, 'Payments']);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(page.locator('#toolbar')).toBeHidden();

  // Depth 2 by the keyboard: select the inner frame, Enter.
  await pick(page, 'checkout-api');
  await page.keyboard.press('Enter');
  await expect(crumbs(page)).toHaveText([name, 'Payments', 'checkout-api']);
  await expect(trail(page).locator('[aria-current="location"]')).toHaveText(/checkout-api/);
  await expect(dimmed()).toHaveCount(5); // Payments, ledger, payments-db, Identity, Search
  await expect(node(page, 'handler')).not.toHaveClass(/depth-out/);

  // Each level's dot takes its node's colour: blue for Payments, ink for the uncoloured frame, none for the board.
  const dots = await trail(page).locator('.depth-dot').evaluateAll(all => all.map(dot => (dot as HTMLElement).style.getPropertyValue('--level-color')));
  expect(dots).toEqual(['', 'var(--c-blue)', 'var(--c-ink)']);

  // Esc steps out one level; a crumb jumps to its level; the board's own crumb leaves depth altogether.
  await page.keyboard.press('Escape');
  await expect(crumbs(page)).toHaveText([name, 'Payments']);
  await pick(page, 'checkout-api');
  await page.keyboard.press('Enter');
  await expect(crumbs(page)).toHaveText([name, 'Payments', 'checkout-api']);
  await trail(page).getByRole('button', { name: /Payments/ }).click();
  await expect(crumbs(page)).toHaveText([name, 'Payments']);
  await trail(page).getByRole('button', { name: new RegExp(name) }).click();
  await expect(trail(page)).toBeHidden();
  await expect(dimmed()).toHaveCount(0);
  await expect(page.locator('#world g.node.depth-frame')).toHaveCount(0);

  // The glyph in a frame's corner is pressed to go in, with nothing selected first.
  await node(page, 'checkout-api').locator('.node-layers').click();
  await expect(crumbs(page)).toHaveText([name, 'Payments', 'checkout-api']);
  await crumbs(page).first().click();
  await expect(trail(page)).toBeHidden();

  // So is a double-click on the frame itself; on its name, a double-click still edits the name.
  const frame = (await node(page, 'Payments').locator('.node-rect').boundingBox())!;
  await page.mouse.dblclick(frame.x + 24, frame.y + frame.height - 24); // an empty corner of Payments
  await expect(crumbs(page)).toHaveText([name, 'Payments']);
  await page.keyboard.press('Escape');
  await expect(trail(page)).toBeHidden();
  await node(page, 'Payments').locator('.node-boundary-label').dblclick();
  await expect(page.locator('#inline-edit')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(trail(page)).toBeHidden();

  // The palette offers the same step in and the step back out.
  await pick(page, 'Payments');
  await palette(page, 'Step inside');
  await page.keyboard.press('Enter');
  await expect(crumbs(page)).toHaveText([name, 'Payments']);
  await palette(page, 'Step out');
  await page.keyboard.press('Enter');
  await expect(trail(page)).toBeHidden();
});

test('a frame that stops being one steps the view out, and depth is never part of the board', async ({ stack, account }) => {
  const token = stack.accountToken();
  const name = `Acme ${Date.now()}`;
  const board = await seedDepthBoard(stack, token, name);
  const page = await account(token);
  await page.goto(await boardLink(stack, board));
  await expect(nodes(page)).toHaveCount(9);
  await pick(page, 'checkout-api');
  await page.keyboard.press('Enter');
  await expect(crumbs(page)).toHaveText([name, 'Payments', 'checkout-api']); // stepped two deep in one move

  // Someone deletes the inner frame: the view lands on the frame around it.
  const [inner] = await stack.sql(`SELECT id FROM node WHERE board_id = ${board} AND label = 'checkout-api'`);
  await stack.callReducer(token, 'delete_node', [Number(inner.id)]);
  await expect(crumbs(page)).toHaveText([name, 'Payments']);

  // Another reader of the same board is on the whole board: depth is this tab's view, not shared state.
  const other = await account(token);
  await other.goto(await boardLink(stack, board));
  await expect(nodes(other)).toHaveCount(8);
  await expect(trail(other)).toBeHidden();
  // And a reload starts from the whole board.
  await page.reload();
  await expect(nodes(page)).toHaveCount(8);
  await expect(trail(page)).toBeHidden();
});

test('a frame that is also a board link: each glyph does its own; dimmed edges and a pinch do nothing', async ({ stack, account }) => {
  const token = stack.accountToken();
  const name = `Acme ${Date.now()}`, other = `billing-${Date.now()}`;
  const board = await seedDepthBoard(stack, token, name);
  await stack.callReducer(token, 'create_board', [other]);
  const [target] = await stack.sql(`SELECT id FROM board WHERE name = '${other}'`);
  const id = Object.fromEntries((await stack.sql(`SELECT id, label FROM node WHERE board_id = ${board}`)).map(row => [String(row.label), Number(row.id)]));
  await stack.callReducer(token, 'link_node_board', [id.Payments, Number(target.id)]);
  const page = await account(token);
  await page.goto(await boardLink(stack, board));
  await expect(nodes(page)).toHaveCount(9);
  const payments = node(page, 'Payments');
  await expect(payments.locator('.node-layers')).toHaveCount(1);
  await expect(payments.locator('.node-link')).toHaveCount(1);

  // The layers glyph steps inside, though the node links a board; Enter and a double-click do too.
  await payments.locator('.node-layers').click();
  await expect(crumbs(page)).toHaveText([name, 'Payments']);
  await page.keyboard.press('Escape');
  await expect(trail(page)).toBeHidden();
  await pick(page, 'Payments');
  await page.keyboard.press('Enter');
  await expect(crumbs(page)).toHaveText([name, 'Payments']);
  await expect(page.locator('#board-title')).toHaveText(name);

  // Inside Payments, the edge from ledger out to Identity is dimmed: a press on it selects nothing.
  // The same press on the whole board does select it, so this is the frame's doing.
  const [crossing] = await stack.sql(`SELECT id FROM edge WHERE board_id = ${board} AND from_node = ${id.ledger} AND to_node = ${id.Identity}`);
  const press = async () => {
    const hit = page.locator(`#world .edge-hit[data-edge-id="${crossing.id}"]`);
    await hit.dispatchEvent('pointerdown', { button: 0, pointerId: 7, pointerType: 'mouse', isPrimary: true, bubbles: true, clientX: 5, clientY: 5 });
    await hit.dispatchEvent('pointerup', { button: 0, pointerId: 7, pointerType: 'mouse', isPrimary: true, bubbles: true, clientX: 5, clientY: 5 });
  };
  await press();
  await expect(page.locator('#toolbar')).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(trail(page)).toBeHidden();
  await press();
  await expect(page.locator('#toolbar')).toBeVisible();
  await page.keyboard.press('Escape');

  // A finger on the layers glyph is a tap that steps in; with a second finger down it is a pinch, and steps nowhere.
  const glyph = (await node(page, 'checkout-api').locator('.node-layers').boundingBox())!;
  const on = { x: glyph.x + glyph.width / 2, y: glyph.y + glyph.height / 2 };
  await fingers(page, [0, 20, 40].map(d => [on, { x: on.x + 200 + d, y: on.y + 150 }]));
  await expect(trail(page)).toBeHidden();
  await page.locator('#hud-fit').click(); // the pinch zoomed the board: put the glyph back where a finger can find it
  const again = (await node(page, 'checkout-api').locator('.node-layers').boundingBox())!;
  const tap = { x: again.x + again.width / 2, y: again.y + again.height / 2 };
  await fingers(page, [[tap], [tap]]);
  await expect(crumbs(page)).toHaveText([name, 'Payments', 'checkout-api']);
  await crumbs(page).first().click();
  await expect(trail(page)).toBeHidden();

  // The link glyph opens the board the frame links.
  await payments.locator('.node-link').click();
  await expect(page.locator('#board-title')).toHaveText(other);
});

test('a link followed from inside a frame: one trail across both boards, and a level, Esc and back each return', async ({ stack, account }) => {
  const token = stack.accountToken();
  const name = `Acme ${Date.now()}`, other = `billing-${Date.now()}`;
  const board = await seedDepthBoard(stack, token, name);
  await stack.callReducer(token, 'create_board', [other]);
  const [target] = await stack.sql(`SELECT id FROM board WHERE name = '${other}'`);
  const [ledger] = await stack.sql(`SELECT id FROM node WHERE board_id = ${board} AND label = 'ledger'`);
  await stack.callReducer(token, 'link_node_board', [Number(ledger.id), Number(target.id)]);
  // Far from where the first board's view is looking: carried over unchanged, the view would show none of it.
  await stack.callReducer(token, 'create_node', [Number(target.id), 'far', '', 4000, 3000, 160, 80, 'ink', false, { some: 'service' }, NONE, NONE, NONE, NONE, NONE, NONE]);
  const page = await account(token);
  await page.emulateMedia({ reducedMotion: 'reduce' }); // the view jumps to a frame, so its place can be read at once
  await page.goto(await boardLink(stack, board));
  await expect(nodes(page)).toHaveCount(9);
  const title = page.locator('#board-title');
  const follow = () => node(page, 'ledger').locator('.node-link').click();

  // From inside Payments: the trail runs through the frame, then the board it led to, which is where the view is.
  await pick(page, 'Payments');
  await page.keyboard.press('Enter');
  await expect(crumbs(page)).toHaveText([name, 'Payments']);
  // The view eases into the frame: read where the node is once it has stopped moving.
  let prev = '';
  await expect.poll(async () => { const now = JSON.stringify(await node(page, 'ledger').boundingBox()); const still = now === prev; prev = now; return still; }).toBe(true);
  const left = (await node(page, 'ledger').boundingBox())!;
  await follow();
  await expect(title).toHaveText(other);
  await expect(crumbs(page)).toHaveText([name, 'Payments', other]);
  await expect(trail(page).locator('[aria-current="location"]')).toHaveText(other);
  await expect(node(page, 'far')).toBeInViewport(); // framed like a fresh open, not at the view of the board left

  // Esc steps back out through the link, into the frame the view was in, looking where it was.
  await page.keyboard.press('Escape');
  await expect(title).toHaveText(name);
  await expect(crumbs(page)).toHaveText([name, 'Payments']);
  await expect(node(page, 'Payments')).toHaveClass(/depth-frame/);
  await expect.poll(async () => { const b = (await node(page, 'ledger').boundingBox())!; return [b.x, b.y, b.width].map(Math.round); }).toEqual([left.x, left.y, left.width].map(Math.round));

  // A level of the earlier board goes straight back to it: its first level, the whole board.
  await follow();
  await expect(crumbs(page)).toHaveText([name, 'Payments', other]);
  await crumbs(page).first().click();
  await expect(title).toHaveText(name);
  await expect(trail(page)).toBeHidden();

  // From the whole board the trail is just the two boards, and the browser's back returns the same way.
  await follow();
  await expect(crumbs(page)).toHaveText([name, other]);
  await page.goBack();
  await expect(title).toHaveText(name);
  await expect(trail(page)).toBeHidden();

  // A second click before the board has opened is the same step: one history entry, not two.
  await node(page, 'ledger').locator('.node-link').dblclick();
  await expect(title).toHaveText(other);
  await page.goBack();
  await expect(title).toHaveText(name);
  await page.goBack(); // a second entry for the same step would leave us on this board here
  await expect(page).toHaveURL('about:blank');
  await page.goForward();
  await expect(nodes(page)).toHaveCount(9);

  // A frame deleted while away: coming back steps out to the nearest frame left and frames that, not the view the deeper one was left at.
  const [handler] = await stack.sql(`SELECT id FROM node WHERE board_id = ${board} AND label = 'handler'`);
  await stack.callReducer(token, 'link_node_board', [Number(handler.id), Number(target.id)]);
  await pick(page, 'Payments');
  await page.keyboard.press('Enter');
  await pick(page, 'checkout-api');
  await page.keyboard.press('Enter');
  await expect(crumbs(page)).toHaveText([name, 'Payments', 'checkout-api']);
  await expect(node(page, 'Payments')).not.toBeInViewport({ ratio: 1 }); // the deeper frame is framed closer, so the outer one overflows
  await node(page, 'handler').locator('.node-link').click();
  await expect(title).toHaveText(other);
  const [inner] = await stack.sql(`SELECT id FROM node WHERE board_id = ${board} AND label = 'checkout-api'`);
  await stack.callReducer(token, 'delete_node', [Number(inner.id)]);
  await page.keyboard.press('Escape');
  await expect(title).toHaveText(name);
  await expect(crumbs(page)).toHaveText([name, 'Payments']);
  await expect(node(page, 'Payments')).toBeInViewport({ ratio: 1 }); // framed on Payments, not left at the deleted frame's view
});

test('two boards that link each other: a second Esc does not go back twice, and a level of the board on screen moves the trail', async ({ stack, account }) => {
  const token = stack.accountToken();
  const name = `Acme ${Date.now()}`, other = `billing-${Date.now()}`;
  const board = await seedDepthBoard(stack, token, name);
  await stack.callReducer(token, 'create_board', [other]);
  const [target] = await stack.sql(`SELECT id FROM board WHERE name = '${other}'`);
  await stack.callReducer(token, 'create_node', [Number(target.id), 'home', '', 0, 0, 160, 80, 'ink', false, { some: 'service' }, NONE, NONE, NONE, NONE, NONE, NONE]);
  const [ledger] = await stack.sql(`SELECT id FROM node WHERE board_id = ${board} AND label = 'ledger'`);
  const [home] = await stack.sql(`SELECT id FROM node WHERE board_id = ${target.id} AND label = 'home'`);
  await stack.callReducer(token, 'link_node_board', [Number(ledger.id), Number(target.id)]);
  await stack.callReducer(token, 'link_node_board', [Number(home.id), board]);
  const page = await account(token);
  const title = page.locator('#board-title');
  // A history entry before the trail starts: going back once too often would land on it.
  await page.goto(await boardLink(stack, Number(target.id)));
  await expect(title).toHaveText(other);
  await page.goto(await boardLink(stack, board));
  await page.reload(); // boot on this board, so the view fits it
  await expect(nodes(page)).toHaveCount(9);
  const follow = (label: string) => node(page, label).locator('.node-link').click();

  // The board being left stays on screen while the earlier one loads: Esc pressed again in that time is one step back, not two.
  await follow('ledger');
  await expect(crumbs(page)).toHaveText([name, other]);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(title).toHaveText(name);
  await expect(trail(page)).toBeHidden();
  await expect(nodes(page)).toHaveCount(9);

  // There and back through the links: the board on screen is also the first level. Clicking it drops the levels after it.
  await follow('ledger');
  await follow('home');
  await expect(crumbs(page)).toHaveText([name, other, name]);
  await crumbs(page).first().click();
  await expect(trail(page)).toBeHidden();
  await expect(title).toHaveText(name);

  // The trail and the browser's history still agree: one link in, one Esc out.
  await follow('ledger');
  await expect(crumbs(page)).toHaveText([name, other]);
  await page.keyboard.press('Escape');
  await expect(title).toHaveText(name);
  await expect(trail(page)).toBeHidden();
});
