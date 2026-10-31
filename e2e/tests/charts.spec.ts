import type { Page } from '@playwright/test';
import { test, expect, openBoard, drawNode, shareBoard, boardIdOf, linkedAgent, guestToken, settledBox, type Stack } from '../fixtures';
import { CHART_CONTRACTS, CHART_TYPES } from '../../module/src/chart-contracts';

// Chart cards (spec 2026-10-09, PR #43, PR #144): library placement, the eleven
// types, live delivery, read-only readers, the source rule, duplicate/undo, export.
const NONE = { none: [] };
const READ_ONLY = 'not authorized: board is read only';
const WIDE = { viewport: { width: 1440, height: 900 } };
type ChartRow = { node_id: number; type: string; csv: string; options: string; source: string };

const charts = (page: Page) => page.locator('#world g.node-chart');
const card = (page: Page, id: number) => page.locator(`#world g.node-chart[data-id="${id}"]`);
/** Select a chart by a click on its title, or on its type tag: two clicks on one spot within 400 ms rename it. */
async function select(page: Page, id: number, on: 'title' | 'tag' = 'title') {
  await page.keyboard.press('Escape');
  await card(page, id).locator(`text.chart-${on}`).click();
}

const chartRow = async (stack: Stack, id: number) =>
  (await stack.sql(`SELECT node_id, type, csv, options, source FROM chart WHERE node_id = ${id}`))[0] as ChartRow | undefined;
const chartRows = async (stack: Stack, B: number) =>
  (await stack.sql(`SELECT node_id, type, csv, options, source FROM chart WHERE board_id = ${B}`)) as ChartRow[];
const nodeBox = async (stack: Stack, id: number) => {
  const [n] = await stack.sql(`SELECT x, y, w, h FROM node WHERE id = ${id}`);
  return { x: Number(n.x), y: Number(n.y), w: Number(n.w), h: Number(n.h) };
};

/** Place a chart tile from the library search; returns the new chart's node id. */
async function placeChart(page: Page, query: string, x: number, y: number): Promise<number> {
  const ids = () => charts(page).evaluateAll(gs => gs.map(g => Number(g.getAttribute('data-id'))));
  const before = await ids();
  await page.keyboard.press('l');
  const search = page.getByRole('searchbox', { name: 'Search the library' });
  await search.fill(query);
  await search.press('Enter');
  await page.locator('#board').click({ position: { x, y } });
  await expect(charts(page)).toHaveCount(before.length + 1);
  await expect(page.locator('#save-status')).toHaveText('Saved');
  return (await ids()).find(id => !before.includes(id))!;
}

/** Type into a grid cell of the selected chart's inspector; Enter saves. */
async function editCell(page: Page, cell: string, value: string) {
  const input = page.locator(`#inspector [data-act="chart-cell-${cell}"]`);
  await input.fill(value);
  await input.press('Enter');
}

/** Every chart card on the page: its drawn plot size, tag and footnote. */
const drawn = (page: Page) => charts(page).evaluateAll(gs => gs.map(g => ({
  plot: g.querySelector('g.chart-plot')!.childElementCount,
  empty: g.querySelectorAll('.chart-empty').length,
  tag: g.querySelector('text.chart-tag')!.textContent,
  source: g.querySelector('text.chart-source')!.textContent ?? '',
})));

test('a chart tile places a sample card that the inspector calls sample data', async ({ guest, stack }) => {
  const page = await guest();
  await openBoard(page, stack.url);
  // The card's top-left lands on the clicked world point, snapped to the 4 px grid
  // (no transform yet: the viewport has never moved from the identity).
  const view = (await page.locator('#world').getAttribute('transform')) ?? 'translate(0 0) scale(1)';
  const [tx, ty, scale] = view.match(/-?[\d.]+/g)!.map(Number);
  const snap = (v: number) => Math.round(v / 4) * 4;
  const stat = await placeChart(page, 'stat', 500, 420);
  await expect(card(page, stat).locator('text.chart-title')).toHaveText('Stat');
  await expect(card(page, stat).locator('text.chart-tag')).toHaveText('stat');
  await expect(card(page, stat).locator('text.chart-source.chart-sample')).toHaveText('sample data');
  const [plotted] = await drawn(page);
  expect(plotted).toMatchObject({ empty: 0, tag: 'stat', source: 'sample data' });
  expect(plotted.plot).toBeGreaterThan(0);
  await expect(page.locator('#inspector .insp-provtext')).toHaveText('sample data · edit it to use your own');
  expect(await chartRow(stack, stat)).toEqual({ node_id: stat, type: 'stat', csv: CHART_CONTRACTS.stat.example, options: '{}', source: 'sample' });
  expect(await nodeBox(stack, stat)).toEqual({ x: snap((500 - tx) / scale), y: snap((420 - ty) / scale), w: 352, h: 224 });

  // Kanban needs more room than the default card.
  await page.keyboard.press('Escape');
  const kanban = await placeChart(page, 'kanban', 1000, 160);
  await expect(card(page, kanban).locator('text.chart-tag')).toHaveText('kanban');
  await expect(card(page, kanban).locator('text.chart-sample')).toHaveText('sample data');
  expect(await chartRow(stack, kanban)).toMatchObject({ type: 'kanban', options: '{}', source: 'sample' });
  expect(await nodeBox(stack, kanban)).toMatchObject({ w: 448, h: 260 });
});

