import { test, expect, openBoard, drawNode, drawEdge, shareBoard, boardIdOf, serverCaughtUp, palette, selectEdge, guestToken, settledBox, type Stack } from '../fixtures';
import type { Locator, Page } from '@playwright/test';

// The library popover and My library (chart spec "Library popover", component
// library spec 2026-10-18): search, drag, save, privacy, rename and delete,
// insert as one undo step, read-only rules and icon nodes.

const HINT = 'Public example. Explore the drawing or export it. Start a new board to draw.';
const SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const NONE = { none: [] };

const popover = (page: Page) => page.locator('#library-popover');
const searchbox = (page: Page) => page.getByRole('searchbox', { name: 'Search the library' });
const section = (page: Page, title: string) => popover(page).locator(`section[aria-label="${title}"]`);
const tile = (page: Page, name: string) => popover(page).getByRole('button', { name, exact: true });
const notice = (page: Page) => page.locator('#error-text');
const node = (page: Page, label: string) => page.locator('#world g.node', { hasText: label });
const chart = (page: Page) => page.locator('#world g.node.node-chart');
const img = (page: Page, name: string) => page.getByRole('img', { name, exact: true });
const hexOf = (page: Page) => page.evaluate(() => (window as any).conn.identity.toHexString() as string);
const libraryOf = (stack: Stack, hex: string) => stack.sql(`SELECT id, name, payload FROM library_item WHERE owner = 0x${hex}`);
const iconsOn = async (stack: Stack, B: number) => (await stack.sql(`SELECT icon FROM node_icon WHERE board_id = ${B}`)).map(row => String(row.icon)).sort();
const drawn = (page: Page) => page.evaluate(() => ['#world g.node', '#world g.node.node-chart', '#world g.edge'].map(s => document.querySelectorAll(s).length));
const stored = (stack: Stack, B: number) => Promise.all(['node', 'chart', 'edge'].map(async table => (await stack.sql(`SELECT * FROM ${table} WHERE board_id = ${B}`)).length));

async function place(page: Page, query: string, x: number, y: number) {
  const nodes = page.locator('#world g.node');
  const count = await nodes.count();
  await page.keyboard.press('l');
  await searchbox(page).fill(query);
  await searchbox(page).press('Enter');
  await page.locator('#board').click({ position: { x, y } });
  await expect(nodes).toHaveCount(count + 1);
  await page.keyboard.press('Escape');
  await expect(page.locator('#save-status')).toHaveText('Saved');
}

/** library-icons.spec.ts: an icon tile found by search, placed by a canvas click. */
const placeIcon = place;

/** Clicks the first node and shift-clicks the rest. An external node's rect is
 *  unfilled, so the svg takes the click and the canvas hit-tests it (force). */
async function select(page: Page, ...nodes: Locator[]) {
  for (const [i, n] of nodes.entries()) await n.locator('.node-rect').first().click({ position: { x: 12, y: 12 }, modifiers: i ? ['Shift'] : [], force: true });
}

/** Runs act and answers the prompt or confirm it opens (null cancels); returns the prompt's default value. */
async function answer(page: Page, reply: string | null, act: () => Promise<void>) {
  const asked = new Promise<string>(resolve => page.once('dialog', dialog => {
    resolve(dialog.defaultValue());
    void (reply === null ? dialog.dismiss() : dialog.accept(reply));
  }));
  await act();
  return asked;
}

/** ⇧L with the name answered; returns the suggested name once the canvas confirms the save. */
async function save(page: Page, name: string) {
  const suggested = await answer(page, name, () => page.keyboard.press('Shift+L'));
  await expect(notice(page)).toHaveText(`Saved "${name}" to your library`);
  return suggested;
}

/** The world point a release at client (x, y) places at: Viewport.screenToWorld, then the 4 px snap. */
const gridAt = (page: Page, x: number, y: number) => page.locator('#world').evaluate((world, [x, y]) => {
  const m = (world as SVGGElement).getScreenCTM()!.inverse();
  const snap = (v: number) => Math.round(v / 4) * 4;
  return { x: snap(m.a * x + m.c * y + m.e), y: snap(m.b * x + m.d * y + m.f) };
}, [x, y]);

