import { EventEmitter } from 'node:events';
import { Duplex, PassThrough, Readable, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { connectCodex } from './chat-codex';
import type { ChatEvent } from '../../shared/chat';

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn }));
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const cwd = process.cwd();
const threadId = 'existing-thread';
const thread = (status = 'idle') => ({ id: threadId, cwd, name: 'Current work', status: { type: status } });
const turn = (id = 'turn-1', status = 'inProgress', items: any[] = []) => ({ id, status, items });
const connections: Awaited<ReturnType<typeof connectCodex>>[] = [];
afterEach(() => { for (const connection of connections.splice(0)) connection.close(); vi.useRealTimers(); vi.clearAllMocks(); });

function server(overrides: Record<string, (frame: any) => any> = {}) {
  const frames: any[] = [];
  const events: ChatEvent[] = [];
  const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: PassThrough; kill: ReturnType<typeof vi.fn> };
  child.stdout = new PassThrough();
  child.stdin = new PassThrough();
  const serverSocket = Duplex.fromWeb({ readable: Readable.toWeb(child.stdin), writable: Writable.toWeb(child.stdout) });
  serverSocket.on('error', () => {});
  child.kill = vi.fn(() => { serverSocket.destroy(); return true; });
  const websocketServer = new WebSocketServer({ noServer: true });
  let websocket: WebSocket;
  const notification = (method: string, params: Record<string, unknown>, id?: string | number) => websocket.send(JSON.stringify({ method, params: { threadId, ...params }, ...(id === undefined ? {} : { id }) }));
  const defaults: Record<string, any> = {
    initialize: {}, 'thread/read': { thread: thread() }, 'thread/resume': { thread: thread() },
    'thread/turns/list': { data: [] }, 'turn/start': { turn: turn() }, 'turn/interrupt': {},
  };
  let headers = '';
  const handshake = (chunk: Buffer) => {
    headers += chunk.toString();
    if (!headers.includes('\r\n\r\n')) return;
    serverSocket.removeListener('data', handshake);
    const request = { method: 'GET', url: '/', headers: Object.fromEntries(headers.trim().split('\r\n').slice(1).map(line => {
      const colon = line.indexOf(':'); return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()];
    })) };
    websocketServer.handleUpgrade(request as any, serverSocket, Buffer.alloc(0), socket => {
      websocket = socket;
      websocket.on('error', () => {});
      websocket.on('message', data => {
        const frame = JSON.parse(data.toString());
        frames.push(frame);
        if (frame.id !== undefined && frame.method) {
          const result = overrides[frame.method] ? overrides[frame.method](frame) : defaults[frame.method];
          if (result !== undefined) websocket.send(JSON.stringify({ id: frame.id, ...(result.error ? result : { result }) }));
        }
      });
    });
  };
  serverSocket.on('data', handshake);
  spawn.mockReturnValue(child);
  const disconnect = vi.fn();
  const start = async (signal?: AbortSignal) => {
    const connection = await connectCodex({ threadId, cwd, emit: event => events.push(event), onDisconnect: disconnect, signal, socketPath: '/tmp/existing.sock' });
    connections.push(connection);
    return connection;
  };
  return { start, child, frames, events, notification, disconnect, raw: (data: string, fin = true) => websocket.send(data, { fin }) };
}

