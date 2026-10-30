/**
 * "Connect an agent" (hosted MCP spec §6, §12). It sets up the viewer's own
 * agent, which opens a board for its task (Decision 9), never the board on
 * screen. The copy lives in shared/connect-guide.ts (the dashboard shows the
 * same steps); this module renders it into index.html #connect and runs the
 * modal, the tabs, the copy controls and the live line.
 */

import { boardHref } from '../../shared/board-link';
import { CONNECT_FOOTER, connectGuide, type GuideBox, type GuideStep } from '../../shared/connect-guide';
import type { Participant, Selection } from './module_bindings/types';
import { copyText, flashLabel } from './chrome';
import { strokeIcon } from './icons';
import type { Command } from './palette';
import { presenceOf } from './presence';

export const LEAD_SIGNED_OUT =
  'Your agent opens a board for its task and draws what it builds. It asks you to sign in to redcrayon the first time it connects.';

export const leadSignedIn = (name: string): string =>
  `Your agent opens a board for its task and draws what it builds. It signs in as you and shows as agent of ${name}.`;

/** The last tab chosen, reopened next time. */
export const TAB_KEY = 'rc_connect_tab';

/** Where the viewer's agent is drawing. `agent` is its display name (`agent of <name>`). */
export interface AgentBoard {
  agent: string;
  board: string;
  boardId: bigint;
  /** Its #b= link id ('' for a board without one yet). */
  slug: string;
  /** That board is the one on screen. */
  here: boolean;
}

export type Viewer = { signedIn: false } | { signedIn: true; name: string; agent: AgentBoard | null };

const CURSOR_MARK = 'M8 1.75 13.5 4.9v6.2L8 14.25 2.5 11.1V4.9ZM2.5 4.9 8 8l5.5-3.1M8 8v6.25';
const TAB_MARKS: Record<string, string> = {
  claude: 'M8 1.75v3.75M8 10.5v3.75M1.75 8h3.75M10.5 8h3.75M3.58 3.58l2.65 2.65M9.77 9.77l2.65 2.65M12.42 3.58 9.77 6.23M6.23 9.77l-2.65 2.65',
  cursor: CURSOR_MARK,
  codex: 'M3.75 2.75h8.5a2 2 0 0 1 2 2v6.5a2 2 0 0 1-2 2h-8.5a2 2 0 0 1-2-2v-6.5a2 2 0 0 1 2-2ZM4.75 6.25 6.75 8l-2 1.75M8.5 9.75h2.75',
  'claude-ai': 'M3.75 2.75h8.5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7.5l-3 2.5v-2.5h-.75a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1ZM5.5 6.75h5',
  other:
    'M6 2.75h-.5A1.5 1.5 0 0 0 4 4.25v2A1.75 1.75 0 0 1 2.25 8 1.75 1.75 0 0 1 4 9.75v2a1.5 1.5 0 0 0 1.5 1.5H6M10 2.75h.5A1.5 1.5 0 0 1 12 4.25v2A1.75 1.75 0 0 0 13.75 8 1.75 1.75 0 0 0 12 9.75v2a1.5 1.5 0 0 1-1.5 1.5H10',
};

/**
 * The board the viewer's agent is on: an agent the viewer linked
 * (my_agent_links, owner = viewer), still present by D17, with a selection
 * row on a board this tab can read. The most recent call wins.
 */
export function findAgentBoard(s: {
  me: string;
  links: Iterable<{ agent: { toHexString(): string }; owner: { toHexString(): string } }>;
  participants: Iterable<Participant>;
  selections: Iterable<Selection>;
  boards: Iterable<{ id: bigint; name: string; slug: string }>;
  onScreen: bigint | undefined;
  now: number;
}): AgentBoard | null {
  const mine = new Set([...s.links].filter(l => l.owner.toHexString() === s.me).map(l => l.agent.toHexString()));
  const boardOf = new Map([...s.selections].map(sel => [sel.identity.toHexString(), sel.boardId]));
  const byId = new Map([...s.boards].map(b => [b.id, b]));
  let best: AgentBoard | null = null;
  let bestSeen = -Infinity;
  for (const p of s.participants) {
    const hex = p.identity.toHexString();
    const boardId = boardOf.get(hex);
    const board = boardId === undefined ? undefined : byId.get(boardId);
    const seen = p.lastSeenAt.toDate().getTime();
    if (!mine.has(hex) || board === undefined || presenceOf(p, s.now) === 'gone' || seen <= bestSeen) {
      continue;
    }
    best = { agent: p.displayName, board: board.name, boardId: boardId!, slug: board.slug, here: boardId === s.onScreen };
    bestSeen = seen;
  }
  return best;
}

/** The ⌘K entry: the header button's words, and `mcp` finds it too. */
export const connectCommand = (open: () => void): Command => ({
  id: 'connect-agent',
  group: 'General',
  title: 'Connect an agent',
  keywords: ['mcp'],
  run: open,
});

