import { describe, expect, it } from 'vitest';
import { CHAT_AUTH_MS, CHAT_CLOSE, CHAT_MAX_AGENT_BYTES, CHAT_MAX_BYTES, CHAT_REAUTH_MS, ChatHub, identityHex, type ChatAttachment, type ChatSocket } from './chat';

class Fake implements ChatSocket {
  sent: Record<string, unknown>[] = [];
  closedWith?: number;
  constructor(public a: ChatAttachment | null) {}
  send(d: string) { this.sent.push(JSON.parse(d)); }
  close(code: number) { this.closedWith = code; }
  attachment() { return this.a; }
  setAttachment(a: ChatAttachment) { this.a = a; }
}

// Presence heartbeats are checked separately from conversation traffic.
const traffic = (socket: Fake) => socket.sent.filter(frame => frame.type !== 'viewers');

function setup() {
  let now = 1000;
  const sockets: Fake[] = [];
  const links: Record<string, string[] | null> = { ada: ['agent-ada'], bob: ['agent-bob'], stranger: [], noread: null };
  const hub = new ChatHub({
    verifyAgent: async t => (t.startsWith('tok-') ? { agent: t.slice(4), board: 7n } : null),
    linkedAgents: async t => links[t] ?? null,
    now: () => now,
  }, () => sockets);
  const open = async (auth: string, role: string, session?: unknown) => {
    const s = new Fake({ role: 'pending', board: '7', at: now });
    sockets.push(s);
    await hub.message(s, JSON.stringify({ auth, role, session }));
    return s;
  };
  return { hub, open, links, sockets, tick: (ms: number) => { now += ms; } };
}

