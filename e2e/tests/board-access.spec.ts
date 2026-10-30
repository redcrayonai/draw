import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { setDb } from '../../shared/db-target';
import { test, expect, openBoard, drawNode, drawEdge, shareBoard, boardIdOf, linkedAgent, serverCaughtUp, palette, guestToken, marker, type Stack } from '../fixtures';

// Who can open a board: the canvas screen and the reducer verdict for the same identity (docs/e2e-access-cases.md).
const NONE = { none: [] };
const SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const HEAD = 'a'.repeat(40);
const EDIT_LINE = 'link sharing on · signed-in people with the link can edit';
const PUBLIC_LINE = 'public · anyone can view';
const LINK_GONE = 'This link is no longer shared. Ask the owner for a new link.';

/** create_node: boardId, label, sublabel, x, y, w, h, token, focal, then seven options. */
const node = (B: number, label: string, x = 400, y = 400) => [B, label, '', x, y, 160, 80, 'ink', false, NONE, NONE, NONE, NONE, NONE, NONE, NONE];
const unavailable = (page: Page) => page.getByRole('heading', { name: 'This board is unavailable' });
const identityOf = (page: Page) => page.evaluate(() => (window as any).myIdentityHex as string);
const slugOf = async (stack: Stack, B: number) => String((await stack.sql(`SELECT slug FROM board WHERE id = ${B}`))[0].slug);
const labelsOn = async (stack: Stack, B: number) => (await stack.sql(`SELECT label FROM node WHERE board_id = ${B}`)).map(row => String(row.label)).sort();
/** Rows of a view in this page's client cache: what the server sent this connection. */
const cached = (page: Page, table: string) => page.evaluate(name => [...(window as any).conn.db[name].iter()].length, table);

/** A fresh org with these identities and roles, written as the dashboard's team sync would (service only). */
async function team(stack: Stack, members: [string, string][]) {
  const org = `org_${randomUUID()}`;
  const service = await stack.serviceIdentity('e2e-org');
  for (const [hex, role] of members) await stack.callReducer(service.token, 'set_org_memberships', [{ __identity__: `0x${hex}` }, [org], [role]]);
  return org;
}

/** The public Demo. Seeding is a no-op once it exists, so it may carry earlier tests' changes. */
async function seedDemo(stack: Stack) {
  const service = await stack.serviceIdentity('e2e-demo');
  await stack.callReducer(service.token, 'seed_demo_board', []);
  const publics = new Set((await stack.sql('SELECT board_id FROM public_board')).map(row => Number(row.board_id)));
  const demo = (await stack.sql("SELECT id, slug FROM board WHERE name = 'Demo'")).find(row => publics.has(Number(row.id)))!;
  return { service, D: Number(demo.id), slug: String(demo.slug) };
}

