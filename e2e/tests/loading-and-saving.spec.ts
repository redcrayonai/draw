import type { Page } from '@playwright/test';
import { test, expect, openBoard, drawNode, shareBoard, boardIdOf, settledBox } from '../fixtures';

/**
 * The editor chunk start.ts imports after painting the loading screen. The page's own entry is
 * named main-*.js too (Vite's `main` input since the embed page, #163): the served index.html's
 * module script tells them apart.
 */
async function editorChunk(stack: { url: string }) {
  const entry = (await (await fetch(stack.url)).text()).match(/<script type="module"[^>]*src="([^"]+)"/)![1];
  return (url: URL) => /^\/assets\/main-[^/]+\.js$/.test(url.pathname) && url.pathname !== entry;
}
const WRITE_RULE = 'write rule: too many writes from this identity; wait a minute';
const hexOf = (page: Page) => page.evaluate(() => (window as any).myIdentityHex as string);
const row = async (stack: { sql(q: string): Promise<Record<string, unknown>[]> }, query: string) => (await stack.sql(query))[0];

test('?new=1 starts exactly one fresh board, and the older board stays reachable', async ({ guest, stack }) => {
  const page = await guest();
  await openBoard(page, stack.url);
  await drawNode(page, 'First');
  const first = page.url();
  const firstId = await boardIdOf(stack, page);
  const hex = await hexOf(page);
  const owned = async () => (await stack.sql(`SELECT board_id FROM board_grant WHERE grantee = 0x${hex} AND role = 'owner'`)).map(r => Number(r.board_id));
  const before = (await owned()).length;

  await openBoard(page, `${stack.url}?new=1`);
  await expect(page).not.toHaveURL(/new=1/);
  const second = page.url();
  expect(second).not.toBe(first);
  await expect(page.locator('#world g.node')).toHaveCount(0);
  expect((await owned()).length).toBe(before + 1);

  // A reload of the cleaned URL (a retried boot) starts no other board.
  await page.reload();
  await expect(page.locator('#canvas-wrap')).toHaveAttribute('aria-busy', 'false');
  await expect(page).toHaveURL(second);
  expect((await owned()).length).toBe(before + 1);

  await openBoard(page, stack.url);
  await expect(page).toHaveURL(second);
  await page.goto(first);
  await expect(page.locator('#world')).toContainText('First');
  expect(await owned()).toContain(firstId);
});

test('two tabs of one guest each draw on their own board only', async ({ guest, stack }) => {
  const a = await guest();
  await openBoard(a, stack.url);
  await drawNode(a, 'Alpha');
  const b = await a.context().newPage();
  await openBoard(b, `${stack.url}?new=1`);
  expect(await hexOf(b)).toBe(await hexOf(a)); // the same guest identity
  await expect(b.locator('#world g.node')).toHaveCount(0); // Alpha was stored before b loaded
  await drawNode(b, 'Beta');
  // A tab's own write is acknowledged after every earlier commit reached it, so Beta would be here by now.
  await drawNode(a, 'Alpha 2');
  await expect(a.locator('#world g.node')).toHaveCount(2);
  await expect(a.locator('#world')).not.toContainText('Beta');
  await drawNode(b, 'Beta 2'); // the same anchor in b, after Alpha 2
  await expect(b.locator('#world g.node')).toHaveCount(2);
  await expect(b.locator('#world')).not.toContainText('Alpha');
  await b.close();
  await a.reload();
  await expect(a.locator('#world')).toContainText('Alpha 2');
  await expect(a.locator('#world g.node')).toHaveCount(2);
  await expect(a.locator('#world')).not.toContainText('Beta');
});

