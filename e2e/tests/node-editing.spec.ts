import type { Page } from '@playwright/test';
import { test, expect, openBoard, drawNode, shareBoard, boardIdOf, serverCaughtUp, pick, guestToken, nodes, settledBox, type Stack } from '../fixtures';

// Placing and editing nodes on the canvas: arming, labels, styles, kinds, focal, undo, read-only.

const NONE = { none: [] };
const READ_ONLY = 'not authorized: board is read only';
const nodeEl = (page: Page, id: number) => page.locator(`#world g[data-id="${id}"]`);
const lastId = async (page: Page) => Number(await nodes(page).last().getAttribute('data-id'));
const rowsOn = (stack: Stack, board: number, columns = '*') => stack.sql(`SELECT ${columns} FROM node WHERE board_id = ${board}`);

/** Press a kind key and click the board there: the kind stays armed until Escape. */
async function place(page: Page, key: string, x: number, y: number) {
  await page.keyboard.press(key);
  await page.locator('#board').click({ position: { x, y } });
}

/** The drawn rect's corner radius and half its width: equal for an ellipse. */
const corners = (page: Page, id: number) => nodeEl(page, id).locator('.node-rect').evaluate(el => ({
  rx: Number(el.getAttribute('rx')),
  half: Number(el.getAttribute('width')) / 2,
}));

/** A colour token resolved in the current theme, comparable with a computed fill. */
const tokenColor = (page: Page, name: string) => page.evaluate(value => {
  const probe = document.body.appendChild(document.createElement('span'));
  probe.style.color = `var(--${value})`;
  const rgb = getComputedStyle(probe).color;
  probe.remove();
  return rgb;
}, name);

test('an armed kind keeps placing until Esc', async ({ guest, stack }) => {
  const page = await guest();
  await openBoard(page, `${stack.url}?new=1`);
  const board = await boardIdOf(stack, page);
  const service = page.locator('.add-row[data-kind="service"]');

  // CV-76: an empty board offers its first node, and the offer arms the service tool.
  await expect(page.locator('#empty-state')).toBeVisible();
  await page.locator('#empty-place').click();
  await expect(service).toHaveClass(/armed/);
  await expect(page.locator('#rail-hint')).toContainText('armed · service');
  await expect(page.locator('#rail-hint')).toContainText('keep clicking to place more');

  // CV-01: every click places another node while the kind stays armed.
  await page.locator('#board').click({ position: { x: 500, y: 220 } });
  await expect(nodes(page)).toHaveCount(1);
  await expect(page.locator('#empty-state')).toBeHidden();
  await page.locator('#board').click({ position: { x: 800, y: 220 } });
  await expect(nodes(page)).toHaveCount(2);
  await expect(service).toHaveClass(/armed/);

  // Esc hands back the select tool: a click on empty canvas places nothing.
  await page.keyboard.press('Escape');
  await expect(page.locator('#tool-select')).toHaveClass(/armed/);
  await expect(service).not.toHaveClass(/armed/);
  await expect(page.locator('#board')).not.toHaveClass(/armed/);
  await page.locator('#board').click({ position: { x: 650, y: 450 } });
  await expect(nodes(page)).toHaveCount(2);
  await expect(page.locator('#save-status')).toHaveText('Saved');
  expect(await rowsOn(stack, board, 'id')).toHaveLength(2);

  // Key 1 arms the same tool, and pressing it again puts it down.
  await page.keyboard.press('1');
  await expect(service).toHaveClass(/armed/);
  await page.keyboard.press('1');
  await expect(page.locator('#tool-select')).toHaveClass(/armed/);
  await expect(service).not.toHaveClass(/armed/);

  await page.reload();
  await expect(nodes(page)).toHaveCount(2);
});

