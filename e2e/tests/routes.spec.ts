import { randomBytes } from 'node:crypto';
import type { BrowserContextOptions, Page } from '@playwright/test';
import { test, expect, openBoard, drawNode, drawEdge, shareBoard, boardIdOf, linkedAgent, settledBox, boardLink, exportSvg, type Stack } from '../fixtures';

// Session routes and agent focus (session routes spec, PR #29), route play (#95),
// latency, trace replay (#96/#97) and neighbour focus (#92). The agent calls the
// module over HTTP as a database-minted identity; no MCP Worker here.

const SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const NONE = { none: [] };
const WIDE: BrowserContextOptions = { viewport: { width: 1440, height: 900 } };
type Account = (token?: string, options?: BrowserContextOptions) => Promise<Page>;

/** A session board the person started with their own token, open on their page. */
async function sessionBoard(stack: Stack, account: Account, token: string) {
  const name = `e2e-routes-${randomBytes(3).toString('hex')}`;
  await stack.callReducer(token, 'start_session', [name, '/tmp/e2e-routes', SHA]);
  const [row] = await stack.sql(`SELECT id FROM board WHERE name = '${name}'`);
  const B = Number(row.id);
  const href = await boardLink(stack, B);
  const page = await account(token, WIDE);
  await openBoard(page, href);
  return { B, href, page };
}

/**
 * The person's linked agent with a grant on B. Each HTTP call disconnects, and onDisconnect
 * clears a caller's selection, so it is also made a service account to keep its focus
 * (agents.spec presentAgent and the RC-539 integration tests do the same).
 */
async function focusedAgent(stack: Stack, token: string, B: number) {
  const agent = await linkedAgent(stack, token, B);
  await stack.sql(`INSERT INTO service_account (identity, label) VALUES (0x${agent.identity}, 'routes-agent')`);
  return agent;
}

let spot = 0;
/** create_node as token (boardId, label, sublabel, x, y, w, h, token, focal, seven options); returns its id. */
async function createNode(stack: Stack, token: string, B: number, label: string) {
  spot += 1;
  await stack.callReducer(token, 'create_node', [B, label, '', 400 + (spot % 4) * 240, 300 + (spot % 3) * 160, 160, 80, 'ink', false, NONE, NONE, NONE, NONE, NONE, NONE, NONE]);
  const [row] = await stack.sql(`SELECT id FROM node WHERE board_id = ${B} AND label = '${label}'`);
  return Number(row.id);
}

/** Auth, Tests and Docs drawn by the agent and planned as its route. */
async function plannedRoute(stack: Stack, agent: { token: string }, B: number) {
  const [a, t, d] = [await createNode(stack, agent.token, B, 'Auth'), await createNode(stack, agent.token, B, 'Tests'), await createNode(stack, agent.token, B, 'Docs')];
  await stack.callReducer(agent.token, 'plan_route', [B, [a, t, d]]);
  return { a, t, d };
}

const arrive = (stack: Stack, agent: { token: string }, B: number, node: number, revision: number, checkpoint: number) =>
  stack.callReducer(agent.token, 'arrive_at_checkpoint', [B, node, revision, checkpoint, SHA, '{}']);

const rail = (page: Page) => page.locator('#session-row');
const destination = (page: Page) => rail(page).locator('.session-route-destination');
const progress = (page: Page) => rail(page).locator('.session-route:not(.session-trace) > .session-route-progress');
const waypoint = (page: Page, id: number) => rail(page).locator(`[data-key="waypoint:${id}"]`);
const focusLine = (page: Page) => rail(page).locator('.session-focus');
const node = (page: Page, id: number) => page.locator(`#world g.node[data-id="${id}"]`);
const nodeNamed = (page: Page, label: string) => page.locator('#world g.node', { hasText: label });
const world = (page: Page) => page.locator('#world');
/** Off the board: pointerleave ends any hover focus. */
const rest = (page: Page) => page.locator('#board-title').hover();
/** Inside the node, clear of its centred label. */
const at = { position: { x: 12, y: 12 } };

