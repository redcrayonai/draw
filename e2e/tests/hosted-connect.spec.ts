import { randomBytes } from 'node:crypto';
import type { Locator, Page } from '@playwright/test';
import { test, expect, openBoard, drawNode, shareBoard, signInOnRequest, boardIdOf, palette, confirmBoardDelete, guestToken, type Stack } from '../fixtures';

// A hosted-style build: the Connect dialog and its account gate, the dashboard link and
// redirects, the privacy link, and OIDC client ids (azp or aud) under issuer enforcement.
// The module requires the session claim 'sid', as a hosted service with such an issuer does;
// every stack.accountToken() carries one unless a test drops it.
test.use({
  clientEnv: { VITE_MCP_URL: 'https://mcp.e2e.invalid/mcp', VITE_DASHBOARD_URL: 'https://dash.e2e.invalid', VITE_PRIVACY_URL: 'https://example.test/privacy' },
  moduleEnv: { BROWSER_CLIENT_IDS: 'e2e-client', BROWSER_SESSION_CLAIM: 'sid' },
});

const MCP = 'https://mcp.e2e.invalid/mcp';
const DASHBOARD = 'https://dash.e2e.invalid/dashboard';
const PRIVACY = 'https://example.test/privacy';
const ADD = `claude mcp add --transport http --scope user draw ${MCP}`;
const PROMPT = 'Open a redcrayon board for this task and draw what you build on it as you go.';
const LEAD = 'Your agent opens a board for its task and draws what it builds. It signs in as you and shows as agent of Test account.';
const FOOTER = [
  'Drawing needs only the URL. To check code refs, redcrayon uploads each file your agent cites and deletes it within 10 minutes. It keeps paths, line numbers, git hashes, hashes of the cited lines and the GitHub repo address. It keeps the cited lines themselves only if you turn on storing code.',
  'Boards your agent opens are private to your account until you share them from your dashboard.',
];
const SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const TROUBLE = 'We’re having trouble connecting';
const AGENT = 'agent of Test account';
const ON = /(^|\s)on(\s|$)/; // the class 'on', not the 'on' in connect-live

const dialog = (page: Page) => page.locator('#connect');
const me = (page: Page) => page.evaluate(() => (window as any).myIdentityHex as string);
/** SQL returns identities wrapped; compare them as bare lowercase hex, as window.myIdentityHex is. */
const hexOf = (value: unknown) => JSON.stringify(value).match(/[0-9a-f]{64}/i)![0].toLowerCase();
const owners = async (stack: Stack, B: number) =>
  (await stack.sql(`SELECT grantee, role FROM board_grant WHERE board_id = ${B}`)).filter(row => row.role === 'owner').map(row => hexOf(row.grantee));
const participants = async (stack: Stack) => (await stack.sql('SELECT identity FROM participant')).length;

/** ⌘K, then Enter on the command once it is the highlighted row. */
async function runCommand(page: Page, query: string, title: string) {
  await palette(page, query);
  await expect(page.locator('#palette-list [role=option][aria-selected=true]')).toContainText(title);
  await page.keyboard.press('Enter');
}

/** The dashboard is not served here: answer its origin so a redirect lands on a page. */
async function stubDashboard(page: Page) {
  await page.context().route('https://dash.e2e.invalid/**', route => route.fulfill({ contentType: 'text/html', body: 'dashboard' }));
}

async function openConnect(page: Page) {
  await page.locator('#act-connect').click();
  await expect(dialog(page)).toBeVisible();
}

test('the header button, the palette and the empty state each open Connect', async ({ account, stack }) => {
  const page = await account();
  await openBoard(page, `${stack.url}?new=1`);
  const opener = page.locator('#act-connect');
  await expect(opener).toHaveAttribute('aria-label', 'Connect an agent');
  await expect(opener).toHaveAttribute('title', 'Connect a coding agent');
  await openConnect(page);
  await expect(page.locator('#connect-title')).toHaveText('Connect an agent');
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeHidden();

  // 'mcp' finds it by its keyword; a title hit (a theme) can rank above it, so pick the row.
  await palette(page, 'mcp');
  await page.locator('#palette-list [role=option]', { hasText: 'Connect an agent' }).click();
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeHidden();

  await expect(page.locator('#empty-connect')).toHaveText('connect an agent');
  await page.locator('#empty-connect').click();
  await expect(dialog(page)).toBeVisible();
});

