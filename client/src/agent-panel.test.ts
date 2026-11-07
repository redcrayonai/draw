import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mountAgentPanel } from './agent-panel';
import { DROPPED } from './agent-chat';
import html from '../index.html?raw';

const BOARD = 'https://draw.example/?db=demo#b=checkout';
const KEY = 'agent-conversation:checkout';

const frame = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;

/** A fetch whose reply streams what the test pushes, until it closes or the request is aborted. */
function sseFetch() {
  const enc = new TextEncoder();
  const calls: { url: string; init: RequestInit }[] = [];
  let ctrl: ReadableStreamDefaultController<Uint8Array> | undefined;
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const body = new ReadableStream<Uint8Array>({ start(c) { ctrl = c; } });
    init?.signal?.addEventListener('abort', () => ctrl?.error(new DOMException('aborted', 'AbortError')));
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }) as unknown as typeof fetch;
  return {
    fetchImpl,
    calls,
    push: (type: string, data: object) => ctrl!.enqueue(enc.encode(frame(type, data))),
    close: () => ctrl!.close(),
    started: () => vi.waitFor(() => expect(ctrl).toBeDefined()),
  };
}

let selected: { id: bigint; label: string } | undefined;

let link = BOARD;

function mount(fake = sseFetch(), storage: Storage = localStorage) {
  document.body.innerHTML = html;
  const panel = mountAgentPanel({
    url: 'https://agent.example/',
    token: async () => 'tok-1',
    boardLink: () => link,
    selectedNode: () => selected,
    storage,
    fetchImpl: fake.fetchImpl,
  });
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  return {
    fake,
    panel,
    orb: $<HTMLButtonElement>('agent-orb'),
    aside: $<HTMLElement>('agent-panel'),
    input: $<HTMLTextAreaElement>('agent-input'),
    sendBtn: $<HTMLButtonElement>('agent-send'),
    msgs: $<HTMLOListElement>('agent-msgs'),
    about: $<HTMLElement>('agent-about'),
  };
}

function ask(input: HTMLTextAreaElement, text: string) {
  input.value = text;
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
}

const items = (msgs: HTMLElement) => [...msgs.children].map(li => [li.className, li.textContent]);
const sentBody = (fake: ReturnType<typeof sseFetch>, i = 0) => JSON.parse(String(fake.calls[i].init.body));

beforeEach(() => {
  localStorage.clear();
  selected = undefined;
  link = BOARD;
});

