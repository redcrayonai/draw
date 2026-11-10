import type { ChatSession } from '../../shared/chat';
import { createChatConnection, type ChatConnection, type ChatConnectionOptions, type ConnectionStatus } from './chat-connection';
export { IDLE_REAUTH_MS } from './chat-connection';
import { armChime, chime, setSound, soundOn } from './chime';

/**
 * Chat with the agent you are running, from the board. The canvas holds no
 * history of its own: the helper on the person's machine keeps the queue and
 * the conversation, and the relay (mcp/src/chat.ts) stores nothing. The model
 * below is rebuilt from the helper's snapshot on every join.
 */

export type ChatLook = 'chat' | 'terminal';
export type AgentState = 'idle' | 'working' | 'stopping' | 'stopped';
export type Queued = { id: string; text: string; context?: string };
export type Item =
  | { kind: 'user'; id: string; text: string; context?: string; terminal?: boolean }
  | { kind: 'text'; message: string; text: string; final: boolean }
  | { kind: 'work'; steps: { id: string; summary: string; done: boolean }[] }
  | { kind: 'approval'; id: string; summary: string; status: 'pending' | 'resolved' }
  | { kind: 'notice'; text: string; attention?: boolean };

export interface ChatModel {
  items: Item[];
  queue: Queued[];
  state: AgentState;
  paused: boolean;
  online: boolean;
  connection: ConnectionStatus;
  sessions: ChatSession[];
  selected: string | null;
  session: ChatSession | null;
  /** Set when the channel refused or closed, with the sentence to show. */
  closed: string | null;
}

export const emptyChat = (): ChatModel => ({ items: [], queue: [], state: 'idle', paused: false, online: false, connection: 'offline', sessions: [], selected: null, session: null, closed: null });

type Frame = Record<string, any>;

function applyEvent(m: ChatModel, e: Frame): void {
  switch (e.type) {
    case 'delivered':
      m.items.push({ kind: 'user', id: String(e.id), text: String(e.text ?? ''), context: typeof e.context === 'string' ? e.context : undefined });
      return;
    case 'user':
      m.items.push({ kind: 'user', id: String(e.id), text: String(e.text ?? ''), terminal: e.origin === 'terminal' });
      return;
    case 'text': {
      const open = [...m.items].reverse().find(i => i.kind === 'text' && i.message === e.message);
      if (open?.kind === 'text') {
        open.text += String(e.delta ?? '');
        open.final = Boolean(e.final);
      } else {
        m.items.push({ kind: 'text', message: String(e.message), text: String(e.delta ?? ''), final: Boolean(e.final) });
      }
      return;
    }
    case 'tool': {
      const last = m.items[m.items.length - 1];
      if (e.phase === 'start') {
        const step = { id: String(e.id), summary: String(e.summary ?? ''), done: false };
        if (last?.kind === 'work') last.steps.push(step);
        else m.items.push({ kind: 'work', steps: [step] });
        return;
      }
      for (const item of m.items) {
        if (item.kind !== 'work') continue;
        const step = item.steps.find(s => s.id === e.id);
        if (step) { step.done = true; return; }
      }
      // Restored adapter history can contain only the completed tool record.
      if (typeof e.summary === 'string') {
        const step = { id: String(e.id), summary: e.summary, done: true };
        if (last?.kind === 'work') last.steps.push(step);
        else m.items.push({ kind: 'work', steps: [step] });
      }
      return;
    }
    case 'approval': {
      const existing = m.items.find(i => i.kind === 'approval' && i.id === e.id);
      if (existing?.kind === 'approval') existing.status = e.status;
      else m.items.push({ kind: 'approval', id: String(e.id), summary: String(e.summary ?? ''), status: e.status });
      return;
    }
    case 'notice':
      m.items.push({ kind: 'notice', text: String(e.text ?? ''), ...(e.tone === 'attention' ? { attention: true } : {}) });
      return;
  }
}

/** One frame from the relay. Pure, so the whole conversation is tested without a socket. */
export function applyFrame(m: ChatModel, f: Frame): void {
  if (f.agent === 'connected') {
    if (!m.online) m.connection = 'syncing';
    m.closed = null;
    return;
  }
  if (f.agent === 'gone') {
    m.online = false;
    m.connection = 'waiting';
    return;
  }
  if (f.type === 'sessions') {
    m.sessions = Array.isArray(f.sessions) ? [...f.sessions] : [];
    if (m.session && !m.sessions.some(s => s.id === m.session!.id)) m.sessions.push(m.session);
    const selected = typeof f.selected === 'string' ? f.selected : null;
    if (selected !== m.selected) {
      m.items = [];
      m.queue = [];
      m.online = false;
      m.state = 'idle';
      m.paused = false;
      m.selected = selected;
      m.session = m.sessions.find(s => s.id === selected) ?? null;
      m.connection = selected ? 'syncing' : 'waiting';
    }
    return;
  }
  const sessionId = typeof f.session === 'string' ? f.session : f.session?.id;
  if (sessionId && m.selected && sessionId !== m.selected) return;
  if (f.type === 'snapshot') {
    if (f.session && typeof f.session === 'object') {
      m.session = f.session;
      m.selected = f.session.id;
    }
    m.items = [];
    for (const e of (f.events as Frame[]) ?? []) applyEvent(m, e);
    m.queue = (f.queue as Queued[]) ?? [];
    m.state = f.state ?? 'idle';
    m.paused = Boolean(f.paused);
    m.online = true;
    m.connection = 'ready';
    m.closed = null;
    return;
  }
  if (f.type === 'state') {
    m.state = f.state;
    return;
  }
  if (f.type === 'queue') {
    m.queue = f.queue ?? [];
    m.paused = Boolean(f.paused);
    return;
  }
  applyEvent(m, f);
}

