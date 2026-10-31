import { test, expect, openBoard, drawNode, shareBoard, boardIdOf, nodes, type Stack } from '../fixtures';
import type { Locator, Page } from '@playwright/test';

const nodeRect = (page: Page, i: number) => nodes(page).nth(i).locator('.node-rect');
const cursors = (page: Page) => page.locator('#presence > g');
const outlines = (page: Page) => page.locator('#presence > rect[stroke-dasharray="2 3"]');
const chips = (page: Page) => page.locator('#participant-chips .p-chip');
const chip = (page: Page, name: string) => page.locator(`#participant-chips .p-chip[aria-label="${name}"]`);
const hexOf = (page: Page) => page.evaluate(() => (window as any).myIdentityHex as string);
const guestName = (hex: string) => `human-${hex.slice(0, 6)}`;
const rowsOf = (stack: Stack, table: 'cursor' | 'selection', hex: string) => stack.sql(`SELECT * FROM ${table} WHERE identity = 0x${hex}`);
/** hex's row in this page's client cache (its board and selected node count), so "not drawn" checks run on loaded data. */
const cachedRow = (page: Page, table: 'visibleCursor' | 'visibleSelection', hex: string) => page.evaluate(([t, h]) => {
  const row = [...(window as any).conn.db[t].iter()].find((r: any) => r.identity.toHexString() === h);
  return row ? { board: Number(row.boardId), nodes: row.nodeIds?.length } : null;
}, [table, hex] as const);

