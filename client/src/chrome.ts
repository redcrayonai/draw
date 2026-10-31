import { setDb } from '../../shared/db-target';
import type { Node, Edge, Participant, Selection, Session, CodeRef, Chart } from './module_bindings/types';
import { finishBoardLoading } from './board-loading';
import { lineSpan, type RefSummary } from './refs';
import { appendPathText, buildEditorHref, editorLabel } from './editor-link';
import { githubBlobUrl, githubRepoUrl } from './code-link';
import { highlightSnippet, plainSnippet, languageForPath } from './highlight';
import { el, evidenceClass, type EvidenceClass } from './render';
import { disclosureIcon } from './icons';
import { presenceOf } from './presence';
import type { Command } from './palette';
import type { ChartPatch } from './ops';
import { chartSignature, renderChartSections } from './chart-inspector';
import { changeNoteSignature, renderChangeNotes } from './change-note-inspector';
import { renderThreats, threatSignature } from './threat-inspector';
import type { ThreatView } from './threats-view';
import type { NoteView } from './change-notes-view';
import { SAMPLE_SOURCE, isHumanSource } from '../../module/src/chart-contracts';
import { THEMES, themeById, type ThemeId } from '../../shared/themes';

const strip = document.getElementById('error-strip') as HTMLDivElement;
const stripText = document.getElementById('error-text') as HTMLSpanElement;
const dismiss = document.getElementById('error-dismiss') as HTMLButtonElement | null;

// Guarded on purpose: this module body runs at import time, so an absent
// control here would take the whole app down before showError() can report it.
dismiss?.addEventListener('click', () => {
  strip.hidden = true;
});

export function showError(message: string): void {
  stripText.textContent = message;
  strip.hidden = false;
}

/** How long a success line stays in the strip. */
export const NOTICE_MS = 4000;

/** A success line: the strip shows it for a few seconds and the polite
 *  status region says it, so it reaches screen-reader users too. */
export function showNotice(message: string): void {
  showError(message);
  announce(message);
  window.setTimeout(() => {
    if (stripText.textContent === message) {
      strip.hidden = true;
    }
  }, NOTICE_MS);
}

// Signed-in account menu in the header actions: your name opens it, sign out is inside.
export function initAccountBar(displayName: string, onSignOut: () => void): void {
  const actions = document.querySelector('.header-actions') as HTMLElement;
  let bar = document.getElementById('account-bar') as HTMLSpanElement | null;
  if (!bar) {
    bar = document.createElement('span');
    bar.id = 'account-bar';
    actions.append(bar);
  }
  bar.replaceChildren();
  const name = document.createElement('button');
  name.id = 'account-name';
  const label = document.createElement('span');
  label.textContent = displayName;
  name.title = displayName;
  name.append(label);
  name.insertAdjacentHTML('beforeend', '<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M2.5 4l2.5 2.5L7.5 4"/></svg>');
  name.setAttribute('aria-haspopup', 'menu');
  name.setAttribute('aria-controls', 'account-pop');
  name.setAttribute('aria-expanded', 'false');
  const pop = document.createElement('div');
  pop.id = 'account-pop';
  pop.setAttribute('role', 'menu');
  pop.setAttribute('aria-label', 'Account');
  pop.hidden = true;
  const button = document.createElement('button');
  button.setAttribute('role', 'menuitem');
  button.textContent = 'sign out';
  button.addEventListener('click', onSignOut);
  pop.append(button);
  const setOpen = (open: boolean): void => {
    pop.hidden = !open;
    name.setAttribute('aria-expanded', String(open));
  };
  name.addEventListener('click', () => {
    setOpen(pop.hidden);
    if (!pop.hidden) button.focus();
  });
  dismissible(pop, name, () => setOpen(false));
  bar.append(name, pop);
}

// Header "sign in" button for optional-auth mode: the board is usable
// anonymously and signing in is an upgrade, not a gate.
export function initSignInButton(onSignIn: () => void): void {
  const actions = document.querySelector('.header-actions') as HTMLElement;
  let button = document.getElementById('sign-in') as HTMLButtonElement | null;
  if (!button) {
    button = document.createElement('button');
    button.id = 'sign-in';
    button.className = 'ctl';
    button.textContent = 'sign in';
    button.addEventListener('click', onSignIn);
    actions.append(button);
  }
}

/**
 * The dashboard's board list on this page's database, or undefined (no link).
 * `db` is forwarded unless it is `home`, like the dashboard's canvasHref.
 */
export function dashboardHref(base: string | undefined, db: string, home?: string): string | undefined {
  if (!base) {
    return undefined;
  }
  try {
    const url = new URL('/dashboard', base);
    return setDb(url, db, home).toString();
  } catch {
    return undefined; // a malformed VITE_DASHBOARD_URL costs the link, never the boot
  }
}

/**
 * Breadcrumb root: a link back to the dashboard, or plain text without one.
 * Guests get neither (RC-570): the dashboard needs an account, and the
 * header's sign in is the path that keeps their drawing.
 */
export function initBoardsLink(href: string | undefined, signedIn: boolean): void {
  const link = document.getElementById('crumb-boards') as HTMLAnchorElement | null;
  if (link === null) {
    return;
  }
  if (!signedIn) {
    link.hidden = true;
    const sep = link.nextElementSibling as HTMLElement | null;
    if (sep?.classList.contains('crumb-sep')) sep.hidden = true;
    return;
  }
  if (href === undefined) {
    return;
  }
  link.href = href;
  link.title = 'Back to boards';
}

/** Missing and inaccessible links use the same copy, without exposing board metadata. */
/** Copy for a share link the owner turned off (open_shared_link's sentence, plus what to do). */
export const LINK_GONE = 'This link is no longer shared. Ask the owner for a new link.';

export function showBoardUnavailable(boardsHref: string | undefined, newBoardHref: string, message = 'It may have been removed, or this link may need a different account.'): void {
  finishBoardLoading();
  document.getElementById('board-unavailable')?.remove();
  document.body.classList.add('board-unavailable');
  const title = document.getElementById('board-title');
  if (title) title.textContent = 'Board unavailable';
  const panel = document.createElement('section');
  panel.id = 'board-unavailable';
  panel.tabIndex = -1;
  panel.setAttribute('aria-labelledby', 'unavailable-title');
  const heading = document.createElement('h2');
  heading.id = 'unavailable-title';
  heading.textContent = 'This board is unavailable';
  const copy = document.createElement('p');
  copy.textContent = message;
  const actions = document.createElement('div');
  actions.className = 'unavailable-actions';
  if (boardsHref) {
    const back = document.createElement('a');
    back.href = boardsHref;
    back.className = 'ctl';
    back.textContent = 'Back to boards';
    actions.append(back);
  }
  const start = document.createElement('a');
  start.href = newBoardHref;
  start.className = 'btn-primary';
  start.textContent = 'Start a new board';
  actions.append(start);
  panel.append(heading, copy, actions);
  (document.getElementById('canvas-wrap') ?? document.body).append(panel);
  panel.focus();
}

// Non-destructive overlay while waiting out the reconnect backoff; the page
// reloads when the timer fires, so this only needs to inform.
export function showReconnect(reason: string, delayMs: number): void {
  finishBoardLoading();
  let panel = document.getElementById('reconnect') as HTMLDivElement | null;
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'reconnect';
    document.body.append(panel);
  }
  panel.textContent = `We’re having trouble connecting. Retrying in ${Math.round(delayMs / 1000)}s…`;
  panel.setAttribute('role', 'status');
  const retry = document.createElement('button');
  retry.className = 'ctl';
  retry.textContent = 'Retry now';
  retry.addEventListener('click', () => location.reload());
  panel.append(document.createElement('br'), retry);
  console.warn('Connection interrupted:', reason);
  setLive(false, 'Connection interrupted');
}

/* ---- theme ---- */

export type Theme = ThemeId;
export { THEMES };

/** The applied theme; anything index.html did not set (or a stale value) reads as dark. */
export function currentTheme(): Theme {
  return themeById(document.documentElement.dataset.theme)?.id ?? 'dark';
}

/** The theme whose code palette snippets use: each theme has its own, but neo-brutalism sits on light paper. */
export function codeTheme(theme: Theme = currentTheme()): Exclude<Theme, 'brutal'> {
  return theme === 'brutal' ? 'light' : theme;
}

/** Apply a theme and persist it. Exported so ⌘K can drive it too. */
export function setTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem('redcrayon-theme', theme);
  } catch {
    // Private-mode storage failures must not break the switch.
  }
  syncPicker();
  // Snippets carry theme colours inline; whoever renders them re-renders on this.
  window.dispatchEvent(new Event('redcrayon:theme'));
}

/** ⌘K: one command per theme; a check marks the one showing. */
export function themeCommands(): Command[] {
  const current = currentTheme();
  return THEMES.map(t => ({
    id: `theme-${t.id}`,
    title: `Theme: ${t.name}`,
    group: 'Theme',
    checked: t.id === current,
    // 'theme light' finds every light theme, not only the ones named Light: a
    // keyword matches only when it contains the whole query.
    keywords: ['toggle', 'appearance', 'mode', `theme ${t.scheme}`],
    run: () => setTheme(t.id),
  }));
}

/** Reflect the applied theme on the picker: the button's tooltip and the pressed option. */
function syncPicker(): void {
  const theme = currentTheme();
  // The button is an icon, so the theme goes in the tooltip — writing
  // textContent here would delete the SVG.
  const label = `Theme: ${themeById(theme)!.name}`;
  const btn = document.getElementById('act-theme');
  btn?.setAttribute('title', label);
  btn?.setAttribute('aria-label', label);
  for (const opt of document.querySelectorAll<HTMLElement>('[data-theme-opt]')) {
    opt.setAttribute('aria-pressed', String(opt.dataset.themeOpt === theme));
  }
}

/** The picker's options, one labelled group per THEMES group, each with a swatch the theme paints itself. */
function themeOptions(): HTMLElement[] {
  return (['redcrayon', 'Dark', 'Light'] as const).map(group => {
    const section = div('theme-group');
    section.setAttribute('role', 'group');
    const head = div('eyebrow', group);
    head.id = `theme-group-${group.toLowerCase()}`;
    section.setAttribute('aria-labelledby', head.id);
    section.append(head);
    for (const t of THEMES.filter(x => x.group === group)) {
      const opt = document.createElement('button');
      opt.dataset.themeOpt = t.id;
      opt.setAttribute('aria-pressed', 'false');
      // [data-swatch] picks up the theme's own tokens (themes.css), so the chip never drifts from the theme.
      const swatch = document.createElement('span');
      swatch.className = 'theme-swatch';
      swatch.dataset.swatch = t.id;
      swatch.setAttribute('aria-hidden', 'true');
      opt.append(t.name, swatch);
      section.append(opt);
    }
    return section;
  });
}