describe('agent panel', () => {
  it('orb shows once mounted and opens the panel', () => {
    document.body.innerHTML = html;
    expect((document.getElementById('agent-orb') as HTMLElement).hidden).toBe(true);
    const { orb, aside, input } = mount();
    expect(orb.hidden).toBe(false);
    expect(aside.hidden).toBe(true);
    orb.click();
    expect(aside.hidden).toBe(false);
    expect(orb.getAttribute('aria-expanded')).toBe('true');
    expect(document.body.classList.contains('agent-open')).toBe(true);
    expect(document.activeElement).toBe(input);
    (document.getElementById('agent-close') as HTMLButtonElement).click();
    expect(aside.hidden).toBe(true);
    expect(orb.getAttribute('aria-expanded')).toBe('false');
    expect(document.body.classList.contains('agent-open')).toBe(false);
    orb.click();
    aside.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(aside.hidden).toBe(true);
  });

  it('sends the message with token, board link and conversation id', async () => {
    const { fake, input } = mount();
    ask(input, '   ');
    expect(fake.calls).toHaveLength(0); // blank input is ignored
    ask(input, ' Add a cache ');
    await fake.started();
    const { url, init } = fake.calls[0];
    expect(url).toBe('https://agent.example/chat');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-1');
    const body = sentBody(fake);
    expect(body.message).toBe('Add a cache');
    expect(body.boardLink).toBe(BOARD);
    expect(body.messageId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.conversationId).toMatch(/^c-[0-9a-f-]{36}$/);
    expect(body.conversationId).toBe(localStorage.getItem(KEY));
    expect(body.focus).toBeUndefined();
    expect(input.value).toBe('');
  });

  it('a share link\'s token is not in the storage key', async () => {
    link = 'https://draw.example/#s=secret-share-token-123';
    const { fake, input } = mount();
    ask(input, 'hi');
    await fake.started();
    const keys = Object.keys(localStorage);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^agent-conversation:[0-9a-f]{16}$/);
    expect(keys.some(k => k.includes('secret-share-token-123'))).toBe(false);
    expect(sentBody(fake).conversationId).toBe(localStorage.getItem(keys[0]));
    expect(sentBody(fake).boardLink).toBe(link); // the agent still gets the link itself
  });

  it('keys a share link without crypto.subtle (plain-http origins)', async () => {
    const digest = vi.spyOn(crypto.subtle, 'digest').mockRejectedValue(new Error('no subtle'));
    link = 'https://draw.example/#s=secret-share-token-123';
    const { fake, input } = mount();
    ask(input, 'hi');
    await fake.started();
    const keys = Object.keys(localStorage);
    expect(keys).toEqual([expect.stringMatching(/^agent-conversation:[0-9a-f]{16}$/)]);
    expect(sentBody(fake).conversationId).toBe(localStorage.getItem(keys[0]));
    digest.mockRestore();
  });

  it('the same board keeps its conversation across visits', async () => {
    const first = mount();
    ask(first.input, 'one');
    await first.fake.started();
    const id = sentBody(first.fake).conversationId;
    // another visit to the same board: other query, other page
    link = 'https://draw.example/?db=other#b=checkout';
    const second = mount();
    ask(second.input, 'two');
    await second.fake.started();
    expect(sentBody(second.fake).conversationId).toBe(id);
    // and the same share link hashes to the same key each visit
    link = 'https://draw.example/#s=tok-abc';
    const third = mount();
    ask(third.input, 'three');
    await third.fake.started();
    const shared = sentBody(third.fake).conversationId;
    const fourth = mount();
    ask(fourth.input, 'four');
    await fourth.fake.started();
    expect(sentBody(fourth.fake).conversationId).toBe(shared);
    expect(shared).not.toBe(id);
  });

  it('sending still works when storage throws', async () => {
    const blocked = {
      getItem: () => { throw new DOMException('blocked', 'SecurityError'); },
      setItem: () => { throw new DOMException('blocked', 'SecurityError'); },
    } as unknown as Storage;
    const { fake, input, msgs } = mount(sseFetch(), blocked);
    ask(input, 'one');
    await fake.started();
    const id = sentBody(fake).conversationId;
    expect(id).toMatch(/^c-[0-9a-f-]{36}$/);
    fake.push('done', { text: 'ok' });
    fake.close();
    await vi.waitFor(() => expect(msgs.children).toHaveLength(2));
    ask(input, 'two'); // the in-memory id holds for this page
    await vi.waitFor(() => expect(fake.calls).toHaveLength(2));
    expect(sentBody(fake, 1).conversationId).toBe(id);
    (document.getElementById('agent-new') as HTMLButtonElement).click();
    await vi.waitFor(() => expect((document.getElementById('agent-send') as HTMLButtonElement).disabled).toBe(false));
    ask(input, 'three');
    await vi.waitFor(() => expect(fake.calls).toHaveLength(3));
    expect(sentBody(fake, 2).conversationId).not.toBe(id);
  });

  it('new chat holds when storage can be read but not written', async () => {
    localStorage.setItem(KEY, 'c-earlier');
    const full = {
      getItem: (k: string) => localStorage.getItem(k),
      setItem: () => { throw new DOMException('full', 'QuotaExceededError'); },
    } as unknown as Storage;
    const { fake, input, sendBtn } = mount(sseFetch(), full);
    (document.getElementById('agent-new') as HTMLButtonElement).click();
    ask(input, 'one');
    await fake.started();
    expect(sentBody(fake).conversationId).not.toBe('c-earlier');
    const id = sentBody(fake).conversationId;
    fake.push('done', { text: 'ok' });
    fake.close();
    await vi.waitFor(() => expect(sendBtn.disabled).toBe(false));
    ask(input, 'two');
    await vi.waitFor(() => expect(fake.calls).toHaveLength(2));
    expect(sentBody(fake, 1).conversationId).toBe(id);
  });

  it('keeps the stored conversation id for the board', async () => {
    localStorage.setItem(KEY, 'c-earlier');
    const { fake, input } = mount();
    ask(input, 'hi');
    await fake.started();
    expect(sentBody(fake).conversationId).toBe('c-earlier');
  });

  it('renders deltas and status lines in order', async () => {
    const { fake, input, msgs } = mount();
    ask(input, 'Add a cache');
    await fake.started();
    fake.push('status', { message: 'Reading the board…' });
    fake.push('status', { message: 'Adding node…' });
    await vi.waitFor(() => expect(msgs.children).toHaveLength(3));
    // the newest status line spins while the reply streams
    expect(items(msgs)).toEqual([
      ['agent-msg agent-me', 'Add a cache'],
      ['agent-msg agent-status', 'Reading the board…'],
      ['agent-msg agent-status run', 'Adding node…'],
    ]);
    fake.push('delta', { text: 'I added ' });
    fake.push('delta', { text: 'a cache.' });
    fake.push('done', {});
    fake.close();
    await vi.waitFor(() => expect(items(msgs)).toEqual([
      ['agent-msg agent-me', 'Add a cache'],
      ['agent-msg agent-status', 'Reading the board…'],
      ['agent-msg agent-status', 'Adding node…'],
      ['agent-msg agent-agent', 'I added a cache.'],
    ]));
  });

  it('the cut-short notice has no check mark', async () => {
    const { fake, input, msgs } = mount();
    ask(input, 'hi');
    await fake.started();
    fake.push('status', { message: 'Reading the board…' });
    fake.push('status', { message: 'Reply cut short. Ask me to continue.' });
    fake.push('done', {});
    fake.close();
    await vi.waitFor(() => expect(items(msgs)).toEqual([
      ['agent-msg agent-me', 'hi'],
      ['agent-msg agent-status', 'Reading the board…'],
      ['agent-msg agent-status notice', 'Reply cut short. Ask me to continue.'],
    ]));
  });

  it('send is disabled while a reply streams', async () => {
    const { fake, input, sendBtn } = mount();
    expect(sendBtn.disabled).toBe(false);
    sendBtn.click(); // blank
    expect(fake.calls).toHaveLength(0);
    input.value = 'one';
    sendBtn.click();
    await fake.started();
    expect(sendBtn.disabled).toBe(true);
    ask(input, 'two');
    expect(fake.calls).toHaveLength(1);
    fake.push('done', { text: 'ok' });
    fake.close();
    await vi.waitFor(() => expect(sendBtn.disabled).toBe(false));
  });

  it('shift+enter does not send', () => {
    const { fake, input } = mount();
    input.value = 'line';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
    expect(fake.calls).toHaveLength(0);
  });

  it('new chat starts a fresh conversation id', async () => {
    const { fake, input, msgs } = mount();
    ask(input, 'one');
    await fake.started();
    fake.push('done', { text: 'ok' });
    fake.close();
    await vi.waitFor(() => expect(msgs.children).toHaveLength(2));
    const first = sentBody(fake).conversationId;
    (document.getElementById('agent-new') as HTMLButtonElement).click();
    expect(msgs.children).toHaveLength(0);
    await vi.waitFor(() => expect(localStorage.getItem(KEY)).not.toBe(first));
    ask(input, 'two');
    await vi.waitFor(() => expect(fake.calls).toHaveLength(2));
    const second = sentBody(fake, 1).conversationId;
    expect(second).not.toBe(first);
    expect(second).toMatch(/^c-[A-Za-z0-9:_-]{1,126}$/);
    expect(second).toBe(localStorage.getItem(KEY));
  });

  it('the about chip sends focus and can be cleared', async () => {
    selected = { id: 42n, label: 'Auth service' };
    const { fake, input, about, panel } = mount();
    expect(about.hidden).toBe(false);
    expect(about.querySelector('b')!.textContent).toBe('Auth service');
    ask(input, 'one');
    await fake.started();
    expect(sentBody(fake).focus).toEqual({ nodeId: '42', label: 'Auth service' });
    fake.push('done', { text: 'ok' });
    fake.close();
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));

    (document.getElementById('agent-about-clear') as HTMLButtonElement).click();
    expect(about.hidden).toBe(true);
    panel.selectionChanged(); // the same node is still selected: stays cleared
    expect(about.hidden).toBe(true);
    await vi.waitFor(() => expect((document.getElementById('agent-send') as HTMLButtonElement).disabled).toBe(false));
    ask(input, 'two');
    await vi.waitFor(() => expect(fake.calls).toHaveLength(2));
    expect(sentBody(fake, 1).focus).toBeUndefined();

    selected = { id: 7n, label: 'x'.repeat(300) };
    panel.selectionChanged();
    expect(about.hidden).toBe(false);
    selected = undefined;
    panel.selectionChanged();
    expect(about.hidden).toBe(true);
  });

  it('a dropped stream shows the dropped message', async () => {
    const { fake, input, msgs, sendBtn } = mount();
    ask(input, 'one');
    await fake.started();
    fake.push('delta', { text: 'Half' });
    fake.close(); // no done or error
    await vi.waitFor(() => expect(items(msgs)[msgs.children.length - 1]).toEqual(['agent-msg agent-error', DROPPED]));
    expect(sendBtn.disabled).toBe(false);
  });

  it('switching boards clears the chat and continues the new board\'s conversation', async () => {
    localStorage.setItem('agent-conversation:payments', 'c-payments');
    const { fake, input, msgs, sendBtn, panel } = mount();
    ask(input, 'one');
    await fake.started();
    fake.push('delta', { text: 'Half' });
    await vi.waitFor(() => expect(msgs.children).toHaveLength(2));
    link = 'https://draw.example/?db=demo#b=payments';
    panel.boardChanged();
    expect((fake.calls[0].init.signal as AbortSignal).aborted).toBe(true);
    expect(msgs.children).toHaveLength(0);
    expect(sendBtn.disabled).toBe(false);
    ask(input, 'two');
    await vi.waitFor(() => expect(fake.calls).toHaveLength(2));
    expect(sentBody(fake, 1)).toMatchObject({ boardLink: link, conversationId: 'c-payments' });
  });

  it('new chat during a reply does not show dropped', async () => {
    const { fake, input, msgs, sendBtn } = mount();
    ask(input, 'one');
    await fake.started();
    fake.push('delta', { text: 'Half' });
    await vi.waitFor(() => expect(msgs.children).toHaveLength(2));
    (document.getElementById('agent-new') as HTMLButtonElement).click();
    expect((fake.calls[0].init.signal as AbortSignal).aborted).toBe(true);
    await new Promise(r => setTimeout(r, 20));
    expect(msgs.children).toHaveLength(0);
    expect(sendBtn.disabled).toBe(false);
  });
});