test('label edits cancel on Esc, save live on Enter, and undo and redo', async ({ guest, account, stack }) => {
  test.setTimeout(90_000);
  const owner = await guest();
  await openBoard(owner, `${stack.url}?new=1`);
  await drawNode(owner, 'api');
  const id = await lastId(owner);
  const board = await boardIdOf(stack, owner);
  const link = await shareBoard(owner, 'edit');
  await owner.keyboard.press('Escape');
  const editor = await account();
  await openBoard(editor, link);
  await expect(editor.locator('#world')).toContainText('api');
  const label = (page: Page) => nodeEl(page, id).locator('[data-field="label"]');
  const edit = owner.locator('#inline-edit');

  // CV-12: Esc drops the draft.
  await label(owner).dblclick();
  await edit.fill('gateway');
  await edit.press('Escape');
  await expect(edit).toHaveCount(0);
  // A label renders only once the server acks it, so read the row: a write would hold Saved back first.
  await expect(owner.locator('#save-status')).toHaveText('Saved');
  expect((await stack.sql(`SELECT label FROM node WHERE id = ${id}`))[0].label).toBe('api');
  await expect(label(owner)).toHaveText('api');

  // Enter saves, and the collaborator sees it without a reload.
  await label(owner).dblclick();
  await edit.fill('gateway');
  await edit.press('Enter');
  await expect(label(owner)).toHaveText('gateway');
  await expect(label(editor)).toHaveText('gateway');

  // One ⌘Z takes the rename back for everyone; ⌘⇧Z puts it back.
  await owner.keyboard.press('ControlOrMeta+z');
  await expect(label(owner)).toHaveText('api');
  await expect(label(editor)).toHaveText('api');
  await owner.keyboard.press('ControlOrMeta+Shift+z');
  await expect(label(owner)).toHaveText('gateway');
  await expect(label(editor)).toHaveText('gateway');

  // CV-13: the sublabel has its own editor and leaves the label alone.
  await nodeEl(owner, id).locator('.node-sublabel').dblclick();
  await expect(edit).toHaveClass(/sublabel/);
  await expect(edit).toHaveValue('svc');
  await edit.fill('payments-svc');
  await edit.press('Enter');
  await expect(nodeEl(owner, id).locator('.node-sublabel')).toHaveText('payments-svc');
  await expect(label(owner)).toHaveText('gateway');
  await expect(nodeEl(editor, id).locator('.node-sublabel')).toHaveText('payments-svc');

  // CV-15: a boundary heading edits in a one-line input.
  await place(owner, '4', 300, 360);
  await owner.keyboard.press('Escape');
  const heading = owner.locator('#world g.node-boundary .node-boundary-label');
  await expect(heading).toHaveText('boundary');
  await heading.dblclick();
  await expect(owner.locator('input#inline-edit.boundary')).toBeVisible();
  await edit.fill('core services');
  await edit.press('Enter');
  await expect(heading).toHaveText('core services');
  await expect(editor.locator('#world g.node-boundary .node-boundary-label')).toHaveText('core services');

  await expect(owner.locator('#save-status')).toHaveText('Saved');
  expect((await rowsOn(stack, board, 'label, sublabel, kind')).map(r => [r.label, r.sublabel, r.kind]).sort()).toEqual([
    ['core services', '', 'boundary'],
    ['gateway', 'payments-svc', 'service'],
  ]);
  await owner.reload();
  await expect(label(owner)).toHaveText('gateway');
  await expect(nodeEl(owner, id).locator('.node-sublabel')).toHaveText('payments-svc');
  await expect(heading).toHaveText('core services');
});

