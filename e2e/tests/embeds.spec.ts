import { test, expect } from '../fixtures';
import { DbConnection } from '../../client/src/module_bindings';
import { CHART_CONTRACTS, CHART_TYPES } from '../../module/src/chart-contracts';
import type { Browser, Page } from '@playwright/test';
import type { withStack } from '../stack';
import { createServer } from 'node:http';
import { once } from 'node:events';

const NONE = { none: [] };
const some = (value: string) => ({ some: value });
const CSV = 'region,requests\nEurope,24\nAmericas,42\nAsia,32\n';
type Stack = Parameters<Parameters<typeof withStack>[0]>[0];

async function chartFixture(stack: Stack, browser: Browser) {
  const token = stack.accountToken();
  const name = `Embed ${Date.now()}`;
  await stack.callReducer(token, 'create_board', [name]);
  const [board] = await stack.sql(`SELECT id, slug FROM board WHERE name = '${name}'`);
  const boardId = Number(board.id);
  for (const [title, csv, x] of [['Requests by region', CSV, 0], ['PRIVATE chart', 'secret,value\nprivate-key,999\n', 500]] as const) {
    await stack.callReducer(token, 'create_chart', [boardId, title, 'Last hour', x, 0, 352, 224, 'bars', csv, NONE, some('Metrics service')]);
  }
  const nodes = await stack.sql(`SELECT id FROM node WHERE board_id = ${boardId}`);
  const nodeId = Number(nodes[0].id), otherId = Number(nodes[1].id);
  const context = await browser.newContext();
  await context.addInitScript(value => { Object.assign(window, { __e2eAccountToken: value }); }, token);
  const page = await context.newPage();
  await page.goto(`${stack.url}#b=${board.slug}`);
  await expect(page.locator('#world .node')).toHaveCount(2);
  await page.locator(`#world .node[data-id="${nodeId}"]`).click({ position: { x: 12, y: 12 } });
  await page.getByRole('button', { name: 'Embed chart', exact: true }).click();
  await page.getByRole('switch', { name: 'Enable embed access' }).check();
  const link = page.getByRole('textbox', { name: 'Embed URL', exact: true });
  await expect(link).toHaveValue(/#e=[a-f0-9]{32}$/);
  return { page, token, nodeId, otherId, boardId, url: await link.inputValue(), close: () => context.close() };
}

async function standaloneHost(page: Page, url: string) {
  // A real second origin: route.fulfill has an unknown address space and
  // Chromium blocks its loopback subframes with Local Network Access checks.
  const server = createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><html><body style="margin:0"><iframe title="Chart" src="${url}" style="width:480px;height:360px;border:0"></iframe></body></html>`));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  page.once('close', () => server.close());
  await page.goto(`http://localhost:${(server.address() as { port: number }).port}/`);
  return page.frameLocator('iframe');
}

test('owner publishes a live chart in a third-party iframe and revokes an open embed', async ({ browser, guest, stack }) => {
  test.setTimeout(90_000);
  const fixture = await chartFixture(stack, browser);
  try {
    await expect(fixture.page.getByRole('textbox', { name: 'Iframe snippet' })).toHaveValue(/<iframe .*loading="lazy"/);
    await expect(fixture.page.locator('#act-share')).toHaveText('Share');
    const viewer = await guest();
    // Notion/third-party frames may have neither cookies nor storage access.
    await viewer.addInitScript(() => {
      for (const storage of ['localStorage', 'sessionStorage']) Object.defineProperty(window, storage, { get() { throw new Error('Third-party storage denied'); } });
    });
    const errors: string[] = [];
    viewer.on('pageerror', err => errors.push(err.message));
    const frame = await standaloneHost(viewer, fixture.url);
    await expect(frame.locator('#embed-title')).toHaveText('Requests by region');
    await expect(frame.locator('.chart-bar')).toHaveCount(3);
    await expect(frame.locator('body')).not.toContainText('PRIVATE');
    await expect(frame.locator('#dock, #toolbar, #inspector, #act-share, #sign-in')).toHaveCount(0);
    await expect(frame.getByRole('link', { name: 'Open in Draw' })).toHaveAttribute('target', '_blank');
    await frame.locator('#viewer-theme').selectOption('dark');
    await expect(frame.locator('html')).toHaveAttribute('data-theme', 'dark');
    await frame.locator('#viewer-theme').selectOption('light');
    await expect(frame.locator('html')).toHaveAttribute('data-theme', 'light');
    await frame.locator('.chart-bar').first().hover();
    await expect(frame.getByRole('tooltip')).toContainText('Europe');
    await frame.getByRole('button', { name: 'Pause animations' }).click();
    await expect(frame.getByRole('button', { name: 'Resume animations' })).toHaveAttribute('aria-pressed', 'true');
    await frame.getByRole('button', { name: 'Resume animations' }).click();
    await stack.callReducer(fixture.token, 'set_chart_data', [fixture.nodeId, NONE, some(CSV.replace('24', '36')), NONE, some('Live metrics')]);
    await expect(frame.locator('#embed-source')).toContainText('Live metrics');
    await expect(frame.locator('.chart-bar').first()).toHaveAttribute('data-tip', /36/);
    await frame.locator('#embed-data summary').click();
    await expect(frame.locator('#embed-data table')).toContainText('Europe');
    await expect(frame.locator('#embed-data table')).toContainText('36');
    await frame.locator('#embed-data summary').click();
    await viewer.locator('iframe').evaluate(iframe => { iframe.style.width = '260px'; });
    await expect.poll(() => frame.locator('#embed-chart').getAttribute('viewBox')).toMatch(/^0 0 236 /);
    // Replay starts a real grow transition. Moving the frame out of view
    // pauses it even though the top-level document remains visible.
    await viewer.locator('iframe').evaluate(iframe => { iframe.style.marginTop = '2000px'; });
    await expect.poll(() => frame.locator('html').evaluate(root => new Promise<boolean>(resolve => {
      const observer = new IntersectionObserver(entries => { observer.disconnect(); resolve(entries[0].isIntersecting); });
      observer.observe(root);
    }))).toBe(false);
    await frame.getByRole('button', { name: 'Replay', exact: true }).evaluate(button => button.click());
    await viewer.waitForTimeout(150);
    await expect.poll(() => frame.locator('.chart-bar').first().evaluate(mark => (mark as SVGElement).style.transform)).toBe('scaleY(0)');
    await viewer.locator('iframe').evaluate(iframe => { iframe.style.marginTop = '0'; });
    await expect.poll(() => frame.locator('.chart-bar').first().evaluate(mark => (mark as SVGElement).style.transform)).toBe('');
    await viewer.emulateMedia({ reducedMotion: 'reduce' });
    await expect(frame.getByRole('button', { name: 'Replay', exact: true })).toBeDisabled();
    await viewer.locator('iframe').screenshot({ path: '../.context/chart-embed-mobile.png' });
    expect(errors).toEqual([]);

    await fixture.page.getByRole('switch', { name: 'Enable embed access' }).uncheck();
    await expect(frame.locator('#embed-title')).toHaveText('Chart unavailable');
    await expect(frame.locator('.chart-bar')).toHaveCount(0);
    await expect(frame.locator('#embed-status')).toContainText('no longer embedded');
    await stack.callReducer(fixture.token, 'set_chart_data', [fixture.nodeId, NONE, some(CSV), NONE, some('Do not publish')]);
    await expect(frame.locator('body')).not.toContainText('Do not publish');
    await fixture.page.getByRole('switch', { name: 'Enable embed access' }).check();
    await expect(fixture.page.locator('#embed-url')).not.toHaveValue(fixture.url);
    const reopened = await guest();
    await reopened.goto(fixture.url);
    await expect(reopened.locator('#embed-status')).toContainText('no longer embedded');
  } finally { await fixture.close(); }
});

test('a chart capability cannot read or write its board, neighboring charts, or private storage', async ({ browser, stack }) => {
  const fixture = await chartFixture(stack, browser);
  const capability = new URL(fixture.url).hash.slice(3);
  let conn: DbConnection | undefined;
  let publicBoardId: bigint | undefined;
  try {
    // Anonymous connections also read public boards, independently of embed access.
    const publicName = `Public embed neighbor ${Date.now()}`;
    await stack.callReducer(fixture.token, 'create_board', [publicName]);
    const [publicBoard] = await stack.sql(`SELECT id FROM board WHERE name = '${publicName}'`);
    publicBoardId = BigInt(String(publicBoard.id));
    await stack.sql(`INSERT INTO public_board (board_id) VALUES (${publicBoardId})`);
    conn = await new Promise<DbConnection>((resolve, reject) => {
      DbConnection.builder().withUri(stack.databaseUrl).withDatabaseName(stack.databaseName)
        .onConnect(connection => resolve(connection)).onConnectError((_ctx, error) => reject(error)).build();
    });
    const queries = ['embedded_chart', 'embedded_board', 'my_board_embeds', 'visible_board', 'visible_node', 'visible_edge', 'visible_chart', 'visible_code_ref', 'visible_threat', 'visible_change_note', 'visible_session', 'visible_repo_file', 'my_boards', 'my_chart_embeds'];
    await new Promise<void>((resolve, reject) => conn!.subscriptionBuilder().onApplied(() => resolve()).onError(ctx => reject(ctx.event)).subscribe(queries.map(q => `SELECT * FROM ${q}`)));
    const normalViews = {
      visibleBoard: conn.db.visibleBoard, visibleNode: conn.db.visibleNode, visibleEdge: conn.db.visibleEdge,
      visibleChart: conn.db.visibleChart, visibleCodeRef: conn.db.visibleCodeRef, visibleThreat: conn.db.visibleThreat,
      visibleChangeNote: conn.db.visibleChangeNote, visibleSession: conn.db.visibleSession, visibleRepoFile: conn.db.visibleRepoFile,
      myBoards: conn.db.myBoards, myChartEmbeds: conn.db.myChartEmbeds, myBoardEmbeds: conn.db.myBoardEmbeds, embeddedBoard: conn.db.embeddedBoard,
    };
    expect([...conn.db.visibleBoard.iter()]).toContainEqual(expect.objectContaining({ id: publicBoardId }));
    expect([...conn.db.visibleBoard.iter()]).not.toContainEqual(expect.objectContaining({ id: BigInt(fixture.boardId) }));
    for (const nodeId of [fixture.nodeId, fixture.otherId]) {
      expect([...conn.db.visibleNode.iter()]).not.toContainEqual(expect.objectContaining({ id: BigInt(nodeId) }));
      expect([...conn.db.myChartEmbeds.iter()]).not.toContainEqual(expect.objectContaining({ nodeId: BigInt(nodeId) }));
    }
    const before = new Map(Object.entries(normalViews).map(([name, table]) => {
      const rows = [...table.iter()];
      expect(rows, name).not.toContainEqual(expect.objectContaining({ boardId: BigInt(fixture.boardId) }));
      return [name, rows];
    }));
    for (const table of [conn.db.visibleThreat, conn.db.visibleRepoFile, conn.db.myChartEmbeds, conn.db.myBoardEmbeds, conn.db.embeddedBoard]) expect([...table.iter()]).toEqual([]);
    expect([...conn.db.embeddedChart.iter()]).toEqual([]);
    await conn.reducers.openChartEmbed({ token: capability });
    await expect.poll(() => [...conn!.db.embeddedChart.iter()].length).toBe(1);
    expect([...conn.db.embeddedChart.iter()]).toEqual([expect.objectContaining({ title: 'Requests by region', csv: CSV })]);
    expect(Object.keys([...conn.db.embeddedChart.iter()][0]).sort()).toEqual(['csv', 'options', 'source', 'subtitle', 'title', 'token', 'type']);
    // Opening the chart may add only its sanitized embed row, never normal board access.
    for (const [name, table] of Object.entries(normalViews)) expect([...table.iter()], name).toEqual(before.get(name));
    await expect(conn.reducers.openBoards({ boardIds: [BigInt(fixture.boardId)] })).rejects.toThrow();
    await expect(conn.reducers.setChartData({ nodeId: BigInt(fixture.nodeId), csv: CSV })).rejects.toThrow();
    await expect(conn.reducers.enableChartEmbed({ nodeId: BigInt(fixture.otherId), token: 'cd'.repeat(16) })).rejects.toThrow();
    await expect(conn.reducers.disableChartEmbed({ nodeId: BigInt(fixture.nodeId) })).rejects.toThrow();
    await expect(conn.reducers.openSharedLink({ token: capability })).rejects.toThrow();
    for (const table of ['chart', 'node', 'chart_embed', 'chart_embed_visit', 'board_embed', 'board_embed_visit']) {
      await new Promise<void>((resolve, reject) => conn!.subscriptionBuilder().onApplied(() => reject(new Error(`${table} was exposed`))).onError(() => resolve()).subscribe([`SELECT * FROM ${table}`]));
    }
    await stack.callReducer(fixture.token, 'disable_chart_embed', [fixture.nodeId]);
    await expect.poll(() => [...conn!.db.embeddedChart.iter()].length).toBe(0);
    await expect(conn.reducers.openChartEmbed({ token: capability })).rejects.toThrow();
  } finally {
    conn?.disconnect();
    if (publicBoardId !== undefined) await stack.sql(`DELETE FROM public_board WHERE board_id = ${publicBoardId}`);
    await fixture.close();
  }
});

test('every existing chart renderer fits a narrow anonymous embed; deleting the source revokes it', async ({ browser, guest, stack }) => {
  test.setTimeout(90_000);
  const fixture = await chartFixture(stack, browser);
  try {
    const viewer = await guest();
    await viewer.setViewportSize({ width: 320, height: 420 });
    await viewer.goto(fixture.url);
    for (const type of CHART_TYPES) {
      await stack.callReducer(fixture.token, 'set_chart_data', [fixture.nodeId, some(type), some(CHART_CONTRACTS[type].example), some('{}'), some('Renderer fixture')]);
      await expect(viewer.locator('#embed-chart')).toHaveAttribute('data-chart-type', type);
      await expect(viewer.locator('#embed-status')).toBeHidden();
      await expect.poll(() => viewer.locator('.chart-plot > *').count()).toBeGreaterThan(0);
      expect(await viewer.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await viewer.screenshot({ path: '../.context/chart-embed-chart.png' });
    await stack.callReducer(fixture.token, 'delete_node', [fixture.nodeId]);
    await expect(viewer.locator('#embed-title')).toHaveText('Chart unavailable');
    expect(await stack.sql(`SELECT * FROM chart_embed WHERE node_id = ${fixture.nodeId}`)).toEqual([]);
  } finally { await fixture.close(); }
});

test('board embeds publish visual content only and pause real diagram playback', async ({ browser, guest, stack }) => {
  test.setTimeout(90_000);
  const f = await chartFixture(stack, browser);
  let conn: DbConnection | undefined;
  try {
    await stack.callReducer(f.token, 'create_node', [f.boardId, 'API', 'Public service', 0, 320, 176, 80, 'ink', false, some('service'), some('PRIVATE NODE DOC'), NONE, NONE, NONE, NONE, NONE]);
    await stack.callReducer(f.token, 'create_node', [f.boardId, 'Database', '', 400, 320, 176, 80, 'ink', false, some('datastore'), NONE, NONE, NONE, NONE, NONE, NONE]);
    await stack.callReducer(f.token, 'create_node', [f.boardId, 'HIDDEN NODE', '', 600, 640, 176, 80, 'ink', false, some('service'), NONE, NONE, NONE, NONE, NONE, NONE]);
    const services = await stack.sql(`SELECT id FROM node WHERE board_id = ${f.boardId} AND kind <> 'chart'`);
    const [api, database, hidden] = services.map(n => Number(n.id));
    await stack.callReducer(f.token, 'set_node_hidden', [hidden, true, NONE]);
    await stack.callReducer(f.token, 'create_edge', [f.boardId, api, database, 'requests', 'human:PRIVATE EVIDENCE', NONE, NONE, NONE]);
    const [edge] = await stack.sql(`SELECT id FROM edge WHERE board_id = ${f.boardId}`);
    await stack.callReducer(f.token, 'set_node_icon', [api, 'queue']);
    await stack.callReducer(f.token, 'set_edge_weight', [Number(edge.id), 'bold']);
    await stack.callReducer(f.token, 'add_threat', [f.boardId, api, 'compromised', 'critical', 'Exposed credential', 'PRIVATE THREAT DETAILS', '', '', '', '[]', '', 'e2e']);
    await f.page.locator('#embed-scope').selectOption('board');
    await f.page.getByRole('switch', { name: 'Enable embed access' }).check();
    await expect(f.page.locator('#embed-url')).toHaveValue(/kind=board.*#e=/);
    const boardUrl = await f.page.locator('#embed-url').inputValue();
    const token = new URL(boardUrl).hash.slice(3);
    const viewer = await guest();
    const frame = await standaloneHost(viewer, boardUrl);
    await expect(frame.locator('#world .node')).toHaveCount(4);
    await expect(frame.locator('#embed-chart')).toHaveAccessibleName('Read-only diagram. Use arrow keys to pan, or the zoom and fit buttons.');
    await expect(frame.locator('#world .edge')).toHaveCount(1);
    await expect(frame.locator('#world .node-icon-slot[role="img"]')).toHaveCount(1);
    await expect(frame.locator('#world .edge-line')).toHaveClass(/weight-bold/);
    await expect(frame.locator('#embed-mode option')).toHaveCount(1);
    await expect(frame.locator('body')).not.toContainText('HIDDEN NODE');
    await expect(frame.locator('body')).not.toContainText('PRIVATE NODE DOC');
    await frame.getByRole('button', { name: 'Play', exact: true }).click();
    await expect.poll(() => frame.locator('#world').getAttribute('data-playback-ms')).not.toBe('0');
    await frame.getByRole('button', { name: 'Pause', exact: true }).click();
    const paused = await frame.locator('#world').getAttribute('data-playback-ms');
    await viewer.waitForTimeout(250);
    expect(await frame.locator('#world').getAttribute('data-playback-ms')).toBe(paused);
    await frame.getByRole('button', { name: 'Replay', exact: true }).click();
    await viewer.locator('iframe').evaluate(iframe => { iframe.style.marginTop = '2000px'; });
    await expect(frame.locator('body')).toHaveClass(/motion-paused/);
    const offscreen = await frame.locator('#world').getAttribute('data-playback-ms');
    await viewer.waitForTimeout(250);
    expect(await frame.locator('#world').getAttribute('data-playback-ms')).toBe(offscreen);
    await viewer.locator('iframe').evaluate(iframe => { iframe.style.marginTop = '0'; });
    await expect.poll(() => frame.locator('#world').getAttribute('data-playback-ms')).not.toBe(offscreen);
    await frame.getByRole('button', { name: 'Pause', exact: true }).click();
    await frame.getByRole('checkbox', { name: 'Loop', exact: true }).check();

    // Owner must explicitly include the sensitive layer, and can remove it live.
    await f.page.locator('#embed-threats').check();
    await expect(frame.locator('#embed-mode option')).toHaveCount(2);
    await frame.locator('#embed-mode').selectOption({ label: 'Threat: Exposed credential' });
    await frame.getByRole('button', { name: 'Play', exact: true }).click();
    await expect.poll(() => frame.locator('.embed-reached').count()).toBeGreaterThan(0);
    await frame.getByRole('button', { name: 'Pause', exact: true }).click();
    await viewer.locator('iframe').screenshot({ path: '../.context/board-embed-playback.png' });

    conn = await new Promise<DbConnection>((resolve, reject) => {
      DbConnection.builder().withUri(stack.databaseUrl).withDatabaseName(stack.databaseName)
        .onConnect(connection => resolve(connection)).onConnectError((_ctx, error) => reject(error)).build();
    });
    await new Promise<void>((resolve, reject) => conn!.subscriptionBuilder().onApplied(() => resolve()).onError(ctx => reject(ctx.event))
      .subscribe(['embedded_board', 'embedded_chart', 'visible_node', 'visible_board', 'visible_chart', 'my_board_embeds'].map(q => `SELECT * FROM ${q}`)));
    const normalViews = {
      visibleNode: conn.db.visibleNode, visibleBoard: conn.db.visibleBoard, visibleChart: conn.db.visibleChart,
      embeddedChart: conn.db.embeddedChart, myBoardEmbeds: conn.db.myBoardEmbeds,
    };
    expect([...conn.db.visibleBoard.iter()]).not.toContainEqual(expect.objectContaining({ id: BigInt(f.boardId) }));
    const before = new Map(Object.entries(normalViews).map(([name, table]) => {
      const rows = [...table.iter()];
      expect(rows, name).not.toContainEqual(expect.objectContaining({ boardId: BigInt(f.boardId) }));
      return [name, rows];
    }));
    for (const table of [conn.db.embeddedChart, conn.db.myBoardEmbeds, conn.db.embeddedBoard]) expect([...table.iter()]).toEqual([]);
    await conn.reducers.openBoardEmbed({ token });
    await expect.poll(() => [...conn!.db.embeddedBoard.iter()].length).toBe(1);
    const published = JSON.parse([...conn.db.embeddedBoard.iter()][0].scene);
    expect(published.nodes).toHaveLength(4);
    expect(published.before).toBeNull();
    expect(published.threats).toEqual([expect.objectContaining({ title: 'Exposed credential' })]);
    const serialized = JSON.stringify(published);
    for (const secret of ['PRIVATE NODE DOC', 'PRIVATE EVIDENCE', 'PRIVATE THREAT DETAILS', 'HIDDEN NODE', 'createdBy', 'evidenceSnippet', 'boardId']) expect(serialized).not.toContain(secret);
    for (const [name, table] of Object.entries(normalViews)) expect([...table.iter()], name).toEqual(before.get(name));
    await expect(conn.reducers.setChartData({ nodeId: BigInt(f.nodeId), csv: CSV })).rejects.toThrow();
    await expect(conn.reducers.openSharedLink({ token })).rejects.toThrow();
    await expect(conn.reducers.openChartEmbed({ token })).rejects.toThrow();
    await expect(conn.reducers.disableBoardEmbed({ boardId: BigInt(f.boardId) })).rejects.toThrow();
    await expect(conn.reducers.openBoardEmbed({ token: new URL(f.url).hash.slice(3) })).rejects.toThrow();

    await f.page.locator('#embed-threats').uncheck();
    await expect(frame.locator('#embed-mode option')).toHaveCount(1);
    await expect.poll(() => JSON.parse([...conn!.db.embeddedBoard.iter()][0].scene).threats).toEqual([]);
    await stack.callReducer(f.token, 'set_chart_data', [f.nodeId, NONE, some(CSV.replace('24', '51')), NONE, some('Live board metrics')]);
    await expect(frame.locator('.chart-bar').first()).toHaveAttribute('data-tip', /51/);
    // Pausing playback must keep live chart edits visible, including after scene rebuilds.
    await expect(frame.locator('.chart-bar').first()).toHaveCSS('transform', 'none');
    await viewer.locator('iframe').evaluate(iframe => { iframe.style.width = '260px'; });
    expect(await frame.locator('html').evaluate(root => root.scrollWidth <= innerWidth)).toBe(true);
    await viewer.emulateMedia({ reducedMotion: 'reduce' });
    await expect(frame.getByRole('button', { name: 'Replay', exact: true })).toBeDisabled();
    await expect(frame.locator('#embed-progress')).toHaveText('Reduced motion · static view');
    await f.page.getByRole('switch', { name: 'Enable embed access' }).uncheck();
    await expect(frame.locator('#embed-title')).toHaveText('Board unavailable');
    await expect(frame.locator('#world .node')).toHaveCount(0);
    await expect.poll(() => [...conn!.db.embeddedBoard.iter()]).toEqual([]);
    await expect(conn.reducers.openBoardEmbed({ token })).rejects.toThrow();
    // The separate chart capability still works after board revocation.
    const chart = await guest(); await chart.goto(f.url);
    await expect(chart.locator('#embed-title')).toHaveText('Requests by region');
  } finally { conn?.disconnect(); await f.close(); }
});

test('architecture comparison is opt-in, plays before/after changes and loses revoked baseline access live', async ({ browser, guest, stack }) => {
  test.setTimeout(90_000);
  const owner = stack.accountToken();
  const name = `Architecture embed ${Date.now()}`;
  const refs = [{ ref: 'before', sha: 'a'.repeat(40) }, { ref: 'after', sha: 'b'.repeat(40) }];
  await stack.callReducer(owner, 'create_architecture_history', [name, 'https://github.com/example/embeds', JSON.stringify(refs), `embed-${Date.now()}`]);
  const [history] = await stack.sql(`SELECT id FROM architecture_history WHERE name = '${name}'`);
  const service = await fetch(`${stack.databaseUrl}/v1/identity`, { method: 'POST' }).then(r => r.json());
  await stack.sql(`INSERT INTO service_account (identity, label) VALUES (0x${service.identity}, 'embed-test')`);
  const node = (key: string, label: string, kind = 'service') => ({ key, label, sublabel: '', kind });
  const edge = (from: string, to: string) => ({ from, to, label: 'calls', relation: 'imports', evidence: 'import' });
  const before = { nodes: [node('PRIVATE/path/api', 'API'), node('PRIVATE/path/old', 'Old worker')], edges: [edge('PRIVATE/path/api', 'PRIVATE/path/old')], files: [] };
  const after = { nodes: [node('PRIVATE/path/api', 'API', 'external'), node('PRIVATE/path/new', 'New worker')], edges: [edge('PRIVATE/path/api', 'PRIVATE/path/new')], files: [] };
  for (const [i, g] of [before, after].entries()) await stack.callReducer(service.token, 'publish_architecture_snapshot', [Number(history.id), i, refs[i].ref, refs[i].sha, JSON.stringify(g)]);
  const versions = await stack.sql(`SELECT board_id FROM architecture_version WHERE history_id = ${history.id}`);
  const [baseId, boardId] = versions.map(v => Number(v.board_id));
  // Seed styling on the imported baseline as the test operator; snapshots are immutable.
  const [oldNode] = await stack.sql(`SELECT id FROM node WHERE board_id = ${baseId} AND label = 'Old worker'`);
  const [oldEdge] = await stack.sql(`SELECT id FROM edge WHERE board_id = ${baseId}`);
  await stack.sql(`INSERT INTO node_icon (node_id, board_id, icon) VALUES (${oldNode.id}, ${baseId}, 'queue')`);
  await stack.sql(`INSERT INTO edge_weight (edge_id, board_id, weight) VALUES (${oldEdge.id}, ${baseId}, 'bold')`);
  const [board] = await stack.sql(`SELECT slug FROM board WHERE id = ${boardId}`);
  const context = await browser.newContext();
  await context.addInitScript(value => { Object.assign(window, { __e2eAccountToken: value }); }, owner);
  const page = await context.newPage();
  try {
    await page.goto(`${stack.url}#b=${board.slug}`);
    await expect(page.locator('#world .node')).toHaveCount(2);
    await page.getByRole('button', { name: 'Embed board', exact: true }).click();
    await page.getByRole('switch', { name: 'Enable embed access' }).check();
    await expect(page.locator('#embed-url')).toHaveValue(/kind=board.*#e=/);
    const url = await page.locator('#embed-url').inputValue();
    const viewer = await guest(); await viewer.goto(url);
    await expect(viewer.locator('#world .node')).toHaveCount(2);
    await expect(viewer.locator('#embed-mode option[value="architecture"]')).toHaveCount(0);
    await page.locator('#embed-comparison').check();
    await expect(viewer.locator('#embed-mode option[value="architecture"]')).toHaveCount(1);
    await viewer.locator('#embed-mode').selectOption('architecture');
    await expect(viewer.locator('#world .node')).toHaveCount(3);
    await expect(viewer.locator('#world .node.diff-added')).toHaveCount(1);
    await expect(viewer.locator('#world .node.diff-removed')).toHaveCount(1);
    await expect(viewer.locator('#world .node.diff-changed')).toHaveCount(1);
    await expect(viewer.locator('#world .node.diff-removed .node-icon-slot')).toHaveAccessibleName('Queue');
    await expect(viewer.locator('#world .edge-line.diff-removed')).toHaveClass(/weight-bold/);
    await viewer.getByRole('button', { name: 'Play', exact: true }).click();
    await expect.poll(() => viewer.locator('#world').getAttribute('data-playback-ms')).not.toBe('0');
    await viewer.getByRole('button', { name: 'Pause', exact: true }).click();
    const opacity = await viewer.locator('.node.diff-added').evaluate(n => (n as SVGElement).style.opacity);
    await viewer.waitForTimeout(150);
    expect(await viewer.locator('.node.diff-added').evaluate(n => (n as SVGElement).style.opacity)).toBe(opacity);
    await viewer.getByRole('button', { name: 'Replay', exact: true }).click();
    await expect(viewer.locator('#embed-progress')).toHaveText('100%');
    await viewer.screenshot({ path: '../.context/architecture-embed-playback.png' });
    // SQL is the test operator: remove the publisher's access to the baseline.
    await stack.sql(`DELETE FROM board_grant WHERE board_id = ${baseId}`);
    await expect(viewer.locator('#embed-mode option[value="architecture"]')).toHaveCount(0);
    await expect(viewer.locator('#world .node')).toHaveCount(2);
    await expect(viewer.locator('body')).not.toContainText('Old worker');
    await page.getByRole('switch', { name: 'Enable embed access' }).uncheck();
    await expect(viewer.locator('#embed-title')).toHaveText('Board unavailable');
  } finally {
    await context.close();
    await stack.sql(`DELETE FROM service_account WHERE identity = 0x${service.identity}`);
  }
});

test('session routes highlight paths in order; source deletion revokes a board capability', async ({ guest, stack }) => {
  const owner = stack.accountToken(), name = `Route embed ${Date.now()}`;
  await stack.callReducer(owner, 'start_session', [name, '/tmp/embed-route', 'a'.repeat(40)]);
  const [board] = await stack.sql(`SELECT id FROM board WHERE name = '${name}'`);
  const boardId = Number(board.id);
  for (const [i, label] of ['Gateway', 'Service', 'Store'].entries()) await stack.callReducer(owner, 'create_node', [boardId, label, '', i * 240, 0, 176, 80, 'ink', false, some('service'), NONE, NONE, NONE, NONE, NONE, NONE]);
  const nodes = await stack.sql(`SELECT id FROM node WHERE board_id = ${boardId}`);
  const ids = nodes.map(n => Number(n.id));
  for (let i = 1; i < ids.length; i++) await stack.callReducer(owner, 'create_edge', [boardId, ids[i - 1], ids[i], 'calls', 'human:e2e', NONE, NONE, NONE]);
  await stack.callReducer(owner, 'plan_route', [boardId, ids]);
  const token = 'ef'.repeat(16);
  await stack.callReducer(owner, 'enable_board_embed', [boardId, token, false, 0]);
  const url = new URL('embed.html?kind=board', stack.url); url.hash = `e=${token}`;
  const viewer = await guest(); await viewer.goto(url.href);
  await expect(viewer.locator('#world .node')).toHaveCount(3);
  await viewer.locator('#embed-mode').selectOption('route');
  await viewer.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(viewer.locator('#world .embed-path')).toHaveCount(2);
  await expect(viewer.locator('#world .embed-reached')).toHaveCount(3);
  await expect(viewer.locator('#embed-progress')).toHaveText('100%');
  await viewer.getByRole('checkbox', { name: 'Loop', exact: true }).check();
  await viewer.getByRole('button', { name: 'Replay', exact: true }).click();
  await expect.poll(() => viewer.locator('#world').getAttribute('data-playback-ms')).not.toBe('0');
  await stack.callReducer(owner, 'delete_board', [boardId]);
  await expect(viewer.locator('#embed-title')).toHaveText('Board unavailable');
  await expect(viewer.locator('#world .node')).toHaveCount(0);
  expect(await stack.sql(`SELECT * FROM board_embed WHERE board_id = ${boardId}`)).toEqual([]);
  expect(await stack.sql(`SELECT * FROM board_embed_visit WHERE board_id = ${boardId}`)).toEqual([]);
});