describe('the shared terminal conversation', () => {
  it('attaches to the exact loaded thread without starting a daemon or overriding its settings', async () => {
    const s = server();
    const connection = await s.start();
    expect(spawn).toHaveBeenCalledWith('codex', ['app-server', 'proxy', '--sock', '/tmp/existing.sock'], { cwd, stdio: ['pipe', 'pipe', 'ignore'] });
    expect(s.frames.map(frame => frame.method)).toEqual(['initialize', 'initialized', 'thread/read', 'thread/resume', 'thread/turns/list']);
    expect(s.frames.find(frame => frame.method === 'thread/resume').params).toEqual({ threadId, excludeTurns: true });
    expect(connection.session).toMatchObject({ id: `codex:${threadId}`, agent: 'codex', capabilities: { stop: 'interrupt', approvals: true } });
    connection.close();
    expect(s.frames.some(frame => frame.method === 'turn/interrupt')).toBe(false);
    expect(s.child.kill).toHaveBeenCalledOnce();
    expect(s.disconnect).not.toHaveBeenCalled();
  });

  it('keeps private or oversized thread titles out of the public session descriptor', async () => {
    const title = 'private-title-'.repeat(100);
    const s = server({ 'thread/resume': () => ({ thread: { ...thread(), name: title } }) });
    const connection = await s.start();
    expect(connection.session.name).toBe('Codex');
    expect(JSON.stringify(connection.session)).not.toContain(title);
  });

  it.each([
    { thread: { ...thread(), cwd: '/' } }, { thread: { ...thread(), id: 'another-thread' } }, { thread: thread('notLoaded') },
  ])('refuses another checkout, thread, or standalone terminal before resuming', async read => {
    const s = server({ 'thread/read': () => read });
    await expect(s.start()).rejects.toThrow('UNAVAILABLE');
    expect(s.frames.some(frame => frame.method === 'thread/resume')).toBe(false);
    expect(s.child.kill).toHaveBeenCalledOnce();
  });

  it('loads recent conversation text and filters tool internals and reasoning', async () => {
    const s = server({ 'thread/turns/list': () => ({ data: [turn('old', 'completed', [
      { id: 'u1', type: 'userMessage', content: [{ type: 'text', text: 'first' }, { type: 'image', url: 'private-url' }, { type: 'text', text: 'second' }] },
      { id: 'a1', type: 'agentMessage', text: 'answer' },
      { id: 'c1', type: 'commandExecution', command: 'private-command', aggregatedOutput: 'private-output' },
      { id: 'r1', type: 'reasoning', content: ['private-reasoning'] },
    ])] }) });
    await s.start();
    expect(s.events).toContainEqual({ type: 'user', id: 'u1', text: 'first\nsecond', origin: 'terminal' });
    expect(s.events).toContainEqual({ type: 'text', message: 'a1', delta: 'answer', final: true });
    expect(JSON.stringify(s.events)).not.toContain('private-');
  });

  it('mirrors terminal messages, suppresses our own turn even before its acknowledgment, and preserves multiline input', async () => {
    const s = server({ 'turn/start': () => {
      s.notification('turn/started', { turn: turn() });
      s.notification('item/started', { turnId: 'turn-1', item: { type: 'userMessage', id: 'board-user', content: [{ type: 'text', text: 'board\nmessage' }] } });
      return { turn: turn() };
    } });
    const connection = await s.start();
    await connection.send('board\nmessage');
    s.notification('item/completed', { turnId: 'turn-1', item: { type: 'userMessage', id: 'board-user', content: [{ type: 'text', text: 'board\nmessage' }] } });
    await flush();
    s.notification('item/started', { turnId: 'terminal-turn', item: { type: 'userMessage', id: 'terminal-user', content: [{ type: 'text', text: 'hello' }] } });
    await flush();
    expect(s.events.filter(event => event.type === 'user')).toEqual([{ type: 'user', id: 'terminal-user', text: 'hello', origin: 'terminal' }]);
    expect(s.frames.find(frame => frame.method === 'turn/start').params).toEqual({ threadId, input: [{ type: 'text', text: 'board\nmessage', text_elements: [] }] });
    await expect(connection.send('second')).rejects.toThrow('current turn');
  });

  it('streams text once, finalizes a message, and ignores other threads and raw tool output', async () => {
    const s = server();
    await s.start();
    s.notification('item/agentMessage/delta', { threadId: 'another-thread', itemId: 'wrong', delta: 'private' });
    await flush();
    s.notification('item/agentMessage/delta', { turnId: 't', itemId: 'a', delta: 'Hello ' });
    await flush();
    s.notification('item/agentMessage/delta', { turnId: 't', itemId: 'a', delta: 'world' });
    await flush();
    s.notification('item/completed', { turnId: 't', item: { id: 'a', type: 'agentMessage', text: 'Hello world!' } });
    await flush();
    s.notification('item/completed', { turnId: 't', item: { id: 'a', type: 'agentMessage', text: 'Hello world!' } });
    await flush();
    s.notification('item/commandExecution/outputDelta', { delta: 'private-output' });
    await flush();
    expect(s.events.filter(event => event.type === 'text')).toEqual([
      { type: 'text', message: 'a', delta: 'Hello ', final: false },
      { type: 'text', message: 'a', delta: 'world', final: false },
      { type: 'text', message: 'a', delta: '!', final: true },
    ]);
    expect(JSON.stringify(s.events)).not.toContain('private');
  });

  it('interrupts the exact active turn and waits for confirmation', async () => {
    const s = server({ 'thread/resume': () => ({ thread: thread('active') }), 'thread/turns/list': () => ({ data: [turn()] }) });
    const connection = await s.start();
    await connection.stop();
    expect(s.frames.at(-1).params).toEqual({ threadId, turnId: 'turn-1' });
    expect(s.events.at(-1)).toEqual({ type: 'state', state: 'stopping' });
    s.notification('turn/completed', { turn: turn('turn-1', 'interrupted') });
    await flush();
    await vi.waitFor(() => expect(s.events.at(-1)).toEqual({ type: 'state', state: 'stopped' }));
  });

  it('finalizes partial text on interruption even when the server sends no item completion', async () => {
    const s = server();
    await s.start();
    s.notification('turn/started', { turn: turn() });
    s.notification('item/agentMessage/delta', { turnId: 'turn-1', itemId: 'partial', delta: 'partial line' });
    s.notification('turn/completed', { turn: turn('turn-1', 'interrupted') });
    await flush();
    expect(s.events).toContainEqual({ type: 'text', message: 'partial', delta: '', final: true });
  });

  it('does not duplicate streamed text already included in the attachment history', async () => {
    const s = server({ 'thread/turns/list': () => {
      s.notification('item/agentMessage/delta', { turnId: 'turn-1', itemId: 'active', delta: 'already in history' });
      return { data: [turn('turn-1', 'inProgress', [{ type: 'agentMessage', id: 'active', text: 'already in history' }])] };
    } });
    await s.start();
    s.notification('item/completed', { turnId: 'turn-1', item: { type: 'agentMessage', id: 'active', text: 'already in history and completed' } });
    await flush();
    expect(s.events.filter(event => event.type === 'text').map(event => event.delta).join('')).toBe('already in history and completed');
  });

  it('does not leave a fast completed turn marked active after the start response', async () => {
    const s = server({ 'turn/start': () => {
      s.notification('turn/started', { turn: turn() });
      s.notification('turn/completed', { turn: turn('turn-1', 'completed') });
      return { turn: turn() };
    } });
    const connection = await s.start();
    await connection.send('first');
    await connection.send('second');
    expect(s.frames.filter(frame => frame.method === 'turn/start')).toHaveLength(2);
  });
});