/**
 * Records from now on what the canvas shows only for a moment: the node ids, in order, each time a node
 * takes a class (on), the dots it adds, and every place a dot's head is drawn (at).
 */
async function watch(page: Page) {
  await page.evaluate(() => {
    const seen: { on: Record<string, number[]>; dots: string[]; at: string[] } = { on: {}, dots: [], at: [] };
    const last = new Map<Element, string[]>([...document.querySelectorAll('#world [data-id]')].map(e => [e, [...e.classList]]));
    Object.assign(window, { __seen: seen });
    new MutationObserver(records => {
      for (const r of records) {
        const target = r.target as Element;
        const id = r.type === 'attributes' ? target.getAttribute('data-id') : null;
        if (id) {
          const now = [...target.classList];
          for (const c of now) if (!(last.get(target) ?? []).includes(c)) (seen.on[c] ??= []).push(Number(id));
          last.set(target, now);
        }
        if (r.type === 'attributes' && target.matches('.route-dot')) seen.at.push(`${target.getAttribute('cx')},${target.getAttribute('cy')}`);
        for (const added of r.addedNodes) {
          if (added instanceof Element && added.matches('.route-comet')) seen.dots.push(added.querySelector('.route-dot')?.getAttribute('class') ?? '');
        }
      }
    }).observe(document.querySelector('#world')!, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'cx', 'cy'] });
  });
}
const seen = (page: Page) => page.evaluate(() => (window as any).__seen as { on: Record<string, number[]>; dots: string[]; at: string[] });

test('a planned route shows in the rail and on the waypoints, and arrivals update open boards live', async ({ account, stack }) => {
  test.setTimeout(90_000);
  const token = stack.accountToken();
  const { B, href, page } = await sessionBoard(stack, account, token);
  const agent = await focusedAgent(stack, token, B);
  const second = await account(token, WIDE);
  await openBoard(second, href);
  const [a, t, d] = [await createNode(stack, agent.token, B, 'Auth'), await createNode(stack, agent.token, B, 'Tests'), await createNode(stack, agent.token, B, 'Docs')];
  for (const p of [page, second]) await expect(world(p)).toContainText('Docs');
  await expect(page.locator('#world g.edge')).toHaveCount(0);

  await stack.callReducer(agent.token, 'plan_route', [B, [a, t, d]]);
  for (const p of [page, second]) {
    await expect(destination(p)).toHaveText('destination: Docs');
    await expect(progress(p)).toHaveText('0/3 · next: Auth');
  }

  await arrive(stack, agent, B, a, 1, 0);
  for (const p of [page, second]) {
    await expect(progress(p)).toHaveText('1/3 · now: Auth · next: Tests');
    await expect(waypoint(p, a)).toHaveAttribute('data-status', 'current');
    await expect(waypoint(p, a)).toHaveAttribute('aria-current', 'step');
    await expect(rail(p).locator('.session-waypoint-status')).toHaveText(['current', 'pending', 'pending']);
  }
  // Numbered markers on the waypoint nodes; they are not edges.
  await expect(node(page, a).locator('.node-route')).toHaveClass(/route-current/);
  await expect(node(page, a).locator('.node-route-number')).toHaveText('1');
  await expect(node(page, a).locator('.node-route-current')).toHaveText('current');
  await expect(node(page, t).locator('.node-route')).toHaveClass(/route-pending/);
  await expect(node(page, t).locator('.node-route-number')).toHaveText('2');
  await expect(page.locator('#world g.edge')).toHaveCount(0);

  await arrive(stack, agent, B, t, 1, 1);
  await arrive(stack, agent, B, d, 1, 2);
  for (const p of [page, second]) {
    await expect(progress(p)).toHaveText('3/3 · destination reached');
    await expect(waypoint(p, d)).toHaveAttribute('data-status', 'current');
    await expect(node(p, a).locator('.node-route')).toHaveClass(/route-done/);
  }
  await expect(rail(second).locator('.session-waypoint-status')).toHaveText(['done', 'done', 'current']);

  // A completed route can be extended (TF-43).
  const ship = await createNode(stack, agent.token, B, 'Ship');
  await stack.callReducer(agent.token, 'reroute', [B, [ship], [0], [], 'one more stop']);
  await expect(destination(second)).toHaveText('destination: Ship');
  await expect(progress(second)).toHaveText('3/4 · now: Docs · next: Ship');
  await expect(rail(second).locator('.session-waypoint-status')).toHaveText(['done', 'done', 'current', 'pending']);
});

