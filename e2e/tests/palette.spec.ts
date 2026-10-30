import type { BrowserContextOptions, Page } from '@playwright/test';
import { test, expect, openBoard, drawNode, boardIdOf, settledBox, type Stack } from '../fixtures';

// ⌘K beyond the keyboard: mouse, key capture, selection-aware commands, arrange
// commands and their shortcuts, and themes from the picker and the palette.
const WIDE = { viewport: { width: 1440, height: 900 } };
const EMPTY = { position: { x: 300, y: 500 } }; // a #board point clear of drawNode's nodes

async function palette(page: Page, query = '') {
  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.locator('#palette-input')).toBeFocused();
  if (query) await page.locator('#palette-input').fill(query);
}

const input = (page: Page) => page.locator('#palette-input');

async function reload(page: Page) {
  await page.reload();
  await expect(page.locator('#canvas-wrap')).toHaveAttribute('aria-busy', 'false');
}

/** The union of every node's box once two reads 250 ms apart agree (a selection can glide the view). */
async function settledNodes(page: Page) {
  let last = '';
  await expect.poll(async () => {
    const boxes = await page.locator('#world g.node').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect()));
    const box = JSON.stringify({
      left: Math.min(...boxes.map(b => b.left)), top: Math.min(...boxes.map(b => b.top)),
      right: Math.max(...boxes.map(b => b.right)), bottom: Math.max(...boxes.map(b => b.bottom)),
    });
    const same = box === last;
    last = box;
    return same;
  }, { intervals: [250] }).toBe(true);
  return JSON.parse(last) as { left: number; top: number; right: number; bottom: number };
}

/** Drags a marquee from empty canvas around every node; the palette badge confirms the count. */
async function selectAll(page: Page) {
  await page.keyboard.press('Escape'); // no selection toolbar over the start point
  const n = await page.locator('#world g.node').count();
  const box = await settledNodes(page);
  await page.mouse.move(box.left - 30, box.top - 30);
  await page.mouse.down();
  await page.mouse.move(box.right + 30, box.bottom + 30, { steps: 8 });
  await page.mouse.up();
  await palette(page);
  await expect(page.locator('#palette-ctx')).toHaveText(`${n} nodes selected`);
  await page.keyboard.press('Escape');
  await expect(page.locator('#palette')).toBeHidden();
}

/** Node rows in drawing order. */
async function positions(stack: Stack, board: number) {
  const rows = await stack.sql(`SELECT id, x, y, w FROM node WHERE board_id = ${board}`);
  return rows.map(r => ({ id: Number(r.id), x: Number(r.x), y: Number(r.y), w: Number(r.w) })).sort((a, b) => a.id - b.id);
}

async function edges(stack: Stack, board: number) {
  const rows = await stack.sql(`SELECT from_node, to_node, evidence FROM edge WHERE board_id = ${board}`);
  return rows.map(r => ({ from: Number(r.from_node), to: Number(r.to_node), evidence: String(r.evidence) })).sort((a, b) => a.from - b.from);
}

/** Tidy's grid for three staggered nodes: a and b share the top row, c sits under a. */
const tidied = ([a, b, c]: { x: number; y: number }[]) => a.y === b.y && b.x > a.x && (c === undefined || (c.x === a.x && c.y > a.y));

async function drawBoard(page: Page, stack: Stack, labels: string[]) {
  await openBoard(page, stack.url);
  for (const label of labels) await drawNode(page, label);
  return boardIdOf(stack, page);
}

const NONE = { none: [] };

/** An account's new board whose nodes the module made, laid out as drawNode would. This tab never
 *  created them, so its edge captures cannot collide with their ids (see the divergent test below). */