describe('approval identity and races', () => {
  it('answers only the exact pending request and rejects duplicates or decisions not offered', async () => {
    const s = server();
    const connection = await s.start();
    s.notification('turn/started', { turn: turn() });
    await flush();
    s.notification('item/commandExecution/requestApproval', { turnId: 'turn-1', itemId: 'cmd', command: 'private-command', availableDecisions: ['accept', 'decline'] }, 8);
    await flush();
    const approval = s.events.find(event => event.type === 'approval')!;
    if (approval.type !== 'approval') throw new Error('missing approval');
    await expect(connection.approve('8', 'accept')).rejects.toThrow('no longer pending');
    await connection.approve(approval.id, 'accept');
    await flush();
    expect(s.frames.at(-1)).toEqual({ id: 8, result: { decision: 'accept' } });
    await expect(connection.approve(approval.id, 'accept')).rejects.toThrow('no longer pending');
    s.notification('item/commandExecution/requestApproval', { turnId: 'turn-1', itemId: 'cmd2', availableDecisions: ['decline'] }, 9);
    await flush();
    const second = s.events.at(-1)!;
    if (second.type !== 'approval') throw new Error('missing approval');
    await expect(connection.approve(second.id, 'accept')).rejects.toThrow('not offered');
    expect(approval.summary).toContain(`Allow this command in ${cwd}?\nprivate-command`);
  });

  it('shows the actual file paths and working directory without copying file diffs', async () => {
    const s = server();
    const connection = await s.start();
    s.notification('turn/started', { turn: turn() });
    s.notification('item/started', { turnId: 'turn-1', item: { type: 'fileChange', id: 'files', changes: [{ path: '/repo/file.ts', diff: 'private-file-content' }] } });
    s.notification('item/fileChange/requestApproval', { turnId: 'turn-1', itemId: 'files', grantRoot: '/repo' }, 'file-request');
    await flush();
    const approval = s.events.at(-1)!;
    if (approval.type !== 'approval') throw new Error('missing approval');
    expect(approval.summary).toContain(cwd);
    expect(approval.summary).toContain('/repo/file.ts');
    expect(approval.summary).toContain('Requested write root for this session: /repo');
    expect(JSON.stringify(s.events)).not.toContain('private-file-content');
    await connection.approve(approval.id, 'decline');
    await flush();
    expect(s.frames.at(-1)).toEqual({ id: 'file-request', result: { decision: 'decline' } });
  });

  it('declines with cancel when that is the only refusal the command offers', async () => {
    const s = server();
    const connection = await s.start();
    s.notification('turn/started', { turn: turn() });
    s.notification('item/commandExecution/requestApproval', { turnId: 'turn-1', itemId: 'cmd', availableDecisions: ['accept', 'cancel'] }, 19);
    await flush();
    const approval = s.events.at(-1)!;
    if (approval.type !== 'approval') throw new Error('missing approval');
    await connection.approve(approval.id, 'decline');
    await flush();
    expect(s.frames.at(-1)).toEqual({ id: 19, result: { decision: 'cancel' } });
    expect(s.events).toContainEqual({ type: 'notice', text: 'Declined. The agent will stop this turn.' });
  });

  it('clears requests answered in the terminal or completed, and ignores foreign/late approvals', async () => {
    const s = server();
    const connection = await s.start();
    s.notification('turn/started', { turn: turn() });
    await flush();
    s.notification('item/fileChange/requestApproval', { turnId: 'turn-1', itemId: 'file' }, 'request');
    await flush();
    const first = s.events.at(-1)!;
    if (first.type !== 'approval') throw new Error('missing approval');
    s.notification('serverRequest/resolved', { requestId: 'request' });
    await flush();
    await expect(connection.approve(first.id, 'accept')).rejects.toThrow('no longer pending');
    s.notification('item/fileChange/requestApproval', { threadId: 'foreign', turnId: 'turn-1', itemId: 'file' }, 'foreign-request');
    await flush();
    s.notification('item/fileChange/requestApproval', { turnId: 'turn-1', itemId: 'file' }, 'other-request');
    await flush();
    const second = s.events.at(-1)!;
    if (second.type !== 'approval') throw new Error('missing approval');
    s.notification('turn/completed', { turn: turn('turn-1', 'completed') });
    await flush();
    await expect(connection.approve(second.id, 'accept')).rejects.toThrow('no longer pending');
    s.notification('item/fileChange/requestApproval', { turnId: 'turn-1', itemId: 'file' }, 'late-request');
    await flush();
    expect(s.events.filter(event => event.type === 'approval' && event.status === 'pending')).toHaveLength(2);
  });
});

