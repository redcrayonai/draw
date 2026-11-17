import { afterEach, expect, it, vi } from 'vitest';
import { requestChatHandoff } from './chat-handoff';
import type { ChatConnectionOptions } from './chat-connection';

afterEach(() => vi.useRealTimers());

function setup() {
  vi.useFakeTimers();
  let options!: ChatConnectionOptions;
  const send = vi.fn((_frame: Record<string, any>) => true), close = vi.fn();
  const result = requestChatHandoff('wss://relay/chat/2', async () => 'token', 'Continue here', o => {
    options = o;
    return { start() {}, send, close };
  });
  return { options, send, close, result };
}

it('sends once to the sole session and waits for its queue acknowledgement', async () => {
  const { options, send, close, result } = setup();
  options.receive({ type: 'sessions', sessions: [{ id: 'existing' }], selected: 'existing' });
  options.receive({ type: 'snapshot', session: { id: 'existing' } });
  options.receive({ type: 'snapshot', session: { id: 'existing' } });
  expect(send).toHaveBeenCalledTimes(1);
  const frame = send.mock.calls[0][0];
  expect(frame).toMatchObject({ type: 'send', session: 'existing', text: 'Continue here' });
  expect(close).not.toHaveBeenCalled();
  options.receive({ type: 'queue', session: 'existing', queue: [{ id: frame.id }] });
  await expect(result).resolves.toBeUndefined();
  expect(close).toHaveBeenCalledOnce();
});

it('does not guess between multiple sessions', async () => {
  const { options, send, close, result } = setup();
  options.receive({ type: 'sessions', sessions: [{ id: 'one' }, { id: 'two' }], selected: null });
  await expect(result).rejects.toThrow('more than one session');
  expect(send).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledOnce();
});

it('closes a connection that never acknowledges without resending', async () => {
  const { result, close, send } = setup();
  const rejected = expect(result).rejects.toThrow('confirm');
  await vi.advanceTimersByTimeAsync(15_000);
  await rejected;
  expect(send).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledOnce();
});

it('fails at once when no conversation is attached on the other board', async () => {
  const { options, send, close, result } = setup();
  options.receive({ type: 'sessions', sessions: [], selected: null });
  options.receive({ agent: 'gone' });
  await expect(result).rejects.toThrow('not connected to board chat');
  expect(send).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledOnce();
});