async function seededBoard(account: (token?: string, options?: BrowserContextOptions) => Promise<Page>, stack: Stack, labels: string[]) {
  const token = stack.accountToken();
  const page = await account(token, WIDE);
  await openBoard(page, `${stack.url}?new=1`);
  const board = await boardIdOf(stack, page);
  for (const [i, label] of labels.entries()) {
    await stack.callReducer(token, 'create_node', [board, label, '', 496 + i * 224, 224 + i * 128, 160, 80, 'ink', false, NONE, NONE, NONE, NONE, NONE, NONE, NONE]);
  }
  await expect(page.locator('#world g.node')).toHaveCount(labels.length);
  return { page, board, token };
}

test('a palette row runs on a mouse click, and the backdrop closes it', async ({ guest, stack }) => {
  const page = await guest();
  await openBoard(page, stack.url);
  await palette(page, 'theme');
  const dark = page.getByRole('option', { name: 'Theme: Dark, current' });
  await expect(dark).toBeVisible();
  await expect(dark.locator('svg')).toHaveCount(1);

  // The hover highlights in place, so the click that follows still lands.
  const light = page.getByRole('option', { name: 'Theme: Light', exact: true });
  await expect(light).toHaveAttribute('aria-selected', 'false');
  await expect(light.locator('svg')).toHaveCount(0);
  await light.hover();
  await expect(light).toHaveAttribute('aria-selected', 'true');
  await light.click();
  await expect(page.locator('#palette')).toBeHidden();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await reload(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

  // The check moved with the theme.
  await palette(page, 'theme');
  await expect(page.getByRole('option', { name: 'Theme: Light, current' })).toBeVisible();
  await expect(page.getByRole('option', { name: /, current$/ })).toHaveCount(1);
  await page.locator('#palette').click({ position: { x: 5, y: 5 } });
  await expect(page.locator('#palette')).toBeHidden();

  // Esc and ⌘K both close it, and the next ⌘K opens it empty and focused.
  await palette(page, 'x');
  await page.keyboard.press('Escape');
  await expect(page.locator('#palette')).toBeHidden();
  await palette(page);
  await expect(page.locator('#palette-input')).toHaveValue('');
  await page.locator('#palette-input').fill('y');
  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.locator('#palette')).toBeHidden();
  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.locator('#palette')).toBeVisible();
  await expect(page.locator('#palette-input')).toBeFocused();
  await expect(page.locator('#palette-input')).toHaveValue('');
});

test('the palette keeps every key while open', async ({ guest, stack }) => {
  const page = await guest();
  await openBoard(page, stack.url);
  await drawNode(page, 'a');
  const board = await boardIdOf(stack, page);
  const input = page.locator('#palette-input');
  await palette(page);
  // 'l' would open the library and '1' arm a service on the board.
  await page.keyboard.type('l1');
  await expect(input).toHaveValue('l1');
  await expect(page.locator('#library-popover')).toBeHidden();
  await page.keyboard.press('Tab');
  await expect(input).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(input).toBeFocused();
  await input.fill('place text');
  await page.locator('#palette-preview').click();
  await expect(input).toBeFocused();
  await page.locator('#palette-foot').click();
  await expect(input).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(page.locator('#palette')).toBeHidden();
  await expect(page.locator('#tool-select')).toHaveClass(/armed/);
  await expect(page.locator('.add-row[data-kind="service"]')).not.toHaveClass(/armed/);
  await page.locator('#board').click(EMPTY);
  // Drawing b lands after anything that click wrote (one connection, in order): only a and b exist.
  await drawNode(page, 'b');
  expect((await stack.sql(`SELECT label FROM node WHERE board_id = ${board}`)).map(r => r.label).sort()).toEqual(['a', 'b']);

  // In the library search, letters stay in the search and ⌘K still opens the palette.
  await page.keyboard.press('Escape');
  await page.keyboard.press('l');
  const search = page.locator('#library-popover .lib-search');
  await expect(search).toBeFocused();
  await page.keyboard.type('dat');
  await expect(search).toHaveValue('dat');
  await expect(page.locator('.add-row[data-kind="text"]')).not.toHaveClass(/armed/);
  await expect(page.locator('#tool-select')).toHaveClass(/armed/);
  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.locator('#palette')).toBeVisible();
  await expect(input).toBeFocused();
});