test("an open label editor never overwrites a collaborator's concurrent change", async ({ account, stack }) => {
  const token = stack.accountToken();
  const page = await account(token);
  await openBoard(page, `${stack.url}?new=1`);
  await drawNode(page, 'api');
  const id = await lastId(page);

  // A's editor is open with a draft when B (the same person elsewhere) restyles the node.
  await nodeEl(page, id).locator('[data-field="label"]').dblclick();
  const edit = page.locator('#inline-edit');
  await edit.fill('gateway');
  await stack.callReducer(token, 'update_node', [id, NONE, { some: 'edge tier' }, NONE, NONE, NONE, NONE, { some: 'blue' }, NONE, NONE]);
  await expect(nodeEl(page, id)).toHaveClass(/color-blue/);
  await expect(edit).toHaveValue('gateway');
  await edit.press('Enter');

  await expect.poll(async () => (await stack.sql(`SELECT label, sublabel, color FROM node WHERE id = ${id}`))[0])
    .toEqual({ label: 'gateway', sublabel: 'edge tier', color: 'blue' });
  await expect(nodeEl(page, id)).toContainText('gateway');
  await expect(nodeEl(page, id)).toContainText('edge tier');
  await expect(nodeEl(page, id)).toHaveClass(/color-blue/);
});

test('node colour, size, line and shape apply at once, live, persist and undo', async ({ guest, account, stack }) => {
  test.setTimeout(90_000);
  const owner = await guest();
  await openBoard(owner, `${stack.url}?new=1`);
  await drawNode(owner, 'api');
  const id = await lastId(owner);
  const link = await shareBoard(owner, 'edit');
  await owner.keyboard.press('Escape');
  const editor = await account();
  await openBoard(editor, link);
  await expect(editor.locator('#world')).toContainText('api');

  await nodeEl(owner, id).click();
  await expect(owner.locator('#toolbar')).toBeVisible();
  await owner.locator('#tb-color-menu summary').click();
  // CV-32: the Default swatch is an edge colour; a node's menu leaves it out.
  await expect(owner.locator('#tb-swatches [data-color="red"]')).toBeVisible();
  await expect(owner.locator('#tb-swatches [data-color=""]')).toHaveCount(1);
  await expect(owner.locator('#tb-swatches [data-color=""]')).toBeHidden();
  await pick(owner, 'color', '[data-color="red"]');
  await owner.locator('#tb-color-menu summary').click();
  await owner.locator('#tb-size [data-size="l"]').click();
  await pick(owner, 'style', '#tb-stroke [data-stroke="dashed"]');
  // CV-32: a node selection hides the edge-only controls and shows the node ones.
  await expect(owner.locator('#tb-stroke [data-stroke="dashed"]')).toBeVisible();
  await expect(owner.locator('#tb-stroke [data-stroke="dotted"]')).toHaveCount(1);
  await expect(owner.locator('#tb-stroke [data-stroke="dotted"]')).toBeHidden();
  await expect(owner.locator('#tb-weight')).toHaveCount(1);
  await expect(owner.locator('#tb-weight')).toBeHidden();
  await expect(owner.locator('#tb-reset-style')).toHaveCount(1);
  await expect(owner.locator('#tb-reset-style')).toBeHidden();
  await expect(owner.locator('#tb-kind')).toBeVisible();
  await pick(owner, 'style', '#tb-shape [data-shape="ellipse"]');

  // CV-18: the owner sees each at once; the collaborator without reloading.
  for (const page of [owner, editor]) {
    await expect(nodeEl(page, id)).toHaveClass(/color-red/);
    await expect(nodeEl(page, id)).toHaveClass(/size-l/);
    await expect(nodeEl(page, id)).toHaveClass(/stroke-dashed/);
    await expect.poll(async () => { const c = await corners(page, id); return c.rx === c.half && c.rx > 10; }).toBe(true);
  }

  // Each control is its own undo step: ⌘Z takes back only the shape.
  await owner.keyboard.press('ControlOrMeta+z');
  for (const page of [owner, editor]) await expect.poll(async () => (await corners(page, id)).rx).toBe(10);
  await expect(nodeEl(owner, id)).toHaveClass(/stroke-dashed/);
  await expect(nodeEl(owner, id)).toHaveClass(/size-l/);
  await expect(nodeEl(owner, id)).toHaveClass(/color-red/);

  await expect(owner.locator('#save-status')).toHaveText('Saved');
  await owner.reload();
  await expect(owner.locator('#world')).toContainText('api');
  await expect(nodeEl(owner, id)).toHaveClass(/color-red/);
  await expect(nodeEl(owner, id)).toHaveClass(/size-l/);
  await expect(nodeEl(owner, id)).toHaveClass(/stroke-dashed/);
  expect((await corners(owner, id)).rx).toBe(10);
});