/** Wire the top-bar picker: #act-theme opens #theme-pop, an option applies its theme. */
export function setupTheme(): void {
  const btn = document.getElementById('act-theme') as HTMLButtonElement | null;
  const pop = document.getElementById('theme-pop') as HTMLDivElement | null;
  pop?.replaceChildren(...themeOptions());
  syncPicker();
  if (btn === null || pop === null) return;
  const setOpen = (open: boolean): void => {
    pop.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
  };
  btn.addEventListener('click', () => setOpen(pop.hidden));
  pop.addEventListener('click', evt => {
    const opt = (evt.target as Element).closest<HTMLElement>('[data-theme-opt]');
    if (opt === null) return;
    setTheme(opt.dataset.themeOpt as Theme);
    setOpen(false);
    btn.focus();
  });
  dismissible(pop, btn, () => setOpen(false));
}

/**
 * Close a top-bar popover on an outside pointerdown or focus, or on Escape, which stops
 * here (window capture) so the canvas's own Escape waits for the next press
 * and focus returns to the popover's button, or to what close returns (a
 * popover with a second opener). A text field (label editor, ⌘K palette)
 * keeps its own Escape; switches and readonly fields do not. Presses on
 * `also` count as inside, so a second opener can toggle it.
 */
export function dismissible(
  pop: HTMLElement,
  anchor: HTMLElement | null,
  close: () => HTMLElement | void,
  also: (HTMLElement | null)[] = []
): void {
  // Pointer or keyboard focus landing elsewhere closes it, so two popovers
  // never stack and tabbing past the options does not leave one behind.
  for (const type of ['pointerdown', 'focusin']) {
    document.addEventListener(type, evt => {
      const target = evt.target as globalThis.Node;
      if (!pop.hidden && !pop.contains(target) && ![anchor, ...also].some(a => a?.contains(target))) close();
    });
  }
  window.addEventListener('keydown', evt => {
    const typing = evt.target instanceof Element && evt.target.closest('input:not([type=checkbox]):not([type=radio]):not([readonly]), textarea, [contenteditable]') !== null;
    if (evt.key === 'Escape' && !pop.hidden && !typing) {
      (close() ?? anchor)?.focus();
      evt.preventDefault();
      evt.stopPropagation();
    }
  }, true);
}

/* ---- live status ---- */

/** Write acknowledgement is separate from the connection badge. */
export function setSaveStatus(state: 'pending' | 'saved' | 'error', reason?: string): void {
  const status = document.getElementById('save-status');
  if (!status) return;
  status.hidden = false;
  status.dataset.state = state;
  status.textContent = state === 'pending' ? 'Saving…' : state === 'saved' ? 'Saved' : 'Save failed';
  status.title = reason ?? (state === 'pending'
    ? 'Waiting for the server to save changes'
    : state === 'saved' ? 'Changes saved to the board' : 'Changes could not be saved. Try again.');
}

// The badge must never claim "Live" while we are backing off a reconnect.
export function setLive(live: boolean, reason?: string): void {
  const el = document.getElementById('live');
  if (!el) {
    return;
  }
  el.classList.toggle('offline', !live);
  const label = el.lastChild;
  if (label !== null) {
    label.textContent = live ? 'Live' : 'Offline';
  }
  el.title = reason ?? (live ? 'Connected to the live board' : 'Disconnected');
  // The empty session board's waiting dot tells the same truth (G11).
  const waiting = document.getElementById('empty-live');
  if (waiting !== null) {
    waiting.classList.toggle('offline', !live);
    waiting.title = el.title;
  }
}

/* ---- header counts ---- */

/**
 * Compact totals; hidden counts appear only when needed. The full disclosure
 * stays in the title and accessible label when narrow headers hide sub-counts.
 */
export function renderBoardCounts(
  el: HTMLElement,
  c: { nodes: number; shownNodes: number; edges: number; shownEdges: number; checkpoint: number | null }
): void {
  const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
  const sub = (shown: number, total: number) => span('counts-sub', total > shown ? ` · ${total - shown} hidden` : '');
  const checkpoint = c.checkpoint !== null ? ` · checkpoint ${c.checkpoint}` : '';
  el.replaceChildren(
    count(c.nodes, 'node'),
    sub(c.shownNodes, c.nodes),
    ` · ${count(c.edges, 'edge')}`,
    sub(c.shownEdges, c.edges),
    checkpoint
  );
  el.title = `${count(c.nodes, 'node')} · ${c.shownNodes} shown · ${c.nodes - c.shownNodes} hidden — ` +
    `${count(c.edges, 'edge')} · ${c.shownEdges} shown · ${c.edges - c.shownEdges} hidden${checkpoint}`;
  el.setAttribute('aria-label', el.title);
}

/* ---- header exposure ---- */

const ICON_CODE = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_THREAT = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.4"/><path d="M8 4.75v3.75" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="8" cy="11" r=".9" fill="currentColor"/></svg>';
const ICON_LOCK = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="3.25" y="7.25" width="9.5" height="6.5" rx="1.5" stroke="currentColor" stroke-width="1.3"/><path d="M5.5 7.25V5.5a2.5 2.5 0 0 1 5 0v1.75" stroke="currentColor" stroke-width="1.3"/></svg>';

/**
 * What a share link can expose: the board's code refs (with source snippets)
 * and threats. `link` is the owner's live link and what it carries, null when
 * no link is on or the viewer is not the owner. Only the owner can click
 * through to the Share popover. Empty when the board holds neither.
 */
export function renderExposure(
  el: HTMLButtonElement,
  x: { code: number; threats: number; owner: boolean; link: { code: boolean; threats: boolean } | null }
): void {
  const items = [
    { n: x.code, noun: 'code ref', icon: ICON_CODE, shown: x.link?.code === true },
    { n: x.threats, noun: 'threat', icon: ICON_THREAT, shown: x.link?.threats === true },
  ].filter(i => i.n > 0);
  el.disabled = !x.owner;
  if (items.length === 0) {
    el.replaceChildren();
    el.dataset.state = '';
    el.removeAttribute('title');
    el.removeAttribute('aria-label');
    return;
  }
  const label = (i: (typeof items)[number]) => `${i.n} ${i.noun}${i.n === 1 ? '' : 's'}`;
  const list = (l: typeof items) => l.map(label).join(' and ');
  const sep = '<span class="sep">·</span>';
  const shown = items.filter(i => i.shown);
  const kept = items.filter(i => !i.shown);
  let html: string;
  let title: string;
  if (x.link === null) {
    el.dataset.state = 'private';
    html = items.map(i => `<span class="item">${i.icon}${label(i)}</span>`).join(sep);
    title = `${list(items)} on this board.` + (x.owner ? ' Not shared.' : '');
  } else if (shown.length === 0) {
    el.dataset.state = 'kept';
    html = `${ICON_LOCK}<span class="verb">Link hides</span>` + items.map(i => `<span class="item">${label(i)}</span>`).join(sep);
    title = `The share link leaves out ${list(items)}.`;
  } else {
    el.dataset.state = 'out';
    html = '<span class="dot"></span><span class="verb">Link shows</span>' +
      shown.map(i => `<span class="item">${i.icon}${label(i)}</span>`).join(sep); // what stays private is in the title
    title = `Anyone with the link sees ${list(shown)}.` + (kept.length > 0 ? ` ${list(kept)} ${kept.length === 1 && kept[0].n === 1 ? 'stays' : 'stay'} private.` : '');
  }
  el.innerHTML = html; // counts and static icons only
  el.title = x.owner ? `${title} Click to change what the link shows.` : title;
  el.setAttribute('aria-label', el.title);
}

/* ---- shortcuts overlay trigger ---- */

export function setupShortcutsToggle(): void {
  const toggle = document.getElementById('shortcuts-toggle');
  const panel = document.getElementById('shortcuts');
  if (toggle === null || panel === null) {
    return;
  }
  toggle.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
  });
}

/* ---- rail collapse: laptops need their canvas ---- */

export function setupRailToggle(defaultCollapsed = false): void {
  const rail = document.getElementById('rail') as HTMLElement;
  const toggle = document.getElementById('rail-toggle') as HTMLButtonElement;
  const apply = (collapsed: boolean) => {
    rail.classList.toggle('collapsed', collapsed);
    document.body.classList.toggle('rail-collapsed', collapsed);
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.title = collapsed ? 'Show the board panel' : 'Hide the board panel';
  };
  const saved = localStorage.getItem('redcrayon-rail');
  apply(saved === null ? defaultCollapsed : saved === 'collapsed');
  toggle.addEventListener('click', () => {
    const collapsed = !rail.classList.contains('collapsed');
    localStorage.setItem('redcrayon-rail', collapsed ? 'collapsed' : 'open');
    apply(collapsed);
  });
}

/**
 * The evidence legend keys the evidence overlay switch, so it sits directly
 * under that switch while the rail is open, and floats over the canvas
 * (bottom-left) only while the rail is collapsed (P2). Moves nothing when
 * already in place.
 */
export function placeLegend(legend: HTMLElement, rail: HTMLElement, wrap: HTMLElement): void {
  const inRail = !rail.classList.contains('collapsed');
  const anchor = rail.querySelector('#overlay-row');
  if (inRail && anchor !== null) {
    if (anchor.nextElementSibling !== legend) {
      anchor.after(legend);
    }
  } else if (legend.parentElement !== wrap) {
    wrap.append(legend);
  }
  if (legend.classList.contains('in-rail') !== inRail) {
    legend.classList.toggle('in-rail', inRail);
  }
}

/**
 * The legend's summary as nowrap figures, each carrying its trailing ' ·',
 * so the narrow rail wraps between figures and no line starts with a
 * separator. Writes nothing when the figures are unchanged.
 */
export function renderLegendSummary(el: HTMLElement, parts: string[]): void {
  const text = parts.join(' · ');
  if (el.textContent === text) {
    return;
  }
  const out: (HTMLSpanElement | string)[] = [];
  parts.forEach((p, i) => {
    if (i > 0) {
      out.push(' ');
    }
    const s = document.createElement('span');
    s.className = 'legend-part';
    s.textContent = i < parts.length - 1 ? `${p} ·` : p;
    out.push(s);
  });
  el.replaceChildren(...out);
}

/* ---- header actions ---- */

export function setupHeaderActions(onExport: () => void, onRescan?: () => void): void {
  for (const id of ['act-export', 'share-export']) document.getElementById(id)?.addEventListener('click', onExport);
  (document.getElementById('act-rescan') as HTMLButtonElement).addEventListener('click', () => {
    if (onRescan) { onRescan(); return; }
    showError('re-scan needs the importer CLI: importer/ in this repo — point it at a repository and re-run.');
  });
}

