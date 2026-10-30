import type { Page } from '@playwright/test';
import { test, expect, openBoard, drawNode, shareBoard, boardIdOf, guestToken, nodes, tryPlace, settledBox, type Stack } from '../fixtures';

// Link sharing while recipients have the board open (spec 2026-10-15 link sharing, e2e-access-cases TR04-TR09).
const LINE = {
  view: 'link sharing on · anyone with the link can view',
  edit: 'link sharing on · signed-in people with the link can edit',
};
const HINT = {
  off: 'Only people with access can open this board. Turn on to get a link anyone can open.',
  view: 'Anyone with the link can view. Turning this off ends access for everyone.',
  edit: 'Anyone with the link can view. Signed-in people can edit. Turning this off ends access for everyone.',
};
const GONE = 'This link is no longer shared.';
const READ_ONLY = 'not authorized: board is read only';
const UNAVAILABLE = 'not authorized: board is unavailable';
const NONE = { none: [] };
/** create_node's positional arguments: one plain node on board B. */
const newNode = (B: number, label: string) => [B, label, '', 800, 600, 160, 80, 'ink', false, ...Array(7).fill(NONE)];
/** The bare canvas address plus the fragment: no ?new=1, no ?db= (SH-10). */
const linkPattern = (stack: Stack) => new RegExp(`^${stack.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}#s=[0-9a-f]{32}$`);

const tokenOf = (link: string) => new URL(link).hash.slice('#s='.length);
const switchOf = (page: Page) => page.getByRole('switch', { name: 'Share with link' });
const modeButton = (page: Page, mode: 'view' | 'edit') => page.getByRole('button', { name: mode === 'edit' ? 'Can edit' : 'Can view', exact: true });
/** The node labels in the page's row cache, not only the drawn ones. */
const cachedLabels = (page: Page) => page.evaluate(() => [...(window as any).conn.db.visibleNode.iter()].map((n: any) => n.label as string));
const visits = (stack: Stack, B: number) => stack.sql(`SELECT * FROM link_visit WHERE board_id = ${B}`);

async function slugOf(stack: Stack, B: number) {
  const [{ slug }] = await stack.sql(`SELECT slug FROM board WHERE id = ${B}`);
  return String(slug);
}

async function openMenu(page: Page) {
  if (await page.locator('#share-pop').isHidden()) await page.locator('#act-share').click();
  await expect(page.locator('#share-pop')).toBeVisible();
}

async function setMode(page: Page, mode: 'view' | 'edit') {
  await openMenu(page);
  await modeButton(page, mode).click();
  await expect(modeButton(page, mode)).toHaveAttribute('aria-pressed', 'true');
}

async function stopSharing(page: Page) {
  await openMenu(page);
  await switchOf(page).uncheck();
  await expect(page.locator('#act-share')).toHaveText('Share');
}

/** A fresh document load: a goto that only changes the fragment would not boot the canvas again. */
async function reopen(page: Page, href: string) {
  await page.goto('about:blank');
  await openBoard(page, href);
}

async function expectUnavailable(page: Page) {
  await expect(page.getByRole('heading', { name: 'This board is unavailable' })).toBeVisible();
  await expect(page.getByText('It may have been removed, or this link may need a different account.')).toBeVisible();
  await expect(page.locator('#board-title')).toHaveText('Board unavailable');
  await expect(nodes(page)).toHaveCount(0);
  expect(await cachedLabels(page)).toEqual([]);
}