test('a guest who presses Connect gets sign-in, and a cancel keeps the board', async ({ guest, stack }) => {
  const g = await guest();
  await openBoard(g, `${stack.url}?new=1`);
  const B = await boardIdOf(stack, g);
  const guestHex = await me(g);
  // Each sign-in request first offers the board for claiming under a fresh code (guest-handoff.ts).
  const offerCode = async () => (await stack.sql(`SELECT code FROM guest_claim_offer WHERE board_id = ${B}`))[0]?.code;
  // Nothing queued with signInOnRequest: the provider's sign-in is cancelled.
  async function cancelledSignIn(press: () => Promise<unknown>, previous: unknown) {
    await press();
    await expect.poll(offerCode).not.toEqual(previous);
    await expect(g.locator('#sign-in')).toBeEnabled(); // disabled until the sign-in ends
    await expect(dialog(g)).toBeHidden();
    return offerCode();
  }

  const fromEmpty = await cancelledSignIn(() => g.locator('#empty-connect').click(), undefined);
  await drawNode(g, 'Guest work');
  const url = g.url();
  const fromHeader = await cancelledSignIn(() => g.locator('#act-connect').click(), fromEmpty);
  await cancelledSignIn(() => runCommand(g, 'Connect an agent', 'Connect an agent'), fromHeader);
  await expect(g).toHaveURL(url);
  await expect(g.locator('#world')).toContainText('Guest work');
  await expect(g.locator('#act-share')).toBeVisible();
  await expect(g.locator('#board-title')).toHaveClass(/renamable/);
  expect(await owners(stack, B)).toEqual([guestHex]);
});

test('a guest who signs in from Connect keeps the drawing, and Connect then names their agent', async ({ guest, stack }) => {
  const g = await guest();
  await openBoard(g, `${stack.url}?new=1`);
  await drawNode(g, 'Guest work');
  const url = g.url();
  const B = await boardIdOf(stack, g);
  const guestHex = await me(g);

  signInOnRequest(g, stack.accountToken());
  await g.locator('#act-connect').click();
  await expect(g.locator('#account-name')).toHaveText('Test account');
  await expect(g).toHaveURL(url);
  await expect(g.locator('#world')).toContainText('Guest work');
  await expect(dialog(g)).toBeHidden(); // the reload does not open the guide by itself
  const accountHex = await me(g);
  expect(accountHex).not.toBe(guestHex);
  await expect.poll(() => owners(stack, B)).toEqual([accountHex]);

  await openConnect(g);
  await expect(g.locator('#connect-lead')).toHaveText(LEAD);
});

