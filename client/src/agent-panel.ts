// Chat with a hosted agent from the board: #agent-orb opens #agent-panel, whose
// reply streams in with status lines. With one node selected, an "About" chip
// scopes the message to that node.
import { streamChat, type ChatBody } from './agent-stream';
import { chatReducer, initialChat, type ChatAction, type ChatState } from './agent-chat';

export interface AgentPanelDeps {
  /** The agent server; the chat endpoint is `<url>/chat`. */
  url: string;
  /** The bearer token for this person, or null to send none. */
  token: () => Promise<string | null>;
  /** The link of the board on screen, which the agent opens. */
  boardLink: () => string;
  /** The node the message is about: exactly one selected node, else undefined. */
  selectedNode: () => { id: bigint; label: string } | undefined;
  storage?: Storage;
  fetchImpl?: typeof fetch;
}

const LABEL_MAX = 200;

// The panel's width: dragged or set with the arrow keys on its left edge, and remembered.
const WIDTH_KEY = 'agent-panel-width';
const WIDTH_DEFAULT = 320;
const WIDTH_MIN = 280;
const WIDTH_STEP = 24;
const widthMax = () => Math.floor(window.innerWidth * 0.7);
const clampWidth = (w: number) => Math.max(WIDTH_MIN, Math.min(widthMax(), Math.round(w)));

/** One conversation per board: keyed on its #b=<slug>. A Share-link visit has no slug, and
 *  its #s= token must not sit in storage, so it is keyed on a short one-way hash of the link. */
async function conversationKey(boardLink: string): Promise<string> {
  const hash = boardLink.indexOf('#');
  const slug = hash === -1 ? null : new URLSearchParams(boardLink.slice(hash + 1)).get('b');
  if (slug) return `agent-conversation:${slug}`;
  return `agent-conversation:${await shortHash(boardLink)}`;
}

/** First 16 hex chars of the text's SHA-256. Pages on a plain-http origin have no
 *  crypto.subtle, so they fall back to two FNV-1a passes: still one-way enough to keep a token out. */
async function shortHash(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  try {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
  } catch {
    const fnv = (seed: number) => {
      let h = seed;
      for (const b of bytes) h = Math.imul(h ^ b, 0x01000193) >>> 0;
      return h.toString(16).padStart(8, '0');
    };
    return fnv(0x811c9dc5) + fnv(0x050c5d1f);
  }
}

/** A random id; pages on a plain-http origin have no crypto.randomUUID. */
function randomId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `${Date.now().toString(16)}-${[...bytes].map(b => b.toString(16).padStart(2, '0')).join('')}`;
}

const newConversationId = () => `c-${randomId()}`;
const validId = (id: string | null): id is string => id !== null && id.length <= 128 && /^[A-Za-z0-9:_-]+$/.test(id);

