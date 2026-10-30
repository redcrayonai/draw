import type { BrowserContextOptions, Page, WebSocketRoute } from '@playwright/test';
import { test, expect, openBoard, drawNode, drawEdge, shareBoard, boardIdOf, guestToken, type Stack } from '../fixtures';

// The Live traffic switch (live tap spec, PR #103) against a mocked live channel:
// page.routeWebSocket stands in for the hosted Worker at wss://mcp.e2e.invalid/live/<board>.

// Worker options must be top-level; the same literals as hosted-connect.spec.ts share one stack.
test.use({
  clientEnv: { VITE_MCP_URL: 'https://mcp.e2e.invalid/mcp', VITE_DASHBOARD_URL: 'https://dash.e2e.invalid', VITE_PRIVACY_URL: 'https://example.test/privacy' },
  moduleEnv: { BROWSER_CLIENT_IDS: 'e2e-client', BROWSER_SESSION_CLAIM: 'sid' },
});

const WIDE: BrowserContextOptions = { viewport: { width: 1440, height: 900 } };
const CLIPBOARD: BrowserContextOptions = { ...WIDE, permissions: ['clipboard-read', 'clipboard-write'] };
const TAP_CONNECTED = [{ ok: true }, { tap: 'connected' }];

type Channel = { route?: WebSocketRoute; url?: string; protocols?: string[]; messages: Record<string, unknown>[]; closed: boolean };

/** Mocks the board's live channel: records what the canvas sends, and answers its viewer auth with replies. */
async function liveChannel(page: Page, replies: object[]) {
  const channel: Channel = { messages: [], closed: false };
  await page.routeWebSocket(/\/live\/\d+$/, ws => {
    Object.assign(channel, { route: ws, url: ws.url(), protocols: ws.protocols() });
    ws.onMessage(raw => {
      const message = JSON.parse(String(raw));
      channel.messages.push(message);
      if (message.role === 'viewer') for (const reply of replies) ws.send(JSON.stringify(reply));
    });
    ws.onClose(() => { channel.closed = true; });
  });
  return channel;
}
const send = (channel: Channel, message: object) => channel.route!.send(JSON.stringify(message));
/** A tap streaming the same window every second, as a real one does, so Live never goes stale; stop() returns the last send time. */
function stream(channel: Channel, message: object) {
  let last = 0;
  const tick = () => { send(channel, message); last = Date.now(); };
  tick();
  const timer = setInterval(tick, 1000);
  return () => { clearInterval(timer); return last; };
}

/** One second of api calling web: against the drawn web→api arrow. */
const traffic = (web: number, api: number) => ({
  t: 1, window_ms: 1000, unmapped: 3,
  edges: [{ from: String(api), to: String(web), count: 41, errors: 2, p50: 12.4, p95: 38, max: 51 }],
});

const liveRow = (page: Page) => page.locator('#live-row');
const liveStatus = (page: Page) => page.locator('#live-status');
/** The status line alone, without its action button. */
const statusLine = (page: Page) => liveStatus(page).locator(':scope > div');
const label = (page: Page) => page.locator('#world .edge-labels .edge-label');
const nodeNamed = (page: Page, name: string) => page.locator('#world g.node', { hasText: name });
/** Hover inside the node, clear of its label: the edges next to it show their numbers. */
const hoverNode = (page: Page, name: string) => nodeNamed(page, name).locator('.node-rect').hover({ position: { x: 12, y: 12 } });

/** The person's new board with web→api, the channel mocked before the first load. */
async function webApiBoard(stack: Stack, page: Page, replies: object[]) {
  const channel = await liveChannel(page, replies);
  await openBoard(page, `${stack.url}?new=1`);
  await drawNode(page, 'web');
  await drawNode(page, 'api');
  await drawEdge(page, 0, 1);
  await page.keyboard.press('Escape');
  await page.locator('#board-title').hover(); // off the board: no hover focus
  const [web, api] = await page.locator('#world g.node').evaluateAll(nodes => nodes.map(node => Number(node.getAttribute('data-id'))));
  return { channel, web, api, B: await boardIdOf(stack, page) };
}