test("clicking a waypoint only inspects it, and the route outlives the agent's focus", async ({ account, stack }) => {
  const token = stack.accountToken();
  test.setTimeout(90_000);
  const { B, href, page } = await sessionBoard(stack, account, token);
  const agent = await focusedAgent(stack, token, B);
  const { a, d } = await plannedRoute(stack, agent, B);
  await arrive(stack, agent, B, a, 1, 0);
  await expect(progress(page)).toHaveText('1/3 · now: Auth · next: Tests');

  await waypoint(page, d).click();
  await expect(page.locator('#inspector .insp-title')).toHaveText('Docs');
  // The click's own write (the person's selection) has landed, so any route write it made would have too.
  await expect.poll(async () => (await stack.sql(`SELECT node_ids FROM selection WHERE board_id = ${B}`)).map(r => JSON.stringify(r.node_ids))).toContain(JSON.stringify([d]));
  expect(await stack.sql(`SELECT current_index, revision FROM session_route WHERE board_id = ${B}`)).toEqual([{ current_index: 0, revision: 1 }]);
  await expect(progress(page)).toHaveText('1/3 · now: Auth · next: Tests');

  // An arrival focuses the agent on the waypoint.
  await expect(focusLine(page)).toHaveText('agent on Auth');
  // Once the agent has been away 30 minutes it is gone: its line goes, its route and selection stay (PR-28, TF-45).
  const later = await account(token, WIDE);
  await later.clock.install();
  await openBoard(later, href);
  await expect(focusLine(later)).toHaveText('agent on Auth');
  await later.clock.fastForward('31:00');
  await expect(focusLine(later)).toHaveCount(0);
  await expect(progress(later)).toHaveText('1/3 · now: Auth · next: Tests');
  await expect(waypoint(later, a)).toHaveAttribute('data-status', 'current');
  expect(await stack.sql(`SELECT node_ids FROM selection WHERE identity = 0x${agent.identity}`)).toEqual([{ node_ids: [a] }]);

  // Clearing the agent's focus leaves the route alone.
  await stack.callReducer(agent.token, 'set_selection', [B, []]);
  await expect(focusLine(page)).toHaveCount(0);
  await expect(progress(page)).toHaveText('1/3 · now: Auth · next: Tests');
  await expect(waypoint(page, a)).toHaveAttribute('data-status', 'current');
  await page.reload();
  await expect(progress(page)).toHaveText('1/3 · now: Auth · next: Tests');
  await expect(waypoint(page, a)).toHaveAttribute('data-status', 'current');
  await expect(focusLine(page)).toHaveCount(0);
});

