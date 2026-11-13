// Opt-in: uses your installed, authenticated agent and makes real model calls.
// node scripts/local-agent-smoke.mjs codex|claude-code|pi
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { connect } from 'node:net';
import { randomUUID } from 'node:crypto';

const kind = process.argv[2];
assert(['codex', 'claude-code', 'pi'].includes(kind), 'Usage: node scripts/local-agent-smoke.mjs codex|claude-code|pi');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { chromium, expect } = createRequire(join(root, 'e2e/package.json'))('@playwright/test');
const WebSocket = createRequire(join(root, 'helper/package.json'))('ws');
const cli = join(root, 'helper/dist/redcrayon.mjs'), artifacts = join(root, '.context');
const directory = mkdtempSync(join(tmpdir(), `draw-${kind}-`)), store = join(directory, 'store');
const children = [], agentErrors = [], approvals = [];
let browser, ws, endpoint, board, fatal;
const deadline = Date.now() + 180000;
function start(command, args, env = {}) {
  const child = spawn(command, args, { cwd: root, env: { ...process.env, ...env }, stdio: 'pipe', detached: true });
  children.push(child);
  child.once('error', error => { fatal = error; });
  child.stderr.on('data', data => { agentErrors.push(String(data)); if (agentErrors.length > 20) agentErrors.shift(); });
  return child;
}
async function until(test) {
  while (Date.now() < deadline) {
    if (fatal) throw fatal;
    const value = await test(); if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Agent smoke timed out; check the test conversation in your terminal.');
}
async function call(input) {
  const response = await fetch(endpoint.origin + '/api/call', { method: 'POST', headers: { authorization: 'Bearer ' + endpoint.token }, body: JSON.stringify(input), signal: AbortSignal.timeout(30000) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error);
  return value;
}
async function cleanup() {
  ws?.terminate(); await browser?.close(); browser = undefined;
  await Promise.all(children.splice(0).map(async child => {
    const exited = new Promise(resolve => child.once('exit', resolve));
    try { process.kill(-child.pid, 'SIGTERM'); } catch { return; }
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 2000))]);
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ }
  }));
  rmSync(directory, { recursive: true, force: true });
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void cleanup().finally(() => process.exit(130)); });

async function codexSession(marker) {
  const socket = join(directory, 'agent.sock');
  start('codex', ['app-server', '--listen', 'unix://' + socket,
    '-c', 'mcp_servers.draw-local.command=' + JSON.stringify(process.execPath),
    '-c', 'mcp_servers.draw-local.args=' + JSON.stringify([cli, 'local-mcp', '--repo', root, '--store', store])]);
  await until(() => existsSync(socket));
  ws = new WebSocket('ws://localhost', { createConnection: () => connect(socket) });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  let sequence = 0;
  const pending = new Map(), completed = new Set();
  ws.on('message', raw => {
    const frame = JSON.parse(String(raw));
    if (pending.has(frame.id)) {
      const { resolve, reject } = pending.get(frame.id); pending.delete(frame.id);
      frame.error ? reject(new Error(JSON.stringify(frame.error))) : resolve(frame.result);
    }
    if (frame.method === 'turn/completed') completed.add(frame.params.turn.id);
    if (frame.id !== undefined && frame.method) {
      const p = frame.params, tool = /tool "(read_board|apply_board)"/.exec(p.message ?? '')?.[1];
      // This test terminal approves only its board tools, once per request. No permission changes.
      const allowed = frame.method === 'mcpServer/elicitation/request' && p.serverName === 'draw-local' && p.mode === 'form'
        && p._meta?.codex_approval_kind === 'mcp_tool_call' && p._meta?.tool_params?.board === board.slug && !!tool;
      approvals.push({ tool, allowed });
      if (frame.method === 'mcpServer/elicitation/request') ws.send(JSON.stringify({ id: frame.id, result: { action: allowed ? 'accept' : 'decline', content: {} } }));
      else fatal = new Error(`Unexpected terminal request: ${frame.method}`);
    }
  });
  async function rpc(method, params) {
    const id = `smoke-${++sequence}`;
    const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    ws.send(JSON.stringify({ id, method, params }));
    return Promise.race([result, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error(`Timed out: ${method}`)), 30000); timer.unref(); })]);
  }
  await rpc('initialize', { clientInfo: { name: 'draw_smoke', version: '1' } });
  ws.send(JSON.stringify({ method: 'initialized' }));
  const { thread } = await rpc('thread/start', { cwd: root, approvalPolicy: 'on-request', sandbox: 'read-only', baseInstructions: 'Controlled continuity test. Reply briefly. Use only local board tools when asked.' });
  const first = await rpc('turn/start', { threadId: thread.id, input: [{ type: 'text', text: `Remember marker ${marker}. Reply READY.`, text_elements: [] }] });
  await until(() => completed.has(first.turn.id));
  await call({ action: 'attach_conversation', board: board.slug, threadId: thread.id, socketPath: socket });
  return { id: thread.id, readId: async () => (await rpc('thread/read', { threadId: thread.id })).thread.id };
}

