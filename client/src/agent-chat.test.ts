import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDLE_REAUTH_MS, appendBlocks, appendInline, applyFrame, chatUrl, emptyChat, mountAgentChat, revealStep, type AgentElsewhere } from './agent-chat';

describe('applyFrame', () => {
  it('builds a conversation: message, streamed text, work steps', () => {
    const m = emptyChat();
    applyFrame(m, { agent: 'connected' });
    expect(m.online).toBe(false);
    applyFrame(m, { type: 'snapshot', events: [], queue: [], state: 'idle' });
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

  it('restores completed adapter tool records without requiring a live start event', () => {
    const m = emptyChat();
    applyFrame(m, { type: 'snapshot', state: 'idle', events: [
      { type: 'tool', id: 'tool-1', phase: 'done', summary: 'Changed a file' },
      { type: 'tool', id: 'tool-2', phase: 'done', summary: 'Ran a command' },
    ] });
    expect(m.items).toEqual([{ kind: 'work', steps: [
      { id: 'tool-1', summary: 'Changed a file', done: true },
      { id: 'tool-2', summary: 'Ran a command', done: true },
    ] }]);
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

  it('hands known fences and node names to the board, and keeps the rest as text', () => {
    const div = document.createElement('div');
    const seen: [string, string, string, boolean][] = [];
    const clicked: string[] = [];
    appendBlocks(div, 'See `Orders` and `a.ts`.\n- **`Orders` (412 ms):** slow\n```chart bars p95 by hop\nhop,p95\nA,1\n```\n```ts\nx\n```\n```choices\nYes', undefined, {
      node: name => (name === 'Orders' ? () => clicked.push(name) : null),
      fence: (lang, info, body, closed) => {
        seen.push([lang, info, body, closed]);
        return lang === 'ts' ? null : Object.assign(document.createElement('figure'), { textContent: lang });
      },
    });
    expect(seen).toEqual([['chart', 'bars p95 by hop', 'hop,p95\nA,1', true], ['ts', '', 'x', true], ['choices', '', 'Yes', false]]);
    expect([...div.children].map(c => c.tagName)).toEqual(['P', 'UL', 'FIGURE', 'PRE', 'FIGURE']);
    for (const chip of div.querySelectorAll<HTMLButtonElement>('button.ac-node')) chip.click();
    expect(clicked).toEqual(['Orders', 'Orders']);
    expect(div.querySelector('li strong')?.textContent).toBe('Orders (412 ms):');
    expect(div.querySelector('p code')?.textContent).toBe('a.ts');
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
    constructor(readonly url: string) { FakeSocket.all.push(this); }
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
    localStorage.clear();
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: !q.includes('reduced-motion') }));
  });
  afterEach(() => {
    location.hash = '';
    panel()?.remove();
    document.querySelectorAll('#chat-draw').forEach(node => node.remove());
    document.documentElement.removeAttribute('data-agent-chat');
    document.documentElement.removeAttribute('data-agent-drawing');
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

  it('an agent drawing elsewhere calls the panel over; with no agent anywhere the panel waits, then hands over a prompt for this board', async () => {
    location.hash = '#b=checkout';
    const none = await mount();
    none.socket.frame({ agent: 'gone' });
    none.chat.refresh();
    expect(panel().hidden).toBe(true);
    none.button.click();
    expect(panel().textContent).toContain('No agent connected');
    expect(panel().querySelector('.ac-empty a')).toBeNull();
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    [...panel().querySelectorAll('button')].find(b => b.textContent === 'Copy prompt for agent')!.click();
    expect(writeText).toHaveBeenCalledWith(`Reconnect board chat on this board: ${location.href}`);
    expect(location.href).toContain('#b=checkout');
    panel().remove();

    // A share link is a secret: no prompt carries it.
    FakeSocket.all = [];
    location.hash = '#s=secret-share-token';
    const shared = await mount();
    shared.socket.frame({ agent: 'gone' });
    shared.button.click();
    expect(panel().textContent).toContain('Ask your agent to reconnect board chat');
    expect([...panel().querySelectorAll('button')].some(b => b.textContent === 'Copy prompt for agent')).toBe(false);
    panel().remove();
    location.hash = '';

    FakeSocket.all = [];
    const live = await mount({ board: 'now', href: '#b=now' });
    live.socket.frame({ agent: 'gone' });
    live.chat.refresh();
    expect(panel().hidden).toBe(false);
    expect(panel().textContent).toContain('Your agent is on now');
  });

  it('asks the person to reconnect an absent agent while keeping the draft and history', async () => {
    const { button, socket } = await mount();
    button.click();
    socket.frame({ type: 'snapshot', events: [{ type: 'user', id: 'old', text: 'Earlier conversation' }], queue: [], state: 'idle' });
    const input = panel().querySelector('textarea')!;
    input.value = 'Unsent question';
    input.dispatchEvent(new Event('input'));
    socket.frame({ agent: 'gone' });
    expect(panel().textContent).toContain('Waiting for agent');
    expect(panel().textContent).toContain('Ask your agent to reconnect board chat');
    expect(panel().textContent).not.toContain('Reconnecting automatically');
    expect(panel().textContent).toContain('Earlier conversation');
    expect(input.value).toBe('Unsent question');
  });

  it.each(['語'.repeat(30000), 'x'.repeat(32001)])('keeps an oversized message in the composer and explains the refusal', async text => {
    const { button, socket } = await mount();
    button.click();
    socket.frame({ type: 'snapshot', events: [], queue: [], state: 'idle' });
    const input = panel().querySelector('textarea')!;
    input.value = text;
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(input.value).toBe(text);
    expect(socket.sent.some(frame => frame.type === 'send')).toBe(false);
    expect(panel().textContent).toContain('too long to send');
    socket.handlers.close({ code: 4008, reason: 'Rejected oversized message' });
    expect(panel().textContent).toContain('Rejected oversized message');
  });

  it('reports connection changes so review banners can repaint immediately', async () => {
    const changed = vi.fn();
    const chat = mountAgentChat(document.createElement('button'), {
      url: () => 'wss://x/chat/1', token: async () => 'tok', selection: () => '', onlineChanged: changed,
    });
    chat.setAvailable(true);
    await flush();
    const socket = FakeSocket.all[0];
    changed.mockClear();
    socket.frame({ type: 'snapshot', events: [], queue: [], state: 'idle' });
    expect(changed).toHaveBeenCalledOnce();
    socket.frame({ agent: 'gone' });
    expect(changed).toHaveBeenCalledTimes(2);
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

  const session = (id: string, stop: 'step' | 'interrupt' | 'none' = 'interrupt') => ({ id, agent: id, name: `Agent ${id}`, capabilities: { stop, approvals: true } });
  const snapshot = (id = 'one', events: object[] = [], state = 'idle') => ({ type: 'snapshot', session: session(id), events, queue: [], state, paused: false });
  const input = () => panel().querySelector<HTMLTextAreaElement>('textarea')!;
  const sendButton = () => panel().querySelector<HTMLButtonElement>('.ac-send')!;
  const type = (value: string) => {
    input().value = value;
    input().dispatchEvent(new Event('input'));
  };
  const choose = (id: string) => {
    const select = panel().querySelector<HTMLSelectElement>('select')!;
    select.value = id;
    select.dispatchEvent(new Event('change'));
  };

  it('temporarily shows drawing tools, preserves drafts, and returns to chat after sending marks', async () => {
    const { chat, socket, button } = await mount();
    socket.frame(snapshot());
    type('unfinished thought');
    document.getElementById('chat-draw')!.click();
    expect(panel().hidden).toBe(true);
    expect(document.documentElement.hasAttribute('data-agent-drawing')).toBe(true);
    expect(button.getAttribute('aria-label')).toBe('Back to chat');
    socket.frame({ agent: 'gone' });
    expect(chat.prepareMessage('Review this mark')).toBeUndefined();
    expect(panel().hidden).toBe(true);
    expect(button.getAttribute('aria-label')).toBe('Back to chat');
    socket.frame(snapshot());
    expect(panel().hidden).toBe(true);
    expect(chat.prepareMessage('Review this mark')!()).toBe(true);
    expect(panel().hidden).toBe(false);
    expect(document.documentElement.hasAttribute('data-agent-drawing')).toBe(false);
    expect(input().value).toBe('unfinished thought');
    expect(document.activeElement).toBe(input());
    document.getElementById('chat-draw')!.click();
    button.click();
    expect(panel().hidden).toBe(false);
    expect(input().value).toBe('unfinished thought');
  });

  it('records watcher-handled marks in chat without sending another request', async () => {
    const { chat, socket } = await mount();
    socket.frame(snapshot());
    type('keep my draft');
    expect(chat.prepareMessage('I sent 2 red-crayon marks.', 'Red-crayon marks')!(false)).toBe(true);
    expect(socket.sent.filter(m => m.type === 'send')).toEqual([]);
    expect(socket.sent.find(m => m.type === 'receipt')).toMatchObject({ text: 'I sent 2 red-crayon marks.', session: 'one' });
    expect(input().value).toBe('keep my draft');
  });

  it('reports chat visibility and re-announces it after reconnecting', async () => {
    const { socket, button } = await mount();
    socket.frame(snapshot());
    expect(socket.sent[socket.sent.length - 1]).toMatchObject({ type: 'viewing', active: true });
    button.click();
    expect(socket.sent[socket.sent.length - 1]).toMatchObject({ type: 'viewing', active: false });
    socket.frame({ agent: 'gone' });
    socket.frame(snapshot());
    expect(socket.sent[socket.sent.length - 1]).toMatchObject({ type: 'viewing', active: false });
    button.click();
    expect(socket.sent[socket.sent.length - 1]).toMatchObject({ type: 'viewing', active: true });
  });

  it('sends a saved board action once to its captured conversation without changing the composer', async () => {
    const { chat, socket } = await mount();
    expect(chat.prepareMessage('marks')).toBeUndefined();
    socket.frame(snapshot());
    type('my unfinished draft');
    const forward = chat.prepareMessage('Review my marks', 'Red-crayon marks')!;
    expect(socket.sent.some(m => m.type === 'send')).toBe(false);
    expect(forward()).toBe(true);
    expect(forward()).toBe(false);
    expect(socket.sent.filter(m => m.type === 'send')).toEqual([
      { type: 'send', session: 'one', id: expect.any(String), text: 'Review my marks', context: 'Red-crayon marks' },
    ]);
    expect(input().value).toBe('my unfinished draft');
  });

  it('does not forward saved actions into a different session, board, or disconnected chat', async () => {
    const { chat, socket, button } = await mount();
    socket.frame({ type: 'sessions', sessions: [session('one'), session('two')], selected: 'one' });
    socket.frame(snapshot());
    const changedSession = chat.prepareMessage('marks')!;
    choose('two');
    socket.frame(snapshot('two'));
    expect(changedSession()).toBe(false);
    const disconnected = chat.prepareMessage('marks')!;
    socket.frame({ agent: 'gone' });
    expect(disconnected()).toBe(false);
    socket.frame(snapshot('two'));
    button.click();
    expect(chat.prepareMessage('marks')).toBeUndefined();
    button.click();
    const changedBoard = chat.prepareMessage('marks')!;
    chat.switchBoard();
    expect(changedBoard()).toBe(false);
    expect(socket.sent.some(m => m.type === 'send')).toBe(false);
  });

  it('waits for a snapshot before sending and preserves a draft when the socket fails', async () => {
    const { socket, button } = await mount();
    button.click();
    socket.frame({ agent: 'connected' });
    type('keep this');
    expect(panel().textContent).toContain('Syncing conversation');
    expect(sendButton().disabled).toBe(true);
    socket.frame(snapshot());
    expect(sendButton().disabled).toBe(false);
    socket.send = () => { throw new Error('network lost'); };
    sendButton().click();
    expect(input().value).toBe('keep this');
    expect(panel().textContent).toContain('Reconnecting');
    expect(sendButton().disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(FakeSocket.all).toHaveLength(2);
  });

  it('isolates session histories and drafts, scopes sends, and switches stop capabilities', async () => {
    const { socket } = await mount();
    const sessions = [session('one'), session('two', 'none')];
    socket.frame({ type: 'sessions', sessions, selected: 'one' });
    socket.frame(snapshot('one', [{ type: 'user', id: 'first', text: 'First conversation' }]));
    type('first draft');
    choose('two');
    expect(socket.sent[socket.sent.length - 1]).toEqual({ type: 'select', session: 'two' });
    expect(panel().textContent).not.toContain('First conversation');
    expect(input().value).toBe('');
    expect(sendButton().disabled).toBe(true);
    socket.frame(snapshot('one', [{ type: 'user', id: 'old', text: 'Stale history' }]));
    expect(panel().textContent).not.toContain('Stale history');
    socket.frame({ ...snapshot('two', [], 'working'), session: sessions[1] });
    expect(panel().querySelector<HTMLButtonElement>('.ac-stop')!.hidden).toBe(true);
    type('second draft');
    choose('one');
    expect(input().value).toBe('first draft');
    socket.frame(snapshot('one', [], 'working'));
    const stop = panel().querySelector<HTMLButtonElement>('.ac-stop')!;
    stop.click();
    expect(stop.disabled).toBe(true);
    expect(stop.textContent).toBe('Stopping');
    expect(panel().textContent).toContain('waiting for confirmation');
    expect(socket.sent[socket.sent.length - 1]).toEqual({ type: 'stop', session: 'one' });
    socket.frame({ type: 'state', state: 'stopped' });
    sendButton().click();
    expect(socket.sent[socket.sent.length - 1]).toMatchObject({ type: 'send', session: 'one', text: 'first draft' });
    choose('two');
    expect(input().value).toBe('second draft');
  });

  it('distinguishes concurrent conversations from the same agent', async () => {
    const { socket } = await mount();
    socket.frame({ type: 'sessions', sessions: [session('one'), session('two')].map(s => ({ ...s, name: 'Codex' })), selected: null });
    const choices = [...panel().querySelectorAll('select option')].map(option => option.textContent);
    expect(choices).toEqual(['Choose a session', 'Codex · one', 'Codex · two']);
  });

  it('keeps approvals pending until the adapter confirms them', async () => {
    const { socket } = await mount();
    socket.frame(snapshot());
    socket.frame({ type: 'approval', id: 'approval-1', summary: 'Change this file?', status: 'pending' });
    const allow = [...panel().querySelectorAll('button')].find(b => b.textContent === 'Allow')!;
    allow.click();
    expect(socket.sent[socket.sent.length - 1]).toEqual({ type: 'approval', session: 'one', id: 'approval-1', decision: 'accept' });
    expect(panel().textContent).toContain('Waiting for confirmation');
    expect(panel().querySelectorAll('.ac-approval button:disabled')).toHaveLength(2);
    socket.frame({ type: 'approval', id: 'approval-1', summary: 'Change this file?', status: 'pending' });
    expect(panel().querySelectorAll('.ac-approval button:disabled')).toHaveLength(0);
    socket.frame({ type: 'approval', id: 'approval-1', summary: 'Change this file?', status: 'resolved' });
    expect(panel().textContent).toContain('Approval resolved');
    expect(panel().querySelectorAll('.ac-approval button')).toHaveLength(0);
  });

  it('preserves board drafts and attachments and ignores callbacks from the previous board', async () => {
    let url = 'wss://x/chat/1';
    let selection = 'node one';
    const button = document.createElement('button');
    const chat = mountAgentChat(button, { url: () => url, token: async () => 'tok', selection: () => selection });
    chat.setAvailable(true);
    await flush();
    const first = FakeSocket.all[0];
    first.frame(snapshot());
    type('board one draft');
    chat.close();
    first.frame({ type: 'text', message: 'unread', delta: 'new reply', final: true });
    expect(button.dataset.unread).toBe('true');
    chat.switchBoard();
    expect(button.dataset.unread).toBe('false');
    url = 'wss://x/chat/2';
    selection = 'node two';
    await flush();
    const second = FakeSocket.all[1];
    second.frame(snapshot('two'));
    expect(input().value).toBe('');
    first.frame(snapshot('one', [{ type: 'user', id: 'leak', text: 'old board history' }]));
    expect(panel().textContent).not.toContain('old board history');
    type('board two draft');
    url = 'wss://x/chat/1';
    selection = 'different node';
    chat.switchBoard();
    await flush();
    FakeSocket.all[2].frame(snapshot());
    if (panel().hidden) button.click();
    expect(input().value).toBe('board one draft');
    expect(panel().querySelector('.ac-chips')?.textContent).toBe('node one');
    sendButton().click();
    expect(FakeSocket.all[2].sent[FakeSocket.all[2].sent.length - 1]).toMatchObject({ type: 'send', text: 'board one draft', context: 'node one', session: 'one' });
    type('new question');
    selection = 'newly selected node';
    chat.refresh();
    sendButton().click();
    expect(FakeSocket.all[2].sent[FakeSocket.all[2].sent.length - 1]).toMatchObject({ context: 'newly selected node' });
  });

  it('ignores an old board token result and catches token refresh rejections', async () => {
    let resolve!: (token: string) => void;
    let url = 'wss://x/chat/1';
    const token = vi.fn().mockImplementationOnce(() => new Promise<string>(r => { resolve = r; }))
      .mockRejectedValueOnce(new Error('offline')).mockResolvedValue('tok');
    const chat = mountAgentChat(document.createElement('button'), { url: () => url, token, selection: () => '' });
    chat.setAvailable(true);
    url = 'wss://x/chat/2';
    chat.switchBoard();
    resolve('old token');
    await flush();
    expect(FakeSocket.all).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(FakeSocket.all).toHaveLength(1);
    expect(FakeSocket.all[0].url).toBe(url);
    token.mockRejectedValueOnce(new Error('refresh rejected'));
    FakeSocket.all[0].frame({ ok: true });
    FakeSocket.all[0].frame({ agent: 'connected' });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(panel().textContent).toContain('Reconnecting');
    await vi.advanceTimersByTimeAsync(2000);
    expect(FakeSocket.all).toHaveLength(2);
  });


  it('restores the selected session after reconnecting and does not show Ready for another session', async () => {
    const { socket } = await mount();
    socket.frame({ type: 'sessions', sessions: [session('one'), session('two')], selected: 'one' });
    socket.frame(snapshot());
    type('draft one');
    socket.handlers.close({ code: 1006, reason: '' });
    await vi.advanceTimersByTimeAsync(2000);
    const next = FakeSocket.all[1];
    next.frame({ type: 'sessions', sessions: [session('one'), session('two')], selected: null });
    expect(next.sent[next.sent.length - 1]).toEqual({ type: 'select', session: 'one' });
    expect(input().value).toBe('draft one');
    next.frame({ type: 'text', session: 'two', message: 'stray', delta: 'Another conversation', final: true });
    expect(panel().textContent).not.toContain('Another conversation');
    expect(sendButton().disabled).toBe(true);
    next.frame(snapshot());
    next.frame({ agent: 'connected' });
    expect(panel().textContent).toContain('Ready');
    expect(sendButton().disabled).toBe(false);
    expect(input().value).toBe('draft one');
  });

  it('a plugin\'s agent shares the panel: no link needed, no opening by itself, New chat, and no red-crayon marks', async () => {
    const sent: string[] = [];
    let reply!: { text(delta: string): void; done(): void };
    const button = document.createElement('button');
    button.hidden = true;
    let offered = true;
    const chat = mountAgentChat(button, {
      url: () => 'wss://x/chat/1', token: async () => 'tok', selection: () => '',
      agents: () => (offered ? [{ id: 'helper', name: 'Agent', open(r) { reply = r; return { send: text => { sent.push(text); }, stop() {}, reset() {} }; } }] : []),
    });
    chat.setAvailable(false);
    expect(button.hidden).toBe(false);
    expect(FakeSocket.all).toHaveLength(0); // nobody linked: no relay to ask
    expect(panel().hidden).toBe(true);

    button.click();
    expect(panel().querySelector('.ac-name')!.textContent).toBe('Agent');
    expect(panel().textContent).toContain('Ready');
    expect([...panel().querySelectorAll('.ac-suggest button')].map(b => b.textContent)).toEqual(['Explain this board']);
    const newChat = panel().querySelector<HTMLButtonElement>('.ac-end')!;
    expect(newChat.textContent).toBe('New chat');
    expect(newChat.hidden).toBe(true);

    const input = panel().querySelector('textarea')!;
    input.value = 'What is this?';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flush();
    expect(sent).toEqual(['What is this?']);
    reply.text('A checkout flow.');
    reply.done();
    await vi.advanceTimersByTimeAsync(1000);
    expect(panel().textContent).toContain('A checkout flow.');
    expect(chat.online).toBe(false);
    expect(chat.prepareMessage('I sent 1 red-crayon mark.')).toBeUndefined();

    expect(newChat.hidden).toBe(false);
    newChat.click();
    await flush();
    expect(panel().textContent).not.toContain('A checkout flow.');
    expect(panel().textContent).toContain('Explain this board');

    // The workspace turned the plugin off: nobody to chat with.
    offered = false;
    chat.setAvailable(false);
    expect(button.hidden).toBe(true);
    expect(panel().hidden).toBe(true);
  });

  it('End chat shows only for an agent that can be let go; it sends end and puts the panel back to connecting one', async () => {
    location.hash = '#b=checkout';
    const { button, socket } = await mount();
    const able = (end: boolean) => ({ id: 'one', agent: 'claude-code', name: 'Claude Code', capabilities: { stop: 'step', approvals: true, ...(end ? { end: true } : {}) } });
    const slot = () => panel().querySelector<HTMLButtonElement>('.ac-end')!;
    const head = () => panel().querySelector<HTMLElement>('.ac-head')!;
    button.click();
    socket.frame({ type: 'snapshot', session: able(false), events: [{ type: 'user', id: 'u', text: 'Earlier' }], queue: [], state: 'idle' });
    expect(slot().hidden).toBe(true); // an older helper: nothing to offer
    expect(head().hasAttribute('data-action')).toBe(false);

    socket.frame({ type: 'snapshot', session: able(true), events: [{ type: 'user', id: 'u', text: 'Earlier' }], queue: [], state: 'idle' });
    expect(slot().textContent).toBe('End chat');
    expect(slot().hidden).toBe(false);
    expect(head().hasAttribute('data-action')).toBe(true);
    slot().click();
    expect(socket.sent[socket.sent.length - 1]).toEqual({ type: 'end', session: 'one' });
    socket.frame({ type: 'sessions', sessions: [], selected: 'one' });
    socket.frame({ agent: 'gone' });
    expect(panel().textContent).not.toContain('Earlier');
    expect(panel().textContent).toContain('No agent connected');
    expect(panel().textContent).toContain('Copy prompt for agent');
    expect(slot().hidden).toBe(true);
  });

  it('the launcher opens the chat at once with one agent, and a list to choose from with several', async () => {
    document.body.insertAdjacentHTML('beforeend', '<div id="launcher-menu"><div id="chat-options"></div><div id="plugin-launcher"></div></div>');
    const menu = document.getElementById('launcher-menu')!;
    try {
      const { chat, socket, button } = await mount();
      const options = () => [...menu.querySelectorAll<HTMLButtonElement>('#chat-options > button')];
      const listed = () => menu.hasAttribute('data-open');
      socket.frame({ type: 'sessions', sessions: [session('one')], selected: 'one' });
      socket.frame(snapshot());
      chat.close();
      expect(options().map(b => b.textContent)).toEqual(['Agent one']);
      button.click();
      expect([listed(), panel().hidden]).toEqual([false, false]);
      chat.close();

      socket.frame({ type: 'sessions', sessions: [session('one'), session('two')], selected: 'one' });
      button.click();
      expect([listed(), panel().hidden]).toEqual([true, true]);
      expect(options().map(b => b.textContent)).toEqual(['Agent one', 'Agent two']);
      expect(document.activeElement).toBe(options()[0]);
      // a press elsewhere, or Escape, puts the list away
      document.dispatchEvent(new Event('pointerdown'));
      expect(listed()).toBe(false);
      button.click();
      menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(listed()).toBe(false);

      button.click();
      options()[1].click();
      expect(socket.sent).toContainEqual({ type: 'select', session: 'two' });
      expect([listed(), panel().hidden]).toEqual([false, false]);
    } finally {
      menu.remove();
    }
  });
});
