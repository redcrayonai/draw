import type { Locator, Page } from '@playwright/test';
import { test, expect, openBoard, drawNode, drawEdge, shareBoard, boardIdOf, boardWith, settledBox, type Stack } from '../fixtures';

// PR #4, #25, #132: how an edge's evidence reads on the canvas (class, overlay, legend, inspector).

const NONE = { none: [] };
const WIDE = { viewport: { width: 1440, height: 900 } };

/** The board's edges by evidence, read as the database owner. */
const edgesOn = async (stack: Stack, B: number) =>
  (await stack.sql(`SELECT id, evidence FROM edge WHERE board_id = ${B}`)).map(r => ({ id: Number(r.id), evidence: String(r.evidence) }));

const line = (page: Page, id: number) => page.locator(`#world g.edge:has(.edge-hit[data-edge-id="${id}"]) .edge-line`);

/** The line as the browser draws it: what the stylesheet computes, not the classes. */
const drawn = (locator: Locator) => locator.evaluate(el => {
  const s = getComputedStyle(el);
  return { width: s.strokeWidth, dash: s.strokeDasharray };
});

/** Click the middle of this edge's routed path (shift adds it to the selection). */
async function selectEdge(page: Page, id: number, shift = false) {
  const hit = page.locator(`#world .edge-hit[data-edge-id="${id}"]`);
  // A reveal pan can still be gliding the board: aim once the edge has stopped moving.
  await settledBox(hit);
  const point = await hit.evaluate(el => {
    const path = el as SVGPathElement;
    const at = path.getPointAtLength(path.getTotalLength() / 2);
    const m = path.getScreenCTM()!;
    return { x: at.x * m.a + at.y * m.c + m.e, y: at.x * m.b + at.y * m.d + m.f };
  });
  if (shift) await page.keyboard.down('Shift');
  await page.mouse.click(point.x, point.y);
  if (shift) await page.keyboard.up('Shift');
  await expect(page.locator('#toolbar')).toHaveClass(/edges-only/);
}

const inspector = (page: Page) => page.locator('#inspector');
const action = (page: Page, name: string) => inspector(page).getByRole('button', { name, exact: true });
const summary = (page: Page) => page.locator('#legend-summary');

test('a hand-drawn edge cites its human author, and a drop on empty canvas draws nothing', async ({ guest, stack }) => {
  const page = await guest();
  await openBoard(page, stack.url);
  await drawNode(page, 'web');
  await drawNode(page, 'api');
  await drawEdge(page, 0, 1);
  const me = await page.evaluate(() => (window as any).myIdentityHex as string);
  const B = await boardIdOf(stack, page);
  const [edge] = await edgesOn(stack, B);
  expect(edge.evidence).toBe(`human:${me}`);
  await expect(line(page, edge.id)).toHaveClass(/ev-human/);

  await page.keyboard.press('Escape');
  await selectEdge(page, edge.id);
  await expect(inspector(page).locator('.insp-title')).toHaveText('web → api');
  await expect(inspector(page).locator('.insp-chip')).toHaveText('human');
  await expect(inspector(page).locator('.insp-cite')).toHaveText(`asserted by ${me}`);
  await expect(inspector(page).locator('.insp-provtext')).toHaveText(`asserted by ${me}`);

  // Drag web's handle out onto empty board: the ghost line shows the drag is a draw, and the drop makes nothing.
  await page.keyboard.press('Escape');
  const web = page.locator('#world g.node').first();
  await web.locator('.node-rect').click();
  const handle = await settledBox(page.locator(`.edge-handle[data-node-id="${await web.getAttribute('data-id')}"]`).first());
  const from = await settledBox(web);
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  const drop = { x: from.x + from.width / 2, y: from.y + from.height + 260 };
  await page.mouse.move(drop.x, drop.y, { steps: 8 });
  await expect(page.locator('#world .edge-ghost')).toHaveCount(1); // a straight-down line has a 0-wide box, so not 'visible'
  // The drop point is bare canvas: inside #board, on no node and under no panel.
  expect(await page.evaluate(({ x, y }) => {
    const hit = document.elementFromPoint(x, y);
    return hit !== null && hit.closest('#board') !== null && hit.closest('g.node') === null;
  }, drop)).toBe(true);
  await page.mouse.up();
  await expect(page.locator('#world .edge-ghost')).toHaveCount(0);
  // A later write's round trip: a stray edge from the drop would have landed before this node.
  await drawNode(page, 'db');
  await expect(page.locator('#world g.edge')).toHaveCount(1);
  expect(await edgesOn(stack, B)).toHaveLength(1);
});

