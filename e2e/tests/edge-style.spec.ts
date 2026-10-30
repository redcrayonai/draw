import { test, expect, openBoard, drawNode, drawEdge, shareBoard, selectEdge, pick, exportSvg } from '../fixtures';
import type { Page } from '@playwright/test';

// RC-688: a person styles an edge's colour, line and weight from the toolbar.

const line = (page: Page) => page.locator('#world g.edge .edge-line').first();

/** The line as the browser draws it: what the stylesheet computes, not the classes. */
const drawn = (page: Page) => line(page).evaluate(el => {
  const s = getComputedStyle(el);
  return { stroke: s.stroke, width: s.strokeWidth, dash: s.strokeDasharray, cap: s.strokeLinecap, marker: el.getAttribute('marker-end') };
});

/** A colour token resolved in the current theme, for comparing with a line's stroke. */
const token = (page: Page, color: string) => page.evaluate(name => {
  const probe = document.body.appendChild(document.createElement('span'));
  probe.style.color = `var(--c-${name})`;
  const rgb = getComputedStyle(probe).color;
  probe.remove();
  return rgb;
}, color);

test('an edge keeps the colour, line and weight a person gives it: live for collaborators, after reload, through the overlay and in the export', async ({ guest, account, stack }) => {
  test.setTimeout(90_000);
  const owner = await guest();
  await openBoard(owner, stack.url);
  await drawNode(owner, 'checkout');
  await drawNode(owner, 'payments');
  await drawEdge(owner, 0, 1);
  // drawEdge leaves the first node selected, and a selected node's edges flow (dashes): clear it first
  await owner.keyboard.press('Escape');
  await expect(owner.locator('#toolbar')).toBeHidden();
  const plain = await drawn(owner);
  expect(plain.dash).toBe('none');
  const link = await shareBoard(owner, 'edit');
  await owner.keyboard.press('Escape');
  const editor = await account();
  await editor.goto(link);
  await expect(editor.locator('#world g.edge')).toHaveCount(1);

  // Each control sets one part; the canvas and the toolbar show it at once.
  await selectEdge(owner);
  await expect(owner.locator('#tb-reset-style')).toBeDisabled();
  await pick(owner, 'style', '[data-weight="bold"]');
  await pick(owner, 'style', '[data-stroke="dotted"]');
  // purple: in the dark theme blue is also the selection colour
  await pick(owner, 'color', '[data-color="purple"]');
  const purple = await token(owner, 'purple');
  await expect.poll(() => drawn(owner)).toEqual({ stroke: purple, width: '3.5px', dash: '0.5px, 7px', cap: 'round', marker: 'url(#mk-c-purple-bold)' });
  await expect(owner.locator('#tb-color-menu summary')).toHaveAttribute('aria-label', 'Colour: Purple');
  // The pointer is still on the swatch: once its transitions settle it still shows its colour.
  const hovered = await owner.locator('#tb-swatches [data-color="purple"]').evaluate(async el => {
    await Promise.all(el.getAnimations().map(a => a.finished));
    return getComputedStyle(el).backgroundColor;
  });
  expect(hovered).toBe(purple);
  await expect(owner.locator('#tb-weight [data-weight="bold"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(owner.locator('#tb-stroke [data-stroke="dotted"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(owner.locator('#tb-reset-style')).toBeEnabled();

  // A collaborator sees it without reloading, and their change comes back the same way.
  await expect.poll(() => drawn(editor)).toMatchObject({ width: '3.5px', dash: '0.5px, 7px', marker: 'url(#mk-c-purple-bold)' });
  await selectEdge(editor);
  await pick(editor, 'style', '[data-weight="medium"]');
  await expect.poll(() => drawn(owner)).toMatchObject({ width: '2.5px', dash: '0.5px, 5.5px' });

  // Undo and redo are the owner's own: the colour goes, then comes back. The
  // edge is still selected, and an uncoloured selected edge takes the selection
  // head, at the medium weight the editor set.
  await owner.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await drawn(owner)).marker).toBe('url(#mk-sel-medium)');
  await expect(owner.locator('#tb-color-menu summary')).toHaveAttribute('aria-label', 'Colour: Default');
  await expect(line(editor)).not.toHaveClass(/color-purple/);
  await owner.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(async () => (await drawn(owner)).marker).toBe('url(#mk-c-purple-medium)');
  await expect.poll(async () => (await drawn(editor)).marker).toBe('url(#mk-c-purple-medium)');

  // The style is stored: a reload draws it again.
  await expect(owner.locator('#save-status')).toHaveText('Saved');
  await owner.reload();
  await expect(owner.locator('#world g.edge')).toHaveCount(1);
  await expect.poll(() => drawn(owner)).toEqual({ stroke: purple, width: '2.5px', dash: '0.5px, 5.5px', cap: 'round', marker: 'url(#mk-c-purple-medium)' });

  // The evidence overlay owns line and weight while it is on (a hand-drawn
  // edge is dashed: human evidence, with the usual head); the colour stays,
  // and turning it off brings the saved style back.
  await owner.keyboard.press('Alt+KeyE'); // no switch: a hand-drawn board has no machine evidence
  await expect.poll(() => drawn(owner)).toMatchObject({ stroke: purple, width: '1px', dash: '6px, 4px', marker: 'url(#mk-c-purple)' });
  await selectEdge(owner);
  await owner.locator('#tb-style-menu summary').click();
  await expect(owner.locator('#tb-overlay-note')).toBeVisible();
  await expect(owner.locator('#tb-weight [data-weight="medium"]')).toHaveAttribute('aria-pressed', 'true');
  await owner.keyboard.press('Escape');
  await owner.keyboard.press('Alt+KeyE');
  await expect.poll(() => drawn(owner)).toMatchObject({ width: '2.5px', dash: '0.5px, 5.5px' });

  // The export draws what the screen does.
  let svg = '';
  for await (const chunk of (await (await exportSvg(owner)).createReadStream())!) svg += chunk;
  const exported = new RegExp(`<path[^>]*class="edge-line[^"]*"[^>]*>`).exec(svg)?.[0] ?? '';
  for (const decl of [`stroke:${purple}`, 'stroke-width:2.5px', 'stroke-dasharray:0.5px, 5.5px', 'stroke-linecap:round', 'marker-end="url(#mk-c-purple-medium)"']) {
    expect(exported, decl).toContain(decl);
  }
  expect(svg).toContain('id="mk-c-purple-medium"');

  // Reset puts the edge back to what a new one gets, for everyone.
  await selectEdge(owner);
  await pick(owner, 'style', '#tb-reset-style');
  await expect(owner.locator('#tb-reset-style')).toBeDisabled();
  // Escape closes the popover, then clears the selection: the edge draws as a new one does.
  for (const page of [owner, editor]) {
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect.poll(() => drawn(page)).toEqual(plain);
  }
});

test('a reader sees an edge style but cannot change it', async ({ guest, stack }) => {
  const owner = await guest();
  await openBoard(owner, stack.url);
  await drawNode(owner, 'web');
  await drawNode(owner, 'api');
  await drawEdge(owner, 0, 1);
  await selectEdge(owner);
  await pick(owner, 'style', '[data-weight="bold"]');
  await expect.poll(async () => (await drawn(owner)).width).toBe('3px');
  const link = await shareBoard(owner, 'view');
  const reader = await guest();
  await reader.goto(link);
  await expect.poll(async () => (await drawn(reader)).width).toBe('3px');
  await selectEdge(reader);
  await reader.locator('#tb-style-menu summary').click();
  for (const control of ['#tb-weight [data-weight="regular"]', '#tb-stroke [data-stroke="dashed"]', '#tb-reset-style']) {
    await expect(reader.locator(control)).toBeDisabled();
  }
});
