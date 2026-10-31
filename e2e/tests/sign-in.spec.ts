import type { Page } from '@playwright/test';
import { test, expect, openBoard, drawNode, shareBoard, signIn, signOut, signInOnRequest, boardIdOf, linkedAgent, palette, guestToken, tryPlace, type Stack } from '../fixtures';

// Guest to account handoff and sign-out.
const WIDE = { viewport: { width: 1440, height: 900 } };
const NONE = { none: [] };
const SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const SNIPPET = 'export function verify() {}';
const LINE = {
  view: 'link sharing on · anyone with the link can view',
  edit: 'link sharing on · signed-in people with the link can edit',
};
const RECOVERY = 'Your guest drawing is still saved in this browser. Sign out to return to it, then sign in again to save it to your account.';

/** SQL returns identities wrapped; compare them as bare lowercase hex, as window.myIdentityHex is. */
const hexOf = (value: unknown) => JSON.stringify(value).match(/[0-9a-f]{64}/i)![0].toLowerCase();
const me = (page: Page) => page.evaluate(() => (window as any).myIdentityHex as string);
const grants = async (stack: Stack, B: number) =>
  (await stack.sql(`SELECT grantee, role FROM board_grant WHERE board_id = ${B}`)).map(row => [hexOf(row.grantee), row.role]);
const viewers = async (stack: Stack, B: number) =>
  (await stack.sql(`SELECT viewer FROM link_visit WHERE board_id = ${B}`)).map(row => hexOf(row.viewer));
// createNode: boardId, label, sublabel, x, y, w, h, token, focal, kind, doc, imported, shape, color, strokeStyle, size
const agentNode = (stack: Stack, token: string, B: number, label: string) =>
  stack.callReducer(token, 'create_node', [B, label, '', 200, 700, 160, 80, 'ink', false, NONE, NONE, NONE, NONE, NONE, NONE, NONE]);
// sign out sits in the menu the name opens
const accountBarSignOut = async (page: Page) => {
  await page.locator('#account-name').click();
  await page.locator('#account-bar').getByRole('menuitem', { name: 'sign out', exact: true }).click();
};

/** Selects the node and returns the inspector, which lists its code refs. */
async function inspect(page: Page, label: string) {
  await page.locator('#world g.node', { hasText: label }).locator('.node-rect').click();
  return page.locator('#inspector');
}

