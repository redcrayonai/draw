import { test, expect, openBoard, drawNode, drawEdge, shareBoard, boardIdOf, selectEdge, guestToken, nodes, settledBox, type Stack } from '../fixtures';
import type { Locator, Page } from '@playwright/test';

// Moving, resizing and undo on the canvas (PR #4, #10, #71, #143).

const READ_ONLY = 'not authorized: board is read only';
const NONE = { none: [] };
const edges = (page: Page) => page.locator('#world g.edge');
const nodeG = (page: Page, id: number) => page.locator(`#world g.node[data-id="${id}"]`);
const rect = (page: Page, id: number) => nodeG(page, id).locator('.node-rect');
const corner = (page: Page, id: number) => page.locator(`.resize-handle[data-node-id="${id}"][data-corner="se"]`);
const title = (page: Page) => page.locator('#inspector .insp-title');
const line = (page: Page) => page.locator('#world g.edge .edge-line').first();
const nodeIds = (page: Page) => nodes(page).evaluateAll(gs => gs.map(g => Number(g.getAttribute('data-id'))));
/** Inside the node, clear of its centre where drags start: two presses there within 400 ms are a double-click. */
const clickNode = (page: Page, id: number, modifiers?: ['Shift']) => rect(page, id).click({ position: { x: 12, y: 12 }, modifiers });
const translate = (r: { x: number; y: number }) => `translate(${r.x} ${r.y})`;
const undo = (page: Page) => page.keyboard.press('ControlOrMeta+z');
const redo = (page: Page) => page.keyboard.press('ControlOrMeta+Shift+z');
/** Every write acknowledged: the gesture's history entry is in, so the next ⌘Z undoes it and not the step before. */
const saved = (page: Page) => expect(page.locator('#save-status')).toHaveText('Saved');

async function row(stack: Stack, id: number) {
  const [r] = await stack.sql(`SELECT x, y, w, h FROM node WHERE id = ${id}`);
  return r && { x: Number(r.x), y: Number(r.y), w: Number(r.w), h: Number(r.h) };
}
const labelsOn = async (stack: Stack, B: number) => (await stack.sql(`SELECT label FROM node WHERE board_id = ${B}`)).map(r => r.label);
const edgeRows = (stack: Stack, B: number) => stack.sql(`SELECT * FROM edge WHERE board_id = ${B}`);
const some = (v: string) => ({ some: v });

/** One node or edge made on a service account's own board (off screen, no write budget): it moves that table's id sequence. Returns its id. */
let idRows: { node(): Promise<number>; edge(): Promise<number> } | undefined;
async function ids(stack: Stack) {
  if (idRows) return idRows;
  const svc = await stack.serviceIdentity('e2e-ids');
  const name = `ids ${svc.identity.slice(0, 16)}`;
  await stack.callReducer(svc.token, 'create_board', [name]);
  const S = Number((await stack.sql(`SELECT id FROM board WHERE name = '${name}'`))[0].id);
  const last = async (table: string) => Math.max(...(await stack.sql(`SELECT id FROM ${table} WHERE board_id = ${S}`)).map(r => Number(r.id)));
  const node = async () => { await stack.callReducer(svc.token, 'create_node', [S, 'id', '', 0, 0, 64, 48, 'ink', false, ...Array(7).fill(NONE)]); return last('node'); };
  const ends = [await node(), await node()];
  const edge = async () => { await stack.callReducer(svc.token, 'create_edge', [S, ...ends, '', 'human:e2e', NONE, NONE, NONE]); return last('edge'); };
  return (idRows = { node, edge });
}

// The canvas keeps captured row ids in one set for nodes and edges (divergent test at the end): an edge whose
// id equals a node id this tab made is never captured. Every test starts with node ids well ahead of edge ids,
// so the ids it makes cannot meet, whatever ran before it on this stack.
test.beforeEach(async ({ stack }) => {
  const { node, edge } = await ids(stack);
  for (let lead = (await node()) - (await edge()); lead < 16; lead++) await node();
});