test('all eleven chart types render for the owner, after reload and for a view reader', async ({ account, guest, stack }) => {
  test.setTimeout(90_000);
  const token = stack.accountToken();
  const owner = await account(token, WIDE);
  await openBoard(owner, `${stack.url}?new=1`);
  await drawNode(owner, 'seed');
  const B = await boardIdOf(stack, owner);
  for (const [i, type] of CHART_TYPES.entries()) {
    const c = CHART_CONTRACTS[type];
    await stack.callReducer(token, 'create_chart', [B, c.title, '', 64 + (i % 4) * 480, 400 + Math.floor(i / 4) * 320, 448, 260, type, c.example, NONE, { some: 'e2e: contract example' }]);
  }
  const allDrawn = async (page: Page) => {
    await expect(charts(page)).toHaveCount(CHART_TYPES.length);
    // Polled: a card can arrive a frame before its chart row (then it shows 'no data').
    await expect.poll(async () => {
      const seen = await drawn(page);
      return {
        plotted: seen.every(s => s.plot > 0 && s.empty === 0),
        tags: seen.map(s => s.tag).sort(),
        credited: seen.every(s => s.source.startsWith('source: e2e')),
      };
    }).toEqual({ plotted: true, tags: [...CHART_TYPES].sort(), credited: true });
  };
  await allDrawn(owner);
  await owner.reload();
  await allDrawn(owner);

  const link = await shareBoard(owner, 'view');
  const viewer = await guest();
  await openBoard(viewer, link);
  await expect(viewer.locator('#world')).toContainText('seed');
  await allDrawn(viewer);
});

test('a chart and its data changes reach an open collaborator live', async ({ account, guest, stack }) => {
  test.setTimeout(90_000);
  const token = stack.accountToken();
  const owner = await account(token, WIDE);
  await openBoard(owner, `${stack.url}?new=1`);
  await drawNode(owner, 'api');
  const link = await shareBoard(owner, 'view');
  await owner.locator('#act-share').click(); // closes the share menu
  const viewer = await guest();
  await openBoard(viewer, link);
  await expect(viewer.locator('#world')).toContainText('api');
  await expect(charts(viewer)).toHaveCount(0);

  const id = await placeChart(owner, 'table', 520, 480);
  await expect(charts(viewer)).toHaveCount(1);
  await expect(card(viewer, id).locator('text.chart-sample')).toHaveText('sample data');

  await stack.callReducer(token, 'set_chart_data', [id, NONE, { some: 'host,cpu\napi-9,12\n' }, NONE, NONE]);
  await expect(card(viewer, id)).toContainText('api-9');
  await expect(card(viewer, id).locator('text.chart-source')).toHaveText('source: human:Test account');
  for (const page of [viewer, owner]) {
    await page.reload();
    await expect(card(page, id)).toContainText('api-9');
  }
});

test("readers can inspect a chart's data but change nothing", async ({ guest, stack }) => {
  test.setTimeout(90_000);
  const owner = await guest();
  await openBoard(owner, `${stack.url}?new=1`);
  const id = await placeChart(owner, 'table', 520, 420);
  const B = await boardIdOf(stack, owner);
  await owner.keyboard.press('Escape');
  const before = await chartRow(stack, id);
  expect(before).toMatchObject({ type: 'table', source: 'sample' });

  // A view link, then an edit link opened by a guest (read-only there until they sign in).
  for (const mode of ['view', 'edit'] as const) {
    const link = await shareBoard(owner, mode);
    await owner.locator('#act-share').click();
    // The link really is in this mode before the reader opens it.
    await expect.poll(() => stack.sql(`SELECT mode FROM link_share WHERE board_id = ${B}`)).toEqual([{ mode }]);
    const reader = await guest();
    await openBoard(reader, link);
    await select(reader, id);
    const inspector = reader.locator('#inspector');
    await expect(inspector.locator('.insp-provtext')).toHaveText('sample data · edit it to use your own');
    await expect(inspector.locator('fieldset.chart-view-only')).toHaveAttribute('disabled');
    for (const act of ['chart-csv', 'chart-type', 'chart-cell-1-0']) await expect(inspector.locator(`[data-act="${act}"]`)).toBeDisabled();
    await expect(inspector).not.toContainText('hide node');
    await expect(reader.locator('#tb-kind')).toBeDisabled();
    // Delete stays on for the owner of a chart (below); only a reader loses it.
    await expect(reader.locator('#tb-delete')).toBeDisabled();
    const token = await guestToken(reader);
    await expect(stack.callReducer(token, 'set_chart_data', [id, NONE, { some: 'host,cpu\nx,1\n' }, NONE, { some: 'reader' }])).rejects.toThrow(READ_ONLY);
    await expect(stack.callReducer(token, 'delete_node', [id])).rejects.toThrow(READ_ONLY);
    expect(await chartRow(stack, id)).toEqual(before);
    await expect(card(owner, id)).toBeVisible();
  }
});