test("a private board's #b= or ?boardId= locator gives another account or a guest nothing, even with a link on", async ({ account, guest, stack }) => {
  test.setTimeout(90_000);
  const owner = await account();
  await openBoard(owner, `${stack.url}?new=1`);
  await drawNode(owner, 'Ledger');
  const B = await boardIdOf(stack, owner);
  const canonical = `${stack.url}#b=${await slugOf(stack, B)}`;
  await expect(owner).toHaveURL(canonical);

  const refused = async (page: Page, href: string) => {
    await page.goto(href);
    await expect(unavailable(page)).toBeVisible();
    await expect(page.locator('#world')).not.toContainText('Ledger');
    await expect(page.locator('#act-share')).toBeHidden();
  };
  const strangerToken = stack.accountToken();
  const stranger = await account(strangerToken);
  await refused(stranger, `${stack.url}?boardId=${B}`);
  await refused(await stranger.context().newPage(), canonical);
  const anon = await guest();
  await refused(anon, `${stack.url}?boardId=${B}`);
  await refused(await anon.context().newPage(), canonical);
  for (const token of [strangerToken, await guestToken(anon)]) {
    await expect(stack.callReducer(token, 'create_node', node(B, 'x'))).rejects.toThrow('not authorized: board is unavailable');
  }
  expect(await labelsOn(stack, B)).toEqual(['Ledger']);

  // SH-20: turning the link on must not open every #b= link ever copied.
  const link = await shareBoard(owner, 'edit');
  await expect(owner.locator('#access-line')).toHaveText(EDIT_LINE);
  expect(await stack.sql(`SELECT mode FROM link_share WHERE board_id = ${B}`)).toEqual([{ mode: 'edit' }]);
  const lateToken = stack.accountToken();
  await refused(await guest(), canonical);
  await refused(await account(lateToken), canonical);
  await expect(stack.callReducer(lateToken, 'create_node', node(B, 'x'))).rejects.toThrow('not authorized: board is unavailable');
  expect(await stack.sql(`SELECT id FROM link_visit WHERE board_id = ${B}`)).toEqual([]);
  expect(await labelsOn(stack, B)).toEqual(['Ledger']);
  // Control: the #s= link itself opens and records a visit, so the empty rows above mean something.
  const linked = await guest();
  await openBoard(linked, link);
  await expect(linked.locator('#world')).toContainText('Ledger');
  expect(await stack.sql(`SELECT id FROM link_visit WHERE board_id = ${B}`)).toHaveLength(1);
});

test('dead or malformed share links show the unavailable screen with a way to a fresh board', async ({ guest, stack }) => {
  test.setTimeout(90_000);
  for (const hash of [`#s=${'cd'.repeat(16)}`, '#s=', '#s=../x', `#s=${'AB'.repeat(16)}`]) {
    const page = await guest();
    await page.goto(stack.url + hash);
    await expect(unavailable(page), hash).toBeVisible();
    await expect(page.getByText(LINK_GONE, { exact: true })).toBeVisible();
    await expect(page.locator('#board-title')).toHaveText('Board unavailable');
    await expect(page.getByRole('link', { name: 'Start a new board' })).toHaveAttribute('href', `${stack.url}?new=1`);
    await expect(page.locator('#act-share')).toBeHidden();
  }
});

test("a stranger on a private board's link starts a fresh board of their own", async ({ guest, stack }) => {
  const owner = await guest();
  await openBoard(owner, stack.url);
  await drawNode(owner, 'Secret');
  const B = await boardIdOf(stack, owner);
  const stranger = await guest();
  await stranger.goto(owner.url());
  const panel = stranger.locator('#board-unavailable');
  await expect(panel).toContainText('It may have been removed, or this link may need a different account.');
  await expect(stranger.locator('#board-title')).toHaveText('Board unavailable');
  await expect(panel.getByRole('link', { name: 'Back to boards' })).toHaveCount(0); // no dashboard in this build
  const start = panel.getByRole('link', { name: 'Start a new board' });
  await expect(start).toHaveAttribute('href', `${stack.url}?new=1`);
  await start.click();
  await expect(stranger.locator('#board-title')).toHaveText('Untitled board');
  await expect(stranger.locator('#canvas-wrap')).toHaveAttribute('aria-busy', 'false');
  await expect(panel).toHaveCount(0);
  await drawNode(stranger, 'Mine');
  const mine = await boardIdOf(stack, stranger);
  expect(mine).not.toBe(B);
  expect(await labelsOn(stack, mine)).toEqual(['Mine']);
  await expect(owner.locator('#world')).toContainText('Secret');
  await expect(owner.locator('#world')).not.toContainText('Mine');
  expect(await labelsOn(stack, B)).toEqual(['Secret']);
});

