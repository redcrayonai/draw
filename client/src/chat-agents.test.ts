import { describe, expect, it, vi } from 'vitest';
import { applyFrame, emptyChat } from './agent-chat';
import { joinAgents, type BoardAgent } from './chat-agents';
import type { ChatConnectionOptions, ChatFrame } from './chat-connection';
import type { AgentReply } from './plugin-api';

const last = <T>(list: T[], back = 1): T => list[list.length - back];
const tick = () => new Promise<void>(resolve => queueMicrotask(resolve));
const OWN = { id: 'own-1', agent: 'claude', name: 'feature/x', capabilities: { stop: 'step', approvals: false } };

/** A plugin agent that records what it was sent and lets the test write its reply. */
function fakeAgent(reset = true) {
  const sent: [string, string | undefined][] = [];
  const stop = vi.fn();
  const forget = vi.fn();
  let reply!: AgentReply;
  const agent: BoardAgent = {
    id: 'helper',
    name: 'Agent',
    open(r) {
      reply = r;
      return { send: (text, about) => { sent.push([text, about]); }, stop, ...(reset ? { reset: forget } : {}) };
    },
  };
  return { agent, sent, stop, forget, reply: () => reply };
}

/** The joined connection feeding the shell's own model, and the person's relay stood in by hand. */
function joined(agents: BoardAgent[], linked = true) {
  const model = emptyChat();
  const frames: ChatFrame[] = [];
  const statuses: string[] = [];
  const relaySent: ChatFrame[] = [];
  let relay!: ChatConnectionOptions;
  const connection = joinAgents(linked ? options => {
    relay = options;
    return { start() {}, close() {}, send: frame => { relaySent.push(frame); return true; } };
  } : null, agents, {
    url: 'wss://x/chat/1',
    token: async () => 'tok',
    receive: frame => { frames.push(frame); applyFrame(model, frame); },
    status: status => { statuses.push(status); model.connection = status as typeof model.connection; model.online = false; },
  });
  connection.start();
  const send = async (frame: ChatFrame) => {
    const ok = connection.send({ ...frame, session: frame.session ?? model.selected });
    await tick();
    return ok;
  };
  /** What the relay transport does when the hub says nobody is there, or somebody is. */
  const hub = (sessions: object[], selected: string | null, connected = selected !== null) => {
    relay.receive({ type: 'sessions', sessions, selected });
    relay.status(connected ? 'syncing' : 'waiting');
    relay.receive({ agent: connected ? 'connected' : 'gone' });
  };
  return { model, frames, statuses, relaySent, connection, send, hub, relay: () => relay };
}

