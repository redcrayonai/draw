import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runChat } from './chat';
import { approvedChatConnection, startChatConnection } from './chat-bootstrap';
import { PermissionError } from './permissions';
import type { ChatEvent } from '../../shared/chat';

const state = vi.hoisted(() => ({ directory: '', denied: false, managed: true, connect: vi.fn() }));
vi.mock('./permissions', async original => ({
  ...await original<typeof import('./permissions')>(),
  runtimePermissions: () => state.managed ? { boards: 'ask', conversation: state.denied ? 'deny' : 'ask' } : undefined,
  enforceToolPermissions: () => { if (state.denied) throw new PermissionError('REJECTED: conversation denied'); },
}));
vi.mock('./chat-path', () => ({ chatDir: () => state.directory, chatSocketPath: () => join(state.directory, 'chat.sock'), removeDeadSockets: async () => {} }));
vi.mock('./chat-codex', () => ({ connectCodex: state.connect }));

let emit: (event: ChatEvent) => void;
let input: PassThrough;
const close = vi.fn(), send = vi.fn(async () => {}), approve = vi.fn(async () => {});
const token = `x.${Buffer.from(JSON.stringify({ board: '7' })).toString('base64url')}.y`;
const origin = 'https://relay.invalid';
const approval = { session_id: 'thread', hook_event_name: 'PostToolUse', tool_name: 'mcp__draw__start_chat', tool_response: { token, board: '7', origin } };
const connection = { session: 'codex:thread', agent: 'codex' as const, token, board: '7', origin, at: Date.now() };
class Socket {
  static all: Socket[] = [];
  readyState = 1;
  sent: any[] = [];
  handlers: Record<string, (event: any) => void> = {};
  constructor() { Socket.all.push(this); }
  addEventListener(type: string, callback: (event: any) => void) { this.handlers[type] = callback; }
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
  close() {}
  frame(value: object) { this.handlers.message({ data: JSON.stringify(value) }); }
}
beforeEach(() => {
  state.directory = mkdtempSync(join(tmpdir(), 'draw-chat-permissions-'));
  state.denied = false; state.managed = true; Socket.all = [];
  input = new PassThrough();
  vi.spyOn(process, 'stdin', 'get').mockReturnValue(input as unknown as typeof process.stdin);
  vi.stubGlobal('WebSocket', Socket);
  state.connect.mockImplementation(async options => {
    emit = options.emit;
    return { session: { id: connection.session, agent: 'codex', name: 'Codex', capabilities: {} }, send, stop: async () => {}, approve, close };
  });
});
afterEach(() => { input.destroy(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks(); rmSync(state.directory, { recursive: true, force: true }); });

it('requires a matching successful start_chat hook, not a start_session or another token', () => {
  expect(approvedChatConnection(approval, connection)).toBe(true);
  expect(approvedChatConnection({ ...approval, tool_name: 'mcp__draw__start_session' }, connection)).toBe(false);
  expect(approvedChatConnection({ ...approval, hook_event_name: 'PreToolUse' }, connection)).toBe(false);
  expect(approvedChatConnection(approval, { ...connection, token: 'another-token' })).toBe(false);
});
it('does not reconnect saved managed Ask connections without new approved provenance', async () => {
  await expect(startChatConnection(state.directory, connection)).rejects.toThrow('approve it in Codex');
  expect(state.connect).not.toHaveBeenCalled();
});
it('blocks a managed terminal fallback before opening sockets', async () => {
  await expect(runChat(['--token', token], origin, state.directory, () => {}, () => {})).rejects.toThrow('approve it in Codex');
  expect(Socket.all).toHaveLength(0);
});
it('checks saved Deny before reading approval or connecting', async () => {
  state.denied = true;
  await expect(runChat(['--token', token, '--agent', 'codex', '--session', 'thread'], origin, state.directory, () => {}, () => {})).rejects.toThrow('denied');
  expect(state.connect).not.toHaveBeenCalled(); expect(Socket.all).toHaveLength(0);
});
it.each(['reply', 'message', 'approval'] as const)('disconnects without forwarding a %s after revocation', async action => {
  const running = runChat(['--token', token, '--agent', 'codex', '--session', 'thread'], origin, state.directory, () => {}, () => {});
  input.end(JSON.stringify(approval));
  await vi.waitFor(() => expect(Socket.all).toHaveLength(1));
  const socket = Socket.all[0]; socket.frame({ ok: true });
  state.denied = true;
  if (action === 'reply') emit({ type: 'text', message: 'answer', delta: 'Private reply', final: true });
  else socket.frame(action === 'message' ? { type: 'send', id: 'message', text: 'Do work' } : { type: 'approval', id: 'pending', decision: 'accept' });
  expect(await running).toBe(1);
  expect(send).not.toHaveBeenCalled(); expect(approve).not.toHaveBeenCalled();
  expect(socket.sent).toEqual([]); expect(close).toHaveBeenCalled();
});
