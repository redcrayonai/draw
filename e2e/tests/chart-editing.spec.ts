import { test, expect, openBoard, boardIdOf, type Stack } from '../fixtures';
import type { Page } from '@playwright/test';
import { CHART_CONTRACTS } from '../../module/src/chart-contracts';

// The chart inspector (chart spec 'Inspector'): invalid drafts, when edits save, the
// sample source and undo, type switches, options, the source field, grid editing and
// remote saves that arrive while a draft is open.

const NONE = { none: [] };
type ChartRow = { type: string; csv: string; options: string; source: string };

const insp = (page: Page) => page.locator('#inspector');
const act = (page: Page, name: string) => page.locator(`#inspector [data-act="${name}"]`);
const card = (page: Page, id: number) => page.locator(`#world g.node-chart[data-id="${id}"]`);

async function chartRow(stack: Stack, id: number): Promise<ChartRow> {
  const [row] = await stack.sql(`SELECT * FROM chart WHERE node_id = ${id}`);
  return row as ChartRow;
}

/** Leaves the field without a click elsewhere: the blur saves, focus goes to <body>. */
const blur = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

/** Places a chart tile from the library (the new chart is selected) and returns its node id. */
async function placeChart(page: Page, title: string, x: number, y: number): Promise<number> {
  const charts = page.locator('#world g.node-chart');
  const count = await charts.count();
  await blur(page);
  await page.keyboard.press('l');
  const search = page.getByRole('searchbox', { name: 'Search the library' });
  await search.fill(title);
  await search.press('Enter');
  await page.locator('#board').click({ position: { x, y } });
  await expect(charts).toHaveCount(count + 1);
  await expect(insp(page).locator('.insp-title')).toHaveText(title);
  const ids = await charts.evaluateAll(gs => gs.map(g => Number(g.getAttribute('data-id'))));
  return Math.max(...ids);
}

async function guestChart(guest: () => Promise<Page>, stack: Stack, title: string) {
  const page = await guest();
  await openBoard(page, stack.url);
  const id = await placeChart(page, title, 300, 160);
  return { page, id };
}

/** A paste into the CSV box: the text is filled in, then the paste event saves it. */
async function pasteCsv(page: Page, csv: string) {
  const box = act(page, 'chart-csv');
  if (!(await box.isVisible())) await insp(page).locator('details.chart-paste summary').click();
  await box.fill(csv);
  await box.dispatchEvent('paste');
}

test('an invalid draft shows the parser\'s sentence and keeps the last good chart', async ({ guest, stack }) => {
  const { page, id } = await guestChart(guest, stack, 'Top list');
  const example = CHART_CONTRACTS.toplist.example;
  await expect(card(page, id)).toContainText('/search');
  await insp(page).locator('details.chart-paste summary').click();
  const box = act(page, 'chart-csv');
  const error = insp(page).locator('[data-role="draft-error"]');
  const sentence = "row 2, column 'p99_ms': '12ms' is not a number; put the unit in the unit option";
  await box.fill('endpoint,p99_ms\n/checkout,12ms\n');
  await expect(error).toHaveText(sentence);

  // Leaving the field saves nothing: the draft and its sentence stay, the drawn chart stays the example.
  await box.press('Tab');
  await expect(error).toHaveText(sentence);
  await expect(box).toHaveValue('endpoint,p99_ms\n/checkout,12ms\n');
  await expect(card(page, id)).toContainText('/search');

  await box.fill('endpoint,p99_ms\n/checkout,12\n');
  await box.press('Tab');
  await expect(error).toBeHidden();
  await expect.poll(async () => (await chartRow(stack, id)).csv).toContain('/checkout,12');
  await expect(card(page, id)).toContainText('/checkout');
  await expect(card(page, id)).not.toContainText('/search');
});