test('the loading screen holds the canvas until it is ready, and a failed start offers Reload', async ({ guest, stack }) => {
  const page = await guest();
  await openBoard(page, stack.url);
  await drawNode(page, 'Ready');
  const MAIN_CHUNK = await editorChunk(stack);
  let release!: () => void, requested!: () => void;
  const gate = new Promise<void>(resolve => (release = resolve));
  const asked = new Promise<void>(resolve => (requested = resolve));
  await page.route(MAIN_CHUNK, async route => { requested(); await gate; await route.continue(); });
  // What the canvas showed at the moment the screen left: it must leave only after the first render.
  await page.addInitScript(() => addEventListener('DOMContentLoaded', () => {
    const panel = document.getElementById('board-loading')!;
    new MutationObserver((_, observer) => {
      if (!panel.hidden) return;
      observer.disconnect();
      (window as any).__shownWhenReady = `${document.getElementById('board-title')!.textContent}|${document.querySelectorAll('#world g.node').length}`;
    }).observe(panel, { attributes: true, attributeFilter: ['hidden'] });
  }));
  await page.reload({ waitUntil: 'commit' });
  await asked; // start.ts painted the screen and is waiting for the editor
  const wrap = page.locator('#canvas-wrap');
  await expect(page.locator('#loading-caption')).toHaveText('Loading board…');
  await expect(page.locator('#board-loading')).toBeVisible();
  await expect(wrap).toHaveAttribute('aria-busy', 'true');
  await expect(wrap).toHaveAttribute('inert', '');
  release();
  await expect(page.locator('#board-loading')).toBeHidden();
  await expect(wrap).toHaveAttribute('aria-busy', 'false');
  await expect(wrap).not.toHaveAttribute('inert');
  expect(await page.evaluate(() => (window as any).__shownWhenReady)).toBe('Untitled board|1');
  await expect(page.locator('#world')).toContainText('Ready');

  const broken = await guest();
  await broken.route(MAIN_CHUNK, route => route.abort());
  await broken.goto(stack.url);
  await expect(broken.locator('#loading-caption')).toHaveText('The board could not load. Please reload.');
  await expect(broken.locator('#board-loading')).toHaveAttribute('role', 'alert');
  await expect(broken.locator('#loading-orb')).toBeHidden();
  await broken.unroute(MAIN_CHUNK);
  await broken.getByRole('button', { name: 'Reload', exact: true }).click();
  await expect(broken.locator('#board-title')).not.toBeEmpty();
  await expect(broken.locator('#canvas-wrap')).toHaveAttribute('aria-busy', 'false');
  await expect(broken.locator('#board-loading')).toBeHidden();
});

