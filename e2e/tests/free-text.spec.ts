import { test, expect, openBoard, drawNode, shareBoard, boardIdOf, settledBox, exportSvg as exportDownload, type Stack } from '../fixtures';
import type { Locator, Page } from '@playwright/test';

// Free text (PR #164) and notes (PR #99, #102): how they place, edit, wrap, style, size and persist.

const NOTE_DEFAULT = 'A note about this part of the system.';
const textNodes = (page: Page) => page.locator('#world g.node-text');
const textRows = (stack: Stack, B: number) => stack.sql(`SELECT label, w, h, size FROM node WHERE board_id = ${B} AND kind = 'text'`);

/** Double-click empty canvas, type, and save with ⌘Enter. */
async function writeText(page: Page, x: number, y: number, text: string) {
  await page.locator('#board').dblclick({ position: { x, y } });
  const edit = page.locator('#inline-edit');
  await expect(edit).toBeFocused();
  await page.keyboard.type(text);
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(edit).toHaveCount(0);
  await expect(page.locator('#save-status')).toHaveText('Saved');
}

/** Double-click the element's centre once two reads 250 ms apart agree: closing an editor glides the board (revealSelection). */
async function dblclickSettled(page: Page, locator: Locator) {
  const box = await settledBox(locator);
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
  return box;
}

async function exportSvg(page: Page) {
  let svg = '';
  for await (const chunk of (await (await exportDownload(page)).createReadStream())!) svg += chunk;
  return svg;
}

test('a double-click on empty canvas places free text, and T or 6 arms text for one placement', async ({ guest, stack }) => {
  const page = await guest();
  await openBoard(page, stack.url);
  const edit = page.locator('#inline-edit');

  await page.locator('#board').dblclick({ position: { x: 600, y: 300 } });
  await expect(edit).toBeFocused();
  await expect(edit).toHaveClass(/text/);
  await page.keyboard.type('Checkout flow');
  await page.keyboard.press('Escape'); // Esc saves text, it does not discard
  await expect(textNodes(page)).toHaveCount(1);
  await expect(textNodes(page)).toContainText('Checkout flow');
  await expect(page.locator('#world g.node-service')).toHaveCount(0);
  const B = await boardIdOf(stack, page);
  await expect.poll(() => stack.sql(`SELECT kind, label FROM node WHERE board_id = ${B}`)).toEqual([{ kind: 'text', label: 'Checkout flow' }]);

  // CV-10: the words alone, no outline and no NOTE eyebrow.
  await expect(textNodes(page).locator('.note-eyebrow')).toHaveCount(0);
  expect(await textNodes(page).locator(':scope > rect').first().evaluate(rect => getComputedStyle(rect).stroke)).toBe('none');

  // A double-click on a node still edits its label. (drawNode double-clicks the last g.node, here the text.)
  await page.keyboard.press('1');
  await page.locator('#board').click({ position: { x: 500, y: 120 } });
  await page.keyboard.press('Escape');
  const service = page.locator('#world g.node-service');
  await expect(service).toHaveCount(1);
  await dblclickSettled(page, service);
  await expect(edit).toBeFocused();
  await expect(edit).toHaveValue('Service');
  await edit.fill('api');
  await edit.press('Enter');
  await expect(service).toContainText('api');
  await expect(textNodes(page)).toHaveCount(1);

  // CV-05: T arms text for one placement.
  const row = page.locator('.add-row[data-kind="text"]');
  await page.keyboard.press('t');
  await expect(row).toHaveClass(/armed/);
  await expect(page.locator('#rail-hint')).toContainText('click canvas to place');
  await page.locator('#board').click({ position: { x: 450, y: 520 } });
  await expect(edit).toBeFocused();
  await expect(row).not.toHaveClass(/armed/);
  await page.keyboard.type('Second');
  await page.keyboard.press('Escape');
  await expect(textNodes(page)).toHaveCount(2);
  await page.locator('#board').click({ position: { x: 900, y: 560 } });
  await expect(page.locator('#world g.node')).toHaveCount(3);
  await expect(edit).toHaveCount(0);

  await page.keyboard.press('6');
  await expect(row).toHaveClass(/armed/);
  await page.keyboard.press('Escape');
  await expect(row).not.toHaveClass(/armed/);
  // The dock's Text tool and ⌘K "Place text" arm it too.
  await row.click();
  await expect(row).toHaveClass(/armed/);
  await page.keyboard.press('Escape');
  await expect(row).not.toHaveClass(/armed/);
  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.locator('#palette-input')).toBeFocused();
  await page.locator('#palette-input').fill('Place text');
  await page.keyboard.press('Enter');
  await expect(row).toHaveClass(/armed/);
  await page.locator('#board').click({ position: { x: 900, y: 560 } });
  await expect(edit).toBeFocused();
  await page.keyboard.type('Third');
  await page.keyboard.press('Escape');
  // Placement is async: this later write from the same connection proves the disarmed click above wrote no row.
  await expect.poll(async () => (await stack.sql(`SELECT kind, label FROM node WHERE board_id = ${B}`)).map(r => `${r.kind}:${r.label}`).sort())
    .toEqual(['service:api', 'text:Checkout flow', 'text:Second', 'text:Third']);
});