describe('ChatHub', () => {
  it('reports only current visible viewers of the selected agent and clears them on leave or revocation', async () => {
    const { hub, open, links, tick } = setup();
    const agent = await open('tok-agent-ada', 'agent');
    const ada = await open('ada', 'person');
    const bob = await open('bob', 'person');
    const viewing = (s: Fake, active: boolean) => hub.message(s, JSON.stringify({ type: 'viewing', active }));
    expect(agent.sent.at(-1)).toEqual({ type: 'viewers', count: 0 });
    await viewing(bob, true);
    expect(agent.sent.at(-1)).toEqual({ type: 'viewers', count: 0 });
    await viewing(ada, true);
    expect(agent.sent.at(-1)).toEqual({ type: 'viewers', count: 1 });
    const second = await open('ada', 'person');
    await viewing(second, true);
    expect(agent.sent.at(-1)).toEqual({ type: 'viewers', count: 2 });
    await viewing(ada, false);
    expect(agent.sent.at(-1)).toEqual({ type: 'viewers', count: 1 });
    hub.closed(second);
    expect(agent.sent.at(-1)).toEqual({ type: 'viewers', count: 0 });
    await viewing(ada, true);
    tick(CHAT_REAUTH_MS);
    links.ada = [];
    await hub.message(ada, JSON.stringify({ auth: 'ada' }));
    expect(agent.sent.at(-1)).toEqual({ type: 'viewers', count: 0 });
  });

  it('moves viewer presence when a person selects another conversation', async () => {
    const { hub, open } = setup();
    const session = (id: string) => ({ id, agent: 'claude-code', name: id, capabilities: { stop: 'step', approvals: true } });
    const one = await open('tok-agent-ada', 'agent', session('one'));
    const two = await open('tok-agent-ada', 'agent', session('two'));
    const ada = await open('ada', 'person');
    await hub.message(ada, JSON.stringify({ type: 'select', session: 'one' }));
    await hub.message(ada, JSON.stringify({ type: 'viewing', session: 'one', active: true }));
    expect(one.sent.at(-1)).toEqual({ type: 'viewers', count: 1 });
    await hub.message(ada, JSON.stringify({ type: 'select', session: 'two' }));
    expect(one.sent.at(-1)).toEqual({ type: 'viewers', count: 0 });
    expect(two.sent.at(-1)).toEqual({ type: 'viewers', count: 1 });
  });
  it('relays between a person and only their own agent', async () => {
    const { hub, open } = setup();
    const agentAda = await open('tok-agent-ada', 'agent');
    const agentBob = await open('tok-agent-bob', 'agent');
    const ada = await open('ada', 'person');
    const bob = await open('bob', 'person');
    agentBob.sent.length = 0;
    agentAda.sent.length = 0;
    bob.sent.length = 0;
    ada.sent.length = 0;

    await hub.message(ada, JSON.stringify({ type: 'send', id: 'm1', text: 'hello' }));
    expect(traffic(agentAda)).toEqual([{ type: 'send', id: 'm1', text: 'hello' }]);
    expect(traffic(agentBob)).toEqual([]);

    await hub.message(agentAda, JSON.stringify({ type: 'text', delta: 'hi' }));
    expect(traffic(ada)).toEqual([{ type: 'text', delta: 'hi', session: 'legacy:agent-ada' }]);
    expect(traffic(bob)).toEqual([]);
  });

  it('refuses a person with no link to an agent, even one who can read the board', async () => {
    const { open } = setup();
    expect((await open('stranger', 'person')).closedWith).toBe(CHAT_CLOSE.auth);
    expect((await open('noread', 'person')).closedWith).toBe(CHAT_CLOSE.auth);
  });

  it('refuses an agent token that is invalid or for another board', async () => {
    const { open } = setup();
    expect((await open('nope', 'agent')).closedWith).toBe(CHAT_CLOSE.auth);
    expect((await open('agent-ada', 'person')).closedWith).toBe(CHAT_CLOSE.auth);
  });

  it('a person cannot speak as an agent, or send anything but chat requests', async () => {
    const { hub, open } = setup();
    const agent = await open('tok-agent-ada', 'agent');
    const ada = await open('ada', 'person');
    agent.sent.length = 0;
    await hub.message(ada, JSON.stringify({ type: 'text', delta: 'forged' }));
    await hub.message(ada, JSON.stringify({ type: 'joined' }));
    await hub.message(ada, JSON.stringify({ type: 'viewers', count: 1 }));
    expect(agent.sent).toEqual([]);
    expect(traffic(agent)).toEqual([]);
  });

  it('tells people when their agent comes and goes, and asks the helper for a snapshot on join', async () => {
    const { hub, open, sockets } = setup();
    const ada = await open('ada', 'person');
    expect(ada.sent).toContainEqual({ agent: 'gone' });
    const agent = await open('tok-agent-ada', 'agent');
    expect(ada.sent).toContainEqual({ agent: 'connected' });
    await open('ada', 'person');
    expect(agent.sent).toContainEqual({ type: 'joined' });
    sockets.splice(sockets.indexOf(agent), 1);
    ada.sent.length = 0;
    hub.closed(agent);
    expect(ada.sent).toContainEqual({ agent: 'gone' });
    expect(ada.sent).toContainEqual({ type: 'sessions', sessions: [], selected: 'legacy:agent-ada' });
  });

  it('the newest helper takes over, and the old one closing does not read as gone', async () => {
    const { hub, open } = setup();
    const first = await open('tok-agent-ada', 'agent');
    const second = await open('tok-agent-ada', 'agent');
    const ada = await open('ada', 'person');
    expect(first.closedWith).toBe(CHAT_CLOSE.replaced);
    expect(second.closedWith).toBeUndefined();
    ada.sent.length = 0;
    hub.closed(first);
    expect(traffic(ada)).toEqual([]);
  });

  it('closes a person whose link was revoked at the next re-check', async () => {
    const { hub, open, links, tick } = setup();
    const ada = await open('ada', 'person');
    tick(CHAT_REAUTH_MS);
    links.ada = [];
    await hub.message(ada, JSON.stringify({ auth: 'ada' }));
    expect(ada.closedWith).toBe(CHAT_CLOSE.auth);
  });

  it('stops relaying to a person who has not re-checked in time', async () => {
    const { hub, open, tick } = setup();
    const agent = await open('tok-agent-ada', 'agent');
    const ada = await open('ada', 'person');
    tick(CHAT_REAUTH_MS * 3 + 1);
    await hub.message(agent, JSON.stringify({ type: 'text', delta: 'late' }));
    expect(ada.closedWith).toBe(CHAT_CLOSE.auth);
    expect(ada.sent).not.toContainEqual({ type: 'text', delta: 'late' });
  });

  it('closes a person who sends an oversized message, and sweeps sockets that never authenticate', async () => {
    const { hub, open, sockets, tick } = setup();
    const ada = await open('ada', 'person');
    await hub.message(ada, 'x'.repeat(CHAT_MAX_BYTES + 1));
    expect(ada.closedWith).toBe(CHAT_CLOSE.abuse);
    const waiting = new Fake({ role: 'pending', board: '7', at: 1000 });
    sockets.push(waiting);
    expect(hub.sweep()).toBe(true);
    tick(CHAT_AUTH_MS);
    hub.sweep();
    expect(waiting.closedWith).toBe(CHAT_CLOSE.auth);
  });
});

