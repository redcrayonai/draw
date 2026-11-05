import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDLE_REAUTH_MS, appendBlocks, appendInline, applyFrame, chatUrl, emptyChat, mountAgentChat, revealStep, type AgentElsewhere } from './agent-chat';

describe('applyFrame', () => {
  it('builds a conversation: message, streamed text, work steps', () => {
    const m = emptyChat();
    applyFrame(m, { agent: 'connected' });
    applyFrame(m, { type: 'delivered', id: 'a', text: 'why?', context: 'edge X' });
    applyFrame(m, { type: 'text', message: 'm1', delta: 'Because\n', final: false });
    applyFrame(m, { type: 'text', message: 'm1', delta: 'of this.', final: true });
    applyFrame(m, { type: 'tool', id: 'w1', phase: 'start', summary: 'Edited a.ts' });
    applyFrame(m, { type: 'tool', id: 'w2', phase: 'start', summary: 'Board: delete edge' });
    applyFrame(m, { type: 'tool', id: 'w1', phase: 'done' });
    expect(m.online).toBe(true);
    expect(m.items).toEqual([
      { kind: 'user', id: 'a', text: 'why?', context: 'edge X' },
      { kind: 'text', message: 'm1', text: 'Because\nof this.', final: true },
      { kind: 'work', steps: [{ id: 'w1', summary: 'Edited a.ts', done: true }, { id: 'w2', summary: 'Board: delete edge', done: false }] },
    ]);
  });

  it('a snapshot replaces what the page held, so reopening restores the conversation', () => {
    const m = emptyChat();
    applyFrame(m, { type: 'notice', text: 'old' });
    applyFrame(m, {
      type: 'snapshot',
      state: 'working',
      paused: true,
      queue: [{ id: 'q', text: 'next' }],
      events: [{ type: 'user', id: 't1', text: 'typed', origin: 'terminal' }, { type: 'text', message: 'm', delta: 'hi', final: true }],
    });
    expect(m.items).toEqual([
      { kind: 'user', id: 't1', text: 'typed', terminal: true },
      { kind: 'text', message: 'm', text: 'hi', final: true },
    ]);
    expect(m).toMatchObject({ state: 'working', paused: true, online: true, queue: [{ id: 'q', text: 'next' }] });
  });

  it('follows the queue, the agent state, and the agent leaving', () => {
    const m = emptyChat();
    applyFrame(m, { type: 'queue', queue: [{ id: 'a', text: 'x' }], paused: false });
    applyFrame(m, { type: 'state', state: 'stopping' });
    expect(m).toMatchObject({ state: 'stopping', queue: [{ id: 'a', text: 'x' }] });
    applyFrame(m, { agent: 'connected' });
    applyFrame(m, { agent: 'gone' });
    expect(m.online).toBe(false);
  });
});

describe('revealStep', () => {
  it('always moves forward, faster with a backlog, and never past the text', () => {
    expect(revealStep(0, 5)).toBe(1);
    expect(revealStep(0, 180)).toBe(10);
    expect(revealStep(99, 100)).toBe(100);
    expect(revealStep(100, 100)).toBe(100);
  });
});

describe('chatUrl', () => {
  it('is the board\'s channel on the agent server\'s host', () => {
    expect(chatUrl('https://mcp.example.test/mcp', 7n)).toBe('wss://mcp.example.test/chat/7');
    expect(chatUrl('http://localhost:8788/mcp?x=1', 7n)).toBe('ws://localhost:8788/chat/7');
  });
});

describe('appendInline', () => {
  it('renders code and bold as elements and everything else as text', () => {
    const p = document.createElement('p');
    appendInline(p, '**Web app:** see `a.ts` <img src=x>');
    expect(p.querySelector('strong')?.textContent).toBe('Web app:');
    expect(p.querySelector('code')?.textContent).toBe('a.ts');
    expect(p.querySelector('img')).toBeNull();
    expect(p.textContent).toBe('Web app: see a.ts <img src=x>');
  });
});

describe('appendBlocks', () => {
  const html = (text: string) => {
    const div = document.createElement('div');
    appendBlocks(div, text);
    return div;
  };

  it('renders paragraphs, lists, headings and fenced code', () => {
    const div = html('Done:\n\n- **a.ts:** one\n- b.ts\n\n1. first\n\n## Next\n```ts\nconst x = 1;\n```\nEnd');
    expect([...div.children].map(c => c.tagName)).toEqual(['P', 'UL', 'OL', 'P', 'PRE', 'P']);
    expect(div.querySelector('ul strong')?.textContent).toBe('a.ts:');
    expect(div.querySelector('pre code')?.textContent).toBe('const x = 1;');
    expect(div.querySelector('.ac-heading')?.textContent).toBe('Next');
  });

  it('a fence still streaming is already code, and nothing becomes markup', () => {
    const div = html('```js\nalert(1)\n<img src=x>');
    expect(div.querySelector('pre code')?.textContent).toBe('alert(1)\n<img src=x>');
    expect(div.querySelector('img')).toBeNull();
  });
});