test('commands follow the selection', async ({ guest, stack }) => {
  const page = await guest(WIDE);
  await drawBoard(page, stack, ['a', 'b']);
  const list = page.locator('#palette-list'), ctx = page.locator('#palette-ctx');
  await page.keyboard.press('Escape');
  await palette(page);
  await expect(list).toContainText('Place text');
  await expect(list).toContainText('Export SVG');
  await expect(list).not.toContainText('Tidy up');
  await expect(list).not.toContainText('Mark focal');
  await expect(ctx).toBeHidden();
  await page.keyboard.press('Escape');

  // One node: selection commands, still no arranging.
  await page.locator('#world g.node').first().locator('.node-rect').click();
  await palette(page);
  await expect(ctx).toHaveText('1 node selected');
  for (const title of ['Mark focal', 'Duplicate selection', 'Delete selection']) await expect(list).toContainText(title);
  await expect(list).not.toContainText('Tidy up');
  await page.keyboard.press('Escape');

  await selectAll(page);
  await palette(page);
  for (const title of ['Tidy up', 'Distribute horizontally', 'Connect in order as a flow', 'Delete selection', 'Mark focal']) await expect(list).toContainText(title);
  await expect(list.locator('.palette-group-head')).toHaveText(['Arrange', 'Selection', 'Place', 'General', 'View', 'Theme', 'Branch']);
  await expect(ctx).toHaveText('2 nodes selected');
  await expect(input(page)).toHaveAttribute('aria-activedescendant', 'palette-opt-0');
  await page.keyboard.press('ArrowDown');
  await expect(input(page)).toHaveAttribute('aria-activedescendant', 'palette-opt-1');
  await expect(page.locator('#palette-opt-1')).toHaveAttribute('aria-selected', 'true');

  // Typing drops the headers and ranks; the preview and the undo hint follow the active row.
  await input(page).fill('tidy');
  await expect(list.locator('.palette-group-head')).toHaveCount(0);
  await expect(list.locator('.palette-row').first()).toHaveText(/Tidy up/);
  await expect(page.locator('#palette-preview')).toContainText('2 nodes → one');
  await expect(page.locator('#palette-undo')).toBeVisible();
  await input(page).fill('export');
  await expect(list.locator('.palette-row').first()).toHaveText(/Export SVG/);
  await expect(page.locator('#palette-undo')).toBeHidden();
  await input(page).fill('zzqx');
  await expect(list.locator('.palette-empty')).toHaveText('No matching command');
});

test('Tidy up and Connect in order rearrange and wire a selection, each as one undo step', async ({ account, stack }) => {
  test.setTimeout(90_000);
  const { page, board, token } = await seededBoard(account, stack, ['a', 'b', 'c']);
  const before = await positions(stack, board);
  expect(tidied(before)).toBe(false);
  await selectAll(page);

  await palette(page, 'tid');
  await expect(page.locator('#palette-list .palette-row').first()).toContainText('Tidy up');
  await expect(page.locator('#palette-preview')).toContainText('3 nodes → one 2×2 grid');
  await page.keyboard.press('Enter');
  await expect.poll(async () => tidied(await positions(stack, board))).toBe(true);
  await expect(page.locator('#save-status')).toHaveText('Saved');
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => positions(stack, board)).toEqual(before);

  // Reading order is a, b, c; every edge is cited as drawn by a person.
  await palette(page, 'connect in order');
  await expect(page.locator('#palette-ctx')).toHaveText('3 nodes selected');
  await expect(page.locator('#palette-list .palette-row').first()).toContainText('Connect in order as a flow');
  await page.keyboard.press('Enter');
  await expect(page.locator('#world g.edge')).toHaveCount(2);
  const [a, b, c] = before.map(n => n.id);
  await expect.poll(async () => (await edges(stack, board)).map(e => [e.from, e.to])).toEqual([[a, b], [b, c]]);
  for (const edge of await edges(stack, board)) expect(edge.evidence).toMatch(/^human:./);

  await palette(page, 'connect in order');
  await page.keyboard.press('Enter');
  await expect(page.locator('#error-text')).toHaveText('those nodes are already connected in that order');
  await expect(page.locator('#world g.edge')).toHaveCount(2);

  // One ⌘Z takes back the whole batch.
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.locator('#world g.edge')).toHaveCount(0);
  await expect.poll(() => edges(stack, board)).toEqual([]);

  // A pair that already connects is skipped: only b → c is added.
  await stack.callReducer(token, 'create_edge', [board, a, b, '', 'human:e2e', NONE, NONE, NONE]);
  await expect(page.locator('#world g.edge')).toHaveCount(1);
  await palette(page, 'connect in order');
  await expect(page.locator('#palette-preview')).toContainText('Creates 1 edge across 3 nodes');
  await page.keyboard.press('Enter');
  await expect(page.locator('#world g.edge')).toHaveCount(2);
  await expect.poll(async () => (await edges(stack, board)).map(e => [e.from, e.to])).toEqual([[a, b], [b, c]]);
});