test('a text block left empty is deleted', async ({ account, stack }) => {
  const page = await account();
  await openBoard(page, `${stack.url}?new=1`);
  await drawNode(page, 'svc');
  const B = await boardIdOf(stack, page);

  await page.keyboard.press('t');
  await page.locator('#board').click({ position: { x: 700, y: 420 } });
  await expect(page.locator('#inline-edit')).toBeFocused();
  // The block exists while its editor is open.
  await expect(textNodes(page)).toHaveCount(1);
  await expect.poll(async () => (await textRows(stack, B)).length).toBe(1);
  await page.keyboard.press('Escape');

  await expect(page.locator('#world g.node')).toHaveCount(1);
  await expect.poll(() => textRows(stack, B)).toEqual([]);
  await page.reload();
  await expect(page.locator('#world')).toContainText('svc');
  await expect(page.locator('#world g.node')).toHaveCount(1);
});

test('Enter breaks lines in text, and ⌘Enter or Esc saves', async ({ guest, stack }) => {
  const page = await guest();
  await openBoard(page, stack.url);
  await page.locator('#board').dblclick({ position: { x: 600, y: 300 } });
  await expect(page.locator('#inline-edit')).toBeFocused();
  await page.keyboard.type('line one');
  await page.keyboard.press('Enter');
  await page.keyboard.type('line two');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page.locator('#inline-edit')).toHaveCount(0);
  const lines = page.locator('#world .text-body > tspan');
  await expect(lines).toHaveText(['line one', 'line two']);
  const B = await boardIdOf(stack, page);
  // ⌘Enter saved both lines, and the box grew from one 28 px line to two.
  await expect.poll(() => textRows(stack, B)).toMatchObject([{ label: 'line one\nline two', h: 56 }]);

  // The caret opens at the end, and Esc saves.
  await dblclickSettled(page, textNodes(page));
  await expect(page.locator('#inline-edit')).toBeFocused();
  await page.keyboard.type(' more');
  await page.keyboard.press('Escape');
  await expect(page.locator('#world')).toContainText('line two more');
  await expect(page.locator('#save-status')).toHaveText('Saved');

  await page.reload();
  await expect(lines).toHaveText(['line one', 'line two more']);
  await expect.poll(async () => (await textRows(stack, B)).map(row => row.label)).toEqual(['line one\nline two more']);
});