test('a reroute changes only pending waypoints and is written into the history', async ({ account, stack }) => {
  const token = stack.accountToken();
  const { B, page } = await sessionBoard(stack, account, token);
  const agent = await focusedAgent(stack, token, B);
  const { a, t, d } = await plannedRoute(stack, agent, B);
  await arrive(stack, agent, B, a, 1, 0);
  await expect(progress(page)).toHaveText('1/3 · now: Auth · next: Tests');

  const toggle = rail(page).locator('.session-route-history-toggle');
  await expect(toggle).toHaveText('Route history (2)');
  await toggle.click();
  const history = rail(page).locator('.session-route-history');
  const events = history.locator('li');
  await expect(events).toHaveText(['Planned: Auth, Tests, Docs · checkpoint 0 · revision 1', 'Arrived: Auth · checkpoint 1 · revision 1']);

  const p = await createNode(stack, agent.token, B, 'Deploy');
  await stack.callReducer(agent.token, 'reroute', [B, [p], [1], [t], 'skip tests']);
  await expect(destination(page)).toHaveText('destination: Deploy');
  await expect(rail(page).locator('.session-waypoint-label')).toHaveText(['Auth', 'Docs', 'Deploy']);
  await expect(waypoint(page, a)).toHaveAttribute('data-status', 'current');
  // The live rerender keeps the history open.
  await expect(toggle).toHaveText('Route history (3)');
  await expect(history).toHaveAttribute('open', '');
  await expect(events.nth(2)).toHaveText(`Rerouted: skip tests · added: Deploy (#${p}) · removed: Tests (#${t}) · checkpoint 1 · revision 2`);
  await expect(stack.callReducer(agent.token, 'reroute', [B, [], [], [a], 'drop auth'])).rejects.toThrow(`route rule: cannot change visited waypoint ${a}`);

  // Hidden and deleted waypoints stay listed but cannot be inspected or played.
  await expect(rail(page).locator('.session-route-play')).toBeVisible();
  await stack.callReducer(token, 'set_node_hidden', [d, true, NONE]);
  await expect(waypoint(page, d)).toBeDisabled();
  await expect(waypoint(page, d)).toHaveAttribute('title', 'Cannot inspect Docs (hidden)');
  await expect(waypoint(page, d).locator('.session-waypoint-label')).toHaveText('Docs (hidden)');
  await stack.callReducer(token, 'delete_node', [p]);
  await expect(waypoint(page, p).locator('.session-waypoint-label')).toHaveText(`missing node ${p}`);
  await expect(waypoint(page, p)).toBeDisabled();
  await expect(rail(page).locator('.session-route-play')).toHaveCount(0); // one visible waypoint left
});

test('Play route sends one dot along the waypoints, local to this viewer', async ({ account, stack }) => {
  test.setTimeout(90_000);
  const token = stack.accountToken();
  const { B, href, page } = await sessionBoard(stack, account, token);
  const agent = await focusedAgent(stack, token, B);
  const { a, t, d } = await plannedRoute(stack, agent, B);
  await stack.callReducer(agent.token, 'create_edge', [B, a, t, '', 'agent:route play', NONE, NONE, NONE]);
  await expect(page.locator('#world g.edge')).toHaveCount(1);
  const second = await account(token, WIDE);
  await openBoard(second, href);
  await expect(rail(second).locator('.session-route-play')).toHaveText('▶ Play route');

  const comets = (p: Page) => p.locator('#world .route-comet');
  await Promise.all([page, second].map(watch));
  await rail(page).locator('.session-route-play').click();
  await expect(comets(page)).toHaveCount(1);
  // A replay at once stops the first play long before it could reach Docs.
  await rail(page).locator('.session-route-play').click();
  await expect(comets(page)).toHaveCount(0, { timeout: 20_000 }); // the dot is removed at the end
  const run = await seen(page);
  expect(run.dots).toHaveLength(2); // one dot per play
  expect(run.on['route-hit'].filter(id => id === d)).toHaveLength(1);
  expect(run.on['route-hit'].slice(-3)).toEqual([a, t, d]); // the replay pulses each waypoint as it lands
  expect(new Set(run.at).size).toBeGreaterThan(10); // the dot travels between them
  expect((await seen(second)).dots).toEqual([]); // the other viewer saw no dot at all

  // Reduced motion hops from centre to centre.
  const still = await account(token, { ...WIDE, reducedMotion: 'reduce' });
  await openBoard(still, href);
  await expect(rail(still).locator('.session-route-play')).toBeVisible();
  await watch(still);
  await rail(still).locator('.session-route-play').click();
  await expect(comets(still)).toHaveCount(1);
  await expect(comets(still)).toHaveCount(0, { timeout: 20_000 });
  const hop = await seen(still);
  expect(hop.dots).toHaveLength(1);
  expect(hop.on['route-hit']).toEqual([a, t, d]);
  const centres = await Promise.all([a, t, d].map(async id => {
    const [n] = await stack.sql(`SELECT x, y, w, h FROM node WHERE id = ${id}`);
    return `${(Number(n.x) + Number(n.w) / 2).toFixed(1)},${(Number(n.y) + Number(n.h) / 2).toFixed(1)}`;
  }));
  expect([...new Set(hop.at)].sort()).toEqual(centres.sort());
});