describe('joinAgents', () => {
  it('with nobody linked, the plugin agent is the conversation: a message, steps, text in order, then idle', async () => {
    const a = fakeAgent();
    const { model, send } = joined([a.agent], false);
    expect(model).toMatchObject({ online: true, selected: 'plugin:helper', session: { name: 'Agent', agent: 'plugin', capabilities: { reset: true } } });

    await send({ type: 'send', id: 'b1', text: 'Why is this here?', context: 'API' });
    expect(a.sent).toEqual([['Why is this here?', 'API']]);
    expect(model.state).toBe('working');
    a.reply().step('Reading the board');
    a.reply().text('Because ');
    a.reply().text('it serves the web app.');
    a.reply().step('Moving a node');
    a.reply().text('Done.');
    a.reply().done();
    expect(model.state).toBe('idle');
    expect(model.items).toEqual([
      { kind: 'user', id: 'b1', text: 'Why is this here?', context: 'API' },
      { kind: 'work', steps: [{ id: 's1', summary: 'Reading the board', done: true }] },
      { kind: 'text', message: 'm1', text: 'Because it serves the web app.', final: true },
      { kind: 'work', steps: [{ id: 's2', summary: 'Moving a node', done: true }] },
      { kind: 'text', message: 'm2', text: 'Done.', final: true },
    ]);
  });

  it('queues while a reply is under way, shows a failure, and delivers the next message after it', async () => {
    const a = fakeAgent();
    const { model, send } = joined([a.agent], false);
    await send({ type: 'send', id: 'b1', text: 'one' });
    await send({ type: 'send', id: 'b2', text: 'two' });
    await send({ type: 'send', id: 'b3', text: 'three' });
    expect(model.queue.map(q => q.id)).toEqual(['b2', 'b3']);
    await send({ type: 'delete', id: 'b2' });
    a.reply().done('The connection dropped. Send again to continue.');
    expect(last(model.items, 2)).toEqual({ kind: 'notice', text: 'The connection dropped. Send again to continue.', attention: true });
    expect(a.sent.map(s => s[0])).toEqual(['one', 'three']);
    expect(model).toMatchObject({ state: 'working', queue: [] });
  });

  it('Stop ends the reply and holds the queue until Resume; New chat forgets the conversation', async () => {
    const a = fakeAgent();
    const { model, send } = joined([a.agent], false);
    await send({ type: 'send', id: 'b1', text: 'one' });
    await send({ type: 'send', id: 'b2', text: 'two' });
    a.reply().text('Star');
    await send({ type: 'stop' });
    expect(a.stop).toHaveBeenCalledTimes(1);
    expect(model).toMatchObject({ state: 'stopped', paused: true, queue: [{ id: 'b2' }] });
    a.reply().text('late'); // the stopped reply says no more
    expect(last(model.items)).toMatchObject({ text: 'Star', final: true });
    await send({ type: 'resume' });
    expect(a.sent.map(s => s[0])).toEqual(['one', 'two']);

    await send({ type: 'reset' });
    expect(a.forget).toHaveBeenCalledTimes(1);
    expect(model).toMatchObject({ items: [], queue: [], state: 'idle', online: true });
  });

  it('a conversation that calls done() from inside stop() or reset() does not start the next message', async () => {
    const sent: string[] = [];
    let reply!: AgentReply;
    const agent: BoardAgent = { id: 'eager', name: 'Agent', open(r) { reply = r; return { send: text => { sent.push(text); }, stop: () => reply.done(), reset: () => reply.done() }; } };
    const { model, send } = joined([agent], false);
    await send({ type: 'send', id: 'b1', text: 'one' });
    await send({ type: 'send', id: 'b2', text: 'two' });
    await send({ type: 'stop' });
    expect(sent).toEqual(['one']);
    expect(model).toMatchObject({ state: 'stopped', paused: true, queue: [{ id: 'b2' }] });
    await send({ type: 'resume' });
    expect(sent).toEqual(['one', 'two']);
    await send({ type: 'send', id: 'b3', text: 'three' });
    await send({ type: 'reset' });
    expect(sent).toEqual(['one', 'two']);
    expect(model).toMatchObject({ items: [], queue: [], state: 'idle' });
  });

  it('an agent that throws shows a sentence and leaves the panel working', async () => {
    const agent: BoardAgent = { id: 'bad', name: 'Agent', open: () => ({ send() { throw new Error('boom'); }, stop() {} }) };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { model, send } = joined([agent], false);
    expect(model.session?.capabilities.reset).toBe(false);
    await send({ type: 'send', id: 'b1', text: 'one' });
    expect(last(model.items)).toEqual({ kind: 'notice', text: 'Agent stopped working. Reload the page to try again.', attention: true });
    expect(model.state).toBe('idle');
    const none = joined([{ id: 'worse', name: 'Agent', open() { throw new Error('boom'); } }], false);
    expect(none.statuses).toEqual(['offline']);
    warn.mockRestore();
  });

  it('fills in when the person\'s own agent is not connected, and steps back when theirs arrives', async () => {
    const a = fakeAgent();
    const { model, hub, relay, statuses } = joined([a.agent]);
    relay().status('connecting');
    expect(statuses).toEqual(['connecting']);
    hub([], null);
    expect(model).toMatchObject({ online: true, selected: 'plugin:helper' });
    expect(statuses).toEqual(['connecting']); // never "Waiting for agent" over a working chat

    hub([OWN], 'own-1');
    relay().receive({ type: 'snapshot', session: OWN, events: [{ type: 'user', id: 'u', text: 'earlier' }], queue: [], state: 'idle' });
    expect(model).toMatchObject({ online: true, selected: 'own-1', items: [{ text: 'earlier' }] });
    expect(model.sessions.map(s => s.id)).toEqual(['own-1', 'plugin:helper']);
  });

  it('a conversation the person has used or picked stays on screen; the other is one pick away', async () => {
    const a = fakeAgent();
    const { model, hub, relay, send, relaySent } = joined([a.agent]);
    hub([], null);
    await send({ type: 'send', id: 'b1', text: 'one' });
    hub([OWN], 'own-1');
    relay().receive({ type: 'snapshot', session: OWN, events: [], queue: [], state: 'idle' });
    relay().receive({ type: 'text', session: 'own-1', message: 'x', delta: 'not for this screen', final: true });
    expect(model).toMatchObject({ selected: 'plugin:helper', state: 'working', items: [{ text: 'one' }] });
    expect(model.sessions.map(s => s.id)).toEqual(['own-1', 'plugin:helper']);

    expect(await send({ type: 'select', session: 'own-1' })).toBe(true);
    expect(last(relaySent)).toMatchObject({ type: 'select', session: 'own-1' });
    hub([OWN], 'own-1');
    relay().receive({ type: 'snapshot', session: OWN, events: [], queue: [], state: 'idle' });
    expect(model).toMatchObject({ selected: 'own-1', online: true, items: [] });
    a.reply().text('answered meanwhile');
    a.reply().done();
    expect(model.items).toEqual([]);

    // Their own agent leaving does not swap the conversation under them: the hub keeps their choice.
    hub([], 'own-1', false);
    expect(model).toMatchObject({ selected: 'own-1', online: false });
    await send({ type: 'select', session: 'plugin:helper' });
    expect(model.items).toMatchObject([{ text: 'one' }, { text: 'answered meanwhile', final: true }]);
  });

  it('own sessions waiting to be chosen between are not skipped for the plugin agent', () => {
    const a = fakeAgent();
    const { model, hub } = joined([a.agent]);
    hub([OWN, { ...OWN, id: 'own-2' }], null);
    expect(model.selected).toBeNull();
    expect(model.sessions.map(s => s.id)).toEqual(['own-1', 'own-2', 'plugin:helper']);
  });

  it('without plugin agents the relay passes through untouched', () => {
    const { frames, statuses, hub } = joined([]);
    hub([], null);
    expect(frames).toEqual([{ type: 'sessions', sessions: [], selected: null }, { agent: 'gone' }]);
    expect(statuses).toEqual(['waiting']);
  });
});