test('⇧T, ⌥⇧H and ⌘↵ arrange a selection, and type into a focused text field instead', async ({ account, stack }) => {
  test.setTimeout(90_000);
  const { page, board } = await seededBoard(account, stack, ['a', 'b', 'c']);
  const nodes = page.locator('#world g.node');

  // Unequal gaps, so distributing has something to equalise.
  const start = await positions(stack, board);
  const box = await settledBox(nodes.nth(1).locator('.node-rect'));
  await page.mouse.move(box.x + 12, box.y + 12);
  await page.mouse.down();
  await page.mouse.move(box.x + 12 + 96, box.y + 12, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await positions(stack, board))[1].x).toBeGreaterThan(start[1].x + 40);
  await expect(page.locator('#save-status')).toHaveText('Saved');
  const before = await positions(stack, board);

  // In the label editor ⇧T is a capital T (BL-61).
  await nodes.first().dblclick();
  const edit = page.locator('#inline-edit');
  await expect(edit).toBeFocused();
  await page.keyboard.press('Shift+T');
  await expect(edit).toHaveValue('T');
  await page.keyboard.press('Escape');
  await expect(edit).toHaveCount(0);
  await expect(page.locator('.add-row[data-kind="text"]')).not.toHaveClass(/armed/);

  // With all three selected, the keys still stay in a focused search field.
  await selectAll(page);
  await page.keyboard.press('l');
  const search = page.locator('#library-popover .lib-search');
  await expect(search).toBeFocused();
  await page.keyboard.press('Shift+T');
  await page.keyboard.press('Alt+Shift+H');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(search).toHaveValue(/^T/);
  await page.keyboard.press('Escape');
  await expect(page.locator('#library-popover')).toBeHidden();

  // Mark focal as a barrier: one connection's writes land in order, so once the
  // first focal shows, anything the keys above wrote has landed too. Nothing moved
  // or wired. (The focal limit refuses the third; only the first matters here.)
  await palette(page, 'mark focal');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await stack.sql(`SELECT focal FROM node WHERE board_id = ${board}`)).filter(r => r.focal === true).length).toBeGreaterThan(0);
  expect(await positions(stack, board)).toEqual(before);
  expect(await edges(stack, board)).toEqual([]);

  // ⌥⇧H moves only b, to equal gaps.
  await page.keyboard.press('Alt+Shift+H');
  await expect.poll(async () => {
    const [a, b, c] = await positions(stack, board);
    return Math.abs((b.x - a.x - a.w) - (c.x - b.x - b.w)) <= 8 && b.x !== before[1].x;
  }).toBe(true);
  const spread = await positions(stack, board);
  expect(spread.map(n => [n.y, n.w])).toEqual(before.map(n => [n.y, n.w]));
  expect([spread[0].x, spread[2].x]).toEqual([before[0].x, before[2].x]);

  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page.locator('#world g.edge')).toHaveCount(2);
  const [a, b, c] = before.map(n => n.id);
  await expect.poll(async () => (await edges(stack, board)).map(e => [e.from, e.to])).toEqual([[a, b], [b, c]]);
  await page.keyboard.press('Shift+T');
  await expect.poll(async () => tidied(await positions(stack, board))).toBe(true);
});