test('a guest owner keeps full control after sharing: draws, downgrades and stops', async ({ guest, account, stack }) => {
  test.setTimeout(90_000);
  const owner = await guest();
  await openBoard(owner, `${stack.url}?new=1`);
  await drawNode(owner, 'G1');
  const link = await shareBoard(owner, 'edit');
  expect(link).toMatch(linkPattern(stack));
  await drawNode(owner, 'G2 after share');
  const recToken = stack.accountToken();
  const rec = await account(recToken);
  await openBoard(rec, link);
  await expect(rec.locator('#world')).toContainText('G2 after share');
  await expect(rec.locator('#access-line')).toHaveText(LINE.edit);
  await expect(rec.locator('#board-title')).not.toContainText('view only');
  // The edit link lets this account write: the refusals below come from the owner's changes.
  const id = Number(await nodes(owner).first().getAttribute('data-id'));
  const [at] = await stack.sql(`SELECT x, y FROM node WHERE id = ${id}`);
  await stack.callReducer(recToken, 'move_node', [id, Number(at.x), Number(at.y)]);

  await setMode(owner, 'view');
  await expect(rec.locator('#board-title')).toContainText('view only');
  await expect(rec.locator('#access-line')).toHaveText(LINE.view);
  await expect(stack.callReducer(recToken, 'move_node', [id, 0, 0])).rejects.toThrow(READ_ONLY);

  await stopSharing(owner);
  await expect(rec.getByText(GONE, { exact: false })).toBeVisible();
  await expect(stack.callReducer(recToken, 'open_shared_link', [tokenOf(link)])).rejects.toThrow(GONE);
  await expect(stack.callReducer(recToken, 'move_node', [id, 0, 0])).rejects.toThrow(UNAVAILABLE);
  await drawNode(owner, 'G3');
  await expect(owner.locator('#access-line')).toHaveText('private');
});

test('upgrading a view link to edit keeps the token and reaches open recipients live', async ({ guest, account, stack }) => {
  test.setTimeout(90_000);
  const owner = await account(undefined, { permissions: ['clipboard-read', 'clipboard-write'] });
  await openBoard(owner, `${stack.url}?new=1`);
  await drawNode(owner, 'Base');
  const B = await boardIdOf(stack, owner);

  // The control's off and on states (SH-09); turning it on makes a view link.
  await expect(owner.locator('#act-share')).toHaveText('Share');
  await owner.locator('#act-share').click();
  await expect(owner.locator('#share-hint')).toHaveText(HINT.off);
  await switchOf(owner).check();
  await expect(modeButton(owner, 'view')).toHaveAttribute('aria-pressed', 'true');
  await expect(owner.locator('#act-share')).toHaveText('Shared');
  await expect(owner.locator('#share-hint')).toHaveText(HINT.view);
  await expect(owner.locator('#share-url')).not.toHaveValue('');
  const link = await owner.locator('#share-url').inputValue();
  expect(link).toMatch(linkPattern(stack));
  expect(new URL(link).search).toBe('');
  await owner.locator('#share-copy').click();
  await expect(owner.locator('#share-copy')).toHaveText('Copied ✓');
  expect(await owner.evaluate(() => navigator.clipboard.readText())).toBe(link);

  const accToken = stack.accountToken();
  const acc = await account(accToken);
  await openBoard(acc, link);
  const g = await guest();
  await openBoard(g, link);
  await expect(acc.locator('#board-title')).toContainText('view only');
  await expect(acc.locator('#access-line')).toHaveText(LINE.view);
  await expect(g.locator('#world')).toContainText('Base');
  await expect(g.locator('#sign-in')).toHaveText('sign in');
  await expect(g.locator('#access-line')).toHaveText(LINE.view);

  await setMode(owner, 'edit');
  await expect(owner.locator('#share-url')).toHaveValue(link);
  await expect(owner.locator('#share-hint')).toHaveText(HINT.edit);
  await expect.poll(() => stack.sql(`SELECT token, mode FROM link_share WHERE board_id = ${B}`)).toEqual([{ token: tokenOf(link), mode: 'edit' }]);

  // No reload: the account recipient gains editing, the guest only the sign-in prompt.
  await expect(acc.locator('#board-title')).not.toContainText('view only');
  await expect(acc.locator('#access-line')).toHaveText(LINE.edit);
  await drawNode(acc, 'Upgraded');
  await expect(owner.locator('#world')).toContainText('Upgraded');
  await expect(g.locator('#world')).toContainText('Upgraded');
  await expect(g.locator('#sign-in')).toHaveText('sign in to edit');
  await expect(g.locator('#access-line')).toHaveText(LINE.edit);
  await tryPlace(g);
  await expect(nodes(g)).toHaveCount(2);
  // The guest's own identity reads the board (read only, not unavailable) and cannot add to it.
  await expect(stack.callReducer(await guestToken(g), 'create_node', newNode(B, 'Guest write'))).rejects.toThrow(READ_ONLY);

  await setMode(owner, 'view');
  await expect(owner.locator('#share-url')).toHaveValue(link);
  await expect(acc.locator('#board-title')).toContainText('view only');
  // Checked again after the round trips above, so a late write from the guest's click would show.
  await expect(nodes(g)).toHaveCount(2);
  expect(await stack.sql(`SELECT label FROM node WHERE board_id = ${B}`)).toHaveLength(2);
});