test("an editor's data edit credits the editor and reaches the owner live", async ({ guest, account, stack }) => {
  test.setTimeout(90_000);
  // The owner is a guest: every e2e account is named 'Test account', so only a guest's name differs.
  const owner = await guest();
  await openBoard(owner, `${stack.url}?new=1`);
  const id = await placeChart(owner, 'table', 520, 420);
  await editCell(owner, '1-0', 'api-owner');
  await expect.poll(async () => (await chartRow(stack, id))?.source).toMatch(/^human:human-[0-9a-f]{6}$/);
  expect((await chartRow(stack, id))!.csv).toContain('api-owner');
  await owner.keyboard.press('Escape');

  const link = await shareBoard(owner, 'edit');
  await owner.locator('#act-share').click();
  const editor = await account();
  await openBoard(editor, link);
  await select(editor, id);
  await editCell(editor, '1-0', 'api-editor');
  await expect.poll(async () => (await chartRow(stack, id))?.source).toBe('human:Test account');
  expect((await chartRow(stack, id))!.csv).toContain('api-editor');

  // The owner's canvas was never reloaded.
  await expect(card(owner, id)).toContainText('api-editor');
  await expect(card(owner, id).locator('text.chart-source')).toHaveText('source: human:Test account');
});

test("an agent's chart must name its source, shows it, and a person's edit takes over", async ({ account, stack }) => {
  test.setTimeout(90_000);
  const token = stack.accountToken();
  const owner = await account(token, WIDE);
  await openBoard(owner, `${stack.url}?new=1`);
  await drawNode(owner, 'api');
  const B = await boardIdOf(stack, owner);
  const agent = await linkedAgent(stack, token, B);
  const chart = (source: unknown) => [B, 'p99', 'checkout', 480, 400, 352, 224, 'bars', 'run,p99\nbefore,120\nafter,80\n', NONE, source];
  await expect(stack.callReducer(agent.token, 'create_chart', chart(NONE))).rejects.toThrow(/agents must say where chart data came from/);
  expect(await chartRows(stack, B)).toEqual([]);

  await stack.callReducer(agent.token, 'create_chart', chart({ some: 'agent: npm run bench @ abc1234' }));
  await expect(charts(owner)).toHaveCount(1);
  const [{ node_id }] = await chartRows(stack, B);
  const id = Number(node_id);
  await expect(card(owner, id).locator('text.chart-source')).toHaveText('source: agent: npm run bench @ abc1234');
  await select(owner, id);
  await expect(owner.locator('#inspector .insp-provtext')).toHaveText('source: agent: npm run bench @ abc1234');
  await expect(owner.locator('#inspector .insp-glyph.agent')).toBeVisible();

  await editCell(owner, '1-1', '90');
  await expect.poll(async () => (await chartRow(stack, id))?.source).toBe('human:Test account');
  expect((await chartRow(stack, id))!.csv).toContain('before,90');
  await expect(card(owner, id).locator('text.chart-source')).toHaveText('source: human:Test account');
});