export function liveText(v: Viewer): string {
  if (!v.signedIn) return "Sign in to see your agent's boards here.";
  if (v.agent === null) return 'Waiting for your agent.';
  return `${v.agent.agent} is drawing on ${v.agent.here ? 'this board' : v.agent.board}.`;
}

/** Another board on this page's database. Boot leaves ?db= on the page only when it is not this build's home, so copy it as-is. */
const agentBoardHref = (slug: string): string =>
  boardHref({ app: location.href, slug, db: new URLSearchParams(location.search).get('db') ?? '', home: '' });

function make<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function codeBox(box: GuideBox): HTMLElement {
  const wrap = make('div', box.label === 'prompt' ? 'connect-code connect-prompt' : 'connect-code');
  const bar = make('div', 'connect-code-bar');
  const copy = make('button', 'ctl', 'copy');
  copy.dataset.act = 'copy';
  copy.setAttribute('aria-label', `Copy the ${box.name}`);
  bar.append(make('span', '', box.label), copy);
  const pre = make('pre', '');
  pre.append(make('code', '', box.text));
  wrap.append(bar, pre);
  return wrap;
}

function stepItem(step: GuideStep): HTMLLIElement {
  const li = make('li', '');
  li.append(make('span', 'connect-step-title', step.title));
  if (step.text) li.append(make('p', 'connect-text', step.text));
  if (step.link) {
    const a = make('a', 'btn-primary connect-cursor');
    a.href = step.link.href;
    a.append(strokeIcon('', CURSOR_MARK, '14'), step.link.text);
    li.append(a);
  }
  for (const box of step.boxes ?? []) li.append(codeBox(box));
  if (step.note) li.append(make('p', 'connect-note', step.note));
  if (step.more) {
    const details = make('details', 'connect-manual');
    const summary = make('summary', '');
    summary.append(strokeIcon('', 'M6.5 4.5 10 8l-3.5 3.5'), step.more.summary);
    details.append(summary, codeBox(step.more.box));
    li.append(details);
  }
  return li;
}

/**
 * Wire the dialog (index.html #connect) to #act-connect and #empty-connect,
 * building its tabs from the guide. Without a hosted server URL every opener
 * goes and the dialog stays inert. An anonymous viewer gets the sign-in card
 * instead of the guide, since the agent links to an account; with no sign-in
 * available (anonymous dev mode) the guide opens as it always did. Modal:
 * focus stays inside the panel,
 * Escape (window capture, so the canvas's own Escape waits) or a backdrop
 * pointerdown closes it, and every key stops at the panel so canvas
 * shortcuts never fire behind it. The agent row is an ARIA tablist: roving
 * tabindex, arrows / Home / End move along it and wrap.
 */