describe('agent panel failures', () => {
  it('a failure before sending does not leave the panel stuck', async () => {
    const { fake, input, msgs, sendBtn } = mount();
    // no id can be made for the conversation
    vi.spyOn(crypto, 'randomUUID').mockImplementation(() => { throw new Error('boom'); });
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(() => { throw new Error('boom'); });
    try {
      ask(input, 'hi');
      await vi.waitFor(() => expect(sendBtn.disabled).toBe(false));
      expect(items(msgs)[msgs.children.length - 1]).toEqual(['agent-msg agent-error', 'Something went wrong. Try again.']);
      expect(fake.calls).toHaveLength(0);
      // New chat's id write fails the same way; the next send still goes out once ids work again
      (document.getElementById('agent-new') as HTMLButtonElement).click();
      await new Promise(r => setTimeout(r, 20));
    } finally {
      vi.restoreAllMocks();
    }
    ask(input, 'again');
    await fake.started();
    expect(sentBody(fake).message).toBe('again');
  });

  it('new chat works without crypto.randomUUID', async () => {
    const original = crypto.randomUUID;
    Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true });
    try {
      const { fake, input } = mount();
      (document.getElementById('agent-new') as HTMLButtonElement).click();
      ask(input, 'hi');
      await fake.started();
      const body = sentBody(fake);
      expect(body.conversationId).toMatch(/^c-[A-Za-z0-9:_-]+$/);
      expect(body.conversationId).toBe(localStorage.getItem(KEY));
      expect(body.messageId).toMatch(/^[A-Za-z0-9:_-]{1,128}$/);
    } finally {
      Object.defineProperty(crypto, 'randomUUID', { value: original, configurable: true });
    }
  });

  it('removes conversation keys an earlier version wrote with a share token in them', () => {
    localStorage.setItem('agent-conversation:https://draw.example/#s=old-token', 'c-1');
    localStorage.setItem(KEY, 'c-2');
    localStorage.setItem('other', '#s=keep');
    mount();
    expect(Object.keys(localStorage).sort()).toEqual([KEY, 'other'].sort());
  });
});

