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

function setup() {
  let now = 1000;
  const sockets: Fake[] = [];
  const links: Record<string, string[] | null> = { ada: ['agent-ada'], bob: ['agent-bob'], stranger: [], noread: null };
  const hub = new ChatHub({
    verifyAgent: async t => (t.startsWith('tok-') ? { agent: t.slice(4), board: 7n } : null),
    linkedAgents: async t => links[t] ?? null,
    now: () => now,
  }, () => sockets);
  const open = async (auth: string, role: string) => {
    const s = new Fake({ role: 'pending', board: '7', at: now });
    sockets.push(s);
    await hub.message(s, JSON.stringify({ auth, role }));
    return s;
  };
  return { hub, open, links, sockets, tick: (ms: number) => { now += ms; } };
}

describe('ChatHub', () => {
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
    expect(agentAda.sent).toEqual([{ type: 'send', id: 'm1', text: 'hello' }]);
    expect(agentBob.sent).toEqual([]);

    await hub.message(agentAda, JSON.stringify({ type: 'text', delta: 'hi' }));
    expect(ada.sent).toEqual([{ type: 'text', delta: 'hi' }]);
    expect(bob.sent).toEqual([]);
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
    expect(agent.sent).toEqual([]);
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
    expect(ada.sent).toEqual([{ agent: 'gone' }]);
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
    expect(ada.sent).toEqual([]);
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
    expect(ada.sent).toContainEqual({ type: 'text', delta: 'hi' });
  });

  it('sync is answered even just after a check, and a plain re-check asks for nothing', async () => {
    const { hub, open, tick } = setup();
    const agent = await open('tok-agent-ada', 'agent');
    const ada = await open('ada', 'person');
    agent.sent.length = 0;
    await hub.message(ada, JSON.stringify({ auth: 'ada', sync: true }));
    expect(agent.sent).toEqual([{ type: 'joined' }]);
    agent.sent.length = 0;
    tick(CHAT_REAUTH_MS);
    await hub.message(ada, JSON.stringify({ auth: 'ada' }));
    expect(agent.sent).toEqual([]);
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