test('a link for a database this site does not serve is not opened; the home database stays out of the URL', async ({ guest, stack }) => {
  const owner = await guest();
  await openBoard(owner, stack.url);
  await drawNode(owner, 'Atlas');
  const B = await boardIdOf(stack, owner);
  const link = new URL(await shareBoard(owner, 'view'));
  setDb(link, 'other-db', 'redcrayon-e2e'); // a database this build does not serve
  const visitor = await guest();
  await visitor.goto(link.href);
  await expect(visitor.locator('#error-text')).toHaveText('This link is for a database this site does not serve, so it was not opened.');
  // Control: the same link without ?db= opens and records one visit; the refused page still has none.
  const control = await guest();
  link.searchParams.delete('db');
  await openBoard(control, link.href);
  await expect(control.locator('#world')).toContainText('Atlas');
  expect(await stack.sql(`SELECT id FROM link_visit WHERE board_id = ${B}`)).toHaveLength(1);

  // SH-59: ?db= naming this build's own database opens the board and leaves the address bar.
  const slug = await slugOf(stack, B);
  await openBoard(owner, `${stack.url}?db=redcrayon-e2e#b=${slug}`); // STDB_TEST_DB in e2e/stack.ts
  await expect(owner).toHaveURL(`${stack.url}#b=${slug}`);
  await expect(owner.locator('#world')).toContainText('Atlas');
});

test('a team share opens the board to a teammate as an editor, and its removal ends access live', async ({ account, stack }) => {
  test.setTimeout(90_000);
  const ownerToken = stack.accountToken(), mateToken = stack.accountToken();
  const owner = await account(ownerToken);
  await openBoard(owner, `${stack.url}?new=1`);
  await drawNode(owner, 'Team svc');
  const B = await boardIdOf(stack, owner);
  const mate = await account(mateToken);
  await mate.goto(owner.url());
  await expect(unavailable(mate)).toBeVisible(); // private until the team share
  const org = await team(stack, [[await identityOf(owner), 'org:admin'], [await identityOf(mate), 'org:member']]);
  await expect(owner.locator('#access-line')).toHaveText('private');
  await stack.callReducer(ownerToken, 'share_board_with_team', [B, org]);
  await expect(owner.locator('#access-line')).toHaveText('shared with a team');

  await mate.reload();
  await expect(mate.locator('#world')).toContainText('Team svc');
  await expect(mate.locator('#access-line')).toHaveText('shared with a team');
  await expect(mate.locator('#act-share')).toBeHidden();
  await expect(owner.locator('#board-title')).toHaveClass(/renamable/);
  await expect(mate.locator('#board-title')).toHaveText('Untitled board');
  await expect(mate.locator('#board-title')).not.toHaveClass(/renamable/);
  await palette(owner, 'board');
  await expect(owner.locator('#palette-list')).toContainText('Rename board');
  await expect(owner.locator('#palette-list')).toContainText('Delete this board');
  await owner.keyboard.press('Escape');
  await palette(mate, 'board');
  await expect(mate.locator('#palette-list')).toContainText('Keyboard shortcuts');
  await expect(mate.locator('#palette-list')).not.toContainText('Rename board');
  await expect(mate.locator('#palette-list')).not.toContainText('Delete this board');
  await mate.keyboard.press('Escape');
  await drawNode(mate, 'Teammate');
  await expect(owner.locator('#world')).toContainText('Teammate');
  for (const [reducer, args, verb] of [['rename_board', [B, 'x'], 'rename'], ['delete_board', [B], 'delete']] as const) {
    await expect(stack.callReducer(mateToken, reducer, [...args]), reducer).rejects.toThrow(`share rule: only an owner of board ${B} can ${verb} it`);
  }
  expect(await stack.sql(`SELECT name FROM board WHERE id = ${B}`)).toEqual([{ name: 'Untitled board' }]);

  await stack.callReducer(ownerToken, 'unshare_board_from_team', [B, org]);
  await expect(unavailable(mate)).toBeVisible();
  await expect(mate.locator('#world')).toBeHidden();
  await expect(owner.locator('#access-line')).toHaveText('private');
  await mate.reload();
  await expect(unavailable(mate)).toBeVisible();
  await expect(mate.locator('#world')).not.toContainText('Team svc');
  await expect(stack.callReducer(mateToken, 'create_node', node(B, 'x'))).rejects.toThrow('not authorized: board is unavailable');
  expect(await labelsOn(stack, B)).toEqual(['Team svc', 'Teammate']);
});