/** Press on the element's centre and move by dx, dy in 10 steps; release unless told not to. */
async function drag(page: Page, target: Locator, dx: number, dy: number, release = true) {
  const box = await settledBox(target);
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 10 });
  if (release) await page.mouse.up();
}

/** Record the node as drawn on every frame (position and size) until stopFrames. */
const startFrames = (page: Page, id: number) => page.evaluate(nodeId => {
  const w = window as any;
  w.__frames = [];
  w.__sampling = true;
  const sample = () => {
    const g = document.querySelector(`#world g.node[data-id="${nodeId}"]`);
    const r = g?.querySelector('.node-rect');
    w.__frames.push(`${g?.getAttribute('transform')} ${r?.getAttribute('width')}x${r?.getAttribute('height')}`);
    if (w.__sampling) requestAnimationFrame(sample);
  };
  return new Promise(done => requestAnimationFrame(() => { sample(); done(null); }));
}, id);
/** Two more frames, so the cleared preview is drawn and sampled, then the frames. */
const stopFrames = (page: Page) => page.evaluate(() => new Promise<string[]>(done => {
  const w = window as any;
  requestAnimationFrame(() => requestAnimationFrame(() => { w.__sampling = false; done(w.__frames); }));
}));

test('a dragged node lands on the grid, persists, and moves for a collaborator', async ({ account, guest, stack }) => {
  test.setTimeout(90_000);
  const owner = await account();
  await openBoard(owner, `${stack.url}?new=1`);
  await drawNode(owner, 'api');
  const [id] = await nodeIds(owner);
  const start = await row(stack, id);
  const link = await shareBoard(owner, 'view');
  await owner.keyboard.press('Escape');
  const viewer = await guest();
  await openBoard(viewer, link);
  await expect(nodeG(viewer, id)).toHaveAttribute('transform', translate(start));

  // Off-grid distances: the stored position is snapped to 4 px.
  await drag(owner, rect(owner, id), 203, 121);
  await expect.poll(async () => (await row(stack, id)).x).not.toBe(start.x);
  const moved = await row(stack, id);
  expect([moved.x % 4, moved.y % 4]).toEqual([0, 0]);
  expect(Math.abs(moved.x - start.x - 203)).toBeLessThanOrEqual(2);
  expect(Math.abs(moved.y - start.y - 121)).toBeLessThanOrEqual(2);

  // The viewer's open page follows without a reload; the owner's reload keeps it.
  await expect(nodeG(viewer, id)).toHaveAttribute('transform', translate(moved));
  await expect(nodeG(owner, id)).toHaveAttribute('transform', translate(moved));
  await owner.reload();
  await expect(nodeG(owner, id)).toHaveAttribute('transform', translate(moved));
});

test('a dropped node never snaps back while its write is in flight', async ({ guest, stack }) => {
  const page = await guest();
  await openBoard(page, `${stack.url}?new=1`);
  await drawNode(page, 'api');
  const [id] = await nodeIds(page);
  const start = await row(stack, id);
  await clickNode(page, id);

  await startFrames(page, id);
  await drag(page, rect(page, id), 240, 0);
  await expect.poll(async () => (await row(stack, id)).x).toBe(start.x + 240);
  await saved(page);
  let frames = await stopFrames(page);
  const before = `${translate(start)} 160x80`;
  const after = `${translate({ x: start.x + 240, y: start.y })} 160x80`;
  // Once the node leaves its old place it never draws there again.
  const left = frames.indexOf(after);
  expect(left).toBeGreaterThan(0);
  expect(frames[0]).toBe(before);
  expect(frames.slice(frames.findIndex(f => f !== before))).not.toContain(before);
  expect(frames.at(-1)).toBe(after);

  // The same for a resize: the new size holds through the round trip.
  await startFrames(page, id);
  await drag(page, corner(page, id), 80, 40);
  await expect.poll(async () => (await row(stack, id)).w).toBe(240);
  await saved(page);
  frames = await stopFrames(page);
  const grown = `${translate({ x: start.x + 240, y: start.y })} 240x120`;
  expect(frames[0]).toBe(after);
  expect(frames).toContain(grown);
  expect(frames.slice(frames.findIndex(f => f !== after))).not.toContain(after);
  expect(frames.at(-1)).toBe(grown);
});

