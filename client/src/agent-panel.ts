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

/** One conversation per board, so the key drops the query (?db= and the like) but keeps the #b= link. */
function conversationKey(boardLink: string): string {
  const q = boardLink.indexOf('?');
  if (q === -1) return `agent-conversation:${boardLink}`;
  const hash = boardLink.indexOf('#', q);
  return `agent-conversation:${boardLink.slice(0, q)}${hash === -1 ? '' : boardLink.slice(hash)}`;
}

const newConversationId = () => `c-${crypto.randomUUID()}`;
const validId = (id: string | null): id is string => id !== null && id.length <= 128 && /^[A-Za-z0-9:_-]+$/.test(id);

export function mountAgentPanel(deps: AgentPanelDeps): { selectionChanged(): void } {
  const storage = deps.storage ?? localStorage;
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const orb = $<HTMLButtonElement>('agent-orb');
  const panel = $<HTMLElement>('agent-panel');
  const msgs = $<HTMLOListElement>('agent-msgs');
  const about = $<HTMLElement>('agent-about');
  const form = $<HTMLFormElement>('agent-form');
  const input = $<HTMLTextAreaElement>('agent-input');
  const send = $<HTMLButtonElement>('agent-send');

  let state: ChatState = initialChat();
  // The reply streaming now; New chat aborts it and drops whatever it says after.
  let running: AbortController | null = null;
  // The node whose chip the person cleared; it stays hidden until the selection changes.
  let cleared: bigint | undefined;

  const conversationId = (): string => {
    const key = conversationKey(deps.boardLink());
    const stored = storage.getItem(key);
    if (validId(stored)) return stored;
    const id = newConversationId();
    storage.setItem(key, id);
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
    const body: ChatBody = {
      message,
      conversationId: conversationId(),
      messageId: crypto.randomUUID(),
      boardLink: deps.boardLink(),
      ...(node ? { focus: { nodeId: String(node.id), label: node.label.slice(0, LABEL_MAX) } } : {}),
    };
    input.value = '';
    dispatch({ type: 'send', text: message });
    const ctrl = new AbortController();
    running = ctrl;
    const token = await deps.token().catch(() => null);
    if (ctrl.signal.aborted) return;
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
    storage.setItem(conversationKey(deps.boardLink()), newConversationId());
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
