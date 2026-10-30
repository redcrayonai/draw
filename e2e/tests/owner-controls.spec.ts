import type { Page } from '@playwright/test';
import { test, expect, openBoard, drawNode, shareBoard, boardIdOf, linkedAgent, palette, confirmBoardDelete, guestToken, act, fork, boardLink, type Stack } from '../fixtures';

// Rename and delete are owner-only controls (PR #72, #86, #158): the modal, live propagation,
// refusals in the UI and on the server, branch boards, and what a delete removes.

const NONE = { none: [] };
const SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const HASH = '0123456789abcdef0123456789abcdef';

/** The unfiltered ⌘K list: 'Replay trace' is always there, so it proves the list is filled. */
async function allCommands(page: Page) {
  await palette(page, '');
  const list = page.locator('#palette-list');
  await expect(list).toContainText('Replay trace');
  return list;
}

const title = (page: Page) => page.locator('#board-title');
const nameOf = async (stack: Stack, B: number) => (await stack.sql(`SELECT name FROM board WHERE id = ${B}`))[0]?.name;
const rowsOf = (stack: Stack, table: string, B: number) => stack.sql(`SELECT * FROM ${table} WHERE board_id = ${B}`);

/** Opens the rename modal from the header title. */
async function openRename(page: Page) {
  await title(page).click();
  const dialog = page.locator('#board-rename');
  await expect(dialog.locator('#board-rename-name')).toBeFocused();
  return dialog;
}

async function rename(page: Page, name: string) {
  const dialog = await openRename(page);
  await dialog.locator('#board-rename-name').fill(name);
  await dialog.locator('#board-rename-name').press('Enter');
  await expect(dialog).toHaveCount(0);
}

/** ⌘K Delete this board, then the confirm's delete button. */
async function deleteFromPalette(page: Page) {
  await palette(page, 'delete this board');
  await page.keyboard.press('Enter');
  await confirmBoardDelete(page);
}

async function toBase(page: Page) {
  await page.locator('#branch-chip').click();
  await page.locator('#branch-pop .branch-row').first().click();
  await expect(title(page)).not.toContainText('Branch ·');
}

/** The node labels in the page's row cache, not only what #world shows. */
const cachedLabels = (page: Page) => page.evaluate(() => [...(window as any).conn.db.visibleNode.iter()].map((n: any) => n.label as string));

test('the owner renames from the header title: focus, selection, validation and a trimmed save', async ({ account, stack }) => {
  const owner = await account();
  await openBoard(owner, `${stack.url}?new=1`);
  await drawNode(owner, 'svc');
  const B = await boardIdOf(stack, owner);
  await expect(title(owner)).toHaveClass(/renamable/);

  const dialog = await openRename(owner);
  const input = dialog.locator('#board-rename-name');
  const save = dialog.getByRole('button', { name: 'Rename', exact: true });
  await expect(input).toHaveValue('Untitled board');
  expect(await input.evaluate((el: HTMLInputElement) => el.value.slice(el.selectionStart!, el.selectionEnd!))).toBe('Untitled board');
  await expect(save).toBeDisabled();
  await input.fill('   ');
  await expect(save).toBeDisabled();
  await input.fill('x'.repeat(120));
  await expect(input).toHaveValue('x'.repeat(100));
  await expect(save).toBeEnabled();

  // The modal holds the keyboard: '1' does not arm the node tool, 'l' does not open the library.
  await input.fill('');
  await input.pressSequentially('1l');
  await expect(input).toHaveValue('1l');
  await expect(owner.locator('#library-popover')).toBeHidden();
  await expect(owner.locator('#board')).not.toHaveClass(/armed/);
  // Tab past the last button can leave focus on the body, outside the dialog's own key handler.
  for (let i = 0; i < 3; i++) await owner.keyboard.press('Tab');
  await owner.keyboard.press('1');
  await expect(dialog).toBeVisible();
  await expect(owner.locator('#board')).not.toHaveClass(/armed/);
  await input.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(title(owner)).toHaveText('Untitled board');
  // An armed node tool would place a node here.
  await owner.locator('#board').click({ position: { x: 720, y: 350 } }); // where drawNode would put a second node
  // Drawing b lands after anything that click wrote (one connection, in order): only svc and b exist.
  await drawNode(owner, 'b');
  expect((await stack.sql(`SELECT label FROM node WHERE board_id = ${B}`)).map(r => r.label).sort()).toEqual(['b', 'svc']);

  await openRename(owner);
  await input.fill('Nope');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(title(owner)).toHaveText('Untitled board');
  expect(await nameOf(stack, B)).toBe('Untitled board');

  await rename(owner, '  Payments platform  ');
  await expect(title(owner)).toHaveText('Payments platform');
  expect(await nameOf(stack, B)).toBe('Payments platform');
});