export function mountAgentPanel(deps: AgentPanelDeps): { selectionChanged(): void } {
  // Reading localStorage itself can throw when the browser blocks storage.
  let storage: Storage | undefined;
  try { storage = deps.storage ?? localStorage; } catch { storage = undefined; }
  // Ids for this page, so a blocked storage still keeps one conversation going.
  const memory = new Map<string, string>();
  const load = (key: string): string | null => {
    try { return storage?.getItem(key) ?? null; } catch { return null; }
  };
  const save = (key: string, id: string) => {
    memory.set(key, id);
    try { storage?.setItem(key, id); } catch { /* the in-memory id serves this page */ }
  };
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const orb = $<HTMLButtonElement>('agent-orb');
  const panel = $<HTMLElement>('agent-panel');
  const msgs = $<HTMLOListElement>('agent-msgs');
  const about = $<HTMLElement>('agent-about');
  const form = $<HTMLFormElement>('agent-form');
  const input = $<HTMLTextAreaElement>('agent-input');
  const send = $<HTMLButtonElement>('agent-send');
  const resize = $<HTMLElement>('agent-resize');

  // An earlier version keyed Share-link conversations on the link itself, token and all.
  try {
    const old: string[] = [];
    for (let i = 0; storage && i < storage.length; i++) {
      const key = storage.key(i);
      if (key?.startsWith('agent-conversation:') && key.includes('#s=')) old.push(key);
    }
    for (const key of old) storage?.removeItem(key);
  } catch { /* storage is blocked: nothing was kept there either */ }

  // The width the person chose; shown clamped to the window.
  let wanted = WIDTH_DEFAULT;
  const stored = Number(load(WIDTH_KEY) ?? NaN);
  if (Number.isFinite(stored) && stored >= WIDTH_MIN && stored <= widthMax()) wanted = Math.round(stored);
  const showWidth = () => {
    const w = clampWidth(wanted);
    document.body.style.setProperty('--agent-panel-w', `${w}px`);
    resize.setAttribute('aria-valuenow', String(w));
    resize.setAttribute('aria-valuemin', String(WIDTH_MIN));
    resize.setAttribute('aria-valuemax', String(Math.max(WIDTH_MIN, widthMax())));
  };
  const setWidth = (w: number, remember: boolean) => {
    wanted = clampWidth(w);
    showWidth();
    if (remember) {
      try { storage?.setItem(WIDTH_KEY, String(wanted)); } catch { /* kept for this page only */ }
    }
  };

  let state: ChatState = initialChat();
  // The reply streaming now; New chat aborts it and drops whatever it says after.
  let running: AbortController | null = null;
  // The node whose chip the person cleared; it stays hidden until the selection changes.
  let cleared: bigint | undefined;

  // New chat's id write; a send right after it waits for it, so it never reads the old id.
  let starting: Promise<void> = Promise.resolve();
  const conversationId = async (): Promise<string> => {
    await starting;
    const key = await conversationKey(deps.boardLink());
    const stored = load(key);
    if (validId(stored)) return stored;
    const known = memory.get(key);
    if (known) return known;
    const id = newConversationId();
    save(key, id);
    return id;
  };

  const focusNode = () => {
    const node = deps.selectedNode();
    return node && node.id !== cleared ? node : undefined;
  };

  const renderAbout = () => {
    const node = focusNode();
    about.hidden = node === undefined;
    about.querySelector('b')!.textContent = node?.label ?? '';
  };

  const render = () => {
    let lastStatus = -1;
    state.items.forEach((item, i) => { if (item.kind === 'status') lastStatus = i; });
    msgs.replaceChildren(...state.items.map((item, i) => {
      const li = document.createElement('li');
      li.className = `agent-msg agent-${item.kind}`;
      // The newest status line is still under way while the reply streams.
      if (state.sending && i === lastStatus) li.classList.add('run');
      li.textContent = item.text;
      return li;
    }));
    send.disabled = state.sending;
    msgs.scrollTop = msgs.scrollHeight;
  };

  const dispatch = (action: ChatAction) => {
    state = chatReducer(state, action);
    render();
  };

  const open = (on: boolean) => {
    panel.hidden = !on;
    orb.hidden = on;
    orb.setAttribute('aria-expanded', on ? 'true' : 'false');
    document.body.classList.toggle('agent-open', on);
    if (on) {
      renderAbout();
      input.focus();
    } else {
      orb.focus();
    }
  };

  const submit = async () => {
    const message = input.value.trim();
    if (!message || state.sending) return;
    const node = focusNode();
    const boardLink = deps.boardLink();
    input.value = '';
    dispatch({ type: 'send', text: message });
    const ctrl = new AbortController();
    running = ctrl;
    let conversation: string;
    let token: string | null;
    let messageId: string;
    try {
      [conversation, token] = await Promise.all([conversationId(), deps.token().catch(() => null)]);
      messageId = randomId();
    } catch {
      if (running !== ctrl) return;
      running = null;
      dispatch({ type: 'event', event: { type: 'error', code: 'internal', message: 'Something went wrong. Try again.' } });
      dispatch({ type: 'ended', how: 'error' });
      return;
    }
    if (ctrl.signal.aborted) return;
    const body: ChatBody = {
      message,
      conversationId: conversation,
      messageId,
      boardLink,
      ...(node ? { focus: { nodeId: String(node.id), label: node.label.slice(0, LABEL_MAX) } } : {}),
    };
    const how = await streamChat({
      url: deps.url,
      token,
      body,
      signal: ctrl.signal,
      fetchImpl: deps.fetchImpl,
      onEvent: event => { if (running === ctrl) dispatch({ type: 'event', event }); },
    });
    // A deliberate abort (New chat) already reset the chat: no "connection dropped" line.
    if (running !== ctrl) return;
    running = null;
    dispatch({ type: 'ended', how });
  };

  orb.addEventListener('click', () => open(true));
  $<HTMLButtonElement>('agent-close').addEventListener('click', () => open(false));
  panel.addEventListener('keydown', evt => {
    if (evt.key !== 'Escape') return;
    evt.stopPropagation(); // the canvas's own Escape would clear the selection
    open(false);
  });
  $<HTMLButtonElement>('agent-new').addEventListener('click', () => {
    running?.abort();
    running = null;
    const link = deps.boardLink();
    // a failed write leaves the old id; the next send makes one if none is kept
    starting = starting.then(async () => save(await conversationKey(link), newConversationId())).catch(() => {});
    state = initialChat();
    render();
    input.focus();
  });
  $<HTMLButtonElement>('agent-about-clear').addEventListener('click', () => {
    cleared = deps.selectedNode()?.id;
    renderAbout();
    input.focus();
  });
  form.addEventListener('submit', evt => {
    evt.preventDefault();
    void submit();
  });
  input.addEventListener('keydown', evt => {
    if (evt.key !== 'Enter' || evt.shiftKey || evt.isComposing) return;
    evt.preventDefault();
    void submit();
  });

  let drag: { x: number; w: number } | null = null;
  const endDrag = () => {
    if (!drag) return;
    drag = null;
    resize.classList.remove('drag');
    document.body.classList.remove('agent-resizing');
    setWidth(wanted, true);
  };
  resize.addEventListener('pointerdown', evt => {
    if (evt.button !== 0) return;
    evt.preventDefault(); // no text selection while dragging
    resize.setPointerCapture?.(evt.pointerId);
    drag = { x: evt.clientX, w: clampWidth(wanted) };
    resize.classList.add('drag');
    document.body.classList.add('agent-resizing');
  });
  resize.addEventListener('pointermove', evt => {
    // the panel is docked right: moving the edge left widens it
    if (drag) setWidth(drag.w + drag.x - evt.clientX, false);
  });
  resize.addEventListener('pointerup', endDrag);
  resize.addEventListener('pointercancel', endDrag);
  resize.addEventListener('lostpointercapture', endDrag);
  resize.addEventListener('keydown', evt => {
    if (evt.key !== 'ArrowLeft' && evt.key !== 'ArrowRight') return;
    evt.preventDefault();
    evt.stopPropagation(); // these arrows belong to the handle alone
    setWidth(clampWidth(wanted) + (evt.key === 'ArrowLeft' ? WIDTH_STEP : -WIDTH_STEP), true);
  });
  resize.addEventListener('dblclick', () => setWidth(WIDTH_DEFAULT, true));
  window.addEventListener('resize', showWidth);

  showWidth();
  orb.hidden = false;
  renderAbout();
  render();

  return {
    selectionChanged() {
      if (deps.selectedNode()?.id !== cleared) cleared = undefined;
      renderAbout();
    },
  };
}