describe('agent panel width', () => {
  const W = 'agent-panel-width';
  const width = () => document.body.style.getPropertyValue('--agent-panel-w');
  const handle = () => document.getElementById('agent-resize') as HTMLElement;
  const pointer = (type: string, clientX: number) =>
    handle().dispatchEvent(new PointerEvent(type, { clientX, button: 0, pointerId: 1, bubbles: true, cancelable: true }));
  const key = (k: string) => handle().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

  // jsdom's window is 1024 px wide: the panel may grow to 716 px (70%)
  it('dragging the edge widens the panel within limits', () => {
    mount();
    const h = handle();
    expect(h.getAttribute('role')).toBe('separator');
    expect(h.getAttribute('aria-orientation')).toBe('vertical');
    expect(h.getAttribute('aria-label')).toBe('Resize the agent panel');
    expect(h.tabIndex).toBe(0);
    expect(width()).toBe('320px');
    pointer('pointerdown', 700);
    expect(document.body.classList.contains('agent-resizing')).toBe(true);
    pointer('pointermove', 600);
    expect(width()).toBe('420px');
    pointer('pointermove', 0);
    expect(width()).toBe('716px');
    pointer('pointermove', 1000);
    expect(width()).toBe('280px');
    pointer('pointerup', 1000);
    expect(document.body.classList.contains('agent-resizing')).toBe(false);
    pointer('pointermove', 600); // not dragging any more
    expect(width()).toBe('280px');
  });

  it('arrow keys resize the panel', () => {
    mount();
    key('ArrowLeft');
    expect(width()).toBe('344px');
    key('ArrowRight');
    key('ArrowRight');
    expect(width()).toBe('296px');
    key('ArrowRight');
    expect(width()).toBe('280px');
  });

  it('double-click resets the width', () => {
    mount();
    key('ArrowLeft');
    key('ArrowLeft');
    handle().dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(width()).toBe('320px');
    expect(localStorage.getItem(W)).toBe('320');
  });

  it('the width is remembered', () => {
    mount();
    pointer('pointerdown', 700);
    pointer('pointermove', 600);
    pointer('pointerup', 600);
    expect(localStorage.getItem(W)).toBe('420');
    mount();
    expect(width()).toBe('420px');
  });

  it('a stored width out of range is ignored', () => {
    for (const stored of ['5000', '100', 'wide', '']) {
      localStorage.setItem(W, stored);
      mount();
      expect(width()).toBe('320px');
    }
  });

  it('keeps the width inside a narrower window', () => {
    localStorage.setItem(W, '700');
    mount();
    expect(width()).toBe('700px');
    const inner = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { value: 800, configurable: true });
    try {
      window.dispatchEvent(new Event('resize'));
      expect(width()).toBe('560px');
    } finally {
      Object.defineProperty(window, 'innerWidth', { value: inner, configurable: true });
      window.dispatchEvent(new Event('resize'));
    }
  });
});