test("a teammate who opens the owner's link keeps team access after the link stops", async ({ account, stack }) => {
  test.setTimeout(90_000);
  const ownerToken = stack.accountToken(), mateToken = stack.accountToken();
  const owner = await account(ownerToken);
  await openBoard(owner, `${stack.url}?new=1`);
  await drawNode(owner, 'Team ledger');
  const B = await boardIdOf(stack, owner);
  const canonical = owner.url();
  const probe = await account(mateToken);
  await probe.goto(canonical);
  await expect(unavailable(probe)).toBeVisible();
  const org = await team(stack, [[await identityOf(owner), 'org:admin'], [await identityOf(probe), 'org:member']]);
  await stack.callReducer(ownerToken, 'share_board_with_team', [B, org]);
  const link = await shareBoard(owner, 'view');

  const mate = await probe.context().newPage();
  await probe.close();
  await openBoard(mate, link);
  await expect(mate.locator('#world')).toContainText('Team ledger');
  // The team grant outranks the view link: no "view only", and edits go through.
  await expect(mate.locator('#board-title')).toHaveText('Untitled board');
  await expect(mate.locator('#access-line')).toHaveText('shared with a team');
  await drawNode(mate, 'Team edit');
  await expect(owner.locator('#world')).toContainText('Team edit');

  await owner.getByRole('switch', { name: 'Share with link' }).uncheck();
  await expect(owner.locator('#access-line')).toHaveText('shared with a team');
  expect(await stack.sql(`SELECT board_id FROM link_share WHERE board_id = ${B}`)).toEqual([]);
  // A write after the stop reaching the open tab proves it has the stop too.
  await stack.callReducer(ownerToken, 'create_node', node(B, 'After stop', 800, 600));
  await expect(mate.locator('#world')).toContainText('After stop');
  await expect(mate.locator('#board-unavailable')).toHaveCount(0);
  await expect(mate.getByText('This link is no longer shared.', { exact: false })).toHaveCount(0);
  await stack.callReducer(mateToken, 'create_node', node(B, 'Mate after stop', 800, 800));
  await expect(owner.locator('#world')).toContainText('Mate after stop');

  // TR07: the revoked #s= URL fails on reload; the board's own link still opens through the team.
  await mate.reload();
  await expect(mate.getByText(LINK_GONE, { exact: true })).toBeVisible();
  const again = await mate.context().newPage();
  await openBoard(again, canonical);
  await expect(again.locator('#world')).toContainText('Mate after stop');
  await expect(again.locator('#access-line')).toHaveText('shared with a team');
});

test('the server refuses share administration and deletion from a link editor', async ({ account, stack }) => {
  test.setTimeout(90_000);
  const owner = await account();
  await openBoard(owner, `${stack.url}?new=1`);
  await drawNode(owner, 'svc');
  const B = await boardIdOf(stack, owner);
  const link = await shareBoard(owner, 'edit');
  const editorToken = stack.accountToken();
  const editor = await account(editorToken);
  await openBoard(editor, link);
  await expect(editor.locator('#world')).toContainText('svc');
  await expect(editor.locator('#act-share')).toBeHidden();
  const agent = await linkedAgent(stack, editorToken);
  const attempts: [string, unknown[], string][] = [
    ['set_link_share', [B, 'view', 'ab'.repeat(16)], 'share'],
    ['stop_link_share', [B], 'unshare'],
    ['rename_board', [B, 'x'], 'rename'],
    ['delete_board', [B], 'delete'],
    ['grant_agent_board', [B, { __identity__: `0x${agent.identity}` }], 'share'],
  ];
  for (const [reducer, args, verb] of attempts) {
    await expect(stack.callReducer(editorToken, reducer, args), reducer).rejects.toThrow(`share rule: only an owner of board ${B} can ${verb} it`);
  }
  expect(await stack.sql(`SELECT name FROM board WHERE id = ${B}`)).toEqual([{ name: 'Untitled board' }]);
  expect(await stack.sql(`SELECT mode FROM link_share WHERE board_id = ${B}`)).toEqual([{ mode: 'edit' }]);
  expect(await stack.sql(`SELECT id FROM agent_grant WHERE board_id = ${B}`)).toEqual([]);
  await expect(owner.locator('#access-line')).toHaveText(EDIT_LINE);
  await expect(owner.locator('#world')).toContainText('svc');
  await editor.reload();
  await expect(editor.locator('#world')).toContainText('svc');
  await expect(editor.locator('#access-line')).toHaveText(EDIT_LINE);
});

