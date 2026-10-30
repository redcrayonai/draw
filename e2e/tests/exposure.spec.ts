import { test, expect, openBoard, drawNode, drawEdge, shareBoard, boardIdOf, guestToken, marker, settledBox, type Stack } from '../fixtures';
import type { Page } from '@playwright/test';

// What a share link exposes (threats, code) and who may see and contain threats.

const SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const SNIPPET = 'export function verify() {}';
const NONE = { none: [] };
const MEMBERS_RULE = 'only board members can see or change threats';
const wide = { viewport: { width: 1440, height: 900 } };

/** A new board on this page: auth-svc and users-db, joined by an edge unless edge is false. */
async function board(page: Page, stack: Stack, edge = true) {
  await openBoard(page, `${stack.url}?new=1`);
  await drawNode(page, 'auth-svc');
  await drawNode(page, 'users-db');
  if (edge) await drawEdge(page, 0, 1);
  const ids = await page.locator('#world g.node').evaluateAll(nodes => nodes.map(node => Number(node.getAttribute('data-id'))));
  return { B: await boardIdOf(stack, page), ids };
}

const addThreat = (stack: Stack, token: string, B: number, anchor: number) => stack.callReducer(token, 'add_threat', [
  B, anchor, 'compromised', 'critical', 'Forged session tokens', 'jsonwebtoken lets anyone forge tokens.', '', '', '', '[]', '', 'e2e',
]);

/** A threat and a code ref on auth-svc. */
async function seed(page: Page, stack: Stack, token: string, B: number, ids: number[]) {
  await addThreat(stack, token, B, ids[0]);
  await stack.callReducer(token, 'set_code_consent', [true]); // the board keeps the snippet (RC-690)
  await stack.callReducer(token, 'add_repo_files', [B, ['src/auth.ts']]);
  await stack.callReducer(token, 'add_code_ref', [B, 'node', ids[0], 'src/auth.ts', 'verify', 1, 1, SHA, SNIPPET, 'e2e']);
  await expect(marker(page)).toHaveCount(1);
}

/** Owner's board: two nodes, an edge, a threat and a code ref on auth-svc. */
async function sensitiveBoard(page: Page, stack: Stack, token: string) {
  const { B, ids } = await board(page, stack);
  await seed(page, stack, token, B, ids);
  return B;
}

/** Selects auth-svc and returns the inspector, which lists its code refs when the reader may see them. */
async function inspect(page: Page) {
  await page.locator('#world g.node', { hasText: 'auth-svc' }).locator('.node-rect').click();
  const inspector = page.locator('#inspector');
  await expect(inspector).toContainText('auth-svc');
  return inspector;
}

/** Clicks the middle of the first edge; the inspector then shows its citation. */
async function selectEdge(page: Page) {
  // Clear the selection first: the node toolbar can sit over the edge's middle.
  await page.keyboard.press('Escape');
  await expect(page.locator('#toolbar')).toBeHidden();
  const hit = page.locator('#world g.edge .edge-hit').first();
  // A reveal pan can still be gliding the board: aim once the edge has stopped moving.
  await settledBox(hit);
  const point = await hit.evaluate(el => {
    const path = el as SVGPathElement;
    const at = path.getPointAtLength(path.getTotalLength() / 2);
    const m = path.getScreenCTM()!;
    return { x: at.x * m.a + at.y * m.c + m.e, y: at.x * m.b + at.y * m.d + m.f };
  });
  await page.mouse.click(point.x, point.y);
  await expect(page.locator('#inspector .insp-cite')).toBeVisible();
}

/** ⌘K filtered to the threat commands; the open threat always offers 'Close threat'. */
async function threatCommands(page: Page) {
  await page.keyboard.press('Meta+k');
  await page.locator('#palette-input').fill('threat');
  const list = page.locator('#palette-list');
  await expect(list).toContainText('Close threat');
  return list;
}

const threatId = async (stack: Stack, B: number) => Number((await stack.sql(`SELECT id FROM threat WHERE board_id = ${B}`))[0].id);

