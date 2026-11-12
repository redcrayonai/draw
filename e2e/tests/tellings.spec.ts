import type { BrowserContextOptions, Page } from '@playwright/test';
import { test, expect, openBoard, boardIdOf, boardLink, shareBoard, settledBox, nodes, type Stack } from '../fixtures';

// Tellings: walk-throughs of a board, one per audience, played step by step on the canvas.
// Seeded through the module the way an agent's save_telling tool writes them.

const NONE = { none: [] };
const PHONE: BrowserContextOptions = { viewport: { width: 390, height: 844 }, hasTouch: true };
type Account = (token?: string, options?: BrowserContextOptions) => Promise<Page>;
type Step = { nodes: number[]; body: string };

/** A board of the person's own with A→B→C→D drawn by the module; returns its node ids by label. */
async function seededBoard(stack: Stack, account: Account, options?: BrowserContextOptions) {
  const token = stack.accountToken();
  const page = await account(token, options);
  await openBoard(page, `${stack.url}?new=1`);
  const B = await boardIdOf(stack, page);
  const id: Record<string, number> = {};
  for (const [i, label] of ['A', 'B', 'C', 'D'].entries()) {
    await stack.callReducer(token, 'create_node', [B, label, '', 200 + i * 240, 200, 160, 80, 'ink', false, NONE, NONE, NONE, NONE, NONE, NONE, NONE]);
    const [row] = await stack.sql(`SELECT id FROM node WHERE board_id = ${B} AND label = '${label}'`);
    id[label] = Number(row.id);
  }
  for (const [from, to] of [['A', 'B'], ['B', 'C'], ['C', 'D']]) {
    await stack.callReducer(token, 'create_edge', [B, id[from], id[to], 'calls', 'human:e2e', NONE, NONE, NONE]);
  }
  await expect(nodes(page)).toHaveCount(4);
  return { token, page, B, id };
}

const tell = (stack: Stack, token: string, B: number, audience: string, title: string, steps: Step[]) =>
  stack.callReducer(token, 'save_telling', [B, audience, title,
    JSON.stringify(steps.map((s, i) => ({ nodes: s.nodes.map(String), title: `Step ${i + 1}`, body: s.body }))), 'e2e']);

/** Product walks A, B, then C and D; Engineers walks D then A. Bodies under 14 characters: 3.2 s a step. */
async function twoTellings(stack: Stack, token: string, B: number, id: Record<string, number>) {
  await tell(stack, token, B, 'Product', 'How an order flows', [
    { nodes: [id.A], body: 'Orders start.' }, { nodes: [id.B], body: 'B checks.' }, { nodes: [id.C, id.D], body: 'C and D end.' },
  ]);
  await tell(stack, token, B, 'Engineers', 'Where it ends', [
    { nodes: [id.D], body: 'D stores.' }, { nodes: [id.A], body: 'A begins.' },
  ]);
}

const bar = (page: Page) => page.locator('#telling-bar');
const count = (page: Page) => bar(page).locator('.telling-count');
const body = (page: Page) => bar(page).locator('.telling-body');
const button = (page: Page, act: string) => bar(page).locator(`[data-act="${act}"]`);
const node = (page: Page, id: number) => page.locator(`#world g.node[data-id="${id}"]`);
const litIds = (page: Page) => page.locator('#world g.node.telling-lit').evaluateAll(all => all.map(n => Number(n.getAttribute('data-id'))).sort());
const seenIds = (page: Page) => page.locator('#world g.node.telling-seen').evaluateAll(all => all.map(n => Number(n.getAttribute('data-id'))).sort());
const sorted = (...ids: number[]) => [...ids].sort();

/** Page errors and console errors from now on. */
function errorsOf(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  return errors;
}

test('a board with no walk-through shows no Play walk-through button', async ({ account, stack }) => {
  const { page } = await seededBoard(stack, account);
  await expect(page.locator('#act-tell')).toBeHidden();
});