test('the server refuses the writes the canvas blocks, for a guest on an edit link and an account on a view link', async ({ account, guest, stack }) => {
  test.setTimeout(90_000);
  const owner = await account();
  await openBoard(owner, `${stack.url}?new=1`);
  await drawNode(owner, 'Intake');
  const B = await boardIdOf(stack, owner);
  const link = await shareBoard(owner, 'edit');
  const anon = await guest();
  await openBoard(anon, link);
  await expect(anon.locator('#world')).toContainText('Intake');
  await expect(anon.getByRole('button', { name: 'sign in to edit', exact: true })).toBeVisible();
  await expect(stack.callReducer(await guestToken(anon), 'create_node', node(B, 'x'))).rejects.toThrow('not authorized: board is read only');

  const view = owner.getByRole('button', { name: 'Can view', exact: true });
  await view.click();
  await expect(view).toHaveAttribute('aria-pressed', 'true');
  const viewerToken = stack.accountToken();
  const viewer = await account(viewerToken);
  await openBoard(viewer, link);
  await expect(viewer.locator('#board-title')).toHaveText('Untitled board · view only');
  await expect(stack.callReducer(viewerToken, 'create_node', node(B, 'x'))).rejects.toThrow('not authorized: board is read only');
  await expect(owner.locator('#world g.node')).toHaveCount(1);
  expect(await labelsOn(stack, B)).toEqual(['Intake']);
});

test('the public Demo is read-only for visitors', async ({ guest, stack }) => {
  test.setTimeout(90_000);
  const { D, slug } = await seedDemo(stack);
  const visitor = await guest();
  await openBoard(visitor, `${stack.url}#b=${slug}`);
  await expect(visitor.locator('#world')).toContainText('API Gateway');
  await expect(visitor.locator('#board-title')).toHaveText('Demo · view only');
  await expect(visitor.locator('#access-line')).toHaveText(PUBLIC_LINE);
  await expect(visitor.locator('#rail-hint')).toHaveText('Public example. Explore the drawing or export it. Start a new board to draw.');
  const rows = visitor.locator('.add-row');
  await expect(rows).toHaveCount(6);
  for (const row of await rows.all()) await expect(row).toBeDisabled();
  await expect(visitor.locator('#tool-crayon')).toBeDisabled();

  const nodes = visitor.locator('#world g.node');
  const shown = await nodes.count();
  const stored = (await labelsOn(stack, D)).length;
  await visitor.keyboard.press('1');
  await visitor.locator('#board').click({ position: { x: 1100, y: 620 } }); // open canvas, clear of the drawing
  await visitor.keyboard.press('Escape');
  await serverCaughtUp(stack, visitor, nodes.first());
  await expect(nodes).toHaveCount(shown);
  expect(await labelsOn(stack, D)).toHaveLength(stored);

  await palette(visitor, 'board');
  await expect(visitor.locator('#palette-list')).toContainText('Keyboard shortcuts');
  await expect(visitor.locator('#palette-list')).not.toContainText('Rename board');
  await expect(visitor.locator('#palette-list')).not.toContainText('Delete this board');
  // 'place' still fuzzy-matches "Replay trace"; the six Place commands are gone.
  await visitor.locator('#palette-input').fill('place');
  await expect(visitor.locator('#palette-list')).toContainText('Replay trace');
  await expect(visitor.locator('#palette-list')).not.toContainText(/Place (service|datastore|external|boundary|note|text)/);
  await visitor.keyboard.press('Escape');
  await expect(stack.callReducer(await guestToken(visitor), 'create_node', node(D, 'x'))).rejects.toThrow('not authorized: board is read only');

  // HS-25: Redis and its cache edge ship hidden as "runtime plumbing"; the chip reveals them as ghosts.
  const chip = visitor.locator('#chips-row .chip', { hasText: 'runtime plumbing' });
  await expect(chip).toHaveText('runtime plumbing 2');
  await expect(visitor.locator('#world')).not.toContainText('Redis');
  await chip.click();
  const ghost = visitor.locator('#world g.node.ghost');
  await expect(ghost).toHaveCount(1);
  await expect(ghost).toContainText('Redis');
  await expect(ghost.locator('.ghost-caption')).toHaveText('hidden · runtime plumbing');
  await expect(visitor.locator('#world .edge-line.ghost')).toHaveCount(1);
});