test('a group drag moves all selected nodes, and one undo puts them back', async ({ guest, stack }) => {
  const page = await guest();
  await openBoard(page, `${stack.url}?new=1`);
  await drawNode(page, 'left');
  await drawNode(page, 'right');
  const [a, b] = await nodeIds(page);
  const [startA, startB] = [await row(stack, a), await row(stack, b)];
  await page.keyboard.press('Escape');
  await clickNode(page, a);
  await clickNode(page, b, ['Shift']);
  await expect(title(page)).toHaveText('2 nodes');

  await drag(page, rect(page, a), 160, 0);
  const both = async () => [await row(stack, a), await row(stack, b)];
  await expect.poll(both).toEqual([{ ...startA, x: startA.x + 160 }, { ...startB, x: startB.x + 160 }]);
  await expect(nodeG(page, b)).toHaveAttribute('transform', translate({ x: startB.x + 160, y: startB.y }));
  await saved(page);
  await undo(page);
  await expect.poll(both).toEqual([startA, startB]);
  await expect(nodeG(page, a)).toHaveAttribute('transform', translate(startA));
  await expect(nodeG(page, b)).toHaveAttribute('transform', translate(startB));

  // A marquee over empty canvas selects the same pair. It starts where the node toolbar sat: wait for it to go.
  await page.keyboard.press('Escape');
  await expect(title(page)).toBeHidden();
  await expect(page.locator('#toolbar')).toBeHidden();
  const [boxA, boxB] = [await settledBox(rect(page, a)), await settledBox(rect(page, b))];
  await page.mouse.move(boxA.x - 30, boxA.y - 30);
  await page.mouse.down();
  await page.mouse.move(boxB.x + boxB.width + 30, boxB.y + boxB.height + 30, { steps: 10 });
  await page.mouse.up();
  await expect(title(page)).toHaveText('2 nodes');
});

test('a group move keeps the moves that landed when one node is deleted mid-drag', async ({ account, stack }) => {
  const token = stack.accountToken();
  const page = await account(token);
  await openBoard(page, `${stack.url}?new=1`);
  await drawNode(page, 'left');
  await drawNode(page, 'right');
  const [a, b] = await nodeIds(page);
  const startA = await row(stack, a);
  await page.keyboard.press('Escape');
  await clickNode(page, a);
  await clickNode(page, b, ['Shift']);
  await expect(title(page)).toHaveText('2 nodes');

  // Still holding the mouse: the preview has moved, then the other node goes.
  await drag(page, rect(page, a), 100, 0, false);
  await expect(nodeG(page, a)).toHaveAttribute('transform', translate({ x: startA.x + 100, y: startA.y }));
  await stack.callReducer(token, 'delete_node', [b]);
  await expect(nodes(page)).toHaveCount(1);
  await page.mouse.up();

  await expect(page.locator('#error-strip')).toBeVisible();
  await expect(page.locator('#error-text')).toHaveText(`node ${b} does not exist`);
  await expect.poll(() => row(stack, a)).toEqual({ ...startA, x: startA.x + 100 });
  await expect(nodeG(page, a)).toHaveAttribute('transform', translate({ x: startA.x + 100, y: startA.y }));
  await undo(page);
  await expect.poll(() => row(stack, a)).toEqual(startA);
  await expect(nodeG(page, a)).toHaveAttribute('transform', translate(startA));
});