test('styles survive duplicate and delete-undo', async ({ account, stack }) => {
  const token = stack.accountToken();
  const page = await account(token);
  await openBoard(page, `${stack.url}?new=1`);
  await drawNode(page, 'api');
  const id = await lastId(page);
  const board = await boardIdOf(stack, page);
  await stack.callReducer(token, 'update_node', [id, NONE, NONE, NONE, { some: true }, NONE, { some: 'pill' }, { some: 'green' }, { some: 'dashed' }, { some: 'l' }]);
  await expect(nodeEl(page, id)).toHaveClass(/focal/);
  await expect(nodeEl(page, id)).toHaveClass(/color-green/);
  const [orig] = await stack.sql(`SELECT x, y FROM node WHERE id = ${id}`);
  const style = 'x, y, color, shape, stroke_style, size, focal';
  const styled = (x: unknown, y: unknown, focal: boolean) => ({ x: Number(x), y: Number(y), color: 'green', shape: 'pill', stroke_style: 'dashed', size: 'l', focal });

  const read = async (where: string) => (await stack.sql(`SELECT ${style} FROM node WHERE board_id = ${board}${where}`))
    .map(r => ({ ...r, x: Number(r.x), y: Number(r.y) }));

  // Delete it while it is alone (a later copy overlaps it), then ⌘Z brings it back styled.
  await nodeEl(page, id).click();
  await page.keyboard.press('Delete');
  await expect(nodes(page)).toHaveCount(0);
  await expect.poll(() => read('')).toEqual([]);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(nodes(page)).toHaveCount(1);
  await expect.poll(() => read('')).toEqual([styled(orig.x, orig.y, true)]);
  await expect(page.locator('#world g.node.focal.color-green')).toHaveCount(1);

  // ⌘D: a copy 16 px down-right with the style, never focal.
  await nodes(page).first().click();
  await page.keyboard.press('ControlOrMeta+d');
  await expect(nodes(page)).toHaveCount(2);
  await expect.poll(() => read(' AND focal = false')).toEqual([styled(Number(orig.x) + 16, Number(orig.y) + 16, false)]);
  await expect.poll(() => read(' AND focal = true')).toEqual([styled(orig.x, orig.y, true)]);
});

test('each kind draws its own mark, and the kind cycle reaches a collaborator', async ({ guest, stack }) => {
  test.setTimeout(90_000);
  const owner = await guest();
  await openBoard(owner, `${stack.url}?new=1`);
  await drawNode(owner, 'db');
  const db = await lastId(owner);

  // CV-21: keys 2–5 place a datastore, an external, a boundary and a note.
  await place(owner, '2', 300, 220);
  await place(owner, '3', 720, 220);
  await place(owner, '4', 300, 360);
  await place(owner, '5', 680, 380);
  await owner.locator('#inline-edit').press('Enter'); // a new note opens its editor
  await owner.keyboard.press('Escape');
  await expect(nodes(owner)).toHaveCount(5);
  await expect(owner.locator('#world g.node-datastore .node-rule')).toHaveCount(1);
  await expect(owner.locator('#world g.node-external .node-glyph')).toHaveCount(1);
  await expect(owner.locator('#world g.node-boundary .node-boundary-label')).toHaveText('boundary');
  await expect(owner.locator('#world g.node-note .note-eyebrow')).toHaveText('NOTE');

  // CV-23: the toolbar kind cycle, seen live by a view-link reader.
  const link = await shareBoard(owner, 'view');
  await owner.keyboard.press('Escape');
  const viewer = await guest();
  await openBoard(viewer, link);
  await expect(nodeEl(viewer, db)).toHaveClass(/node-service/);
  await nodeEl(owner, db).click();
  await owner.locator('#tb-style-menu summary').click();
  await expect(owner.locator('#tb-kind')).toHaveText('service');
  await owner.locator('#tb-kind').click();
  await expect(owner.locator('#tb-kind')).toHaveText('datastore');
  await expect(nodeEl(viewer, db)).toHaveClass(/node-datastore/);
  await expect(nodeEl(viewer, db).locator('.node-rule')).toHaveCount(1);
  await expect.poll(async () => (await stack.sql(`SELECT kind FROM node WHERE id = ${db}`))[0].kind).toBe('datastore');
  // The rest of the cycle comes back round to service, then on to datastore again.
  for (const kind of ['external', 'boundary', 'note', 'text', 'service', 'datastore']) {
    await owner.locator('#tb-kind').click();
    await expect(owner.locator('#tb-kind')).toHaveText(kind);
    await expect(nodeEl(viewer, db)).toHaveClass(new RegExp(`node-${kind}`));
  }
  await expect.poll(async () => (await stack.sql(`SELECT kind FROM node WHERE id = ${db}`))[0].kind).toBe('datastore');
  await owner.reload();
  await expect(nodeEl(owner, db)).toHaveClass(/node-datastore/);
});