// client/src/presence.ts identityColor: one of six colours, picked from the identity.
const PALETTE = ['#2563EB', '#0D9488', '#9333EA', '#DB2777', '#D97706', '#475569'];
function identityColor(hex: string) {
  let h = 0;
  for (const c of hex) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

/** A guest owner's board with these nodes, shared with a link. */
async function sharedBoard(guest: () => Promise<Page>, stack: Stack, labels: string[], mode: 'view' | 'edit' = 'edit') {
  const owner = await guest();
  await openBoard(owner, stack.url);
  for (const label of labels) await drawNode(owner, label);
  const link = await shareBoard(owner, mode);
  await owner.keyboard.press('Escape');
  return { owner, link };
}

/** Polls until the cursor's tip (its box's top-left) lies inside the target's box. */
async function expectTipInside(cursor: Locator, target: Locator) {
  await expect.poll(async () => {
    const [tip, box] = await Promise.all([cursor.boundingBox(), target.boundingBox()]);
    return !!tip && !!box && tip.x >= box.x && tip.x <= box.x + box.width && tip.y >= box.y && tip.y <= box.y + box.height;
  }).toBe(true);
}

/** A full load of href, even when only the hash differs from the page's address (same-document otherwise). */
async function openFresh(page: Page, href: string) {
  await page.goto('about:blank');
  await openBoard(page, href);
}

async function reloaded(page: Page) {
  await page.reload();
  await expect(page.locator('#canvas-wrap')).toHaveAttribute('aria-busy', 'false');
}

test('the reader is always listed under their own name', async ({ guest, account, stack }) => {
  test.setTimeout(90_000);
  const reader = await guest();
  await openBoard(reader, stack.url);
  const hex = await hexOf(reader);
  await expect(chips(reader)).toHaveCount(1);
  await expect(chip(reader, guestName(hex))).toHaveText('H');
  await reader.locator('#participants-label').click();
  await expect(reader.locator('#presence-pop .pp-count')).toHaveText('1');
  await expect(reader.locator('#presence-pop .pp-name')).toHaveText(guestName(hex));
  await reader.keyboard.press('Escape');

  const owner = await account();
  await openBoard(owner, `${stack.url}?new=1`);
  await expect(chips(owner)).toHaveCount(1);
  await expect(chip(owner, 'Test account')).toHaveText('T');

  // PR-03: the same names reach the other browser, on the chip and the cursor tag.
  await drawNode(owner, 'Payments');
  const link = await shareBoard(owner, 'view');
  await owner.keyboard.press('Escape');
  await openFresh(reader, link);
  await nodes(reader).first().hover();
  await expect(chip(owner, guestName(hex))).toHaveText('H');
  await expect(cursors(owner)).toHaveText(guestName(hex));
  await owner.locator('#participants-label').click();
  await expect.poll(async () => (await owner.locator('#presence-pop .pp-name').allTextContents()).sort()).toEqual([guestName(hex), 'Test account'].sort());
  await owner.keyboard.press('Escape');
  await nodes(owner).first().hover();
  await expect(cursors(reader)).toHaveText('Test account');
  await expect(chip(reader, 'Test account')).toHaveText('T');
});

test('a remote cursor with its name follows the pointer live, in the identity\'s colour', async ({ guest, account, stack }) => {
  test.setTimeout(90_000);
  const { owner, link } = await sharedBoard(guest, stack, ['Payments', 'Ledger']);
  const ownerHex = await hexOf(owner);
  // Drawing wrote the owner's cursor row and its canvas has it; its own browser never draws it.
  await expect.poll(() => cachedRow(owner, 'visibleCursor', ownerHex)).not.toBeNull();
  await expect(cursors(owner)).toHaveCount(0);

  const visitor = await account();
  await openBoard(visitor, link);
  const vhex = await hexOf(visitor);
  await nodes(visitor).nth(0).hover();
  await expect(cursors(owner)).toHaveCount(1);
  await expect(cursors(owner)).toHaveText('Test account');
  await expectTipInside(cursors(owner), nodeRect(owner, 0));
  await nodes(visitor).nth(1).hover();
  await expectTipInside(cursors(owner), nodeRect(owner, 1));
  // The visitor draws the owner's cursor, never its own (which its canvas holds).
  await expect.poll(() => cachedRow(visitor, 'visibleCursor', vhex)).not.toBeNull();
  await expect(cursors(visitor)).toHaveCount(1);
  await expect(cursors(visitor)).toHaveText(guestName(ownerHex));

  // PR-04: the arrow and the outline share the identity's colour, before and after a reload.
  for (const pass of ['first', 'after reload']) {
    if (pass === 'after reload') {
      // The reload clears both rows, so the colours below are drawn afresh.
      await visitor.mouse.move(0, 0);
      await reloaded(visitor);
      await expect(cursors(owner)).toHaveCount(0);
      await expect(outlines(owner)).toHaveCount(0);
    }
    await nodes(visitor).nth(0).click();
    await expect(owner.locator('#presence > g path')).toHaveAttribute('fill', identityColor(vhex));
    await expect(outlines(owner)).toHaveAttribute('stroke', identityColor(vhex));
  }
});

test('a remote selection draws a dashed outline, and the popover reports it live', async ({ guest, account, stack }) => {
  test.setTimeout(90_000);
  const { owner, link } = await sharedBoard(guest, stack, ['Payments', 'Ledger']);
  const ownerHex = await hexOf(owner);
  const visitor = await account();
  await openBoard(visitor, link);
  await owner.locator('#participants-label').click();
  const row = owner.locator('#presence-pop .pp-row', { has: owner.locator('.pp-name', { hasText: 'Test account' }) });

  await nodes(visitor).nth(0).click();
  await expect(outlines(owner)).toHaveCount(1);
  const [ring, rect] = await Promise.all([outlines(owner).boundingBox(), nodeRect(owner, 0).boundingBox()]);
  expect(ring!.x).toBeLessThan(rect!.x);
  expect(ring!.y).toBeLessThan(rect!.y);
  expect(ring!.x + ring!.width).toBeGreaterThan(rect!.x + rect!.width);
  expect(ring!.y + ring!.height).toBeGreaterThan(rect!.y + rect!.height);
  await expect(row.locator('.pp-status')).toHaveText(/^joined \d+s ago · selecting Payments$/);

  await visitor.keyboard.down('Shift');
  await nodes(visitor).nth(1).click();
  await visitor.keyboard.up('Shift');
  await expect(outlines(owner)).toHaveCount(2);
  await expect(row.locator('.pp-status')).toHaveText(/^joined \d+s ago · selecting 2 nodes$/);

  await visitor.keyboard.press('Escape');
  await expect(outlines(owner)).toHaveCount(0);
  await expect(row.locator('.pp-status')).toHaveText(/^joined \d+s ago$/);
  await expect(owner.locator('#presence-pop')).toBeVisible();

  // The owner's own selection reaches the visitor, never its own presence layer.
  await owner.keyboard.press('Escape');
  await nodes(owner).nth(0).click();
  await owner.keyboard.down('Shift');
  await nodes(owner).nth(1).click();
  await owner.keyboard.up('Shift');
  await expect(outlines(visitor)).toHaveCount(2);
  await expect.poll(async () => ((await rowsOf(stack, 'selection', ownerHex))[0]?.node_ids as unknown[] | undefined)?.length).toBe(2);
  await expect.poll(async () => (await cachedRow(owner, 'visibleSelection', ownerHex))?.nodes).toBe(2);
  await expect(outlines(owner)).toHaveCount(0);
});

test('the list shows only people present on this board, and the popover lists them', async ({ guest, account, stack }) => {
  test.setTimeout(90_000);
  const { owner, link } = await sharedBoard(guest, stack, ['Payments']);
  const ownerHex = await hexOf(owner);
  const visitor = await account();
  await openBoard(visitor, link);
  const vhex = await hexOf(visitor);
  // The visitor is connected and loaded, yet has written no presence: it is not listed.
  await expect(chip(visitor, 'Test account')).toBeVisible();
  const [participant] = await stack.sql(`SELECT connections FROM participant WHERE identity = 0x${vhex}`);
  expect(Number(participant.connections)).toBeGreaterThan(0);
  expect(await rowsOf(stack, 'cursor', vhex)).toEqual([]);
  expect(await rowsOf(stack, 'selection', vhex)).toEqual([]);
  await expect(chip(owner, guestName(ownerHex))).toBeVisible();
  await expect(chips(owner)).toHaveCount(1);

  await nodes(visitor).first().hover();
  await expect(chips(owner)).toHaveCount(2);
  await expect(chip(owner, 'Test account')).toBeVisible();

  const label = owner.locator('#participants-label');
  const pop = owner.locator('#presence-pop');
  await label.click();
  await expect(label).toHaveAttribute('aria-expanded', 'true');
  await expect(pop.locator('.eyebrow')).toHaveText('PARTICIPANTS');
  await expect(pop.locator('.pp-count')).toHaveText('2');
  await expect.poll(async () => (await pop.locator('.pp-name').allTextContents()).sort()).toEqual([guestName(ownerHex), 'Test account'].sort());
  await expect(pop.locator('.pp-status')).toHaveText([/^joined \d+s ago/, /^joined \d+s ago/]);
  await expect(pop.locator('.pp-row', { hasText: 'Test account' }).locator('.pp-status')).toHaveText(/^joined \d+s ago$/);
  await expect(pop.locator('.pp-note')).toHaveText('Initial: human. Bot icon, dashed ring: agent.');
  await label.click();
  await expect(pop).toBeHidden();
  await expect(label).toHaveAttribute('aria-expanded', 'false');
  await label.click();
  await expect(pop).toBeVisible();
  // Focus leaves the button (a click inside keeps the popover open), so Escape has to bring it back.
  await pop.locator('.pp-note').click();
  await expect(label).not.toBeFocused();
  await owner.keyboard.press('Escape');
  await expect(pop).toBeHidden();
  await expect(label).toHaveAttribute('aria-expanded', 'false');
  await expect(label).toBeFocused();
});

test('closing or reloading a tab clears that person\'s presence everywhere', async ({ guest, account, stack }) => {
  test.setTimeout(90_000);
  const { owner, link } = await sharedBoard(guest, stack, ['Payments']);
  const visitor = await account();
  await openBoard(visitor, link);
  const vhex = await hexOf(visitor);
  await nodes(visitor).first().click();
  await expect(cursors(owner)).toHaveCount(1);
  await expect(outlines(owner)).toHaveCount(1);
  await expect(chips(owner)).toHaveCount(2);

  // Park the pointer off the board, so the reloaded page writes nothing until it moves.
  await visitor.mouse.move(0, 0);
  await reloaded(visitor);
  await expect(cursors(owner)).toHaveCount(0);
  await expect(outlines(owner)).toHaveCount(0);
  await expect(chips(owner)).toHaveCount(1);
  await nodes(visitor).first().click();
  await expect(cursors(owner)).toHaveCount(1);
  await expect(outlines(owner)).toHaveCount(1);
  await expect(chips(owner)).toHaveCount(2);
  await expect.poll(async () => (await rowsOf(stack, 'selection', vhex)).length).toBe(1);
  expect(await rowsOf(stack, 'cursor', vhex)).toHaveLength(1);

  await visitor.close();
  await expect(cursors(owner)).toHaveCount(0);
  await expect(outlines(owner)).toHaveCount(0);
  await expect(chips(owner)).toHaveCount(1);
  await expect.poll(() => rowsOf(stack, 'cursor', vhex)).toEqual([]);
  await expect.poll(() => rowsOf(stack, 'selection', vhex)).toEqual([]);
});

test('when one tab of an identity closes, its other open tab writes the presence back', async ({ guest, account, stack }) => {
  test.setTimeout(90_000);
  const { owner, link } = await sharedBoard(guest, stack, ['Payments']);
  const ownerHex = await hexOf(owner);
  const tab2 = await owner.context().newPage(); // same guest token, same identity
  await openBoard(tab2, owner.url());
  await owner.bringToFront();
  await nodes(owner).first().click();

  const visitor = await account();
  await openBoard(visitor, link);
  await expect(outlines(visitor)).toHaveCount(1);
  await visitor.evaluate(hex => {
    const w = window as any;
    w.__deleted = 0;
    w.conn.db.visibleSelection.onDelete((_ctx: unknown, row: any) => { if (row.identity.toHexString() === hex) w.__deleted++; });
  }, ownerHex);

  await tab2.close();
  await expect.poll(() => visitor.evaluate(() => (window as any).__deleted)).toBeGreaterThan(0);
  await expect(outlines(visitor)).toHaveCount(1);
  await expect(cursors(visitor)).toHaveText(guestName(ownerHex));
  await expect(chip(visitor, guestName(ownerHex))).toBeVisible();
  await expect.poll(async () => (await rowsOf(stack, 'selection', ownerHex)).length).toBe(1);
  await expect.poll(async () => (await rowsOf(stack, 'cursor', ownerHex)).length).toBe(1);
});

test('a view-only reader, even a guest, broadcasts cursor and selection', async ({ guest, account, stack }) => {
  test.setTimeout(90_000);
  const owner = await account();
  await openBoard(owner, `${stack.url}?new=1`);
  await drawNode(owner, 'Payments');
  const link = await shareBoard(owner, 'view');
  await owner.keyboard.press('Escape');
  const B = await boardIdOf(stack, owner);

  const visitor = await guest();
  await openBoard(visitor, link);
  const vhex = await hexOf(visitor);
  await nodes(visitor).first().click();
  await expect(chip(owner, guestName(vhex))).toBeVisible();
  await expect(outlines(owner)).toHaveCount(1);
  await expect(cursors(owner)).toHaveText(guestName(vhex));
  const [selected] = await rowsOf(stack, 'selection', vhex);
  expect((selected.node_ids as unknown[]).map(String)).toEqual([await nodes(visitor).first().getAttribute('data-id')]);
  // Selecting wrote presence only: the board still has its one node.
  await expect(nodes(visitor)).toHaveCount(1);
  expect(await stack.sql(`SELECT id FROM node WHERE board_id = ${B}`)).toHaveLength(1);
});

test('strangers get no presence rows and cannot write them', async ({ guest, stack }) => {
  test.setTimeout(90_000);
  const owner = await guest();
  await openBoard(owner, stack.url);
  await drawNode(owner, 'Billing');
  await nodes(owner).first().click();
  const B = await boardIdOf(stack, owner);
  const ownerHex = await hexOf(owner);
  await expect.poll(async () => (await stack.sql(`SELECT * FROM cursor WHERE board_id = ${B}`)).length).toBe(1);
  await expect.poll(async () => (await stack.sql(`SELECT * FROM selection WHERE board_id = ${B}`)).length).toBe(1);

  const stranger = await guest();
  await stranger.goto(owner.url());
  await expect(stranger.getByRole('heading', { name: 'This board is unavailable' })).toBeVisible();
  const shex = await hexOf(stranger);
  // The canvas stops before it subscribes to presence; subscribe by hand, as any client could.
  const seen = await stranger.evaluate(board => new Promise<{ cursors: string[]; selections: string[]; people: string[] }>((resolve, reject) => {
    const conn = (window as any).conn;
    conn.subscriptionBuilder()
      .onApplied(() => resolve({
        cursors: [...conn.db.visibleCursor.iter()].filter((r: any) => r.boardId === BigInt(board)).map((r: any) => r.identity.toHexString()),
        selections: [...conn.db.visibleSelection.iter()].filter((r: any) => r.boardId === BigInt(board)).map((r: any) => r.identity.toHexString()),
        people: [...conn.db.visibleParticipant.iter()].map((p: any) => p.identity.toHexString()),
      }))
      .onError((ctx: { event?: unknown }) => reject(new Error(String(ctx.event))))
      .subscribe(['SELECT * FROM visible_cursor', 'SELECT * FROM visible_selection', 'SELECT * FROM visible_participant']);
  }), B);
  expect(seen.people).toContain(shex);
  expect(seen.people).not.toContain(ownerHex);
  expect(seen.cursors).toEqual([]);
  expect(seen.selections).toEqual([]);

  // SERVER: neither the stranger's own connection nor another identity may write presence on B.
  const write = (reducer: 'updateCursor' | 'setSelection') => stranger.evaluate(([board, name]) => {
    const reducers = (window as any).conn.reducers;
    const call = name === 'updateCursor' ? reducers.updateCursor({ boardId: BigInt(board), x: 1, y: 2 }) : reducers.setSelection({ boardId: BigInt(board), nodeIds: [] });
    return call.then(() => 'written', (error: unknown) => String(error));
  }, [B, reducer] as const);
  expect(await write('updateCursor')).toContain('not authorized: board is unavailable');
  expect(await write('setSelection')).toContain('not authorized: board is unavailable');
  const minted = await stack.mintIdentity();
  await expect(stack.callReducer(minted.token, 'update_cursor', [B, 1, 2])).rejects.toThrow('not authorized: board is unavailable');
  await expect(stack.callReducer(minted.token, 'set_selection', [B, []])).rejects.toThrow('not authorized: board is unavailable');
  for (const hex of [shex, minted.identity]) {
    expect(await rowsOf(stack, 'cursor', hex)).toEqual([]);
    expect(await rowsOf(stack, 'selection', hex)).toEqual([]);
  }
  await expect(chip(owner, guestName(ownerHex))).toBeVisible();
  await expect(chips(owner)).toHaveCount(1);
});

test('other people\'s participant rows carry no sign-in issuer', async ({ account, stack }) => {
  const owner = await account();
  await openBoard(owner, `${stack.url}?new=1`);
  await drawNode(owner, 'Payments'); // drawing writes the owner's cursor, so the visitor is sent its row
  const link = await shareBoard(owner, 'edit');
  const ownerHex = await hexOf(owner);
  const visitor = await account();
  await openBoard(visitor, link);
  const vhex = await hexOf(visitor);
  const issuers = () => visitor.evaluate(() => Object.fromEntries([...(window as any).conn.db.visibleParticipant.iter()].map((p: any) => [p.identity.toHexString(), p.authIssuer])));
  await expect.poll(async () => Object.keys(await issuers())).toContain(ownerHex);
  const rows = await issuers();
  expect(rows[ownerHex]).toBe('');
  expect(rows[vhex]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/browser$/);
  // Stripped in the view, not missing from the table.
  const [stored] = await stack.sql(`SELECT auth_issuer FROM participant WHERE identity = 0x${ownerHex}`);
  expect(stored.auth_issuer).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/browser$/);
});

