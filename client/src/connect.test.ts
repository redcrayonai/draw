import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import html from '../index.html?raw';
import {
  CONNECT_FOOTER,
  CONNECT_PROMPT,
  base64Utf8,
  connectGuide,
  cursorInstallUrl,
  readMcpUrl,
  type GuideTab,
} from '../../shared/connect-guide';
import { filterCommands } from './palette';
import type { Participant, Selection } from './module_bindings/types';

type Connect = typeof import('./connect');
let connect: Connect;

beforeAll(async () => {
  // connect.ts pulls in chrome.ts, whose module body wires the real markup.
  document.body.innerHTML = html;
  localStorage.removeItem('rc_connect_tab');
  connect = await import('./connect');
});

const MCP = 'https://mcp.example.com/mcp';
const SLUG = 'c4bb879c7355360696d9';
const CURSOR = 'cursor://anysphere.cursor-deeplink/mcp/install?name=draw&config=';
const JSON_CONFIG = `{
  "mcpServers": {
    "draw": {
      "url": "https://mcp.example.com/mcp"
    }
  }
}`;
const PROMPT = 'Open a redcrayon board for this task and draw what you build on it as you go.';
const LEAD_IN = 'Your agent opens a board for its task and draws what it builds. It signs in as you and shows as agent of Alan Lee.';
const LEAD_OUT =
  'Your agent opens a board for its task and draws what it builds. It asks you to sign in to redcrayon the first time it connects.';
const FOOTER = [
  'Drawing needs only the URL. To check code refs, redcrayon uploads each file your agent cites and deletes it within 10 minutes. It keeps paths, line numbers, git hashes, hashes of the cited lines and the GitHub repo address. It keeps the cited lines themselves only if you turn on storing code.',
  'Boards your agent opens are private to your account until you share them from your dashboard.',
];

/** The config a Cursor install link carries, decoded as Cursor would. */
function cursorConfig(url: string): unknown {
  expect(url.startsWith(CURSOR)).toBe(true);
  const b64 = decodeURIComponent(url.slice(CURSOR.length));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), c => c.charCodeAt(0))));
}

/** Every string a tab shows, in display order; boxes as `[caption] text`. */
function outline(tab: GuideTab): string[][] {
  return tab.steps.map(s => [
    s.title,
    ...(s.text ? [s.text] : []),
    ...(s.link ? [`<${s.link.text}>`] : []),
    ...(s.boxes ?? []).map(b => `[${b.label}] ${b.text}`),
    ...(s.note ? [s.note] : []),
    ...(s.more ? [s.more.summary, `[${s.more.box.label}] ${s.more.box.text}`] : []),
  ]);
}