test("duplicate and delete-undo keep a chart's data and source; its size and kind stay locked", async ({ guest, stack }) => {
  test.setTimeout(90_000);
  const page = await guest();
  await openBoard(page, `${stack.url}?new=1`);
  const id = await placeChart(page, 'pie', 500, 300);
  const B = await boardIdOf(stack, page);
  const source = page.locator('#inspector [data-act="chart-source"]');
  await source.fill('billing export');
  await source.press('Enter');
  await expect.poll(async () => (await chartRow(stack, id))?.source).toBe('billing export');
  const pie = { type: 'pie', csv: CHART_CONTRACTS.pie.example, options: '{}', source: 'billing export' };
  await page.keyboard.press('Escape');

  // CH-18: a chart is always a rectangle of its own kind.
  await select(page, id);
  await expect(page.locator('#tb-delete')).toBeEnabled();
  await expect(page.locator('#tb-kind')).toBeDisabled();
  await expect(page.locator('#tb-shape button')).toHaveCount(3);
  for (const shape of await page.locator('#tb-shape button').all()) await expect(shape).toBeDisabled();

  await page.keyboard.press('ControlOrMeta+d');
  await expect(charts(page)).toHaveCount(2);
  await expect.poll(async () => (await chartRows(stack, B)).length).toBe(2);
  const rows = await chartRows(stack, B);
  for (const row of rows) expect(row).toMatchObject(pie);
  const copy = Number(rows.find(row => Number(row.node_id) !== id)!.node_id);
  const [a, b] = [await nodeBox(stack, id), await nodeBox(stack, copy)];
  expect(b).toEqual({ x: a.x + 16, y: a.y + 16, w: a.w, h: a.h });
  await page.keyboard.press('ControlOrMeta+z');
  await expect(charts(page)).toHaveCount(1);
  await expect.poll(async () => (await chartRows(stack, B)).map(row => Number(row.node_id))).toEqual([id]);

  await select(page, id, 'tag');
  await page.locator('#tb-delete').click();
  await expect(charts(page)).toHaveCount(0);
  await expect.poll(async () => (await chartRows(stack, B)).length).toBe(0);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(charts(page)).toHaveCount(1);
  await expect.poll(async () => (await chartRows(stack, B)).length).toBe(1);
  const [back] = await chartRows(stack, B);
  expect(back).toMatchObject(pie);
  const restored = Number(back.node_id);
  await expect(card(page, restored).locator('text.chart-source')).toHaveText('source: billing export');
  const [pieDrawn] = await drawn(page);
  expect(pieDrawn).toMatchObject({ empty: 0, tag: 'pie' });
  expect(pieDrawn.plot).toBeGreaterThan(0);

  // CH-18: the resize drag stops at 224x144, and the reducer refuses anything smaller.
  await select(page, restored);
  const handle = page.locator(`#world .resize-handle[data-node-id="${restored}"][data-corner="se"]`);
  const box = await settledBox(handle);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x - 400, box.y - 400, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await nodeBox(stack, restored))).toMatchObject({ w: 224, h: 144 });
  const { x, y } = await nodeBox(stack, restored);
  await expect(stack.callReducer(await guestToken(page), 'resize_node', [restored, x, y, 160, 96]))
    .rejects.toThrow('chart size rule: charts must be at least 224x144; got 160x96');
  expect(await nodeBox(stack, restored)).toMatchObject({ w: 224, h: 144 });
});

test('Export SVG carries chart cards without their hover parts', async ({ guest, stack }) => {
  const page = await guest();
  await openBoard(page, `${stack.url}?new=1`);
  await placeChart(page, 'time series', 400, 300);
  await page.keyboard.press('Escape');
  await placeChart(page, 'stat', 900, 300);
  await page.keyboard.press('Escape');
  await page.locator('#world rect.chart-hit').nth(3).hover();
  await expect(page.locator('#world g.chart-xhair')).toHaveCount(1);

  // A pointer that travels to the button (or any key) drops the crosshair first; a click
  // event alone keeps it on the board, so the export has to strip it itself.
  const download = page.waitForEvent('download');
  await page.locator('#act-export').dispatchEvent('click');
  const stream = await (await download).createReadStream();
  let svg = '';
  for await (const chunk of stream!) svg += chunk;
  await expect(page.locator('#world g.chart-xhair')).toHaveCount(1); // it was on the board being exported
  // Each exported card keeps its title, a drawn plot and its 'sample data' pill.
  const exported = await page.evaluate(markup => [...new DOMParser().parseFromString(markup, 'image/svg+xml').querySelectorAll('g.node-chart')].map(g => ({
    title: g.querySelector('text.chart-title')?.textContent,
    plot: g.querySelector('g.chart-plot')?.childElementCount ?? 0,
    empty: g.querySelectorAll('.chart-empty').length,
    source: g.querySelector('text.chart-source')?.textContent,
  })), svg);
  expect(exported.map(c => c.title).sort()).toEqual(['Stat', 'Time series']);
  for (const c of exported) {
    expect(c).toMatchObject({ empty: 0, source: 'sample data' });
    expect(c.plot).toBeGreaterThan(0);
  }
  expect(svg).not.toContain('chart-hit');
  expect(svg).not.toContain('chart-xhair');
});
