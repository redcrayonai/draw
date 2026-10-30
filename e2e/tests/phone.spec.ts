import type { Locator, Page } from '@playwright/test';
import { test, expect, drawNode, openBoard, shareBoard, fingers, view, settledBox } from '../fixtures';

// A phone from the first load (cloud/docs/investor-demo-user-journeys.md, PR #149).
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true };

type Point = { x: number; y: number };

/** One-frame taps, back to back on one session so a double-tap lands well inside its 400 ms window. */
async function taps(page: Page, at: Point[]) {
  const cdp = await page.context().newCDPSession(page);
  for (const p of at) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...p, id: 0 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }
}

/** The centre of the element once two reads 250 ms apart agree (a reveal pan glides 200 ms). */
async function centre(locator: Locator): Promise<Point> {
  const b = await settledBox(locator);
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

/** Bare canvas under the point: the board itself, no node, panel or control on top. */
async function expectEmptyCanvas(page: Page, p: Point) {
  expect(await page.evaluate(({ x, y }) => {
    const hit = document.elementFromPoint(x, y);
    return hit !== null && hit.closest('#board') !== null && hit.closest('g.node') === null;
  }, p), `canvas at ${p.x},${p.y} is not bare`).toBe(true);
}

/** A phone visitor's own way to draw: the dock's Service tool, a tap on the board, then the Select tool. */
async function placeService(page: Page, at: Point) {
  const nodes = page.locator('#world g.node');
  const count = await nodes.count();
  await page.locator('#dock [data-kind="service"]').tap();
  await page.locator('#board').tap({ position: at });
  await expect(nodes).toHaveCount(count + 1);
  await page.locator('#tool-select').tap();
  await expect(page.locator('#save-status')).toHaveText('Saved');
}

const nodeRow = async (stack: { sql(q: string): Promise<Record<string, unknown>[]> }, id: string) =>
  (await stack.sql(`SELECT x, y FROM node WHERE id = ${id}`)).map(r => [Number(r.x), Number(r.y)])[0];

test('on a phone the side panel starts collapsed and the toggle remembers the choice', async ({ guest, stack }) => {
  test.setTimeout(90_000);
  const page = await guest(PHONE);
  await openBoard(page, stack.url);
  const rail = page.locator('#rail'), toggle = page.locator('#rail-toggle');
  // Collapsed is opacity 0 and pointer-events none, so the class is the signal.
  await expect(rail).toHaveClass(/collapsed/);
  await expect(page.locator('body')).toHaveClass(/rail-collapsed/);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle).toHaveAttribute('title', 'Show the board panel');
  await toggle.tap();
  await expect(rail).not.toHaveClass(/collapsed/);
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(toggle).toHaveAttribute('title', 'Hide the board panel');
  expect(await page.evaluate(() => localStorage.getItem('redcrayon-rail'))).toBe('open');

  // A stored 'open' beats the phone default.
  await page.reload();
  await expect(page.locator('#board-title')).not.toBeEmpty();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(rail).not.toHaveClass(/collapsed/);

  // A laptop starts open; collapsing is stored and beats the laptop default.
  const laptop = await guest();
  await openBoard(laptop, stack.url);
  const lapToggle = laptop.locator('#rail-toggle');
  await expect(lapToggle).toHaveAttribute('aria-expanded', 'true');
  expect(await laptop.evaluate(() => localStorage.getItem('redcrayon-rail'))).toBeNull();
  await lapToggle.click();
  await expect(laptop.locator('#rail')).toHaveClass(/collapsed/);
  expect(await laptop.evaluate(() => localStorage.getItem('redcrayon-rail'))).toBe('collapsed');
  await laptop.reload();
  await expect(laptop.locator('#board-title')).not.toBeEmpty();
  await expect(laptop.locator('#rail')).toHaveClass(/collapsed/);
  await expect(lapToggle).toHaveAttribute('aria-expanded', 'false');
});