describe('ChatHub with a long conversation and an idle tab', () => {
  it('relays a helper frame bigger than a person may send, and strikes only past the agent limit', async () => {
    const { hub, open } = setup();
    const agent = await open('tok-agent-ada', 'agent');
    const ada = await open('ada', 'person');
    ada.sent.length = 0;
    const history = JSON.stringify({ type: 'snapshot', events: 'x'.repeat(CHAT_MAX_BYTES * 3) });
    await hub.message(agent, history);
    expect(ada.sent).toHaveLength(1);
    await hub.message(agent, 'x'.repeat(CHAT_MAX_AGENT_BYTES + 1));
    expect(ada.sent).toHaveLength(1);
    expect((agent.a as { strikes: number }).strikes).toBe(1);
    expect(agent.closedWith).toBeUndefined();
  });

  it('an idle tab hears its agent connect, then re-checks and asks for the talk with sync', async () => {
    const { hub, open, tick } = setup();
    const ada = await open('ada', 'person');
    tick(CHAT_REAUTH_MS * 10);
    const agent = await open('tok-agent-ada', 'agent');
    expect(ada.closedWith).toBeUndefined();
    expect(ada.sent).toContainEqual({ agent: 'connected' });
    expect(agent.sent).not.toContainEqual({ type: 'joined' });
    await hub.message(ada, JSON.stringify({ auth: 'ada', sync: true }));
    expect(agent.sent).toContainEqual({ type: 'joined' });
    agent.sent.length = 0;
    await hub.message(agent, JSON.stringify({ type: 'text', delta: 'hi' }));
    expect(ada.closedWith).toBeUndefined();
    expect(ada.sent).toContainEqual({ type: 'text', delta: 'hi', session: 'legacy:agent-ada' });
  });

  it('sync is answered even just after a check, and a plain re-check asks for nothing', async () => {
    const { hub, open, tick } = setup();
    const agent = await open('tok-agent-ada', 'agent');
    const ada = await open('ada', 'person');
    agent.sent.length = 0;
    await hub.message(ada, JSON.stringify({ auth: 'ada', sync: true }));
    expect(traffic(agent)).toEqual([{ type: 'joined' }]);
    agent.sent.length = 0;
    tick(CHAT_REAUTH_MS);
    await hub.message(ada, JSON.stringify({ auth: 'ada' }));
    expect(traffic(agent)).toEqual([]);
  });
});

describe('identityHex', () => {
  it('reads an identity from the shapes the database returns', () => {
    const hex = 'ab'.repeat(32);
    expect(identityHex(`0x${hex}`)).toBe(hex);
    expect(identityHex([`0x${hex}`])).toBe(hex);
    expect(identityHex({ __identity__: `0x${hex}` })).toBe(hex);
    expect(identityHex('short')).toBeUndefined();
  });
});

const thread = (id: string) => ({ id, agent: 'codex', name: id, capabilities: { stop: 'interrupt' as const, approvals: true } });