test('a resize snaps to the grid, undoes in one step, and stops at the minimum', async ({ guest, stack }) => {
  const page = await guest();
  await openBoard(page, `${stack.url}?new=1`);
  await drawNode(page, 'api');
  const [id] = await nodeIds(page);
  const start = await row(stack, id);
  expect(start).toMatchObject({ w: 160, h: 80 });
  await clickNode(page, id);

  await drag(page, corner(page, id), 81, 39);
  await expect.poll(() => row(stack, id)).toEqual({ ...start, w: 240, h: 120 });
  await saved(page);
  await undo(page);
  await expect.poll(() => row(stack, id)).toEqual(start);
  await expect(rect(page, id)).toHaveAttribute('width', '160');
  await expect(rect(page, id)).toHaveAttribute('height', '80');

  await drag(page, corner(page, id), -300, -300);
  await expect.poll(() => row(stack, id)).toEqual({ ...start, w: 64, h: 48 });
  await expect(rect(page, id)).toHaveAttribute('height', '48');
  // The module holds the same floor.
  const token = await guestToken(page);
  await expect(stack.callReducer(token, 'resize_node', [id, start.x, start.y, 60, 44]))
    .rejects.toThrow('size rule: nodes must be at least 64x48; got 60x44');

  // Free text has a lower floor, 16x16, in the canvas and in the module.
  const B = await boardIdOf(stack, page);
  const [{ token: style }] = await stack.sql(`SELECT token FROM node WHERE id = ${id}`);
  const at = { x: start.x, y: start.y + 200 };
  await stack.callReducer(token, 'create_node', [B, 'free text', '', at.x, at.y, 160, 48, style, false, { some: 'text' }, NONE, NONE, NONE, NONE, NONE, NONE]);
  await expect(nodes(page)).toHaveCount(2);
  const [text] = (await nodeIds(page)).filter(n => n !== id);
  await nodeG(page, text).locator('.text-body').click();
  await drag(page, corner(page, text), -300, -300);
  await expect.poll(() => row(stack, text)).toEqual({ ...at, w: 16, h: 16 });
  await expect(stack.callReducer(token, 'resize_node', [text, at.x, at.y, 12, 12]))
    .rejects.toThrow('size rule: text must be at least 16x16; got 12x12');

  // Both sizes are stored.
  await page.reload();
  await expect(rect(page, id)).toHaveAttribute('height', '48');
  await expect(rect(page, id)).toHaveAttribute('width', '64');
  await expect(nodeG(page, text).locator('rect').first()).toHaveAttribute('width', '16');
});