describe('connect guide (§12 copy, exact)', () => {
  const guide = connectGuide(MCP);

  it('has five tabs in order', () => {
    expect(guide.map(t => [t.id, t.label])).toEqual([
      ['claude', 'Claude Code'],
      ['cursor', 'Cursor'],
      ['codex', 'Codex'],
      ['claude-ai', 'claude.ai'],
      ['other', 'Other'],
    ]);
  });

  it('Claude Code adds the hosted server, signs in through /mcp, then draws', () => {
    expect(outline(guide[0])).toEqual([
      ['Add the server', `[terminal] claude mcp add --transport http --scope user draw ${MCP}`],
      ['Sign in', 'Start Claude Code in your project, run /mcp, choose draw, then Authenticate. Approve in the browser tab that opens.'],
      ['Start drawing', `[prompt] ${PROMPT}`],
    ]);
  });

  it('Cursor leads with the one-click install and folds the manual config away', () => {
    expect(outline(guide[1])).toEqual([
      ['Add the server', '<add to Cursor>', 'Opens Cursor and asks you to confirm.', 'Or paste it into ~/.cursor/mcp.json', `[~/.cursor/mcp.json] ${JSON_CONFIG}`],
      ['Sign in', 'In Cursor Settings → MCP, draw shows a login button. Click it and approve in the browser.'],
      ['Start drawing', `[prompt] ${PROMPT}`],
    ]);
  });

  it('Codex adds the URL and logs in', () => {
    expect(outline(guide[2])).toEqual([
      ['Add the server', '[terminal] codex mcp add draw --url https://mcp.example.com/mcp'],
      ['Sign in', '[terminal] codex mcp login draw', 'A browser tab opens. Approve, then start codex in your project.'],
      ['Start drawing', `[prompt] ${PROMPT}`],
    ]);
  });

  it('claude.ai adds a custom connector', () => {
    expect(outline(guide[3])).toEqual([
      [
        'Add the connector',
        'In claude.ai: Customize → Connectors → Add custom connector. Name it draw and paste this URL.',
        `[url] ${MCP}`,
        'On Team and Enterprise plans an owner adds it once for everyone.',
      ],
      ['Sign in', 'Click Connect next to draw and approve in the tab that opens.'],
      ['Start drawing', `[prompt] ${PROMPT}`, 'claude.ai draws from the conversation. Code refs and checkpoints need a coding agent in your project.'],
    ]);
  });

  it('Other gives the URL and the mcp.json', () => {
    expect(outline(guide[4])).toEqual([
      ['Add the server', `[url] ${MCP}`, `[mcp.json] ${JSON_CONFIG}`, 'Any MCP client with remote servers and sign-in. VS Code uses "servers" and "type": "http".'],
      ['Sign in', 'Your client opens a browser to sign in the first time it connects.'],
      ['Start drawing', `[prompt] ${PROMPT}`],
    ]);
  });

  it('the prompt and the footer, exactly', () => {
    expect(CONNECT_PROMPT).toBe(PROMPT);
    expect(CONNECT_FOOTER).toEqual(FOOTER);
  });

  it('builds the Cursor link from URL-encoded base64 of {"url": …}, and it decodes back', () => {
    const href = guide[1].steps[0].link!.href;
    expect(href).toBe(CURSOR + encodeURIComponent(btoa('{"url":"https://mcp.example.com/mcp"}')));
    expect(cursorConfig(href)).toEqual({ url: MCP });
    // a '+' left raw would reach Cursor as a space
    expect(href.slice(CURSOR.length)).not.toMatch(/[+/=]/);
    for (const url of ['https://mcp.bøard.example/mcp', 'https://mcp.example.com/mcp?a>b~']) {
      expect(cursorConfig(cursorInstallUrl(url))).toEqual({ url });
    }
    expect(base64Utf8('{"url":"ø"}')).toBe('eyJ1cmwiOiLDuCJ9');
  });
});

const id = (hex: string) => ({ toHexString: () => hex });
const NOW = Date.UTC(2026, 9, 10, 12);
const agentRow = (hex: string, ageMs: number, displayName = `agent of ${hex}`) =>
  ({ identity: id(hex), displayName, kind: 'agent', connections: 0, lastSeenAt: { toDate: () => new Date(NOW - ageMs) } }) as unknown as Participant;
const sel = (hex: string, boardId: bigint) => ({ identity: id(hex), boardId, nodeIds: [] }) as unknown as Selection;

describe('findAgentBoard', () => {
  const find = (over: Partial<Parameters<Connect['findAgentBoard']>[0]> = {}) =>
    connect.findAgentBoard({
      me: 'me',
      links: [{ agent: id('a'), owner: id('me') }, { agent: id('b'), owner: id('someone') }],
      participants: [agentRow('a', 10_000, 'agent of Alan Lee'), agentRow('b', 0)],
      selections: [sel('a', 7n), sel('b', 8n)],
      boards: [{ id: 7n, name: 'checkout-flow', slug: SLUG }, { id: 8n, name: 'theirs', slug: 'b'.repeat(20) }],
      onScreen: 1n,
      now: NOW,
      ...over,
    });

  it("finds the board the viewer's own agent selects on, never another owner's agent", () => {
    expect(find()).toEqual({ agent: 'agent of Alan Lee', board: 'checkout-flow', boardId: 7n, slug: SLUG, here: false });
    expect(find({ onScreen: 7n })?.here).toBe(true);
  });

  it('waits while there is no link, no selection, no readable board, or D17 says the agent left', () => {
    expect(find({ links: [] })).toBeNull();
    expect(find({ selections: [] })).toBeNull();
    expect(find({ boards: [] })).toBeNull();
    expect(find({ participants: [agentRow('a', 31 * 60_000)] })).toBeNull();
    // dimmed (2 to 30 min) still counts
    expect(find({ participants: [agentRow('a', 12 * 60_000)] })?.boardId).toBe(7n);
  });

  it('the most recent of two linked agents wins', () => {
    const links = [{ agent: id('a'), owner: id('me') }, { agent: id('c'), owner: id('me') }];
    const participants = [agentRow('a', 60_000), agentRow('c', 5_000)];
    const selections = [sel('a', 7n), sel('c', 9n)];
    const boards = [{ id: 7n, name: 'old', slug: SLUG }, { id: 9n, name: 'new', slug: 'c'.repeat(20) }];
    expect(find({ links, participants, selections, boards })?.board).toBe('new');
  });
});