test("an agent's node writes move its focus line, and an empty selection clears it", async ({ account, stack }) => {
  const token = stack.accountToken();
  const { B, page } = await sessionBoard(stack, account, token);
  await drawNode(page, 'Human');
  const human = Number(await nodeNamed(page, 'Human').getAttribute('data-id'));
  await node(page, human).locator('.node-rect').click(at);
  await expect(page.locator('#inspector .insp-title')).toHaveText('Human');
  const agent = await focusedAgent(stack, token, B);

  const auth = await createNode(stack, agent.token, B, 'Auth');
  await expect(focusLine(page)).toHaveText('agent on Auth');
  await expect(page.locator('#inspector .insp-title')).toHaveText('Human'); // the person's own selection stays
  await stack.callReducer(agent.token, 'update_node', [human, { some: 'Human v2' }, ...Array(8).fill(NONE)]);
  await expect(focusLine(page)).toHaveText('agent on Human v2');
  await expect(page.locator('#inspector .insp-title')).toHaveText('Human v2');
  await expect(stack.callReducer(agent.token, 'create_node', [B, 'Off grid', '', 601, 300, 160, 80, 'ink', false, NONE, NONE, NONE, NONE, NONE, NONE, NONE]))
    .rejects.toThrow('grid rule: x = 601 is not divisible by 4');
  await expect(focusLine(page)).toHaveText('agent on Human v2');

  // An explicit selection holds until the next node write; the first selected node names it.
  await stack.callReducer(agent.token, 'set_selection', [B, [auth, human]]);
  await expect(focusLine(page)).toHaveText('agent on Auth');
  await createNode(stack, agent.token, B, 'C');
  await expect(focusLine(page)).toHaveText('agent on C');
  // A node code ref moves it too.
  await stack.callReducer(agent.token, 'add_repo_files', [B, ['src/auth.ts']]);
  await stack.callReducer(agent.token, 'add_code_ref', [B, 'node', human, 'src/auth.ts', 'verify', 1, 1, SHA, '', 'agent']);
  await expect(focusLine(page)).toHaveText('agent on Human v2');
  await stack.callReducer(agent.token, 'set_selection', [B, []]);
  await expect(focusLine(page)).toHaveCount(0);
  await expect(progress(page)).toHaveCount(0); // no route on this board
  await expect(rail(page).locator('.session-line')).toHaveText('no checkpoint yet');
});