test('inline markdown styles text for everyone and survives reload and export', async ({ guest, stack }) => {
  test.setTimeout(90_000);
  const owner = await guest();
  await openBoard(owner, stack.url);
  await drawNode(owner, 'api');
  const link = await shareBoard(owner, 'view');
  await owner.keyboard.press('Escape');
  await expect(owner.locator('#share-pop')).toBeHidden();
  const viewer = await guest();
  await openBoard(viewer, link);
  await expect(viewer.locator('#world')).toContainText('api');

  const styles = [
    { word: 'Payments', key: 'b', css: '.md-b', stored: '**Payments**' },
    { word: 'Ledger', key: 'i', css: '.md-i', stored: '*Ledger*' },
    { word: 'Legacy', key: 'Shift+x', css: '[text-decoration="line-through"]', stored: '~~Legacy~~' },
    { word: 'retry', key: 'e', css: '.md-code', stored: '`retry`' },
  ];
  for (const [i, { word, key, css }] of styles.entries()) {
    await owner.locator('#board').dblclick({ position: { x: 700, y: 400 + i * 50 } });
    await expect(owner.locator('#inline-edit')).toBeFocused();
    await owner.keyboard.type(word);
    await owner.keyboard.press('ControlOrMeta+a');
    await owner.keyboard.press(`ControlOrMeta+${key}`);
    await owner.keyboard.press('ControlOrMeta+Enter');
    // The open viewer sees the styled run without a reload.
    for (const page of [owner, viewer]) await expect(page.locator(`#world .text-body tspan${css}`)).toHaveText(word);
  }
  const B = await boardIdOf(stack, owner);
  await expect.poll(async () => (await textRows(stack, B)).map(row => row.label).sort()).toEqual(styles.map(s => s.stored).sort());

  // ⌘B on a wrapped selection unwraps it, and again wraps it.
  await dblclickSettled(owner, textNodes(owner).filter({ hasText: 'Payments' }));
  const edit = owner.locator('#inline-edit');
  await expect(edit).toHaveValue('**Payments**');
  await owner.keyboard.press('ControlOrMeta+a');
  await owner.keyboard.press('ControlOrMeta+b');
  await expect(edit).toHaveValue('Payments');
  await owner.keyboard.press('ControlOrMeta+b');
  await expect(edit).toHaveValue('**Payments**');
  await owner.keyboard.press('Escape');
  await expect(edit).toHaveCount(0);

  // CV-73: an external node too, for its drawn glyph.
  await owner.keyboard.press('3');
  await owner.locator('#board').click({ position: { x: 950, y: 420 } });
  await owner.keyboard.press('Escape');
  await expect(owner.locator('#world g.node-external')).toHaveCount(1);
  // And a boundary, for its faint fill.
  await owner.keyboard.press('4');
  await owner.locator('#board').click({ position: { x: 80, y: 420 } });
  await owner.keyboard.press('Escape');
  await expect(owner.locator('#world g.node-boundary')).toHaveCount(1);
  await expect(owner.locator('#save-status')).toHaveText('Saved');

  await owner.reload();
  for (const { word, css } of styles) await expect(owner.locator(`#world .text-body tspan${css}`)).toHaveText(word);

  // Focal after the reload, so the plain fill is read settled; the export itself turns transitions off.
  const api = owner.locator('#world g.node-service');
  const plainFill = await api.locator(':scope > rect.node-rect').evaluate(rect => getComputedStyle(rect).fill);
  await api.click();
  await owner.keyboard.press('f');
  await expect(api).toHaveClass(/\bfocal\b/);

  const svg = await exportSvg(owner);
  expect(svg).toMatch(/<tspan class="md-b"[^>]*font-weight:700/);
  expect(svg).toContain('text-decoration="line-through"');
  expect(svg).toMatch(/<tspan class="md-i"[^>]*font-style:italic/);
  expect(svg).toMatch(/<tspan class="md-code"[^>]*font-family:[^>]*monospace/);
  expect(svg).toContain('class="node-glyph"');
  const fills = await owner.evaluate(markup => {
    const doc = new DOMParser().parseFromString(markup, 'image/svg+xml');
    const style = (sel: string) => doc.querySelector(sel)?.getAttribute('style') ?? '';
    return { focal: style('g.node.focal > rect.node-rect'), boundary: style('g.node-boundary > rect.node-rect') };
  }, svg);
  expect(fills.boundary).toContain('fill-opacity:0.03');
  const focalFill = /(?:^|;)fill:([^;]+)/.exec(fills.focal)?.[1];
  expect(focalFill).toBeTruthy();
  expect(focalFill).not.toBe('none');
  expect(focalFill).not.toBe(plainFill);
});

test('text size refits the box in one undo step', async ({ account, stack }) => {
  const page = await account();
  await openBoard(page, `${stack.url}?new=1`);
  await writeText(page, 600, 300, 'Heading');
  const B = await boardIdOf(stack, page);
  await expect.poll(async () => (await textRows(stack, B)).map(row => row.label)).toEqual(['Heading']);
  const [before] = await textRows(stack, B);
  const body = page.locator('#world .text-body');
  await expect(body).toHaveAttribute('font-size', '20');

  await textNodes(page).click();
  await page.locator('#tb-size [data-size="l"]').click();
  await expect(body).toHaveAttribute('font-size', '28');
  await expect.poll(async () => {
    const [row] = await textRows(stack, B);
    return row.size === 'l' && Number(row.w) > Number(before.w) && Number(row.h) > Number(before.h);
  }).toBe(true);

  // One ⌘Z takes back both the size and the box.
  await page.keyboard.press('ControlOrMeta+z');
  await expect(body).toHaveAttribute('font-size', '20');
  await expect.poll(() => textRows(stack, B)).toEqual([before]);

  // S is 14 px and shrinks the box.
  await page.locator('#tb-size [data-size="s"]').click();
  await expect(body).toHaveAttribute('font-size', '14');
  await expect.poll(async () => {
    const [row] = await textRows(stack, B);
    return row.size === 's' && Number(row.w) < Number(before.w) && Number(row.h) < Number(before.h);
  }).toBe(true);
});