test('the Demo resets itself after an idle spell, never over a fresh write', async ({ guest, stack }) => {
  test.setTimeout(90_000);
  const { service, D, slug } = await seedDemo(stack);
  const visitor = await guest();
  await openBoard(visitor, `${stack.url}#b=${slug}`);
  await expect(visitor.locator('#world')).toContainText('API Gateway');
  // Any service account writes Demo (isBoardMember), whoever seeded it.
  await stack.callReducer(service.token, 'create_node', node(D, 'Stray', 1200, 1200));
  await expect(visitor.locator('#world')).toContainText('Stray');

  // No reset row reads as changed since the last reset, which an earlier run in this stack may have left;
  // with it gone, recency is the only thing between these two reset_demo calls.
  await stack.sql(`DELETE FROM demo_reset WHERE board_id = ${D}`);
  // BL-34: the write is under 10 minutes old, so the cron's reset leaves it.
  await stack.callReducer(service.token, 'reset_demo', []);
  expect(await labelsOn(stack, D)).toContain('Stray');
  await expect(visitor.locator('#world')).toContainText('Stray');

  // SQL cannot backdate a write: no stats row reads as idle (verify-demo-reset-local.mjs).
  await stack.sql(`DELETE FROM board_stats WHERE board_id = ${D}`);
  await stack.callReducer(service.token, 'reset_demo', []);
  await expect(visitor.locator('#world')).not.toContainText('Stray');
  await expect(visitor.locator('#world g.node')).toHaveCount(8); // the seed: 9 nodes, Redis hidden
  await expect(visitor.locator('#chips-row .chip')).toHaveText('runtime plumbing 2'); // HS-25: the reset re-seeds the set
  expect(await labelsOn(stack, D)).toHaveLength(9);
  await expect(visitor.locator('#board-unavailable')).toHaveCount(0);
  await expect(visitor.locator('#board-title')).toHaveText('Demo · view only');
  await expect(visitor).toHaveURL(`${stack.url}#b=${slug}`);
  expect(await stack.sql(`SELECT id FROM board WHERE id = ${D}`)).toHaveLength(1);
  expect(await stack.sql(`SELECT board_id FROM public_board WHERE board_id = ${D}`)).toHaveLength(1);
});