test('a third focal node is refused, and a multi-node change is one undo step', async ({ guest, stack }) => {
  const page = await guest();
  await openBoard(page, `${stack.url}?new=1`);
  for (const label of ['a', 'b', 'c']) await drawNode(page, label);
  const board = await boardIdOf(stack, page);
  await page.keyboard.press('Escape');
  await expect(page.locator('#toolbar')).toBeHidden();

  // Marquee from empty canvas above-left of a to inside c: it touches all three.
  const first = await settledBox(nodes(page).first().locator('.node-rect'));
  const last = await settledBox(nodes(page).last().locator('.node-rect'));
  await page.mouse.move(first.x - 30, first.y - 30);
  await page.mouse.down();
  await page.mouse.move(last.x + 20, last.y + 20, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator('#toolbar')).toBeVisible();

  // CV-22: two land, the third meets the focal limit.
  await page.keyboard.press('f');
  await expect(page.locator('#error-text')).toContainText('focal limit');
  const focal = page.locator('#world g.node.focal');
  await expect(focal).toHaveCount(2);
  await expect.poll(async () => (await rowsOn(stack, board, 'focal')).filter(r => r.focal === true).length).toBe(2);
  const fill = await focal.first().locator('.node-rect').evaluate(el => getComputedStyle(el).fill);
  expect(fill).toBe(await tokenColor(page, 'accent-soft'));
  expect(fill).not.toBe(await tokenColor(page, 'paper'));
  await page.keyboard.press('ControlOrMeta+z');
  await expect(focal).toHaveCount(0);
  await expect.poll(async () => (await rowsOn(stack, board, 'focal')).filter(r => r.focal === true).length).toBe(0);

  // CV-37: colour on all three, then a single ⌘Z clears all three.
  await pick(page, 'color', '[data-color="red"]');
  await expect(page.locator('#world g.node.color-red')).toHaveCount(3);
  await expect.poll(async () => (await rowsOn(stack, board, 'color')).map(r => r.color)).toEqual(['red', 'red', 'red']);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.locator('#world g.node.color-red')).toHaveCount(0);
  await expect(nodes(page)).toHaveCount(3);
  await expect.poll(async () => (await rowsOn(stack, board, 'color')).map(r => r.color)).toEqual(['', '', '']);
});