test('a small text block cannot become a node', async ({ guest, stack }) => {
  const page = await guest();
  await openBoard(page, stack.url);
  await writeText(page, 600, 300, 'Hi');
  await textNodes(page).click();
  await page.locator('#tb-style-menu summary').click();
  const kind = page.locator('#tb-kind');
  await expect(kind).toHaveText('text');
  await kind.click();
  await expect(page.locator('#error-text')).toContainText(/size rule: nodes must be at least 64x48; got \d+x\d+/);
  await expect(textNodes(page)).toHaveCount(1);
  await expect(kind).toHaveText('text');
  const B = await boardIdOf(stack, page);
  expect(await stack.sql(`SELECT kind FROM node WHERE board_id = ${B}`)).toEqual([{ kind: 'text' }]);
});

test('a note places once and opens for typing, and its editor wraps', async ({ guest, stack }) => {
  test.setTimeout(90_000);
  const page = await guest();
  await openBoard(page, stack.url);
  const edit = page.locator('#inline-edit');
  const selectedAll = () => edit.evaluate((el: HTMLTextAreaElement) => el.selectionStart === 0 && el.selectionEnd === el.value.length);

  await page.keyboard.press('5');
  await page.locator('#board').click({ position: { x: 500, y: 300 } });
  await expect(edit).toBeFocused();
  await expect(edit).toHaveClass(/note/);
  await expect(edit).toHaveValue(NOTE_DEFAULT);
  expect(await selectedAll()).toBe(true);
  await expect(page.locator('.add-row[data-kind="note"]')).not.toHaveClass(/armed/);
  await page.keyboard.type('Retries go to the DLQ');
  await page.keyboard.press('Enter');
  await expect(page.locator('#world .note-body')).toContainText('Retries go to the DLQ');
  await expect(page.locator('#save-status')).toHaveText('Saved');
  // A note draws its NOTE eyebrow (the selector test 1 expects text to lack).
  await expect(page.locator('#world g.node-note .note-eyebrow')).toHaveText('NOTE');
  // The note disarmed: the next click places nothing (the exact SQL labels below prove no row was written).
  await page.locator('#board').click({ position: { x: 900, y: 520 } });
  await expect(page.locator('#world g.node')).toHaveCount(1);

  // CV-03: a Note tile dragged from the library (which covers the middle) places one note, editor open, text selected.
  await page.keyboard.press('l');
  const tile = page.locator('#library-popover .lib-tile[title="Note"]');
  const from = (await tile.boundingBox())!;
  const board = (await page.locator('#board').boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(board.x + 1000, board.y + 300, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator('#world g.node')).toHaveCount(2);
  await expect(edit).toBeFocused();
  await expect(edit).toHaveClass(/note/);
  await expect(edit).toHaveValue(NOTE_DEFAULT);
  expect(await selectedAll()).toBe(true);
  await page.keyboard.press('Enter');
  await expect(edit).toHaveCount(0);

  // CV-14: the default note wraps; its editor covers every drawn line.
  const body = page.locator('#world g.node-note .note-body', { hasText: 'A note about' });
  await expect(body.locator('tspan')).toHaveCount(2);
  const drawn = await dblclickSettled(page, body);
  await expect(edit).toBeFocused();
  await expect(edit).toHaveClass(/note/);
  expect((await edit.boundingBox())!.height).toBeGreaterThanOrEqual(drawn.height);
  await edit.fill('first\nsecond');
  await edit.press('Enter');
  await expect(page.locator('#world .note-body', { hasText: 'first second' })).toHaveCount(1);
  const B = await boardIdOf(stack, page);
  await expect.poll(async () => (await stack.sql(`SELECT label FROM node WHERE board_id = ${B} AND kind = 'note'`)).map(row => row.label).sort())
    .toEqual(['Retries go to the DLQ', 'first second']);

  await page.reload();
  await expect(page.locator('#world .note-body', { hasText: 'Retries go to the DLQ' })).toHaveCount(1);
  await expect(page.locator('#world .note-body', { hasText: 'first second' })).toHaveCount(1);
});