test('the owner plays a walk-through step by step, switches audience, reaches the end and exits', async ({ account, stack }) => {
  test.setTimeout(90_000);
  const { token, page, B, id } = await seededBoard(stack, account);
  await twoTellings(stack, token, B, id);
  await expect(page.locator('#act-tell')).toHaveText('Play walk-through');
  await expect(page.locator('#dock')).toBeVisible();
  // D is selected before opening; it is hidden at step 1, so Delete there must not remove it.
  await node(page, id.D).locator('.node-rect').click({ position: { x: 12, y: 12 } });

  await page.locator('#act-tell').click();
  // Held still from here, before any step assertion: the next steps come from the keys alone.
  await page.keyboard.press(' ');
  await expect(button(page, 'play')).toHaveText('Play');
  await expect(page.locator('#world')).toHaveClass(/telling-on/);
  await expect(page.locator('#canvas-wrap')).toHaveClass(/telling-open/);
  await expect(count(page)).toHaveText('1 of 3');
  await expect(body(page)).toHaveText('Orders start.');
  expect(await litIds(page)).toEqual([id.A]);
  expect(await seenIds(page)).toEqual([]);
  await expect(node(page, id.A).locator('.node-step-number')).toHaveText('1');
  await expect(page.locator('#dock')).toBeHidden();
  await page.keyboard.press('Delete');

  await page.keyboard.press('ArrowRight');
  await expect(count(page)).toHaveText('2 of 3');
  await expect(body(page)).toHaveText('B checks.');
  await expect.poll(() => litIds(page)).toEqual([id.B]);
  expect(await seenIds(page)).toEqual([id.A]);
  await expect(node(page, id.B).locator('.node-step-number')).toHaveText('2');
  await expect(node(page, id.C)).not.toHaveClass(/telling-(lit|seen)/);
  await expect(node(page, id.C)).toHaveCSS('opacity', '0');
  await expect(node(page, id.B)).toHaveCSS('opacity', '1');

  await page.keyboard.press('ArrowRight');
  await expect(count(page)).toHaveText('3 of 3');
  await expect.poll(() => litIds(page)).toEqual(sorted(id.C, id.D));
  expect(await seenIds(page)).toEqual(sorted(id.A, id.B));

  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect(count(page)).toHaveText('1 of 3');
  await expect.poll(() => litIds(page)).toEqual([id.A]);

  // The other audience starts its own step 1 and plays; left alone it reaches the ending.
  const audiences = bar(page).getByRole('group', { name: 'Told for' }).getByRole('button');
  await expect(audiences).toHaveText(['Product', 'Engineers']);
  await audiences.nth(1).click();
  await button(page, 'pause').click(); // hold step 1 for its assertions, then play on
  await expect(button(page, 'play')).toHaveText('Play');
  await expect(audiences.nth(1)).toHaveAttribute('aria-pressed', 'true');
  await expect(audiences.nth(0)).toHaveAttribute('aria-pressed', 'false');
  await expect(count(page)).toHaveText('1 of 2');
  await expect(body(page)).toHaveText('D stores.');
  await expect.poll(() => litIds(page)).toEqual([id.D]);
  await button(page, 'play').click();
  await expect(button(page, 'replay')).toHaveText('Replay', { timeout: 15_000 });
  await expect(count(page)).toHaveText('');
  await expect(bar(page).locator('.telling-title')).toHaveText('Where it ends');
  await expect(body(page)).toHaveText('That is the whole walk-through.');
  await expect(button(page, 'play')).toHaveCount(0);
  await expect(button(page, 'pause')).toHaveCount(0);

  await button(page, 'exit').click();
  await expect(page.locator('#world')).not.toHaveClass(/telling-on/);
  await expect(bar(page)).toBeHidden();
  await expect(page.locator('#dock')).toBeVisible();
  await expect(page.locator('#world g.node.telling-lit, #world g.node.telling-seen')).toHaveCount(0);
  await expect(page.locator('#act-tell')).toBeFocused();
  await expect(nodes(page)).toHaveCount(4);
  expect(await stack.sql(`SELECT id FROM node WHERE board_id = ${B}`)).toHaveLength(4);
});

test('a view-link visitor sees the walk-through and plays it to step 2', async ({ account, guest, stack }) => {
  const { token, page, B, id } = await seededBoard(stack, account);
  await twoTellings(stack, token, B, id);
  const link = await shareBoard(page, 'view');
  const visitor = await guest();
  await openBoard(visitor, link);
  await expect(visitor.locator('#act-tell')).toBeVisible();
  await visitor.locator('#act-tell').click();
  await visitor.keyboard.press(' ');
  await expect(button(visitor, 'play')).toHaveText('Play');
  await expect(count(visitor)).toHaveText('1 of 3');
  await button(visitor, 'next').click();
  await expect(count(visitor)).toHaveText('2 of 3');
  await expect(body(visitor)).toHaveText('B checks.');
  await expect.poll(() => litIds(visitor)).toEqual([id.B]);
});

test('with reduced motion Play is disabled and Next still steps', async ({ account, stack }) => {
  const { token, page, B, id } = await seededBoard(stack, account, { reducedMotion: 'reduce' });
  await twoTellings(stack, token, B, id);
  await page.locator('#act-tell').click();
  await expect(count(page)).toHaveText('1 of 3');
  await expect(button(page, 'play')).toBeDisabled();
  await expect(button(page, 'play')).toHaveAttribute('title', 'Motion is reduced on this device. Use Next.');
  await expect(bar(page).locator('.telling-hint')).toBeVisible();
  await expect(bar(page).locator('.telling-hint')).toHaveText('Motion is reduced on this device. Use Next.');
  await button(page, 'next').click();
  await expect(count(page)).toHaveText('2 of 3');
  await expect.poll(() => litIds(page)).toEqual([id.B]);
  await page.keyboard.press('Escape');
  await expect(bar(page)).toBeHidden();
  await expect(page.locator('#act-tell')).toBeFocused();
});