test('the owner sees the Rename board tooltip on the header title', async ({ account, stack }) => {
  // divergent (BL-16): renderCounts overwrites the title attribute with the board counts after syncRenamable (#155 moved the counts there, HS-08)
  test.fail();
  const owner = await account();
  await openBoard(owner, `${stack.url}?new=1`);
  await drawNode(owner, 'svc');
  await expect(title(owner)).toHaveClass(/renamable/);
  await expect(title(owner)).toHaveAttribute('title', 'Rename board');
});

test('⌘K Rename board opens the same modal', async ({ account, stack }) => {
  const owner = await account();
  await openBoard(owner, `${stack.url}?new=1`);
  await drawNode(owner, 'svc');
  await palette(owner, 'rename board');
  await expect(owner.locator('#palette-list')).toContainText('Rename board');
  await owner.keyboard.press('Enter');
  const input = owner.locator('#board-rename-name');
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('Untitled board');
  await input.fill('Via palette');
  await input.press('Enter');
  await expect(owner.locator('#board-rename')).toHaveCount(0);
  await expect(title(owner)).toHaveText('Via palette');
});

test('a rename reaches a second tab and an edit-link editor live, and persists', async ({ account, stack }) => {
  test.setTimeout(90_000);
  const owner = await account();
  await openBoard(owner, `${stack.url}?new=1`);
  await drawNode(owner, 'svc');
  const link = await shareBoard(owner, 'edit');
  await owner.locator('#act-share').click(); // closes the share menu
  const other = await owner.context().newPage();
  await openBoard(other, owner.url());
  const editor = await account();
  await openBoard(editor, link);
  await expect(editor.locator('#world')).toContainText('svc');

  await owner.bringToFront();
  await rename(owner, 'Orders');
  await expect(title(owner)).toHaveText('Orders');
  await expect(title(other)).toHaveText('Orders');
  await expect(title(editor)).toHaveText('Orders');

  const href = owner.url();
  await owner.reload();
  await expect(owner.locator('#canvas-wrap')).toHaveAttribute('aria-busy', 'false');
  await expect(title(owner)).toHaveText('Orders');
  expect(owner.url()).toBe(href);
});

test('only owners rename: link visitors get no control, and the server refuses', async ({ account, guest, stack }) => {
  test.setTimeout(90_000);
  const owner = await account();
  await openBoard(owner, `${stack.url}?new=1`);
  await drawNode(owner, 'svc');
  const B = await boardIdOf(stack, owner);
  const editLink = await shareBoard(owner, 'edit');
  await owner.locator('#act-share').click();
  // The owner's full list has both commands, so their absence below is the access rule.
  const ownerList = await allCommands(owner);
  await expect(ownerList).toContainText('Rename board');
  await expect(ownerList).toContainText('Delete this board');
  await owner.keyboard.press('Escape');
  await expect(owner.locator('#act-share')).toBeVisible();

  const noOwnerControls = async (visitor: Page) => {
    await expect(visitor.locator('#world')).toContainText('svc');
    await expect(title(visitor)).toHaveText(/^Untitled board/);
    await expect(title(visitor)).not.toHaveClass(/renamable/);
    await title(visitor).click();
    await expect(visitor.locator('#board-rename')).toHaveCount(0);
    const list = await allCommands(visitor);
    await expect(list).not.toContainText('Rename board');
    await expect(list).not.toContainText('Delete this board');
    await visitor.keyboard.press('Escape');
    await expect(visitor.locator('#act-share')).toBeHidden();
  };

  const edTok = stack.accountToken();
  const editor = await account(edTok);
  await openBoard(editor, editLink);
  await noOwnerControls(editor);
  await expect(stack.callReducer(edTok, 'rename_board', [B, 'Hijacked'])).rejects.toThrow(`share rule: only an owner of board ${B} can rename it`);
  await expect(stack.callReducer(edTok, 'delete_board', [B])).rejects.toThrow(`share rule: only an owner of board ${B} can delete it`);
  await expect(stack.callReducer(edTok, 'set_link_share', [B, 'edit', 'hijacked-token'])).rejects.toThrow(`share rule: only an owner of board ${B} can share it`);
  expect(await nameOf(stack, B)).toBe('Untitled board');
  expect(await stack.sql(`SELECT id FROM board WHERE id = ${B}`)).toHaveLength(1);

  await owner.bringToFront();
  const viewLink = await shareBoard(owner, 'view');
  const viewer = await guest();
  await openBoard(viewer, viewLink);
  await noOwnerControls(viewer);
  await expect(stack.callReducer(await guestToken(viewer), 'rename_board', [B, 'Hijacked'])).rejects.toThrow(`share rule: only an owner of board ${B} can rename it`);
  expect(await nameOf(stack, B)).toBe('Untitled board');
});

