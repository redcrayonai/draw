import type { Page, WebSocketRoute } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { test, expect, openBoard, boardIdOf, boardLink, linkedAgent, type Stack } from '../fixtures';

// Chat with the agent you are running, from the board, against a mocked relay:
// page.routeWebSocket stands in for the hosted Worker at wss://mcp.e2e.invalid/chat/<board>.
// mcp/src/chat.test.ts holds the relay's access rules; the helper's queue is in helper/src/chat.test.ts.

// Worker options must be top-level; the same literals as hosted-connect.spec.ts share one stack.
test.use({
  clientEnv: { VITE_MCP_URL: 'https://mcp.e2e.invalid/mcp', VITE_DASHBOARD_URL: 'https://dash.e2e.invalid', VITE_PRIVACY_URL: 'https://example.test/privacy' },
  moduleEnv: { BROWSER_CLIENT_IDS: 'e2e-client', BROWSER_SESSION_CLAIM: 'sid' },
});

type Relay = { route?: WebSocketRoute; sent: Record<string, any>[] };

async function relay(page: Page): Promise<Relay> {
  const r: Relay = { sent: [] };
  await page.routeWebSocket(/\/chat\/\d+$/, ws => {
    r.route = ws;
    ws.onMessage(raw => {
      const m = JSON.parse(String(raw));
      r.sent.push(m);
      if (m.role === 'person') {
        ws.send(JSON.stringify({ ok: true, role: 'person' }));
        ws.send(JSON.stringify({ agent: 'connected' }));
      }
    });
  });
  return r;
}
const push = (r: Relay, frame: object) => r.route!.send(JSON.stringify(frame));
const input = (page: Page) => page.getByRole('textbox', { name: 'Message your agent' });
const stop = (page: Page) => page.getByRole('button', { name: 'Stop agent' });
const chatLog = (page: Page) => page.locator('#agent-chat [role="log"]');

async function linkedBoard(account: (token?: string) => Promise<Page>, stack: Stack) {
  const token = stack.accountToken();
  const page = await account(token);
  const r = await relay(page);
  await openBoard(page, `${stack.url}?new=1`);
  await linkedAgent(stack, token, await boardIdOf(stack, page));
  // The panel comes to the person when their agent is connected.
  await expect(input(page)).toBeEnabled();
  return { page, relay: r };
}