test('the owner\'s ticked includes survive a reload, and a re-shared link starts with none', async ({ account, guest, stack }) => {
  test.setTimeout(90_000);
  const token = stack.accountToken();
  const page = await account(token, wide);
  const B = await sensitiveBoard(page, stack, token);
  const link = await shareBoard(page, 'view');
  const threats = page.locator('#share-threats'), code = page.locator('#share-code');
  await threats.check();
  await code.check();
  const viewer = await guest(wide);
  await openBoard(viewer, link);
  await expect(marker(viewer)).toHaveCount(1);
  await expect(await inspect(viewer)).toContainText('verify');
  const includes = () => stack.sql(`SELECT include_threats, include_code FROM link_share WHERE board_id = ${B}`);
  await expect.poll(includes).toEqual([{ include_threats: true, include_code: true }]);

  // The ticked choice is what the module holds, so a reload keeps it.
  await page.reload();
  await expect(page.locator('#canvas-wrap')).toHaveAttribute('aria-busy', 'false');
  await page.locator('#act-share').click();
  await expect(threats).toBeChecked();
  await expect(code).toBeChecked();
  await expect(marker(viewer)).toHaveCount(1);

  // Stop and share again: a new link with both boxes off.
  const on = page.getByRole('switch', { name: 'Share with link' });
  await on.uncheck();
  await expect(page.locator('#share-url')).toHaveValue('');
  await on.check();
  await expect(page.locator('#share-url')).not.toHaveValue('');
  const fresh = await page.locator('#share-url').inputValue();
  expect(fresh).not.toBe(link);
  await expect(threats).not.toBeChecked();
  await expect(code).not.toBeChecked();
  expect(await includes()).toEqual([{ include_threats: false, include_code: false }]);
  const v = await guest(wide);
  await openBoard(v, fresh);
  await expect(v.locator('#world')).toContainText('auth-svc');
  await expect(marker(v)).toHaveCount(0);
  await expect(await inspect(v)).not.toContainText('verify');
  // Threats load in their own subscription: ticking one box shows it is live here, and code stays out.
  await threats.check();
  await expect(marker(v)).toHaveCount(1);
  await expect(await inspect(v)).not.toContainText('verify');
});

test('a view link without Code shows a citation\'s location but not its captured line', async ({ account, guest, stack }) => {
  test.setTimeout(90_000);
  const token = stack.accountToken();
  const page = await account(token, wide);
  const { B, ids } = await board(page, stack, false);
  await stack.callReducer(token, 'set_code_consent', [true]);
  await stack.callReducer(token, 'add_repo_files', [B, ['src/auth.ts']]);
  // The captured line shows only through the stale note's wording.
  await stack.callReducer(token, 'create_edge', [B, ids[0], ids[1], '', 'source:src/auth.ts:1', NONE, { some: SNIPPET }, { some: 'stale' }]);
  await expect(page.locator('#world g.edge')).toHaveCount(1);
  await selectEdge(page);
  await expect(page.locator('#inspector .insp-ref-note')).toContainText('could not be re-anchored');

  const link = await shareBoard(page, 'view');
  const viewer = await guest(wide);
  await openBoard(viewer, link);
  await expect(viewer.locator('#world g.edge')).toHaveCount(1);
  await selectEdge(viewer);
  await expect(viewer.locator('#inspector .insp-cite')).toContainText('src/auth.ts');
  const note = viewer.locator('#inspector .insp-ref-note');
  await expect(note).toContainText('has no captured source line');

  await page.locator('#share-code').check();
  await expect(note).toContainText('could not be re-anchored');
});