describe('conversation isolation', () => {
  it('requires a choice when multiple linked agents are already online, then routes every command to only that session', async () => {
    const { hub, open, links } = setup();
    links.ada = ['agent-ada', 'agent-bob'];
    const first = await open('tok-agent-ada', 'agent', thread('first'));
    const second = await open('tok-agent-bob', 'agent', thread('second'));
    const person = await open('ada', 'person');
    expect(person.sent).toContainEqual({ type: 'sessions', sessions: [thread('first'), thread('second')], selected: null });
    first.sent.length = second.sent.length = 0;
    await hub.message(person, JSON.stringify({ type: 'send', text: 'no selection' }));
    expect(traffic(first)).toEqual([]);
    expect(traffic(second)).toEqual([]);
    await hub.message(person, JSON.stringify({ type: 'select', session: 'second' }));
    expect(traffic(second)).toEqual([{ type: 'joined' }]);
    second.sent.length = 0;
    for (const type of ['send', 'receipt', 'delete', 'stop', 'resume', 'approval']) {
      await hub.message(person, JSON.stringify({ type, id: 'request', decision: 'accept' }));
    }
    expect(traffic(first)).toEqual([]);
    expect(second.sent.map(m => m.type)).toEqual(['send', 'receipt', 'delete', 'stop', 'resume', 'approval']);
    person.sent.length = 0;
    await hub.message(first, JSON.stringify({ type: 'snapshot', secret: true }));
    await hub.message(second, JSON.stringify({ type: 'text', delta: 'selected' }));
    expect(traffic(person)).toEqual([{ type: 'text', delta: 'selected', session: 'second' }]);
    await hub.message(person, JSON.stringify({ type: 'send', session: 'first', text: 'stale' }));
    expect(traffic(first)).toEqual([]);
    expect(second.sent).toHaveLength(6);
  });

  it('keeps two conversations of one identity and replaces only the matching conversation', async () => {
    const { hub, open } = setup();
    const first = await open('tok-agent-ada', 'agent', thread('first'));
    const second = await open('tok-agent-ada', 'agent', thread('second'));
    expect(first.closedWith).toBeUndefined();
    const replacement = await open('tok-agent-ada', 'agent', thread('first'));
    expect(first.closedWith).toBe(CHAT_CLOSE.replaced);
    expect(second.closedWith).toBeUndefined();
    const person = await open('ada', 'person');
    await hub.message(person, JSON.stringify({ type: 'select', session: 'first' }));
    person.sent.length = 0;
    await hub.message(first, JSON.stringify({ type: 'text', delta: 'old' }));
    hub.closed(first);
    expect(traffic(person)).toEqual([]);
    await hub.message(replacement, JSON.stringify({ type: 'text', delta: 'new' }));
    expect(traffic(person)).toEqual([{ type: 'text', delta: 'new', session: 'first' }]);
  });

  it('keeps a disconnected selection and will not let another identity inherit it', async () => {
    const { hub, open, links } = setup();
    links.ada = ['agent-ada', 'agent-bob'];
    const first = await open('tok-agent-ada', 'agent', thread('first'));
    const person = await open('ada', 'person');
    const collision = await open('tok-agent-bob', 'agent', thread('first'));
    expect(collision.closedWith).toBe(CHAT_CLOSE.auth);
    expect(first.closedWith).toBeUndefined();
    const second = await open('tok-agent-bob', 'agent', thread('second'));
    hub.closed(first);
    expect(person.sent.at(-2)).toMatchObject({ selected: 'first', sessions: [thread('second')] });
    second.sent.length = 0;
    await hub.message(person, JSON.stringify({ type: 'send', text: 'offline' }));
    expect(traffic(second)).toEqual([]);
    const impostor = await open('tok-agent-bob', 'agent', thread('first'));
    impostor.sent.length = 0;
    await hub.message(person, JSON.stringify({ type: 'send', text: 'still offline' }));
    expect(traffic(impostor)).toEqual([]);
    person.sent.length = 0;
    await hub.message(impostor, JSON.stringify({ type: 'text', delta: 'wrong identity' }));
    expect(traffic(person)).toEqual([]);
  });

  it('never selects an unlinked session or forwards malformed approval decisions', async () => {
    const { hub, open } = setup();
    const own = await open('tok-agent-ada', 'agent', thread('own'));
    const other = await open('tok-agent-bob', 'agent', thread('other'));
    const person = await open('ada', 'person');
    own.sent.length = other.sent.length = 0;
    await hub.message(person, JSON.stringify({ type: 'select', session: 'other' }));
    for (const command of [{ id: 'x', decision: 'execute' }, { id: '', decision: 'accept' }, { id: 'x'.repeat(257), decision: 'accept' }]) {
      await hub.message(person, JSON.stringify({ type: 'approval', ...command }));
    }
    expect(traffic(own)).toEqual([]);
    expect(traffic(other)).toEqual([]);
  });

  it('validates descriptors and counts UTF-8 bytes before authentication and messages', async () => {
    const { hub, open, sockets } = setup();
    for (const session of [null, {}, { ...thread('x'), id: 'é'.repeat(129) }, { ...thread('x'), capabilities: { stop: 'kill', approvals: true } }]) {
      expect((await open('tok-agent-ada', 'agent', session)).closedWith).toBe(CHAT_CLOSE.auth);
    }
    const pending = new Fake({ role: 'pending', board: '7', at: 1000 });
    sockets.push(pending);
    await hub.message(pending, 'é'.repeat(CHAT_MAX_BYTES / 2 + 1));
    expect(pending.closedWith).toBe(CHAT_CLOSE.abuse);
    const person = await open('ada', 'person');
    await hub.message(person, 'é'.repeat(CHAT_MAX_BYTES / 2 + 1));
    expect(person.closedWith).toBe(CHAT_CLOSE.abuse);
  });

  it('rechecks only the chosen session and does not switch when its permission is revoked', async () => {
    const { hub, open, links, tick } = setup();
    links.ada = ['agent-ada', 'agent-bob'];
    const own = await open('tok-agent-ada', 'agent', thread('own'));
    const person = await open('ada', 'person');
    const other = await open('tok-agent-bob', 'agent', thread('other'));
    own.sent.length = other.sent.length = 0;
    tick(CHAT_REAUTH_MS);
    links.ada = ['agent-bob'];
    await hub.message(person, JSON.stringify({ auth: 'ada', sync: true }));
    await hub.message(person, JSON.stringify({ type: 'stop' }));
    person.sent.length = 0;
    await hub.message(own, JSON.stringify({ type: 'snapshot', secret: true }));
    expect(traffic(own)).toEqual([]);
    expect(traffic(other)).toEqual([]);
    expect(traffic(person)).toEqual([]);
  });
});