test('edge latency stays quiet until the edge is in focus, and updates live', async ({ account, stack }) => {
  test.setTimeout(90_000);
  const token = stack.accountToken();
  const page = await account(token, WIDE);
  await openBoard(page, `${stack.url}?new=1`);
  await drawNode(page, 'web');
  await drawNode(page, 'api');
  await drawEdge(page, 0, 1);
  await page.keyboard.press('Escape');
  await rest(page);
  const B = await boardIdOf(stack, page);
  const [{ id }] = await stack.sql(`SELECT id FROM edge WHERE board_id = ${B}`);
  const e = Number(id);
  const second = await account(token, WIDE);
  await openBoard(second, page.url());
  await expect(second.locator('#world g.edge')).toHaveCount(1);
  const label = (p: Page) => p.locator('#world .edge-labels .edge-label');
  const latency = (ms: number, source: string) => stack.callReducer(token, 'set_edge_latency', [e, ms, source]);

  await latency(38, 'prod');
  await expect(label(page)).toHaveText(''); // placed for the number, which stays quiet
  await nodeNamed(page, 'web').locator('.node-rect').hover(at);
  await expect(label(page)).toHaveText('38ms');
  await latency(13, 'local');
  await nodeNamed(second, 'web').locator('.node-rect').hover(at);
  await expect(label(second)).toHaveText('13ms local');
  await latency(4, 'estimate');
  await expect(label(page)).toHaveText('~4ms');
  await expect(label(second)).toHaveText('~4ms');
  await latency(-1, '');
  await expect(label(page)).toHaveCount(0);
  await expect(label(second)).toHaveCount(0);
  await expect(page.locator('#world g.edge')).toHaveCount(1);
  expect(await stack.sql(`SELECT latency_ms, latency_source FROM edge WHERE id = ${e}`)).toEqual([{ latency_ms: -1, latency_source: '' }]);
  await expect(latency(700000, 'prod')).rejects.toThrow('latency rule: latencyMs must be at most 600000');
  await expect(latency(5, 'guess')).rejects.toThrow("source 'guess' is not allowed");

  // Warmth: 100 ms and up reads warm, 400 ms and up hot; an explicit style turns it off.
  const edge = page.locator('#world g.edge');
  await latency(150, 'prod');
  await expect(edge).toHaveClass(/lat-warm/);
  await latency(500, 'prod');
  await expect(edge).toHaveClass(/lat-hot/);
  await expect(edge).not.toHaveClass(/lat-warm/);
  await page.keyboard.press('Alt+KeyE'); // a hand-drawn edge: the switch shows once the overlay is on
  await expect(page.locator('#overlay-row')).toHaveAttribute('aria-pressed', 'true');
  await expect(edge).not.toHaveClass(/lat-hot/);
  await page.locator('#overlay-row').click();
  await expect(edge).toHaveClass(/lat-hot/);
  await stack.callReducer(token, 'update_edge_style', [e, { some: 'purple' }, NONE]);
  await expect(edge.locator('.edge-line')).toHaveClass(/color-purple/);
  await expect(edge).not.toHaveClass(/lat-hot/);

  // A labelled edge keeps its label and adds the number in focus: '<label> · 38ms'.
  await drawNode(page, 'db');
  const [api, db] = await Promise.all(['api', 'db'].map(async l => Number(await nodeNamed(page, l).getAttribute('data-id'))));
  const [{ evidence }] = await stack.sql(`SELECT evidence FROM edge WHERE id = ${e}`); // the person's own 'human:' citation
  await stack.callReducer(token, 'create_edge', [B, api, db, 'reads', evidence, NONE, NONE, NONE]);
  const [{ id: readsId }] = await stack.sql(`SELECT id FROM edge WHERE board_id = ${B} AND label = 'reads'`);
  await stack.callReducer(token, 'set_edge_latency', [Number(readsId), 38, 'prod']);
  const reads = page.locator('#world .edge-labels', { has: page.locator(`[data-edge-id="${readsId}"]`) }).locator('.edge-label');
  await page.keyboard.press('Escape');
  await nodeNamed(page, 'db').locator('.node-rect').hover(at);
  await expect(reads).toHaveText('reads · 38ms');
  await rest(page);
  await expect(reads).toHaveText('reads');
});