test('the Connect dialog lists five clients with the exact commands, and remembers the tab', async ({ account, stack }) => {
  const page = await account(undefined, { permissions: ['clipboard-read', 'clipboard-write'] });
  await openBoard(page, `${stack.url}?new=1`);
  await openConnect(page);
  const tabs = page.locator('#connect-tabs [role=tab]');
  const tab = (name: string) => page.getByRole('tab', { name, exact: true });
  await expect(tabs).toHaveText(['Claude Code', 'Cursor', 'Codex', 'claude.ai', 'Other']);
  await expect(tab('Claude Code')).toHaveAttribute('aria-selected', 'true');

  const claude = page.locator('#connect-pane-claude');
  await expect(claude).toBeVisible();
  await expect(claude.locator('code')).toHaveText([ADD, PROMPT]);
  await expect(claude.locator('.connect-step-title')).toHaveText(['Add the server', 'Sign in', 'Start drawing']);
  // No plugin step, navigate skill box or capture note in any pane (hidden ones included).
  const panes = page.locator('#connect-panes');
  await expect(panes).toContainText(PROMPT);
  for (const gone of ['npx', '/redcrayon:navigate', 'plugin']) await expect(panes).not.toContainText(gone);

  // AG-29: each copy button puts its exact text on the clipboard.
  const copies = async (pane: Locator, name: string, text: string) => {
    const copy = pane.getByRole('button', { name: `Copy the ${name}`, exact: true });
    await copy.click();
    await expect(copy).toHaveText('copied');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(text);
  };
  await copies(claude, 'add command', ADD);
  await copies(claude, 'prompt', PROMPT);

  await tab('Cursor').click();
  const config = encodeURIComponent(Buffer.from(JSON.stringify({ url: MCP })).toString('base64'));
  await expect(page.locator('#connect-pane-cursor a.connect-cursor')).toHaveAttribute('href', `cursor://anysphere.cursor-deeplink/mcp/install?name=draw&config=${config}`);
  await tab('claude.ai').click();
  await expect(page.locator('#connect-pane-claude-ai code').first()).toHaveText(MCP);
  await tab('Other').click();
  await expect(page.locator('#connect-pane-other code').first()).toHaveText(MCP);
  await tab('Codex').click();
  const codex = page.locator('#connect-pane-codex');
  await expect(codex.locator('code')).toHaveText([`codex mcp add draw --url ${MCP}`, 'codex mcp login draw', PROMPT]);
  await copies(codex, 'login command', 'codex mcp login draw');
  await expect(page.locator('#connect-foot p')).toHaveText([...FOOTER, 'Privacy policy']);
  await expect(page.locator('#connect-foot a')).toHaveAttribute('href', PRIVACY);

  // AG-27: the last tab chosen reopens after a reload.
  await page.reload();
  await expect(page.locator('#canvas-wrap')).toHaveAttribute('aria-busy', 'false');
  await openConnect(page);
  await expect(tab('Codex')).toHaveAttribute('aria-selected', 'true');
  await expect(tab('Codex')).toBeFocused();
  await expect(codex).toBeVisible();
  await expect(claude).toBeHidden();

  // Roving tabindex: arrows wrap, Home and End jump.
  await tab('Other').click();
  await expect(tab('Other')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(tab('Claude Code')).toBeFocused();
  await expect(tab('Claude Code')).toHaveAttribute('aria-selected', 'true');
  await expect(claude).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  await expect(tab('Other')).toBeFocused();
  await expect(tab('Other')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Home');
  await expect(tab('Claude Code')).toBeFocused();
  await page.keyboard.press('End');
  await expect(tab('Other')).toBeFocused();
  await expect(tab('Other')).toHaveAttribute('aria-selected', 'true');
  await expect(tabs.and(page.locator('[tabindex="0"]'))).toHaveText(['Other']);
});

test('Connect is modal: Esc and the backdrop close it, focus returns, and Tab stays inside', async ({ account, stack }) => {
  const page = await account();
  await openBoard(page, `${stack.url}?new=1`);
  await drawNode(page, 'api');
  const crayon = page.locator('#tool-crayon');
  const opener = page.locator('#act-connect');

  await openConnect(page);
  await page.keyboard.press('c');
  await expect(crayon).not.toHaveClass(/armed/);
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeHidden();
  await expect(opener).toBeFocused();
  // The same key does arm the crayon once the dialog is gone.
  await page.keyboard.press('c');
  await expect(crayon).toHaveClass(/armed/);
  await page.keyboard.press('c');
  await expect(crayon).not.toHaveClass(/armed/);

  await openConnect(page);
  await page.mouse.click(5, 5); // the backdrop, outside the panel
  await expect(dialog(page)).toBeHidden();
  await expect(opener).toBeFocused();

  await openConnect(page);
  for (let i = 0; i < 15; i++) {
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement?.closest('#connect-panel') !== null), `Tab ${i + 1} left the dialog`).toBe(true);
  }
  await page.keyboard.press('Shift+Tab');
  expect(await page.evaluate(() => document.activeElement?.closest('#connect-panel') !== null)).toBe(true);
  await expect(crayon).not.toHaveClass(/armed/);
});