test('branch boards offer no rename or delete, even to the owner', async ({ guest, stack }) => {
  test.setTimeout(90_000);
  const owner = await guest();
  await openBoard(owner, stack.url);
  await drawNode(owner, 'api');
  const base = owner.url();
  await expect(owner.locator('#access-line')).toHaveText('private');
  await palette(owner, 'board');
  await expect(owner.locator('#palette-list')).toContainText('Rename board');
  await expect(owner.locator('#palette-list')).toContainText('Delete this board');
  await owner.keyboard.press('Escape');

  await fork(owner);
  await expect(owner.locator('#access-line')).toBeHidden();
  await expect(title(owner)).not.toHaveClass(/renamable/);
  await title(owner).click();
  await expect(owner.locator('#board-rename')).toHaveCount(0);
  await palette(owner, 'board');
  await expect(owner.locator('#palette-list')).toContainText('Switch to Untitled board'); // the list is filled
  await expect(owner.locator('#palette-list')).not.toContainText('Rename board');
  await owner.keyboard.press('Escape');

  // ⌘K back to the base: in place, same document.
  await owner.evaluate(() => { (window as any).__sameDocument = true; });
  await palette(owner, 'switch');
  await expect(owner.locator('#palette-list .on')).toContainText('Switch to Untitled board');
  await expect(owner.locator('#palette-preview')).toHaveText('base'); // the active row's hint
  await owner.keyboard.press('Enter');
  await expect(title(owner)).toHaveText('Untitled board');
  await expect(owner).toHaveURL(base);
  expect(await owner.evaluate(() => (window as any).__sameDocument)).toBe(true);
  await expect(owner.locator('#access-line')).toHaveText('private');
});