/** Press on a tile, travel past the 4 px slop and release at a client point. */
async function drag(page: Page, from: Locator, to: { x: number; y: number }) {
  const box = (await from.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 10 });
  await page.mouse.up();
}

/** The toolbar's Style menu: open it if needed, then press Kind once. */
async function cycleKind(page: Page) {
  const menu = page.locator('#tb-style-menu');
  if ((await menu.getAttribute('open')) === null) await menu.locator('summary').click();
  await page.locator('#tb-kind').click();
}

test('the library popover opens with its sections and closes back to the dock button', async ({ guest, stack }) => {
  test.setTimeout(60_000);
  const page = await guest();
  await openBoard(page, stack.url);
  const button = page.locator('#tool-library');
  await button.click();
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  await expect(searchbox(page)).toBeFocused();
  const [above, dock] = await Promise.all([popover(page).boundingBox(), page.locator('#dock').boundingBox()]);
  expect(above!.y + above!.height).toBeLessThanOrEqual(dock!.y);
  const sections = popover(page).locator('section.lib-section');
  await expect(sections).toHaveCount(7);
  expect(await sections.evaluateAll(all => all.map(s => s.getAttribute('aria-label')))).toEqual(['Objects', 'Agents', 'Systems', 'AI logos', 'Cloud logos', 'Charts', 'My library']);
  await expect(section(page, 'My library').locator('.lib-empty')).toHaveText('No saved items yet — select nodes and press ⇧L');
  await expect(popover(page).locator('.lib-tile')).toHaveCount(57);
  await page.keyboard.press('Escape');
  await expect(popover(page)).toBeHidden();
  await expect(button).toBeFocused();
  await expect(button).toHaveAttribute('aria-expanded', 'false');

  // L closes it too when a tile has focus (in the search it is a letter).
  await page.keyboard.press('l');
  await expect(searchbox(page)).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(tile(page, 'Service')).toBeFocused();
  await page.keyboard.press('l');
  await expect(popover(page)).toBeHidden();
  await expect(button).toBeFocused();

  // CH-26: name, id, search term or section title. The unfiltered sections hold the same
  // Agents and Charts tiles, so the section lists prove the filter ran.
  const shown = () => sections.evaluateAll(all => all.map(s => s.getAttribute('aria-label')));
  await page.keyboard.press('l');
  await searchbox(page).fill('agent');
  await expect.poll(shown).toEqual(['Agents', 'AI logos']);
  await expect(section(page, 'Agents').locator('.lib-tile')).toHaveCount(12);
  await searchbox(page).fill('rag');
  await expect(section(page, 'Agents').locator('.lib-tile')).toHaveCount(1);
  await expect(section(page, 'Agents').getByRole('button', { name: 'Knowledge base', exact: true })).toBeVisible();
  await searchbox(page).fill('chart');
  await expect.poll(shown).toEqual(['Charts']);
  await expect(section(page, 'Charts').locator('.lib-tile')).toHaveCount(11);
  await searchbox(page).fill('zzz');
  await expect(popover(page)).toContainText('Nothing matches "zzz"');
  await expect(popover(page).locator('.lib-tile')).toHaveCount(0);
  // No exact name: the first name starting with it (Claude), not the first match (Model lists claude).
  await searchbox(page).fill('clau');
  await searchbox(page).press('Enter');
  await expect(page.locator('#rail-hint')).toContainText('armed · Claude');
  await page.keyboard.press('Escape');
  await expect(page.locator('#rail-hint')).not.toContainText('armed');
  await page.keyboard.press('l');
  // Enter takes the tile named what was typed: the Claude logo, not Model (which lists claude).
  await searchbox(page).fill('claude');
  await searchbox(page).press('Enter');
  await expect(popover(page)).toBeHidden();
  await page.locator('#board').click({ position: { x: 500, y: 300 } });
  await expect(img(page, 'Claude')).toHaveCount(1);
  await expect(page.locator('#world g.node')).toHaveCount(1);
  await expect(img(page, 'Model')).toHaveCount(0);
  await page.keyboard.press('Escape');

  // Keys 1–5 arm a kind straight from the empty search.
  await page.keyboard.press('l');
  await expect(searchbox(page)).toBeFocused();
  await page.keyboard.press('2');
  await expect(popover(page)).toBeHidden();
  await expect(page.locator('#dock .add-row[data-kind="datastore"]')).toHaveClass(/\barmed\b/);
  await expect(page.locator('#rail-hint')).toContainText('armed · datastore');
  await page.locator('#board').click({ position: { x: 800, y: 450 } });
  await expect(page.locator('#world g.node.node-datastore')).toHaveCount(1);
});