test('a canvas receives presence only for the board it has open', async ({ guest, account, stack }) => {
  test.setTimeout(90_000);
  const owner = await guest();
  await openBoard(owner, stack.url);
  await drawNode(owner, 'Alpha');
  const urlA = owner.url();
  await openBoard(owner, `${stack.url}?new=1`);
  await drawNode(owner, 'Beta');
  const linkB = await shareBoard(owner, 'edit');
  await owner.keyboard.press('Escape');
  const urlB = owner.url();
  const B = await boardIdOf(stack, owner);
  // A full load of A: only A is open in this identity's canvases.
  await openFresh(owner, urlA);
  await expect(owner.locator('#world')).toContainText('Alpha');

  const visitor = await account();
  await openBoard(visitor, linkB);
  const vhex = await hexOf(visitor);
  await nodes(visitor).first().hover();
  await expect.poll(async () => (await rowsOf(stack, 'cursor', vhex)).length).toBe(1);
  // A later write of the owner's own reaches its canvas: updates arrive in commit order, so B's cursor would be there by now.
  const [A, ownerHex] = [await boardIdOf(stack, owner), await hexOf(owner)];
  await nodes(owner).first().click();
  await expect.poll(async () => (await cachedRow(owner, 'visibleSelection', ownerHex))?.board).toBe(A);
  const onB = () => owner.evaluate(board => [...(window as any).conn.db.visibleCursor.iter()].filter((c: any) => c.boardId === BigInt(board)).length, B);
  expect(await onB()).toBe(0);
  await expect(chips(owner)).toHaveCount(1);
  await expect(chip(owner, 'Test account')).toHaveCount(0);

  // Switching to B in the same document brings its people in.
  await owner.evaluate(href => { history.pushState(null, '', href); dispatchEvent(new PopStateEvent('popstate')); }, urlB);
  await expect(owner.locator('#world')).toContainText('Beta');
  await expect(chip(owner, 'Test account')).toBeVisible();
  await expect(cursors(owner)).toHaveCount(1);
  await expect(cursors(owner)).toHaveText('Test account');
});

