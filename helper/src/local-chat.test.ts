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
  await chat.attach(board.slug, 'thread');
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
  emit({ type: 'state', state: 'working' });
  emit({ type: 'approval', id: 'approval', summary: 'Allow command?', status: 'pending' });
  expect(chat.status(board.slug).approvals).toHaveLength(1); expect(approve).not.toHaveBeenCalled();
  await chat.approve(board.slug, 'approval', 'decline'); expect(approve).toHaveBeenCalledWith('approval', 'decline');
  await chat.stop(board.slug); expect(stop).toHaveBeenCalledOnce();
});
it('binds hook agents to the repository/session and saves a late reply after an uncertain delivery', async () => {
  const { store, board, chat } = setup();
  await expect(chat.attach(board.slug, 'thread', undefined, 'pi', '/')).rejects.toThrow('another repository');
  await chat.attach(board.slug, 'thread', undefined, 'pi', board.repo);
  expect(() => chat.hook(board.slug, 'pi:other')).toThrow('UNAVAILABLE');
  const hook = chat.hook(board.slug, 'pi:thread');
  vi.useFakeTimers();
  try {
    const sent = expect(chat.send(board.slug, 'late', 'Do work', [])).rejects.toThrow('UNCONFIRMED');
    await hook.poll();
    await vi.advanceTimersByTimeAsync(25000); await sent;
    expect(store.read(board.slug).feedback[0].state).toBe('uncertain');
    hook.event({ type: 'text', message: 'answer', delta: 'Done', final: false });
    hook.event({ type: 'state', state: 'idle' });
    expect(store.read(board.slug).feedback[0]).toMatchObject({ state: 'answered', reply: 'Done' });
    hook.disconnect(); expect(chat.status(board.slug).connected).toBe(false);
  } finally { vi.useRealTimers(); }
});
it('does not claim a stopped or empty hook turn answered its feedback', async () => {
  const { store, board, chat } = setup();
  await chat.attach(board.slug, 'thread', undefined, 'pi', board.repo);
  const hook = chat.hook(board.slug, 'pi:thread');
  const sent = chat.send(board.slug, 'stop', 'Do work', []), delivery = await hook.poll() as { id: string };
  hook.acknowledge(delivery.id); await sent;
  hook.event({ type: 'state', state: 'stopped' });
  expect(store.read(board.slug).feedback[0].state).toBe('uncertain');
});
it('allows a new board instruction after stopping the previous turn', async () => {
  const { store, board, chat } = setup();
  await chat.attach(board.slug, 'thread', undefined, 'pi', board.repo);
  const hook = chat.hook(board.slug, 'pi:thread');
  hook.event({ type: 'state', state: 'stopped' });
  const sent = chat.send(board.slug, 'after-stop', 'New instruction', []);
  sent.catch(() => {});
  const delivery = await hook.poll() as { id: string };
  hook.acknowledge(delivery.id); await sent;
  expect(store.read(board.slug).feedback[0].state).toBe('delivered');
});