export function setupConnect(
  url: string | undefined,
  opts: { viewer: () => Viewer; signIn?: () => void | Promise<void>; privacyUrl?: string }
): { open(): void; refresh(): void } {
  const root = document.getElementById('connect');
  const panel = document.getElementById('connect-panel');
  const tabRow = document.getElementById('connect-tabs');
  const panes = document.getElementById('connect-panes');
  const opener = document.getElementById('act-connect');
  const inert = { open: () => {}, refresh: () => {} };
  if (url === undefined || root === null || panel === null || tabRow === null || panes === null) {
    // No hosted server to point an agent at yet: offer no way in.
    opener?.remove();
    document.getElementById('empty-connect')?.remove();
    return inert;
  }
  if (opener !== null) opener.hidden = false;

  const guide = connectGuide(url);
  for (const t of guide) {
    const tab = make('button', '');
    tab.setAttribute('role', 'tab');
    tab.id = `connect-tab-${t.id}`;
    tab.dataset.connectTab = t.id;
    tab.setAttribute('aria-controls', `connect-pane-${t.id}`);
    tab.append(strokeIcon('', TAB_MARKS[t.id], '14'), make('span', '', t.label));
    tabRow.append(tab);
    const pane = make('section', '');
    pane.setAttribute('role', 'tabpanel');
    pane.id = `connect-pane-${t.id}`;
    pane.dataset.connectPane = t.id;
    pane.setAttribute('aria-labelledby', tab.id);
    const steps = make('ol', 'connect-steps');
    steps.append(...t.steps.map(stepItem));
    pane.append(steps);
    panes.append(pane);
  }
  const foot = CONNECT_FOOTER.map(line => make('p', '', line));
  if (opts.privacyUrl) {
    const a = make('a', '', 'Privacy policy');
    a.href = opts.privacyUrl;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    const p = make('p', '');
    p.append(a);
    foot.push(p);
  }
  document.getElementById('connect-foot')?.replaceChildren(...foot);

  const tabs = [...tabRow.querySelectorAll<HTMLElement>('[data-connect-tab]')];
  const saved = localStorage.getItem(TAB_KEY);
  let tab = guide.some(t => t.id === saved) ? saved! : 'claude';
  let returnFocus: HTMLElement | null = null;

  const show = (next: string, focus = false): void => {
    tab = next;
    for (const b of tabs) {
      const on = b.dataset.connectTab === tab;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
      if (on && focus) b.focus();
    }
    for (const p of panes.querySelectorAll<HTMLElement>('[data-connect-pane]')) p.hidden = p.dataset.connectPane !== tab;
  };
  const choose = (next: string): void => {
    localStorage.setItem(TAB_KEY, next);
    show(next, true);
  };
  show(tab);

  const lead = document.getElementById('connect-lead');
  const live = document.getElementById('connect-live');
  const liveLine = document.getElementById('connect-live-text');
  let shownLive = '';
  // A polite live region speaks on every change: touch it only when the words do.
  const renderLive = (): void => {
    const v = opts.viewer();
    const text = liveText(v);
    const key = `${text}\n${v.signedIn ? v.agent?.boardId ?? '' : ''}`;
    if (key === shownLive || lead === null || live === null || liveLine === null) return;
    shownLive = key;
    lead.textContent = v.signedIn ? leadSignedIn(v.name) : LEAD_SIGNED_OUT;
    live.classList.toggle('on', v.signedIn && v.agent !== null);
    if (v.signedIn && v.agent !== null && !v.agent.here && v.agent.slug) {
      const link = make('a', 'connect-open', 'open');
      link.href = agentBoardHref(v.agent.slug);
      liveLine.replaceChildren(`${text} `, link);
    } else {
      liveLine.textContent = text;
    }
  };

  // Reachable by Tab: not an unselected tab, not in a hidden pane, not folded in a closed <details>.
  const focusable = () =>
    [...panel.querySelectorAll<HTMLElement>('button, a[href], summary')].filter(
      el => el.tabIndex >= 0 && el.closest('[hidden], details:not([open]) > :not(summary)') === null
    );

  const open = (): void => {
    // An agent links to an account, so ask an anonymous viewer for one first.
    if (!opts.viewer().signedIn && opts.signIn) {
      void opts.signIn();
      return;
    }
    renderLive();
    // From ⌘K the focused palette input is already hidden: return to the header button instead.
    const prev = document.activeElement;
    returnFocus = prev instanceof HTMLElement && prev.closest('[hidden]') === null ? prev : opener;
    root.hidden = false;
    opener?.setAttribute('aria-expanded', 'true');
    show(tab, true);
  };
  const close = (): void => {
    root.hidden = true;
    opener?.setAttribute('aria-expanded', 'false');
    returnFocus?.focus();
  };

  opener?.addEventListener('click', open);
  document.getElementById('empty-connect')?.addEventListener('click', open);
  root.addEventListener('pointerdown', evt => {
    if (evt.target !== root) return;
    // Else the mousedown that follows focuses the now-hidden backdrop, dropping focus to <body>.
    evt.preventDefault();
    close();
  });
  panel.addEventListener('click', evt => {
    const el = (evt.target as Element).closest<HTMLElement>('[data-connect-tab], [data-act]');
    if (el?.dataset.connectTab !== undefined) choose(el.dataset.connectTab);
    else if (el?.dataset.act === 'close') close();
    else if (el?.dataset.act === 'copy') {
      const code = el.closest('.connect-code')?.querySelector('code');
      void copyText(code?.textContent ?? '').then(ok => {
        flashLabel(el, ok, 'copy');
        // No clipboard (insecure origin, denied): leave the text selected for a keyboard copy.
        if (!ok && code) window.getSelection()?.selectAllChildren(code);
      });
    }
  });
  panel.addEventListener('keydown', evt => {
    evt.stopPropagation();
    const at = tabs.indexOf(evt.target as HTMLElement);
    const to = at < 0 ? undefined : { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: tabs.length - 1 }[evt.key];
    if (to !== undefined) {
      evt.preventDefault();
      choose(tabs[(to + tabs.length) % tabs.length].dataset.connectTab!);
      return;
    }
    if (evt.key !== 'Tab') return;
    const items = focusable();
    const pos = items.indexOf(document.activeElement as HTMLElement);
    if (evt.shiftKey ? pos <= 0 : pos === items.length - 1) {
      evt.preventDefault();
      items[evt.shiftKey ? items.length - 1 : 0]?.focus();
    }
  });
  window.addEventListener(
    'keydown',
    evt => {
      if (evt.key === 'Escape' && !root.hidden) {
        close();
        evt.preventDefault();
        evt.stopPropagation();
      }
    },
    true
  );
  return {
    open,
    refresh: () => {
      if (!root.hidden) renderLive();
    },
  };
}