test('the live switch shows with a hosted server, and with no tap offers a prompt for the agent', async ({ account, stack }) => {
  const page = await account(stack.accountToken(), CLIPBOARD);
  const channel = await liveChannel(page, [{ ok: true }, { tap: 'gone' }]);
  await openBoard(page, `${stack.url}?new=1`);
  const B = await boardIdOf(stack, page);
  // The default build hides it (loading-and-saving.spec.ts); this build has a hosted server.
  await expect(liveRow(page)).toBeVisible();
  await expect(liveRow(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(liveStatus(page)).toBeHidden();

  await liveRow(page).click();
  await expect(liveRow(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(statusLine(page)).toHaveText('No live source on this board yet.');
  await liveStatus(page).getByRole('button', { name: 'Copy a prompt for your agent' }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(
    `Start a live tap for board ${B} (call start_tap, write .redcrayon/tap.json, run the command it returns) so I can watch live traffic.`,
  );
  // The person pastes the prompt; the board itself never asks the channel for a tap.
  // Live off sends {live:false} last on the same socket, so anything the copy sent arrived before it.
  await liveRow(page).click();
  await expect.poll(() => channel.closed).toBe(true);
  expect(channel.messages).toEqual([{ auth: expect.any(String), role: 'viewer' }, { live: true }, { live: false }]);
});

test('the canvas authenticates as a viewer in the first message, never in the URL', async ({ account, stack }) => {
  const token = stack.accountToken();
  const page = await account(token, WIDE);
  const channel = await liveChannel(page, []); // the test answers by hand
  await openBoard(page, `${stack.url}?new=1`);
  const B = await boardIdOf(stack, page);

  await liveRow(page).click();
  await expect.poll(() => channel.messages.length).toBe(1);
  expect(channel.url).toBe(`wss://mcp.e2e.invalid/live/${B}`);
  expect(channel.protocols).toEqual([]); // no token in Sec-WebSocket-Protocol either
  expect(channel.messages[0]).toEqual({ auth: token, role: 'viewer' });

  // Live is asked for only once the channel accepts the viewer.
  await expect(statusLine(page)).toHaveText('Connecting…');
  expect(channel.messages).toHaveLength(1);
  send(channel, { ok: true });
  await expect.poll(() => channel.messages.length).toBe(2);
  expect(channel.messages[1]).toEqual({ live: true });

  // Off: say so, then hang up.
  await liveRow(page).click();
  await expect(liveRow(page)).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => channel.closed).toBe(true);
  expect(channel.messages.slice(2)).toEqual([{ live: false }]);
  await expect(liveStatus(page)).toBeHidden();
});

test("a tap's windows make edges flow with rates, errors and direction, then fall back to waiting", async ({ account, stack }) => {
  test.setTimeout(90_000);
  const page = await account(stack.accountToken(), WIDE);
  const { channel, web, api } = await webApiBoard(stack, page, TAP_CONNECTED);
  const edge = page.locator('#world g.edge');

  await liveRow(page).click();
  await expect(statusLine(page)).toHaveText('Tap connected. Waiting for traffic.');
  await expect(edge).not.toHaveClass(/live/);

  // No further click: the windows alone make the edge flow (streamed, so a slow check never sees it go stale).
  const stop = stream(channel, traffic(web, api));
  await expect(statusLine(page)).toHaveText('Live · 1 edge · 3 unmapped calls');
  await expect(edge).toHaveClass(/(^|\s)live(\s|$)/);
  await expect(edge).toHaveClass(/live-rev/); // api→web runs against the web→api arrow
  await expect(edge).toHaveClass(/lat-err/);
  await expect(edge).toHaveAttribute('style', /--flow-dur: 1\.43s/); // flowSeconds(41/s)
  await hoverNode(page, 'web');
  await expect(label(page)).toHaveText('12ms · 41/s · 2 err');

  // Three seconds without a window: back to waiting, the edge still.
  const sent = stop();
  await expect(statusLine(page)).toHaveText('Tap connected. Waiting for traffic.');
  const quiet = Date.now() - sent;
  expect(quiet).toBeGreaterThanOrEqual(3000);
  expect(quiet).toBeLessThan(6000); // about 3 s, not some longer timeout
  await expect(edge).not.toHaveClass(/live/);
  await expect(edge).not.toHaveClass(/lat-err/);
  await expect(edge).not.toHaveAttribute('style', /--flow-dur/);

  // The tap going stops a flowing edge at once, not by the stale timer (which would say waiting).
  send(channel, traffic(web, api));
  await expect(edge).toHaveClass(/(^|\s)live(\s|$)/);
  send(channel, { tap: 'gone' });
  await expect(statusLine(page)).toHaveText('No live source on this board yet.');
  await expect(edge).not.toHaveClass(/live/);
  await expect(statusLine(page)).toHaveText('No live source on this board yet.');
  await expect(liveRow(page)).toHaveAttribute('aria-pressed', 'true');
});

test('an editor pins live latency to the edges; a reader is not offered it', async ({ account, guest, stack }) => {
  test.setTimeout(90_000);
  const page = await account(stack.accountToken(), WIDE);
  const { channel, web, api, B } = await webApiBoard(stack, page, TAP_CONNECTED);
  const [{ id }] = await stack.sql(`SELECT id FROM edge WHERE board_id = ${B}`);
  const e = Number(id);
  const latency = () => stack.sql(`SELECT latency_ms, latency_source FROM edge WHERE id = ${e}`);
  const link = await shareBoard(page, 'view');
  await page.keyboard.press('Escape');

  await liveRow(page).click();
  await expect(statusLine(page)).toHaveText('Tap connected. Waiting for traffic.');
  const stop = stream(channel, traffic(web, api));
  await liveStatus(page).getByRole('button', { name: 'Pin as latency' }).click();
  await expect.poll(async () => {
    const [row] = await latency();
    return [Math.round(Number(row.latency_ms) * 10) / 10, row.latency_source]; // f32 in the database
  }).toEqual([12.4, 'local']);
  stop();
  await liveRow(page).click();
  await expect(liveRow(page)).toHaveAttribute('aria-pressed', 'false');

  // The pin is the edge's own latency now, not live data.
  await page.reload();
  await expect(page.locator('#world g.edge')).toHaveCount(1);
  await hoverNode(page, 'web');
  await expect(label(page)).toHaveText('12ms local');

  // A view-link reader gets the same live edges but no pin, and the module refuses the write.
  const viewer = await guest(WIDE);
  const readerChannel = await liveChannel(viewer, TAP_CONNECTED);
  await openBoard(viewer, link);
  await expect(viewer.locator('#world')).toContainText('api');
  await expect(viewer.locator('#board-title')).toContainText('view only');
  await liveRow(viewer).click();
  await expect(statusLine(viewer)).toHaveText('Tap connected. Waiting for traffic.');
  const stopReader = stream(readerChannel, traffic(web, api));
  await expect(statusLine(viewer)).toHaveText('Live · 1 edge · 3 unmapped calls');
  await expect(viewer.locator('#world g.edge')).toHaveClass(/live-rev/);
  await expect(liveStatus(viewer).getByRole('button')).toHaveCount(0);
  await expect(statusLine(viewer)).toHaveText('Live · 1 edge · 3 unmapped calls'); // still live: the absence counted
  stopReader();
  await expect(stack.callReducer(await guestToken(viewer), 'set_edge_latency', [e, 99, 'local'])).rejects.toThrow('not authorized: board is read only');
  const [row] = await latency();
  expect([Math.round(Number(row.latency_ms) * 10) / 10, row.latency_source]).toEqual([12.4, 'local']); // not the reader's 99
});