test('a view-link visitor can select and inspect but not edit a node', async ({ guest, stack }) => {
  test.setTimeout(90_000);
  const owner = await guest();
  await openBoard(owner, `${stack.url}?new=1`);
  await drawNode(owner, 'ledger');
  const id = await lastId(owner);
  const board = await boardIdOf(stack, owner);
  const link = await shareBoard(owner, 'view');
  await owner.keyboard.press('Escape');
  const viewer = await guest();
  await openBoard(viewer, link);
  await expect(nodeEl(viewer, id)).toContainText('ledger');
  /** Empty canvas 150 px under the node: the same spot relative to the drawing on any page. */
  const belowNode = async (page: Page) => {
    const box = await settledBox(nodeEl(page, id).locator('.node-rect'));
    return { x: box.x + box.width / 2, y: box.y + box.height + 150 };
  };

  // CV-17: a double-click selects but opens no editor, on a node or on empty canvas.
  await nodeEl(viewer, id).locator('[data-field="label"]').dblclick();
  await expect(viewer.locator('#toolbar')).toBeVisible();
  await expect(viewer.locator('#inline-edit')).toHaveCount(0);
  const empty = await belowNode(viewer);
  await viewer.mouse.dblclick(empty.x, empty.y);
  await expect(viewer.locator('#inline-edit')).toHaveCount(0);
  await serverCaughtUp(stack, viewer, nodeEl(viewer, id));
  await expect(nodes(viewer)).toHaveCount(1);
  await expect(nodes(owner)).toHaveCount(1);
  expect(await rowsOn(stack, board, 'id')).toHaveLength(1);
  const viewerToken = await guestToken(viewer);
  await expect(stack.callReducer(viewerToken, 'update_node', [id, { some: 'hijack' }, ...Array(8).fill(NONE)])).rejects.toThrow(READ_ONLY);
  await expect(stack.callReducer(viewerToken, 'update_node', [id, NONE, NONE, NONE, { some: true }, NONE, NONE, { some: 'red' }, NONE, NONE])).rejects.toThrow(READ_ONLY);

  // CV-20: the toolbar shows, but every change is off; Add to library stays on (it writes the reader's own library).
  await nodeEl(viewer, id).click();
  await expect(viewer.locator('#toolbar')).toBeVisible();
  await viewer.locator('#tb-color-menu summary').click();
  await expect(viewer.locator('#tb-swatches [data-color="red"]')).toBeDisabled();
  await viewer.locator('#tb-style-menu summary').click();
  for (const control of ['#tb-size [data-size="s"]', '#tb-delete', '#tb-kind', '#tb-token', '#tb-focal', '#tb-shape [data-shape="ellipse"]', '#tb-stroke [data-stroke="dashed"]']) {
    await expect(viewer.locator(control)).toBeDisabled();
  }
  await expect(viewer.locator('#tb-library')).toBeEnabled();

  // SH-02: the inspector reads the node, and the export carries the drawing.
  await expect(viewer.locator('#inspector')).toBeVisible();
  await expect(viewer.locator('#inspector .insp-title')).toHaveText('ledger');
  const download = viewer.waitForEvent('download');
  await viewer.getByRole('button', { name: 'Export SVG', exact: true }).click();
  let svg = '';
  for await (const chunk of (await (await download).createReadStream())!) svg += chunk;
  expect(svg).toContain('ledger');
  expect((await stack.sql(`SELECT label, color FROM node WHERE id = ${id}`))[0]).toEqual({ label: 'ledger', color: '' });

  // CV-17: a guest on an edit link is still a reader until signed in.
  const editLink = await shareBoard(owner, 'edit');
  await owner.keyboard.press('Escape');
  const editGuest = await guest();
  await openBoard(editGuest, editLink);
  await expect(nodeEl(editGuest, id)).toContainText('ledger');
  await nodeEl(editGuest, id).locator('[data-field="label"]').dblclick();
  await expect(editGuest.locator('#toolbar')).toBeVisible();
  await expect(editGuest.locator('#inline-edit')).toHaveCount(0);
  await expect(stack.callReducer(await guestToken(editGuest), 'update_node', [id, { some: 'hijack' }, ...Array(8).fill(NONE)])).rejects.toThrow(READ_ONLY);

  // The same double-clicks are live for the owner: the gestures above did reach the canvas.
  const spot = await belowNode(owner);
  await owner.mouse.dblclick(spot.x, spot.y);
  await expect(owner.locator('#inline-edit')).toBeVisible();
  await expect(nodes(owner)).toHaveCount(2);
});