async function hookSession(marker) {
  let agent, id;
  if (kind === 'pi') {
    agent = start('pi', ['--mode', 'rpc', '--no-extensions', '-e', 'builtin:mcp', '-e', join(root, 'helper/dist/local-pi-extension.mjs'), '--no-context-files', '--no-skills', '--no-builtin-tools', '--tools', 'mcp__draw_local__read_board,mcp__draw_local__apply_board', '--session-dir', join(directory, 'sessions')], { DRAW_LOCAL_BOARD: board.slug, DRAW_LOCAL_STORE: store });
  } else {
    id = randomUUID();
    const settings = join(directory, 'settings.json');
    writeFileSync(settings, execFileSync(process.execPath, [cli, 'local-claude-settings', '--board', board.slug, '--repo', root, '--store', store]));
    agent = start('claude', ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--session-id', id, '--settings', settings, '--setting-sources', '', '--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: { 'draw-local': { command: process.execPath, args: [cli, 'local-mcp', '--repo', root, '--store', store] } } }), '--tools', '', '--allowedTools', 'mcp__draw-local__read_board', 'mcp__draw-local__apply_board', '--permission-prompts', 'none', '--system-prompt', 'Controlled continuity test. Reply briefly. Use only local board tools when asked.']);
  }
  let buffer = '', settled = 0;
  const responses = new Map(), resultSessions = [];
  agent.stdout.on('data', data => {
    buffer += data;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      let frame; try { frame = JSON.parse(line); } catch { continue; }
      if (frame.type === 'response') responses.set(frame.id, frame);
      if (frame.type === 'agent_settled') settled++;
      if (frame.type === 'result') { resultSessions.push(frame.session_id); if (frame.is_error) fatal = new Error(frame.result ?? 'Claude turn failed'); }
      if (frame.type === 'extension_error') fatal = new Error(frame.error);
    }
  });
  const send = value => agent.stdin.write(JSON.stringify(value) + '\n');
  async function state(requestId) {
    send({ id: requestId, type: 'get_state' });
    const response = await until(() => responses.get(requestId));
    assert.equal(response.success, true); return response.data.sessionId;
  }
  if (kind === 'pi') {
    id = await state('before'); send({ id: 'initial', type: 'prompt', message: `Remember marker ${marker}. Reply READY.` });
    await until(() => settled > 0);
  } else {
    send({ type: 'user', message: { role: 'user', content: `Remember marker ${marker}. Reply READY.` } });
    await until(() => resultSessions.length > 0); assert.equal(resultSessions[0], id);
  }
  return { id, readId: async () => kind === 'pi' ? state('after') : (await until(() => resultSessions.length >= 2 && resultSessions.at(-1))) };
}

