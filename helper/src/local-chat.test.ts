import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalStore } from './local-store';
import { LocalChat } from './local-chat';
import type { connectCodex } from './chat-codex';
import type { ChatEvent } from '../../shared/chat';

const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).forEach(fn => fn()); });
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'local-chat-')); const store = new LocalStore(dir); const board = store.create('Review', dir);
  let emit: (event: ChatEvent) => void = () => {};
  const send = vi.fn(async (_text: string) => {}), stop = vi.fn(async () => {}), approve = vi.fn(async () => {});
  const connect = vi.fn<typeof connectCodex>(async options => {
    emit = options.emit; emit({ type: 'state', state: 'idle' });
    return { session: { id: `codex:${options.threadId}`, agent: 'codex', name: 'Codex', capabilities: { stop: 'interrupt', approvals: true } }, send, stop, approve, close() {} };
  });
  const chat = new LocalChat(store, () => {}, connect);
  cleanup.push(() => { chat.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, store, board, chat, send, stop, approve, connect, emit: (event: ChatEvent) => emit(event) };
}
it('persists feedback before delivery, separates context and deduplicates retries', async () => {
  const { store, board, chat, send, emit, connect } = setup();
  await expect(chat.send(board.slug, 'message-1', 'Check timeout', [])).rejects.toThrow('saved');
  expect(store.read(board.slug).feedback[0].state).toBe('saved');
  await chat.attach(board.slug, 'existing-thread', '/tmp/control.sock');
  expect(connect).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'existing-thread', socketPath: '/tmp/control.sock', cwd: board.repo }));
  send.mockImplementationOnce(async () => { expect(store.read(board.slug).feedback[0].state).toBe('pending'); });
  await chat.send(board.slug, 'message-1', 'Check timeout', []);
  expect(store.read(board.slug).feedback[0].state).toBe('delivered');
  expect(send.mock.calls[0][0]).toContain('untrusted diagram and review context');
  await chat.send(board.slug, 'message-1', 'Check timeout', []); expect(send).toHaveBeenCalledTimes(1);
  emit({ type: 'text', message: 'answer', delta: 'Checked.', final: true });
  expect(store.read(board.slug).feedback[0]).toMatchObject({ state: 'answered', reply: 'Checked.' });
});
it('keeps uncertain delivery visible and never automatically replays it', async () => {
  const { store, board, chat, send } = setup(); await chat.attach(board.slug, 'thread');
  send.mockRejectedValueOnce(new Error('connection lost'));
  await expect(chat.send(board.slug, 'message', 'Do work', [])).rejects.toThrow('connection lost');
  expect(store.read(board.slug).feedback[0].state).toBe('uncertain');
  await chat.send(board.slug, 'message', 'Do work', []); expect(send).toHaveBeenCalledTimes(1);
});
it('never sends when saving the pending state fails', async () => {
  const { store, board, chat, send } = setup(); await chat.attach(board.slug, 'thread');
  vi.spyOn(store, 'updateFeedback').mockImplementationOnce(() => { throw new Error('disk full'); });
  await expect(chat.send(board.slug, 'message', 'Do work', [])).rejects.toThrow('disk full');
  expect(send).not.toHaveBeenCalled(); expect(store.read(board.slug).feedback[0].state).toBe('saved');
});
it('recovers interrupted pending delivery as uncertain after restart', async () => {
  const { dir, store, board } = setup(); store.feedback(board.slug, 'message', 'Do work', []);
  store.updateFeedback(board.slug, 'message', { state: 'pending' }); store.close();
  const reopened = new LocalStore(dir);
  try { expect(reopened.read(board.slug).feedback[0].state).toBe('uncertain'); }
  finally { reopened.close(); }
});
it('preserves stop and explicit approval behavior', async () => {
  const { board, chat, stop, approve, emit } = setup(); await chat.attach(board.slug, 'thread');
  emit({ type: 'approval', id: 'approval', summary: 'Allow command?', status: 'pending' });
  expect(chat.status(board.slug).approvals).toHaveLength(1); expect(approve).not.toHaveBeenCalled();
  await chat.approve(board.slug, 'approval', 'decline'); expect(approve).toHaveBeenCalledWith('approval', 'decline');
  await chat.stop(board.slug); expect(stop).toHaveBeenCalledOnce();
});