test('phone controls fit without overflow or overlap', async ({ guest, stack }) => {
  const page = await guest(PHONE);
  await openBoard(page, stack.url);
  await placeService(page, { x: 120, y: 260 });

  const boxes = await page.evaluate(() => ['#rail-toggle', '#crumb-boards', '#board-title', '#branch-chip', '#exposure-chip', '#board-counts',
    '#save-status', '#live', '#participants-label', '#act-review', '#act-theme', '#act-rescan', '#act-connect', '#act-share', '#act-export',
    '#sign-in', '#dock', '.zoom-cluster', '#shortcuts-toggle']
    .flatMap(s => [...document.querySelectorAll(s)].filter(e => e.getClientRects().length > 0).map(e => {
      const r = e.getBoundingClientRect();
      return { s, l: r.left, t: r.top, r: r.right, b: r.bottom };
    })));
  // The crowded header a guest sees with a node is measured, not filtered away.
  expect(boxes.map(b => b.s)).toEqual(expect.arrayContaining(['#rail-toggle', '#board-title', '#branch-chip', '#save-status', '#live',
    '#participants-label', '#act-review', '#act-theme', '#act-share', '#sign-in', '#dock', '.zoom-cluster', '#shortcuts-toggle']));
  for (const b of boxes) {
    expect(b.l, `${b.s} left`).toBeGreaterThanOrEqual(0);
    expect(b.t, `${b.s} top`).toBeGreaterThanOrEqual(0);
    expect(b.r, `${b.s} right`).toBeLessThanOrEqual(390);
    expect(b.b, `${b.s} bottom`).toBeLessThanOrEqual(844);
  }
  for (const [i, a] of boxes.entries()) {
    for (const c of boxes.slice(i + 1)) {
      const apart = Math.min(a.r, c.r) - Math.max(a.l, c.l) <= 0 || Math.min(a.b, c.b) - Math.max(a.t, c.t) <= 0;
      expect(apart, `${a.s} overlaps ${c.s}`).toBe(true);
    }
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  // The dock may scroll sideways inside itself (PR #164), but every tool keeps a 44 px target (flex: none, not squeezed).
  const sizes = await page.locator('#dock .tool').evaluateAll(els => els.map(e => [e.getBoundingClientRect().width, e.getBoundingClientRect().height]));
  expect(sizes.length).toBeGreaterThan(0);
  for (const size of sizes) expect(size).toEqual([44, 44]);
});

test('a phone visitor places, labels, exports, zooms and opens help and the library', async ({ guest, stack }) => {
  test.setTimeout(90_000);
  const page = await guest(PHONE);
  await openBoard(page, stack.url);
  await placeService(page, { x: 120, y: 260 });
  const node = page.locator('#world g.node');
  await expect(node).toHaveCount(1);

  // A double-tap on the node opens its label editor.
  const c = await centre(node.locator('.node-rect'));
  await taps(page, [c, c]);
  const edit = page.locator('#inline-edit');
  await edit.fill('Phone API');
  await edit.press('Enter');
  await expect(page.locator('#world')).toContainText('Phone API');
  await expect(page.locator('#save-status')).toHaveText('Saved');
  // The label is on the server, so the reload below cannot pass on a stale page.
  const id = (await node.getAttribute('data-id'))!;
  await expect.poll(async () => (await stack.sql(`SELECT label FROM node WHERE id = ${id}`))[0]?.label).toBe('Phone API');

  await page.reload();
  await expect(page.locator('#canvas-wrap')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('#world')).toContainText('Phone API');

  // Read the zoom only once the load's fit has settled, so the change below is the tap's.
  await view(page);
  const zoom = page.locator('#hud-zoom');
  const percent = async () => parseInt((await zoom.textContent())!, 10);
  const before = await percent();
  expect(before).toBeGreaterThan(0);
  await page.locator('#hud-zoom-in').tap();
  await expect.poll(percent).toBeGreaterThan(before);

  const toggle = page.locator('#shortcuts-toggle'), help = page.locator('#shortcuts');
  await toggle.tap();
  await expect(help).toBeVisible();
  await toggle.tap();
  await expect(help).toBeHidden();

  // The dock scrolls sideways to its last tool.
  const library = page.locator('#tool-library');
  await library.scrollIntoViewIfNeeded();
  await library.tap();
  await expect(page.locator('#library-popover')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#library-popover')).toBeHidden();

  const download = page.waitForEvent('download');
  await page.locator('#act-share').tap(); // owners export from the Share popover
  await page.getByRole('button', { name: 'Export SVG', exact: true }).tap();
  let svg = '';
  for await (const chunk of (await (await download).createReadStream())!) svg += chunk;
  expect(svg).toContain('Phone API');
});

test('a tap on a node selects it and a tap on bare canvas clears it, writing nothing', async ({ guest, stack }) => {
  const page = await guest(PHONE);
  await openBoard(page, stack.url);
  await placeService(page, { x: 120, y: 260 });
  const node = page.locator('#world g.node');
  const id = (await node.getAttribute('data-id'))!;
  const stored = await nodeRow(stack, id);
  const handles = page.locator('#world .resize-handle');
  const c = await centre(node.locator('.node-rect'));
  // Left of the node, between the selection toolbar above and the inspector sheet below.
  const bare = { x: 40, y: c.y };

  // A placed node is selected; a tap on bare canvas clears it.
  await expect(handles).not.toHaveCount(0);
  await expect(page.locator('#inspector')).toContainText('Service');
  await expectEmptyCanvas(page, bare);
  await taps(page, [bare]);
  await expect(handles).toHaveCount(0);
  await expect(page.locator('#inspector')).not.toContainText('Service');

  await taps(page, [c]);
  await expect(handles).not.toHaveCount(0);
  await expect(page.locator('#inspector')).toContainText('Service');

  // Far enough after the node tap that the two are not a double-tap.
  await expect(page.locator('#inline-edit')).toHaveCount(0);
  await taps(page, [bare]);
  await expect(handles).toHaveCount(0);
  await expect(page.locator('#inspector')).not.toContainText('Service');

  // A write would turn the status to Saving… at once; Saved means any write is acked before the read.
  await expect(page.locator('#save-status')).toHaveText('Saved');
  await expect(node).toHaveCount(1);
  const [{ board_id: board }] = await stack.sql(`SELECT board_id FROM node WHERE id = ${id}`);
  expect(await stack.sql(`SELECT id FROM node WHERE board_id = ${board}`)).toHaveLength(1);
  expect(await nodeRow(stack, id)).toEqual(stored);
});

test('swipes never place text, and a real double-tap does', async ({ guest, stack }) => {
  const page = await guest(PHONE);
  await openBoard(page, stack.url);
  const nodes = page.locator('#world g.node');
  await expect(nodes).toHaveCount(0);
  const start = { x: 120, y: 400 };
  await expectEmptyCanvas(page, start);
  const before = await view(page);
  await page.evaluate(() => {
    const downs: number[] = ((window as any).__downs = []);
    document.getElementById('board')!.addEventListener('pointerdown', e => downs.push(e.timeStamp), true);
  });

  // Two quick 30 px swipes from the same spot: each travels past the tap slop, so neither is a tap.
  const swipe = [0, 10, 20, 30].map(d => [{ x: start.x + d, y: start.y }]);
  await fingers(page, swipe);
  await fingers(page, swipe);
  expect((await view(page)).tx - before.tx).toBe(60);
  // Both presses fall inside the 400 ms double-tap window, so only the slop rule keeps them apart.
  const downs = await page.evaluate(() => (window as any).__downs as number[]);
  expect(downs).toHaveLength(2);
  expect(downs[1] - downs[0]).toBeLessThan(400);
  await expect(nodes).toHaveCount(0);
  await expect(page.locator('#inline-edit')).toHaveCount(0);

  // A finger drifts a little between the two taps of a real double-tap.
  await taps(page, [start, { x: start.x + 5, y: start.y }]);
  await expect(page.locator('#inline-edit.text')).toBeFocused();
  await expect(nodes).toHaveCount(1);
});

test('on a read-only board a finger over a node pans, and a tap selects it', async ({ guest, stack }) => {
  test.setTimeout(90_000);
  const owner = await guest();
  await openBoard(owner, stack.url);
  await drawNode(owner, 'api');
  const id = (await owner.locator('#world g.node').getAttribute('data-id'))!;
  const stored = await nodeRow(stack, id);
  const link = await shareBoard(owner, 'view');

  const viewer = await guest(PHONE);
  await viewer.goto(link);
  await expect(viewer.locator('#canvas-wrap')).toHaveAttribute('aria-busy', 'false');
  await expect(viewer.locator('#world')).toContainText('api');
  await expect(viewer.locator('#board-title')).toContainText('view only');
  const node = viewer.locator('#world g.node');
  const outline = viewer.locator('#world .selection-outline');
  const c = await centre(node.locator('.node-rect'));
  const before = await view(viewer);
  const placed = await node.getAttribute('transform');

  await fingers(viewer, [0, 20, 40, 60].map(d => [{ x: c.x + d, y: c.y }]));
  const after = await view(viewer);
  expect([after.tx - before.tx, after.ty - before.ty]).toEqual([60, 0]);
  // The board moved, not the node within it.
  await expect(node).toHaveAttribute('transform', placed!);
  // A pan is not a tap: nothing is selected.
  await expect(outline).toHaveCount(0);
  await expect(viewer.locator('#inspector')).not.toContainText('api');
  expect(await nodeRow(stack, id)).toEqual(stored);

  const moved = await centre(node.locator('.node-rect'));
  expect(moved.x - c.x).toBeCloseTo(60, 0);
  await taps(viewer, [moved]);
  await expect(outline).toHaveCount(1);
  await expect(viewer.locator('#inspector')).toContainText('api');
  expect(await nodeRow(stack, id)).toEqual(stored);
});

test('a cancelled touch drag puts the node back and writes nothing', async ({ guest, stack }) => {
  const page = await guest(PHONE);
  await openBoard(page, stack.url);
  await placeService(page, { x: 120, y: 260 });
  const node = page.locator('#world g.node');
  const id = (await node.getAttribute('data-id'))!;
  const stored = await nodeRow(stack, id);
  const c = await centre(node.locator('.node-rect'));
  const at = await node.getAttribute('transform');

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...c, id: 0 }] });
  for (const dx of [40, 80]) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: c.x + dx, y: c.y, id: 0 }] });
  }
  // The drag is live on screen before the system takes the pointer.
  await expect(node).not.toHaveAttribute('transform', at!);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
  await expect(node).toHaveAttribute('transform', at!);

  // A later write from the same page lands after anything the cancel could have sent.
  const [{ board_id: board }] = await stack.sql(`SELECT board_id FROM node WHERE id = ${id}`);
  const bare = { x: 40, y: c.y };
  await expectEmptyCanvas(page, bare);
  await taps(page, [bare]); // clears the selection, so the inspector sheet leaves the lower board free
  await expect(page.locator('#world .resize-handle')).toHaveCount(0);
  await placeService(page, { x: 120, y: 520 });
  await expect.poll(async () => (await stack.sql(`SELECT id FROM node WHERE board_id = ${board}`)).length).toBe(2);
  expect(await nodeRow(stack, id)).toEqual(stored);
});