test("after a downgrade, a recipient's open label edit or drag cannot commit", async ({ account, stack }) => {
  test.setTimeout(90_000);
  const owner = await account();
  await openBoard(owner, `${stack.url}?new=1`);
  await drawNode(owner, 'Orig');
  const B = await boardIdOf(stack, owner);
  const id = Number(await nodes(owner).first().getAttribute('data-id'));
  const row = async () => (await stack.sql(`SELECT label, x, y FROM node WHERE id = ${id}`))[0];
  const before = await row();
  const link = await shareBoard(owner, 'edit');
  const recToken = stack.accountToken();
  const rec = await account(recToken);
  await openBoard(rec, link);
  await expect(rec.locator('#world')).toContainText('Orig');
  await expect(rec.locator('#board-title')).not.toContainText('view only');
  // An edit committed before the downgrade stays (AG-41).
  await drawNode(rec, 'Kept');
  await expect(owner.locator('#world')).toContainText('Kept');

  // An inline label draft open across the downgrade.
  await rec.locator(`#world g.node[data-id="${id}"]`).dblclick();
  const edit = rec.locator('#inline-edit');
  await edit.fill('Hijack');
  await setMode(owner, 'view');
  await expect(rec.locator('#board-title')).toContainText('view only');
  await edit.press('Enter');
  await expect(edit).toHaveCount(0);
  await expect(stack.callReducer(recToken, 'update_node', [id, { some: 'Hijack' }, ...Array(8).fill(NONE)])).rejects.toThrow(READ_ONLY);
  expect(await row()).toEqual(before);
  await expect(owner.locator('#world')).toContainText('Orig');
  await expect(owner.locator('#world')).not.toContainText('Hijack');
  await expect(rec.locator('#world')).not.toContainText('Hijack');
  await rec.reload();
  await expect(rec.locator('#world')).toContainText('Orig');
  await expect(rec.locator('#world')).toContainText('Kept');
  await expect(rec.locator('#world')).not.toContainText('Hijack');
  await expect(owner.locator('#world')).toContainText('Kept');

  // A drag held across the downgrade.
  await setMode(owner, 'edit');
  await expect(rec.locator('#board-title')).not.toContainText('view only');
  const node = rec.locator(`#world g.node[data-id="${id}"]`);
  const start = await node.getAttribute('transform');
  const box = await settledBox(node.locator('.node-rect'));
  await rec.mouse.move(box.x + 12, box.y + 12);
  await rec.mouse.down();
  await rec.mouse.move(box.x + 92, box.y + 92, { steps: 8 });
  await expect(node).not.toHaveAttribute('transform', start!);
  await setMode(owner, 'view');
  await expect(rec.locator('#board-title')).toContainText('view only');
  await rec.mouse.up();
  await expect(node).toHaveAttribute('transform', start!);
  await expect(stack.callReducer(recToken, 'move_node', [id, Number(before.x) + 80, Number(before.y) + 80])).rejects.toThrow(READ_ONLY);
  expect(await row()).toEqual(before);
  expect(await stack.sql(`SELECT id FROM node WHERE board_id = ${B} AND label = 'Kept'`)).toHaveLength(1);
});