test('Connect in order wires every pair when an edge id equals a node id this tab drew', async ({ guest, stack }) => {
  // divergent (new): ops.ts captureInsert keeps one claimedIds set for node and edge ids, so that edge is never captured and the batch stalls after it
  test.fail();
  test.setTimeout(90_000);
  const page = await guest(WIDE);
  await openBoard(page, stack.url);
  // Line the id sequences up through a second person's board: the next node id is the next edge id.
  const filler = stack.accountToken();
  const name = `ids-${Date.now()}`;
  await stack.callReducer(filler, 'create_board', [name]);
  const [{ id }] = await stack.sql(`SELECT id FROM board WHERE name = '${name}'`);
  const fb = Number(id);
  const ids = async (table: string) => (await stack.sql(`SELECT id FROM ${table} WHERE board_id = ${fb}`)).map(r => Number(r.id));
  const addNode = async () => { await stack.callReducer(filler, 'create_node', [fb, 'filler', '', 0, 0, 160, 80, 'ink', false, NONE, NONE, NONE, NONE, NONE, NONE, NONE]); return Math.max(...await ids('node')); };
  await addNode();
  let lastNode = await addNode();
  const [n1, n2] = (await ids('node')).sort((x, y) => x - y);
  const addEdge = async () => {
    await stack.callReducer(filler, 'create_edge', [fb, n1, n2, '', 'human:e2e', NONE, NONE, NONE]);
    const edge = Math.max(...await ids('edge'));
    await stack.callReducer(filler, 'delete_edge', [edge]);
    return edge;
  };
  let lastEdge = await addEdge();
  while (lastEdge < lastNode) lastEdge = await addEdge();
  while (lastNode < lastEdge) lastNode = await addNode();

  for (const label of ['a', 'b', 'c']) await drawNode(page, label);
  const board = await boardIdOf(stack, page);
  const [a, b, c] = (await positions(stack, board)).map(n => n.id);
  test.skip(a !== lastEdge + 1, 'id sequences did not line up');
  await selectAll(page);
  await palette(page, 'connect in order');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await edges(stack, board)).map(e => [e.from, e.to])).toEqual([[a, b], [b, c]]);
});

test('a title match outranks a keyword match', async ({ guest, stack }) => {
  // divergent (new): ⌘K 'flow' ranks 'Replay trace' (keyword 'flow', rank + 20) above the title 'Connect in order as a flow'
  test.fail();
  const page = await guest(WIDE);
  await drawBoard(page, stack, ['a', 'b']);
  await selectAll(page);
  await palette(page, 'flow');
  await expect(page.locator('#palette-list')).toContainText('Replay trace');
  await expect(page.locator('#palette-list .palette-row').first()).toContainText('Connect in order as a flow');
});

test('⇧T tidies a selection and arms nothing', async ({ guest, stack }) => {
  // divergent (CV-54): ⇧T also arms the text tool (interactions.ts arms text on 'T' without a shift check)
  test.fail();
  const page = await guest(WIDE);
  const board = await drawBoard(page, stack, ['a', 'b']);
  await selectAll(page);
  await page.keyboard.press('Shift+T');
  await expect.poll(async () => tidied(await positions(stack, board))).toBe(true);
  await expect(page.locator('.add-row[data-kind="text"]')).not.toHaveClass(/armed/);
  await expect(page.locator('#tool-select')).toHaveClass(/armed/);
  await page.locator('#board').click(EMPTY);
  // Drawing c lands after anything that click wrote: only a, b and c exist.
  await drawNode(page, 'c');
  expect((await stack.sql(`SELECT label FROM node WHERE board_id = ${board}`)).map(r => r.label).sort()).toEqual(['a', 'b', 'c']);
});