/**
 * Serialise the live board SVG as it reads on screen: clone it, inline the
 * computed styles the stylesheet provides (they do not travel with the
 * markup), and drop whatever the screen does not show.
 */
export function exportSvgMarkup(svg: SVGSVGElement): string {
  const PROPS = [
    'fill',
    'fill-opacity',
    'stroke',
    'stroke-width',
    'stroke-dasharray',
    // a dotted edge's dots are round caps on near-zero dashes (RC-688)
    'stroke-linecap',
    'stroke-linejoin',
    'vector-effect',
    'opacity',
    'font-family',
    'font-size',
    'font-weight',
    'font-style',
    'letter-spacing',
    'color',
    'filter',
  ];
  // Export the settled board: no neighbour dimming or flow dashes, and no
  // transition caught mid-fade while the computed styles are read.
  const world = svg.querySelector('#world');
  const worldCls = world?.getAttribute('class') ?? null;
  world?.classList.remove('focus-dim', 'focus-flow');
  world?.classList.add('exporting');
  // Threats are members-only and the open card is local state: read the styles without the blast.
  const blastLive = [...svg.querySelectorAll('[class*="blast-"], .tc-lit')].map(e => [e, e.getAttribute('class')!] as const);
  for (const [e, cls] of blastLive) e.setAttribute('class', cls.split(/\s+/).filter(c => !c.startsWith('blast-') && c !== 'tc-lit').join(' '));
  try {
    return exportClone(svg, PROPS);
  } finally {
    for (const [e, cls] of blastLive) e.setAttribute('class', cls);
    if (worldCls === null) world?.removeAttribute('class');
    else world?.setAttribute('class', worldCls);
  }
}

function exportClone(svg: SVGSVGElement, PROPS: string[]): string {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.querySelector('#world')?.classList.remove('exporting');
  const srcAll = [svg as Element, ...svg.querySelectorAll('*')];
  const dstAll = [clone as Element, ...clone.querySelectorAll('*')];
  // CSS-hidden on screen (density rules hide badges and sublabels below 60%
  // zoom): removed after the loop so the indices stay paired (G29).
  const hidden: Element[] = [];
  for (let i = 0; i < srcAll.length; i++) {
    // A library icon keeps its name in the file (spec 2026-10-18 D9): <title>
    // computes as display: none, but it is the icon's accessible name. Other
    // titles (code-ref symbols, cut labels) still stay out of the file.
    if (srcAll[i].localName === 'title' && srcAll[i].parentElement?.classList.contains('node-icon-slot')) continue;
    const computed = getComputedStyle(srcAll[i]);
    if (computed.display === 'none' || computed.visibility === 'hidden') {
      hidden.push(dstAll[i]);
      continue;
    }
    const inline = PROPS.map(p => `${p}:${computed.getPropertyValue(p)}`).join(';');
    dstAll[i].setAttribute('style', inline);
    // A theme can restyle rect geometry in CSS (brutal squares corners and
    // widens the datastore rule); write the computed values back as
    // attributes, which every SVG reader honours.
    if (srcAll[i].localName === 'rect') {
      for (const r of ['rx', 'ry', 'width']) {
        const v = parseFloat(computed.getPropertyValue(r));
        if (!Number.isNaN(v)) dstAll[i].setAttribute(r, String(v));
      }
    }
  }
  for (const e of hidden) {
    e.remove();
  }
  // The export is the board, not the session: strip presence, transient
  // artifacts, hit targets, handles and selection chrome from the clone.
  for (const sel of [
    '#presence',
    '#transient',
    '#crayon', // draft review circles are private to their author (D13)
    '.edge-hit',
    '.edge-handle',
    '.resize-handle',
    '.selection-outline',
    '.chart-hit',
    '.chart-xhair',
    // threat marker (its title names the CVE), hop badges and travelling dots
    '.board-marker',
    '.hop-badge',
    '.route-comet',
  ]) {
    for (const e of clone.querySelectorAll(sel)) {
      e.remove();
    }
  }
  const rect = svg.getBoundingClientRect();
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', String(Math.round(rect.width)));
  clone.setAttribute('height', String(Math.round(rect.height)));
  clone.style.background = getComputedStyle(svg).backgroundColor;
  if (svg.dataset.assertionMode === 'intent') {
    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('data-intent-label', '');
    label.setAttribute('x', '16'); label.setAttribute('y', '24');
    label.setAttribute('fill', getComputedStyle(document.documentElement).getPropertyValue('--ink').trim() || '#888');
    label.setAttribute('font-family', 'sans-serif'); label.setAttribute('font-size', '14');
    label.textContent = 'Intent proposal · planned architecture';
    clone.append(label);
  }
  return new XMLSerializer().serializeToString(clone);
}