test('stopping a link removes rows from open recipients, and the canonical link refuses them', async ({ guest, account, stack }) => {
  test.setTimeout(90_000);
  const owner = await account();
  await openBoard(owner, `${stack.url}?new=1`);
  await drawNode(owner, 'Secret');
  const B = await boardIdOf(stack, owner);
  const slug = await slugOf(stack, B);
  const link = await shareBoard(owner, 'view');
  const rec = await guest();
  await openBoard(rec, link);
  await expect(rec.locator('#world')).toContainText('Secret');
  expect(await cachedLabels(rec)).toEqual(['Secret']);
  const recToken = await guestToken(rec);
  const id = Number(await nodes(owner).first().getAttribute('data-id'));
  // While the link is on, this guest reads the board (read only, not unavailable).
  await expect(stack.callReducer(recToken, 'move_node', [id, 0, 0])).rejects.toThrow(READ_ONLY);

  await stopSharing(owner);
  await expect(rec.getByText(GONE, { exact: false })).toBeVisible();
  // The rows leave the client, not only the CSS-hidden board (BL-44).
  await expect.poll(() => cachedLabels(rec)).toEqual([]);
  expect(await stack.sql(`SELECT * FROM link_share WHERE board_id = ${B}`)).toEqual([]);
  expect(await visits(stack, B)).toEqual([]);
  await expect(stack.callReducer(recToken, 'open_shared_link', [tokenOf(link)])).rejects.toThrow(GONE);
  await expect(stack.callReducer(recToken, 'move_node', [id, 0, 0])).rejects.toThrow(UNAVAILABLE);
  await rec.reload();
  await expect(rec.getByText(GONE, { exact: false })).toBeVisible();
  expect(await cachedLabels(rec)).toEqual([]);

  await reopen(rec, `${stack.url}#b=${slug}`);
  await expectUnavailable(rec);
  await reopen(rec, `${stack.url}?boardId=${B}`);
  await expectUnavailable(rec);
});

test('turning a link on again makes a new token, and the old link stays dead', async ({ account, stack }) => {
  test.setTimeout(90_000);
  const owner = await account();
  await openBoard(owner, `${stack.url}?new=1`);
  await drawNode(owner, 'Rotated');
  const B = await boardIdOf(stack, owner);
  const old = await shareBoard(owner, 'view');
  const recToken = stack.accountToken();
  const rec = await account(recToken);
  await openBoard(rec, old);
  await expect(rec.locator('#world')).toContainText('Rotated');
  const id = Number(await nodes(rec).first().getAttribute('data-id'));
  await rec.reload();
  await expect(rec.locator('#world')).toContainText('Rotated');
  await rec.reload();
  await expect(rec.locator('#world')).toContainText('Rotated');
  // One visit row per viewer, however often the link is opened (SH-31).
  expect(await visits(stack, B)).toHaveLength(1);
  await expect(stack.callReducer(recToken, 'move_node', [id, 0, 0])).rejects.toThrow(READ_ONLY);

  await stopSharing(owner);
  await expect(rec.getByText(GONE, { exact: false })).toBeVisible();
  await switchOf(owner).check();
  await expect(owner.locator('#act-share')).toHaveText('Shared');
  await expect(owner.locator('#share-url')).not.toHaveValue('');
  const fresh = await owner.locator('#share-url').inputValue();
  expect(fresh).not.toBe(old);
  await expect.poll(() => stack.sql(`SELECT token FROM link_share WHERE board_id = ${B}`)).toEqual([{ token: tokenOf(fresh) }]);
  expect(await visits(stack, B)).toEqual([]);
  // The recipient's old visit grants nothing on the new link until they open it.
  await expect(stack.callReducer(recToken, 'move_node', [id, 0, 0])).rejects.toThrow(UNAVAILABLE);
  await expect(stack.callReducer(recToken, 'open_shared_link', [tokenOf(old)])).rejects.toThrow(GONE);

  await expect(rec.getByText(GONE, { exact: false })).toBeVisible();
  await rec.reload();
  await expect(rec.getByText(GONE, { exact: false })).toBeVisible();
  await reopen(rec, owner.url());
  await expect(rec.getByRole('heading', { name: 'This board is unavailable' })).toBeVisible();
  await expect(nodes(rec)).toHaveCount(0);

  const rec2 = await rec.context().newPage();
  await openBoard(rec2, fresh);
  await expect(rec2.locator('#world')).toContainText('Rotated');
  expect(await visits(stack, B)).toHaveLength(1);
});