test('a view-link visitor can neither drag nor delete', async ({ guest, stack }) => {
  test.setTimeout(90_000);
  const owner = await guest();
  await openBoard(owner, `${stack.url}?new=1`);
  await drawNode(owner, 'web');
  await drawNode(owner, 'api');
  await drawEdge(owner, 0, 1);
  const B = await boardIdOf(stack, owner);
  const [a, b] = await nodeIds(owner);
  const start = await row(stack, a);
  const startB = await row(stack, b);
  const [{ id: edgeId }] = await edgeRows(stack, B);
  const link = await shareBoard(owner, 'view');
  await owner.keyboard.press('Escape');
  const viewer = await guest();
  await openBoard(viewer, link);
  await expect(edges(viewer)).toHaveCount(1);
  await expect(nodeG(viewer, a)).toHaveAttribute('transform', translate(start));

  // Pressing selects and inspects; the drag draws no frame anywhere else.
  await startFrames(viewer, a);
  await drag(viewer, rect(viewer, a), 200, 0);
  await expect(title(viewer)).toHaveText('web');
  const frames = await stopFrames(viewer);
  expect(frames.length).toBeGreaterThan(3);
  expect(new Set(frames)).toEqual(new Set([`${translate(start)} 160x80`]));
  await expect(nodeG(owner, a)).toHaveAttribute('transform', translate(start));
  expect(await row(stack, a)).toEqual(start);
  const viewerToken = await guestToken(viewer);
  await expect(stack.callReducer(viewerToken, 'move_node', [a, start.x + 200, start.y])).rejects.toThrow(READ_ONLY);

  // Delete on the node and Backspace on the edge remove nothing; the inspector offers neither.
  await expect(viewer.locator('#inspector').getByRole('button', { name: 'hide node…' })).toHaveCount(0);
  await viewer.keyboard.press('Delete');
  await selectEdge(viewer);
  const inspector = viewer.locator('#inspector');
  await expect(inspector.getByRole('button', { name: 'copy citation' })).toBeVisible();
  await expect(inspector.getByRole('button', { name: 'hide edge…' })).toHaveCount(0);
  await expect(inspector.getByRole('button', { name: 'delete', exact: true })).toHaveCount(0);
  await viewer.keyboard.press('Backspace');
  // A later owner move reaches the viewer after the replies to any write it sent: a refusal would show by then.
  const ownerMove = { x: startB.x + 40, y: startB.y };
  await stack.callReducer(await guestToken(owner), 'move_node', [b, ownerMove.x, ownerMove.y]);
  await expect(nodeG(viewer, b)).toHaveAttribute('transform', translate(ownerMove));
  for (const page of [viewer, owner]) {
    await expect(nodes(page)).toHaveCount(2);
    await expect(edges(page)).toHaveCount(1);
  }
  await expect(viewer.locator('#error-strip')).toBeHidden();
  await expect(stack.callReducer(viewerToken, 'delete_node', [a])).rejects.toThrow(READ_ONLY);
  await expect(stack.callReducer(viewerToken, 'delete_edge', [Number(edgeId)])).rejects.toThrow(READ_ONLY);
  expect(await labelsOn(stack, B)).toHaveLength(2);
  expect(await edgeRows(stack, B)).toHaveLength(1);
});

test('create, delete and two quick undos leave no node and no error, and redo replays them', async ({ guest, stack }) => {
  const page = await guest();
  await openBoard(page, `${stack.url}?new=1`);
  const B = await boardIdOf(stack, page);
  await page.keyboard.press('1');
  await page.locator('#board').click({ position: { x: 600, y: 300 } });
  await page.keyboard.press('Escape');
  await expect(nodes(page)).toHaveCount(1);
  await expect.poll(() => labelsOn(stack, B)).toEqual(['Service']);
  const [id] = await nodeIds(page);
  await clickNode(page, id);
  await page.keyboard.press('Delete');
  await expect(nodes(page)).toHaveCount(0);
  await expect.poll(() => labelsOn(stack, B)).toEqual([]);
  await saved(page);

  // Back to back: the second undo finds the restored row under its new id.
  await undo(page);
  await undo(page);
  // A redo of the create can only run if both undos landed (a dropped one would leave the delete to redo).
  await redo(page);
  await expect(nodes(page)).toHaveCount(1);
  await expect(page.locator('#error-strip')).toBeHidden();
  await expect.poll(() => labelsOn(stack, B)).toEqual(['Service']);
  await redo(page);
  await expect(nodes(page)).toHaveCount(0);
  await expect.poll(() => labelsOn(stack, B)).toEqual([]);
  await expect(page.locator('#error-strip')).toBeHidden();

  await page.reload();
  await expect(page.locator('#board-title')).not.toBeEmpty();
  await expect(nodes(page)).toHaveCount(0);
  expect(await labelsOn(stack, B)).toEqual([]);
});