test('the grid saves on Enter, blur or paste, not on each keystroke, and each save is one undo step', async ({ guest, stack }) => {
  const { page, id } = await guestChart(guest, stack, 'Table');
  const example = CHART_CONTRACTS.table.example;
  const cell = act(page, 'chart-cell-1-1');
  await cell.selectText();
  await cell.pressSequentially('55');
  await expect(cell).toHaveValue('55');
  // Past the 150 ms check several times over, the typed cell is still unsaved.
  const start = Date.now();
  await expect.poll(async () => {
    if ((await chartRow(stack, id)).csv !== example) return 'saved';
    return Date.now() - start > 600 ? 'held' : 'waiting';
  }).toBe('held');

  await cell.press('Enter');
  await expect.poll(async () => (await chartRow(stack, id)).csv).toContain('api-1,55,1.2,41');
  await expect(act(page, 'chart-cell-2-1')).toBeFocused();
  const enterSaved = (await chartRow(stack, id)).csv;

  // A paste saves at once, with focus still in the box.
  await pasteCsv(page, 'host,cpu\nx,1\n');
  await expect.poll(async () => (await chartRow(stack, id)).csv).toBe('host,cpu\nx,1\n');
  await expect(act(page, 'chart-csv')).toBeFocused();

  await blur(page);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await chartRow(stack, id)).csv).toBe(enterSaved);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await chartRow(stack, id)).csv).toBe(example);
});

test('the first data edit replaces sample with the person\'s name, and undo restores sample', async ({ guest, stack }) => {
  const { page, id } = await guestChart(guest, stack, 'Stat');
  const note = 'sample data: your first data edit replaces this source with your name';
  const foot = card(page, id).locator('text.chart-source');
  await expect(insp(page)).toContainText(note);
  await expect(foot).toHaveText('sample data');

  await pasteCsv(page, 'value\n42\n');
  await expect.poll(async () => (await chartRow(stack, id)).source).toMatch(/^human:human-[0-9a-f]{6}$/);
  await expect(foot).toHaveText(/^source: human:human-[0-9a-f]{6}$/);
  await expect(card(page, id).locator('.chart-sample')).toHaveCount(0);
  await expect(insp(page).locator('.insp-provtext')).toHaveText(/^source: human:human-[0-9a-f]{6}$/);
  await expect(insp(page)).not.toContainText(note);

  await blur(page);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => chartRow(stack, id)).toMatchObject({ csv: CHART_CONTRACTS.stat.example, source: 'sample' });
  await expect(card(page, id).locator('text.chart-source.chart-sample')).toHaveText('sample data');
  await expect(insp(page)).toContainText(note);

  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(async () => (await chartRow(stack, id)).csv).toBe('value\n42\n');
  await expect(foot).toHaveText(/^source: human:human-/);
});

test('a type switch is checked against the new contract', async ({ guest, stack }) => {
  const { page, id } = await guestChart(guest, stack, 'Table');
  const select = act(page, 'chart-type');
  const typeError = insp(page).locator('[data-role="type-error"]');
  const tag = card(page, id).locator('text.chart-tag');
  await expect(tag).toHaveText('table');

  await select.selectOption('pie');
  await expect(typeError).toHaveText('pie needs exactly 2 columns (label, value); got 4 columns');
  await expect(select).toHaveValue('table');
  expect((await chartRow(stack, id)).type).toBe('table');

  await select.selectOption('bars');
  await expect(typeError).toBeHidden();
  await expect.poll(async () => (await chartRow(stack, id)).type).toBe('bars');
  await expect(tag).toHaveText('bars');

  await blur(page);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await chartRow(stack, id)).type).toBe('table');
  await expect(tag).toHaveText('table');
  await expect(select).toHaveValue('table');
});