test("an owner tab opened from the owner's own link keeps owner access and survives the stop, but not a reload", async ({ account, stack }) => {
  test.setTimeout(90_000);
  const owner = await account();
  await openBoard(owner, `${stack.url}?new=1`);
  await drawNode(owner, 'Mine');
  const link = await shareBoard(owner, 'view');
  await owner.keyboard.press('Escape');
  await expect(owner.locator('#share-pop')).toBeHidden();

  const tab2 = await owner.context().newPage();
  await openBoard(tab2, link);
  await expect(tab2.locator('#world')).toContainText('Mine');
  await expect(tab2.locator('#act-share')).toHaveText('Shared');
  await expect(tab2.locator('#board-title')).not.toContainText('view only');
  await drawNode(tab2, 'Owner via link');
  await expect(owner.locator('#world')).toContainText('Owner via link');

  // The owner's own access does not hang on the link (TR07).
  await stopSharing(owner);
  await expect(tab2.locator('#act-share')).toHaveText('Share');
  await expect(tab2.locator('#world')).toContainText('Owner via link');
  await expect(tab2.locator('#board-unavailable')).toHaveCount(0);
  await expect(tab2.getByText(GONE, { exact: false })).toHaveCount(0);
  await tab2.reload();
  await expect(tab2.getByText(GONE, { exact: false })).toBeVisible();
  await reopen(tab2, owner.url());
  await expect(tab2.locator('#world')).toContainText('Owner via link');
});

test("a link visitor reopening by ?boardId or #b= keeps the link's mode under the canonical URL", async ({ guest, account, stack }) => {
  test.setTimeout(90_000);
  const owner = await account();
  await openBoard(owner, `${stack.url}?new=1`);
  await drawNode(owner, 'Canon');
  const B = await boardIdOf(stack, owner);
  const slug = await slugOf(stack, B);
  const link = await shareBoard(owner, 'view');

  const v = await guest();
  await openBoard(v, link);
  await expect(v.locator('#world')).toContainText('Canon');
  await reopen(v, `${stack.url}?boardId=${B}`);
  await expect(v.locator('#world')).toContainText('Canon');
  await expect(v.locator('#board-title')).toContainText('view only');
  await expect(v).toHaveURL(`${stack.url}#b=${slug}`);
  await tryPlace(v);
  await expect(nodes(v)).toHaveCount(1);
  const id = Number(await nodes(v).first().getAttribute('data-id'));
  await expect(stack.callReducer(await guestToken(v), 'move_node', [id, 0, 0])).rejects.toThrow(READ_ONLY);
  await reopen(v, `${stack.url}#b=${slug}`);
  await expect(v.locator('#world')).toContainText('Canon');
  await expect(v.locator('#board-title')).toContainText('view only');
  // A fresh load shows every stored node: the click above placed none.
  await expect(nodes(v)).toHaveCount(1);
  expect(await stack.sql(`SELECT id FROM node WHERE board_id = ${B}`)).toHaveLength(1);

  // A legacy ?boardId= link canonicalizes for the owner too (SH-61).
  await openBoard(owner, `${stack.url}?boardId=${B}`);
  await expect(owner.locator('#world')).toContainText('Canon');
  await expect(owner).toHaveURL(`${stack.url}#b=${slug}`);
});