/** The chat channel for a board, on the same host as the hosted agent server. */
export function chatUrl(mcpUrl: string, board: bigint): string {
  const u = new URL(mcpUrl);
  u.protocol = u.protocol === 'http:' ? 'ws:' : 'wss:';
  u.pathname = `/chat/${board}`;
  u.search = '';
  u.hash = '';
  return u.toString();
}

/** Text with `code` and **bold** spans, as DOM nodes: an agent's text never becomes markup. */
export function appendInline(parent: HTMLElement, text: string): void {
  text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/).forEach(part => {
    if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) {
      const code = document.createElement('code');
      code.textContent = part.slice(1, -1);
      parent.append(code);
    } else if (part.length > 4 && part.startsWith('**') && part.endsWith('**')) {
      const strong = document.createElement('strong');
      strong.textContent = part.slice(2, -2);
      parent.append(strong);
    } else if (part) {
      parent.append(part);
    }
  });
}

/**
 * An agent's markdown as DOM: paragraphs, lists, headings and fenced code, the
 * subset agents write. A fence still streaming renders as code already.
 */
export function appendBlocks(parent: HTMLElement, text: string, codeActions?: (pre: HTMLElement, code: string) => void): void {
  const lines = text.split('\n');
  let para: string[] = [];
  let list: HTMLElement | null = null;
  const flush = () => {
    if (para.length) {
      const p = document.createElement('p');
      appendInline(p, para.join('\n'));
      parent.append(p);
    }
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      flush();
      list = null;
      const body: string[] = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) body.push(lines[i]);
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.textContent = body.join('\n');
      pre.append(code);
      codeActions?.(pre, body.join('\n'));
      parent.append(pre);
      continue;
    }
    const item = /^\s*(?:[-*]|(\d+)\.)\s+(.*)$/.exec(line);
    if (item) {
      flush();
      if (!list || (list.tagName === 'OL') !== Boolean(item[1])) {
        list = document.createElement(item[1] ? 'ol' : 'ul');
        parent.append(list);
      }
      const li = document.createElement('li');
      appendInline(li, item[2]);
      list.append(li);
      continue;
    }
    if (!line.trim()) {
      flush();
      list = null;
      continue;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      list = null;
      const h = document.createElement('p');
      h.className = 'ac-heading';
      appendInline(h, heading[1]);
      parent.append(h);
      continue;
    }
    list = null;
    para.push(line);
  }
  flush();
}

/** How much of `target` characters to show next frame: steady when caught up, faster with a backlog, so lines read as a stream. */
export function revealStep(shown: number, target: number): number {
  if (shown >= target) return target;
  return Math.min(target, shown + Math.max(1, Math.ceil((target - shown) / 18)));
}

/** Where the person's agent is when it is not on this board. */
export type AgentElsewhere = { board: string; href: string; live: boolean };

export interface AgentChatOpts {
  url(): string;
  token(): Promise<string | null>;
  /** What the person has selected, in words, or empty. */
  selection(): string;
  connection?(options: ChatConnectionOptions): ChatConnection;
  agentElsewhere?(): AgentElsewhere | null;
  onOpen?(): void;
  canAutoOpen?(): boolean;
  /** The board gained (+) or lost (-) this much width beside it. */
  boardWidthChanged?(delta: number): void;
}

const LOOK_KEY = 'redcrayon.chatLook';
const WIDTH_KEY = 'redcrayon.chatWidth';
const CLOSED_KEY = 'redcrayon.chatClosed:';
const MIN_WIDTH = 320;
const MAX_WIDTH = 640;
const SVG_NS = 'http://www.w3.org/2000/svg';

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
};

function button(className: string, text: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', className, text);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

/** One authored 16 px stroke icon, in the weight of the rest of the chrome. */
function icon(path: string, filled = false): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('fill', filled ? 'currentColor' : 'none');
  svg.setAttribute('stroke', filled ? 'none' : 'currentColor');
  svg.setAttribute('stroke-width', '1.3');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const d = document.createElementNS(SVG_NS, 'path');
  d.setAttribute('d', path);
  svg.append(d);
  return svg;
}
const ICON = {
  close: 'M4 4l8 8M12 4l-8 8',
  stop: 'M4.5 3.5h7a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1Z',
  chevron: 'M6 4l4 4-4 4',
  check: 'M3.5 8.5l3 3 6-7',
  down: 'M8 3v10M4 9l4 4 4-4',
  pencil: 'M2.75 13.25V11l7.5-7.5 2.25 2.25-7.5 7.5ZM10.25 3.5l1.5-1.5 2.25 2.25-1.5 1.5',
};