test('a tile dragged onto the canvas places one item at the drop point', async ({ guest, stack }) => {
  const page = await guest();
  await openBoard(page, stack.url);
  await page.keyboard.press('l');
  await searchbox(page).fill('queue');
  const first = await gridAt(page, 700, 450);
  await drag(page, tile(page, 'Queue'), { x: 700, y: 450 });
  await expect(popover(page)).toBeHidden();
  await expect(img(page, 'Queue')).toHaveCount(1);
  await expect(page.locator('#save-status')).toHaveText('Saved');
  const box = await settledBox(page.locator('#world g.node .node-rect').first());
  expect(Math.abs(box.x - 700)).toBeLessThan(6);
  expect(Math.abs(box.y - 450)).toBeLessThan(6);
  const B = await boardIdOf(stack, page);
  expect(await stack.sql(`SELECT x, y FROM node WHERE board_id = ${B}`)).toEqual([first]);

  // Released over the popover itself: nothing is dropped, so the popover stays open.
  await page.keyboard.press('Escape');
  await page.keyboard.press('l');
  await searchbox(page).fill('queue');
  const search = (await searchbox(page).boundingBox())!;
  await drag(page, tile(page, 'Queue'), { x: search.x + search.width / 2, y: search.y + search.height / 2 });
  await expect(popover(page)).toBeVisible();
  // A real drop after it: writes from one connection land in order, so once it is
  // stored, 2 rows (not 3) proves the miss wrote nothing.
  const second = await gridAt(page, 420, 300);
  await drag(page, tile(page, 'Queue'), { x: 420, y: 300 });
  await expect.poll(async () => (await stack.sql(`SELECT id FROM node WHERE board_id = ${B} AND x = ${second.x} AND y = ${second.y}`)).length).toBe(1);
  expect(await stack.sql(`SELECT id FROM node WHERE board_id = ${B}`)).toHaveLength(2);
  await expect(img(page, 'Queue')).toHaveCount(2);
});

