import { randomBytes } from 'node:crypto';
import { test as base, expect, type BrowserContext, type BrowserContextOptions, type Locator, type Page } from '@playwright/test';
import { withStack } from './stack';
import { boardHref } from '../shared/board-link';

export type Stack = Parameters<Parameters<typeof withStack>[0]>[0];
type Actors = { guest(options?: BrowserContextOptions): Promise<Page>; account(token?: string, options?: BrowserContextOptions): Promise<Page> };
type Env = Record<string, string>;
/** A context's provider session, read by e2e/auth-provider.mjs through the __e2eAuth binding. */
type Session = { token?: string; request?: string; down?: boolean };
const sessions = new WeakMap<BrowserContext, Session>();

export const test = base.extend<Actors & { actors: Actors }, { stack: Stack; clientEnv: Env; moduleEnv: Env }>({
  // Extra build env for the canvas and the module publish: a file that sets either gets its own stack.
  clientEnv: [{}, { scope: 'worker', option: true }],
  moduleEnv: [{}, { scope: 'worker', option: true }],
  stack: [async ({ clientEnv, moduleEnv }, use) => { await withStack(use, { clientEnv, moduleEnv }); }, { scope: 'worker', timeout: 120_000 }],
  actors: async ({ browser, stack }, use) => {
    const contexts: BrowserContext[] = [];
    const create = async (token?: string, options?: BrowserContextOptions) => {
      const context = await browser.newContext(options);
      contexts.push(context);
      const session: Session = { token };
      sessions.set(context, session);
      await context.exposeBinding('__e2eAuth', (_source, op: 'init' | 'request' | 'signOut') => {
        if (op === 'request') { session.token ??= session.request; session.request = undefined; }
        if (op === 'signOut') session.token = undefined;
        return session;
      });
      return context.newPage();
    };
    await use({ guest: options => create(undefined, options), account: (token = stack.accountToken(), options) => create(token, options) });
    await Promise.all(contexts.map(context => context.close()));
  },
  guest: async ({ actors }, use) => { await use(actors.guest); },
  account: async ({ actors }, use) => { await use(actors.account); },
});
export { expect };

function session(target: Page | BrowserContext) {
  const found = sessions.get('context' in target ? target.context() : target);
  if (!found) throw new Error('Only guest() and account() pages have a test sign-in session');
  return found;
}

/** From now on the provider in this page's context is signed in with token; the open page sees it at once (onUserChange). */
export async function signIn(page: Page, token: string) {
  session(page).token = token;
  await page.evaluate(value => (window as any).__e2eAuthSet?.(value), token);
}

/** Ends this context's session as a provider sign-out would: the open page gets onSignedOut (the canvas then leaves for the guest board). */
export async function signOut(page: Page) {
  session(page).token = undefined;
  await page.evaluate(() => (window as any).__e2eAuthSet?.(undefined));
}

/** The next sign-in the page asks for (ensureSignedIn: Sign in, Connect) completes with token instead of being cancelled. */
export function signInOnRequest(page: Page, token: string) {
  session(page).request = token;
}

/** While down, the provider's initAuth rejects ('sign-in provider unreachable') on every load in this context. */
export function providerDown(target: Page | BrowserContext, down: boolean) {
  session(target).down = down;
}

/** The board on screen: the first board of this page's open_board row (RC-605). */
export async function boardIdOf(stack: Stack, page: Page): Promise<number> {
  const connection = await page.evaluate(() => (window as any).conn.connectionId.toHexString() as string);
  const [row] = await stack.sql(`SELECT board_ids FROM open_board WHERE connection_id = 0x${connection}`);
  if (!row) throw new Error('This page has no board open');
  return Number((row.board_ids as unknown[])[0]);
}

/** A database-minted agent named e2e-agent, linked to the person and granted boardId when given (verify-marks-local.mjs agentOn). */
export async function linkedAgent(stack: Stack, personToken: string, boardId?: number) {
  const agent = await stack.mintIdentity();
  await stack.callReducer(agent.token, 'join_board', ['e2e-agent', 'agent']);
  const code = randomBytes(32).toString('base64url');
  await stack.callReducer(agent.token, 'offer_agent_link', [code]);
  await stack.callReducer(personToken, 'redeem_agent_link', [code]);
  if (boardId !== undefined) await stack.callReducer(personToken, 'grant_agent_board', [boardId, { __identity__: `0x${agent.identity}` }]);
  return agent;
}

/**
 * Selects node and waits until the server stores that selection. One connection runs its calls in order, so
 * every write the page sent before (a refused one too) has run by then. Readers may select, so this works on any page.
 */