test('a trace replays for every viewer of the board', async ({ account, guest, stack }) => {
  test.setTimeout(90_000);
  const token = stack.accountToken();
  const page = await account(token, WIDE);
  await openBoard(page, `${stack.url}?new=1`);
  await drawNode(page, 'web');
  await drawNode(page, 'api');
  await drawEdge(page, 0, 1);
  await page.keyboard.press('Escape');

  // ⌘K Replay trace works on any board; with no trace it says how to get one.
  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.locator('#palette-input')).toBeFocused();
  await page.locator('#palette-input').fill('replay trace');
  await expect(page.locator('#palette-list')).toContainText('Replay trace');
  await page.keyboard.press('Enter');
  await expect(page.locator('#error-text')).toHaveText('No trace on this board yet. An agent sends one with play_trace.');

  const B = await boardIdOf(stack, page);
  const [web, api] = await Promise.all(['web', 'api'].map(async l => Number(await nodeNamed(page, l).getAttribute('data-id'))));
  const viewer = await guest(WIDE);
  await openBoard(viewer, await shareBoard(page, 'view'));
  await page.locator('#act-share').click(); // closes the share menu
  await expect(viewer.locator('#world g.edge')).toHaveCount(1);
  const spans = [
    { id: 'a', node: String(web), startMs: 0, durationMs: 40 },
    { id: 'b', parent: 'a', node: String(api), startMs: 5, durationMs: 20, status: 'error' },
  ];
  await Promise.all([page, viewer].map(watch));
  await stack.callReducer(token, 'play_trace', [B, JSON.stringify(spans), 'local', 'checkout']);
  await Promise.all([page, viewer].map(async p => {
    await expect(world(p)).toHaveClass(/trace-playing/);
    await expect(world(p)).not.toHaveClass(/trace-playing/, { timeout: 20_000 });
    const run = await seen(p);
    expect(run.dots).toEqual(['route-dot trace-dot error']); // one red dot: the web -> api hop
    expect(run.on['trace-active']).toEqual([web, api]); // each node lit while its span ran, in order
    expect(run.on['trace-error']).toEqual([api]); // only the failed span reads red
  }));

  await expect(stack.callReducer(token, 'play_trace', [B, JSON.stringify([{ id: 'x', node: '999999', startMs: 0, durationMs: 5 }]), 'local', 'bad']))
    .rejects.toThrow('trace rule: span x node 999999 is not on this board');
});

test("a session board's rail names the last trace and replays it", async ({ account, stack }) => {
  test.setTimeout(90_000);
  const token = stack.accountToken();
  const { B, href, page } = await sessionBoard(stack, account, token);
  const web = await createNode(stack, token, B, 'web');
  const api = await createNode(stack, token, B, 'api');
  await expect(world(page)).toContainText('api');
  const spans = [
    { id: 'a', node: String(web), startMs: 0, durationMs: 40 },
    { id: 'b', parent: 'a', node: String(api), startMs: 5, durationMs: 20, status: 'error' },
  ];
  await stack.callReducer(token, 'play_trace', [B, JSON.stringify(spans), 'local', 'checkout']);
  const lastTrace = (p: Page) => rail(p).locator('.session-trace .session-route-progress');
  await expect(lastTrace(page)).toHaveText('last trace: checkout · 2 spans · 40ms · local');
  // It arrived now, so it plays at once.
  await expect(world(page)).toHaveClass(/trace-playing/);

  // Opened when the trace is 31 s old (this browser's clock), it waits for Replay (TF-50).
  const later = await account(token, WIDE);
  await later.clock.install({ time: Date.now() + 31_000 });
  await openBoard(later, href);
  await expect(lastTrace(later)).toHaveText('last trace: checkout · 2 spans · 40ms · local');
  await expect(world(later)).not.toHaveClass(/trace-playing/);
  await rail(later).locator('.session-trace-play').click();
  await expect(world(later)).toHaveClass(/trace-playing/);
});