test('someone with no linked agent is not offered a chat', async ({ account, stack }) => {
  const page = await account();
  await openBoard(page, `${stack.url}?new=1`);
  await expect(page.locator('#act-share')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Chat with agent' })).toBeHidden();
});

test('the panel opens once when the agent connects, and stays closed once the person closes it', async ({ account, stack }) => {
  const { page } = await linkedBoard(account, stack);
  await page.getByRole('button', { name: 'Close chat' }).click();
  await expect(page.locator('#agent-chat')).toBeHidden();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Chat with agent' })).toBeVisible();
  await page.waitForTimeout(500);
  await expect(page.locator('#agent-chat')).toBeHidden();
  await page.getByRole('button', { name: 'Chat with agent' }).click();
  await expect(input(page)).toBeFocused();
});

test('a message goes to the agent with the selection, and the reply streams in', async ({ account, stack }) => {
  const { page, relay: r } = await linkedBoard(account, stack);
  await expect(page.getByRole('button', { name: 'Send' })).toBeDisabled();
  await input(page).fill('why is this here?');
  await input(page).press('Enter');
  await expect.poll(() => r.sent.find(m => m.type === 'send')?.text).toBe('why is this here?');
  await expect(input(page)).toHaveValue('');

  const id = r.sent.find(m => m.type === 'send')!.id;
  push(r, { type: 'queue', queue: [], paused: false });
  push(r, { type: 'delivered', id, text: 'why is this here?' });
  push(r, { type: 'state', state: 'working' });
  push(r, { type: 'text', message: 'm1', delta: 'I added it in `web/orders.ts:42`.\n', final: false });
  await expect(chatLog(page).locator('code')).toHaveText('web/orders.ts:42');
  push(r, { type: 'tool', id: 'w1', phase: 'start', summary: 'Edited web/orders.ts' });
  await expect(chatLog(page)).toContainText('Edited web/orders.ts');
  // An agent's text is never markup.
  push(r, { type: 'text', message: 'm2', delta: '<img src=x onerror=alert(1)>', final: true });
  await expect(chatLog(page)).toContainText('<img src=x onerror=alert(1)>');
  await expect(chatLog(page).locator('img')).toHaveCount(0);
});

test('queued messages can be deleted, and Stop is there only while the agent works', async ({ account, stack }) => {
  const { page, relay: r } = await linkedBoard(account, stack);
  await expect(stop(page)).toBeHidden();
  push(r, { type: 'state', state: 'working' });
  await expect(stop(page)).toBeVisible();

  push(r, { type: 'queue', queue: [{ id: 'q1', text: 'next thing' }], paused: false });
  await expect(chatLog(page)).toContainText('Queued');
  await page.getByRole('button', { name: 'Delete queued message: next thing' }).click();
  await expect.poll(() => r.sent.find(m => m.type === 'delete')?.id).toBe('q1');

  await stop(page).click();
  await expect.poll(() => r.sent.some(m => m.type === 'stop')).toBe(true);
  push(r, { type: 'state', state: 'stopping' });
  await expect(stop(page)).toContainText('Stopping');
  await expect(stop(page)).toBeDisabled();
  push(r, { type: 'state', state: 'stopped' });
  push(r, { type: 'notice', text: 'Stopped.' });
  push(r, { type: 'queue', queue: [{ id: 'q2', text: 'held' }], paused: true });
  await expect(stop(page)).toBeHidden();
  await page.getByRole('button', { name: 'Resume' }).click();
  await expect.poll(() => r.sent.some(m => m.type === 'resume')).toBe(true);
});

test('the terminal look is remembered, a snapshot restores the talk, and an offline agent takes no messages', async ({ account, stack }) => {
  const { page, relay: r } = await linkedBoard(account, stack);
  push(r, { type: 'snapshot', state: 'idle', paused: false, queue: [], events: [{ type: 'user', id: 't1', text: 'typed there', origin: 'terminal' }] });
  await expect(chatLog(page)).toContainText('Typed in your terminal');

  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  await expect(page.locator('#agent-chat')).toHaveAttribute('data-look', 'terminal');
  expect(await page.evaluate(() => localStorage.getItem('redcrayon.chatLook'))).toBe('terminal');

  push(r, { agent: 'gone' });
  await expect(input(page)).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Stop agent' })).toBeHidden();

  // Typing in the box must not fire the canvas's tool shortcuts.
  push(r, { agent: 'connected' });
  await expect(input(page)).toBeEnabled();
  await input(page).pressSequentially('c');
  await expect(page.locator('#tool-crayon')).not.toHaveClass(/armed/);
});

/** A database-minted agent that offers a pairing code, and the board link carrying it. */
async function pairingLink(stack: Stack, B: number) {
  const agent = await stack.mintIdentity();
  await stack.callReducer(agent.token, 'join_board', ['e2e-agent', 'agent']);
  const code = randomBytes(32).toString('base64url');
  await stack.callReducer(agent.token, 'offer_agent_link', [code]);
  return { agent, code, href: `${await boardLink(stack, B)}&pair=${code}` };
}
const links = (stack: Stack, agent: string) => stack.sql(`SELECT * FROM agent_link WHERE agent = 0x${agent}`);

test('a pairing link asks first, links on the button, and gives the agent this board', async ({ account, stack }) => {
  const token = stack.accountToken();
  const page = await account(token);
  await relay(page);
  await openBoard(page, `${stack.url}?new=1`);
  const B = await boardIdOf(stack, page);
  const { agent, code, href } = await pairingLink(stack, B);
  await page.goto('about:blank');
  await page.goto(href);

  // Asked, and nothing has happened yet; the code has left the address bar.
  const linkAgent = page.getByRole('button', { name: 'Link agent' });
  await expect(linkAgent).toBeVisible();
  expect(page.url()).not.toContain(code);
  expect(new URL(page.url()).hash).toContain('b=');
  expect(await links(stack, agent.identity)).toHaveLength(0);

  await linkAgent.click();
  await expect(page.getByRole('button', { name: 'Chat with agent' })).toBeVisible();
  await expect(linkAgent).toBeHidden();
  await expect.poll(async () => (await links(stack, agent.identity)).length).toBe(1);
  await expect.poll(async () => (await stack.sql(`SELECT * FROM agent_grant WHERE board_id = ${B} AND agent = 0x${agent.identity}`)).length).toBe(1);
});

test('Not now leaves everything as it was; a used link says you are linked already, or that it did not work', async ({ account, stack }) => {
  const token = stack.accountToken();
  const page = await account(token);
  await relay(page);
  await openBoard(page, `${stack.url}?new=1`);
  const B = await boardIdOf(stack, page);
  const { agent, href } = await pairingLink(stack, B);
  await page.goto('about:blank');
  await page.goto(href);
  await page.getByRole('button', { name: 'Not now' }).click();
  await expect(page.getByRole('button', { name: 'Link agent' })).toBeHidden();
  expect(await links(stack, agent.identity)).toHaveLength(0);

  // The same code again, in the open tab: only the fragment changes.
  await page.evaluate(h => { location.hash = new URL(h).hash; }, href);
  await page.getByRole('button', { name: 'Link agent' }).click();
  await expect(page.getByRole('button', { name: 'Chat with agent' })).toBeVisible();
  await page.goto('about:blank');
  await page.goto(href);
  await page.getByRole('button', { name: 'Link agent' }).click();
  await expect(page.locator('#agent-chat')).toContainText('Your agent is already linked');

  // Someone else with the spent code, on their own board.
  const other = await account(stack.accountToken({ sub: `other-${Date.now()}` }));
  await relay(other);
  await openBoard(other, `${stack.url}?new=1`);
  await other.goto(`${await boardLink(stack, await boardIdOf(stack, other))}&pair=${new URL(href).hash.split('pair=')[1]}`);
  await other.getByRole('button', { name: 'Link agent' }).click();
  await expect(other.locator('#agent-chat')).toContainText('That link did not work');
});