test('option controls save at once and keep the stored source', async ({ guest, stack }) => {
  const { page, id } = await guestChart(guest, stack, 'Time series');
  const area = act(page, 'chart-opt-style-area');
  // Built from the contract: the enum is a button group, the unit a text field.
  await expect(insp(page).getByRole('group', { name: 'style' }).getByRole('button')).toHaveText(['line', 'area', 'stacked']);
  await expect(insp(page).getByRole('textbox', { name: 'unit' })).toBeEditable();
  await expect(area).toHaveAttribute('aria-pressed', 'false');
  await area.click();
  await expect(area).toHaveAttribute('aria-pressed', 'true');
  await expect(act(page, 'chart-opt-style-line')).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => chartRow(stack, id)).toMatchObject({ options: '{"style":"area"}', source: 'sample' });
  await expect(card(page, id).locator('text.chart-source.chart-sample')).toHaveText('sample data');

  const pie = await placeChart(page, 'Pie', 300, 460);
  const donut = act(page, 'chart-opt-donut');
  await expect(donut).toHaveText('on');
  await donut.click();
  await expect(donut).toHaveText('off');
  await expect(donut).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => chartRow(stack, pie)).toMatchObject({ options: '{"donut":false}', source: 'sample' });
  await expect(card(page, pie).locator('text.chart-source.chart-sample')).toHaveText('sample data');
});

test('the source field stores text, picks its glyph, and refuses more than 200 characters', async ({ guest, stack }) => {
  const { page, id } = await guestChart(guest, stack, 'Bars');
  const source = act(page, 'chart-source');
  const foot = card(page, id).locator('text.chart-source');
  const glyph = insp(page).locator('.insp-glyph');

  await source.fill('grafana export 2026-10-22');
  await source.press('Enter');
  await expect.poll(async () => (await chartRow(stack, id)).source).toBe('grafana export 2026-10-22');
  await expect(foot).toHaveText('source: grafana export 2026-10-22');
  await expect(insp(page).locator('.insp-provtext')).toHaveText('source: grafana export 2026-10-22');
  await expect(glyph).toHaveClass(/\bsample\b/);

  await source.fill('x'.repeat(201));
  await expect(insp(page).locator('[data-role="draft-error"]')).toHaveText('source is 201 characters; the limit is 200');
  await source.press('Enter');
  await expect(insp(page).locator('[data-role="draft-error"]')).toBeVisible();
  await expect(foot).toHaveText('source: grafana export 2026-10-22');

  await source.fill('agent: bench @ abc');
  await source.press('Enter');
  await expect.poll(async () => (await chartRow(stack, id)).source).toBe('agent: bench @ abc');
  await expect(glyph).toHaveClass(/\bagent\b/);

  await source.fill('human:alice');
  await source.press('Enter');
  await expect.poll(async () => (await chartRow(stack, id)).source).toBe('human:alice');
  await expect(glyph).toHaveClass(/\bhuman\b/);

  // Too long for the card: the footnote is cut and its <title> holds the whole text.
  const long = 'abcdefghij'.repeat(12);
  await source.fill(long);
  await source.press('Enter');
  await expect.poll(async () => (await chartRow(stack, id)).source).toBe(long);
  await expect(foot.locator('title')).toHaveText(`source: ${long}`);
  // The drawn text (the foot's own text nodes, not its <title>) ends in an ellipsis.
  const drawn = () => foot.evaluate(t => [...t.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join(''));
  await expect.poll(drawn).toMatch(/^source: .*…$/);
  expect((await drawn()).length).toBeLessThan(`source: ${long}`.length);
  // Back to plain text after 'human:': the glyph is neutral again.
  await expect(glyph).toHaveClass(/\bsample\b/);
});

test('the data grid adds and deletes rows and series by mouse and keyboard', async ({ guest, stack }) => {
  const { page, id } = await guestChart(guest, stack, 'Table');
  await act(page, 'chart-add-row').click();
  await expect(act(page, 'chart-cell-5-0')).toBeFocused();
  for (const [i, text] of ['api-3', '50', '1.1', '9'].entries()) {
    if (i > 0) await page.keyboard.press('Tab');
    await expect(act(page, `chart-cell-5-${i}`)).toBeFocused();
    await page.keyboard.type(text);
  }
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await chartRow(stack, id)).csv).toContain('\napi-3,50,1.1,9');

  await act(page, 'chart-add-series').click();
  await expect(act(page, 'chart-cell-0-4')).toBeFocused();
  await expect(act(page, 'chart-cell-0-4')).toHaveValue('series 4');

  // Alt+Backspace deletes the row and keeps focus in the grid, on the row that moved up.
  expect((await chartRow(stack, id)).csv).toContain('\napi-2,');
  await act(page, 'chart-cell-2-0').click();
  await page.keyboard.press('Alt+Backspace');
  await expect.poll(async () => (await chartRow(stack, id)).csv).not.toContain('api-2');
  expect((await chartRow(stack, id)).csv).toContain('api-1');
  await expect(act(page, 'chart-cell-2-0')).toBeFocused();
  await expect(act(page, 'chart-cell-2-0')).toHaveValue('worker-1');

  // The × is out of the Tab order and deletes by mouse.
  const del = act(page, 'chart-del-1');
  await expect(del).toHaveAttribute('tabindex', '-1');
  await expect(del).toHaveAttribute('aria-label', 'delete row 1');
  await del.click();
  await expect.poll(async () => (await chartRow(stack, id)).csv).not.toContain('api-1');
  expect((await chartRow(stack, id)).csv).toContain('worker-1');
});