test('the owner\'s exposure chip says what exists and what the link shows', async ({ account, stack }) => {
  test.setTimeout(90_000);
  const token = stack.accountToken();
  const page = await account(token, wide);
  const { B, ids } = await board(page, stack);
  const chip = page.locator('#exposure-chip'), pop = page.locator('#share-pop');
  // Nothing to expose yet: no chip text and no label.
  await expect(chip).toBeEmpty();
  await expect(chip).not.toHaveAttribute('aria-label');
  await seed(page, stack, token, B, ids);
  await expect(chip).toHaveAttribute('data-state', 'private');
  await expect(chip).toContainText('1 code ref');
  await expect(chip).toContainText('1 threat');
  await expect(chip).toHaveAttribute('aria-label', '1 code ref and 1 threat on this board. Not shared. Click to change what the link shows.');
  await expect(chip).toBeEnabled();

  // No link yet: the chip opens on the switch, and Escape hands focus back to the chip.
  await chip.click();
  await expect(pop).toBeVisible();
  await expect(page.locator('#share-on')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(pop).toBeHidden();
  await expect(chip).toBeFocused();

  await shareBoard(page, 'view');
  await expect(chip).toHaveAttribute('data-state', 'kept');
  await expect(chip).toHaveText(/^Link hides\s*1 code ref\s*·\s*1 threat$/);
  await page.keyboard.press('Escape');
  await expect(pop).toBeHidden();

  // With a link on, the chip opens on the include boxes, each with its count.
  await chip.click();
  await expect(pop).toBeVisible();
  await expect(page.locator('#share-threats')).toBeFocused();
  await expect(chip).toHaveAttribute('aria-expanded', 'true');
  for (const id of ['#share-threats', '#share-code']) {
    await expect(page.locator('label.share-check', { has: page.locator(id) }).locator('.share-count')).toHaveText('1');
  }

  await page.locator('#share-threats').check();
  await expect(chip).toHaveAttribute('data-state', 'out');
  await expect(chip).toContainText('Link shows');
  await expect(chip).toContainText('1 threat');
  await expect(chip).not.toContainText('code ref');
  await expect(chip).toHaveAttribute('aria-label', 'Anyone with the link sees 1 threat. 1 code ref stays private. Click to change what the link shows.');
  // An edit link always carries code.
  await page.getByRole('button', { name: 'Can edit', exact: true }).click();
  await expect(chip).toContainText('1 code ref');
  await chip.click();
  await expect(pop).toBeHidden();
  await expect(chip).toHaveAttribute('aria-expanded', 'false');
});

test('a link visitor\'s chip shows only what the link carries', async ({ account, guest, stack }) => {
  test.setTimeout(90_000);
  const token = stack.accountToken();
  const page = await account(token, wide);
  await sensitiveBoard(page, stack, token);
  const link = await shareBoard(page, 'view');
  const viewer = await guest(wide);
  await openBoard(viewer, link);
  await expect(viewer.locator('#world')).toContainText('auth-svc');
  const chip = viewer.locator('#exposure-chip');
  // Disabled is set by the visitor's own render, so the chip has drawn.
  await expect(chip).toBeDisabled();
  await expect(chip).toBeEmpty();

  // Threats arrive in their own subscription: seeing them here proves it is live before code is checked alone.
  await page.locator('#share-threats').check();
  await expect(chip).toHaveText('1 threat');
  await expect(chip).toHaveAttribute('aria-label', '1 threat on this board.');
  await page.locator('#share-threats').uncheck();
  await expect(chip).toBeEmpty();
  await page.locator('#share-code').check();
  await expect(chip).toHaveText('1 code ref');
  await expect(chip).toHaveAttribute('aria-label', '1 code ref on this board.');
  await expect(chip).toBeDisabled();
});

test('a member marks a threat contained and reopens it, live in every tab and after reload', async ({ account, stack }) => {
  test.setTimeout(90_000);
  const token = stack.accountToken();
  const a = await account(token, wide);
  const { B, ids } = await board(a, stack);
  await addThreat(stack, token, B, ids[0]);
  await expect(marker(a)).toHaveCount(1);
  const b = await account(token, wide);
  await openBoard(b, a.url());
  await expect(marker(b)).toHaveClass(/tone-red/);
  await expect(marker(b)).toHaveClass(/pulse/);

  // The open threat is this tab's own state.
  await marker(a).click();
  const card = a.locator('#inspector .tc');
  await expect(card).toBeVisible();
  await expect(a.locator('#world')).toHaveClass(/blast-on/);
  await expect(b.locator('#world')).not.toHaveClass(/blast-on/);
  await expect(b.locator('#inspector .tc')).toHaveCount(0);

  const contain = card.locator('.tc-contain');
  await expect(contain).toHaveText('Mark contained');
  await contain.click();
  await expect(card.locator('.tc-contained')).toContainText('contained by');
  await expect(card).toContainText('compromised, contained');
  await expect(contain).toHaveText('Reopen');
  await expect(marker(b)).toHaveClass(/tone-muted/);
  await expect(marker(b)).not.toHaveClass(/pulse/);
  await expect(marker(b)).toHaveAttribute('aria-label', /contained$/);
  // B has now applied a change made after A opened the threat, and still shows it closed.
  await expect(b.locator('#world')).not.toHaveClass(/blast-on/);
  await expect(b.locator('#inspector .tc')).toHaveCount(0);
  await b.reload();
  await expect(b.locator('#canvas-wrap')).toHaveAttribute('aria-busy', 'false');
  await expect(marker(b)).toHaveClass(/tone-muted/);

  await contain.click();
  await expect(contain).toHaveText('Mark contained');
  await expect(marker(b)).toHaveClass(/tone-red/);
  await expect(marker(b)).toHaveClass(/pulse/);
  expect(await stack.sql(`SELECT contained_by FROM threat WHERE board_id = ${B}`)).toEqual([{ contained_by: '' }]);
  // A member is offered the same action in ⌘K.
  await expect(await threatCommands(a)).toContainText('Mark threat contained');
  await a.keyboard.press('Escape');

  await a.reload();
  await expect(a.locator('#canvas-wrap')).toHaveAttribute('aria-busy', 'false');
  await expect(marker(a)).toHaveCount(1);
  await expect(a.locator('#world')).not.toHaveClass(/blast-on/);
  await expect(a.locator('#inspector .tc')).toHaveCount(0);
});

test('Mark contained is not offered to a guest owner or a view-link visitor', async ({ account, guest, stack }) => {
  test.setTimeout(90_000);
  const token = stack.accountToken();
  const owner = await account(token, wide);
  const { B, ids } = await board(owner, stack, false);
  await addThreat(stack, token, B, ids[0]);
  await expect(marker(owner)).toHaveCount(1);
  const link = await shareBoard(owner, 'view');
  await owner.locator('#share-threats').check();

  const visitorToken = stack.accountToken();
  const visitor = await account(visitorToken, wide);
  await openBoard(visitor, link);
  await marker(visitor).click();
  await expect(visitor.locator('#inspector .tc')).toBeVisible();
  await expect(visitor.locator('#inspector .tc-contain')).toHaveCount(0);
  await expect(await threatCommands(visitor)).not.toContainText('Mark threat contained');
  await expect(stack.callReducer(visitorToken, 'set_threat_contained', [await threatId(stack, B), true])).rejects.toThrow('not authorized: board is read only');

  // A guest owns its board and may note threats on it, but containing needs a signed-in person.
  const g = await guest(wide);
  await openBoard(g, stack.url);
  await drawNode(g, 'edge-vm');
  const gB = await boardIdOf(stack, g);
  const gToken = await guestToken(g);
  await addThreat(stack, gToken, gB, Number(await g.locator('#world g.node').first().getAttribute('data-id')));
  await marker(g).click();
  await expect(g.locator('#inspector .tc')).toBeVisible();
  await expect(g.locator('#inspector .tc-contain')).toHaveCount(0);
  await expect(await threatCommands(g)).not.toContainText('Mark threat contained');
  await expect(stack.callReducer(gToken, 'set_threat_contained', [await threatId(stack, gB), true])).rejects.toThrow('only a signed-in person with edit access can contain a threat');
});

test('an edit-link visitor with Threats included is not offered contain', async ({ account, stack }) => {
  // divergent (TF-20): main offers Mark contained to a signed-in edit-link visitor (panel and ⌘K), then the module refuses it
  test.fail();
  test.setTimeout(90_000);
  const token = stack.accountToken();
  const owner = await account(token, wide);
  const { B, ids } = await board(owner, stack, false);
  await addThreat(stack, token, B, ids[0]);
  const link = await shareBoard(owner, 'edit');
  await owner.locator('#share-threats').check();

  const editorToken = stack.accountToken();
  const editor = await account(editorToken, wide);
  await openBoard(editor, link);
  await expect(marker(editor)).toHaveCount(1);
  await marker(editor).click();
  await expect(editor.locator('#inspector .tc')).toBeVisible();
  await expect(stack.callReducer(editorToken, 'set_threat_contained', [await threatId(stack, B), true])).rejects.toThrow(MEMBERS_RULE);
  await expect(editor.locator('#inspector .tc-contain')).toHaveCount(0);
  await expect(await threatCommands(editor)).not.toContainText('Mark threat contained');
});

test('an edit link shows no threats unless included, and the server refuses threat writes from its editor', async ({ account, stack }) => {
  test.setTimeout(90_000);
  const token = stack.accountToken();
  const owner = await account(token, wide);
  const { B, ids } = await board(owner, stack, false);
  await addThreat(stack, token, B, ids[0]);
  await expect(marker(owner)).toHaveCount(1);
  const link = await shareBoard(owner, 'edit');

  const editorToken = stack.accountToken();
  const editor = await account(editorToken, wide);
  await openBoard(editor, link);
  await expect(editor.locator('#world')).toContainText('users-db');
  await expect(marker(editor)).toHaveCount(0);

  // Edit access to the board is not access to its threats.
  await expect(stack.callReducer(editorToken, 'add_threat', [B, ids[1], 'compromised', 'high', 't', 's', '', '', '', '[]', '', 'e2e'])).rejects.toThrow(MEMBERS_RULE);
  const id = await threatId(stack, B);
  await expect(stack.callReducer(editorToken, 'update_threat', [id, NONE, NONE, { some: 'renamed' }, NONE, NONE, NONE, NONE, NONE, NONE])).rejects.toThrow(MEMBERS_RULE);
  await expect(stack.callReducer(editorToken, 'remove_threat', [id])).rejects.toThrow(MEMBERS_RULE);
  expect((await stack.sql(`SELECT anchor_id, title FROM threat WHERE board_id = ${B}`)).map(row => [Number(row.anchor_id), row.title])).toEqual([[ids[0], 'Forged session tokens']]);
  await expect(marker(owner)).toHaveCount(1);
  await expect(marker(editor)).toHaveCount(0);

  // Including Threats is what shows them.
  await owner.locator('#share-threats').check();
  await expect(marker(editor)).toHaveCount(1);
});

test('branching a board copies the drawing but not its threats', async ({ account, stack }) => {
  test.setTimeout(90_000);
  const token = stack.accountToken();
  const page = await account(token, wide);
  const { B, ids } = await board(page, stack);
  await addThreat(stack, token, B, ids[0]);
  await expect(marker(page)).toHaveCount(1);
  const base = page.url();

  await page.locator('#branch-chip').click();
  await page.locator('#branch-pop .branch-new').click();
  await page.locator('#branch-create-name').fill('no-threats');
  await page.locator('#branch-create button[type="submit"]').click();
  await expect.poll(() => page.url()).not.toBe(base);
  await expect(page.locator('#board-title')).toHaveText('Branch · no-threats');
  await expect(page.locator('#world g.node')).toHaveCount(2);
  await expect(page.locator('#world g.edge')).toHaveCount(1);
  await expect(marker(page)).toHaveCount(0);
  await expect.poll(() => boardIdOf(stack, page)).not.toBe(B);
  const branch = await boardIdOf(stack, page);
  expect(await stack.sql(`SELECT id FROM node WHERE board_id = ${branch}`)).toHaveLength(2);
  expect(await stack.sql(`SELECT id FROM threat WHERE board_id = ${branch}`)).toEqual([]);

  await page.locator('#branch-chip').click();
  await page.locator('#branch-pop .branch-row').first().click();
  await expect(page.locator('#board-title')).not.toContainText('Branch ·');
  await expect(marker(page)).toHaveCount(1);
});
