import { describe, it, expect } from 'vitest';
import { chatReducer, initialChat, DROPPED, type ChatState } from './agent-chat';

const delta = (text: string) => ({ type: 'event', event: { type: 'delta', text } }) as const;
const run = (state: ChatState, ...actions: Parameters<typeof chatReducer>[1][]) =>
  actions.reduce(chatReducer, state);

describe('chatReducer', () => {
  it('send adds my message and marks sending', () => {
    const s = chatReducer(initialChat(), { type: 'send', text: 'hi' });
    expect(s).toEqual({ items: [{ kind: 'me', text: 'hi' }], sending: true });
  });

  it('an empty delta changes nothing', () => {
    const start = run(initialChat(), { type: 'send', text: 'hi' });
    expect(chatReducer(start, delta(''))).toBe(start);
  });

  it('an unknown event type changes nothing', () => {
    const start = run(initialChat(), { type: 'send', text: 'hi' });
    const unknown = { type: 'event', event: { type: 'mystery' } } as unknown as Parameters<typeof chatReducer>[1];
    expect(chatReducer(start, unknown)).toBe(start);
  });

  it('deltas build one agent message', () => {
    const s = run(initialChat(), delta('Hel'), delta('lo'));
    expect(s.items).toEqual([{ kind: 'agent', text: 'Hello' }]);
  });

  it('a status between deltas starts a new agent message after it', () => {
    const s = run(initialChat(), delta('a'), { type: 'event', event: { type: 'status', message: 'working' } }, delta('b'));
    expect(s.items).toEqual([
      { kind: 'agent', text: 'a' },
      { kind: 'status', text: 'working' },
      { kind: 'agent', text: 'b' },
    ]);
  });

  it('an error event adds an error item', () => {
    const s = run(initialChat(), { type: 'event', event: { type: 'error', code: 'x', message: 'boom' } });
    expect(s.items).toEqual([{ kind: 'error', text: 'boom' }]);
  });

  it('a stream that ends without done is an error', () => {
    const s = run({ items: [], sending: true }, { type: 'ended', how: 'dropped' });
    expect(s).toEqual({ items: [{ kind: 'error', text: DROPPED }], sending: false });
  });

  it('ended done clears sending', () => {
    expect(run({ items: [], sending: true }, { type: 'ended', how: 'done' }).sending).toBe(false);
  });

  it('ended error clears sending without a second error item', () => {
    const s = run({ items: [{ kind: 'error', text: 'boom' }], sending: true }, { type: 'ended', how: 'error' });
    expect(s).toEqual({ items: [{ kind: 'error', text: 'boom' }], sending: false });
  });

  it('done text is used only when no agent text arrived for this reply', () => {
    const done = { type: 'event', event: { type: 'done', text: 'final' } } as const;
    expect(run(initialChat(), { type: 'send', text: 'q' }, done).items.slice(-1)[0]).toEqual({ kind: 'agent', text: 'final' });
    expect(run(initialChat(), { type: 'send', text: 'q' }, delta('final'), done).items)
      .toEqual([{ kind: 'me', text: 'q' }, { kind: 'agent', text: 'final' }]);
    // An agent message from an earlier reply does not count.
    const second = run(initialChat(), { type: 'send', text: 'q' }, delta('old'), { type: 'send', text: 'q2' }, done);
    expect(second.items.slice(-1)[0]).toEqual({ kind: 'agent', text: 'final' });
  });

  it('does not mutate the input state', () => {
    const before: ChatState = { items: [{ kind: 'agent', text: 'a' }], sending: true };
    const snapshot = structuredClone(before);
    run(before, delta('b'), { type: 'send', text: 'x' }, { type: 'ended', how: 'dropped' });
    expect(before).toEqual(snapshot);
  });
});