test('undo walks back through a restored node, and redo replays every step', async ({ guest, stack }) => {
  const page = await guest();
  await openBoard(page, `${stack.url}?new=1`);
  await drawNode(page, 'Undo me');
  const B = await boardIdOf(stack, page);
  const [id] = await nodeIds(page);
  await clickNode(page, id);
  await page.keyboard.press('Delete');
  const steps: Array<[() => Promise<void>, string[]]> = [
    [() => undo(page), ['Undo me']], // restored under a new id
    [() => undo(page), ['Service']], // its label edit reverts on the restored row
    [() => undo(page), []], // its create is undone
    [() => redo(page), ['Service']],
    [() => redo(page), ['Undo me']],
    [() => redo(page), []],
  ];
  await expect(nodes(page)).toHaveCount(0);
  await expect.poll(() => labelsOn(stack, B)).toEqual([]);
  await saved(page);
  for (const [step, labels] of steps) {
    await step();
    await expect(nodes(page)).toHaveCount(labels.length);
    if (labels.length) await expect(nodes(page).locator('.node-label')).toHaveText(labels);
    await expect.poll(() => labelsOn(stack, B)).toEqual(labels);
    await saved(page);
    await expect(page.locator('#error-strip')).toBeHidden();
  }
  await page.reload();
  await expect(page.locator('#board-title')).not.toBeEmpty();
  await expect(nodes(page)).toHaveCount(0);
});

test('deleting a node with edges and undoing brings everything back for every viewer', async ({ guest, stack }) => {
  test.setTimeout(90_000);
  const owner = await guest();
  await openBoard(owner, `${stack.url}?new=1`);
  for (const label of ['web', 'api', 'db']) await drawNode(owner, label);
  await drawEdge(owner, 0, 1);
  await drawEdge(owner, 1, 2);
  const B = await boardIdOf(stack, owner);
  const [a, b, c] = await nodeIds(owner);
  // Non-default kind, style and edge look, so a restore that fell back to defaults shows.
  const ownerToken = await guestToken(owner);
  await stack.callReducer(ownerToken, 'update_node', [b, NONE, some('tier 2'), NONE, NONE, some('datastore'), some('pill'), some('green'), some('dashed'), some('l')]);
  const ab = Number((await stack.sql(`SELECT id FROM edge WHERE from_node = ${a}`))[0].id);
  await stack.callReducer(ownerToken, 'update_edge_style', [ab, some('purple'), some('dotted')]);
  await stack.callReducer(ownerToken, 'set_edge_weight', [ab, 'bold']);
  const look = async (id: number) => (await stack.sql(`SELECT label, sublabel, x, y, w, h, token, focal, kind, shape, color, stroke_style, size FROM node WHERE id = ${id}`))[0];
  const before = await look(b);
  expect(before).toMatchObject({ label: 'api', kind: 'datastore', color: 'green' });
  const edgeLook = async () => (await edgeRows(stack, B)).map(e => [e.evidence, e.color, e.stroke_style]).sort();
  const edgesBefore = await edgeLook();
  expect(edgesBefore.map(([evidence]) => evidence)).toEqual([expect.stringMatching(/^human:/), expect.stringMatching(/^human:/)]);
  const styled = (page: Page) => page.locator('#world g.edge .edge-line.stroke-dotted[marker-end="url(#mk-c-purple-bold)"]');
  const link = await shareBoard(owner, 'view');
  await owner.keyboard.press('Escape');
  const viewer = await guest();
  await openBoard(viewer, link);
  await expect(edges(viewer)).toHaveCount(2);
  await expect(styled(viewer)).toHaveCount(1);
  await expect(viewer.locator('#world')).toContainText('tier 2');

  await owner.keyboard.press('Escape');
  // A pill's corner is outside its outline: press on its top middle instead.
  await rect(owner, b).click({ position: { x: 80, y: 12 } });
  await owner.keyboard.press('Delete');
  for (const page of [owner, viewer]) {
    await expect(nodes(page)).toHaveCount(2);
    await expect(edges(page)).toHaveCount(0);
    await expect(page.locator('#world')).not.toContainText('api');
  }
  expect(await edgeRows(stack, B)).toEqual([]);
  await saved(owner);
  await undo(owner);
  for (const page of [owner, viewer]) {
    await expect(nodes(page)).toHaveCount(3);
    await expect(edges(page)).toHaveCount(2);
    await expect(page.locator('#world')).toContainText('api');
    await expect(page.locator('#world')).toContainText('tier 2');
    await expect(styled(page)).toHaveCount(1);
  }
  const [restored] = (await nodeIds(owner)).filter(id => id !== a && id !== c);
  expect(restored).not.toBe(b);
  expect(await look(restored)).toEqual(before);
  const back = await edgeRows(stack, B);
  expect(back.map(e => [Number(e.from_node), Number(e.to_node)]).sort()).toEqual([[a, restored], [restored, c]].sort());
  expect(await edgeLook()).toEqual(edgesBefore);
  const abBack = back.find(e => Number(e.from_node) === a)!;
  expect(abBack).toMatchObject({ color: 'purple', stroke_style: 'dotted' });
  expect(await stack.sql(`SELECT weight FROM edge_weight WHERE edge_id = ${abBack.id}`)).toEqual([{ weight: 'bold' }]);
});