export async function serverCaughtUp(stack: Stack, page: Page, node: Locator) {
  const me = await page.evaluate(() => (window as any).conn.identity.toHexString() as string);
  const selected = async () => JSON.stringify((await stack.sql(`SELECT node_ids FROM selection WHERE identity = 0x${me}`))[0]?.node_ids ?? []);
  // Clear first, so the click below always sends a new selection.
  await page.keyboard.press('Escape');
  await expect.poll(selected).toBe('[]');
  await node.locator('.node-rect').click({ position: { x: 12, y: 12 } }); // inside the node, clear of its centred labels
  await expect.poll(selected).toBe(JSON.stringify([Number(await node.getAttribute('data-id'))]));
}

/** A board's canonical #b= link, built the way the apps build it. The canvas serves the test database: no ?db=. */
export async function boardLink(stack: Stack, boardId: number) {
  const [row] = await stack.sql(`SELECT slug FROM board WHERE id = ${boardId}`);
  return boardHref({ app: stack.url, slug: String(row?.slug ?? ''), db: 'redcrayon-e2e', home: 'redcrayon-e2e' });
}

export async function openBoard(page: Page, href: string) {
  // A fresh document, as a new tab would open it: a goto that changes only the #hash switches boards in place.
  if (page.url().split('#')[0] === href.split('#')[0]) await page.goto('about:blank');
  await page.goto(href);
  await expect(page.locator('#canvas-wrap')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('#board-title')).not.toBeEmpty();
}

export async function drawNode(page: Page, label: string) {
  const nodes = page.locator('#world g.node');
  const count = await nodes.count();
  await page.keyboard.press('1');
  await page.locator('#board').click({ position: { x: 500 + count * 220, y: 220 + count * 130 } });
  await page.keyboard.press('Escape');
  await expect(nodes).toHaveCount(count + 1);
  await nodes.last().dblclick();
  const edit = page.locator('#inline-edit');
  await edit.fill(label);
  await edit.press('Enter');
  await expect(page.locator('#world')).toContainText(label);
  await expect(page.locator('#save-status')).toHaveText('Saved');
}

export async function shareBoard(page: Page, mode: 'view' | 'edit') {
  await page.locator('#act-share').click();
  await page.getByRole('switch', { name: 'Share with link' }).check();
  const button = page.getByRole('button', { name: mode === 'edit' ? 'Can edit' : 'Can view', exact: true });
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#share-url')).not.toHaveValue('');
  return page.locator('#share-url').inputValue();
}

/** Owners export from the Share popover (shareBoard may leave it open); everyone else from the header. */
export async function exportSvg(page: Page) {
  const download = page.waitForEvent('download');
  if (await page.locator('#act-share').isVisible() && await page.locator('#share-pop').isHidden()) await page.locator('#act-share').click();
  await page.getByRole('button', { name: 'Export SVG', exact: true }).click();
  return download;
}

export async function drawEdge(page: Page, from: number, to: number) {
  const nodes = page.locator('#world g.node');
  const count = await page.locator('#world g.edge').count();
  await nodes.nth(from).click();
  const id = await nodes.nth(from).getAttribute('data-id');
  const handle = page.locator(`.edge-handle[data-node-id="${id}"]`).first();
  // Selecting can pan the node clear of the panels (revealSelection glides 200 ms), and a reload
  // fits the board: measure only once the endpoints stop moving, or the drag lands short.
  const start = await settledBox(handle);
  const end = await settledBox(nodes.nth(to));
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator('#world g.edge')).toHaveCount(count + 1);
  await expect(page.locator('#save-status')).toHaveText('Saved');
}

/** The element's box once two reads 250 ms apart agree: probes that far apart straddle the 200 ms pan (RC-610). */
export async function settledBox(locator: Locator) {
  let last = '';
  await expect.poll(async () => {
    const box = JSON.stringify(await locator.boundingBox());
    const same = box === last && box !== 'null';
    last = box;
    return same;
  }, { intervals: [250], message: 'Element is not visible or keeps moving' }).toBe(true);
  return JSON.parse(last) as { x: number; y: number; width: number; height: number };
}

// Helpers shared by several specs. A file whose variant really differs keeps its own.

export const nodes = (page: Page) => page.locator('#world g.node');
/** A guest's database token, from its own localStorage: reducer calls as that guest. */
export const guestToken = (page: Page) => page.evaluate(() => Object.entries(localStorage).find(([key]) => key.startsWith('stdb_token:'))![1]);
/** A threat marker the reader can open. */
export const marker = (page: Page) => page.locator('#world .board-marker[role="button"]');