test('a chart over 50 rows shows a read-only grid and edits as text', async ({ account, stack }) => {
  const token = stack.accountToken();
  const page = await account(token);
  await openBoard(page, `${stack.url}?new=1`);
  const B = await boardIdOf(stack, page);
  // A top list takes up to 500 rows (a table stops at 50).
  const csv = ['endpoint,p99_ms', ...Array.from({ length: 60 }, (_, i) => `/route-${i + 1},${100 + i}`)].join('\n');
  await stack.callReducer(token, 'create_chart', [B, 'big', '', 480, 400, 352, 224, 'toplist', csv, NONE, { some: 'seed' }]);
  await page.locator('#world g.node-chart .chart-title').click();
  await expect(insp(page).locator('.insp-title')).toHaveText('big');

  const region = page.getByRole('region', { name: 'chart data, read-only' });
  await expect(region).toBeVisible();
  // The header and the first 50 rows.
  await expect(region.locator('tr')).toHaveCount(51);
  await expect(region.locator('tr').last()).toContainText('/route-50');
  await expect(region.locator('input')).toHaveCount(0);
  await expect(insp(page).locator('.chart-data-grid-note')).toContainText('+10 more rows');
  await act(page, 'chart-edit-text').click();
  await expect(act(page, 'chart-csv')).toBeFocused();
  await expect(act(page, 'chart-csv')).toHaveValue(csv);
});

test('a remote save never overwrites an open draft, and refreshes the grid when idle', async ({ account, stack }) => {
  const token = stack.accountToken();
  const page = await account(token);
  await openBoard(page, `${stack.url}?new=1`);
  const B = await boardIdOf(stack, page);
  await stack.callReducer(token, 'create_chart', [B, 'hosts', '', 480, 400, 352, 224, 'table', 'host,cpu\napi-1,10\n', NONE, { some: 'seed' }]);
  const [{ node_id }] = await stack.sql(`SELECT node_id FROM chart WHERE board_id = ${B}`);
  const id = Number(node_id);
  await card(page, id).locator('.chart-title').click();
  const cell = act(page, 'chart-cell-1-0');
  await expect(cell).toHaveValue('api-1');

  await cell.fill('local-draft');
  const remote = (csv: string) => stack.callReducer(token, 'set_chart_data', [id, NONE, { some: csv }, NONE, NONE]);
  await remote('host,cpu\nremote-1,10\n');
  // The canvas redraws; the typed field keeps its text and focus.
  await expect(card(page, id)).toContainText('remote-1');
  await expect(cell).toHaveValue('local-draft');
  await expect(cell).toBeFocused();

  // Saving the field: the local draft is the last write.
  await cell.press('Enter');
  await expect.poll(async () => (await chartRow(stack, id)).csv).toContain('local-draft');
  expect((await chartRow(stack, id)).csv).not.toContain('remote-1');
  await expect(card(page, id)).toContainText('local-draft');
  await expect(card(page, id)).not.toContainText('remote-1');

  await blur(page);
  await remote('host,cpu\nremote-2,10\n');
  await expect(act(page, 'chart-cell-1-0')).toHaveValue('remote-2');
});