test('Connect opened from ⌘K returns focus to the header button', async ({ account, stack }) => {
  // divergent (AG-28): the palette blurs its input as it closes, so open() records <body> as the opener and Escape leaves focus on <body>
  test.fail();
  const page = await account();
  await openBoard(page, `${stack.url}?new=1`);
  await runCommand(page, 'Connect an agent', 'Connect an agent');
  await expect(dialog(page)).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Claude Code', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeHidden();
  await expect(page.locator('#act-connect')).toBeFocused({ timeout: 3_000 });
});

test("the live line follows the person's agent across boards", async ({ account, guest, stack }) => {
  test.setTimeout(90_000);
  const token = stack.accountToken();
  const owner = await account(token);
  await openBoard(owner, `${stack.url}?new=1`);
  await drawNode(owner, 'api');
  const B1 = await boardIdOf(stack, owner);
  await openConnect(owner);
  const live = owner.locator('#connect-live');
  const line = owner.locator('#connect-live-text');
  await expect(owner.locator('#connect-lead')).toHaveText(LEAD);
  await expect(line).toHaveText('Waiting for your agent.');
  await expect(live).not.toHaveClass(ON);

  // The agent stand-in holds a socket, so its selection row lasts (the module drops an HTTP caller's).
  const agentPage = await guest();
  await openBoard(agentPage, `${stack.url}?new=1`);
  await drawNode(agentPage, 'agent work');
  const G = await boardIdOf(stack, agentPage);
  const agentHex = await me(agentPage);
  const code = randomBytes(32).toString('base64url');
  await stack.callReducer(await guestToken(agentPage), 'offer_agent_link', [code]);
  await stack.callReducer(token, 'redeem_agent_link', [code]);
  await agentPage.evaluate(name => (window as any).conn.reducers.joinBoard({ displayName: name, kind: 'agent' }), AGENT);
  const [{ slug: slugG }] = await stack.sql(`SELECT slug FROM board WHERE id = ${G}`);

  await expect(line).toHaveText(`${AGENT} is drawing on Untitled board. open`);
  await expect(owner.locator('a.connect-open')).toHaveAttribute('href', `${stack.url}#b=${slugG}`);
  await expect(live).toHaveClass(ON);
  await expect(live).toHaveAttribute('aria-live', 'polite');

  await stack.callReducer(token, 'grant_agent_board', [B1, { __identity__: `0x${agentHex}` }]);
  // A fresh load on B1: a hash-only goto keeps the open board.
  await agentPage.goto(owner.url());
  await agentPage.reload();
  await expect(agentPage.locator('#canvas-wrap')).toHaveAttribute('aria-busy', 'false');
  await expect(agentPage.locator('#world')).toContainText('api');
  // Selected, as a drawing agent is: the reload's old socket can close after the new one wrote an empty selection.
  await agentPage.locator('#world g.node', { hasText: 'api' }).locator('.node-rect').click();
  await agentPage.evaluate(name => (window as any).conn.reducers.joinBoard({ displayName: name, kind: 'agent' }), AGENT);
  await expect(line).toHaveText(`${AGENT} is drawing on this board.`);
  await expect(owner.locator('a.connect-open')).toHaveCount(0);
  await expect(live).toHaveClass(ON);
  await expect(dialog(owner)).toBeVisible();
});