test('a step whose node was deleted still plays its words without a page error', async ({ account, stack }) => {
  const { token, page, B, id } = await seededBoard(stack, account);
  const errors = errorsOf(page);
  await twoTellings(stack, token, B, id);
  await stack.callReducer(token, 'delete_node', [id.B]);
  await expect(nodes(page)).toHaveCount(3);

  await page.locator('#act-tell').click();
  await page.keyboard.press(' ');
  await page.keyboard.press('ArrowRight');
  await expect(count(page)).toHaveText('2 of 3');
  await expect(body(page)).toHaveText('B checks.');
  await expect.poll(() => seenIds(page)).toEqual([id.A]);
  expect(await litIds(page)).toEqual([]);
  await page.keyboard.press('ArrowRight');
  await expect(count(page)).toHaveText('3 of 3');
  await expect.poll(() => litIds(page)).toEqual(sorted(id.C, id.D));
  expect(errors).toEqual([]);
});

test('on a phone six long audiences and a full body fit without sideways scroll', async ({ account, stack }) => {
  test.setTimeout(60_000);
  const { token, page, B, id } = await seededBoard(stack, account, PHONE);
  const word = 'x'.repeat(60);
  const long = `${word} ${'words that wrap '.repeat(30)}`.slice(0, 280);
  expect(long).toHaveLength(280);
  for (let i = 0; i < 6; i++) {
    await tell(stack, token, B, `Audience ${i + 1} `.padEnd(40, 'y'), 'A long walk-through', [{ nodes: [id.A], body: long }]);
  }
  await page.locator('#act-tell').click();
  await expect(body(page)).toHaveText(long);
  await expect(bar(page).getByRole('group', { name: 'Told for' }).getByRole('button')).toHaveCount(6);

  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  // The long word wraps inside the bar rather than running past its edge (clipped, so the page width misses it).
  expect(await body(page).evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
  // The bar scrolls past 60% of the canvas instead of covering the board.
  const barHeight = await bar(page).evaluate(el => el.getBoundingClientRect().height);
  const wrapHeight = await page.locator('#canvas-wrap').evaluate(el => el.getBoundingClientRect().height);
  expect(barHeight).toBeLessThanOrEqual(wrapHeight * 0.6 + 1);
  const exit = button(page, 'exit');
  await expect(exit).toBeVisible();
  await expect(exit).toBeInViewport({ ratio: 1 });
  for (const b of await bar(page).locator('button').all()) {
    const box = (await b.boundingBox())!;
    expect(box.x, await b.innerText()).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, await b.innerText()).toBeLessThanOrEqual(390);
  }
});

test('after a click on Next, Space presses Next again and neither pans nor toggles play', async ({ account, stack }) => {
  const { token, page, B, id } = await seededBoard(stack, account);
  await twoTellings(stack, token, B, id);
  await page.locator('#act-tell').click();
  await page.keyboard.press(' ');
  await expect(button(page, 'play')).toBeVisible();
  await expect(count(page)).toHaveText('1 of 3');
  await button(page, 'next').click();
  await expect(count(page)).toHaveText('2 of 3');

  await page.keyboard.down(' ');
  await expect(page.locator('#board')).not.toHaveClass(/panning/);
  await page.keyboard.up(' ');
  await expect(count(page)).toHaveText('3 of 3');
  await expect(button(page, 'play')).toBeVisible();
  await expect(button(page, 'pause')).toHaveCount(0);
  await expect(button(page, 'next')).toBeFocused();
});

test('the first step frames its node clear of the bar', async ({ account, stack }) => {
  const { token, page, B, id } = await seededBoard(stack, account);
  await twoTellings(stack, token, B, id);
  await page.locator('#act-tell').click();
  await page.keyboard.press(' '); // hold step 1 while the camera settles
  await expect(count(page)).toHaveText('1 of 3');
  const lit = await settledBox(node(page, id.A).locator('.node-rect'));
  const box = (await bar(page).boundingBox())!;
  const overlaps = lit.x < box.x + box.width && box.x < lit.x + lit.width && lit.y < box.y + box.height && box.y < lit.y + lit.height;
  expect(overlaps, `node ${JSON.stringify(lit)} under bar ${JSON.stringify(box)}`).toBe(false);
});