test('a selection saves to My library with its edges and charts; cancel saves nothing', async ({ guest, stack }) => {
  test.setTimeout(60_000);
  const page = await guest();
  await openBoard(page, stack.url);
  await drawNode(page, 'api');
  await drawNode(page, 'db');
  await drawEdge(page, 0, 1);
  await place(page, 'stat', 420, 460);
  await select(page, node(page, 'api'), node(page, 'db'), chart(page));
  expect(await save(page, 'Kit')).toBe('api');

  const me = await hexOf(page);
  const [row] = await libraryOf(stack, me);
  expect(row.name).toBe('Kit');
  const payload = JSON.parse(String(row.payload));
  expect(payload.version).toBe(1);
  expect(payload.nodes).toHaveLength(3);
  expect(Math.min(...payload.nodes.map((n: { x: number }) => n.x))).toBe(0);
  expect(Math.min(...payload.nodes.map((n: { y: number }) => n.y))).toBe(0);
  expect(payload.nodes.filter((n: { chart?: unknown }) => n.chart).map((n: { chart: { type: string } }) => n.chart.type)).toEqual(['stat']);
  expect(payload.edges).toHaveLength(1);
  expect([payload.nodes[payload.edges[0].from].label, payload.nodes[payload.edges[0].to].label]).toEqual(['api', 'db']);

  await page.keyboard.press('l');
  await expect(section(page, 'My library').getByRole('button', { name: 'Kit', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');

  // Cancel on the toolbar button stores nothing; the ⌘K entry then saves once more.
  await answer(page, null, () => page.locator('#tb-library').click());
  await palette(page, 'add selection');
  await expect(page.locator('#palette-list')).toContainText('Add selection to library');
  await answer(page, 'Again', () => page.locator('#palette-input').press('Enter'));
  await expect(notice(page)).toHaveText('Saved "Again" to your library');
  expect((await libraryOf(stack, me)).map(r => r.name).sort()).toEqual(['Again', 'Kit']);
});

test('saved items are private to their owner and follow the identity live', async ({ guest, account, stack }) => {
  test.setTimeout(90_000);
  const token = stack.accountToken();
  const a = await account(token);
  const b = await account(token);
  await openBoard(a, `${stack.url}?new=1`);
  await openBoard(b, `${stack.url}?new=1`);
  await b.keyboard.press('l');
  await expect(section(b, 'My library').locator('.lib-empty')).toBeVisible();
  await drawNode(a, 'api');
  await select(a, node(a, 'api'));
  await save(a, 'Shared kit');
  // CH-30: the other browser of the same account, without a reload.
  await expect(section(b, 'My library').getByRole('button', { name: 'Shared kit', exact: true })).toBeVisible();

  // CH-29: another account sees nothing, and the server answers as if the item did not exist.
  const otherToken = stack.accountToken();
  const other = await account(otherToken);
  await openBoard(other, `${stack.url}?new=1`);
  await other.keyboard.press('l');
  await expect(section(other, 'Objects')).toBeVisible();
  await expect(section(other, 'My library').locator('.lib-empty')).toBeVisible();
  await expect(popover(other)).not.toContainText('Shared kit');
  expect(await other.evaluate(() => [...(window as any).conn.db.myLibrary.iter()].length)).toBe(0);
  const [{ id }] = await stack.sql(`SELECT id FROM library_item WHERE name = 'Shared kit'`);
  await expect(stack.callReducer(otherToken, 'delete_library_item', [id])).rejects.toThrow(/library item \d+ does not exist/);
  await expect(stack.callReducer(otherToken, 'rename_library_item', [id, 'Taken'])).rejects.toThrow(/library item \d+ does not exist/);
  expect(await stack.sql(`SELECT name FROM library_item WHERE id = ${id}`)).toEqual([{ name: 'Shared kit' }]);
  // Their own save arrives live in that same open popover: the empty list above was a loaded one.
  await stack.callReducer(otherToken, 'save_library_item', ['Own', JSON.stringify({ version: 1, nodes: [], edges: [] })]);
  await expect(section(other, 'My library').getByRole('button', { name: 'Own', exact: true })).toBeVisible();
  await expect(popover(other)).not.toContainText('Shared kit');
  expect(await other.evaluate(() => [...(window as any).conn.db.myLibrary.iter()].map(item => item.name))).toEqual(['Own']);

  // A guest's items survive a reload in the same browser.
  const g = await guest();
  await openBoard(g, stack.url);
  await drawNode(g, 'cache');
  await select(g, node(g, 'cache'));
  await save(g, 'Mine');
  await g.reload();
  await expect(g.locator('#canvas-wrap')).toHaveAttribute('aria-busy', 'false');
  await expect(g.locator('#world')).toContainText('cache');
  await g.keyboard.press('l');
  await expect(section(g, 'My library').getByRole('button', { name: 'Mine', exact: true })).toBeVisible();
});

test('a saved item is renamed and deleted from its menu', async ({ guest, stack }) => {
  test.setTimeout(60_000);
  const page = await guest();
  await openBoard(page, stack.url);
  await drawNode(page, 'api');
  await select(page, node(page, 'api'));
  await save(page, 'Kit');
  const me = await hexOf(page);
  const names = async () => (await libraryOf(stack, me)).map(r => r.name);
  const rename = () => popover(page).getByRole('menuitem', { name: 'Rename' }).click();
  const remove = () => popover(page).getByRole('menuitem', { name: 'Delete' }).click();
  await page.keyboard.press('l');

  // Cancelled rename: nothing changes.
  await popover(page).getByRole('button', { name: 'Actions for Kit' }).click();
  expect(await answer(page, null, rename)).toBe('Kit');
  await expect(tile(page, 'Kit')).toBeVisible();

  // Right-click opens the same menu; a dismissed confirm keeps the item.
  await tile(page, 'Kit').click({ button: 'right' });
  await expect(popover(page).getByRole('menuitem', { name: 'Delete' })).toBeVisible();
  await answer(page, null, remove);
  await expect(tile(page, 'Kit')).toBeVisible();

  // Writes from one connection land in order: had either cancel sent a write, this rename would
  // not find 'Kit' (deleted) or would follow a rename.
  await popover(page).getByRole('button', { name: 'Actions for Kit' }).click();
  await answer(page, 'Kit 2', rename);
  await expect(tile(page, 'Kit 2')).toBeVisible();
  await expect.poll(names).toEqual(['Kit 2']);

  await tile(page, 'Kit 2').click({ button: 'right' });
  await answer(page, '', remove);
  await expect(tile(page, 'Kit 2')).toHaveCount(0);
  await expect(section(page, 'My library').locator('.lib-empty')).toBeVisible();
  await expect.poll(names).toEqual([]);
});

test('inserting a saved item is one undo step and copies only what it should', async ({ account, stack }) => {
  test.setTimeout(90_000);
  const token = stack.accountToken();
  const page = await account(token, { viewport: { width: 1440, height: 900 } });
  await openBoard(page, `${stack.url}?new=1`);
  const B = await boardIdOf(stack, page);
  await drawNode(page, 'api');
  await drawNode(page, 'db');
  await drawEdge(page, 0, 1);
  await page.keyboard.press('Escape');
  await selectEdge(page);
  const colour = page.locator('#tb-color-menu');
  if ((await colour.getAttribute('open')) === null) await colour.locator('summary').click();
  await page.locator('#tb-color-menu [data-color="red"]').click();
  const style = page.locator('#tb-style-menu');
  for (const option of ['[data-stroke="dotted"]', '[data-weight="bold"]']) {
    if ((await style.getAttribute('open')) === null) await style.locator('summary').click();
    await style.locator(option).click();
  }
  await expect.poll(() => stack.sql(`SELECT color, stroke_style FROM edge WHERE board_id = ${B}`)).toEqual([{ color: 'red', stroke_style: 'dotted' }]);
  await expect.poll(() => stack.sql(`SELECT weight FROM edge_weight WHERE board_id = ${B}`)).toEqual([{ weight: 'bold' }]);
  await page.keyboard.press('Escape');

  // Focal and a code ref on api, a chart with its own source: none of the first two may copy.
  const [{ id: apiId }] = await stack.sql(`SELECT id FROM node WHERE board_id = ${B} AND label = 'api'`);
  await stack.callReducer(token, 'update_node', [apiId, NONE, NONE, NONE, { some: true }, NONE, NONE, NONE, NONE, NONE]);
  await stack.callReducer(token, 'add_repo_files', [B, ['src/api.ts']]);
  await stack.callReducer(token, 'add_code_ref', [B, 'node', apiId, 'src/api.ts', 'handler', 1, 4, SHA, '', 'e2e']);
  await expect(node(page, 'api')).toHaveClass(/\bfocal\b/);
  expect(await stack.sql(`SELECT id FROM code_ref WHERE board_id = ${B}`)).toHaveLength(1);
  await place(page, 'stat', 480, 520);
  const [{ node_id: chartId }] = await stack.sql(`SELECT node_id FROM chart WHERE board_id = ${B}`);
  await stack.callReducer(token, 'set_chart_data', [chartId, NONE, NONE, NONE, { some: 'grafana' }]);
  await expect(chart(page).locator('.chart-source')).toHaveText('source: grafana');
  await select(page, node(page, 'api'), node(page, 'db'), chart(page));
  await save(page, 'Kit');
  const me = await hexOf(page);
  const [{ payload }] = await libraryOf(stack, me);
  expect(JSON.parse(String(payload)).edges[0]).not.toHaveProperty('evidence');

  await openBoard(page, `${stack.url}?new=1`);
  const B2 = await boardIdOf(stack, page);
  expect(B2).not.toBe(B);
  await page.keyboard.press('l');
  await tile(page, 'Kit').click();
  const board = (await page.locator('#board').boundingBox())!;
  const at = await gridAt(page, board.x + 500, board.y + 300);
  await page.locator('#board').click({ position: { x: 500, y: 300 } });
  await expect.poll(() => drawn(page)).toEqual([3, 1, 1]);
  await expect.poll(() => stored(stack, B2)).toEqual([3, 1, 1]);
  // The inserted group is the selection.
  await expect(page.locator('#world .selection-outline')).toHaveCount(3);
  const placed = await stack.sql(`SELECT id, x, y, focal FROM node WHERE board_id = ${B2}`);
  expect(placed.map(r => r.focal)).toEqual([false, false, false]);
  // The group's top-left is the click, on the 4 px grid.
  expect({ x: Math.min(...placed.map(r => Number(r.x))), y: Math.min(...placed.map(r => Number(r.y))) }).toEqual(at);
  await expect.poll(() => stack.sql(`SELECT evidence, color, stroke_style FROM edge WHERE board_id = ${B2}`)).toEqual([{ evidence: `human:${me}`, color: 'red', stroke_style: 'dotted' }]);
  await expect.poll(() => stack.sql(`SELECT weight FROM edge_weight WHERE board_id = ${B2}`)).toEqual([{ weight: 'bold' }]);
  expect(await stack.sql(`SELECT source FROM chart WHERE board_id = ${B2}`)).toEqual([{ source: 'grafana' }]);
  expect(await stack.sql(`SELECT id FROM code_ref WHERE board_id = ${B2}`)).toEqual([]);

  // One ⌘Z takes all of it; ⌘⇧Z puts it back with new ids.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => drawn(page)).toEqual([0, 0, 0]);
  await expect.poll(() => stored(stack, B2)).toEqual([0, 0, 0]);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(() => drawn(page)).toEqual([3, 1, 1]);
  await expect.poll(() => stored(stack, B2)).toEqual([3, 1, 1]);
  const again = await stack.sql(`SELECT id FROM node WHERE board_id = ${B2}`);
  expect(again.filter(r => placed.some(p => p.id === r.id))).toEqual([]);
});

test('a reader cannot place from the library but can save into their own', async ({ guest, stack }) => {
  test.setTimeout(90_000);
  const owner = await guest();
  await openBoard(owner, stack.url);
  await drawNode(owner, 'api');
  await place(owner, 'stat', 420, 460);
  const B = await boardIdOf(stack, owner);
  const link = await shareBoard(owner, 'view');

  const viewer = await guest();
  await openBoard(viewer, link);
  await expect(viewer.locator('#world')).toContainText('api');
  await expect(chart(viewer)).toHaveCount(1);
  await viewer.keyboard.press('l');
  await searchbox(viewer).fill('pie');
  await searchbox(viewer).press('Enter');
  await expect(notice(viewer)).toHaveText(HINT);
  // Nothing was armed: the rail shows the reader hint, not 'armed · pie chart'.
  await expect(viewer.locator('#rail-hint')).toHaveText(HINT);
  await viewer.locator('#board').click({ position: { x: 900, y: 500 } });
  await serverCaughtUp(stack, viewer, node(viewer, 'api'));
  await expect(chart(viewer)).toHaveCount(1);
  expect(await stack.sql(`SELECT node_id FROM chart WHERE board_id = ${B}`)).toHaveLength(1);
  // The server refuses the same writes (a chart, a saved item's nodes) from this reader.
  const viewerToken = await guestToken(viewer);
  await expect(stack.callReducer(viewerToken, 'create_chart', [B, 'Pie', '', 0, 0, 352, 224, 'pie', 'slice,value\na,1', NONE, NONE])).rejects.toThrow('not authorized: board is read only');
  await expect(stack.callReducer(viewerToken, 'create_node', [B, 'api', '', 0, 0, 160, 96, 'ink', false, NONE, NONE, NONE, NONE, NONE, NONE, NONE])).rejects.toThrow('not authorized: board is read only');

  // Saving writes only the reader's own library, so it still works here.
  await select(viewer, node(viewer, 'api'));
  await expect(viewer.locator('#tb-delete')).toBeDisabled();
  await expect(viewer.locator('#tb-library')).toBeEnabled();
  await save(viewer, 'Borrowed');
  // The toolbar button saves too.
  await answer(viewer, 'Borrowed 2', () => viewer.locator('#tb-library').click());
  await expect(notice(viewer)).toHaveText('Saved "Borrowed 2" to your library');
  const me = await hexOf(viewer);
  expect((await libraryOf(stack, me)).map(r => r.name).sort()).toEqual(['Borrowed', 'Borrowed 2']);

  await viewer.keyboard.press('l');
  await tile(viewer, 'Borrowed').click();
  await expect(notice(viewer)).toHaveText(HINT);
  await expect(viewer.locator('#rail-hint')).toHaveText(HINT);
  await viewer.locator('#board').click({ position: { x: 900, y: 500 } });
  await serverCaughtUp(stack, viewer, node(viewer, 'api'));
  await expect(viewer.locator('#world g.node')).toHaveCount(2);
  expect(await stack.sql(`SELECT id FROM node WHERE board_id = ${B}`)).toHaveLength(2);

  await palette(viewer, 'library');
  await expect(viewer.locator('#palette-list')).toContainText('Open library');
  await viewer.keyboard.press('Escape');

  // On a board of their own the saved item inserts.
  await openBoard(viewer, `${stack.url}?new=1`);
  const own = await boardIdOf(stack, viewer);
  expect(own).not.toBe(B);
  await viewer.keyboard.press('l');
  await tile(viewer, 'Borrowed').click();
  await viewer.locator('#board').click({ position: { x: 500, y: 300 } });
  await expect(viewer.locator('#world g.node')).toHaveCount(1);
  await expect(viewer.locator('#world')).toContainText('api');
  await expect.poll(async () => (await stack.sql(`SELECT label FROM node WHERE board_id = ${own}`)).map(r => r.label)).toEqual(['api']);
});

test('icon nodes take their defaults and arrive live with their icon', async ({ guest, stack }) => {
  test.setTimeout(90_000);
  const owner = await guest();
  await openBoard(owner, stack.url);
  await placeIcon(owner, 'model', 400, 200);
  await placeIcon(owner, 'memory', 640, 200);
  await placeIcon(owner, 'orchestrator', 880, 200);
  await placeIcon(owner, 'claude', 400, 420);
  const B = await boardIdOf(stack, owner);
  const rows = await stack.sql(`SELECT label, sublabel, kind, w, h, token FROM node WHERE board_id = ${B}`);
  const icon = (label: string, kind: string) => ({ label, sublabel: '', kind, w: 160, h: 96, token: 'ink' });
  expect(rows.sort((x, y) => String(x.label).localeCompare(String(y.label)))).toEqual([
    icon('Claude', 'external'), icon('Memory', 'datastore'), icon('Model', 'external'), icon('Orchestrator', 'service'),
  ]);
  expect(await iconsOn(stack, B)).toEqual(['claude', 'memory', 'model', 'orchestrator']);

  // CH-37: a viewer with the board open never draws the new node without its icon.
  const link = await shareBoard(owner, 'view');
  await owner.keyboard.press('Escape');
  const viewer = await guest();
  await openBoard(viewer, link);
  await expect(viewer.locator('#world .node-icon-slot')).toHaveCount(4);
  await viewer.evaluate(() => {
    const w = window as any;
    w.__frames = [];
    const sample = () => {
      w.__frames.push([document.querySelectorAll('#world g.node').length, document.querySelectorAll('#world .node-icon-slot').length]);
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await placeIcon(owner, 'orchestrator', 640, 420);
  await expect(img(viewer, 'Orchestrator')).toHaveCount(2);
  const frames = () => viewer.evaluate(() => (window as any).__frames as [number, number][]);
  // Wait for a sampled frame that shows the new node, then check every frame that did.
  await expect.poll(async () => (await frames()).some(([nodes]) => nodes === 5)).toBe(true);
  expect((await frames()).filter(([nodes, icons]) => nodes === 5 && icons !== 5)).toEqual([]);
});

test('an icon survives delete-undo, leaves at a note, and travels through My library', async ({ guest, stack }) => {
  test.setTimeout(90_000);
  const page = await guest();
  await openBoard(page, stack.url);
  await placeIcon(page, 'k8s', 400, 200);
  const B = await boardIdOf(stack, page);
  await expect(img(page, 'Kubernetes')).toHaveCount(1);
  await expect.poll(() => iconsOn(stack, B)).toEqual(['kubernetes']);
  await select(page, node(page, 'Kubernetes'));
  await page.locator('#tb-delete').click();
  await expect(page.locator('#world g.node')).toHaveCount(0);
  await expect(img(page, 'Kubernetes')).toHaveCount(0);
  await expect.poll(() => iconsOn(stack, B)).toEqual([]);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(img(page, 'Kubernetes')).toHaveCount(1);
  await expect.poll(() => iconsOn(stack, B)).toEqual(['kubernetes']);
  await page.keyboard.press('Escape');

  // CH-39: every box kind keeps the icon; a note drops it; undo brings both back.
  await placeIcon(page, 'orchestrator', 640, 200);
  const orchestrator = node(page, 'Orchestrator');
  const [{ id }] = await stack.sql(`SELECT id FROM node WHERE board_id = ${B} AND label = 'Orchestrator'`);
  const kindOf = async () => String((await stack.sql(`SELECT kind FROM node WHERE id = ${id}`))[0].kind);
  const iconOf = async () => (await stack.sql(`SELECT icon FROM node_icon WHERE node_id = ${id}`)).map(r => r.icon);
  await select(page, orchestrator);
  for (const kind of ['datastore', 'external', 'boundary']) {
    await cycleKind(page);
    await expect(orchestrator).toHaveClass(new RegExp(`\\bnode-${kind}\\b`));
    await expect(img(page, 'Orchestrator')).toHaveCount(1);
  }
  await expect.poll(kindOf).toBe('boundary');
  expect(await iconOf()).toEqual(['orchestrator']);
  await cycleKind(page);
  await expect(orchestrator).toHaveClass(/\bnode-note\b/);
  await expect(img(page, 'Orchestrator')).toHaveCount(0);
  await expect.poll(kindOf).toBe('note');
  expect(await iconOf()).toEqual([]);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('ControlOrMeta+z');
  await expect(orchestrator).toHaveClass(/\bnode-boundary\b/);
  await expect(img(page, 'Orchestrator')).toHaveCount(1);
  await expect.poll(kindOf).toBe('boundary');
  await expect.poll(iconOf).toEqual(['orchestrator']);
  await page.keyboard.press('Escape');

  // CH-40: ⇧L keeps the icon in the payload, and an insert on another board brings it back.
  await placeIcon(page, 'gateway', 880, 200);
  await select(page, node(page, 'Gateway'));
  await save(page, 'GW');
  const [{ payload }] = await libraryOf(stack, await hexOf(page));
  expect(JSON.parse(String(payload)).nodes.map((n: { icon?: string }) => n.icon)).toEqual(['gateway']);
  await openBoard(page, `${stack.url}?new=1`);
  const B2 = await boardIdOf(stack, page);
  expect(B2).not.toBe(B);
  await page.keyboard.press('l');
  await tile(page, 'GW').click();
  await page.locator('#board').click({ position: { x: 500, y: 300 } });
  await expect(img(page, 'Gateway')).toHaveCount(1);
  await expect.poll(() => iconsOn(stack, B2)).toEqual(['gateway']);
});