test("a signed-in viewer's Boards crumb and ⌘K reach the dashboard; the no-code note links the privacy policy", async ({ account, guest, stack }) => {
  test.setTimeout(90_000);
  const token = stack.accountToken();
  const page = await account(token);
  await stubDashboard(page);
  await openBoard(page, `${stack.url}?new=1`);
  const crumb = page.locator('#crumb-boards');
  await expect(crumb).toBeVisible();
  await expect(crumb).toHaveAttribute('href', DASHBOARD);
  await expect(crumb).toHaveAttribute('title', 'Back to boards');

  // CC-10: a ref with no stored code links the build's privacy policy.
  await drawNode(page, 'auth-svc');
  const B = await boardIdOf(stack, page);
  const nodeId = Number(await page.locator('#world g.node').first().getAttribute('data-id'));
  await stack.callReducer(token, 'add_repo_files', [B, ['src/auth.ts']]);
  await stack.callReducer(token, 'add_code_ref', [B, 'node', nodeId, 'src/auth.ts', 'verify', 1, 1, SHA, '', 'e2e']);
  await page.locator('#world g.node', { hasText: 'auth-svc' }).locator('.node-rect').click();
  const note = page.locator('#inspector .insp-ref-note', { hasText: 'No code stored for this reference.' });
  await expect(note).toBeVisible();
  const privacy = note.locator('a[data-act="privacy"]');
  await expect(privacy).toHaveText('Privacy policy');
  await expect(privacy).toHaveAttribute('href', PRIVACY);
  await expect(privacy).toHaveAttribute('target', '_blank');
  await expect(privacy).toHaveAttribute('rel', 'noopener noreferrer');
  await page.keyboard.press('Escape');

  // BL-07: an unavailable board offers the way back too.
  const missing = await account(token);
  await openBoard(missing, `${stack.url}#b=nosuchboard00000000`);
  const back = missing.locator('#board-unavailable a', { hasText: 'Back to boards' });
  await expect(back).toBeVisible();
  await expect(back).toHaveAttribute('href', DASHBOARD);

  await palette(page, 'dashboard');
  await expect(page.locator('#palette-list [role=option][aria-selected=true]')).toContainText('Go to dashboard');
  await expect(page.locator('#palette-preview')).toHaveText('all boards');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(DASHBOARD);

  // A guest gets neither.
  const g = await guest();
  await openBoard(g, `${stack.url}?new=1`);
  await expect(g.locator('#act-connect')).toBeVisible(); // the hosted build loaded
  await expect(g.locator('#crumb-boards')).toBeHidden();
  await palette(g, 'mcp');
  await expect(g.locator('#palette-list')).toContainText('Connect an agent'); // the list is filled
  await g.locator('#palette-input').fill('dashboard');
  await expect(g.locator('#palette-list')).not.toContainText('Go to dashboard');
});

test('a signed-in bare root opens the dashboard, and a delete lands there too', async ({ account, guest, stack }) => {
  test.setTimeout(90_000);
  const root = await account();
  await stubDashboard(root);
  await root.goto(stack.url);
  await expect(root).toHaveURL(DASHBOARD);

  const page = await account();
  await stubDashboard(page);
  await openBoard(page, `${stack.url}?new=1`);
  await expect(page.locator('#account-name')).toHaveText('Test account');
  await expect(page).toHaveURL(new RegExp(`^${stack.url}#b=`));
  await drawNode(page, 'Doomed');
  const boardLink = page.url();
  // A board link opens the canvas for an account too.
  await page.reload();
  await expect(page.locator('#canvas-wrap')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('#world')).toContainText('Doomed');
  await expect(page).toHaveURL(boardLink);

  const g = await guest();
  await openBoard(g, stack.url);
  await expect(g.locator('#board-title')).toHaveText('Untitled board');
  await expect(g).toHaveURL(new RegExp(`^${stack.url}#b=`));

  // BL-31: after a delete, the account owner goes to the dashboard, the guest owner to a fresh board.
  const B = await boardIdOf(stack, page);
  await runCommand(page, 'delete this board', 'Delete this board');
  await confirmBoardDelete(page);
  await expect(page).toHaveURL(DASHBOARD);
  expect(await stack.sql(`SELECT id FROM board WHERE id = ${B}`)).toEqual([]);

  await drawNode(g, 'Guest doomed');
  const guestHref = g.url();
  const GB = await boardIdOf(stack, g);
  await runCommand(g, 'delete this board', 'Delete this board');
  await confirmBoardDelete(g);
  await expect(g).not.toHaveURL(guestHref);
  await expect(g.locator('#canvas-wrap')).toHaveAttribute('aria-busy', 'false');
  await expect(g.locator('#board-title')).toHaveText('Untitled board');
  await expect(g.locator('#world g.node')).toHaveCount(0);
  await expect(g).toHaveURL(new RegExp(`^${stack.url}#b=`));
  expect(await stack.sql(`SELECT id FROM board WHERE id = ${GB}`)).toEqual([]);
});