try {
  mkdirSync(artifacts, { recursive: true });
  start(process.execPath, [cli, 'local', '--repo', root, '--store', store]);
  await until(() => existsSync(join(store, 'endpoint.json')));
  endpoint = JSON.parse(readFileSync(join(store, 'endpoint.json'), 'utf8'));
  board = await call({ action: 'open_board', name: `${kind} same-session handoff` });
  await call({ action: 'apply_board', board: board.slug, revision: 0, operations: [
    { type: 'node.put', patch: { label: 'Smoke API', x: 123, y: 234 } },
    { type: 'note.add', target: '1', text: 'Confirm the conversation marker and update this node.' },
  ] });
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 960 } });
  const pageErrors = [], external = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('request', request => { if (!request.url().startsWith(endpoint.origin)) external.push(request.url()); });
  await page.goto(`${endpoint.origin}/#local&key=${endpoint.token}`);
  await expect(page.locator('[data-id="1"]')).toContainText('Smoke API');
  await page.locator('[data-id="1"]').click();
  const marker = 'draw-' + randomUUID();
  const session = await (kind === 'codex' ? codexSession(marker) : hookSession(marker));
  await until(async () => { const status = await call({ action: 'chat_status', board: board.slug }); return status.connected && status.state === 'idle'; });
  await expect(page.locator('[data-stop]')).toHaveText(kind === 'claude-code' ? 'Stop after current step' : 'Stop agent');
  // Submit through the browser, then assert that the live canvas and durable store both change.
  await page.getByRole('button', { name: 'Conversation', exact: true }).click();
  await page.locator('[data-send] textarea').fill('Use draw-local read_board and apply_board to rename selected node 1 to HANDOFF_OK, preserving its position. Reply to note 2 with the marker from our earlier message and resolve that note. Then reply with that marker followed by HANDOFF_OK. Read the latest revision before writing. Use only local board tools.');
  await page.getByRole('button', { name: 'Send feedback', exact: true }).click();
  const updated = await until(async () => {
    const value = await call({ action: 'read_board', board: board.slug });
    return value.feedback[0]?.state === 'answered' && value.nodes[0].label === 'HANDOFF_OK' && value.notes[0].resolved && value;
  });
  assert.equal(await session.readId(), session.id);
  assert(updated.feedback[0].reply.includes(marker));
  assert(updated.feedback[0].reply.includes('HANDOFF_OK'));
  assert.equal(updated.nodes[0].x, 123); assert.equal(updated.nodes[0].y, 234);
  assert.equal(updated.notes[0].id, '2'); assert.equal(updated.notes[0].target, '1');
  assert(updated.notes[0].replies.some(reply => reply.text.includes(marker)));
  await expect(page.locator('[data-id="1"]')).toContainText('HANDOFF_OK');
  await expect(page.locator('#notes')).toContainText(marker);
  await expect(page.locator('#notes')).toContainText('Resolved');
  await expect(page.locator('[data-messages]')).toContainText('answered');
  assert.deepEqual(pageErrors, []); assert.deepEqual(external, []);
  await page.screenshot({ path: join(artifacts, `${kind}-handoff.png`), fullPage: true });
  const evidence = { agent: kind, version: execFileSync(kind === 'claude-code' ? 'claude' : kind, ['--version'], { encoding: 'utf8' }).trim(), threadBefore: session.id, threadAfter: session.id, board: board.slug, node: updated.nodes[0], note: updated.notes[0], reply: updated.feedback[0].reply, state: updated.feedback[0].state, approvals, browserLiveUpdate: true, at: new Date().toISOString() };
  writeFileSync(join(artifacts, `${kind}-handoff-evidence.json`), JSON.stringify(evidence, null, 2) + '\n');
  console.log(`${kind}: PASS — same session, browser feedback, live diagram edit, anchored review reply/resolution; evidence in .context/${kind}-handoff-evidence.json`);
} catch (error) {
  console.error(error.message);
  // Logs may contain private provider metadata; retain them locally without printing them.
  writeFileSync(join(artifacts, `${kind}-smoke-errors.log`), agentErrors.join(''), { mode: 0o600 });
  process.exitCode = 1;
} finally { await cleanup(); }