test('a guest owner who signs in keeps the board, its link and its recipients; agent grants and stored code go', async ({ guest, account, stack }) => {
  test.setTimeout(90_000);
  const g = await guest(WIDE);
  await openBoard(g, `${stack.url}?new=1`);
  await drawNode(g, 'Guest service');
  const B = await boardIdOf(stack, g);
  const gTok = await guestToken(g);
  const guestHex = await me(g);
  const nodeId = Number(await g.locator('#world g.node').first().getAttribute('data-id'));
  await stack.callReducer(gTok, 'set_code_consent', [true]);
  await stack.callReducer(gTok, 'add_repo_files', [B, ['src/auth.ts']]);
  await stack.callReducer(gTok, 'add_code_ref', [B, 'node', nodeId, 'src/auth.ts', 'verify', 1, 1, SHA, SNIPPET, 'e2e']);
  await expect((await inspect(g, 'Guest service')).locator('.insp-code')).toContainText(SNIPPET); // the guest stored it
  await g.keyboard.press('Escape');
  const agent = await linkedAgent(stack, gTok, B);
  await agentNode(stack, agent.token, B, 'Agent before');
  await expect(g.locator('#world')).toContainText('Agent before');
  expect(await stack.sql(`SELECT id FROM agent_grant WHERE board_id = ${B}`)).toHaveLength(1);

  const link = await shareBoard(g, 'edit');
  await g.locator('#act-share').click(); // closes the share menu
  const r = await account(undefined, WIDE);
  await openBoard(r, link);
  await expect(r.locator('#world')).toContainText('Guest service');
  const url = g.url();
  expect(await grants(stack, B)).toEqual([[guestHex, 'owner']]);

  signInOnRequest(g, stack.accountToken());
  await g.locator('#sign-in').click();
  await expect(g.locator('#account-name')).toHaveText('Test account');
  await expect(g).toHaveURL(url);
  await expect(g.locator('#world')).toContainText('Guest service');
  await expect(g.locator('#board-title')).toHaveClass(/renamable/);
  await expect(g.locator('#access-line')).toHaveText(LINE.edit);
  await g.locator('#act-share').click();
  await expect(g.locator('#share-url')).toHaveValue(link);
  await expect(g.getByRole('button', { name: 'Can edit', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await g.locator('#act-share').click();

  // The account owns it now; the guest's agent lost the board with the guest, and the account has no code consent.
  const accountHex = await me(g);
  expect(accountHex).not.toBe(guestHex);
  expect(await grants(stack, B)).toEqual([[accountHex, 'owner']]);
  expect(await stack.sql(`SELECT id FROM agent_grant WHERE board_id = ${B}`)).toEqual([]);
  await expect(agentNode(stack, agent.token, B, 'Agent after')).rejects.toThrow('not authorized: board is unavailable');
  expect(await stack.sql(`SELECT snippet FROM code_ref WHERE board_id = ${B}`)).toEqual([{ snippet: '' }]);
  const inspector = await inspect(g, 'Guest service');
  await expect(inspector).toContainText('No code stored for this reference.');
  await expect(inspector.locator('.insp-code')).toHaveCount(0);
  await g.keyboard.press('Escape');

  // The open recipient never reloaded and still edits, both ways, live.
  await drawNode(r, 'Still editing');
  await expect(g.locator('#world')).toContainText('Still editing');
  await drawNode(g, 'After claim');
  await expect(r.locator('#world')).toContainText('After claim');
  await r.reload();
  await expect(r).toHaveURL(link);
  await expect(r.locator('#world')).toContainText('After claim');
});

test("a guest recipient signs in from an edit link and edits without claiming the owner's board", async ({ guest, account, stack }) => {
  test.setTimeout(90_000);
  const owner = await account();
  await openBoard(owner, `${stack.url}?new=1`);
  await drawNode(owner, 'Shared');
  const link = await shareBoard(owner, 'edit');
  await owner.locator('#act-share').click();
  const B = await boardIdOf(stack, owner);
  const ownerHex = await me(owner);

  const r = await guest();
  await openBoard(r, link);
  await expect(r.locator('#world')).toContainText('Shared');
  await expect(r.locator('#board-title')).toHaveText('Untitled board · view only');
  const signInToEdit = r.getByRole('button', { name: 'sign in to edit', exact: true });
  await expect(signInToEdit).toBeVisible();
  const rTok = stack.accountToken();
  signInOnRequest(r, rTok);
  await signInToEdit.click();
  await expect(r.locator('#account-name')).toHaveText('Test account');
  await expect(r).toHaveURL(link);
  await expect(r.locator('#canvas-wrap')).toHaveAttribute('aria-busy', 'false');
  await expect(r.locator('#board-title')).toHaveText('Untitled board');
  await drawNode(r, 'Recipient');
  await expect(owner.locator('#world')).toContainText('Recipient');

  // An editor, not an owner: no Share, no delete, and the module refuses both.
  await expect(owner.locator('#act-share')).toBeVisible();
  await expect(r.locator('#act-share')).toBeHidden();
  await palette(owner, 'board');
  await expect(owner.locator('#palette-list')).toContainText('Delete this board');
  await owner.keyboard.press('Escape');
  await palette(r, 'board');
  await expect(r.locator('#palette-list')).toContainText('Keyboard shortcuts'); // the filtered list has rendered
  await expect(r.locator('#palette-list')).not.toContainText('Delete this board');
  await r.keyboard.press('Escape');
  const rHex = await me(r);
  expect(await grants(stack, B)).toEqual([[ownerHex, 'owner']]);
  expect(await viewers(stack, B)).toContain(rHex);
  await expect(stack.callReducer(rTok, 'delete_board', [B])).rejects.toThrow(`only an owner of board ${B} can delete it`);
  expect(await stack.sql(`SELECT id FROM board WHERE id = ${B}`)).toHaveLength(1);
});

test("a cancelled sign-in keeps the guest's board, link and recipients", async ({ guest, stack }) => {
  const g = await guest();
  await openBoard(g, `${stack.url}?new=1`);
  await drawNode(g, 'Kept');
  const link = await shareBoard(g, 'view');
  await g.locator('#act-share').click();
  const B = await boardIdOf(stack, g);
  const guestHex = await me(g);
  const r = await guest();
  await openBoard(r, link);
  await expect(r.locator('#world')).toContainText('Kept');
  await expect(r.locator('#sign-in')).toHaveText('sign in');
  const url = g.url();
  const before = (await stack.sql('SELECT id FROM board')).length;

  // Nothing queued with signInOnRequest: the provider returns no session, as a closed sign-in window does.
  await g.locator('#sign-in').click();
  await expect.poll(async () => (await stack.sql(`SELECT board_id FROM guest_claim_offer WHERE board_id = ${B}`)).length).toBe(1); // the attempt ran
  await expect(g.locator('#sign-in')).toBeEnabled();
  await expect(g).toHaveURL(url);
  await expect(g.locator('#account-name')).toHaveCount(0);
  expect(await g.evaluate(() => Object.keys(sessionStorage).filter(k => k.startsWith('guest_claim:')))).toEqual([]);
  await expect(g.locator('#world')).toContainText('Kept');
  await expect(g.locator('#act-share')).toHaveText('Shared');
  await expect(g.locator('#access-line')).toHaveText(LINE.view);
  expect(await grants(stack, B)).toEqual([[guestHex, 'owner']]);

  // Still the owner: a mode change reaches the open recipient.
  await g.locator('#act-share').click();
  await g.getByRole('button', { name: 'Can edit', exact: true }).click();
  await expect(r.locator('#sign-in')).toHaveText('sign in to edit');
  expect((await stack.sql('SELECT id FROM board')).length).toBe(before);
  await r.reload();
  await expect(r.locator('#world')).toContainText('Kept');
});

/** A guest's shared drawing whose claim the module refuses on the sign-in reload (TR13). */
async function refusedClaim(guest: () => Promise<Page>, stack: Stack) {
  const g = await guest();
  await openBoard(g, `${stack.url}?new=1`);
  await drawNode(g, 'Recover me');
  const link = await shareBoard(g, 'view');
  await g.locator('#act-share').click();
  const B = await boardIdOf(stack, g);
  const guestHex = await me(g);
  const r = await guest();
  await openBoard(r, link);
  await expect(r.locator('#world')).toContainText('Recover me');
  const url = g.url();
  // A well-formed but wrong code: the module refuses it as invalid or expired.
  await g.context().addInitScript(() => {
    for (const key of Object.keys(sessionStorage).filter(k => k.startsWith('guest_claim:'))) {
      sessionStorage.setItem(key, JSON.stringify({ ...JSON.parse(sessionStorage.getItem(key)!), code: 'x'.repeat(40) }));
    }
  });
  signInOnRequest(g, stack.accountToken());
  await g.locator('#sign-in').click();
  await expect(g.locator('#account-name')).toHaveText('Test account');
  await expect(g.getByRole('heading', { name: 'This board is unavailable' })).toBeVisible();
  return { g, r, B, guestHex, url };
}

test('a refused claim explains itself and leaves the guest the owner', async ({ guest, stack }) => {
  const { g, r, B, guestHex, url } = await refusedClaim(guest, stack);
  await expect(g.locator('#error-text')).toHaveText(RECOVERY);
  await expect(g).toHaveURL(url);
  expect(await grants(stack, B)).toEqual([[guestHex, 'owner']]);
  await r.reload();
  await expect(r.locator('#world')).toContainText('Recover me');
});

test('signing out after a refused claim returns to the guest drawing', async ({ guest, stack }) => {
  // divergent (AG-39, SH-43): guestHomeHref() is this same #b= URL, so location.assign is a fragment navigation; the signed-out page stays on the unavailable panel until a manual reload
  test.fail();
  const { g, r, guestHex, url } = await refusedClaim(guest, stack);
  await accountBarSignOut(g);
  await expect.poll(() => g.evaluate(() => Object.entries(localStorage).find(([key]) => key.startsWith('account_seen:'))?.[1] ?? null)).toBeNull(); // the sign-out ran
  await expect(g.locator('#world')).toContainText('Recover me');
  await expect(g).toHaveURL(url);
  await expect(g.locator('#account-name')).toHaveCount(0);
  await expect(g.locator('#act-share')).toBeVisible();
  await expect(g.locator('#sign-in')).toHaveText('sign in');
  expect(await me(g)).toBe(guestHex);
  await r.reload();
  await expect(r.locator('#world')).toContainText('Recover me');
});

test("signing out drops the account's boards from this browser; the account's agent keeps writing", async ({ account, stack }) => {
  test.setTimeout(90_000);
  const token = stack.accountToken();
  const a = await account(token);
  await openBoard(a, `${stack.url}?new=1`);
  await drawNode(a, 'Account only');
  const href = a.url();
  const B = await boardIdOf(stack, a);
  const accountHex = await me(a);
  const agent = await linkedAgent(stack, token, B);

  await accountBarSignOut(a);
  await expect(a.locator('#sign-in')).toHaveText('sign in');
  await expect(a.locator('#canvas-wrap')).toHaveAttribute('aria-busy', 'false');
  await expect(a.locator('#board-title')).toHaveText('Untitled board');
  await expect(a.locator('#account-bar')).toHaveCount(0);
  await expect(a.locator('#world g.node')).toHaveCount(0);
  expect(await me(a)).not.toBe(accountHex); // a new guest identity

  const p = await a.context().newPage();
  await p.goto(href);
  await expect(p.getByRole('heading', { name: 'This board is unavailable' })).toBeVisible();
  expect(await stack.sql(`SELECT id FROM board WHERE id = ${B}`)).toHaveLength(1); // unavailable to this browser, not gone

  // AG-55: the canvas sign-out signed out no agent.
  expect(await stack.sql(`SELECT id FROM agent_grant WHERE board_id = ${B}`)).toHaveLength(1);
  await agentNode(stack, agent.token, B, 'Agent later');
  const again = await account(token);
  await openBoard(again, href);
  await expect(again.locator('#world')).toContainText('Agent later');
});

test('an editor who signs out is read-only on the edit link, and another account is a new visitor', async ({ account, stack }) => {
  test.setTimeout(90_000);
  const owner = await account();
  await openBoard(owner, `${stack.url}?new=1`);
  await drawNode(owner, 'Owner service');
  const link = await shareBoard(owner, 'edit');
  const B = await boardIdOf(stack, owner);
  const r = await account();
  await openBoard(r, link);
  await drawNode(r, 'As account');
  await expect(owner.locator('#world')).toContainText('As account');
  const firstHex = await me(r);

  await accountBarSignOut(r);
  await expect(r.locator('#sign-in')).toHaveText('sign in');
  await r.goto('about:blank'); // the guest home differs from the link only by its hash
  await openBoard(r, link);
  await expect(r.locator('#world')).toContainText('As account');
  await expect(r.getByRole('button', { name: 'sign in to edit', exact: true })).toBeVisible();
  await expect(r.locator('#board-title')).toHaveText('Untitled board · view only');
  await expect(r.locator('#rail-hint')).toHaveText('Public example. Explore the drawing or export it. Start a new board to draw.');
  const guestHex = await me(r);
  expect(guestHex).not.toBe(firstHex);
  await tryPlace(r);
  await expect(r.locator('#world g.node')).toHaveCount(2);
  await expect(agentNode(stack, await guestToken(r), B, 'Guest write')).rejects.toThrow('not authorized: board is read only');
  await r.reload();
  await expect(r.locator('#world')).toContainText('As account');
  await expect(r.locator('#world g.node')).toHaveCount(2);
  await expect(owner.locator('#world g.node')).toHaveCount(2);

  await signIn(r, stack.accountToken());
  await r.reload();
  await expect(r.locator('#account-name')).toHaveText('Test account');
  await expect(r.locator('#world')).toContainText('As account');
  await drawNode(r, 'Second account');
  await expect(owner.locator('#world')).toContainText('Second account');
  const secondHex = await me(r);
  expect(new Set([firstHex, guestHex, secondHex]).size).toBe(3);
  expect(await viewers(stack, B)).toEqual(expect.arrayContaining([firstHex, guestHex, secondHex]));
});

test('a sign-out in another tab sends the open canvas to the guest home', async ({ guest, stack }) => {
  const a = await guest();
  await openBoard(a, stack.url);
  await drawNode(a, 'Guest drawing');
  // The claim key sits beside the guest token: guest_claim:<uri>/<db>.
  const claimKey = await a.evaluate(() => Object.keys(localStorage).find(k => k.startsWith('stdb_token:'))!.replace('stdb_token:', 'guest_claim:'));
  await signIn(a, stack.accountToken());
  await openBoard(a, `${stack.url}?new=1`);
  await expect(a.locator('#account-name')).toHaveText('Test account');
  await drawNode(a, 'Account only');
  const boardUrl = a.url();
  const accountConn = await a.evaluate(() => (window as any).conn.connectionId.toHexString() as string);
  // Boards this connection holds open; a disconnect empties or drops its open_board row (closeBoards).
  const accountOpen = async () => (await stack.sql(`SELECT board_ids FROM open_board WHERE connection_id = 0x${accountConn}`)).flatMap(row => row.board_ids as unknown[]).length;
  expect(await accountOpen()).toBe(1);
  expect(await a.evaluate(() => Object.entries(localStorage).find(([key]) => key.startsWith('account_seen:'))?.[1] ?? null)).toBe('1');
  await a.evaluate(key => sessionStorage.setItem(key, JSON.stringify({ boardId: '1', code: 'x'.repeat(40), slug: 'elsewhere' })), claimKey);

  await signOut(a); // the provider's sign-out event, as another tab ending the session sends it
  await expect(a).not.toHaveURL(boardUrl);
  await expect(a.locator('#sign-in')).toBeVisible();
  await expect(a.locator('#world')).toContainText('Guest drawing');
  await expect(a.locator('#world')).not.toContainText('Account only');
  await expect.poll(accountOpen).toBe(0); // the account's connection is closed
  expect(await a.evaluate(() => Object.entries(localStorage).find(([key]) => key.startsWith('account_seen:'))?.[1] ?? null)).toBeNull();
  expect(await a.evaluate(key => sessionStorage.getItem(key), claimKey)).toBeNull();
});