test('a token is an account when its azp or aud names a configured client, and is refused otherwise', async ({ account, stack }) => {
  test.setTimeout(90_000);
  const owner = await account();
  await openBoard(owner, `${stack.url}?new=1`);
  await drawNode(owner, 'Owner work');
  const link = await shareBoard(owner, 'edit');
  await owner.locator('#act-share').click(); // closes the share menu

  // Accepted: azp is the client id, or no azp and aud lists it.
  for (const [claims, label] of [[{ azp: 'e2e-client' }, 'By azp'], [{ azp: undefined, aud: 'e2e-client' }, 'By aud']] as const) {
    const editor = await account(stack.accountToken(claims));
    await openBoard(editor, link);
    await expect(editor.locator('#account-name')).toHaveText('Test account');
    await expect(editor.locator('#world')).toContainText('Owner work');
    await drawNode(editor, label);
    await expect(owner.locator('#world')).toContainText(label);
  }

  // Refused at connect: aud names another client, or azp an unknown one.
  for (const claims of [{ azp: undefined, aud: 'other-client' }, { azp: 'https://evil.example' }]) {
    const before = await participants(stack);
    const bad = stack.accountToken(claims);
    const page = await account(bad);
    await page.goto(`${stack.url}?new=1`);
    await expect(page.locator('#reconnect')).toContainText(TROUBLE);
    await expect(page.locator('#board-title')).toBeEmpty();
    await expect(page.locator('#world g.node')).toHaveCount(0);
    // At least one retry was refused too (the backoff counter), and none left a participant row.
    // The backoff reloads the page: a read cut off by that reload counts as not yet.
    await expect.poll(() => page.evaluate(() => Number(sessionStorage.getItem('stdb_reconnect_attempt'))).catch(() => 0)).toBeGreaterThanOrEqual(2);
    expect(await participants(stack)).toBe(before);
    await expect(stack.callReducer(bad, 'join_board', ['e2e', 'human'])).rejects.toThrow(/issuer rule/);
    await page.close();
  }

  // Control: the default token (azp = the canvas origin) still connects.
  const control = await account();
  await openBoard(control, link);
  await expect(control.locator('#world')).toContainText('By aud');
  await expect(control.locator('#reconnect')).toHaveCount(0);
});

test('an edit link refuses a token of the browser issuer that lacks the session claim', async ({ account, stack }) => {
  test.setTimeout(90_000);
  const owner = await account();
  await openBoard(owner, `${stack.url}?new=1`);
  await drawNode(owner, 'Owner work');
  const link = await shareBoard(owner, 'edit');
  const B = await boardIdOf(stack, owner);

  // Control: a session token (it carries sid) edits through the link.
  const control = await account();
  await openBoard(control, link);
  await drawNode(control, 'With sid');
  await expect(owner.locator('#world')).toContainText('With sid');

  // SH-45: same issuer and azp, no sid, as the provider's other tokens. The module refuses it at connect.
  const before = await participants(stack);
  const bare = stack.accountToken({ sid: undefined });
  const page = await account(bare);
  await page.goto(link);
  await expect(page.locator('#reconnect')).toContainText(TROUBLE);
  await expect(page.locator('#world g.node')).toHaveCount(0);
  expect(await participants(stack)).toBe(before);
  const NONE = { none: [] };
  await expect(stack.callReducer(bare, 'create_node', [B, 'No sid', '', 900, 600, 160, 80, 'ink', false, NONE, NONE, NONE, NONE, NONE, NONE, NONE])).rejects.toThrow(/issuer rule/);
  expect(await stack.sql(`SELECT label FROM node WHERE board_id = ${B}`)).toHaveLength(2);
  await expect(owner.locator('#world')).not.toContainText('No sid');
});