test('navigating the same tab to another share link reboots into it, and Back returns', async ({ guest, account, stack }) => {
  test.setTimeout(90_000);
  const owner = await account();
  await openBoard(owner, `${stack.url}?new=1`);
  await drawNode(owner, 'Linked');
  const B = await boardIdOf(stack, owner);
  const link = await shareBoard(owner, 'view');

  const rec = await guest();
  await openBoard(rec, `${stack.url}?new=1`);
  await drawNode(rec, 'Own');
  await expect(rec).toHaveURL(/#b=/);
  await rec.goto(link); // fragment navigation: same document, no load of its own
  await expect(rec.locator('#world')).toContainText('Linked');
  await expect(rec.locator('#world')).not.toContainText('Own');
  await expect(rec.locator('#access-line')).toHaveText(LINE.view);
  await expect(rec.locator('#board-title')).toContainText('view only');
  await expect(rec).toHaveURL(link);
  const me = await rec.evaluate(() => (window as any).myIdentityHex as string);
  expect(await stack.sql(`SELECT id FROM link_visit WHERE board_id = ${B} AND viewer = 0x${me}`)).toHaveLength(1);

  await rec.goBack();
  await expect(rec.locator('#world')).toContainText('Own');
  await expect(rec.locator('#world')).not.toContainText('Linked');

  // pushState plus popstate, as an in-app link would do.
  await openBoard(owner, `${stack.url}?new=1`);
  await drawNode(owner, 'Second');
  const B2 = await boardIdOf(stack, owner);
  const link2 = await shareBoard(owner, 'view');
  await rec.evaluate(href => { history.pushState(null, '', href); dispatchEvent(new PopStateEvent('popstate')); }, link2);
  await expect(rec.locator('#world')).toContainText('Second');
  await expect(rec.locator('#world')).not.toContainText('Own');
  await expect(rec.locator('#board-title')).toContainText('view only');
  await expect(rec).toHaveURL(link2);
  expect(await stack.sql(`SELECT id FROM link_visit WHERE board_id = ${B2} AND viewer = 0x${me}`)).toHaveLength(1);
});

test('a link opens in a second tab while another tab is subscribed, and after a module republish', async ({ account, stack }) => {
  test.setTimeout(120_000);
  const owner = await account();
  await openBoard(owner, `${stack.url}?new=1`);
  await drawNode(owner, 'Live');
  const link = await shareBoard(owner, 'view');

  const rec = await account();
  await openBoard(rec, `${stack.url}?new=1`);
  const tab2 = await rec.context().newPage();
  await openBoard(tab2, link);
  await expect(tab2.locator('#world')).toContainText('Live');

  // A board shared before the publish, opened by someone whose views ran before it (PR #88).
  await openBoard(owner, `${stack.url}?new=1`);
  await drawNode(owner, 'After publish');
  const link2 = await shareBoard(owner, 'view');
  await stack.republish();
  const tab3 = await rec.context().newPage();
  await openBoard(tab3, link2);
  await expect(tab3.locator('#world')).toContainText('After publish');
});

test('the share token never leaves the fragment', async ({ guest, account, stack }) => {
  const owner = await account();
  await openBoard(owner, `${stack.url}?new=1`);
  await drawNode(owner, 'Quiet');
  const link = await shareBoard(owner, 'view');
  const token = tokenOf(link);

  const B = await boardIdOf(stack, owner);

  const v = await guest();
  const seen: string[] = [];
  const referers: string[] = [];
  // A fragment is never sent over HTTP: keep only the part of each URL that is.
  v.on('request', r => {
    referers.push(r.headers().referer ?? '');
    seen.push(r.url().split('#')[0], r.postData() ?? '');
  });
  v.on('websocket', ws => seen.push(ws.url()));
  v.on('console', m => seen.push(m.text()));
  await openBoard(v, link);
  await expect(v.locator('#world')).toContainText('Quiet');
  await v.reload();
  await expect(v.locator('#world')).toContainText('Quiet');
  // Anchors: the socket and the page's own Referer were seen, and the token reached the module (as open_shared_link's argument).
  expect(seen.some(s => s.startsWith('ws://'))).toBe(true);
  expect(referers.some(r => r.startsWith(stack.url))).toBe(true);
  expect(await visits(stack, B)).toHaveLength(1);
  expect([...seen, ...referers].filter(s => s.includes(token))).toEqual([]);
});