export function mountAgentChat(chatButton: HTMLButtonElement, opts: AgentChatOpts) {
  const model = emptyChat();
  const panel = el('aside', 'ac-panel');
  panel.id = 'agent-chat';
  panel.hidden = true;
  panel.setAttribute('aria-label', 'Chat with agent');
  document.body.append(panel);

  let look: ChatLook = localStorage.getItem(LOOK_KEY) === 'terminal' ? 'terminal' : 'chat';
  let connection: ChatConnection | null = null;
  let boardUrl = opts.url();
  let boardVersion = 0;
  let switchingBoard = false;
  let lastSelection = opts.selection();
  const drafts = new Map<string, { text: string; attached: string; detached: string }>();
  const selections = new Map<string, string>();
  let draftContext: string | null = null;
  const pendingApprovals = new Set<string>();
  let available = false;
  let open = false;
  let drawing = false;
  let unread = false;
  let nextId = 1;
  let detached = '';
  let workingSince = 0;
  let wasOnline = false;
  /** A pairing link waiting for the person's answer. Never acted on without it: anyone can send someone a link. */
  let pairing: { run(): Promise<'linked' | 'already'>; busy: boolean; failed: boolean; already?: boolean } | null = null;
  const expanded = new Set<string>();
  const back = el('span', 'ac-back', 'Back to chat');
  back.hidden = true;
  chatButton.append(back);
  const draw = button('ac-draw', '', () => {
    setOpen(false);
    setDrawing(true);
    document.getElementById('tool-select')?.focus();
  });
  draw.id = 'chat-draw';
  draw.hidden = true;
  draw.append(icon(ICON.pencil));
  draw.setAttribute('aria-label', 'Draw');
  draw.setAttribute('aria-controls', 'dock');
  draw.title = 'Draw';
  (document.getElementById('canvas-wrap') ?? document.body).append(draw);

  /** The selection this message would carry, unless the person took it off. */
  const context = () => {
    if (draftContext !== null) return draftContext;
    const current = opts.selection();
    if (current !== detached) detached = '';
    return current === detached ? '' : current;
  };
  const busy = () => model.online && (model.state === 'working' || model.state === 'stopping');
  const closedKey = () => CLOSED_KEY + opts.url();

  // ---- width: the panel docks beside the board, and the board keeps the rest ----
  const applyWidth = (w: number) => {
    const clamped = Math.round(Math.min(Math.max(MIN_WIDTH, w), MAX_WIDTH, Math.max(MIN_WIDTH, innerWidth - 480)));
    document.documentElement.style.setProperty('--ac-w', `${clamped}px`);
    handle.setAttribute('aria-valuenow', String(clamped));
    return clamped;
  };
  const boardResized = () => window.dispatchEvent(new Event('resize'));
  const handle = el('div', 'ac-resize');
  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-orientation', 'vertical');
  handle.setAttribute('aria-label', 'Resize chat');
  handle.setAttribute('aria-valuemin', String(MIN_WIDTH));
  handle.setAttribute('aria-valuemax', String(MAX_WIDTH));
  handle.tabIndex = 0;
  let width = applyWidth(Number(localStorage.getItem(WIDTH_KEY)) || 400);
  window.addEventListener('resize', () => { width = applyWidth(width); });
  const docked = () => matchMedia('(min-width: 721px)').matches;
  const setWidth = (w: number) => {
    const before = width;
    width = applyWidth(w);
    localStorage.setItem(WIDTH_KEY, String(width));
    boardResized();
    opts.boardWidthChanged?.(before - width);
  };
  handle.addEventListener('pointerdown', ev => {
    ev.preventDefault();
    handle.setPointerCapture(ev.pointerId);
    const move = (e: PointerEvent) => setWidth(innerWidth - e.clientX);
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  });
  handle.addEventListener('keydown', ev => {
    if (ev.key === 'ArrowLeft') setWidth(width + 24);
    else if (ev.key === 'ArrowRight') setWidth(width - 24);
    else return;
    ev.preventDefault();
  });

  // ---- static parts ----
  const dot = el('span', 'ac-dot');
  const statusText = el('span');
  // Labeled, not an icon: the person should know what the button does before pressing it.
  const sound = button('ac-sound', '', () => {
    setSound(!soundOn());
    renderSound();
  });
  const renderSound = () => {
    sound.textContent = soundOn() ? 'Sound on' : 'Sound off';
    sound.setAttribute('aria-pressed', String(soundOn()));
    sound.title = 'A chime when your agent finishes or needs you, while you are not looking at the chat';
  };
  renderSound();
  armChime();
  const statusLine = el('div', 'ac-private');
  statusLine.append(statusText, el('span', 'ac-sep', ' · '), sound);
  const name = el('div', 'ac-name');
  const agentName = el('span', undefined, 'Your agent');
  name.append(dot, agentName);
  const sessions = el('select', 'ac-sessions');
  sessions.setAttribute('aria-label', 'Agent session');
  sessions.hidden = true;
  sessions.addEventListener('change', () => selectSession(sessions.value));
  const id = el('div', 'ac-id');
  id.append(name, statusLine);
  const seg = el('div', 'ac-seg');
  seg.setAttribute('role', 'group');
  seg.setAttribute('aria-label', 'Chat look');
  const looks = (['chat', 'terminal'] as const).map(l => {
    const b = button('', l === 'chat' ? 'Chat' : 'Terminal', () => {
      look = l;
      localStorage.setItem(LOOK_KEY, l);
      rendered.clear();
      log.textContent = '';
      render();
    });
    seg.append(b);
    return [l, b] as const;
  });
  const close = button('ac-x', '', () => setOpen(false, true));
  close.append(icon(ICON.close));
  close.setAttribute('aria-label', 'Close chat');
  const head = el('div', 'ac-head');
  head.append(id, seg, close);

  const log = el('div', 'ac-log');
  log.setAttribute('role', 'log');
  log.setAttribute('aria-live', 'polite');
  log.tabIndex = 0;
  log.setAttribute('aria-label', 'Conversation');
  const jump = button('ac-jump', 'Jump to latest', () => {
    stickToEnd = true;
    log.scrollTop = log.scrollHeight;
    jump.hidden = true;
  });
  jump.prepend(icon(ICON.down));
  jump.hidden = true;
  const logWrap = el('div', 'ac-logwrap');
  logWrap.append(log, jump);

  const chips = el('div', 'ac-chips');
  const inputRow = el('div', 'ac-inputrow');
  const input = el('textarea', 'ac-input');
  input.rows = 1;
  input.placeholder = 'Ask about the board, or ask for a change';
  input.setAttribute('aria-label', 'Message your agent');
  const prompt = el('span', 'ac-prompt', '❯');
  prompt.setAttribute('aria-hidden', 'true');
  inputRow.append(prompt, input);
  const hint = el('span', 'ac-hint');
  const stop = button('ac-stop', 'Stop', () => {
    if (model.state !== 'working' || !frame({ type: 'stop' })) return;
    model.state = 'stopping';
    render();
  });
  stop.prepend(icon(ICON.stop, true));
  stop.setAttribute('aria-label', 'Stop agent');
  const sendBtn = button('ac-send', 'Send', () => send());
  const actions = el('div', 'ac-actions');
  actions.append(stop, sendBtn);
  const row = el('div', 'ac-row');
  row.append(hint, actions);
  const box = el('div', 'ac-box');
  box.append(chips, inputRow, row);
  const foot = el('div', 'ac-foot');
  const lost = el('div', 'ac-lost');
  foot.append(lost, box);
  panel.append(handle, head, sessions, logWrap, foot);

  const frame = (f: Frame): boolean => model.online && Boolean(connection?.send({
    ...f, ...(model.selected ? { session: model.selected } : {}),
  }));
  const reportViewing = () => frame({ type: 'viewing', active: open && document.visibilityState !== 'hidden' });
  document.addEventListener('visibilitychange', reportViewing);
  const draftKey = () => JSON.stringify([boardUrl, model.selected]);
  function saveDraft(): void {
    drafts.set(draftKey(), { text: input.value, attached: context(), detached });
  }
  function restoreDraft(): void {
    const draft = drafts.get(draftKey());
    input.value = draft?.text ?? '';
    draftContext = draft?.text ? draft.attached : null;
    detached = draft?.detached ?? '';
    lastSelection = opts.selection();
    input.style.height = 'auto';
  }
  function clearHistory(): void {
    model.items = [];
    model.queue = [];
    model.state = 'idle';
    model.paused = false;
    model.online = false;
    model.connection = 'syncing';
    shown.clear();
    expanded.clear();
    rendered.clear();
    pendingApprovals.clear();
    log.textContent = '';
  }
  function selectSession(session: string): void {
    if (!session || session === model.selected) return;
    if (!connection?.send({ type: 'select', session })) return;
    saveDraft();
    model.selected = session;
    model.session = model.sessions.find(s => s.id === session) ?? null;
    selections.set(boardUrl, session);
    clearHistory();
    restoreDraft();
    render();
  }
  function send(): void {
    const text = input.value.trim();
    if (!text || !model.online) return;
    const attached = context();
    if (!frame({ type: 'send', id: `b${Date.now()}-${nextId++}`, text, ...(attached ? { context: attached } : {}) })) return;
    input.value = '';
    draftContext = null;
    drafts.delete(draftKey());
    input.style.height = 'auto';
    stickToEnd = true;
    render();
  }
  input.addEventListener('keydown', ev => {
    ev.stopPropagation(); // the canvas's tool shortcuts must not see typing
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
      ev.preventDefault();
      send();
    }
    if (ev.key === 'Escape') setOpen(false, true);
  });
  input.addEventListener('input', () => {
    if (!input.value) draftContext = null;
    else if (draftContext === null) draftContext = context();
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
    renderComposer();
  });
  const copyButton = (label: string, text: string, className = 'ac-link') => {
    const b = button(className, label, () => {
      void navigator.clipboard?.writeText(text).then(() => {
        b.textContent = 'Copied';
        setTimeout(() => (b.textContent = label), 1500);
      });
    });
    return b;
  };

  // ---- streaming: each message's revealed length, advanced once a frame ----
  const shown = new Map<string, number>();
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  let animating = false;
  let stickToEnd = true;
  log.addEventListener('scroll', () => {
    stickToEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 24;
    if (stickToEnd) jump.hidden = true;
  });
  const fillText = (node: HTMLElement, text: string) => {
    node.textContent = '';
    appendBlocks(node, text.trimEnd(), (pre, code) => pre.append(copyButton('Copy', code, 'ac-copy')));
  };
  const animate = () => {
    if (animating || !open) return;
    animating = true;
    log.setAttribute('aria-busy', 'true');
    requestAnimationFrame(function tick() {
      let pending = false;
      for (const item of model.items) {
        if (item.kind !== 'text') continue;
        const at = shown.get(item.message) ?? 0;
        const next = reduced() ? item.text.length : revealStep(at, item.text.length);
        if (next !== at) {
          shown.set(item.message, next);
          const node = log.querySelector<HTMLElement>(`[data-message="${CSS.escape(item.message)}"] .ac-body`);
          if (node) fillText(node, item.text.slice(0, next));
        }
        if (next < item.text.length) pending = true;
      }
      if (stickToEnd) log.scrollTop = log.scrollHeight;
      else jump.hidden = false;
      if (pending && open) requestAnimationFrame(tick);
      else {
        animating = false;
        log.removeAttribute('aria-busy');
      }
    });
  };

  // ---- rendering: keyed, so a new row never rereads the rows above it to a screen reader or drops a selection ----
  type Row = { key: string; sig: string; build(): HTMLElement };
  const rendered = new Map<string, { sig: string; node: HTMLElement }>();

  function reconcile(rows: Row[]): void {
    const keep = new Set(rows.map(r => r.key));
    for (const [key, r] of rendered) {
      if (!keep.has(key)) {
        r.node.remove();
        rendered.delete(key);
      }
    }
    let cursor = log.firstElementChild;
    for (const row of rows) {
      let current = rendered.get(row.key);
      if (!current || current.sig !== row.sig) {
        const node = row.build();
        current?.node.replaceWith(node);
        if (current && cursor === current.node) cursor = node;
        current = { sig: row.sig, node };
        rendered.set(row.key, current);
      }
      if (current.node === cursor) cursor = cursor.nextElementSibling;
      else log.insertBefore(current.node, cursor);
    }
  }

  function userNode(text: string, attached: string | undefined, meta?: string, q?: Queued): HTMLElement {
    const wrap = el('div', q ? 'ac-user ac-queued' : 'ac-user');
    if (attached) wrap.append(el('span', 'ac-chip', attached));
    const bubble = el('div', 'ac-bubble');
    if (look === 'terminal') bubble.append(el('span', 'ac-promptline', '❯ '));
    bubble.append(text);
    wrap.append(bubble);
    if (q || meta) {
      const small = el('small', 'ac-meta', meta ?? 'Queued');
      if (q) {
        const del = button('ac-link', 'Delete', () => frame({ type: 'delete', id: q.id }));
        del.setAttribute('aria-label', `Delete queued message: ${q.text.slice(0, 40)}`);
        small.append(del);
      }
      wrap.append(small);
    }
    return wrap;
  }

  function stepNode(s: { summary: string; done: boolean }, running: boolean): HTMLElement {
    const line = el('div', running ? 'ac-step running' : 'ac-step');
    if (look === 'terminal') line.append(el('span', 'ac-tree', '⎿ '));
    else if (running) line.append(el('span', 'ac-spin'));
    else if (s.done) line.append(icon(ICON.check));
    else line.append(el('span', 'ac-halted'));
    line.append(el('span', 'ac-steptext', s.summary));
    return line;
  }

  function workNode(key: string, steps: { summary: string; done: boolean }[], lastRunning: number): HTMLElement {
    const work = el('div', 'ac-work');
    // The developer look keeps every step on screen; chat folds them behind the latest.
    if (look === 'terminal' || steps.length === 1) {
      steps.forEach((s, i) => work.append(stepNode(s, i === lastRunning)));
      return work;
    }
    const isOpen = expanded.has(key);
    const toggle = button('ac-worktoggle', '', () => {
      if (isOpen) expanded.delete(key);
      else expanded.add(key);
      render();
    });
    toggle.setAttribute('aria-expanded', String(isOpen));
    toggle.append(icon(ICON.chevron), el('span', 'ac-count', `${steps.length} steps`));
    work.append(toggle);
    if (isOpen) steps.forEach((s, i) => work.append(stepNode(s, i === lastRunning)));
    else work.append(stepNode(steps[Math.max(lastRunning, steps.length - 1)], lastRunning >= 0));
    return work;
  }

  function pairCard(p: NonNullable<typeof pairing>): HTMLElement {
    const card = el('div', 'ac-empty');
    if (p.already) {
      card.append(el('h4', undefined, 'Your agent is already linked'));
      card.append(el('p', undefined, 'Your conversation will appear when the agent is available.'));
      card.append(button('ac-action', 'Close', () => {
        pairing = null;
        render();
      }));
      return card;
    }
    if (p.failed) {
      card.append(el('h4', undefined, 'That link did not work'));
      card.append(el('p', undefined, 'It may have expired or been used already. Ask your agent for a new one.'));
      card.append(button('ac-action', 'Close', () => {
        pairing = null;
        render();
      }));
      return card;
    }
    card.append(el('h4', undefined, 'Link this agent to your browser?'));
    card.append(el('p', undefined, 'It will be able to draw on this board, and you can chat with it here. Continue only if you started this agent yourself.'));
    const yes = button('ac-action primary', p.busy ? 'Linking…' : 'Link agent', () => {
      p.busy = true;
      render();
      p.run().then(
        result => {
          if (result === 'already') {
            p.busy = false;
            p.already = true;
          } else pairing = null;
          render();
        },
        () => {
          p.busy = false;
          p.failed = true;
          render();
        },
      );
    });
    yes.disabled = p.busy;
    card.append(yes, button('ac-action', 'Not now', () => {
      pairing = null;
      render();
    }));
    return card;
  }

  function setupCard(): HTMLElement {
    const card = el('div', 'ac-empty');
    const elsewhere = opts.agentElsewhere?.() ?? null;
    if (elsewhere) {
      card.append(el('h4', undefined, elsewhere.live ? `Your agent is on ${elsewhere.board}` : `Your latest session is ${elsewhere.board}`));
      card.append(el('p', undefined, elsewhere.live ? 'This board has no agent. Go to the board it is drawing on.' : 'Open this board, then ask your agent to reconnect board chat if it is offline.'));
      const go = el('a', 'ac-action primary', `Open ${elsewhere.board}`);
      go.href = elsewhere.href;
      card.append(go);
      return card;
    }
    if (!model.selected && model.sessions.length > 1) {
      card.append(el('h4', undefined, 'Choose an agent session'));
      card.append(el('p', undefined, 'Each session keeps its own conversation and draft.'));
      return card;
    }
    const syncing = model.connection === 'syncing';
    card.append(el('h4', undefined, syncing ? 'Restoring your conversation' : model.connection === 'waiting' ? 'No agent connected' : model.connection === 'reconnecting' ? 'Reconnecting to your agent' : 'Connecting to your agent'));
    card.append(el('p', undefined, syncing ? 'Your messages will appear here in a moment.' : model.connection === 'waiting' ? 'Ask your agent to reconnect board chat and include this board’s URL. You can keep a draft here.' : 'Your conversation and draft will stay here while we reconnect.'));
    return card;
  }

  function startCard(attached: string): HTMLElement {
    const card = el('div', 'ac-empty');
    card.append(el('h4', undefined, 'Ask about this board, or ask for a change'));
    const prompts = attached
      ? ['Why is this here?', 'Explain what this does', 'Remove this and update the code']
      : ['Explain this board', 'What did you change most recently?'];
    const list = el('div', 'ac-suggest');
    for (const text of prompts) {
      list.append(button('ac-action', text, () => {
        input.value = text;
        input.dispatchEvent(new Event('input'));
        input.focus();
      }));
    }
    card.append(list);
    if (!attached) card.append(el('p', 'ac-small', 'Select a node or an edge to attach it to your message.'));
    return card;
  }

  function renderStatus(): void {
    const state = !model.online ? ({ connecting: 'Connecting', reconnecting: 'Reconnecting', syncing: 'Syncing conversation', waiting: 'Waiting for agent', offline: 'Not connected', ready: 'Syncing conversation' }[model.connection]) : model.state === 'working' ? 'Working' : model.state === 'stopping' ? 'Stopping' : model.state === 'stopped' ? 'Stopped' : 'Ready';
    const awaitingApproval = model.online && model.items.some(i => i.kind === 'approval' && i.status === 'pending');
    statusText.textContent = `${awaitingApproval ? 'Needs approval' : state} · private to you`;
    agentName.textContent = model.session?.name || 'Your agent';
    sessions.hidden = model.sessions.length < 2;
    const options = JSON.stringify(model.sessions.map(s => [s.id, s.name]));
    if (sessions.dataset.options !== options) {
      const placeholder = el('option', undefined, 'Choose a session');
      placeholder.value = '';
      placeholder.disabled = true;
      sessions.replaceChildren(placeholder, ...model.sessions.map(s => {
        const duplicate = model.sessions.some(other => other.id !== s.id && other.name === s.name);
        const option = el('option', undefined, duplicate ? `${s.name} · ${s.id.slice(-8)}` : s.name);
        option.value = s.id;
        return option;
      }));
      sessions.dataset.options = options;
    }
    sessions.value = model.selected ?? '';
    dot.className = `ac-dot ${!model.online ? 'off' : busy() ? 'busy' : ''}`;
    chatButton.dataset.state = !model.online ? 'off' : busy() ? 'busy' : 'on';
    chatButton.dataset.unread = String(unread);
    chatButton.setAttribute('aria-label', `${drawing ? 'Back to chat' : 'Chat with agent'}${unread ? ', new reply' : ''}`);
  }

  function renderComposer(): void {
    const attached = open ? context() : '';
    chips.textContent = '';
    chips.hidden = !attached;
    if (attached) {
      const chip = el('span', 'ac-chip', attached);
      const off = button('ac-chipx', '', () => {
        detached = opts.selection();
        draftContext = '';
        render();
      });
      off.append(icon(ICON.close));
      off.setAttribute('aria-label', `Do not attach ${attached}`);
      chip.append(off);
      chips.append(chip);
    }
    const hasText = input.value.trim().length > 0;
    stop.hidden = !busy() || model.session?.capabilities.stop === 'none';
    stop.disabled = model.state === 'stopping';
    stop.lastChild!.textContent = model.state === 'stopping' ? 'Stopping' : 'Stop';
    input.disabled = false;
    sendBtn.disabled = !model.online || !hasText;
    sendBtn.textContent = busy() ? 'Queue' : 'Send';
    hint.textContent = !model.online ? ''
      : model.state === 'stopping' ? model.session?.capabilities.stop === 'interrupt' ? 'Stop requested · waiting for confirmation' : 'Stopping at its next step'
      : busy() ? 'Messages wait until it finishes'
      : attached ? 'Attached to your message'
      : look === 'terminal' ? 'enter send · shift+enter new line'
      : 'Select a node to attach it';
    foot.hidden = pairing !== null;
    lost.hidden = model.online || model.items.length === 0;
    lost.textContent = model.connection === 'syncing' ? 'Restoring your conversation…' : model.connection === 'waiting' ? 'Ask your agent to reconnect board chat. Your draft is saved here.' : 'Reconnecting automatically. Your draft is saved here.';
  }

  function render(): void {
    panel.dataset.look = look;
    for (const [l, b] of looks) b.setAttribute('aria-pressed', String(l === look));
    renderStatus();

    const rows: Row[] = [];
    const attached = context();
    if (pairing) {
      const p = pairing;
      rows.push({ key: 'pair', sig: JSON.stringify([p.busy, p.failed, p.already]), build: () => pairCard(p) });
    } else if (model.closed) {
      rows.push({ key: 'closed', sig: model.closed, build: () => el('div', 'ac-empty', model.closed!) });
    } else if (!model.online && model.items.length === 0) {
      const elsewhere = opts.agentElsewhere?.() ?? null;
      rows.push({ key: 'setup', sig: JSON.stringify([elsewhere, model.connection]), build: setupCard });
    } else if (model.items.length === 0 && model.queue.length === 0) {
      rows.push({ key: 'start', sig: attached ? 'selected' : 'none', build: () => startCard(attached) });
    }
    let n = 0;
    for (const item of model.items) {
      n++;
      if (item.kind === 'user') {
        const meta = item.terminal ? 'Typed in your terminal' : undefined;
        rows.push({ key: `u:${item.id}`, sig: '', build: () => userNode(item.text, item.context, meta) });
      }
      if (item.kind === 'approval') {
        rows.push({ key: `a:${item.id}`, sig: JSON.stringify([item, model.online, model.session?.capabilities.approvals, pendingApprovals.has(item.id)]), build: () => {
          const card = el('div', 'ac-approval');
          card.append(el('strong', undefined, item.status === 'resolved' ? 'Approval resolved' : 'Your approval is needed'));
          card.append(el('p', undefined, item.summary));
          if (item.status === 'pending' && model.session?.capabilities.approvals) {
            for (const [decision, label] of [['accept', 'Allow'], ['decline', 'Decline']] as const) {
              const action = button('ac-action', label, () => {
                if (!frame({ type: 'approval', id: item.id, decision })) return;
                pendingApprovals.add(item.id);
                render();
              });
              action.disabled = !model.online || pendingApprovals.has(item.id);
              card.append(action);
            }
            if (pendingApprovals.has(item.id)) card.append(el('small', 'ac-meta', 'Waiting for confirmation…'));
          }
          return card;
        } });
      }
      if (item.kind === 'notice') {
        rows.push({ key: `n:${n}`, sig: item.text, build: () => el('div', item.attention ? 'ac-notice attention' : 'ac-notice', item.text) });
      }
      if (item.kind === 'work') {
        const key = `w:${item.steps[0].id}`;
        const last = item.steps.findIndex(s => !s.done);
        const running = model.state === 'working' && last >= 0 ? last : -1;
        const steps = item.steps.map(s => ({ summary: s.summary, done: s.done }));
        rows.push({ key, sig: JSON.stringify([steps, running, expanded.has(key)]), build: () => workNode(key, steps, running) });
      }
      if (item.kind === 'text') {
        rows.push({
          key: `t:${item.message}`,
          sig: '',
          build: () => {
            const node = el('div', 'ac-agent');
            node.dataset.message = item.message;
            if (look === 'terminal') node.append(el('span', 'ac-bullet', '●'));
            const body = el('div', 'ac-body');
            fillText(body, item.text.slice(0, reduced() ? item.text.length : (shown.get(item.message) ?? 0)));
            node.append(body);
            return node;
          },
        });
      }
    }
    if (busy() && model.state === 'working') {
      const stepRunning = model.items.some(i => i.kind === 'work' && i.steps.some(st => !st.done));
      rows.push({ key: 'working', sig: String(stepRunning), build: () => {
        const row = el('div', 'ac-thinking');
        if (!stepRunning) row.append(el('span', 'ac-spin'));
        row.append(el('span', 'ac-elapsed'));
        return row;
      } });
    }
    for (const q of model.queue) rows.push({ key: `q:${q.id}`, sig: '', build: () => userNode(q.text, q.context, undefined, q) });
    if (model.paused && model.queue.length > 0) {
      rows.push({
        key: 'paused',
        sig: '',
        build: () => {
          const banner = el('div', 'ac-notice attention', 'Queue paused.');
          banner.append(button('ac-link', 'Resume queue', () => frame({ type: 'resume' })));
          return banner;
        },
      });
    }
    reconcile(rows);
    tickElapsed();
    renderComposer();
    if (stickToEnd) log.scrollTop = log.scrollHeight;
    else if (rows.length) jump.hidden = false;
    animate();
  }

  const tickElapsed = () => {
    const node = log.querySelector('.ac-elapsed');
    if (node) node.textContent = `Working · ${Math.max(0, Math.floor((Date.now() - workingSince) / 1000))}s`;
  };
  setInterval(() => {
    if (open && busy()) tickElapsed();
  }, 1000);

  // ---- channel: adapters speak one protocol; presentation never owns a socket ----
  function connect(): void {
    if (connection || !available || switchingBoard) return;
    const current = (opts.connection ?? createChatConnection)({
      url: boardUrl,
      token: opts.token,
      status(status, reason) {
        if (connection !== current) return;
        if (status === 'syncing' && model.online) return;
        model.connection = status;
        model.online = false;
        wasOnline = false;
        model.closed = reason ?? null;
        render();
      },
      receive(f) {
        if (connection !== current) return;
        const incoming = typeof f.session === 'string' ? f.session : f.session?.id;
        if (incoming && model.selected && incoming !== model.selected) return;
        if (!model.online && !f.agent && f.type !== 'snapshot' && f.type !== 'sessions') return;
        const before = model.state;
        const previous = model.selected;
        if (f.type === 'sessions' || f.type === 'snapshot') saveDraft();
        applyFrame(model, f);
        if (f.type === 'approval') pendingApprovals.delete(String(f.id));
        if (previous !== model.selected) {
          // A first descriptor identifies the draft typed while this session was connecting.
          if (previous === null && input.value && model.selected && !drafts.has(draftKey())) {
            drafts.set(draftKey(), { text: input.value, attached: context(), detached });
          }
          if (previous === null && model.selected) drafts.delete(JSON.stringify([boardUrl, null]));
          shown.clear();
          expanded.clear();
          rendered.clear();
          pendingApprovals.clear();
          log.textContent = '';
          restoreDraft();
        }
        if (f.type === 'sessions') {
          const preferred = selections.get(boardUrl);
          if (preferred && preferred !== model.selected && model.sessions.some(s => s.id === preferred)) {
            selectSession(preferred);
            return;
          }
        }
        if (model.selected) selections.set(boardUrl, model.selected);
        if (f.type === 'sessions' && model.sessions.length) arrive();
        const watching = open && document.hasFocus() && document.visibilityState === 'visible';
        if (f.type === 'state' && before === 'working' && f.state === 'idle') chime('done', watching);
        if ((f.type === 'notice' && f.tone === 'attention') || (f.type === 'approval' && f.status === 'pending')) chime('attention', watching);
        if (f.type === 'snapshot') {
          shown.clear();
          rendered.clear();
          pendingApprovals.clear();
          log.textContent = '';
          for (const item of model.items) if (item.kind === 'text') shown.set(item.message, item.text.length);
        }
        if (model.state === 'working' && before !== 'working') workingSince = Date.now();
        if (model.online && !wasOnline) arrive();
        wasOnline = model.online;
        if (f.type === 'snapshot') reportViewing();
        if (!open && f.type === 'text') unread = true;
        if (f.type === 'text' && log.querySelector(`[data-message="${CSS.escape(String(f.message))}"]`)) {
          renderStatus();
          return animate();
        }
        render();
      },
    });
    connection = current;
    current.start();
  }

  function disconnect(): void {
    const previous = connection;
    connection = null;
    previous?.close();
    model.online = false;
    model.connection = 'offline';
    wasOnline = false;
  }

  /** The panel comes to the person once per board, unless they closed it there. A phone keeps the board. */
  function arrive(): void {
    if (open || drawing || sessionStorage.getItem(closedKey()) || !docked() || opts.canAutoOpen?.() === false) return;
    setOpen(true);
  }

  function setDrawing(next: boolean): void {
    drawing = next;
    document.documentElement.toggleAttribute('data-agent-drawing', next);
    back.hidden = !next;
    renderStatus();
  }

  function setOpen(next: boolean, byPerson = false): void {
    if (next || byPerson) setDrawing(false);
    if (next === open) return;
    if (next) opts.onOpen?.();
    open = next;
    draw.hidden = !next;
    panel.hidden = !next;
    chatButton.setAttribute('aria-expanded', String(next));
    document.documentElement.toggleAttribute('data-agent-chat', next);
    reportViewing();
    boardResized();
    if (docked()) opts.boardWidthChanged?.(next ? -width : width);
    if (next) {
      unread = false;
      sessionStorage.removeItem(closedKey());
      for (const item of model.items) if (item.kind === 'text' && item.final) shown.set(item.message, item.text.length);
      rendered.clear();
      log.textContent = '';
      render();
      if (byPerson) input.focus();
    } else {
      if (byPerson) {
        sessionStorage.setItem(closedKey(), '1');
        chatButton.focus();
      }
      renderStatus();
    }
  }

  chatButton.addEventListener('click', () => setOpen(!open, true));
  panel.addEventListener('keydown', ev => ev.stopPropagation());
  renderStatus();

  return {
    get online(): boolean { return model.online; },
    close(): void { setOpen(false, true); },
    /** Capture the destination before a board action saves; never forward into a later conversation. */
    prepareMessage(text: string, attached?: string): ((wake?: boolean) => boolean) | undefined {
      if ((!open && !drawing) || !model.online || !text.trim()) return;
      const target = { connection, boardUrl, selected: model.selected };
      let sent = false;
      return (wake = true) => {
        if (sent || !model.online || connection !== target.connection || boardUrl !== target.boardUrl || opts.url() !== target.boardUrl || model.selected !== target.selected) return false;
        if (!frame({ type: wake ? 'send' : 'receipt', id: `b${Date.now()}-${nextId++}`, text, ...(attached ? { context: attached } : {}) })) return false;
        sent = true;
        stickToEnd = true;
        if (drawing) setOpen(true, true);
        render();
        return true;
      };
    },
    /** Shown only to someone with a linked agent: anyone else could not connect anyway. */
    setAvailable(next: boolean): void {
      chatButton.hidden = !next;
      if (next === available) return;
      available = next;
      if (next) connect();
      else {
        setDrawing(false);
        setOpen(false);
        disconnect();
      }
    },
    /** A pairing link was opened: ask the person, and run it only on their answer. */
    offerPair(run: () => Promise<'linked' | 'already'>): void {
      pairing = { run, busy: false, failed: false };
      if (open) render();
      else setOpen(true);
    },
    /** The canvas selection or the agent's whereabouts changed. */
    refresh(): void {
      const selected = opts.selection();
      if (selected !== lastSelection) {
        lastSelection = selected;
        draftContext = null;
      }
      if (open) render();
      // Only an agent drawing now calls the panel over; an old session waits until the person opens it.
      else if (!model.online && opts.agentElsewhere?.()?.live) arrive();
    },
    /** Another board is on screen: another chat channel, and a fresh snapshot from its helper. */
    switchBoard(): void {
      saveDraft();
      setDrawing(false);
      if (model.selected) selections.set(boardUrl, model.selected);
      setOpen(false);
      disconnect();
      Object.assign(model, emptyChat());
      shown.clear();
      expanded.clear();
      switchingBoard = true;
      const version = ++boardVersion;
      // The canvas calls this before updating its board id.
      queueMicrotask(() => {
        if (version !== boardVersion) return;
        switchingBoard = false;
        boardUrl = opts.url();
        restoreDraft();
        if (available) connect();
      });
    },
  };
}