/** Export the live board SVG (exportSvgMarkup) as a download. */
export function exportSvg(svg: SVGSVGElement, boardName: string): void {
  const blob = new Blob([exportSvgMarkup(svg)], {
    type: 'image/svg+xml',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${boardName || 'board'}.svg`;
  a.click();
  URL.revokeObjectURL(url);
}

/* ---- participants (footer chips + detail popover) ---- */

const chipsEl = document.getElementById('participant-chips') as HTMLDivElement;
const popEl = document.getElementById('presence-pop') as HTMLDivElement;
const popLabel = document.getElementById('participants-label') as HTMLButtonElement | null;

function setPresencePop(open: boolean): void {
  popEl.hidden = !open;
  popLabel?.setAttribute('aria-expanded', String(open));
}

popLabel?.addEventListener('click', () => {
  setPresencePop(popEl.hidden);
});
dismissible(popEl, popLabel, () => setPresencePop(false));

/** The agent's avatar (G47): a drawn bot head, toolbar stroke weight. */
function botIcon(size: number): SVGSVGElement {
  const svg = el('svg', {
    width: String(size),
    height: String(size),
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.3',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  });
  // antenna, head, two eyes
  svg.append(el('path', { d: 'M8 2.5v2.5M3.5 5h9a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1ZM6 8.5v1M10 8.5v1' }));
  return svg;
}

/** A human's initial, or the agent's bot icon. */
function avatarContent(p: Participant, iconSize: number): SVGSVGElement | string {
  return p.kind === 'agent' ? botIcon(iconSize) : (p.displayName[0] ?? '?').toUpperCase();
}

/** An agent's presence in words (D17); never "joined … ago". */
function agentStatus(p: Participant, now: number): string {
  return presenceOf(p, now) === 'idle' ? `idle · active ${ago(p.lastSeenAt.toDate(), now)} ago` : 'active now';
}

export function renderParticipantChips(participants: Participant[], now = Date.now()): void {
  chipsEl.replaceChildren(
    ...participants.map(p => {
      const chip = document.createElement('div');
      const agent = p.kind === 'agent';
      chip.className = agent ? `p-chip agent${presenceOf(p, now) === 'idle' ? ' idle' : ''}` : 'p-chip';
      chip.title = agent ? `${p.displayName}, ${agentStatus(p, now)}` : p.displayName;
      chip.setAttribute('role', 'img');
      chip.setAttribute('aria-label', chip.title);
      const initial = document.createElement('span');
      initial.append(avatarContent(p, 14));
      chip.append(initial);
      return chip;
    })
  );
}

function ago(date: Date, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - date.getTime()) / 1000));
  if (s < 60) {
    return `${s}s`;
  }
  if (s < 3600) {
    return `${Math.floor(s / 60)}m`;
  }
  return `${Math.floor(s / 3600)}h`;
}

export function renderPresencePop(
  participants: Participant[],
  selections: Selection[],
  nodesById: Map<bigint, Node>,
  now = Date.now()
): void {
  const head = document.createElement('div');
  head.className = 'pp-head';
  const eyebrow = document.createElement('div');
  eyebrow.className = 'eyebrow';
  eyebrow.textContent = 'PARTICIPANTS';
  const count = document.createElement('div');
  count.className = 'pp-count';
  count.textContent = String(participants.length);
  head.append(eyebrow, count);

  const selectionsOf = new Map(selections.map(s => [s.identity.toHexString(), s.nodeIds]));

  const list = document.createElement('div');
  list.className = 'pp-list';
  for (const p of participants) {
    const row = document.createElement('div');
    const agent = p.kind === 'agent';
    const idle = agent && presenceOf(p, now) === 'idle';
    row.className = agent ? `pp-row agent${idle ? ' idle' : ''}` : 'pp-row';
    const avatar = document.createElement('div');
    avatar.className = 'pp-avatar';
    avatar.append(avatarContent(p, 14));
    const body = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'pp-name';
    name.textContent = p.displayName;
    const status = document.createElement('div');
    status.className = 'pp-status';
    const sel = selectionsOf.get(p.identity.toHexString()) ?? [];
    const selNodes = sel.map(id => nodesById.get(id)).filter((n): n is Node => n !== undefined);
    // An agent shows one state: idle, else what it selects, else active now.
    const parts = agent ? [] : [`joined ${ago(p.connectedAt.toDate(), now)} ago`];
    if (idle) {
      parts.push(agentStatus(p, now));
    } else if (selNodes.length === 1) {
      parts.push(`selecting ${nodeName(selNodes[0])}`);
      status.title = selNodes[0].sublabel || nodeName(selNodes[0]);
    } else if (selNodes.length > 1) {
      parts.push(`selecting ${selNodes.length} nodes`);
    } else if (agent) {
      parts.push('active now');
    }
    status.textContent = parts.join(' · ');
    body.append(name, status);
    row.append(avatar, body);
    list.append(row);
  }

  const note = document.createElement('div');
  note.className = 'pp-note';
  note.textContent = 'Initial: human. Bot icon, dashed ring: agent.';

  popEl.replaceChildren(head, list, note);
}

/* ---- inspector ---- */

const inspectorEl = document.getElementById('inspector') as HTMLElement;

export interface InspectorActions {
  hideEdges: (edges: Edge[]) => void;
  hideNodes: (nodes: Node[]) => void;
  deleteEdges: (edges: Edge[]) => void;
  /** Expand one ref in the CODE section (stores Editor.expandedRef, rerenders). */
  expandRef: (id: bigint) => void;
  /** Clipboard write of `path:start-end`; resolves false when the write
   *  failed. The button shows "copied" or "copy failed" itself. */
  copyRef: (ref: RefSummary) => Promise<boolean>;
  /** Save a chart's data (ops.setChartDataAction). Absent where charts
   *  cannot be edited; optional so existing fixtures stay valid. */
  setChartData?: (nodeId: bigint, patch: ChartPatch) => Promise<void>;
  /** Pin a chart to the edge or component it measures, or unpin it (null). Absent where charts cannot be edited. */
  pinChart?: (nodeId: bigint, target: { targetKind: string; targetId: bigint } | null) => void;
  /** Mark a change note reviewed or clear it (D12); absent where nobody may review. */
  markReviewed?: (id: bigint, reviewed: boolean) => void;
  /** Clipboard write of an "ask agent to fix" prompt (D8); resolves false when the write failed. */
  copyFixPrompt?: (text: string) => Promise<boolean>;
  /** Open a threat: its panel docks here and its blast plays on the canvas. */
  openThreatCard?(anchorId: bigint, threatId: bigint): void;
}

export interface InspectorModel {
  readOnly?: boolean;
  nodes: Node[];
  edges: Edge[];
  nodesById: Map<bigint, Node>;
  participants: Participant[];
  /** `node:<id>` | `edge:<id>` → refs (summaries only, orphans removed). */
  refsByTarget: Map<string, RefSummary[]>;
  session: Session | null;
  expandedRef: bigint | null;
  editorScheme: string;
  /** Repo paths the session's coverage lists as deleted since its base. */
  deletedPaths: ReadonlySet<string>;
  /** Lazy row access: snippet and sha are read for the one expanded ref only. */
  refRow: (id: bigint) => CodeRef | undefined;
  /** The session's repo remote (RC-690); null or absent until a helper reports one. */
  remote?: { remoteUrl: string; pushedHead: string; dirtyPaths: string[] } | null;
  /** The hosted privacy policy (VITE_PRIVACY_URL); absent in builds without one. */
  privacyUrl?: string;
  /** A chart node's data row; absent until the chart table has loaded. */
  chartRow?: (nodeId: bigint) => Chart | undefined;
  /** What a chart is pinned to (visible_chart_anchor); absent before the table loads. */
  chartPin?: (nodeId: bigint) => { targetKind: string; targetId: bigint } | undefined;
  /** Change notes by anchor node (spec 2026-10-16); absent before the table loads. */
  changeNotes?: ReadonlyMap<bigint, NoteView[]>;
  /** D12: a signed-in viewer who may edit this board may review a change note. */
  canReview?: boolean;
  /** Threats by anchor node, members only (spec 2026-10-16); absent when there are none. */
  threats?: ReadonlyMap<bigint, ThreatView[]>;
  /** The open threat's panel, owned and repainted by main; shown in place of the rows on its anchor. */
  threatPanel?: { anchorId: bigint; el: HTMLElement };
}

const CLASS_LABEL: Record<EvidenceClass, string> = {
  import: 'import',
  source: 'source',
  stale: 'stale source',
  test: 'test-import',
  human: 'human',
  agent: 'agent claim',
  none: 'none',
};

// weakest first — the order a reviewer should worry in
const CLASS_RANK: Record<EvidenceClass, number> = {
  none: 0,
  agent: 1,
  stale: 2,
  human: 3,
  test: 4,
  source: 5,
  import: 6,
};

function div(className: string, text?: string): HTMLDivElement {
  const d = document.createElement('div');
  d.className = className;
  if (text !== undefined) {
    d.textContent = text;
  }
  return d;
}

function span(className: string, text: string): HTMLSpanElement {
  const s = document.createElement('span');
  s.className = className;
  s.textContent = text;
  return s;
}

function btn(className: string, text: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = className;
  b.textContent = text;
  b.addEventListener('click', onClick);
  return b;
}

/* ---- clipboard feedback ---- */

/** Write text to the clipboard. Never throws: false when there is no
 *  clipboard (insecure origin), it throws, or the write is rejected. */
export async function copyText(text: string): Promise<boolean> {
  try {
    const clip = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    if (clip === undefined || typeof clip.writeText !== 'function') {
      return false;
    }
    await clip.writeText(text);
    return true;
  } catch {
    return false;
  }
}

const FLASH_MS = 1200;
const flashTimers = new WeakMap<HTMLElement, number>();

/** Say a copy result to assistive tech through the page's polite status region. */
function announce(text: string): void {
  let region = document.getElementById('copy-status');
  if (region === null) {
    // index.html ships the region; created here only where it is absent.
    region = div('sr-only');
    region.id = 'copy-status';
    region.setAttribute('role', 'status');
    region.setAttribute('aria-live', 'polite');
    document.body.append(region);
  }
  // A status region speaks on change, so a second identical result (two
  // copies inside 1.2 s) gets a trailing no-break space to differ.
  region.textContent = region.textContent === text ? `${text}\u00a0` : text;
}

/** Show a copy result on the control for 1.2 s, then put its label back. */
export function flashLabel(el: HTMLElement, ok: boolean, idle: string, done = 'copied'): void {
  const text = ok ? done : 'copy failed';
  el.textContent = text;
  el.classList.toggle('copied', ok);
  el.classList.toggle('copy-failed', !ok);
  announce(text);
  window.clearTimeout(flashTimers.get(el));
  flashTimers.set(
    el,
    window.setTimeout(() => {
      el.textContent = idle;
      el.classList.remove('copied', 'copy-failed');
    }, FLASH_MS)
  );
}

const ICON_CHECK = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const AGENT_PROMPT_LABEL = 'Copy prompt for agent';
const AGENT_PROMPT_DONE = 'Copied · paste to agent';

/**
 * A prompt the board hands to the person's coding agent: the agent glyph (as
 * on its presence avatar) and a label that names the hand-off. A copy reads
 * "Copied · paste to agent" for 2.4 s; `onFail` gets the text a
 * blocked clipboard could not take, so the caller can show it instead.
 */
export function agentPromptButton(text: () => string, onFail: (text: string) => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'ctl agent-prompt';
  const icon = document.createElement('span');
  icon.className = 'agent-prompt-icon';
  const label = document.createElement('span');
  const idle = () => {
    icon.replaceChildren(botIcon(14));
    label.textContent = AGENT_PROMPT_LABEL;
    b.classList.remove('copied');
  };
  idle();
  b.append(icon, label);
  b.addEventListener('click', () => {
    const value = text();
    void copyText(value).then(ok => {
      announce(ok ? AGENT_PROMPT_DONE : 'copy failed');
      if (!ok) return onFail(value);
      icon.innerHTML = ICON_CHECK;
      label.textContent = AGENT_PROMPT_DONE;
      b.classList.add('copied');
      window.clearTimeout(flashTimers.get(b));
      flashTimers.set(b, window.setTimeout(idle, 2 * FLASH_MS));
    });
  });
  return b;
}

/** A node's name in chrome copy: its label, else its sublabel (G37). */
export function nodeName(n: Node): string {
  return n.label || n.sublabel;
}

function edgeName(e: Edge, nodesById: Map<bigint, Node>): string {
  const name = (id: bigint) => {
    const n = nodesById.get(id);
    return n ? nodeName(n) : `#${id}`;
  };
  return `${name(e.fromNode)} → ${name(e.toNode)}`;
}

/** The ends by path: each sublabel, else its label; `both` when every end has one. */
function edgePaths(e: Edge, nodesById: Map<bigint, Node>): { text: string; ends: string[]; both: boolean } {
  const nodes = [nodesById.get(e.fromNode), nodesById.get(e.toNode)];
  const ends = nodes.map((n, i) => (n ? n.sublabel || n.label : `#${i === 0 ? e.fromNode : e.toNode}`));
  return { text: ends.join(' → '), ends, both: nodes.every(n => n !== undefined && n.sublabel.length > 0) };
}

/** One line of a path, with a break opportunity after each '/' (P18). */
function pathLine(text: string): HTMLDivElement {
  const line = div('insp-edge-path');
  appendPathText(line, text);
  return line;
}

function citation(e: Edge): string {
  const cls = evidenceClass(e.evidence, e.evidenceStatus);
  switch (cls) {
    case 'source':
    case 'stale':
      return e.evidence.slice('source:'.length);
    case 'human':
      return `asserted by ${e.evidence.slice('human:'.length)}`;
    case 'agent':
      return `rests on: ${e.evidence.slice('agent:'.length).trim()}`;
    case 'none':
      return 'no citation · asserted on canvas';
    default:
      return e.evidence; // import / test-import: the class is the citation
  }
}

/* ---- inspector: CODE section ---- */

// Why a ref's lines may be off; statusNote adds the shared caveat as a
// second line, so a narrow panel never breaks the pair at ' · ' (P13).
const STATUS_CAUSE: Record<string, string> = {
  stale: 'symbol not found at the last checkpoint',
  ambiguous: 'more than one match at the last checkpoint',
};
// A deleted file explains a stale ref better than "symbol not found" does.
const DELETED_CAUSE = 'file deleted since the session started';

function statusNote(cause: string): HTMLElement {
  const note = div('insp-ref-note');
  note.append(div('insp-ref-note-line', cause), div('insp-ref-note-line', 'lines are as last seen'));
  return note;
}

// Memo + keyboard state. The inspector is rebuilt with replaceChildren, so a
// live agent session would otherwise wipe scroll and text selection on every
// write; renderInspector skips the rebuild while the signature is unchanged.
let lastSig: string | null = null;
let lastRefs: RefSummary[] = [];
let lastActions: InspectorActions | null = null;
let lastExpanded: bigint | null = null;
let focusedRef: bigint | null = null;
// The rows of the latest renderInspector call, memo hit or not (lastActions
// is likewise refreshed on every call).
// The signature leaves out fields the inspector does not show (edge color,
// stroke style, endpoint ids; node position and style), so a kept DOM can
// hold buttons built from older rows. Their handlers read these at click
// time, so ops always snapshots the current row (deleteEdgeAction's undo).
let liveNodes: Node[] = [];
let liveEdges: Edge[] = [];
// Selected ids of the last rebuild: scroll is carried over only while the
// reader stays on the same target.
let lastTargetIds: string | null = null;
// Scroll backstop for the async fill: the position the reader had before the
// rebuild and the one the panel had right after it.
let scrollWant: { want: number; got: number } | null = null;
// Open bodies of the panel being replaced, offered to the rebuild while the
// reader stays on the same target (G33).
let reusableBodies: HTMLElement[] = [];

/** Highlighted snippet blocks by `${refId}|${blobSha}|${theme}|${startLine}|${endLine}|${snippet}`
 *  (renderRefBody), so a rebuild repaints the coloured block in the same
 *  frame. Small LRU. */
const SNIPPET_CACHE_MAX = 32;
const snippetCache = new Map<string, HTMLElement>();

function cachedSnippet(key: string): HTMLElement | null {
  const block = snippetCache.get(key);
  if (block === undefined) {
    return null;
  }
  snippetCache.delete(key);
  snippetCache.set(key, block); // most recently used last
  return block.cloneNode(true) as HTMLElement;
}

function cacheSnippet(key: string, block: HTMLElement): void {
  snippetCache.delete(key);
  snippetCache.set(key, block.cloneNode(true) as HTMLElement);
  while (snippetCache.size > SNIPPET_CACHE_MAX) {
    const oldest = snippetCache.keys().next().value as string;
    snippetCache.delete(oldest);
  }
}

/** Forget the memo and keyboard state (tests; board switch). */
export function resetInspectorMemo(): void {
  lastSig = null;
  lastRefs = [];
  lastActions = null;
  lastExpanded = null;
  focusedRef = null;
  liveNodes = [];
  liveEdges = [];
  lastTargetIds = null;
  scrollWant = null;
  snippetCache.clear();
}

/** The current rows for `rows` (by id), falling back to the row as rendered. */
function currentNodes(rows: Node[]): Node[] {
  return rows.map(r => liveNodes.find(n => n.id === r.id) ?? r);
}

function currentEdges(rows: Edge[]): Edge[] {
  return rows.map(r => liveEdges.find(e => e.id === r.id) ?? r);
}

/** The actions of the latest render, falling back to the ones rendered with. */
function currentActions(rendered: InspectorActions): InspectorActions {
  return lastActions ?? rendered;
}

function targetKey(nodes: Node[], edges: Edge[]): string | null {
  if (nodes.length === 1 && edges.length === 0) {
    return `node:${nodes[0].id}`;
  }
  if (edges.length === 1 && nodes.length === 0) {
    return `edge:${edges[0].id}`;
  }
  return null;
}

function expandedFor(refs: RefSummary[], wanted: bigint | null): bigint | null {
  if (refs.length === 0) {
    return null;
  }
  return wanted !== null && refs.some(r => r.id === wanted) ? wanted : refs[0].id;
}

/**
 * Everything the inspector renders, in one string. Positions (x, y, w, h) are
 * deliberately absent: a drag anywhere on the board must not rebuild the
 * inspector while the reader has a snippet open.
 */
function signature(nodes: Node[], edges: Edge[], m: InspectorModel): string {
  if (nodes.length === 0 && edges.length === 0) {
    return '';
  }
  const parts: string[] = [
    m.readOnly ? 'read-only' : 'editable',
    document.documentElement.dataset.theme ?? '',
    m.editorScheme,
    String(m.expandedRef ?? ''),
    // Not session.checkpoint itself: mark_checkpoint runs before every commit
    // and would rebuild the panel for nothing. Only the per-ref "not yet
    // checkpointed" flag below depends on it.
    // Session presence (not just its root) decides the node provenance footer.
    m.session === null ? 'no-session' : `session:${m.session.repoRoot}`,
  ];
  for (const n of nodes) {
    parts.push(`n${n.id}|${n.label}|${n.sublabel}|${n.kind}|${n.focal ? 1 : 0}|${n.imported ? 1 : 0}|${n.doc}`);
  }
  if (nodes.length === 1 && edges.length === 0 && nodes[0].kind === 'chart') {
    // A chart row change re-renders, but not while a chart field has focus.
    parts.push(chartSignature(nodes[0].id, m.chartRow?.(nodes[0].id)));
    const pin = m.chartPin?.(nodes[0].id);
    parts.push(`pin:${pin ? `${pin.targetKind}:${pin.targetId}` : ''}|${m.nodes.length}|${m.edges.length}`);
  }
  if (nodes.length === 1 && edges.length === 0) {
    const notes = m.changeNotes?.get(nodes[0].id);
    if (notes) parts.push(changeNoteSignature(notes, m.canReview === true));
    const threats = m.threats?.get(nodes[0].id);
    if (threats) parts.push(threatSignature(threats));
    if (m.threatPanel?.anchorId === nodes[0].id) parts.push('threat-open');
  }
  for (const e of edges) {
    parts.push(`e${e.id}|${e.label}|${e.evidence}|${e.evidenceStatus}|${e.evidenceSnippet}|${e.imported ? 1 : 0}|${edgeName(e, m.nodesById)}|${edgePaths(e, m.nodesById).text}`);
  }
  const key = targetKey(nodes, edges);
  if (key !== null) {
    const refs = m.refsByTarget.get(key) ?? [];
    for (const r of refs) {
      const pending = m.session !== null && r.checkpoint > m.session.checkpoint ? 1 : 0;
      const deleted = m.deletedPaths.has(r.path) ? 1 : 0;
      parts.push(`r${r.id}|${r.symbol}|${r.path}|${r.startLine}|${r.endLine}|${r.status}|${r.checkpoint}|${pending}|${deleted}`);
    }
    const expanded = expandedFor(refs, m.expandedRef);
    const row = expanded !== null ? m.refRow(expanded) : undefined;
    const gh = expanded !== null ? githubLink(refs.find(r => r.id === expanded)!, m) : { href: null, unpushed: false };
    parts.push(`sha${row?.blobSha ?? ''}|${row?.snippet ? 1 : 0}|${gh.href ?? ''}|${gh.unpushed ? 1 : 0}|${m.privacyUrl ?? ''}`);
  }
  return parts.join('\n');
}

function reducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Ceiling for the 200 ms row transition: release even if no transitionend
 *  arrives (already at target, tab hidden, transition cancelled). */
const OPEN_RELEASE_MS = 300;

/**
 * Grow the body's one grid row from 0fr to 1fr (style.css): `.entering`
 * holds it collapsed for the first frame, `.opening` clips the inner
 * wrapper until the row has grown, so focus rings are not clipped after.
 * No layout is read and none is forced per frame.
 */
function animateOpen(body: HTMLElement): void {
  if (reducedMotion()) {
    return;
  }
  body.classList.add('opening', 'entering');
  // Commit the collapsed row now (a style read, not a layout): the panel may
  // already have resolved the body at 1fr, and the next frame's style pass
  // would otherwise never see 0fr.
  void getComputedStyle(body).gridTemplateRows;
  let timer = 0;
  const release = () => {
    // the bare global, not window.: this runs from a timer that can outlive
    // a torn-down test DOM (vitest jsdom), where `window` is gone but timers are not
    clearTimeout(timer);
    body.removeEventListener('transitionend', onEnd);
    body.classList.remove('opening', 'entering');
  };
  // transitionend bubbles: a child's hover transition must not end the
  // expand partway, so only the body's own row transition counts.
  const onEnd = (evt: Event) => {
    if (evt.target === body && (evt as TransitionEvent).propertyName === 'grid-template-rows') {
      release();
    }
  };
  body.addEventListener('transitionend', onEnd);
  timer = window.setTimeout(release, OPEN_RELEASE_MS);
  const frame =
    typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (fn: () => void) => window.setTimeout(fn, 0);
  frame(() => body.classList.remove('entering'));
}

function editorHref(ref: RefSummary, m: InspectorModel): string | null {
  if (m.deletedPaths.has(ref.path)) {
    return null; // nothing to open
  }
  return m.session !== null ? buildEditorHref(m.editorScheme, m.session.repoRoot, ref.path, ref.startLine) : null;
}

/**
 * The ref's page on GitHub at the commit the last checkpoint saw pushed, or
 * why there is none: `unpushed` when that commit or this path's copy is not
 * on the remote. No remote row, another host or a deleted file say nothing.
 */
function githubLink(ref: RefSummary, m: InspectorModel): { href: string | null; unpushed: boolean } {
  const r = m.remote;
  if (!r || githubRepoUrl(r.remoteUrl) === null || m.deletedPaths.has(ref.path)) {
    return { href: null, unpushed: false };
  }
  // A ref newer than the last checkpoint was not in its dirty check, so the pushed commit may not hold these lines.
  const pending = m.session !== null && ref.checkpoint > m.session.checkpoint;
  const pushed = r.pushedHead !== '' && !r.dirtyPaths.includes(ref.path) && !pending;
  return { href: pushed ? githubBlobUrl(r.remoteUrl, r.pushedHead, ref.path, ref.startLine, ref.endLine) : null, unpushed: !pushed };
}

/** Each rendered body's bodyKey — kept off the DOM, since it holds the
 *  whole snippet (up to 4000 characters). */
const bodyKeys = new WeakMap<HTMLElement, string>();

/** Everything an expanded body renders. A rebuild keeps the live body (and the
 *  reader's text selection in its snippet) while this is unchanged. */
function bodyKey(ref: RefSummary, m: InspectorModel): string {
  const row = m.refRow(ref.id);
  const sha = row?.blobSha ?? '';
  const theme = codeTheme();
  const pending = m.session !== null && ref.checkpoint > m.session.checkpoint ? 1 : 0;
  const gh = githubLink(ref, m);
  return [
    ref.id, sha, theme, ref.startLine, ref.endLine, ref.path, ref.symbol, ref.status, ref.checkpoint, pending,
    m.deletedPaths.has(ref.path) ? 1 : 0, // the deleted note, even when the href was null anyway
    editorHref(ref, m) ?? '',
    gh.href ?? '', gh.unpushed ? 1 : 0,
    row?.snippet ?? '',
    m.privacyUrl ?? '',
  ].join('|');
}

/**
 * The snippet's scroller inside its bordered box. The box is capped at 20
 * rows (style.css) so the rest of the ref list stays in view under it; the
 * scroller takes focus, so the keyboard can scroll it. Returns `show`, which
 * puts a block in the scroller.
 *
 * `.more` on the box fades its bottom edge while rows are hidden below the
 * scroll edge. It is checked on scroll and whenever the scroller or the
 * shown block changes size (panel width, a font load, the coloured block
 * replacing the plain one), and written only when it changes.
 */
function snippetBox(ref: RefSummary, box: HTMLElement): (block: HTMLElement) => void {
  const scroller = div('insp-code-scroll');
  scroller.tabIndex = 0;
  scroller.dataset.act = 'snippet'; // restoreFocus finds it again after a rebuild
  scroller.setAttribute('role', 'region');
  scroller.setAttribute('aria-label', `${ref.symbol} snippet, lines ${lineSpan(ref.startLine, ref.endLine)}`);
  box.append(scroller);
  const sync = () => {
    const more = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight > 1;
    if (box.classList.contains('more') !== more) {
      box.classList.toggle('more', more);
    }
  };
  scroller.addEventListener('scroll', sync, { passive: true });
  const sizes = typeof ResizeObserver === 'function' ? new ResizeObserver(sync) : null;
  sizes?.observe(scroller);
  let shown: HTMLElement | null = null;
  return block => {
    if (shown !== null) {
      sizes?.unobserve(shown);
    }
    scroller.replaceChildren(block);
    shown = block;
    sizes?.observe(block);
  };
}

function renderRefBody(ref: RefSummary, m: InspectorModel, actions: InspectorActions): HTMLElement {
  // Disclosure pattern: the body is a region labelled by its row's button.
  const body = div('insp-ref-body');
  body.id = `insp-ref-body-${ref.id}`;
  body.setAttribute('role', 'region');
  body.setAttribute('aria-labelledby', `insp-ref-row-${ref.id}`);
  bodyKeys.set(body, bodyKey(ref, m));
  // The body is a one-row grid that animates open (animateOpen); its
  // content lives in the single row. Meta line, status note and actions come
  // first, right under the row, so the reader never scrolls past the code to
  // act on it; the snippet comes last.
  const inner = div('insp-ref-inner');
  body.append(inner);
  const row = m.refRow(ref.id);
  const sha = row?.blobSha ?? '';

  const foot = div('insp-ref-foot');
  // A new ref is stamped session.checkpoint + 1: it belongs to the upcoming
  // checkpoint, which the rail has not reached yet.
  const pending = m.session !== null && ref.checkpoint > m.session.checkpoint;
  const when = pending ? 'not yet checkpointed' : `checkpoint ${ref.checkpoint}`;
  const deleted = m.deletedPaths.has(ref.path);
  // Say the ok status in words; stale, ambiguous and deleted say theirs below.
  const current = ref.status === 'ok' && !deleted ? 'current ' : '';
  foot.append(span('insp-ref-asof', `${current}as of ${sha.slice(0, 7) || '—'} · ${when}`));
  inner.append(foot);
  if (deleted) {
    inner.append(statusNote(DELETED_CAUSE));
  } else if (ref.status !== 'ok') {
    inner.append(statusNote(STATUS_CAUSE[ref.status] ?? ref.status));
  }

  const ctls = div('insp-ref-ctls');
  const copy = btn('ctl strong', 'copy ref', () => {
    void currentActions(actions).copyRef(ref).then(ok => flashLabel(copy, ok, 'copy ref'));
  });
  copy.dataset.act = 'copy';
  copy.title = 'Copy path:start-end · c';
  ctls.append(copy);

  const href = editorHref(ref, m);
  if (href !== null) {
    const a = document.createElement('a');
    a.className = 'ctl';
    a.dataset.act = 'open';
    a.setAttribute('href', href);
    a.textContent = 'open in editor';
    a.title = `Open in ${editorLabel(m.editorScheme)} · o · ⌥-click copies the link`;
    a.addEventListener('click', evt => {
      if (evt.altKey) {
        evt.preventDefault();
        void copyText(href).then(ok => flashLabel(a, ok, 'open in editor', 'link copied'));
      }
    });
    ctls.append(a);
  } else {
    const why = deleted ? 'file deleted' : 'path or repo root not linkable';
    ctls.append(div('insp-ref-note', `open in editor unavailable · ${why}`));
  }
  const gh = githubLink(ref, m);
  if (gh.href !== null) {
    const a = document.createElement('a');
    a.className = 'ctl';
    a.dataset.act = 'github';
    a.setAttribute('href', gh.href);
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = 'open on GitHub';
    ctls.append(a);
  } else if (gh.unpushed) {
    ctls.append(div('insp-ref-note', 'not pushed yet'));
  }
  inner.append(ctls);

  // A ref without stored text (a board without consent, or text not filled in yet) has nothing to draw: path, lines and the links stand.
  if (!row?.snippet) {
    const note = div('insp-ref-note', 'No code stored for this reference.');
    if (m.privacyUrl) {
      const a = document.createElement('a');
      a.dataset.act = 'privacy';
      a.setAttribute('href', m.privacyUrl);
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = 'Privacy policy';
      note.append(' ', a);
    }
    inner.append(note);
    return body;
  }
  const code = div('insp-code');
  code.dataset.sha = sha;
  const show = snippetBox(ref, code);
  const theme = codeTheme();
  const snippet = row?.snippet ?? '';
  // First paint is synchronous so the slot never collapses while a rebuild's
  // forced layout runs (that clamps the panel's scrollTop): the cached
  // highlighted block when there is one, else plain rows of the same height
  // that the highlighted block replaces when it resolves.
  // Everything the block draws: a range or snippet change with the same
  // start line and file sha must not reuse the old block.
  const cacheKey = `${ref.id}|${sha}|${theme}|${ref.startLine}|${ref.endLine}|${snippet}`;
  const cached = cachedSnippet(cacheKey);
  if (cached !== null) {
    show(cached);
  } else {
    code.setAttribute('aria-busy', 'true');
    show(plainSnippet(snippet, ref.startLine, ref.symbol));
    void highlightSnippet(snippet, languageForPath(ref.path), theme, ref.startLine, ref.symbol).then(block => {
      cacheSnippet(cacheKey, block);
      // A later rebuild may have replaced this block: only fill the one still shown.
      if (code.isConnected && code.dataset.sha === sha) {
        show(block);
        code.removeAttribute('aria-busy');
        restoreScroll();
      }
    });
  }
  inner.append(code);
  return body;
}

function renderCodeSection(key: string, m: InspectorModel, actions: InspectorActions): HTMLElement[] {
  const refs = m.refsByTarget.get(key) ?? [];
  lastRefs = refs;
  if (refs.length === 0) {
    return [];
  }
  const expanded = expandedFor(refs, m.expandedRef);
  if (focusedRef === null || !refs.some(r => r.id === focusedRef)) {
    focusedRef = expanded;
  }
  const out: HTMLElement[] = [
    div('insp-divider'),
    div('eyebrow', `code · ${refs.length} ref${refs.length === 1 ? '' : 's'}`),
  ];
  // A list of disclosures (button + region), not a listbox: the expanded
  // body holds a snippet, buttons and a link, which an option may not contain.
  const list = document.createElement('ul');
  list.className = 'insp-refs';
  list.setAttribute('aria-label', 'code refs');
  for (const ref of refs) {
    const isOn = ref.id === expanded;
    // A ref on a deleted file is named 'deleted', as its note and the rail
    // name it, whatever the checkpoint's resolver last said (P13).
    const state = m.deletedPaths.has(ref.path) ? 'deleted' : ref.status;
    const item = document.createElement('li');
    item.className = `insp-ref${isOn ? ' on' : ''}${state !== 'ok' ? ` ${state}` : ''}`;
    item.dataset.refId = ref.id.toString();
    const row = btn('insp-ref-row', '', () => {
      // The rebuild that expandRef triggers restores DOM focus to focusedRef.
      focusedRef = ref.id;
      currentActions(actions).expandRef(ref.id);
    });
    row.id = `insp-ref-row-${ref.id}`;
    row.setAttribute('aria-expanded', isOn ? 'true' : 'false');
    if (isOn) {
      row.setAttribute('aria-controls', `insp-ref-body-${ref.id}`); // only a body that exists
    }
    // Roving tabindex: the list is one Tab stop; the arrows move within it.
    row.tabIndex = ref.id === focusedRef ? 0 : -1;
    row.classList.toggle('focus', ref.id === focusedRef);
    // Both lines truncate (style.css); the title carries the full string.
    const where = `${ref.path}:${lineSpan(ref.startLine, ref.endLine)}`;
    const sym = span('insp-ref-sym', ref.symbol);
    sym.title = ref.symbol;
    // Every row, collapsed or open, names a non-ok status in its header (G12).
    const head = span('insp-ref-head', '');
    head.append(sym);
    if (state !== 'ok') {
      head.append(span(`insp-chip ${state}`, state));
    }
    head.append(disclosureIcon());
    const loc = span('insp-ref-loc', '');
    loc.title = where;
    const bdi = document.createElement('bdi');
    bdi.textContent = where;
    loc.append(bdi);
    row.append(head, loc);
    item.append(row);
    if (isOn) {
      // The old tree is still in the panel here: an identical open body moves
      // across instead of being rebuilt (renderInspector restores the selection).
      const key = bodyKey(ref, m);
      const live = reusableBodies.find(b => bodyKeys.get(b) === key);
      item.append(live ?? renderRefBody(ref, m, actions));
    }
    list.append(item);
  }
  out.push(list);
  return out;
}

// Guarded like `dismiss` above: this runs at import time, and modules that
// import chrome without the app shell (ops.ts under test) have no #inspector.
inspectorEl?.addEventListener('keydown', evt => {
  if (lastActions === null || lastRefs.length === 0 || evt.metaKey || evt.ctrlKey || evt.altKey) {
    return;
  }
  const refs = lastRefs;
  // Enter and the arrows belong to the list only when the panel itself or a
  // ref row has DOM focus; on any other control (hide, delete, copy ref, the
  // editor link) they keep their native meaning. On a ref row they act on
  // that row, not on the row last highlighted with the arrows.
  const target = evt.target instanceof HTMLElement ? evt.target : null;
  // Text typed in a field (the chart form, or any later one) is never a panel key.
  if (target?.closest('input, textarea, select')) {
    return;
  }
  const onRow = target !== null && target.classList.contains('insp-ref-row');
  const listKeys = target === inspectorEl || onRow;
  const rowId = onRow ? target.parentElement?.dataset.refId : undefined;
  const at = rowId !== undefined ? refs.findIndex(r => r.id.toString() === rowId) : -1;
  const idx = Math.max(0, at >= 0 ? at : refs.findIndex(r => r.id === focusedRef));
  const moveFocus = (next: number) => {
    const id = refs[next].id;
    focusedRef = id;
    for (const row of inspectorEl.querySelectorAll<HTMLElement>('.insp-ref-row')) {
      const on = row.parentElement?.dataset.refId === id.toString();
      row.classList.toggle('focus', on);
      row.tabIndex = on ? 0 : -1;
      if (on) {
        row.focus(); // DOM focus follows, so a screen reader announces the move
      }
    }
  };
  switch (evt.key) {
    case 'ArrowDown':
      if (!listKeys) {
        return;
      }
      moveFocus(Math.min(refs.length - 1, idx + 1));
      break;
    case 'ArrowUp':
      if (!listKeys) {
        return;
      }
      moveFocus(Math.max(0, idx - 1));
      break;
    case 'Enter':
      if (!listKeys) {
        return;
      }
      moveFocus(idx);
      lastActions.expandRef(refs[idx].id);
      break;
    case 'o': {
      const open = inspectorEl.querySelector<HTMLElement>('[data-act="open"]');
      if (open !== null) {
        open.click();
      } else {
        announce('open in editor unavailable');
      }
      break;
    }
    case 'c':
      inspectorEl.querySelector<HTMLElement>('[data-act="copy"]')?.click();
      break;
    default:
      return;
  }
  evt.preventDefault();
  evt.stopPropagation();
});

/* ---- inspector: per-selection renderers ---- */

type Provenance = { who: 'agent' | 'human'; text: string };

/**
 * Who put the edge there, by evidence class first (G10). A source citation is
 * the agent's: the footer names who cited it. The captured source line and
 * checkpoint status determine whether its location still holds. The
 * path is in the CITED AT block above; the footer does not repeat it.
 */
function edgeProvenance(e: Edge, cls: EvidenceClass): Provenance {
  switch (cls) {
    case 'source':
    case 'stale':
      return { who: 'agent', text: 'cited by agent' };
    case 'import':
    case 'test':
      return { who: 'agent', text: e.imported ? 'cited by agent · verified on import' : `cited by agent · ${e.evidence}` };
    case 'human':
      return { who: 'human', text: `asserted by ${e.evidence.slice('human:'.length)}` };
    case 'agent':
      return { who: 'agent', text: 'claimed by agent · unverified' };
    default:
      return { who: 'human', text: 'asserted on canvas · unverified' };
  }
}

/** A node on a session board, or one carrying code refs, is the agent's (G10). */
function nodeProvenance(n: Node, m: InspectorModel): Provenance {
  if (n.imported) {
    return { who: 'agent', text: 'imported from repo' };
  }
  const refs = m.refsByTarget.get(`node:${n.id}`)?.length ?? 0;
  if (refs > 0) {
    return { who: 'agent', text: `drawn by agent · ${refs} code ref${refs === 1 ? '' : 's'}` };
  }
  if (m.session !== null) {
    return { who: 'agent', text: 'drawn by agent' };
  }
  return { who: 'human', text: 'placed by hand · no evidence' };
}

function renderEdgeInspector(e: Edge, m: InspectorModel, actions: InspectorActions): void {
  const cls = evidenceClass(e.evidence, e.evidenceStatus);
  const frag: HTMLElement[] = [];
  frag.push(div('eyebrow', 'EDGE'));
  // Labels name the edge; the paths go in the title and, when both ends have
  // one, a mono line under it (G37).
  const title = div('insp-title', edgeName(e, m.nodesById));
  const paths = edgePaths(e, m.nodesById);
  title.title = paths.text;
  frag.push(title);
  if (paths.both) {
    // From-path, then '→ to-path': each on its own line, so neither breaks
    // mid-segment against the other.
    const lines = div('insp-edge-paths');
    lines.append(pathLine(paths.ends[0]), pathLine(`→ ${paths.ends[1]}`));
    frag.push(lines);
  }

  const chiprow = div('insp-chiprow');
  const chip = div(`insp-chip${cls === 'none' || cls === 'agent' ? ' weak' : cls === 'stale' ? ' stale' : ''}`, CLASS_LABEL[cls]);
  chiprow.append(chip, div('insp-chipnote', 'evidence class'));
  frag.push(chiprow);

  frag.push(div('insp-divider'));
  frag.push(div('eyebrow', 'CITED AT'));
  frag.push(div('insp-cite', citation(e)));
  if (cls === 'stale') {
    frag.push(div('insp-ref-note', e.evidenceSnippet.length > 0
      ? 'Source citation could not be re-anchored at the last checkpoint. Location is as last seen.'
      : 'Source citation has no captured source line. Location is as last seen.'));
  }

  frag.push(...renderCodeSection(`edge:${e.id}`, m, actions));

  frag.push(div('insp-divider'));
  const { who, text } = edgeProvenance(e, cls);
  const prov = div('insp-prov');
  prov.append(div(`insp-glyph ${who}`), div('insp-provtext', text));
  frag.push(prov);

  const actionsRow = div('insp-actions');
  const copyCitation = btn('ctl strong', 'copy citation', () => {
    const [cur] = currentEdges([e]);
    void copyText(cur.evidence.length > 0 ? cur.evidence : '(none)').then(ok =>
      flashLabel(copyCitation, ok, 'copy citation')
    );
  });
  actionsRow.append(copyCitation);
  if (!m.readOnly) {
    actionsRow.append(
      btn('ctl', 'hide edge…', () => currentActions(actions).hideEdges(currentEdges([e]))),
      btn('ctl', 'delete', () => currentActions(actions).deleteEdges(currentEdges([e])))
    );
  }
  frag.push(actionsRow);
  inspectorEl.replaceChildren(...frag);
}

function renderEdgesInspector(edges: Edge[], m: InspectorModel, actions: InspectorActions): void {
  const frag: HTMLElement[] = [];
  frag.push(div('eyebrow', 'SELECTION'));
  frag.push(div('insp-title', `${edges.length} edges`));

  const byClass = new Map<EvidenceClass, number>();
  for (const e of edges) {
    const c = evidenceClass(e.evidence, e.evidenceStatus);
    byClass.set(c, (byClass.get(c) ?? 0) + 1);
  }
  const summary = [...byClass.entries()]
    .sort((a, b) => CLASS_RANK[b[0]] - CLASS_RANK[a[0]])
    .map(([c, n]) => `${n} ${CLASS_LABEL[c]}`)
    .join(' · ');
  frag.push(div('insp-sum', summary));

  frag.push(div('insp-divider'));
  const list = div('insp-list');
  // evidence rolls up weakest first
  for (const e of [...edges].sort(
    (a, b) => CLASS_RANK[evidenceClass(a.evidence, a.evidenceStatus)] - CLASS_RANK[evidenceClass(b.evidence, b.evidenceStatus)]
  )) {
    const cls = evidenceClass(e.evidence, e.evidenceStatus);
    const item = div('insp-item');
    const head = div('insp-item-head');
    head.append(
      div('insp-item-edge', edgeName(e, m.nodesById)),
      div(
        `insp-item-cls${cls === 'import' || cls === 'source' ? ' strong' : ''}${cls === 'none' ? ' italic' : ''}`,
        CLASS_LABEL[cls]
      )
    );
    item.append(head, div('insp-item-at', citation(e)));
    list.append(item);
  }
  frag.push(list);

  if (!m.readOnly) {
    const actionsRow = div('insp-actions');
    actionsRow.append(btn('ctl strong', 'hide as set…', () => currentActions(actions).hideEdges(currentEdges(edges))));
    frag.push(actionsRow);
  }
  inspectorEl.replaceChildren(...frag);
}

/** The provenance glyph class for a chart source: `human:` and `agent:` (any
 *  case, as the reducer trims them) name who supplied it; anything else is neutral. */
function provenanceWho(source: string): 'human' | 'agent' | 'sample' {
  return isHumanSource(source) ? 'human' : source.trim().toLowerCase().startsWith('agent:') ? 'agent' : 'sample';
}

/** A chart: eyebrow, title, chips, the data form (chart-inspector.ts), the
 *  node's DOC and CODE refs, provenance from the chart's source, and the actions. */
function renderChartInspector(n: Node, m: InspectorModel, actions: InspectorActions): void {
  const row = m.chartRow?.(n.id);
  const frag: HTMLElement[] = [div('eyebrow', 'CHART'), div('insp-title', n.label)];
  const chiprow = div('insp-chiprow');
  chiprow.append(div('insp-chip', row?.type ?? 'chart'));
  if (n.sublabel.length > 0) {
    chiprow.append(div('insp-chipnote', n.sublabel));
  }
  if (n.focal) {
    chiprow.append(div('insp-chip', 'focal'));
  }
  frag.push(chiprow);
  const sections = renderChartSections(n, row, {
    setChartData: (nodeId, patch) => {
      // A collaborator deleted the chart mid-draft: the blur some browsers
      // fire as the field leaves the panel must not save it.
      if (m.chartRow?.(nodeId) === undefined) {
        return Promise.resolve();
      }
      // Read at save time: a kept panel must save through the newest actions.
      const save = currentActions(actions).setChartData;
      return save === undefined ? Promise.reject(new Error('charts cannot be edited here')) : save(nodeId, patch);
    },
  });
  if (m.readOnly) {
    // A public example: the data reads, but no control can change it.
    const view = document.createElement('fieldset');
    view.className = 'chart-view-only';
    view.disabled = true;
    view.append(...sections);
    frag.push(view);
  } else {
    frag.push(...sections);
  }
  frag.push(...renderPinSection(n, m, actions));
  if (n.doc.length > 0) {
    frag.push(div('insp-divider'), div('eyebrow', 'DOC'), div('insp-body', n.doc));
  }
  frag.push(...renderCodeSection(`node:${n.id}`, m, actions));
  frag.push(div('insp-divider'));
  // The glyph and the text both follow the chart's source: who supplied the
  // numbers, not who drew the card. Sample data and any source with neither
  // prefix (a note a person typed, say) is neither: the board never says
  // "machine-made" for words it cannot vouch for.
  const { who, text } = row === undefined
    ? nodeProvenance(n, m)
    : row.source === SAMPLE_SOURCE
      ? { who: 'sample', text: 'sample data · edit it to use your own' }
      : { who: provenanceWho(row.source), text: `source: ${row.source}` };
  const prov = div('insp-prov');
  prov.append(div(`insp-glyph ${who}`), div('insp-provtext', text));
  frag.push(prov);
  if (!m.readOnly) {
    const actionsRow = div('insp-actions');
    actionsRow.append(btn('ctl strong', 'hide node…', () => currentActions(actions).hideNodes(currentNodes([n]))));
    frag.push(actionsRow);
  }
  inspectorEl.replaceChildren(...frag);
}

/** PINNED TO: the edge or component a chart measures, picked from the board's edges and components. */
function renderPinSection(n: Node, m: InspectorModel, actions: InspectorActions): HTMLElement[] {
  if (m.chartPin === undefined) return [];
  const pin = m.chartPin(n.id);
  const names = new Map(m.nodes.map(x => [x.id, x.label || `node ${x.id}`]));
  const select = document.createElement('select');
  select.className = 'chart-pin-select';
  select.setAttribute('aria-label', 'Pinned to');
  const add = (value: string, text: string) => {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = text;
    select.append(o);
  };
  add('', 'not pinned');
  for (const e of m.edges) add(`edge:${e.id}`, `${names.get(e.fromNode) ?? '?'} → ${names.get(e.toNode) ?? '?'}${e.label ? ` · ${e.label}` : ''}`);
  for (const x of m.nodes) if (!['chart', 'text', 'note', 'boundary'].includes(x.kind)) add(`node:${x.id}`, names.get(x.id)!);
  select.value = pin ? `${pin.targetKind}:${pin.targetId}` : '';
  select.disabled = m.readOnly === true || currentActions(actions).pinChart === undefined;
  select.addEventListener('change', () => {
    const [targetKind, id] = select.value.split(':');
    currentActions(actions).pinChart?.(n.id, targetKind ? { targetKind, targetId: BigInt(id) } : null);
  });
  return [div('insp-divider'), div('eyebrow', 'PINNED TO'), select];
}

function renderNodeInspector(n: Node, m: InspectorModel, actions: InspectorActions): void {
  if (n.kind === 'chart') {
    renderChartInspector(n, m, actions);
    return;
  }
  const frag: HTMLElement[] = [];
  frag.push(div('eyebrow', 'NODE'));
  frag.push(div('insp-title', n.label));

  const chiprow = div('insp-chiprow');
  chiprow.append(div('insp-chip', n.kind));
  if (n.sublabel.length > 0) {
    chiprow.append(div('insp-chipnote', n.sublabel));
  }
  if (n.focal) {
    chiprow.append(div('insp-chip', 'focal'));
  }
  frag.push(chiprow);

  const threats = m.threats?.get(n.id);
  if (threats && threats.length > 0) {
    frag.push(div('insp-divider'));
    frag.push(div('eyebrow', 'THREAT'));
    if (m.threatPanel?.anchorId === n.id) frag.push(m.threatPanel.el);
    else frag.push(...renderThreats(threats, { openCard: id => currentActions(actions).openThreatCard?.(n.id, id) }));
  }

  // A change note is the one thing on this node a reviewer must not miss: first.
  const notes = m.changeNotes?.get(n.id);
  if (notes && notes.length > 0) {
    frag.push(div('insp-divider'));
    frag.push(div('eyebrow', 'CHANGE'));
    frag.push(
      ...renderChangeNotes({
        notes,
        refRow: m.refRow,
        canReview: m.canReview === true,
        theme: codeTheme(),
        markReviewed: actions.markReviewed && ((id, reviewed) => currentActions(actions).markReviewed?.(id, reviewed)),
        copyFix:
          actions.copyFixPrompt &&
          ((text, b) => void currentActions(actions).copyFixPrompt?.(text).then(ok => flashLabel(b, ok, 'ask agent to fix'))),
      })
    );
  }

  if (n.doc.length > 0) {
    frag.push(div('insp-divider'));
    frag.push(div('eyebrow', 'DOC'));
    frag.push(div('insp-body', n.doc));
  }

  frag.push(...renderCodeSection(`node:${n.id}`, m, actions));

  frag.push(div('insp-divider'));
  const { who, text } = nodeProvenance(n, m);
  const prov = div('insp-prov');
  prov.append(div(`insp-glyph ${who}`), div('insp-provtext', text));
  frag.push(prov);

  if (!m.readOnly) {
    const actionsRow = div('insp-actions');
    actionsRow.append(btn('ctl strong', 'hide node…', () => currentActions(actions).hideNodes(currentNodes([n]))));
    frag.push(actionsRow);
  }
  inspectorEl.replaceChildren(...frag);
}

function renderNodesInspector(nodes: Node[], m: InspectorModel, actions: InspectorActions): void {
  const frag: HTMLElement[] = [];
  frag.push(div('eyebrow', 'SELECTION'));
  frag.push(div('insp-title', `${nodes.length} nodes`));
  frag.push(div('insp-divider'));
  const list = div('insp-list');
  for (const n of nodes) {
    const item = div('insp-item');
    const head = div('insp-item-head');
    head.append(div('insp-item-edge', n.label), div('insp-item-cls', n.kind));
    item.append(head);
    list.append(item);
  }
  frag.push(list);
  if (!m.readOnly) {
    const actionsRow = div('insp-actions');
    actionsRow.append(btn('ctl strong', 'hide as set…', () => currentActions(actions).hideNodes(currentNodes(nodes))));
    frag.push(actionsRow);
  }
  inspectorEl.replaceChildren(...frag);
}

/** Backstop after the async fill: put the reader back where they were unless
 *  they scrolled since the rebuild. */
function restoreScroll(): void {
  if (scrollWant !== null && inspectorEl.scrollTop === scrollWant.got && scrollWant.got < scrollWant.want) {
    inspectorEl.scrollTop = scrollWant.want;
  }
  scrollWant = null;
}

type SnippetScroll = { refId: string; top: number };

/** The open snippet's own scroll offset, when the reader has moved it. */
function snippetScroll(): SnippetScroll | null {
  const item = inspectorEl.querySelector<HTMLElement>('.insp-ref.on');
  const top = item?.querySelector<HTMLElement>('.insp-code-scroll')?.scrollTop ?? 0;
  return item?.dataset.refId !== undefined && top > 0 ? { refId: item.dataset.refId, top } : null;
}

/** Put the snippet back where the reader had it, if the same ref is open.
 *  Chrome drops an element's scroll offset when it leaves the document, so
 *  even a kept body that moved across needs this. */
function restoreSnippetScroll(kept: SnippetScroll): void {
  const item = inspectorEl.querySelector<HTMLElement>('.insp-ref.on');
  const scroller = item?.dataset.refId === kept.refId ? item.querySelector<HTMLElement>('.insp-code-scroll') : null;
  if (scroller !== null && scroller.scrollTop !== kept.top) {
    scroller.scrollTop = kept.top;
  }
}

/** After a rebuild: focus the same control in the same ref, else that ref's
 *  row, else the same panel control, else the panel. */
function restoreFocus(act: string | undefined, refId: string | undefined): void {
  const item = refId === undefined
    ? undefined
    : [...inspectorEl.querySelectorAll<HTMLElement>('.insp-ref')].find(el => el.dataset.refId === refId);
  const byAct = (scope: HTMLElement) =>
    [...scope.querySelectorAll<HTMLElement>('[data-act]')].find(el => el.dataset.act === act);
  const target = act !== undefined
    ? (item !== undefined ? byAct(item) : undefined) ?? byAct(inspectorEl)
    : item?.querySelector<HTMLElement>(':scope > .insp-ref-row');
  (target ?? inspectorEl).focus({ preventScroll: true });
}

// `Node` and `Selection` here are board row types; these are the DOM ones.
type DomSelection = NonNullable<ReturnType<typeof getSelection>>;
type DomNode = NonNullable<DomSelection['anchorNode']>;
type SelectionMark = { anchor: DomNode; anchorOffset: number; focus: DomNode; focusOffset: number };

/** The reader's text selection, when it lies inside the panel. */
function inspectorSelection(): SelectionMark | null {
  const sel = typeof getSelection === 'function' ? getSelection() : null;
  if (sel === null || sel.rangeCount === 0 || sel.isCollapsed || sel.anchorNode === null || sel.focusNode === null) {
    return null;
  }
  if (!inspectorEl.contains(sel.anchorNode) || !inspectorEl.contains(sel.focusNode)) {
    return null;
  }
  return { anchor: sel.anchorNode, anchorOffset: sel.anchorOffset, focus: sel.focusNode, focusOffset: sel.focusOffset };
}

/** Put a selection back if its nodes made it into the rebuilt panel. */
function restoreSelection(mark: SelectionMark | null): void {
  if (mark === null || !inspectorEl.contains(mark.anchor) || !inspectorEl.contains(mark.focus)) {
    return;
  }
  getSelection()?.setBaseAndExtent(mark.anchor, mark.anchorOffset, mark.focus, mark.focusOffset);
}

export function renderInspector(
  allSelectedNodes: Node[],
  allSelectedEdges: Edge[],
  m: InspectorModel,
  actions: InspectorActions
): void {
  // A hidden target is never shown. main.ts selects from visible rows, and a
  // stale selection that still names a hidden row must not resurrect it.
  const selectedNodes = allSelectedNodes.filter(n => !n.hidden);
  const selectedEdges = allSelectedEdges.filter(e => !e.hidden);

  liveNodes = selectedNodes;
  liveEdges = selectedEdges;
  lastActions = actions;

  const sig = signature(selectedNodes, selectedEdges, m);
  if (sig === lastSig) {
    return; // same inputs: keep scroll, text selection and the "copied" state
  }
  lastSig = sig;
  lastRefs = [];

  // replaceChildren detaches a focused row or control and drops focus to
  // <body>, after which the panel's keys stop working. Remember what had
  // focus so the rebuilt panel can take it back.
  const active = document.activeElement;
  const hadFocus = active instanceof HTMLElement && active !== inspectorEl && inspectorEl.contains(active);
  const focusAct = hadFocus ? active.dataset.act : undefined;
  const focusRefId = hadFocus ? active.closest<HTMLElement>('.insp-ref')?.dataset.refId : undefined;
  // Same target: the rebuild must not move the reader (DoD Robustness).
  const targetIds = [...selectedNodes.map(n => `n${n.id}`), ...selectedEdges.map(e => `e${e.id}`)].join(',');
  const keepScroll = targetIds === lastTargetIds ? inspectorEl.scrollTop : null;
  // The open snippet scrolls in its own capped box: same rule as the panel.
  const keepSnippet = keepScroll !== null ? snippetScroll() : null;
  lastTargetIds = targetIds;
  scrollWant = null;
  // Moving a kept body out of the old tree collapses a selection inside it;
  // its nodes survive, so the same boundaries can be put back afterwards.
  const keptSelection = inspectorSelection();
  reusableBodies = keepScroll !== null ? [...inspectorEl.querySelectorAll<HTMLElement>('.insp-ref-body')] : [];

  if (selectedEdges.length === 1 && selectedNodes.length === 0) {
    renderEdgeInspector(selectedEdges[0], m, actions);
  } else if (selectedEdges.length > 1 && selectedNodes.length === 0) {
    renderEdgesInspector(selectedEdges, m, actions);
  } else if (selectedNodes.length === 1 && selectedEdges.length === 0) {
    renderNodeInspector(selectedNodes[0], m, actions);
  } else if (selectedNodes.length > 1) {
    renderNodesInspector(selectedNodes, m, actions);
  } else {
    reusableBodies = [];
    inspectorEl.hidden = true;
    inspectorEl.replaceChildren();
    lastExpanded = null;
    return;
  }
  reusableBodies = [];
  inspectorEl.hidden = false;
  if (keepScroll !== null) {
    inspectorEl.scrollTop = keepScroll;
    scrollWant = { want: keepScroll, got: inspectorEl.scrollTop };
  } else {
    inspectorEl.scrollTop = 0;
  }
  if (keepSnippet !== null) {
    restoreSnippetScroll(keepSnippet);
  }
  if (hadFocus && !inspectorEl.contains(document.activeElement)) {
    restoreFocus(focusAct, focusRefId);
  }
  restoreSelection(keptSelection);

  // Animate the body only when a different ref opened, not on every rebuild.
  const key = targetKey(selectedNodes, selectedEdges);
  const expanded = key !== null ? expandedFor(m.refsByTarget.get(key) ?? [], m.expandedRef) : null;
  if (expanded !== lastExpanded) {
    const body = inspectorEl.querySelector<HTMLElement>('.insp-ref-body');
    if (body !== null) {
      animateOpen(body);
    }
  }
  lastExpanded = expanded;
}