test('undo will not overwrite someone else\'s later change', async ({ account, stack }) => {
  test.setTimeout(90_000);
  const token = stack.accountToken();
  const owner = await account(token);
  await openBoard(owner, `${stack.url}?new=1`);
  await drawNode(owner, 'Contested');
  const [id] = await nodeIds(owner);
  const link = await shareBoard(owner, 'edit');
  await owner.keyboard.press('Escape');
  const editorToken = stack.accountToken();
  const editor = await account(editorToken);
  await openBoard(editor, link);
  await expect(editor.locator('#world')).toContainText('Contested');

  const start = await row(stack, id);
  await drag(owner, rect(owner, id), 120, 0);
  await expect.poll(async () => (await row(stack, id)).x).toBe(start.x + 120);
  await saved(owner);
  await stack.callReducer(editorToken, 'move_node', [id, 800, 600]);
  // The owner's tab has the editor's move before the undo.
  await expect(nodeG(owner, id)).toHaveAttribute('transform', 'translate(800 600)');

  await undo(owner);
  await expect(owner.locator('#error-strip')).toBeVisible();
  await expect(owner.locator('#error-text')).toHaveText('undo of "move node" rejected — dropped: it was changed by someone else since');
  expect(await row(stack, id)).toMatchObject({ x: 800, y: 600 });
  await expect(nodeG(owner, id)).toHaveAttribute('transform', 'translate(800 600)');
  await expect(nodeG(editor, id)).toHaveAttribute('transform', 'translate(800 600)');
});

test('a new edge appears live for a collaborator and undoes and redoes for both', async ({ guest, stack }) => {
  test.setTimeout(90_000);
  const owner = await guest();
  await openBoard(owner, `${stack.url}?new=1`);
  await drawNode(owner, 'web');
  await drawNode(owner, 'api');
  const B = await boardIdOf(stack, owner);
  const link = await shareBoard(owner, 'view');
  await owner.keyboard.press('Escape');
  const viewer = await guest();
  await openBoard(viewer, link);
  await expect(nodes(viewer)).toHaveCount(2);
  await expect(edges(viewer)).toHaveCount(0);

  await drawEdge(owner, 0, 1);
  await expect(edges(viewer)).toHaveCount(1);
  await owner.keyboard.press('Escape');
  await undo(owner);
  for (const page of [owner, viewer]) await expect(edges(page)).toHaveCount(0);
  await expect.poll(async () => (await edgeRows(stack, B)).length).toBe(0);
  await saved(owner);
  await redo(owner);
  for (const page of [owner, viewer]) await expect(edges(page)).toHaveCount(1);
  await expect.poll(async () => (await edgeRows(stack, B)).length).toBe(1);
});