test('offline humans are never listed or drawn', async ({ guest, stack }) => {
  const owner = await guest();
  await openBoard(owner, stack.url);
  await drawNode(owner, 'Payments');
  const B = await boardIdOf(stack, owner);
  // An HTTP caller connects and disconnects per call: its participant row ends at connections 0.
  const ghost = await stack.mintIdentity();
  await stack.callReducer(ghost.token, 'join_board', ['Ghost human', 'human']);
  await stack.sql(`INSERT INTO cursor (identity, board_id, x, y) VALUES (0x${ghost.identity}, ${B}, 0, 0)`);
  // Both rows reach the owner's canvas, so nothing below is drawn for want of data.
  const delivered = () => owner.evaluate(hex => {
    const db = (window as any).conn.db;
    const person = [...db.visibleParticipant.iter()].find((p: any) => p.identity.toHexString() === hex);
    return { cursor: [...db.visibleCursor.iter()].some((c: any) => c.identity.toHexString() === hex), connections: person?.connections, name: person?.displayName };
  }, ghost.identity);
  await expect.poll(delivered).toEqual({ cursor: true, connections: 0, name: 'Ghost human' });
  await expect(chips(owner)).toHaveCount(1);
  await expect(chip(owner, 'Ghost human')).toHaveCount(0);
  await expect(cursors(owner)).toHaveCount(0);
  await stack.sql(`DELETE FROM cursor WHERE identity = 0x${ghost.identity}`);
});