describe('mountAgentChat', () => {
  class FakeSocket {
    static all: FakeSocket[] = [];
    readyState = 1;
    sent: Record<string, unknown>[] = [];
    handlers: Record<string, (ev: any) => void> = {};
    constructor() { FakeSocket.all.push(this); }
    addEventListener(type: string, fn: (ev: any) => void) { this.handlers[type] = fn; }
    send(data: string) { this.sent.push(JSON.parse(data)); }
    close() {}
    frame(f: object) { this.handlers.message({ data: JSON.stringify(f) }); }
  }
  const flush = () => vi.advanceTimersByTimeAsync(0);
  const panel = () => document.getElementById('agent-chat')!;

  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.all = [];
    sessionStorage.clear();
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: !q.includes('reduced-motion') }));
  });
  afterEach(() => {
    panel()?.remove();
    document.documentElement.removeAttribute('data-agent-chat');
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function mount(elsewhere: AgentElsewhere | null = null) {
    const button = document.createElement('button');
    const chat = mountAgentChat(button, { url: () => 'wss://x/chat/1', token: async () => 'tok', selection: () => '', agentElsewhere: () => elsewhere });
    chat.setAvailable(true);
    await flush();
    const socket = FakeSocket.all[0];
    socket.handlers.open({});
    socket.frame({ ok: true, role: 'person' });
    return { chat, socket, button };
  }

  it('an agent drawing elsewhere calls the panel over; an old session waits until the person opens it', async () => {
    const old = await mount({ board: 'old', href: '#b=old', live: false });
    old.socket.frame({ agent: 'gone' });
    old.chat.refresh();
    expect(panel().hidden).toBe(true);
    old.button.click();
    expect(panel().textContent).toContain('Open old');
    panel().remove();

    FakeSocket.all = [];
    const live = await mount({ board: 'now', href: '#b=now', live: true });
    live.socket.frame({ agent: 'gone' });
    live.chat.refresh();
    expect(panel().hidden).toBe(false);
    expect(panel().textContent).toContain('Your agent is on now');
  });

  it('retries a refusal with a fresh connection, and says why only once it keeps happening', async () => {
    const { button, socket } = await mount();
    socket.frame({ agent: 'gone' });
    button.click();
    socket.handlers.close({ code: 4001, reason: 'You can no longer chat.' });
    expect(panel().textContent).not.toContain('You can no longer chat.');
    await vi.advanceTimersByTimeAsync(2000);
    expect(FakeSocket.all).toHaveLength(2);
    FakeSocket.all[1].handlers.close({ code: 4001, reason: 'You can no longer chat.' });
    await vi.advanceTimersByTimeAsync(4000);
    expect(FakeSocket.all).toHaveLength(3);
    FakeSocket.all[2].handlers.close({ code: 4001, reason: 'You can no longer chat.' });
    expect(panel().textContent).toContain('You can no longer chat.');
  });

  it('a token that fails to refresh is retried, not the end of the chat', async () => {
    const button = document.createElement('button');
    let token: string | null = null;
    const chat = mountAgentChat(button, { url: () => 'wss://x/chat/1', token: async () => token, selection: () => '' });
    chat.setAvailable(true);
    await flush();
    expect(FakeSocket.all).toHaveLength(0);
    token = 'tok';
    await vi.advanceTimersByTimeAsync(2000);
    expect(FakeSocket.all).toHaveLength(1);
  });

  it('a pairing link waits for the person: nothing runs until they press Link agent, and Not now runs nothing', async () => {
    const { chat } = await mount();
    const press = (name: string) => [...panel().querySelectorAll('button')].find(b => b.textContent === name)!.click();
    let runs = 0;
    chat.offerPair(async () => { runs++; return 'linked' as const; });
    expect(panel().hidden).toBe(false);
    expect(panel().textContent).toContain('Continue only if you started this agent yourself');
    expect(runs).toBe(0);
    press('Not now');
    expect(runs).toBe(0);
    expect(panel().textContent).not.toContain('Link this agent');

    chat.offerPair(async () => { runs++; return 'linked' as const; });
    press('Link agent');
    await flush();
    expect(runs).toBe(1);
    expect(panel().textContent).not.toContain('Link this agent');

    chat.offerPair(async () => { throw new Error('link code is invalid or expired'); });
    press('Link agent');
    await flush();
    expect(panel().textContent).toContain('That link did not work');

    chat.offerPair(async () => 'already' as const);
    press('Link agent');
    await flush();
    expect(panel().textContent).toContain('Your agent is already linked');
  });

  it('history from a snapshot shows at once; only live text is revealed as it streams', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: !q.includes('reduced-motion') }));
    vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => setTimeout(() => fn(0), 16));
    const { socket, button } = await mount();
    socket.frame({ agent: 'connected' });
    if (panel().hidden) button.click();
    const long = 'word '.repeat(200);
    socket.frame({ type: 'snapshot', state: 'idle', paused: false, queue: [], events: [{ type: 'text', message: 'old', delta: `${long}end of old`, final: true }] });
    await vi.advanceTimersByTimeAsync(20);
    expect(panel().textContent).toContain('end of old');
    socket.frame({ type: 'text', message: 'new', delta: `${long}end of new`, final: true });
    await vi.advanceTimersByTimeAsync(20);
    expect(panel().textContent).not.toContain('end of new');
    await vi.advanceTimersByTimeAsync(3000);
    expect(panel().textContent).toContain('end of new');
  });

  it('re-checks access rarely with no agent, often with one, and asks for the talk when one arrives', async () => {
    const { socket } = await mount();
    socket.frame({ agent: 'gone' });
    socket.sent.length = 0;
    await vi.advanceTimersByTimeAsync(IDLE_REAUTH_MS - 1000);
    expect(socket.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(socket.sent).toEqual([{ auth: 'tok' }]);

    socket.sent.length = 0;
    socket.frame({ agent: 'connected' });
    await flush();
    expect(socket.sent).toEqual([{ auth: 'tok', sync: true }]);
    socket.sent.length = 0;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(socket.sent).toEqual([{ auth: 'tok' }]);
  });
});