test('a deleted edge comes back with its colour, line and weight', async ({ account, guest, stack }) => {
  test.setTimeout(90_000);
  const token = stack.accountToken();
  const page = await account(token);
  await openBoard(page, `${stack.url}?new=1`);
  await drawNode(page, 'web');
  await drawNode(page, 'api');
  await drawEdge(page, 0, 1);
  const B = await boardIdOf(stack, page);
  const [{ id }] = await edgeRows(stack, B);
  const edgeId = Number(id);
  await stack.callReducer(token, 'update_edge_style', [edgeId, { some: 'purple' }, { some: 'dotted' }]);
  await stack.callReducer(token, 'set_edge_weight', [edgeId, 'bold']);
  await page.keyboard.press('Escape');
  await expect(line(page)).toHaveAttribute('marker-end', 'url(#mk-c-purple-bold)');
  const link = await shareBoard(page, 'view');
  await page.keyboard.press('Escape');
  const viewer = await guest();
  await openBoard(viewer, link);
  await expect(line(viewer)).toHaveAttribute('marker-end', 'url(#mk-c-purple-bold)');

  await selectEdge(page);
  await page.keyboard.press('Delete');
  // Gone for the open viewer too, without a reload.
  for (const p of [page, viewer]) {
    await expect(edges(p)).toHaveCount(0);
    await expect(nodes(p)).toHaveCount(2);
  }
  await expect.poll(() => edgeRows(stack, B)).toEqual([]);
  expect(await stack.sql(`SELECT * FROM edge_weight WHERE edge_id = ${edgeId}`)).toEqual([]);
  await saved(page);
  await undo(page);
  for (const p of [page, viewer]) {
    await expect(edges(p)).toHaveCount(1);
    await expect(line(p)).toHaveAttribute('marker-end', 'url(#mk-c-purple-bold)');
    await expect(line(p)).toHaveClass(/\bstroke-dotted\b/);
  }
  const [back] = await edgeRows(stack, B);
  expect(Number(back.id)).not.toBe(edgeId);
  expect(back).toMatchObject({ color: 'purple', stroke_style: 'dotted' });
  expect(await stack.sql(`SELECT weight FROM edge_weight WHERE edge_id = ${back.id}`)).toEqual([{ weight: 'bold' }]);
});

test('an undone edge delete keeps its style when the new edge id equals a node id this tab made', async ({ account, stack }) => {
  // divergent (CV-29): ops.ts captureInsert keeps one claimedIds set for node and edge ids, so the restored edge is never captured and its style is never written back
  test.fail();
  const token = stack.accountToken();
  const page = await account(token);
  await openBoard(page, `${stack.url}?new=1`);
  await drawNode(page, 'web');
  await drawNode(page, 'api');
  await drawEdge(page, 0, 1);
  const B = await boardIdOf(stack, page);
  const [web] = await nodeIds(page);
  const edgeId = Number((await edgeRows(stack, B))[0].id);
  await stack.callReducer(token, 'update_edge_style', [edgeId, some('purple'), some('dotted')]);
  await stack.callReducer(token, 'set_edge_weight', [edgeId, 'bold']);
  await page.keyboard.press('Escape');
  await expect(line(page)).toHaveAttribute('marker-end', 'url(#mk-c-purple-bold)');
  // Edge ids run behind node ids (beforeEach): make edges elsewhere until the next one gets web's id.
  const { edge } = await ids(stack);
  while ((await edge()) < web - 1);

  await selectEdge(page);
  await page.keyboard.press('Delete');
  await expect(edges(page)).toHaveCount(0);
  await saved(page);
  await undo(page);
  await expect(edges(page)).toHaveCount(1);
  test.skip(Number((await edgeRows(stack, B))[0].id) !== web, 'id sequences did not line up');
  await expect(line(page)).toHaveAttribute('marker-end', 'url(#mk-c-purple-bold)');
});
