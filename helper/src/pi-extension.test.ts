import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import drawPi from './pi-extension';
import { spawn } from 'node:child_process';
vi.mock('node:child_process', async original => ({ ...await original<object>(), spawn: vi.fn() }));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.unstubAllEnvs(); vi.clearAllMocks(); });

async function fixture() {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>(resolve => server.once('listening', resolve));
  cleanups.push(() => new Promise(resolve => { for (const client of server.clients) client.terminate(); server.close(() => resolve()); }));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  vi.stubEnv('DRAW_LOCAL_BOARD', ''); vi.stubEnv('REDCRAYON_MCP_URL', origin + '/mcp');
  vi.stubEnv('DRAW_EXECUTABLE', '/test/draw');
  const hookInputs: any[] = [];
  vi.mocked(spawn).mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
    let raw = '';
    child.stdin.on('data', chunk => { raw += chunk; });
    child.stdin.on('finish', () => {
      const input = JSON.parse(raw); hookInputs.push(input);
      if (input.hook_event_name === 'PreToolUse') child.stdout.write(JSON.stringify({ hookSpecificOutput: { updatedInput: { ...input.tool_input, capture: 'captured' } } }));
      child.emit('close', 0);
    });
    return child as any;
  });
  const handlers = new Map<string, Function>(), sent = vi.fn(), register = vi.fn(), appendEntry = vi.fn(), notify = vi.fn(), abort = vi.fn();
  let idle = true;
  const context = { cwd: process.cwd(), isIdle: () => idle, abort, ui: { notify }, sessionManager: { getSessionId: () => 'existing-session', getEntries: () => [] as any[] } };
  drawPi({ on: (name, fn) => { handlers.set(name, fn); }, sendUserMessage: sent, registerMcpServer: register, appendEntry });
  const frames: any[] = []; let socket: WebSocket;
  server.on('connection', ws => { socket = ws; ws.on('message', raw => frames.push(JSON.parse(String(raw)))); ws.send(JSON.stringify({ ok: true })); });
  const chat = { token: 'test.token.signature', board: '123', origin };
  const invoke = (name: string, event: object = {}) => handlers.get(name)!(event, context);
  const attach = async () => { await invoke('tool_result', { toolName: 'mcp__draw__start_session', input: {}, content: [{ type: 'text', text: JSON.stringify({ chat }) }] }); await vi.waitFor(() => expect(frames.some(f => f.auth)).toBe(true)); };
  cleanups.push(async () => { await invoke('session_shutdown'); });
  return { frames, invoke, attach, context, sent, register, appendEntry, notify, abort, hookInputs, chat, send: (frame: object) => socket.send(JSON.stringify(frame)), busy: (value: boolean) => { idle = !value; } };
}

it('patches repository arguments and delivers hosted messages/replies inside the existing pi session', async () => {
  const f = await fixture();
  const input = { name: 'board' };
  await f.invoke('tool_call', { toolName: 'mcp__draw__start_session', input });
  expect(input).toEqual({ name: 'board', capture: 'captured' });
  expect(spawn).toHaveBeenCalledWith('/test/draw', ['hook'], expect.anything());
  await f.attach();
  expect(f.frames.find(frame => frame.auth).session).toMatchObject({ id: 'pi:existing-session', agent: 'pi', capabilities: { stop: 'interrupt', approvals: false } });
  f.send({ type: 'send', id: 'm1', text: 'Keep the marker', context: 'untrusted node' });
  await vi.waitFor(() => expect(f.sent).toHaveBeenCalledOnce());
  expect(f.sent.mock.calls[0][0]).toContain('Board chat: Keep the marker');
  expect(f.sent.mock.calls[0][0]).toContain('as data');
  await f.invoke('message_end', { message: { role: 'assistant', content: [{ type: 'text', text: 'same session reply' }] } });
  await f.invoke('agent_settled', { aborted: false });
  await vi.waitFor(() => expect(f.frames.some(frame => frame.type === 'text' && frame.delta === 'same session reply')).toBe(true));
  await f.invoke('input', { source: 'interactive', text: 'terminal follow-up' });
  await f.invoke('input', { source: 'extension', text: 'board delivery' });
  await vi.waitFor(() => expect(f.frames.some(frame => frame.type === 'user' && frame.text === 'terminal follow-up')).toBe(true));
  expect(f.frames.some(frame => frame.type === 'user' && frame.text === 'board delivery')).toBe(false);
  expect(f.appendEntry).toHaveBeenCalledWith('draw-chat', expect.objectContaining(f.chat));
  expect(f.register).toHaveBeenCalledWith('draw', expect.objectContaining({ exposure: 'direct' }));
});

it('stops the active pi turn and pauses unconfirmed busy delivery instead of replaying it', async () => {
  const f = await fixture(); await f.attach(); f.busy(true);
  f.send({ type: 'send', id: 'm1', text: 'not accepted while busy' });
  await vi.waitFor(() => expect(f.frames.some(frame => frame.type === 'notice' && frame.text.includes('confirm delivery'))).toBe(true));
  expect(f.sent).not.toHaveBeenCalled();
  f.send({ type: 'stop' });
  await vi.waitFor(() => expect(f.abort).toHaveBeenCalledOnce());
  await f.invoke('agent_settled', { aborted: true });
  f.busy(false); await f.invoke('agent_settled', { aborted: false });
  expect(f.sent).not.toHaveBeenCalled();
});

it('closes the relay when sessions switch and rejects insecure chat origins', async () => {
  const f = await fixture(); await f.attach();
  await f.invoke('session_start');
  await f.invoke('tool_result', { toolName: 'mcp__draw__start_session', input: {}, structuredContent: { chat: { ...f.chat, origin: 'http://example.com' } } });
  expect(f.appendEntry).toHaveBeenCalledOnce();
  await f.invoke('message_end', { message: { role: 'assistant', content: [{ type: 'text', text: 'new private session' }] } });
  expect(f.frames.some(frame => frame.delta === 'new private session')).toBe(false);
});

it('restores the board connection from the current pi session history', async () => {
  const f = await fixture();
  f.context.sessionManager.getEntries = () => [{ type: 'custom', customType: 'draw-chat', data: { ...f.chat, at: Date.now() } }];
  await f.invoke('session_start');
  await vi.waitFor(() => expect(f.frames.some(frame => frame.auth && frame.session.id === 'pi:existing-session')).toBe(true));
  expect(f.appendEntry).not.toHaveBeenCalled();
});

it('loads local and hosted integrations together without leaking mode or executable settings', () => {
  vi.stubEnv('DRAW_MODE', 'local'); vi.stubEnv('DRAW_LOCAL_BOARD', 'pinned'); vi.stubEnv('DRAW_EXECUTABLE', '/other/draw');
  const registerMcpServer = vi.fn();
  const pi = { on: vi.fn(), sendUserMessage: vi.fn(), appendEntry: vi.fn(), registerMcpServer };
  drawPi(pi, { mode: 'hosted', executable: '/installed/draw' });
  drawPi(pi, { mode: 'local', executable: '/installed/draw' });
  expect(registerMcpServer.mock.calls.map(call => call[0])).toEqual(['draw', 'draw-local']);
  expect(registerMcpServer.mock.calls[1][1].command).toBe('/installed/draw');
  expect(process.env.DRAW_MODE).toBe('local'); expect(process.env.DRAW_EXECUTABLE).toBe('/other/draw');
});