test("a refused rename keeps the modal open with the server's sentence", async ({ account, stack }) => {
  test.setTimeout(90_000);
  const owner = await account();
  await openBoard(owner, `${stack.url}?new=1`);
  await drawNode(owner, 'svc');
  const B = await boardIdOf(stack, owner);
  const other = await owner.context().newPage();
  await openBoard(other, owner.url());

  await owner.bringToFront();
  const dialog = await openRename(owner);
  await other.bringToFront();
  await deleteFromPalette(other);
  await expect.poll(() => stack.sql(`SELECT id FROM board WHERE id = ${B}`)).toEqual([]);

  await owner.bringToFront();
  const input = dialog.locator('#board-rename-name');
  await input.fill('Too late');
  await input.press('Enter');
  await expect(dialog.locator('[role="alert"]')).toHaveText(`board ${B} does not exist`);
  await expect(dialog).toBeVisible();
  await expect(input).toHaveValue('Too late');
  await expect(dialog.getByRole('button', { name: 'Rename', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(owner.locator('#board-unavailable')).toBeVisible();
});

test('a guest owner deletes from ⌘K; a view-link guest is offered nothing, loses the board, and it stays gone', async ({ guest, stack }) => {
  test.setTimeout(120_000);
  const owner = await guest();
  await openBoard(owner, stack.url);
  await drawNode(owner, 'Guest svc');
  const link = await shareBoard(owner, 'view');
  await owner.locator('#act-share').click();
  const boardHref = owner.url();
  const B = await boardIdOf(stack, owner);
  const ownerList = await allCommands(owner);
  await expect(ownerList).toContainText('Delete this board');
  await expect(ownerList).toContainText('Rename board');
  await owner.keyboard.press('Escape');

  const viewer = await guest();
  await openBoard(viewer, link);
  await expect(viewer.locator('#world')).toContainText('Guest svc');
  await expect.poll(() => cachedLabels(viewer)).toEqual(['Guest svc']);
  const viewerList = await allCommands(viewer);
  await expect(viewerList).not.toContainText('Delete this board');
  await expect(viewerList).not.toContainText('Rename board');
  await viewer.keyboard.press('Escape');
  await expect(stack.callReducer(await guestToken(viewer), 'delete_board', [B])).rejects.toThrow(`share rule: only an owner of board ${B} can delete it`);
  expect(await rowsOf(stack, 'link_share', B)).toHaveLength(1);
  expect(await rowsOf(stack, 'link_visit', B)).not.toEqual([]);

  await owner.bringToFront();
  await deleteFromPalette(owner);
  await expect(owner).not.toHaveURL(boardHref);
  await expect(owner.locator('#canvas-wrap')).toHaveAttribute('aria-busy', 'false');
  await expect(title(owner)).toHaveText('Untitled board');
  await expect(owner.locator('#world g.node')).toHaveCount(0);
  await expect(owner).toHaveURL(/#b=/);
  const fresh = owner.url();
  expect(await stack.sql(`SELECT id FROM board WHERE id = ${B}`)).toEqual([]);

  // The open viewer: the link copy, and the rows left its cache (BL-44).
  await expect(viewer.getByRole('heading', { name: 'This board is unavailable' })).toBeVisible();
  await expect(viewer.locator('#board-unavailable')).toContainText('This link is no longer shared. Ask the owner for a new link.');
  await expect.poll(() => cachedLabels(viewer)).toEqual([]);
  expect(await rowsOf(stack, 'link_share', B)).toEqual([]);
  expect(await rowsOf(stack, 'link_visit', B)).toEqual([]);
  const reopened = await viewer.context().newPage();
  await reopened.goto(link);
  await expect(reopened.getByText('This link is no longer shared.', { exact: false })).toBeVisible();

  // The deleted board's own link stays dead; the root resumes the fresh board.
  const again = await owner.context().newPage();
  await again.goto(boardHref);
  await expect(again.getByRole('heading', { name: 'This board is unavailable' })).toBeVisible();
  await expect(again.locator('#world g.node')).toHaveCount(0);
  await again.close();
  await openBoard(owner, stack.url);
  await expect(owner).toHaveURL(fresh);
  expect(await boardIdOf(stack, owner)).not.toBe(B);
});

test('deleting a board removes its agent grants, code rows and presence', async ({ account, stack }) => {
  test.setTimeout(120_000);
  const token = stack.accountToken();
  // A session board (start_session, as code-tracking.spec.ts) so the session row is there to remove too.
  const name = `e2e-session-${Date.now()}`;
  await stack.callReducer(token, 'start_session', [name, '/tmp/e2e-repo', SHA]);
  const B = Number((await stack.sql(`SELECT id FROM board WHERE name = '${name}'`))[0].id);
  const nodeAs = (who: string, label: string, x: number) => stack.callReducer(who, 'create_node', [B, label, '', x, 240, 160, 80, 'ink', false, NONE, NONE, NONE, NONE, NONE, NONE, NONE]);
  await nodeAs(token, 'a', 200);
  await nodeAs(token, 'b', 520);
  const idOf = async (label: string) => Number((await stack.sql(`SELECT id FROM node WHERE board_id = ${B} AND label = '${label}'`))[0].id);
  const [a, b] = [await idOf('a'), await idOf('b')];
  const agent = await linkedAgent(stack, token, B);
  await nodeAs(agent.token, 'from agent', 840); // the grant works before the delete
  const owner = await account(token);
  await openBoard(owner, await boardLink(stack, B));
  await expect(owner.locator('#world')).toContainText('from agent');

  await stack.callReducer(token, 'add_repo_files', [B, ['src/a.ts']]);
  await stack.callReducer(token, 'add_code_ref', [B, 'node', a, 'src/a.ts', 'verify', 1, 1, SHA, '', 'e2e']);
  const [ref] = await rowsOf(stack, 'code_ref', B);
  await stack.callReducer(token, 'set_code_ref_hashes', [ref.id, HASH]);
  await stack.callReducer(token, 'create_edge', [B, a, b, 'calls', 'source:src/a.ts:3', NONE, NONE, { some: 'ok' }]);
  const [edge] = await rowsOf(stack, 'edge', B);
  await stack.callReducer(token, 'set_edge_evidence_code', [edge.id, HASH, NONE]);
  await stack.callReducer(token, 'set_session_remote', [B, 'git@github.com:example/repo.git', SHA, ['src/a.ts']]);

  const link = await shareBoard(owner, 'edit');
  await owner.locator('#act-share').click();
  const visitor = await account();
  await openBoard(visitor, link);
  await expect(visitor.locator('#world')).toContainText('from agent');
  const vhex = await visitor.evaluate(() => (window as any).conn.identity.toHexString() as string);
  await visitor.mouse.move(600, 400);
  await visitor.mouse.move(640, 420);
  await visitor.locator(`#world g[data-id="${a}"] .node-rect`).click({ position: { x: 12, y: 12 } });
  await expect.poll(async () => (await stack.sql(`SELECT * FROM cursor WHERE identity = 0x${vhex} AND board_id = ${B}`)).length).toBe(1);
  await expect.poll(async () => (await stack.sql(`SELECT * FROM selection WHERE identity = 0x${vhex} AND board_id = ${B}`)).length).toBe(1);

  const tables = ['agent_grant', 'code_ref', 'code_ref_hash', 'edge_evidence_hash', 'session', 'session_remote', 'repo_file', 'edge', 'cursor', 'selection'];
  for (const table of tables) expect(await rowsOf(stack, table, B), table).not.toEqual([]);

  await owner.bringToFront();
  await deleteFromPalette(owner);
  await expect.poll(() => stack.sql(`SELECT id FROM board WHERE id = ${B}`)).toEqual([]);
  await expect(visitor.getByRole('heading', { name: 'This board is unavailable' })).toBeVisible();
  for (const table of tables) expect(await rowsOf(stack, table, B), table).toEqual([]);
  const open = await stack.sql('SELECT board_ids FROM open_board');
  expect(open.flatMap(row => (row.board_ids as unknown[]).map(Number))).not.toContain(B);
  await expect(nodeAs(agent.token, 'after delete', 1160)).rejects.toThrow(`board ${B} does not exist`);
});

test('a base with an open branch cannot be deleted until the branch is merged', async ({ account, stack }) => {
  test.setTimeout(120_000);
  const token = stack.accountToken();
  const owner = await account(token);
  await openBoard(owner, `${stack.url}?new=1`);
  await drawNode(owner, 'api');
  const B = await boardIdOf(stack, owner);
  const OPEN = 'delete rule: this board has open branches; merge or delete them first';
  await fork(owner, 'open');
  await toBase(owner);

  await deleteFromPalette(owner);
  await expect(owner.locator('#error-text')).toHaveText(OPEN);
  await expect(owner.locator('#board-delete')).toHaveCount(0);
  await expect(owner.locator('#world')).toContainText('api');
  expect(await stack.sql(`SELECT id FROM board WHERE id = ${B}`)).toHaveLength(1);

  await owner.locator('#branch-chip').click();
  await owner.locator('#branch-pop .branch-row').nth(1).click();
  await expect(title(owner)).toHaveText('Branch · open');
  await drawNode(owner, 'q');
  // Submitted and accepted branches are still open (BR-51): the owner's own call is refused.
  await act(owner, 'submit', 'In review');
  await expect(stack.callReducer(token, 'delete_board', [B])).rejects.toThrow(OPEN);
  await act(owner, 'accept', 'Accepted');
  await expect(stack.callReducer(token, 'delete_board', [B])).rejects.toThrow(OPEN);
  await act(owner, 'merge', 'Merged');

  await toBase(owner);
  await deleteFromPalette(owner);
  await expect.poll(() => stack.sql(`SELECT id FROM board WHERE id = ${B}`)).toEqual([]);
});

test('the owner deletes a branch that has served its purpose', async ({ account, stack }) => {
  // divergent (BR-52): ⌘K offers Delete this board only off versioned boards, and no other surface deletes a plain-base branch
  test.fail();
  test.setTimeout(90_000);
  const owner = await account();
  await openBoard(owner, `${stack.url}?new=1`);
  await drawNode(owner, 'api');
  const base = owner.url();
  const B = await boardIdOf(stack, owner);
  await fork(owner, 'scrap');
  // The open_board row follows the switch a moment later.
  await expect.poll(() => boardIdOf(stack, owner)).not.toBe(B);
  const branch = await boardIdOf(stack, owner);
  await palette(owner, 'delete this board');
  await expect(owner.locator('#palette-list')).toContainText('Delete this board');
  await owner.keyboard.press('Enter');
  await confirmBoardDelete(owner);
  await expect.poll(() => stack.sql(`SELECT id FROM board WHERE id = ${branch}`)).toEqual([]);

  // A fresh document: base differs from the branch URL only by its #hash.
  await owner.goto('about:blank');
  await openBoard(owner, base);
  await deleteFromPalette(owner);
  await expect.poll(() => stack.sql(`SELECT id FROM board WHERE id = ${B}`)).toEqual([]);
});
