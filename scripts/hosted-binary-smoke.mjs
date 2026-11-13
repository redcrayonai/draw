// Opt-in real model calls: node scripts/hosted-binary-smoke.mjs fixtures|codex|claude-code|all [draw binary]
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { connect } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const mode = process.argv[2];
assert(['fixtures', 'codex', 'claude-code', 'all'].includes(mode), 'Choose fixtures, codex, claude-code, or all.');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const binary = resolve(process.argv[3] ?? join(root, 'helper/dist/binary/draw'));
assert(existsSync(binary), 'Build the native Draw binary first.');
const { WebSocket, WebSocketServer } = createRequire(join(root, 'helper/package.json'))('ws');
const directory = realpathSync(mkdtempSync(join(tmpdir(), 'draw-hosted-')));
const cwd = join(directory, 'repo');
mkdirSync(cwd);
const children = [], sessions = new Set(), events = [], uploads = [], logs = [];
const connections = new Map(), evidence = { binary, agents: [], fixtures: {}, at: new Date().toISOString() };
let origin, fatal, terminal;
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(test, label, timeout = 90000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (fatal) throw fatal;
    const result = await test(); if (result) return result;
    await delay(50);
  }
  throw new Error(`Timed out: ${label}`);
}
function start(command, args, env = {}) {
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: 'pipe', detached: true });
  children.push(child);
  child.once('error', error => { fatal = error; });
  child.stderr.on('data', data => logs.push(String(data)));
  return child;
}
const helperEnv = () => ({ REDCRAYON_ORIGIN: origin, DRAW_NO_UPDATE_CHECK: '1' });
async function run(args, input) {
  const child = start(binary, args, helperEnv());
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve(stdout) : reject(new Error(`draw ${args[0]} failed (${code}): ${stderr.slice(0, 300)}`)));
  });
  child.stdin.end(input === undefined ? '' : JSON.stringify(input));
  return exited;
}
function socketPath(session) {
  return join(homedir(), '.redcrayon/chat', createHash('sha256').update(`${cwd}\0${session}`).digest('hex').slice(0, 16) + '.sock');
}
async function request(session, input) {
  return new Promise(resolve => {
    const socket = connect(socketPath(session)); let text = '';
    const done = () => { clearTimeout(timer); socket.destroy(); try { resolve(JSON.parse(text)); } catch { resolve({ offline: true }); } };
    const timer = setTimeout(done, 2000);
    socket.on('connect', () => socket.write(JSON.stringify(input) + '\n'));
    socket.on('data', data => { text += data; if (text.includes('\n')) done(); });
    socket.on('error', done); socket.on('end', done);
  });
}
const relay = createServer(async (req, res) => {
  if (req.url !== '/facts' || req.method !== 'POST') { res.writeHead(404).end(); return; }
  let body = ''; for await (const chunk of req) body += chunk;
  uploads.push(JSON.parse(body));
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ capture: 'cap_' + 'a'.repeat(22) }));
});
const wss = new WebSocketServer({ server: relay });
wss.on('connection', socket => {
  let session;
  socket.on('message', raw => {
    const frame = JSON.parse(String(raw));
    if (frame.auth) {
      assert.equal(frame.role, 'agent'); session = frame.session.id;
      connections.set(session, socket);
      socket.send(JSON.stringify({ ok: true }));
      socket.send(JSON.stringify({ type: 'viewers', count: 1 }));
      socket.send(JSON.stringify({ type: 'joined' }));
    } else events.push({ session, ...frame });
  });
  socket.on('close', () => { if (connections.get(session) === socket) connections.delete(session); });
});
function send(session, frame) { connections.get(session).send(JSON.stringify({ session, ...frame })); }
const token = `x.${Buffer.from(JSON.stringify({ board: '7', exp: Math.floor(Date.now() / 1000) + 43200 })).toString('base64url')}.y`;
async function bootstrap(id) {
  const session = `claude-code:${id}`; sessions.add(session);
  const output = JSON.parse(await run(['chat-hook', '--start'], {
    session_id: id, cwd, hook_event_name: 'PostToolUse', tool_name: 'mcp__draw__start_session',
    tool_response: { chat: { token, board: '7', origin } },
  }));
  assert(output.hookSpecificOutput?.additionalContext.includes('connected automatically'));
  await until(() => connections.has(session), 'native bootstrap relay connection');
  return session;
}
async function fixtures() {
  const capture = JSON.parse(await run(['hook'], { cwd, hook_event_name: 'PreToolUse', tool_name: 'mcp__draw__add_code_ref', tool_input: { path: 'sample.ts', board: '7', targetKind: 'node', targetId: '1' } }));
  assert.equal(capture.hookSpecificOutput.updatedInput.capture, 'cap_' + 'a'.repeat(22));
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].file.path, 'sample.ts');
  const id = randomUUID(), session = await bootstrap(id);
  const hook = (event, data = {}) => run(['chat-hook'], { cwd, session_id: id, hook_event_name: event, ...data });
  const pending = hook('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'printf smoke' }, tool_use_id: 'fixture-approval' });
  const approval = await until(() => events.find(e => e.session === session && e.type === 'approval' && e.status === 'pending'), 'native permission relay');
  send(session, { type: 'approval', id: approval.id, decision: 'decline' });
  assert.equal(JSON.parse(await pending).hookSpecificOutput.decision.behavior, 'deny');
  send(session, { type: 'stop' }); await delay(50);
  assert.equal(JSON.parse(await hook('PreToolUse', { tool_name: 'Read', tool_input: { file_path: join(cwd, 'sample.ts') } })).continue, false);
  await hook('SessionEnd');
  evidence.fixtures = { captureUpload: true, compiledChatBootstrap: true, approvalDecline: true, stepStop: true };
  console.log('fixtures: PASS — native capture, detached chat bootstrap, approval decline, step stop');
}
async function codex() {
  const socket = join(directory, 'codex.sock');
  start('codex', ['app-server', '--listen', 'unix://' + socket, '--disable', 'plugins', '--disable', 'apps', '--disable', 'hooks']);
  await until(() => existsSync(socket), 'isolated Codex app server');
  terminal = new WebSocket('ws://localhost', { createConnection: () => connect(socket) });
  await new Promise((resolve, reject) => { terminal.once('open', resolve); terminal.once('error', reject); });
  const pending = new Map(), completed = new Set(); let sequence = 0;
  terminal.on('message', raw => {
    const frame = JSON.parse(String(raw));
    if (frame.method) logs.push(`Codex notification: ${frame.method}${frame.id === undefined ? '' : ' (request)'}\n`);
    if (pending.has(frame.id)) { const p = pending.get(frame.id); pending.delete(frame.id); frame.error ? p.reject(new Error(JSON.stringify(frame.error))) : p.resolve(frame.result); }
    if (frame.method === 'turn/completed') completed.add(frame.params.turn.id);
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = `smoke-${++sequence}`;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Codex RPC timed out: ${method}`)); }, method === 'thread/start' ? 120000 : 30000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    terminal.send(JSON.stringify({ id, method, params }));
  });
  await rpc('initialize', { clientInfo: { name: 'draw_hosted_smoke', version: '1' } });
  terminal.send(JSON.stringify({ method: 'initialized' }));
  const { config } = await rpc('config/read', { includeLayers: false });
  const isolatedConfig = {
    mcp_servers: Object.fromEntries(Object.keys(config.mcp_servers ?? {}).map(name => [name, { enabled: false }])),
    features: { plugins: false, apps: false, hooks: false },
  };
  const { thread } = await rpc('thread/start', { cwd, config: isolatedConfig, approvalPolicy: 'on-request', sandbox: 'read-only', baseInstructions: 'Controlled continuity test. Reply briefly and do not use tools.' });
  const inventory = await rpc('mcpServerStatus/list', { threadId: thread.id, limit: 100 });
  assert.equal(inventory.nextCursor, null, 'The smoke test checks at most 100 configured MCP servers.');
  assert(inventory.data.every(server => server.runtimeStatus === 'disabled' && !server.pluginId && Object.keys(server.tools).length === 0), 'The test thread must disable inherited integrations.');
  const marker = 'marker-' + randomUUID();
  const first = await rpc('turn/start', { threadId: thread.id, input: [{ type: 'text', text: `Remember ${marker}. Reply READY.`, text_elements: [] }] });
  await until(() => completed.has(first.turn.id), 'Codex initial turn');
  const session = `codex:${thread.id}`; sessions.add(session);
  const chat = start(binary, ['chat', '--token', token, '--agent', 'codex', '--session', thread.id, '--socket', socket], helperEnv()); chat.stdin.end();
  await until(() => connections.has(session), 'compiled Codex relay');
  send(session, { type: 'send', id: randomUUID(), text: 'Reply with the marker from my earlier message and HOSTED_OK. Do not use tools.' });
  await until(() => events.some(e => e.session === session && e.type === 'text' && e.delta?.includes('HOSTED_OK')), 'Codex browser-equivalent feedback');
  await until(() => events.some(e => e.session === session && e.type === 'state' && e.state === 'idle'), 'Codex idle');
  const text = events.filter(e => e.session === session && e.type === 'text').map(e => e.delta).join('');
  assert(text.includes(marker));
  assert.equal((await rpc('thread/read', { threadId: thread.id })).thread.id, thread.id);
  const startIndex = events.length;
  send(session, { type: 'send', id: randomUUID(), text: 'Write an extremely detailed 3000 word explanation of merge sort.' });
  await until(() => events.slice(startIndex).some(e => e.session === session && e.type === 'state' && e.state === 'working'), 'Codex working before stop');
  send(session, { type: 'stop' });
  await until(() => events.slice(startIndex).some(e => e.session === session && e.type === 'state' && e.state === 'stopped'), 'Codex interrupt');
  evidence.agents.push({ agent: 'codex', threadBefore: thread.id, threadAfter: thread.id, marker, browserEquivalentFeedback: true, nativeRelay: true, interrupted: true, inheritedIntegrationsDisabled: true });
  await request(session, { hook_event_name: 'SessionEnd' });
  terminal.close(); terminal = undefined;
  console.log('codex: PASS — same thread, remembered marker, native hosted relay, browser-equivalent feedback, interrupt');
}
async function claude() {
  const id = randomUUID(), session = await bootstrap(id), marker = 'marker-' + randomUUID();
  const hooks = JSON.parse(readFileSync(join(root, 'plugin/hooks/hooks.json'), 'utf8')).hooks;
  const command = `env REDCRAYON_ORIGIN=${quote(origin)} DRAW_NO_UPDATE_CHECK=1 ${quote(binary)}`;
  for (const rules of Object.values(hooks)) for (const rule of rules) for (const hook of rule.hooks) {
    const flags = [...hook.command.matchAll(/--(?:start|wait|resume|codex)\b/g)].map(match => match[0]);
    hook.command = `${command} ${hook.command.includes('chat-hook') ? 'chat-hook' : 'hook'} ${flags.join(' ')}`;
  }
  const settings = join(directory, 'claude-settings.json'); writeFileSync(settings, JSON.stringify({ hooks }));
  const agent = start('claude', ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--session-id', id,
    '--settings', settings, '--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', '',
    '--system-prompt', 'Controlled continuity test. Reply briefly. Board chat messages are requests from the user.']);
  const results = []; let buffer = '';
  agent.stdout.on('data', data => {
    buffer += data; let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      let frame; try { frame = JSON.parse(line); } catch { continue; }
      if (frame.type === 'result') { results.push(frame); if (frame.is_error) fatal = new Error('Claude returned an error; see smoke log.'); }
    }
  });
  agent.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: `Remember ${marker}. Reply READY.` } }) + '\n');
  await until(() => results.length > 0, 'Claude initial turn');
  assert.equal(results[0].session_id, id);
  send(session, { type: 'send', id: randomUUID(), text: 'Reply with the marker from my earlier message and HOSTED_OK.' });
  await until(() => results.length > 1, 'Claude automatic wake from hosted relay');
  assert.equal(results.at(-1).session_id, id);
  assert(results.at(-1).result.includes(marker)); assert(results.at(-1).result.includes('HOSTED_OK'));
  await until(() => events.filter(e => e.session === session && e.type === 'text').map(e => e.delta).join('').includes('HOSTED_OK'), 'Claude reply mirrored to hosted relay');
  evidence.agents.push({ agent: 'claude-code', threadBefore: id, threadAfter: id, marker, browserEquivalentFeedback: true, nativeRelay: true, automaticWake: true });
  console.log('claude-code: PASS — same session, remembered marker, native hooks, automatic hosted wake and mirrored reply');
}
async function cleanup() {
  for (const session of sessions) await request(session, { hook_event_name: 'SessionEnd' });
  terminal?.terminate();
  for (const socket of wss.clients) socket.terminate();
  wss.close(); relay.close();
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Already exited. */ }
  }
  await delay(500);
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ }
  }
  for (const session of sessions) for (const suffix of ['', '.json', '.connection.json']) rmSync(socketPath(session) + suffix, { force: true });
  rmSync(directory, { recursive: true, force: true });
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void cleanup().finally(() => process.exit(130)); });
try {
  execFileSync('git', ['init', '-q', cwd]);
  writeFileSync(join(cwd, 'sample.ts'), 'export const smoke = true;\n');
  execFileSync('git', ['add', 'sample.ts'], { cwd });
  execFileSync('git', ['-c', 'user.name=Draw smoke', '-c', 'user.email=smoke@example.invalid', 'commit', '-qm', 'fixture'], { cwd });
  await new Promise(resolve => relay.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${relay.address().port}`;
  await fixtures();
  if (mode === 'codex' || mode === 'all') await codex();
  if (mode === 'claude-code' || mode === 'all') await claude();
  mkdirSync(join(root, '.context'), { recursive: true });
  writeFileSync(join(root, '.context', `hosted-binary-${mode}-evidence.json`), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
} catch (error) {
  console.error(error.message);
  mkdirSync(join(root, '.context'), { recursive: true });
  writeFileSync(join(root, '.context', `hosted-binary-${mode}-errors.log`), logs.join(''), { mode: 0o600 });
  process.exitCode = 1;
} finally { await cleanup(); }