test('a lost connection shows the reconnect panel and returns to the same board', async ({ guest, stack }) => {
  test.setTimeout(60_000);
  const page = await guest();
  await openBoard(page, stack.url);
  await drawNode(page, 'Kept');
  const href = page.url();
  let blocked = true;
  await page.routeWebSocket(/\/v1\/database\//, ws => { if (blocked) ws.close(); else ws.connectToServer(); });
  // Each backoff attempt reloads the page, so keep every panel's first line in this tab's sessionStorage.
  await page.addInitScript(() => new MutationObserver((_, observer) => {
    const panel = document.getElementById('reconnect');
    if (!panel) return;
    observer.disconnect();
    sessionStorage.setItem('e2e-reconnect', `${sessionStorage.getItem('e2e-reconnect') ?? ''}${panel.firstChild?.textContent}|`);
  }).observe(document, { childList: true, subtree: true }));
  await page.reload();
  const panel = page.locator('#reconnect');
  // Wait out two retries: the 4 s panel leaves time to unblock and click before the next reload.
  await expect(panel).toContainText('We’re having trouble connecting. Retrying in 4s…');
  expect(await page.evaluate(() => sessionStorage.getItem('e2e-reconnect'))).toBe(
    ['1s', '2s', '4s'].map(s => `We’re having trouble connecting. Retrying in ${s}…|`).join(''));
  const retry = page.getByRole('button', { name: 'Retry now' });
  await expect(retry).toBeVisible();
  blocked = false;
  await retry.click();
  await expect(page.locator('#world')).toContainText('Kept');
  await expect(page).toHaveURL(href);
  await expect(panel).toHaveCount(0);
});

test('a build without hosted URLs offers no Connect, dashboard link or live switch', async ({ account, guest, stack }) => {
  const page = await account();
  await openBoard(page, stack.url); // the bare root: an account would go to the dashboard
  await expect(page.locator('#error-text')).toHaveText('The dashboard is unavailable. You can still start a board here.');
  await expect(page.locator('#account-name')).toBeVisible();
  await expect(page.locator('#act-connect')).toHaveCount(0);
  await expect(page.locator('#empty-connect')).toHaveCount(0);
  await expect(page.locator('#rail-hint')).toBeVisible(); // the rail is up (a blank board has no evidence switch)
  await expect(page.locator('#live-row')).toBeHidden();
  const boards = page.locator('#crumb-boards');
  await expect(boards).toHaveText('Boards');
  await expect(boards).toBeVisible();
  await expect(boards).not.toHaveAttribute('href');
  await expect(page.locator('.crumb-sep')).toBeVisible();

  await page.keyboard.press('ControlOrMeta+k');
  const input = page.locator('#palette-input'), list = page.locator('#palette-list');
  await expect(input).toBeFocused();
  await expect(list).toContainText('Keyboard shortcuts');
  await input.fill('mcp');
  await expect(list).not.toContainText('Keyboard shortcuts'); // the filter ran
  await expect(list).not.toContainText('Connect an agent');
  await input.fill('dashboard');
  await expect(list).not.toContainText('Keyboard shortcuts');
  await expect(list).not.toContainText('Go to dashboard');
  await page.keyboard.press('Escape');
  await expect(page.locator('#palette')).toBeHidden();
  await drawNode(page, 'Fallback');

  const visitor = await guest();
  await openBoard(visitor, stack.url);
  await expect(visitor.locator('#sign-in')).toBeVisible();
  await expect(visitor.locator('#crumb-boards')).toBeHidden();
  await expect(visitor.locator('.crumb-sep')).toBeHidden();
});

test('the save badge reports acknowledged writes and ignores presence and library writes', async ({ guest, stack }) => {
  const page = await guest();
  await openBoard(page, stack.url);
  await page.evaluate(() => {
    const status = document.getElementById('save-status')!;
    (window as any).__saves = [];
    new MutationObserver(() => (window as any).__saves.push(`${status.dataset.state}:${status.textContent}`))
      .observe(status, { attributes: true, childList: true, characterData: true, subtree: true });
  });
  const saves = () => page.evaluate(() => (window as any).__saves as string[]);
  await drawNode(page, 'Payments');
  await expect.poll(async () => (await saves()).at(-1)).toBe('saved:Saved');
  expect(await saves()).toContain('pending:Saving…');
  await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toHaveAttribute('title', 'Changes saved to the board');

  // Presence and the personal library reach the server but leave the badge alone.
  await page.evaluate(() => { (window as any).__saves = []; });
  const hex = await hexOf(page);
  const node = page.locator('#world g.node').first();
  const id = await node.getAttribute('data-id');
  const selected = async () => JSON.stringify((await row(stack, `SELECT node_ids FROM selection WHERE identity = 0x${hex}`))?.node_ids);
  // drawNode's clicks may have stored a cursor already: wait for this move to change it.
  const cursor = async () => JSON.stringify(await row(stack, `SELECT x, y FROM cursor WHERE identity = 0x${hex}`));
  const cursor0 = await cursor();
  await page.mouse.move(300, 300);
  await page.mouse.move(600, 400, { steps: 10 });
  await expect.poll(cursor).not.toBe(cursor0);
  expect(await cursor()).toContain('"x"');
  await node.locator('.node-rect').click();
  await expect.poll(selected).toContain(id!);
  page.once('dialog', dialog => dialog.accept('Mine'));
  await page.keyboard.press('Shift+L');
  await expect(page.locator('#error-text')).toHaveText('Saved "Mine" to your library');
  expect((await stack.sql(`SELECT name FROM library_item WHERE owner = 0x${hex}`)).map(r => r.name)).toEqual(['Mine']);
  await page.locator('#board').click({ position: { x: 60, y: 400 } });
  await expect.poll(selected).toBe('[]');
  expect(await saves()).toEqual([]);
});

test("a refused write shows Save failed and the module's sentence; geometry still saves", async ({ guest, stack }) => {
  test.setTimeout(60_000);
  const page = await guest();
  await openBoard(page, `${stack.url}?new=1`);
  await drawNode(page, 'Kept');
  const hex = await hexOf(page);
  const boardId = await boardIdOf(stack, page);
  // A refused call rolls back its spend, so a negative bucket stays refused for the whole test.
  await stack.sql(`UPDATE write_budget SET tokens = -1000.0 WHERE identity = 0x${hex}`);
  expect(Number((await row(stack, `SELECT tokens FROM write_budget WHERE identity = 0x${hex}`))!.tokens)).toBe(-1000);
  const status = page.locator('#save-status');
  const node = page.locator('#world g.node').first();

  // RS-16: a refused rename.
  await node.dblclick();
  await page.locator('#inline-edit').fill('Renamed');
  await page.locator('#inline-edit').press('Enter');
  await expect(status).toHaveText('Save failed');
  await expect(status).toHaveAttribute('data-state', 'error');
  await expect(status).toHaveAttribute('title', WRITE_RULE);

  // BL-37: a refused placement shows the sentence and adds no node.
  await page.locator('#error-dismiss').click();
  await expect(page.locator('#error-strip')).toBeHidden();
  await page.keyboard.press('1');
  await page.locator('#board').click({ position: { x: 720, y: 420 } });
  await page.keyboard.press('Escape');
  // Dismiss only hides the strip and keeps the rename's text: the strip showing again is the new refusal.
  await expect(page.locator('#error-strip')).toBeVisible();
  await expect(page.locator('#error-text')).toHaveText(WRITE_RULE);
  await expect(page.locator('#world g.node')).toHaveCount(1);
  expect((await stack.sql(`SELECT label FROM node WHERE board_id = ${boardId}`)).map(r => r.label)).toEqual(['Kept']);

  // BL-38: a drag spends no budget, so the move is saved.
  await page.locator('#error-dismiss').click();
  const id = await node.getAttribute('data-id');
  const x = async () => Number((await row(stack, `SELECT x FROM node WHERE id = ${id}`))!.x);
  const x0 = await x();
  const box = await settledBox(node.locator('.node-rect'));
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 160, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect.poll(x).toBeGreaterThan(x0);
  await expect(status).toHaveText('Saved');
  await expect(page.locator('#error-strip')).toBeHidden();
  const x1 = await x();

  await page.reload();
  await expect(page.locator('#world')).toContainText('Kept');
  await expect(page.locator('#world')).not.toContainText('Renamed');
  await expect(node).toHaveAttribute('transform', new RegExp(`^translate\\(${x1} `));

  await stack.sql(`DELETE FROM write_budget WHERE identity = 0x${hex}`);
  await drawNode(page, 'After');
  await expect(status).toHaveAttribute('data-state', 'saved');
  await expect.poll(async () => (await stack.sql(`SELECT label FROM node WHERE board_id = ${boardId}`)).map(r => r.label).sort()).toEqual(['After', 'Kept']);
});

test('pointer presence spends no write budget', async ({ guest, account, stack }) => {
  test.setTimeout(60_000);
  const owner = await guest();
  await openBoard(owner, stack.url);
  await drawNode(owner, 'Budget');
  const link = await shareBoard(owner, 'edit');
  await owner.keyboard.press('Escape');
  const ownerHex = await hexOf(owner);
  const watcher = await account();
  await openBoard(watcher, link);
  await expect(watcher.locator('#world')).toContainText('Budget');
  await watcher.evaluate(hex => {
    const w = window as any;
    w.__moves = 0;
    const count = (row: { identity: { toHexString(): string } }) => { if (row.identity.toHexString() === hex) w.__moves++; };
    w.conn.db.visibleCursor.onInsert((_ctx: unknown, row: any) => count(row));
    w.conn.db.visibleCursor.onUpdate((_ctx: unknown, _old: unknown, row: any) => count(row));
  }, ownerHex);
  const budget = async () => JSON.stringify(await row(stack, `SELECT tokens, refilled_at FROM write_budget WHERE identity = 0x${ownerHex}`));
  const spent = await budget();
  expect(spent).toContain('tokens');

  // More moves than a guest's 60 a minute plus refill: each one reaches the watcher.
  let i = 0;
  await expect.poll(async () => {
    await owner.mouse.move(300 + (i % 40) * 10, 300 + (i++ % 2) * 30);
    return watcher.evaluate(() => (window as any).__moves as number);
  }, { intervals: [30], timeout: 20_000 }).toBeGreaterThanOrEqual(75);
  expect(await budget()).toBe(spent);
  await expect(owner.locator('#world')).toContainText('Budget');
  await expect(owner.locator('#error-text')).not.toContainText('write rule');
  await drawNode(owner, 'After waving');
});