it('ignores late authentication after disconnect or its deadline', async () => {
  let resolve!: (claims: { agent: string; board: bigint }) => void;
  let now = 1000;
  const socket = new Fake({ role: 'pending', board: '7', at: now });
  const hub = new ChatHub({ verifyAgent: () => new Promise(r => { resolve = r; }), linkedAgents: async () => [], now: () => now }, () => [socket]);
  const pending = hub.message(socket, JSON.stringify({ auth: 'token', role: 'agent', session: thread('late') }));
  now += CHAT_AUTH_MS;
  hub.sweep();
  resolve({ agent: 'agent-ada', board: 7n });
  await pending;
  expect(socket.closedWith).toBe(CHAT_CLOSE.auth);
  expect(traffic(socket)).toEqual([]);
  expect(socket.a?.role).toBe('pending');
});

it('does not relay or join with stale permissions while a recheck is pending or after disconnect', async () => {
  let resolve!: (agents: string[]) => void;
  const agent = new Fake({ role: 'agent', board: '7', at: 0, agent: 'agent-ada', strikes: 0, session: thread('own') });
  const person = new Fake({ role: 'person', board: '7', at: 0, agents: ['agent-ada'], checked: 0, selected: { id: 'own', agent: 'agent-ada' } });
  const hub = new ChatHub({ verifyAgent: async () => null, linkedAgents: () => new Promise(r => { resolve = r; }), now: () => CHAT_REAUTH_MS }, () => [agent, person]);
  const pending = hub.message(person, JSON.stringify({ auth: 'token', sync: true }));
  await hub.message(person, JSON.stringify({ type: 'send', text: 'stale' }));
  await hub.message(agent, JSON.stringify({ type: 'text', delta: 'private' }));
  hub.closed(person);
  resolve(['agent-ada']);
  await pending;
  expect(traffic(agent)).toEqual([]);
  expect(traffic(person)).toEqual([]);
});


it('tags legacy snapshots and prevents helpers from forging selection metadata', async () => {
  const { hub, open } = setup();
  const agent = await open('tok-agent-ada', 'agent');
  const person = await open('ada', 'person');
  person.sent.length = 0;
  await hub.message(agent, JSON.stringify({ type: 'sessions', selected: 'forged', sessions: [] }));
  await hub.message(agent, JSON.stringify({ type: 'snapshot', events: [], session: thread('forged') }));
  expect(traffic(person)).toEqual([{ type: 'snapshot', events: [], session: { id: 'legacy:agent-ada', agent: 'agent', name: 'Agent conversation', capabilities: { stop: 'step', approvals: false } } }]);
});


it('refreshes unchanged access without rebuilding history, while replacement still requests a snapshot', async () => {
  const { hub, open, tick } = setup();
  const first = await open('tok-agent-ada', 'agent', thread('thread'));
  const person = await open('ada', 'person');
  first.sent.length = person.sent.length = 0;
  tick(CHAT_REAUTH_MS);
  await hub.message(person, JSON.stringify({ auth: 'ada' }));
  expect(traffic(person)).toEqual([]);
  expect(traffic(first)).toEqual([]);
  const replacement = await open('tok-agent-ada', 'agent', thread('thread'));
  expect(person.sent).toContainEqual({ agent: 'connected' });
  replacement.sent.length = 0;
  await hub.message(person, JSON.stringify({ auth: 'ada', sync: true }));
  expect(traffic(replacement)).toEqual([{ type: 'joined' }]);
});