describe('connection failures', () => {
  it('does not spawn a proxy for an already cancelled connection', async () => {
    const s = server();
    const controller = new AbortController();
    controller.abort();
    await expect(s.start(controller.signal)).rejects.toThrow('cancelled');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('cancels initialization, closes only the proxy, and removes the abort listener', async () => {
    const s = server({ initialize: () => undefined });
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const connecting = s.start(controller.signal);
    const rejected = expect(connecting).rejects.toThrow('connection closed');
    await vi.waitFor(() => expect(s.frames.some(frame => frame.method === 'initialize')).toBe(true));
    controller.abort();
    await rejected;
    expect(s.child.kill).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(s.frames.map(frame => frame.method)).toEqual(['initialize']);
    expect(s.disconnect).not.toHaveBeenCalled();
  });

  it('cancels before the WebSocket handshake completes', async () => {
    const s = server();
    const controller = new AbortController();
    const connecting = s.start(controller.signal);
    const rejected = expect(connecting).rejects.toThrow('terminal');
    controller.abort();
    await rejected;
    expect(s.child.kill).toHaveBeenCalledOnce();
    expect(s.frames).toHaveLength(0);
  });

  it('rejects a failed handshake without exposing raw server errors', async () => {
    const s = server({ initialize: () => ({ error: { message: 'private-error', code: -1 } }) });
    await expect(s.start()).rejects.toThrow('terminal rejected');
    expect(s.frames).toHaveLength(1);
    expect(s.child.kill).toHaveBeenCalledOnce();
    expect(JSON.stringify(s.events)).not.toContain('private-error');
  });

  it('rejects an in-flight send, closes the relay callback once, and never resends after disconnect', async () => {
    const s = server({ 'turn/start': () => undefined });
    const connection = await s.start();
    const sending = connection.send('hello');
    await flush();
    const rejection = expect(sending).rejects.toThrow('connection was lost');
    s.child.emit('exit', 1);
    await rejection;
    s.child.emit('exit', 1);
    expect(s.disconnect).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(s.events.at(-1)).toEqual({ type: 'state', state: 'stopped' }));
    await expect(connection.send('hello')).rejects.toThrow('reconnect');
    expect(s.frames.filter(frame => frame.method === 'turn/start')).toHaveLength(1);
  });

  it('times out unacknowledged requests as uncertain instead of automatically retrying', async () => {
    vi.useFakeTimers();
    const s = server({ 'turn/start': () => undefined });
    const connection = await s.start();
    const rejection = expect(connection.send('hello')).rejects.toThrow('UNCONFIRMED');
    await vi.advanceTimersByTimeAsync(30_000);
    await rejection;
    expect(s.disconnect).toHaveBeenCalledOnce();
  });

  it('reads split JSON frames and closes on malformed protocol data', async () => {
    const s = server();
    await s.start();
    const frame = JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId, itemId: 'a', delta: 'one\u2028two' } });
    s.raw(frame.slice(0, 30), false);
    await flush();
    s.raw(frame.slice(30));
    await flush();
    expect(s.events.at(-1)).toMatchObject({ type: 'text', delta: 'one\u2028two' });
    s.raw('invalid-json');
    await flush();
    expect(s.disconnect).toHaveBeenCalledOnce();
  });
});
