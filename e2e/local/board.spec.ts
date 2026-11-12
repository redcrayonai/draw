import { test, expect } from '@playwright/test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('packaged local board: tool edits, browser drag, review, concurrent tab and restart', async ({ browser }) => {
  const root = resolve(import.meta.dirname, '../..');
  const directory = mkdtempSync(join(tmpdir(), 'draw-browser-'));
  const native = process.env.DRAW_LOCAL_BINARY;
  if (native) {
    mkdirSync(join(directory, 'package'));
    copyFileSync(native, join(directory, 'package/draw'));
  } else cpSync(join(root, 'helper/dist'), join(directory, 'package'), { recursive: true, filter: path => path !== join(root, 'helper/dist/binary') });
  const executable = join(directory, native ? 'package/draw' : 'package/redcrayon.mjs');
  const runtime = process.env.DRAW_LOCAL_NODE ?? process.execPath;
  const launch = native ? executable : runtime;
  const prefix = native ? [] : [executable];
  const environment = { ...process.env };
  if (native) {
    // A single-file install must work without Node or Bun anywhere on PATH.
    mkdirSync(join(directory, 'path'));
    symlinkSync(execFileSync('which', ['git'], { encoding: 'utf8' }).trim(), join(directory, 'path/git'));
    environment.PATH = join(directory, 'path');
    environment.DRAW_OPEN_URL_FILE = join(directory, 'opened-url');
    writeFileSync(join(directory, 'path', process.platform === 'darwin' ? 'open' : 'xdg-open'), '#!/bin/sh\nprintf %s "$1" > "$DRAW_OPEN_URL_FILE"\n', { mode: 0o755 });
  }
  let child: ChildProcess;
  let endpoint: { origin: string; token: string };
  async function start() {
    child = spawn(launch, [...prefix, 'local', '--repo', root, '--store', directory], { cwd: directory, env: environment, stdio: ['ignore', 'ignore', 'pipe'] });
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject); child.once('exit', code => reject(new Error(`server exited ${code}`)));
      child.stderr!.on('data', data => { if (data.toString().includes('Draw:')) resolve(); });
    });
    endpoint = JSON.parse(readFileSync(join(directory, 'endpoint.json'), 'utf8'));
  }
  async function stop() {
    await new Promise<void>(resolve => { child.once('exit', () => resolve()); child.kill('SIGTERM'); });
  }
  const call = async (input: unknown) => {
    const response = await fetch(`${endpoint.origin}/api/call`, { method: 'POST', headers: { Authorization: `Bearer ${endpoint.token}` }, body: JSON.stringify(input) });
    expect(response.ok).toBeTruthy(); return response.json();
  };
  const context = await browser.newContext();
  async function cli(command: string[], input: string) {
    const child = spawn(launch, [...prefix, ...command, '--repo', root, '--store', directory], { cwd: directory, env: environment, stdio: 'pipe' });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    const done = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    child.stdin.end(input); return { code: await done, stdout, stderr };
  }
  try {
    await start();
    if (native) {
      const reopened = await cli([], '');
      expect(reopened.code).toBe(0);
      await expect.poll(() => { try { return readFileSync(environment.DRAW_OPEN_URL_FILE!, 'utf8'); } catch { return ''; } }).toContain(endpoint.origin);
    }
    const page = await context.newPage();
    const errors: string[] = [], external: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (!request.url().startsWith(endpoint.origin)) external.push(request.url()); });
    await page.goto(`${endpoint.origin}/#local&key=${endpoint.token}`);
    await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => document.fonts.check('12px Geist') && document.fonts.check('12px "Geist Mono"'))).toBe(true);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'material-light');
    await page.getByRole('button', { name: 'Theme: Material Light', exact: true }).click();
    await page.locator('[data-theme-opt="dark"]').click();
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.getByRole('button', { name: 'Theme: Dark', exact: true }).click();
    await page.locator('[data-theme-opt="material-light"]').click();
    await expect(page.locator('#status')).toHaveText('Create your first board');
    const opened = await cli(['local-mcp'], JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'open_board', arguments: { name: 'Local architecture' } } }));
    expect(opened.code).toBe(0);
    const board = JSON.parse(JSON.parse(opened.stdout).result.content[0].text);
    const created = await cli(['local-mcp'], JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'apply_board', arguments: { board: board.slug, revision: 0, operations: [
      { type: 'node.put', patch: { label: 'API', x: 120, y: 160 } },
      { type: 'node.put', patch: { label: 'Database', x: 440, y: 160 } },
      { type: 'edge.put', patch: { from: '1', to: '2', label: 'queries' } },
    ] } } }));
    expect(created.code).toBe(0); expect(JSON.parse(created.stdout).result.isError).toBeUndefined();
    const bridge = await cli(['local-mcp'], [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'read_board', arguments: { board: board.slug } } },
    ].map(v => JSON.stringify(v)).join('\n'));
    expect(bridge.code).toBe(0);
    const frames = bridge.stdout.trim().split('\n').map(line => JSON.parse(line));
    expect(frames[1].result.tools.some((t: { name: string }) => t.name === 'attach_conversation')).toBe(true);
    expect(JSON.parse(frames[2].result.content[0].text).nodes).toHaveLength(2);
    const node = page.locator('[data-id="1"]');
    await expect(node).toBeVisible();
    const edgeHit = page.locator('.edge-hit[data-edge-id="3"]');
    await edgeHit.focus(); await edgeHit.press('Enter');
    for (const direction of ['both', 'none', 'forward']) {
      await page.locator('#edit select[name="direction"]').selectOption(direction);
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(page.locator('#status')).toHaveText('Saved');
      const line = page.locator('.edge-line').first();
      if (direction === 'both') await expect(line).toHaveAttribute('marker-start', /url/);
      else await expect(line).not.toHaveAttribute('marker-start');
      if (direction === 'none') await expect(line).not.toHaveAttribute('marker-end');
      else await expect(line).toHaveAttribute('marker-end', /url/);
    }
    const second = await context.newPage(); await second.goto(`${endpoint.origin}/#b=${board.slug}`);
    await expect(second.locator('[data-id="1"]')).toBeVisible();
    const box = (await node.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2 + 40, { steps: 5 }); await page.mouse.up();
    await expect.poll(async () => (await call({ action: 'read_board', board: board.slug })).nodes[0].x).not.toBe(120);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect.poll(async () => (await call({ action: 'read_board', board: board.slug })).nodes[0].x).toBe(120);
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await expect.poll(async () => (await call({ action: 'read_board', board: board.slug })).nodes[0].x).not.toBe(120);
    await page.getByRole('textbox', { name: 'Repository path' }).fill('shared/local.ts');
    await page.getByRole('button', { name: 'Attach reference', exact: true }).click();
    await page.getByRole('button', { name: 'shared/local.ts:1–1', exact: true }).click();
    await expect(page.locator('[data-code]')).toContainText('Local wire/storage contract');
    await page.getByRole('button', { name: 'Review', exact: true }).click();
    await second.getByRole('button', { name: 'Review', exact: true }).click();
    await page.locator('#note textarea').fill('Please check the timeout.');
    await page.getByRole('button', { name: 'Add note', exact: true }).click();
    await expect(second.locator('#notes')).toContainText('Please check the timeout.');
    const saved = await call({ action: 'read_board', board: board.slug });
    await call({ action: 'apply_board', board: board.slug, revision: saved.revision, operations: [{ type: 'node.put', id: '1', patch: { label: 'Gateway' } }, { type: 'note.reply', id: saved.notes[0].id, text: 'Timeout documented.' }] });
    await expect(node).toContainText('Gateway');
    await expect(page.locator('#notes')).toContainText('Timeout documented.');
    const label = page.locator('#edit input[name="label"]');
    await label.fill('Unsaved draft');
    await page.locator('#note textarea').focus();
    const concurrent = await call({ action: 'read_board', board: board.slug });
    await call({ action: 'apply_board', board: board.slug, revision: concurrent.revision, operations: [{ type: 'node.put', id: '1', patch: { label: 'Agent changed' } }] });
    await expect(node).toContainText('Agent changed');
    await expect(label).toHaveValue('Unsaved draft');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('#status')).toContainText('board changed');
    await expect(label).toHaveValue('Unsaved draft');
    expect((await call({ action: 'read_board', board: board.slug })).nodes[0].label).toBe('Agent changed');
    await page.getByRole('button', { name: 'Reload fields', exact: true }).click();
    await expect(label).toHaveValue('Agent changed');
    await label.fill('Gateway');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(node).toContainText('Gateway');
    await context.setOffline(true);
    const disconnected = await call({ action: 'read_board', board: board.slug });
    await call({ action: 'apply_board', board: board.slug, revision: disconnected.revision, operations: [{ type: 'node.put', id: '1', patch: { description: 'Updated while browsers were offline' } }] });
    await context.setOffline(false);
    await expect(page.locator('#edit textarea[name="description"]')).toHaveValue('Updated while browsers were offline');
    await page.getByRole('button', { name: 'Resolve', exact: true }).click();
    await expect(second.locator('#notes')).toContainText('Resolved');
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(node).toHaveCount(0);
    await expect(page.locator('#notes')).toContainText('Detached');
    const deleted = await call({ action: 'read_board', board: board.slug });
    expect(deleted.edges).toHaveLength(0);
    expect(deleted.notes[0].target).toBe('1');
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(node).toBeVisible();
    await expect(page.locator('#notes')).not.toContainText('Detached');
    const restoredGraph = await call({ action: 'read_board', board: board.slug });
    const removedEdge = await cli(['local-mcp'], JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'apply_board', arguments: { board: board.slug, revision: restoredGraph.revision, operations: [{ type: 'element.delete', id: '3' }] } } }));
    expect(JSON.parse(removedEdge.stdout).result.isError).toBeUndefined();
    await expect(page.locator('.edge-hit')).toHaveCount(0);
    await node.click(); await page.locator('[data-id="2"]').click({ modifiers: ['Shift'] });
    await page.getByRole('button', { name: 'Connect selected', exact: true }).click();
    await expect(page.locator('.edge-hit')).toHaveCount(1);
    expect((await call({ action: 'read_board', board: board.slug })).edges).toHaveLength(1);
    await page.getByRole('button', { name: 'Close review', exact: true }).click();
    await page.locator('[data-kind=service]').click();
    await page.locator('#canvas').click({ position: { x: 600, y: 500 } });
    await expect(page.locator('.node[data-id]')).toHaveCount(3);
    const extra = await call({ action: 'read_board', board: board.slug });
    const addedNode = extra.nodes.find((n: { label: string }) => n.label === 'Service');
    const removedNode = await cli(['local-mcp'], JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'apply_board', arguments: { board: board.slug, revision: extra.revision, operations: [{ type: 'element.delete', id: addedNode.id }] } } }));
    expect(JSON.parse(removedNode.stdout).result.isError).toBeUndefined();
    await expect(page.locator('.node[data-id]')).toHaveCount(2);
    // Every retained drawing tool places its actual kind; panning never moves a node.
    for (const kind of ['datastore', 'external', 'boundary', 'note', 'text']) {
      await page.locator(`[data-kind=${kind}]`).click();
      await page.locator('#canvas').click({ position: { x: 700, y: 450 } });
      await expect(page.locator('.node[data-id]')).toHaveCount(3);
      const added = await call({ action: 'read_board', board: board.slug });
      const item = added.nodes.find((n: { kind: string }) => n.kind === kind);
      expect(item).toBeTruthy();
      await call({ action: 'apply_board', board: board.slug, revision: added.revision, operations: [{ type: 'element.delete', id: item.id }] });
      await expect(page.locator('.node[data-id]')).toHaveCount(2);
    }
    const beforePan = await call({ action: 'read_board', board: board.slug });
    const transform = await page.locator('#world').getAttribute('transform');
    await page.getByRole('button', { name: 'Hand', exact: true }).click();
    const panBox = (await node.boundingBox())!;
    await page.mouse.move(panBox.x + panBox.width / 2, panBox.y + panBox.height / 2);
    await page.mouse.down(); await page.mouse.move(panBox.x + panBox.width / 2 + 50, panBox.y + panBox.height / 2 + 30); await page.mouse.up();
    await expect(page.locator('#world')).not.toHaveAttribute('transform', transform!);
    expect((await call({ action: 'read_board', board: board.slug })).nodes).toEqual(beforePan.nodes);
    await page.getByRole('button', { name: 'Select', exact: true }).click();
    await page.getByRole('button', { name: 'Fit', exact: true }).click();
    const zoom = await page.locator('#hud-zoom').textContent();
    await page.getByRole('button', { name: 'Zoom out', exact: true }).click();
    await expect(page.locator('#hud-zoom')).not.toHaveText(zoom!);
    await page.getByRole('button', { name: 'Fit', exact: true }).click();
    writeFileSync(join(directory, 'mapping.json'), JSON.stringify({ api: '1', database: '2' }));
    const pipe = await cli(['live', '--board', board.slug, '--map', join(directory, 'mapping.json')], '{"from":"api","to":"database","duration_ms":12}\nmalformed\n{"from":"database","to":"api","error":true}');
    expect(pipe.code).toBe(1); expect(pipe.stderr).toContain('Accepted 2; rejected 1');
    await page.getByText('Live traffic', { exact: true }).click();
    await expect(page.locator('[data-summary]')).toContainText('Gateway → Database: 1 calls');
    await expect(page.locator('[data-summary]')).toContainText('Database → Gateway: 1 calls · 1 errors · latency unknown');
    await expect(page.locator('.edge.live')).toHaveCount(1);
    await expect(page.locator('.local-reverse')).toHaveCount(1);
    await page.screenshot({ path: join(root, '.context/local-board.png') });
    for (const width of [768, 390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await page.getByRole('button', { name: 'Conversation', exact: true }).click();
      await expect(page.locator('[data-send] textarea')).toBeVisible();
      await page.locator('[data-send] textarea').fill('Keep this draft');
      await page.getByRole('button', { name: 'Close conversation', exact: true }).click();
      await page.getByRole('button', { name: 'Conversation', exact: true }).click();
      await expect(page.locator('[data-send] textarea')).toHaveValue('Keep this draft');
      const panel = (await page.locator('#local-conversation').boundingBox())!;
      expect(panel.x).toBeGreaterThanOrEqual(0); expect(panel.x + panel.width).toBeLessThanOrEqual(width);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      await page.getByRole('button', { name: 'Close conversation', exact: true }).click();
    }
    expect(errors).toEqual([]); expect(external).toEqual([]);
    await stop(); await start();
    const restored = await call({ action: 'read_board', board: board.slug });
    expect(restored.nodes[0].x).toBe(saved.nodes[0].x);
    expect(restored.notes[0].replies[0].text).toBe('Timeout documented.');
    expect(restored.notes[0].resolved).toBe(true);
    expect(restored.nodes[0].refs).toHaveLength(1);
    expect(restored.nodes[0].description).toBe('Updated while browsers were offline');
  } finally { await context.close(); if (child! && child.exitCode === null) await stop(); rmSync(directory, { recursive: true, force: true }); }
});