test('the theme picker applies, marks and remembers a theme, and ⌘K finds every theme', async ({ guest, stack }) => {
  test.setTimeout(90_000);
  // A stored theme the app does not know paints the default.
  const stale = await guest();
  await stale.context().addInitScript(() => localStorage.setItem('redcrayon-theme', 'solarized'));
  await openBoard(stale, stack.url);
  expect(await stale.evaluate(() => localStorage.getItem('redcrayon-theme'))).toBe('solarized');
  await expect(stale.locator('html')).toHaveAttribute('data-theme', 'dark');

  const page = await guest();
  await openBoard(page, stack.url);
  const html = page.locator('html'), button = page.locator('#act-theme'), pop = page.locator('#theme-pop');
  await expect(html).toHaveAttribute('data-theme', 'dark');
  await button.click();
  await expect(pop).toBeVisible();
  await expect(pop.locator('.theme-group .eyebrow')).toHaveText(['redcrayon', 'Dark', 'Light']);
  await expect(pop.locator('[data-theme-opt]')).toHaveCount(13);
  // Each option carries a swatch painted by its own theme.
  expect(await pop.locator('[data-theme-opt]').evaluateAll(opts =>
    opts.every(o => o.querySelector<HTMLElement>('.theme-swatch')?.dataset.swatch === (o as HTMLElement).dataset.themeOpt))).toBe(true);
  await expect(pop.locator('[data-theme-opt="dark"]')).toHaveAttribute('aria-pressed', 'true');

  await pop.locator('[data-theme-opt="nord"]').click();
  await expect(html).toHaveAttribute('data-theme', 'nord');
  await expect(pop).toBeHidden();
  await expect(button).toBeFocused();
  await expect(button).toHaveAttribute('aria-label', 'Theme: Nord');
  // The key the stale visitor above seeded is the one the picker writes.
  expect(await page.evaluate(() => localStorage.getItem('redcrayon-theme'))).toBe('nord');
  await button.click();
  await expect(pop.locator('[data-theme-opt="nord"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(pop.locator('[data-theme-opt="dark"]')).toHaveAttribute('aria-pressed', 'false');

  // Escape and an outside press close it; Escape hands focus back to the button.
  await pop.locator('[data-theme-opt="nord"]').focus();
  await expect(button).not.toBeFocused();
  await page.keyboard.press('Escape');
  await expect(pop).toBeHidden();
  await expect(button).toBeFocused();
  await button.click();
  await expect(pop).toBeVisible();
  await page.locator('#board').click(EMPTY);
  await expect(pop).toBeHidden();

  // ⌘K over the open picker: the palette gets the next Escape.
  await button.click();
  await expect(pop).toBeVisible();
  await palette(page);
  await expect(pop).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(page.locator('#palette')).toBeHidden();

  await reload(page);
  await expect(html).toHaveAttribute('data-theme', 'nord');

  const list = page.locator('#palette-list');
  await palette(page, 'theme light');
  for (const name of ['Light', 'Neo-brutalism', 'One Light', 'Material Light', 'Catppuccin Latte']) await expect(list).toContainText(`Theme: ${name}`);
  await expect(list).not.toContainText('Theme: Nord');
  await input(page).fill('theme: nord');
  await expect(page.getByRole('option', { name: 'Theme: Nord, current' })).toBeVisible();
  await input(page).fill('one light');
  await expect(list.locator('.palette-row').first()).toHaveText('Theme: One Light');
  await page.keyboard.press('Enter');
  await expect(html).toHaveAttribute('data-theme', 'one-light');
});