test('a public board shows its drawing and code to any reader, never its threats or marks', async ({ account, guest, stack }) => {
  test.setTimeout(120_000);
  const token = stack.accountToken();
  const owner = await account(token, { viewport: { width: 1440, height: 900 } });
  await openBoard(owner, `${stack.url}?new=1`);
  await drawNode(owner, 'auth-svc');
  await drawNode(owner, 'users-db');
  await drawEdge(owner, 0, 1);
  const [auth, users] = await owner.locator('#world g.node').evaluateAll(nodes => nodes.map(n => Number(n.getAttribute('data-id'))));
  const B = await boardIdOf(stack, owner);
  await stack.callReducer(token, 'add_repo_files', [B, ['src/auth.ts']]);
  // No snippet: this owner never agreed to store code (RC-690), and the ref still shows.
  await stack.callReducer(token, 'add_code_ref', [B, 'node', auth, 'src/auth.ts', 'verify', 1, 1, SHA, '', 'e2e']);
  await stack.callReducer(token, 'set_session_remote', [B, 'https://github.com/acme/api', HEAD, []]);
  const addThreat = (anchor: number, title: string) =>
    stack.callReducer(token, 'add_threat', [B, anchor, 'compromised', 'critical', title, 'Anyone can forge tokens.', '', '', '', '[]', '', 'e2e']);
  await addThreat(auth, 'Forged session tokens');
  await expect(marker(owner)).toHaveCount(1);

  // One sent round of marks, as review.spec.ts sends it.
  await owner.keyboard.press('c');
  await expect(owner.locator('#tool-crayon')).toHaveClass(/armed/);
  await owner.locator(`#world g[data-id="${auth}"] .node-rect`).click({ position: { x: 12, y: 12 } });
  await expect(owner.locator('.mark-note textarea')).toBeFocused();
  await owner.keyboard.press('Escape');
  await expect(owner.locator('#mark-send')).toHaveText('Send 1 mark');
  await owner.locator('#mark-send').click();
  await expect(owner.locator('#mark-banner')).toHaveText('No agent listening');
  await expect(owner.locator('#crayon .mark')).toHaveCount(1);
  await expect(owner.locator('#act-review')).toBeVisible();
  expect(await stack.sql(`SELECT id FROM mark WHERE board_id = ${B}`)).toHaveLength(1);
  await expect.poll(() => cached(owner, 'visibleThreat')).toBe(1);
  await expect.poll(() => cached(owner, 'visibleMark')).toBe(1);

  const slug = await slugOf(stack, B);
  await stack.sql(`INSERT INTO public_board (board_id) VALUES (${B})`);
  try {
    const readerToken = stack.accountToken();
    const anon = await guest();
    const reader = await account(readerToken);
    for (const page of [anon, reader]) {
      await openBoard(page, `${stack.url}#b=${slug}`);
      await expect(page.locator('#world')).toContainText('auth-svc');
      await expect(page.locator('#world')).toContainText('users-db');
      await expect(page.locator('#world g.edge')).toHaveCount(1);
      await expect(page.locator('#access-line')).toHaveText(PUBLIC_LINE);
      await expect(page.locator('#board-title')).toHaveText('Untitled board · view only');
      await page.locator('#world g.node', { hasText: 'auth-svc' }).locator('.node-rect').click();
      await expect(page.locator('#inspector .insp-ref-sym')).toHaveText('verify');
      await expect(page.locator('#inspector a[data-act="github"]')).toHaveAttribute('href', `https://github.com/acme/api/blob/${HEAD}/src/auth.ts#L1-L1`);
      await expect(marker(page)).toHaveCount(0);
      await expect(page.locator('#crayon .mark')).toHaveCount(0);
      await expect(page.locator('#act-review')).toBeHidden();
      await expect(page.locator('#mark-banner')).toBeHidden();
      await expect(page.locator('#tool-crayon')).toBeDisabled();
    }
    for (const t of [await guestToken(anon), readerToken]) {
      await expect(stack.callReducer(t, 'create_node', node(B, 'x'))).rejects.toThrow('not authorized: board is read only');
    }

    // A threat added while they read never reaches them; the write after it proves they are current.
    await addThreat(users, 'Open admin port');
    await expect(marker(owner)).toHaveCount(2);
    await stack.callReducer(token, 'create_node', node(B, 'late', 800, 600));
    await expect.poll(() => cached(owner, 'visibleThreat')).toBe(2);
    for (const page of [anon, reader]) {
      await expect(page.locator('#world')).toContainText('late');
      await expect(marker(page)).toHaveCount(0);
      // The server never sent them a threat or mark row; the code ref row did arrive.
      expect(await cached(page, 'visibleCodeRef')).toBe(1);
      expect(await cached(page, 'visibleThreat')).toBe(0);
      expect(await cached(page, 'visibleMark')).toBe(0);
    }
  } finally {
    await stack.sql(`DELETE FROM public_board WHERE board_id = ${B}`);
  }
});