describe('Connect an agent dialog', () => {
  let viewer: import('./connect').Viewer = { signedIn: true, name: 'Alan Lee', agent: null };
  const signIn = vi.fn();
  let dialog: { open(): void; refresh(): void };
  const TABS = ['claude', 'cursor', 'codex', 'claude-ai', 'other'];
  const root = () => document.getElementById('connect') as HTMLDivElement;
  const panel = () => document.getElementById('connect-panel') as HTMLElement;
  const opener = () => document.getElementById('act-connect') as HTMLButtonElement;
  const closeBtn = () => panel().querySelector<HTMLButtonElement>('button[aria-label="Close"]')!;
  const tab = (t: string) => panel().querySelector<HTMLButtonElement>(`[data-connect-tab="${t}"]`)!;
  const pane = (t: string) => panel().querySelector<HTMLElement>(`[data-connect-pane="${t}"]`)!;
  const codes = (t: string) => [...pane(t).querySelectorAll('.connect-code pre > code')].map(c => c.textContent);
  const copyBtns = (t: string) => [...pane(t).querySelectorAll<HTMLButtonElement>('.connect-code .ctl[data-act="copy"]')];
  const live = () => document.getElementById('connect-live')!;
  const shownPanes = () =>
    [...panel().querySelectorAll<HTMLElement>('[data-connect-pane]')].filter(p => !p.hidden).map(p => p.dataset.connectPane);
  const open = () => {
    opener().focus();
    opener().click();
    expect(root().hidden).toBe(false);
  };
  const key = (target: Element, k: string, init: KeyboardEventInit = {}) => {
    const evt = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(evt);
    return evt;
  };
  /** Dispatch a keydown and report whether it reached a window bubble listener, as the canvas's does. */
  const reachesWindow = (target: Element, k: string): boolean => {
    const later = vi.fn();
    window.addEventListener('keydown', later);
    try {
      key(target, k);
    } finally {
      window.removeEventListener('keydown', later);
    }
    return later.mock.calls.length > 0;
  };
  const settle = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  const withClipboard = async (writeText: (text: string) => Promise<void>, body: () => Promise<void>) => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    try {
      await body();
    } finally {
      delete (navigator as unknown as Record<string, unknown>).clipboard;
    }
  };

  beforeAll(() => {
    expect(opener().hidden).toBe(true); // ships hidden: no dead button before boot
    dialog = connect.setupConnect(MCP, { viewer: () => viewer, signIn });
  });

  afterEach(() => {
    if (!root().hidden) closeBtn().click();
    viewer = { signedIn: true, name: 'Alan Lee', agent: null };
    dialog.refresh();
  });

  it('every opener reads as §12 says', () => {
    expect(opener().hidden).toBe(false);
    expect(opener().textContent?.trim()).toBe('Connect an agent');
    expect(opener().title).toBe('Connect a coding agent');
    expect(opener().getAttribute('aria-label')).toBe('Connect an agent');
    expect(document.getElementById('empty-connect')!.textContent).toBe('connect an agent');
    const cmd = connect.connectCommand(() => {});
    expect([cmd.title, cmd.group]).toEqual(['Connect an agent', 'General']);
    expect(filterCommands([{ id: 'x', title: 'Export SVG', run: () => {} }, cmd], 'mcp')).toEqual([cmd]);
  });

  it('ships closed, then opens on Claude Code with everything filled in', () => {
    expect(root().hidden).toBe(true);
    expect(opener().getAttribute('aria-expanded')).toBe('false');
    open();
    expect(opener().getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById('connect-title')!.textContent).toBe('Connect an agent');
    expect(document.getElementById('connect-lead')!.textContent).toBe(LEAD_IN);
    expect(shownPanes()).toEqual(['claude']);
    expect(document.activeElement).toBe(tab('claude'));
    expect(TABS.map(t => tab(t).textContent)).toEqual(['Claude Code', 'Cursor', 'Codex', 'claude.ai', 'Other']);
    expect(codes('claude')).toEqual([`claude mcp add --transport http --scope user draw ${MCP}`, PROMPT]);
    expect(codes('cursor')).toEqual([JSON_CONFIG, PROMPT]);
    expect(codes('codex')).toEqual([`codex mcp add draw --url ${MCP}`, 'codex mcp login draw', PROMPT]);
    expect(codes('claude-ai')).toEqual([MCP, PROMPT]);
    expect(codes('other')).toEqual([MCP, JSON_CONFIG, PROMPT]);
    const link = pane('cursor').querySelector<HTMLAnchorElement>('a.connect-cursor')!;
    expect(link.textContent).toBe('add to Cursor');
    expect(cursorConfig(link.getAttribute('href')!)).toEqual({ url: MCP });
    expect([...document.querySelectorAll('#connect-foot > p')].map(p => p.textContent)).toEqual(FOOTER);
    // each pane renders its guide steps, in order, numbered by the list
    expect([...pane('codex').querySelectorAll('.connect-steps > li > .connect-step-title')].map(t => t.textContent)).toEqual([
      'Add the server',
      'Sign in',
      'Start drawing',
    ]);
  });

  it('tabs are a real tablist: one selected, roving tabindex, each pane labelled by its tab', () => {
    open();
    expect(document.getElementById('connect-tabs')!.getAttribute('role')).toBe('tablist');
    for (const t of ['cursor', 'codex', 'claude-ai', 'other', 'claude']) {
      tab(t).click();
      expect(shownPanes()).toEqual([t]);
      // focus follows the selection (Safari does not focus a clicked button by itself)
      expect(document.activeElement).toBe(tab(t));
      expect(TABS.map(x => tab(x).getAttribute('aria-selected'))).toEqual(TABS.map(x => String(x === t)));
      expect(TABS.map(x => tab(x).tabIndex)).toEqual(TABS.map(x => (x === t ? 0 : -1)));
      expect(tab(t).getAttribute('role')).toBe('tab');
      expect(pane(t).getAttribute('role')).toBe('tabpanel');
      expect(pane(t).getAttribute('aria-labelledby')).toBe(tab(t).id);
      expect(tab(t).getAttribute('aria-controls')).toBe(pane(t).id);
      // icon above the label at phone widths: every tab carries a drawn mark
      expect(tab(t).querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('arrow keys, Home and End move the selection along the tabs and wrap', () => {
    open();
    expect(key(tab('claude'), 'ArrowRight').defaultPrevented).toBe(true);
    expect(shownPanes()).toEqual(['cursor']);
    expect(document.activeElement).toBe(tab('cursor'));
    key(tab('cursor'), 'End');
    expect(document.activeElement).toBe(tab('other'));
    key(tab('other'), 'ArrowRight');
    expect(document.activeElement).toBe(tab('claude'));
    key(tab('claude'), 'ArrowLeft');
    expect(shownPanes()).toEqual(['other']);
    key(tab('other'), 'Home');
    expect(shownPanes()).toEqual(['claude']);
    // an arrow anywhere else (a code box scrolling sideways) is left alone
    expect(key(copyBtns('claude')[0], 'ArrowRight').defaultPrevented).toBe(false);
    expect(shownPanes()).toEqual(['claude']);
  });

  it('comes back on the last tab chosen, kept in rc_connect_tab', () => {
    open();
    tab('codex').click();
    expect(localStorage.getItem('rc_connect_tab')).toBe('codex');
    closeBtn().click();
    open();
    expect(shownPanes()).toEqual(['codex']);
    expect(document.activeElement).toBe(tab('codex'));
    tab('claude').click();
  });

  it('copy writes the exact snippet of its own box, each control named Copy the <thing>', async () => {
    const writeText = vi.fn((_text: string) => Promise.resolve());
    await withClipboard(writeText, async () => {
      open();
      for (const t of TABS) {
        tab(t).click();
        copyBtns(t).forEach((b, i) => {
          b.click();
          expect(writeText).toHaveBeenLastCalledWith(codes(t)[i]);
        });
      }
    });
    expect(TABS.map(t => copyBtns(t).map(b => b.getAttribute('aria-label')))).toEqual([
      ['Copy the add command', 'Copy the prompt'],
      ['Copy the Cursor config', 'Copy the prompt'],
      ['Copy the add command', 'Copy the login command', 'Copy the prompt'],
      ['Copy the server URL', 'Copy the prompt'],
      ['Copy the server URL', 'Copy the mcp.json config', 'Copy the prompt'],
    ]);
    for (const b of TABS.flatMap(copyBtns)) expect(b.textContent).toMatch(/^(copy|copied)$/);
  });

  it('copy reads copied for 1.2 s, then copy again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await withClipboard(() => Promise.resolve(), async () => {
        open();
        const btn = copyBtns('claude')[0];
        btn.click();
        await settle();
        expect(btn.textContent).toBe('copied');
        vi.advanceTimersByTime(1199);
        expect(btn.textContent).toBe('copied');
        vi.advanceTimersByTime(1);
        expect(btn.textContent).toBe('copy');
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('a failed copy says copy failed and selects the snippet so a keyboard copy still works', async () => {
    await withClipboard(() => Promise.reject(new Error('denied')), async () => {
      open();
      copyBtns('claude')[0].click();
      await settle();
      expect(copyBtns('claude')[0].textContent).toBe('copy failed');
      expect(window.getSelection()!.toString()).toBe(`claude mcp add --transport http --scope user draw ${MCP}`);
    });
    window.getSelection()!.removeAllRanges();
  });

  it('Cursor keeps the manual config folded under the one-click install', () => {
    open();
    tab('cursor').click();
    const details = pane('cursor').querySelector('details')!;
    expect(details.open).toBe(false);
    expect(details.querySelector('summary')!.textContent).toBe('Or paste it into ~/.cursor/mcp.json');
    const link = pane('cursor').querySelector('a.connect-cursor')!;
    expect(link.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    tab('claude').click();
  });

  describe('live line', () => {
    const text = () => document.getElementById('connect-live-text')!;

    it('is a polite live region', () => {
      expect(live().getAttribute('aria-live')).toBe('polite');
    });

    it('signed in, it waits for the agent', () => {
      open();
      expect(text().textContent).toBe('Waiting for your agent.');
      expect(live().classList.contains('on')).toBe(false);
      expect(text().querySelector('a, button')).toBeNull();
    });

    it("turns live with an open link when the agent draws elsewhere, and the dialog stays open", () => {
      open();
      viewer = { signedIn: true, name: 'Alan Lee', agent: { agent: 'agent of Alan Lee', board: 'checkout-flow', boardId: 7n, slug: SLUG, here: false } };
      dialog.refresh();
      expect(text().textContent).toBe('agent of Alan Lee is drawing on checkout-flow. open');
      const link = text().querySelector('a')!;
      expect(link.textContent).toBe('open');
      expect(link.getAttribute('href')).toBe(`${location.origin}/#b=${SLUG}`);
      expect(live().classList.contains('on')).toBe(true);
      expect(root().hidden).toBe(false);
      // an unchanged state does not touch the region, so nothing is re-announced
      const node = text().firstChild;
      dialog.refresh();
      expect(text().firstChild).toBe(node);
    });

    it('names this board, with no link, when the agent draws on the board on screen', () => {
      viewer = { signedIn: true, name: 'Alan Lee', agent: { agent: 'agent of Alan Lee', board: 'checkout-flow', boardId: 7n, slug: SLUG, here: true } };
      open();
      expect(text().textContent).toBe('agent of Alan Lee is drawing on this board.');
      expect(text().querySelector('a')).toBeNull();
      expect(live().classList.contains('on')).toBe(true);
    });

    it('signed out, every opener asks for an account instead of showing the guide', () => {
      viewer = { signedIn: false };
      signIn.mockClear();
      opener().click();
      expect(signIn).toHaveBeenCalledTimes(1);
      expect(root().hidden).toBe(true);
      document.getElementById('empty-connect')!.click();
      expect(signIn).toHaveBeenCalledTimes(2);
      expect(root().hidden).toBe(true);
    });
  });

  it('no dialog string names a vendor, an env var, a socket URL, a DB host, or breaks the voice', () => {
    const strings = new Set<string>([LEAD_IN, LEAD_OUT]);
    const collect = () => {
      for (const el of panel().querySelectorAll('*')) {
        for (const attr of ['aria-label', 'title', 'href']) {
          const v = el.getAttribute(attr);
          // a board link is this page's own origin (localhost under the test DOM)
          if (v && !v.startsWith(`${location.origin}/#b=`)) strings.add(v);
        }
      }
      strings.add(panel().textContent ?? '');
    };
    for (const v of [
      { signedIn: true, name: 'Alan Lee', agent: null },
      { signedIn: true, name: 'Alan Lee', agent: { agent: 'agent of Alan Lee', board: 'b', boardId: 7n, slug: SLUG, here: false } },
    ]) {
      viewer = v;
      dialog.refresh();
      open();
      collect();
      closeBtn().click();
    }
    for (const s of strings) {
      expect(s).not.toMatch(/spacetime|maincloud|bsatn|clockwork|\bstdb\b/i);
      expect(s).not.toMatch(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/); // SPACETIME_URI, REDCRAYON_CLIENT_URL, …
      expect(s).not.toMatch(/npx -y redcrayon-mcp|wss?:\/\/|localhost|127\.0\.0\.1/);
      expect(s).not.toMatch(/\breducer|wasm|energy budget|SenderError|panic/i);
      expect(s).not.toMatch(/please|oops|!/i);
      expect(s).not.toMatch(/\p{Extended_Pictographic}/u);
      expect(s).not.toMatch(/Redcrayon|REDCRAYON|RedCrayon/);
    }
    // controls inside the panel are lowercase; the live line's Sign in starts its sentence
    for (const b of panel().querySelectorAll('.ctl')) expect(b.textContent).toMatch(/^[a-z ]+$/);
  });

  it('Escape closes it, returns focus to the opener, and goes no further', () => {
    open();
    const later = vi.fn();
    window.addEventListener('keydown', later);
    let evt: KeyboardEvent;
    try {
      evt = key(tab('claude'), 'Escape');
    } finally {
      window.removeEventListener('keydown', later);
    }
    expect(root().hidden).toBe(true);
    expect(evt.defaultPrevented).toBe(true);
    expect(later).not.toHaveBeenCalled();
    expect(opener().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(opener());
  });

  it('Escape from outside the panel while it is open is stopped at the window', () => {
    open();
    expect(reachesWindow(document.body, 'Escape')).toBe(false);
    expect(root().hidden).toBe(true);
  });

  it('Escape with the dialog closed passes through untouched', () => {
    expect(reachesWindow(document.body, 'Escape')).toBe(true);
  });

  it('the close button closes it and returns focus', () => {
    open();
    closeBtn().click();
    expect(root().hidden).toBe(true);
    expect(document.activeElement).toBe(opener());
  });

  it('a pointerdown on the backdrop closes it; one inside the panel does not', () => {
    open();
    const down = (target: Element) => {
      const evt = new Event('pointerdown', { bubbles: true, cancelable: true });
      target.dispatchEvent(evt);
      return evt;
    };
    expect(down(panel()).defaultPrevented).toBe(false);
    expect(down(tab('codex')).defaultPrevented).toBe(false);
    expect(root().hidden).toBe(false);
    // prevented, or the browser's mousedown focuses the now-hidden backdrop and drops focus to <body>
    expect(down(root()).defaultPrevented).toBe(true);
    expect(root().hidden).toBe(true);
    expect(document.activeElement).toBe(opener());
  });

  it('keeps canvas shortcuts (1-5, h, ?, ⌘K) from firing while it is open', () => {
    open();
    for (const k of ['1', '5', 'h', '?', 'k']) {
      expect(reachesWindow(tab('claude'), k), k).toBe(false);
      expect(reachesWindow(panel(), k), k).toBe(false);
    }
  });

  it('Tab and Shift-Tab wrap around inside the panel, skipping unselected tabs and folded content', () => {
    open();
    tab('cursor').click();
    const last = copyBtns('cursor').slice(-1)[0];
    last.focus();
    expect(key(last, 'Tab').defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(closeBtn());
    expect(key(closeBtn(), 'Tab', { shiftKey: true }).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);
    // between the ends the browser moves focus itself
    tab('cursor').focus();
    expect(key(tab('cursor'), 'Tab').defaultPrevented).toBe(false);
    tab('claude').click();
  });

  it('the empty-state link opens it', () => {
    document.getElementById('empty-connect')!.click();
    expect(root().hidden).toBe(false);
  });

  it('opening it closes an open popover', () => {
    const label = document.getElementById('participants-label') as HTMLButtonElement;
    label.click();
    expect(document.getElementById('presence-pop')!.hidden).toBe(false);
    open();
    expect(document.getElementById('presence-pop')!.hidden).toBe(true);
  });

  it('running it from the ⌘K palette leaves the dialog open and the palette closed', async () => {
    const { CommandPalette } = await import('./palette');
    const palette = new CommandPalette({ commands: () => [connect.connectCommand(() => dialog.open())], context: () => '' });
    palette.open();
    key(document.getElementById('palette-input')!, 'Enter');
    expect(palette.isOpen).toBe(false);
    expect(root().hidden).toBe(false);
    // the palette input it was opened from is hidden now: focus goes back to the header button
    key(tab('claude'), 'Escape');
    expect(document.activeElement).toBe(opener());
  });
});

describe('privacy policy link', () => {
  it('follows the disclosure only when the build names a policy', () => {
    document.body.innerHTML = html;
    connect.setupConnect(MCP, { viewer: () => ({ signedIn: false }) });
    expect(document.querySelector('#connect-foot a')).toBeNull();
    document.body.innerHTML = html;
    connect.setupConnect(MCP, { viewer: () => ({ signedIn: false }), privacyUrl: 'https://example.com/privacy' });
    const a = document.querySelector<HTMLAnchorElement>('#connect-foot a')!;
    expect(a.textContent).toBe('Privacy policy');
    expect(a.getAttribute('href')).toBe('https://example.com/privacy');
    expect(a.getAttribute('rel')).toBe('noopener noreferrer');
  });
});

describe('without a hosted server URL (VITE_MCP_URL unset)', () => {
  it('reads VITE_MCP_URL as an http(s) URL with a path, and never a local one in a production build', () => {
    expect(readMcpUrl(MCP, true)).toBe(MCP);
    expect(readMcpUrl('http://localhost:8787/mcp', false)).toBe('http://localhost:8787/mcp');
    for (const bad of [undefined, '', 'mcp.example.com/mcp', 'wss://mcp.example.com/mcp', 'http://localhost:8787/mcp', 'http://127.0.0.1:8787/mcp', 'https://mcp.example.com', 'https://mcp.example.com/']) {
      expect(readMcpUrl(bad, true), String(bad)).toBeUndefined();
    }
  });

  it('every opener is gone and the dialog stays inert', () => {
    document.body.innerHTML = html;
    const dialog = connect.setupConnect(undefined, { viewer: () => ({ signedIn: false }) });
    expect(document.getElementById('act-connect')).toBeNull();
    expect(document.getElementById('empty-connect')).toBeNull();
    dialog.open();
    expect(document.getElementById('connect')!.hidden).toBe(true);
    expect(document.getElementById('connect-tabs')!.children).toHaveLength(0);
  });
});