test('hovering or selecting one node dims all but its neighbours, and an export is settled', async ({ guest, stack }) => {
  test.setTimeout(90_000);
  const page = await guest(WIDE);
  await openBoard(page, stack.url);
  for (const label of ['alpha', 'beta', 'gamma']) await drawNode(page, label);
  await drawEdge(page, 0, 1);
  await page.keyboard.press('Escape');
  await rest(page);
  const [a, b, c] = await page.locator('#world g.node').evaluateAll(nodes => nodes.map(n => Number(n.getAttribute('data-id'))));
  const opacity = (id: number) => node(page, id).evaluate(el => getComputedStyle(el).opacity);
  await expect(world(page)).not.toHaveClass(/focus-dim/);

  await node(page, b).locator('.node-rect').hover(at);
  await expect(world(page)).toHaveClass(/focus-dim/);
  await expect(node(page, a)).toHaveClass(/focus-near/);
  await expect(node(page, b)).toHaveClass(/focus-near/);
  await expect(node(page, c)).not.toHaveClass(/focus-near/);
  await expect(page.locator('#world g.edge')).toHaveClass(/focus-near/);
  await expect.poll(() => opacity(c)).toBe('0.22');
  await rest(page);
  await expect(world(page)).not.toHaveClass(/focus-dim/);

  // A boundary focuses nothing.
  const box = await settledBox(node(page, c));
  await page.keyboard.press('4');
  await page.mouse.click(box.x + box.width + 120, box.y - 200);
  await page.keyboard.press('Escape');
  const boundary = page.locator('#world g.node.node-boundary');
  await expect(boundary).toHaveCount(1);
  await expect(page.locator('#save-status')).toHaveText('Saved');
  await page.keyboard.press('Escape'); // the new boundary is selected: hover alone decides the focus
  await expect(page.locator('#inspector')).toBeHidden();
  await rest(page);
  const inside = await settledBox(boundary);
  await page.mouse.move(inside.x + inside.width / 2, inside.y + inside.height / 2);
  // The same render that shows the hovered boundary's handles would dim the board.
  await expect(page.locator(`#world .edge-handle[data-node-id="${await boundary.getAttribute('data-id')}"]`)).toHaveCount(4);
  await expect(world(page)).not.toHaveClass(/focus-dim/);

  // A sole selection runs flow dashes along its edges; reduced motion and a multi-selection do not.
  const line = page.locator('#world g.edge .edge-line');
  await node(page, a).locator('.node-rect').click(at);
  await expect(world(page)).toHaveClass(/focus-flow/);
  await expect.poll(() => line.evaluate(el => getComputedStyle(el).animationName)).toBe('edge-flow');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(() => line.evaluate(el => getComputedStyle(el).animationName)).toBe('none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await node(page, b).locator('.node-rect').click({ ...at, modifiers: ['Shift'] });
  await expect(page.locator('#inspector .insp-title')).toHaveText('2 nodes');
  await expect(world(page)).not.toHaveClass(/focus-flow/);

  // Export while one node is selected: the file is the settled board, without the selection chrome.
  await node(page, a).locator('.node-rect').click(at);
  await expect(world(page)).toHaveClass(/focus-dim/);
  await expect(world(page)).toHaveClass(/focus-flow/);
  for (const cls of ['selection-outline', 'edge-handle', 'resize-handle']) await expect(page.locator(`#world .${cls}`).first()).toBeAttached();
  const title = await page.locator('#board-title').textContent();
  const file = await exportSvg(page);
  expect(file.suggestedFilename()).toBe(`${title}.svg`);
  let svg = '';
  for await (const chunk of (await file.createReadStream())!) svg += chunk;
  expect(svg).toContain('gamma');
  const hasClass = (cls: string) => new RegExp(`class="(?:[^"]*\\s)?${cls}(?:\\s[^"]*)?"`).test(svg);
  expect(hasClass('edge-line')).toBe(true); // the class test finds a class the file keeps
  for (const cls of ['focus-dim', 'focus-flow', 'resize-handle', 'edge-handle', 'edge-hit', 'selection-outline']) expect(hasClass(cls), cls).toBe(false);
  expect(/<path[^>]*class="edge-line[^"]*"[^>]*>/.exec(svg)?.[0]).toContain('stroke-dasharray:none');
  const [{ x, y }] = await stack.sql(`SELECT x, y FROM node WHERE id = ${c}`);
  const gamma = new RegExp(`<g[^>]*data-id="${c}"[^>]*>`).exec(svg)?.[0] ?? '';
  expect(gamma).toContain(`transform="translate(${x} ${y})"`);
  expect(gamma).toContain('opacity:1;');
  // The board on screen keeps its focus.
  await expect(world(page)).toHaveClass(/focus-dim/);
});