/** A new board with these nodes drawn through the UI; returns the board and node ids in drawing order. */
export async function boardWith(page: Page, stack: Stack, labels: string[]) {
  await openBoard(page, `${stack.url}?new=1`);
  for (const label of labels) await drawNode(page, label);
  const ids = await nodes(page).evaluateAll(all => all.map(node => Number(node.getAttribute('data-id'))));
  return { B: await boardIdOf(stack, page), ids };
}

/** Opens ⌘K and types query. */
export async function palette(page: Page, query: string) {
  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.locator('#palette-input')).toBeFocused();
  await page.locator('#palette-input').fill(query);
}

/** The open board-delete confirm: type the board name it asks for, then press delete. */
export async function confirmBoardDelete(page: Page) {
  const dialog = page.locator('#board-delete');
  const name = (await dialog.locator('#board-delete-prompt').innerText()).match(/^Delete "(.*)" and everything/)![1];
  await dialog.getByRole('textbox', { name: 'Board name to confirm deletion' }).fill(name);
  await dialog.getByRole('button', { name: 'delete', exact: true }).click();
}

/** Click the middle of the first drawn edge: its routed path need not pass through its box's centre. */
export async function selectEdge(page: Page) {
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
  await expect(page.locator('#toolbar')).toHaveClass(/edges-only/);
}

/** Picks option from the toolbar's colour or style menu, opening it first if needed. */
export async function pick(page: Page, menu: 'color' | 'style', option: string) {
  const details = page.locator(`#tb-${menu}-menu`);
  if ((await details.getAttribute('open')) === null) await details.locator('summary').click();
  await page.locator(`#tb-${menu}-menu ${option}`).click();
}

/** Tries to place a node with the '1' tool on open canvas. */
export async function tryPlace(page: Page) {
  await page.keyboard.press('1');
  await page.locator('#board').click({ position: { x: 650, y: 350 } });
  await page.keyboard.press('Escape');
}

/** Real touch input (pointerType touch), one frame per step, through the browser's input pipeline. */
export async function fingers(page: Page, path: { x: number; y: number }[][]) {
  const cdp = await page.context().newCDPSession(page);
  const points = (frame: { x: number; y: number }[]) => frame.map((p, id) => ({ ...p, id }));
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(path[0]) });
  for (const frame of path.slice(1)) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(frame) });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

/** The board's translate and scale, once two reads 250 ms apart agree (a resize refits, a selection reveal glides). */
export async function view(page: Page) {
  let last: string | null = null;
  await expect.poll(async () => {
    // No transform yet is the identity.
    const now = (await page.locator('#world').getAttribute('transform')) ?? 'translate(0 0) scale(1)';
    const same = now === last;
    last = now;
    return same;
  }, { intervals: [250] }).toBe(true);
  const [tx, ty, scale] = last!.match(/-?[\d.]+/g)!.map(Number);
  return { tx, ty, scale };
}

// Branches: the header chip, its popover and the review dialog.
export const chip = (page: Page) => page.locator('#branch-chip');
export const status = (page: Page) => chip(page).locator('.branch-status');

/** Opens the review dialog for the board on screen: chip → its own (current) row. */
export async function openReview(page: Page) {
  await chip(page).click();
  await page.locator('#branch-pop .branch-row.current').click();
  await expect(page.locator('#branch-review')).toBeVisible();
}

/** Walks the board on screen one review step and waits for its new status. */
export async function act(page: Page, action: 'submit' | 'accept' | 'reject' | 'merge', word: string) {
  await openReview(page);
  await page.locator(`#branch-review button[data-action="${action}"]`).click();
  await expect(page.locator('#branch-review')).toHaveCount(0);
  await expect(status(page)).toHaveText(word);
}

/** Forks the board on screen from the chip; without a name the dialog's default is kept. */
export async function fork(page: Page, name?: string) {
  await chip(page).click();
  await page.locator('#branch-pop .branch-new').click();
  if (name) await page.locator('#branch-create-name').fill(name);
  await page.locator('#branch-create button[type="submit"]').click();
  await expect(page.locator('#board-title')).toHaveText(name ? `Branch · ${name}` : /^Branch · /);
  await expect(status(page)).toHaveText('Draft');
}

// Red crayon review: the crayon tool and the Send pill.
export const loops = (page: Page) => page.locator('#crayon .mark');
export const pill = (page: Page) => page.locator('#mark-send');

export async function armCrayon(page: Page) {
  await page.keyboard.press('c');
  await expect(page.locator('#tool-crayon')).toHaveClass(/armed/);
}

export async function send(page: Page, count: number) {
  await expect(pill(page)).toHaveText(`Send ${count} mark${count === 1 ? '' : 's'}`);
  await pill(page).click();
  await expect(pill(page)).toBeHidden();
  await expect(loops(page)).toHaveCount(0);
}