test('the evidence overlay legend counts each class live, and draws class by line', async ({ account, stack }) => {
  const token = stack.accountToken();
  const page = await account(token, WIDE);
  const { B, ids: [a, b, c] } = await boardWith(page, stack, ['a', 'b', 'c']);
  await drawEdge(page, 0, 1);
  // create_edge: boardId, from, to, label, evidence, imported, evidenceSnippet, evidenceStatus
  await stack.callReducer(token, 'create_edge', [B, b, c, '', 'import', NONE, NONE, NONE]);
  await stack.callReducer(token, 'create_edge', [B, a, c, '', 'agent:guess', NONE, NONE, NONE]);
  await expect(page.locator('#world g.edge')).toHaveCount(3);
  const id = Object.fromEntries((await edgesOn(stack, B)).map(e => [e.evidence.split(':')[0], e.id]));
  // drawEdge leaves a selected; a selected node's edges flow (dashes), so clear it before reading lines
  await page.keyboard.press('Escape');
  await expect(page.locator('#toolbar')).toBeHidden();

  await expect(page.locator('#legend')).toBeHidden();
  await page.keyboard.press('Alt+e');
  await expect(page.locator('#overlay-row')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#legend')).toBeVisible();
  await expect(summary(page)).toHaveText('3 shown edges · 1 proven · 0 stale source · 0 test-only · 1 asserted by human · 1 claimed by agent · 0 none');

  // CV-56: import solid and strongest, human dashed, an agent claim weak and dotted.
  await expect.poll(() => drawn(line(page, id.import))).toEqual({ width: '2px', dash: 'none' });
  await expect.poll(() => drawn(line(page, id.human))).toMatchObject({ dash: '6px, 4px' });
  await expect.poll(() => drawn(line(page, id.agent))).toEqual({ width: '1.5px', dash: '0.5px, 5px' });
  const [imp, agent] = [await drawn(line(page, id.import)), await drawn(line(page, id.agent))];
  expect(parseFloat(imp.width)).toBeGreaterThan(parseFloat(agent.width));

  // A new edge reaches the counts without a toggle.
  await drawEdge(page, 2, 0);
  await expect(summary(page)).toContainText('4 shown edges');
  await expect(summary(page)).toContainText('2 asserted by human');
  // ...and so does one written elsewhere (here by the module), with no action on this page.
  await stack.callReducer(token, 'create_edge', [B, b, a, '', 'import', NONE, NONE, NONE]);
  await expect(summary(page)).toHaveText('5 shown edges · 2 proven · 0 stale source · 0 test-only · 2 asserted by human · 1 claimed by agent · 0 none');

  await page.keyboard.press('Alt+e');
  await expect(page.locator('#overlay-row')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#legend')).toBeHidden();
});

test('the edge inspector names an agent claim, and only writers can hide or delete', async ({ account, stack }) => {
  test.setTimeout(90_000);
  const token = stack.accountToken();
  const page = await account(token, WIDE);
  const { B, ids: [a, b, c] } = await boardWith(page, stack, ['a', 'b', 'c']);
  await stack.callReducer(token, 'create_edge', [B, a, b, 'reads', 'agent:guessed from names', NONE, NONE, NONE]);
  await expect(page.locator('#world g.edge')).toHaveCount(1);
  const [claim] = await edgesOn(stack, B);

  await page.keyboard.press('Escape');
  await selectEdge(page, claim.id);
  const insp = inspector(page);
  await expect(insp.locator('.eyebrow').first()).toHaveText('EDGE');
  await expect(insp.locator('.insp-title')).toHaveText('a → b');
  await expect(insp.locator('.insp-chip')).toHaveText('agent claim');
  await expect(insp.locator('.insp-chip')).toHaveClass(/weak/);
  await expect(insp.locator('.eyebrow').nth(1)).toHaveText('CITED AT');
  await expect(insp.locator('.insp-cite')).toHaveText('rests on: guessed from names');
  await expect(insp.locator('.insp-provtext')).toHaveText('claimed by agent · unverified');
  for (const name of ['copy citation', 'hide edge…', 'delete']) await expect(action(page, name)).toBeVisible();

  // CC-42 under the overlay: dotted line, its legend row and count (deselected, so the line reads unselected).
  await page.keyboard.press('Escape');
  await expect(page.locator('#toolbar')).toBeHidden();
  await page.keyboard.press('Alt+e');
  await expect(page.locator('#overlay-row')).toHaveAttribute('aria-pressed', 'true');
  await expect(line(page, claim.id)).toHaveClass(/ev-agent/);
  await expect.poll(() => drawn(line(page, claim.id))).toEqual({ width: '1.5px', dash: '0.5px, 5px' });
  // The legend rows are static markup, so text alone would pass while it is hidden.
  await expect(page.locator('#legend .legend-row', { hasText: 'agent claim' })).toBeVisible();
  await expect(summary(page)).toContainText('1 claimed by agent');
  await page.keyboard.press('Alt+e');
  await expect(page.locator('#legend')).toBeHidden();

  // CV-58: two edges roll up weakest first, whatever order they were picked in.
  await stack.callReducer(token, 'create_edge', [B, b, c, '', 'import', NONE, NONE, NONE]);
  await expect(page.locator('#world g.edge')).toHaveCount(2);
  const imported = (await edgesOn(stack, B)).find(e => e.evidence === 'import')!;
  await page.keyboard.press('Escape');
  await selectEdge(page, imported.id);
  await selectEdge(page, claim.id, true);
  await expect(insp.locator('.insp-title')).toHaveText('2 edges');
  await expect(insp.locator('.insp-sum')).toHaveText('1 import · 1 agent claim');
  await expect(insp.locator('.insp-item-cls')).toHaveText(['agent claim', 'import']);
  await expect(insp.locator('.insp-item-at')).toHaveText(['rests on: guessed from names', 'import']);
  await expect(action(page, 'hide as set…')).toBeVisible();

  // A view-link reader sees the same evidence and none of the writer actions.
  await page.keyboard.press('Escape');
  const link = await shareBoard(page, 'view');
  const readerToken = stack.accountToken();
  const reader = await account(readerToken, WIDE);
  await reader.goto(link);
  await expect(reader.locator('#world g.edge')).toHaveCount(2);
  await selectEdge(reader, claim.id);
  await expect(inspector(reader).locator('.insp-chip')).toHaveText('agent claim');
  await expect(inspector(reader).locator('.insp-cite')).toHaveText('rests on: guessed from names');
  await expect(inspector(reader).locator('.insp-provtext')).toHaveText('claimed by agent · unverified');
  await expect(action(reader, 'copy citation')).toBeVisible();
  await expect(action(reader, 'hide edge…')).toHaveCount(0);
  await expect(action(reader, 'delete')).toHaveCount(0);
  await selectEdge(reader, imported.id, true);
  await expect(inspector(reader).locator('.insp-title')).toHaveText('2 edges');
  await expect(action(reader, 'hide as set…')).toHaveCount(0);

  // The module refuses the reader too, not just the panel.
  await expect(stack.callReducer(readerToken, 'delete_edge', [claim.id])).rejects.toThrow('board is read only');
  await expect(stack.callReducer(readerToken, 'set_edge_hidden', [claim.id, true, NONE])).rejects.toThrow('board is read only');
  expect(await stack.sql(`SELECT hidden FROM edge WHERE id = ${claim.id}`)).toEqual([{ hidden: false }]);
});

test('a source citation that goes stale reads as stale, live', async ({ account, stack }) => {
  const token = stack.accountToken();
  const page = await account(token, WIDE);
  const { B, ids: [n1, n2] } = await boardWith(page, stack, ['n1', 'n2']);
  await stack.callReducer(token, 'add_repo_files', [B, ['src/a.ts']]);
  await stack.callReducer(token, 'create_edge', [B, n1, n2, 'reads', 'source:src/a.ts:3', NONE, NONE, { some: 'ok' }]);
  await expect(page.locator('#world g.edge')).toHaveCount(1);
  const [edge] = await edgesOn(stack, B);

  await page.keyboard.press('Escape');
  await page.keyboard.press('Alt+e');
  await expect(page.locator('#overlay-row')).toHaveAttribute('aria-pressed', 'true');
  await expect(line(page, edge.id)).toHaveClass(/ev-source/);
  await expect.poll(() => drawn(line(page, edge.id))).toMatchObject({ dash: 'none' });
  await expect(summary(page)).toContainText('1 proven');
  await expect(summary(page)).toContainText('0 stale source');
  await selectEdge(page, edge.id);
  const insp = inspector(page);
  await expect(insp.locator('.insp-chip')).toHaveText('source');
  await expect(insp.locator('.insp-cite')).toHaveText('src/a.ts:3');
  await expect(insp.locator('.insp-ref-note')).toHaveCount(0);

  // A checkpoint flags it stale: the open page follows without a reload.
  await stack.callReducer(token, 'update_edge_evidence', [edge.id, 'source:src/a.ts:3', 'stale']);
  await expect(line(page, edge.id)).toHaveClass(/ev-stale/);
  // The class is set with or without the overlay; the stale dash is what the overlay draws.
  await expect.poll(() => drawn(line(page, edge.id))).toMatchObject({ dash: '3px, 3px' });
  await expect(page.locator(`#world g.edge:has(.edge-hit[data-edge-id="${edge.id}"]) title`)).toHaveText('Stale source citation · src/a.ts:3');
  await expect(summary(page)).toContainText('0 proven');
  await expect(summary(page)).toContainText('1 stale source');
  await expect(insp.locator('.insp-chip')).toHaveText('stale source');
  await expect(insp.locator('.insp-chip')).toHaveClass(/stale/);
  await expect(insp.locator('.insp-cite')).toHaveText('src/a.ts:3');
  // No consent on this board, so no stored line: the no-line wording.
  await expect(insp.locator('.insp-ref-note')).toHaveText('Source citation has no captured source line. Location is as last seen.');
});
