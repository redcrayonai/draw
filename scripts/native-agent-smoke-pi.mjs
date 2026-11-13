// Opt-in: real installed pi + native Draw, against a private loopback hosted-protocol fixture.
// node scripts/native-agent-smoke-pi.mjs [native-draw-path] [pi-extension-path]
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { WebSocketServer } = createRequire(join(root, 'helper/package.json'))('ws');
const executable = resolve(process.argv[2] || join(root, 'helper/dist/binary/draw'));
const extension = resolve(process.argv[3] || join(root, 'helper/dist/pi-extension.mjs'));
const directory = mkdtempSync(join(tmpdir(), 'draw-hosted-pi-'));
const repo = join(directory, 'repo');
execFileSync('git', ['clone', '--shared', '--quiet', root, repo]);
const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
const captures = [], calls = [], events = [], errors = [], responses = new Map();
const capture = 'cap_' + 'a'.repeat(22), marker = 'continuity-' + randomUUID();
let origin, agent, socket, settled = 0, fatal, label = 'before', before;
const deadline = Date.now() + 180000;
const tools = [
  { name: 'start_session', description: 'Open the test board and connect board chat.', inputSchema: { type: 'object', properties: { name: { type: 'string' }, capture: { type: 'string' } }, required: ['name'] } },
  { name: 'read_board', description: 'Read the test board.', inputSchema: { type: 'object', properties: { board: { type: 'string' } }, required: ['board'] } },
  { name: 'apply_board', description: 'Change the label of the test board node.', inputSchema: { type: 'object', properties: { board: { type: 'string' }, label: { type: 'string' } }, required: ['board', 'label'] } },
];
const server = createServer(async (req, res) => {
  if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
  let raw = ''; for await (const chunk of req) raw += chunk;
  const input = JSON.parse(raw);
  res.setHeader('content-type', 'application/json');
  if (req.url === '/facts') { captures.push(input); res.end(JSON.stringify({ capture })); return; }
  if (input.id === undefined) { res.writeHead(202); res.end(); return; }
  let result = {};
  if (input.method === 'initialize') result = { protocolVersion: input.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'draw-hosted-fixture', version: '1' } };
  if (input.method === 'tools/list') result = { tools };
  if (input.method === 'tools/call') {
    calls.push(input.params);
    const { name, arguments: args } = input.params;
    if (name === 'apply_board') label = args.label;
    const value = name === 'start_session' ? { id: '123', baseSha, url: origin + '/board/123', chat: { token: 'fixture.token.signature', board: '123', origin } } : { id: '123', nodes: [{ id: '1', label }] };
    result = { content: [{ type: 'text', text: JSON.stringify(value) }] };
  }
  res.end(JSON.stringify({ jsonrpc: '2.0', id: input.id, result }));
});
const relay = new WebSocketServer({ server });
relay.on('connection', ws => {
  socket = ws;
  ws.on('message', raw => { const frame = JSON.parse(String(raw)); events.push(frame); if (frame.auth) ws.send(JSON.stringify({ ok: true })); });
});
async function until(check) {
  while (Date.now() < deadline) { if (fatal) throw fatal; const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error('Hosted pi smoke timed out; inspect .context/pi-hosted-smoke-errors.log.');
}
function send(value) { agent.stdin.write(JSON.stringify(value) + '\n'); }
async function session(id) { send({ type: 'get_state', id }); return (await until(() => responses.get(id)))?.data?.sessionId; }
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  agent = spawn('pi', ['--mode', 'rpc', '--no-extensions', '-e', 'builtin:mcp', '-e', extension, '--no-context-files', '--no-skills', '--no-builtin-tools', '--tools', 'mcp__draw__start_session,mcp__draw__read_board,mcp__draw__apply_board', '--session-dir', join(directory, 'sessions')], {
    cwd: repo, env: { ...process.env, DRAW_EXECUTABLE: executable, DRAW_LOCAL_BOARD: '', REDCRAYON_MCP_URL: origin + '/mcp', REDCRAYON_ORIGIN: origin }, stdio: 'pipe',
  });
  agent.on('error', error => { fatal = error; });
  agent.on('exit', (code, signal) => { if (code || signal) fatal = new Error(`pi exited: ${code ?? signal}`); });
  agent.stderr.on('data', chunk => errors.push(String(chunk)));
  let buffer = '';
  agent.stdout.on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      let frame; try { frame = JSON.parse(line); } catch { continue; }
      if (frame.type === 'response') responses.set(frame.id, frame);
      if (frame.type === 'agent_settled') settled++;
      if (frame.type === 'extension_error') fatal = new Error(frame.error);
    }
  });
  before = await session('before'); assert(before);
  send({ type: 'prompt', id: 'open', message: `Remember marker ${marker}. Call draw start_session with name "pi continuity test" now, then reply READY. No other tools.` });
  await until(() => settled && events.some(e => e.auth));
  assert.equal(events.find(e => e.auth).session.id, `pi:${before}`);
  assert.equal(calls.find(call => call.name === 'start_session')?.arguments.capture, capture, 'native repository hook patches real pi MCP call');
  assert(captures.length > 0, 'native helper captured this repository');
  socket.send(JSON.stringify({ type: 'send', id: 'feedback', session: `pi:${before}`, text: 'Read board 123 using draw read_board, then change its node label to HANDOFF_OK using draw apply_board. Reply with the marker from our earlier conversation followed by HANDOFF_OK.' }));
  await until(() => label === 'HANDOFF_OK' && events.some(e => e.type === 'text' && e.delta.includes(marker) && e.delta.includes('HANDOFF_OK')) && settled >= 2);
  const after = await session('after'); assert.equal(after, before);
  const evidence = { agent: 'pi', version: execFileSync('pi', ['--version'], { encoding: 'utf8' }).trim(), executable, threadBefore: before, threadAfter: after, hostedProtocolFixture: true, repositoryCaptures: captures.length, nativeCaptureInjected: true, label, boardReply: events.filter(e => e.type === 'text').map(e => e.delta).join('\n'), at: new Date().toISOString() };
  mkdirSync(join(root, '.context'), { recursive: true });
  writeFileSync(join(root, '.context/pi-hosted-handoff-evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log('pi hosted: PASS — same real conversation, native repository capture, hosted board delivery and tool edit.');
} catch (error) {
  console.error(error.message);
  mkdirSync(join(root, '.context'), { recursive: true });
  writeFileSync(join(root, '.context/pi-hosted-smoke-errors.log'), errors.join(''), { mode: 0o600 });
  process.exitCode = 1;
} finally {
  if (agent && agent.exitCode === null) { agent.kill('SIGTERM'); await Promise.race([new Promise(resolve => agent.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 2000))]); if (agent.exitCode === null) agent.kill('SIGKILL'); }
  for (const client of relay.clients) client.terminate();
  await new Promise(resolve => relay.close(resolve));
  await new Promise(resolve => server.close(resolve));
  rmSync(directory, { recursive: true, force: true });
}
