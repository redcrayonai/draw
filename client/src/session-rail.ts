import type { Session } from './module_bindings/types';
import type { Coverage } from './refs';
import { appendPathText, buildEditorHref } from './editor-link';
import { disclosureIcon, warnIcon } from './icons';
import type { RouteModel } from './route';

export interface SessionModel {
  session: Session | null;
  coverage: Coverage;
  /** `label || sublabel` of the node the agent's selection row names, or null. */
  agentFocus: string | null;
  /** That node's sublabel (its path), shown in the focus line's title (G37). */
  agentFocusPath?: string;
  now: number;
  codeOverlay: boolean;
  /** Live refs on this board (orphans excluded) — drives the empty hint. */
  refCount: number;
  editorScheme: string;
  /** Live refs whose lines are as last seen, by status (G12). */
  refStatus: { stale: number; ambiguous: number };
  /** Select the next node or edge that holds a stale or ambiguous ref. */
  onSelectStale?: () => void;
  route?: RouteModel | null;
  /** Inspect a waypoint; arrivals belong to the agent's explicit route operation. */
  onSelectWaypoint?: (nodeId: bigint) => void;
  /** Animate a dot along the route's waypoints on this canvas only. */
  onPlayRoute?: () => void;
  /** The board's latest played trace, as one line; null when none. */
  trace?: string | null;
  onReplayTrace?: () => void;
  /** Change notes on this board and changed migrations no note cites (spec 2026-10-16). */
  changeNotes?: { counts: { notes: number; byKind: Partial<Record<string, number>>; staleReaders: number }; unconfirmed: number };
  /** Select the next node that anchors a change note. */
  onSelectNote?: () => void;
  /** The threat line (threatRailText); empty or absent when there are none to show. */
  threats?: string;
  /** Every threat is contained: the line drops from red to muted. */
  threatsContained?: boolean;
  /** Open the next open threat's card. */
  onSelectThreat?: () => void;
}

/**
 * The line under the code overlay switch (P1): below 60% zoom the badges
 * hide with the sublabels while the switch still reads on, so the rail
 * says why. Null when there is nothing to disclose.
 */
export function codeOverlayHint(m: { codeOverlay: boolean; dense: boolean; refCount: number }): string | null {
  return m.codeOverlay && m.dense && m.refCount > 0 ? 'ref badges show at 60% zoom and up' : null;
}

/** How long the checkpoint line carries `.pulse` after a new checkpoint lands. */
export const PULSE_MS = 400;

export function relativeTime(fromMs: number, nowMs: number): string {
  const s = Math.max(0, Math.floor((nowMs - fromMs) / 1000));
  if (s < 45) {
    return 'just now';
  }
  if (s < 3600) {
    return `${Math.max(1, Math.floor(s / 60))} min ago`;
  }
  if (s < 86_400) {
    return `${Math.floor(s / 3600)} h ago`;
  }
  return `${Math.floor(s / 86_400)} d ago`;
}

interface BlockState {
  checkpoint: number | null;
  pulseUntil: number;
  /** Chips the reader has expanded (view-local, survives re-renders). */
  open: Set<string>;
  /** Signature of the last full build; null forces a rebuild. */
  sig: string | null;
  /** The checkpoint line of the last build, patched in place by clock ticks. */
  line: HTMLElement | null;
  /** The latest model's handler: a memo hit keeps the button, not the closure. */
  onSelectStale: (() => void) | undefined;
  onSelectNote: (() => void) | undefined;
  onSelectThreat: (() => void) | undefined;
  onSelectWaypoint: ((nodeId: bigint) => void) | undefined;
  onPlayRoute: (() => void) | undefined;
  onReplayTrace: (() => void) | undefined;
  routeHistoryOpen: boolean;
}

const states = new WeakMap<HTMLElement, BlockState>();

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

function pathList(key: string, paths: string[], hrefFor: (p: string) => string | null): HTMLDivElement {
  const list = div('chip-paths');
  list.dataset.key = key;
  list.hidden = true;
  for (const p of paths) {
    const row = div('chip-path');
    const name = span('chip-path-name', '');
    appendPathText(name, p);
    row.append(name);
    const href = hrefFor(p);
    if (href !== null) {
      const a = document.createElement('a');
      a.className = 'chip-open';
      a.dataset.path = p;
      a.setAttribute('href', href);
      a.textContent = 'open';
      a.title = `Open ${p} in your editor`;
      row.append(a);
    }
    list.append(row);
  }
  return list;
}

interface Group {
  key: string;
  label: string;
  /** What the chip lists, before the shared ' · click to list the paths'. */
  what: string;
  cls: string;
  paths: string[];
  links: boolean;
}

function checkpointText(s: Session, now: number): string {
  return s.checkpoint === 0
    ? 'no checkpoint yet'
    : `checkpoint ${s.checkpoint} · ${relativeTime(s.updatedAt.toDate().getTime(), now)}`;
}

/** `N changed · C on board · E excluded · U not on board`. Each figure is a
 *  nowrap span, so the line wraps only between figures (G37); the debt chip
 *  below carries the warning, so the line has no ⚠ of its own. */
function reconciliation(c: Coverage): HTMLElement {
  const excluded = c.excluded.reduce((n, g) => n + g.paths.length, 0);
  const uncovered = c.uncovered.length;
  const onBoard = Math.max(0, c.changed - excluded - uncovered);
  const line = div(`session-recon${uncovered > 0 ? ' debt' : ''}`);
  const parts = [`${c.changed} changed`, `${onBoard} on board`, `${excluded} excluded`, `${uncovered} not on board`];
  parts.forEach((p, i) => {
    if (i > 0) {
      line.append(' · ');
    }
    line.append(span('recon-part', p));
  });
  return line;
}

/**
 * Everything the block renders except the ticking relative time (patched in
 * place) and the reader's open chips (toggled in place). Live sessions call
 * renderSessionBlock on every table change, selection change and 30 s tick;
 * an unchanged signature must leave the DOM alone so focus, text selection
 * and a running pulse survive.
 */
function signature(s: Session, m: SessionModel): string {
  return JSON.stringify([
    s.checkpoint,
    s.repoRoot,
    m.agentFocus,
    m.coverage,
    m.codeOverlay && m.refCount === 0,
    m.editorScheme,
    m.refStatus.stale,
    m.refStatus.ambiguous,
    m.route?.key,
    m.trace,
    m.changeNotes,
    m.threats,
    m.threatsContained,
  ]);
}

type FocusMark = { chip: string } | { list: string; path: string } | null;

function focusMark(el: HTMLElement): FocusMark {
  const a = document.activeElement;
  if (!(a instanceof HTMLElement) || !el.contains(a)) {
    return null;
  }
  if (a.dataset.key !== undefined && a.matches('.chip, .session-stale, .session-threats, .session-notes, .session-waypoint, .session-route-history-toggle, .session-route-play, .session-trace-play')) {
    return { chip: a.dataset.key };
  }
  const list = a.closest<HTMLElement>('.chip-paths');
  if (a.dataset.path !== undefined && list?.dataset.key !== undefined) {
    return { list: list.dataset.key, path: a.dataset.path };
  }
  return null;
}

function restoreFocus(el: HTMLElement, mark: FocusMark): void {
  if (mark === null || el.contains(document.activeElement)) {
    return;
  }
  let target: HTMLElement | undefined;
  if ('chip' in mark) {
    target = [...el.querySelectorAll<HTMLElement>('.chip, .session-stale, .session-threats, .session-notes, .session-waypoint, .session-route-history-toggle, .session-route-play, .session-trace-play')].find(c => c.dataset.key === mark.chip);
  } else {
    const list = [...el.querySelectorAll<HTMLElement>('.chip-paths')].find(l => l.dataset.key === mark.list);
    target = [...(list?.querySelectorAll<HTMLElement>('a.chip-open') ?? [])].find(a => a.dataset.path === mark.path);
  }
  target?.focus({ preventScroll: true });
}

/**
 * Render the SESSION block. Spec §8: a board without a session row shows no
 * session chrome at all, so `session === null` empties and hides `el`
 * regardless of the overlay; the "no code refs yet" hint lives inside the
 * block and needs the overlay on and an empty index.
 */
export function renderSessionBlock(el: HTMLElement, m: SessionModel): void {
  let st = states.get(el);
  if (st === undefined) {
    st = { checkpoint: null, pulseUntil: 0, open: new Set(), sig: null, line: null, onSelectStale: undefined, onSelectNote: undefined, onSelectThreat: undefined, onSelectWaypoint: undefined, onPlayRoute: undefined, onReplayTrace: undefined, routeHistoryOpen: false };
    states.set(el, st);
  }
  const state = st;
  state.onSelectStale = m.onSelectStale;
  state.onSelectNote = m.onSelectNote;
  state.onSelectThreat = m.onSelectThreat;
  state.onSelectWaypoint = m.onSelectWaypoint;
  state.onPlayRoute = m.onPlayRoute;
  state.onReplayTrace = m.onReplayTrace;
  const s = m.session;

  if (s === null) {
    state.checkpoint = null;
    state.sig = null;
    state.line = null;
    if (!el.hidden || el.firstChild !== null) {
      el.hidden = true;
      el.replaceChildren();
    }
    return;
  }

  const lineText = checkpointText(s, m.now);
  const sig = signature(s, m);
  if (sig === state.sig && state.line !== null && el.contains(state.line)) {
    // Memo hit: patch the ticking time and expire the pulse, nothing else.
    if (state.line.textContent !== lineText) {
      state.line.textContent = lineText;
    }
    if (m.now >= state.pulseUntil && state.line.classList.contains('pulse')) {
      state.line.classList.remove('pulse');
    }
    return;
  }
  state.sig = sig;

  // The pulse goes on the one render where the checkpoint advanced; a later
  // rebuild inside the window (a burst of agent writes) does not restart it.
  const advanced = state.checkpoint !== null && s.checkpoint > state.checkpoint;
  if (advanced) {
    state.pulseUntil = m.now + PULSE_MS;
  }
  state.checkpoint = s.checkpoint;

  const mark = focusMark(el);
  state.routeHistoryOpen = el.querySelector<HTMLDetailsElement>('.session-route-history')?.open ?? state.routeHistoryOpen;
  const frag: HTMLElement[] = [];

  frag.push(div('eyebrow', 'SESSION'));
  const line = div('session-line', lineText);
  if (advanced) {
    line.classList.add('pulse');
  }
  state.line = line;
  frag.push(line);

  if (m.agentFocus !== null) {
    // One line, ellipsis when long; the title carries the path (or the full name).
    const focus = div('session-focus', `agent on ${m.agentFocus}`);
    focus.title = m.agentFocusPath || m.agentFocus;
    frag.push(focus);
  }

  if (m.route !== undefined && m.route !== null) {
    const route = m.route;
    const block = div('session-route');
    block.append(div('session-route-destination', `destination: ${route.destination}`));
    block.append(div('session-route-progress', route.progress));
    if (route.waypoints.filter(w => w.availability === 'visible').length >= 2) {
      const play = document.createElement('button');
      play.type = 'button';
      play.className = 'session-route-play';
      play.dataset.key = 'route-play';
      play.textContent = '\u25B6 Play route';
      play.title = 'Send a dot along the route (only on your screen)';
      play.addEventListener('click', () => state.onPlayRoute?.());
      block.append(play);
    }
    const list = document.createElement('ol');
    list.className = 'session-waypoints';
    list.setAttribute('aria-label', 'Route waypoints');
    for (const waypoint of route.waypoints) {
      const row = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'session-waypoint';
      button.dataset.key = `waypoint:${waypoint.nodeId}`;
      button.dataset.status = waypoint.status;
      button.setAttribute('aria-label', `Waypoint ${waypoint.number}: ${waypoint.label} · ${waypoint.status}`);
      button.disabled = waypoint.availability !== 'visible';
      if (waypoint.status === 'current') {
        button.setAttribute('aria-current', 'step');
      }
      button.title = button.disabled ? `Cannot inspect ${waypoint.label}` : `Inspect ${waypoint.label}`;
      button.append(span('session-waypoint-number', String(waypoint.number)), span('session-waypoint-label', waypoint.label), span('session-waypoint-status', ` ${waypoint.status}`));
      button.addEventListener('click', () => state.onSelectWaypoint?.(waypoint.nodeId));
      row.append(button);
      list.append(row);
    }
    block.append(list);
    const history = document.createElement('details');
    history.className = 'session-route-history';
    history.open = state.routeHistoryOpen;
    history.addEventListener('toggle', () => {
      if (el.contains(history)) {
        state.routeHistoryOpen = history.open;
      }
    });
    const summary = document.createElement('summary');
    summary.className = 'session-route-history-toggle';
    summary.dataset.key = 'route-history';
    summary.textContent = `Route history (${route.history.length})`;
    history.append(summary);
    const events = document.createElement('ol');
    for (const event of route.history) {
      const row = document.createElement('li');
      row.textContent = event.text;
      events.append(row);
    }
    history.append(events);
    block.append(history);
    frag.push(block);
  }

  if (m.trace) {
    const block = div('session-route session-trace');
    block.append(div('session-route-progress', `last trace: ${m.trace}`));
    const play = document.createElement('button');
    play.type = 'button';
    play.className = 'session-route-play session-trace-play';
    play.dataset.key = 'trace-play';
    play.textContent = '\u25B6 Replay trace';
    play.title = 'Replay the last trace an agent sent (only on your screen)';
    play.addEventListener('click', () => state.onReplayTrace?.());
    block.append(play);
    frag.push(block);
  }

  const c = m.coverage;
  // Disclosure: once anything changed, the totals reconcile on screen
  // (changed = on board + excluded + not on board), including the fully
  // covered case where no debt chip exists. Nothing changed is said once,
  // by the empty line below (G37).
  if (s.checkpoint >= 1 && c.changed > 0) {
    frag.push(reconciliation(c));
  }

  const chips = div('session-chips');
  const nothing =
    c.changed === 0 && c.uncovered.length === 0 && c.excluded.length === 0 && c.deleted.length === 0;
  if (s.checkpoint === 0) {
    // coverage is '{}' until the first mark_checkpoint, however much the
    // agent has already edited: "nothing changed" would be a false statement.
    chips.append(div('session-empty', 'coverage appears at the first checkpoint'));
  } else if (nothing) {
    chips.append(div('session-empty', 'nothing changed since the session started'));
  } else {
    const groups: Group[] = [];
    if (c.uncovered.length > 0) {
      const n = c.uncovered.length;
      groups.push({
        key: 'uncovered',
        label: `${n} changed file${n === 1 ? '' : 's'} not on board`,
        what: 'Changed files not on the board',
        cls: 'debt',
        paths: c.uncovered,
        links: true,
      });
    }
    for (const g of c.excluded) {
      groups.push({
        key: `ex:${g.reason}`,
        label: `${g.paths.length} · ${g.reason}`,
        what: `Excluded: ${g.reason}`,
        cls: '',
        paths: g.paths,
        links: true,
      });
    }
    if (c.deleted.length > 0) {
      groups.push({
        key: 'deleted',
        label: `${c.deleted.length} deleted`,
        what: 'Deleted since the session started',
        cls: '',
        paths: c.deleted,
        links: false,
      });
    }
    const hrefFor = (p: string) => buildEditorHref(m.editorScheme, s.repoRoot, p, 1);
    for (const g of groups) {
      const chip = document.createElement('button');
      chip.className = `chip${g.cls ? ` ${g.cls}` : ''}`;
      chip.dataset.key = g.key;
      if (g.cls === 'debt') {
        chip.append(warnIcon());
      }
      chip.append(g.label, disclosureIcon());
      chip.title = `${g.what} · click to list the paths`;
      const list = pathList(g.key, g.paths, g.links ? hrefFor : () => null);
      const apply = () => {
        const open = state.open.has(g.key);
        chip.classList.toggle('active', open);
        chip.setAttribute('aria-expanded', open ? 'true' : 'false');
        list.hidden = !open;
      };
      chip.addEventListener('click', () => {
        if (state.open.has(g.key)) {
          state.open.delete(g.key);
        } else {
          state.open.add(g.key);
        }
        apply();
      });
      apply();
      chips.append(chip, list);
    }
  }
  frag.push(chips);

  // Refs whose lines are as last seen, counted at board level (G12).
  const { stale, ambiguous } = m.refStatus;
  if (stale + ambiguous > 0) {
    const parts = [stale > 0 ? `${stale} stale` : '', ambiguous > 0 ? `${ambiguous} ambiguous` : ''].filter(Boolean);
    const total = stale + ambiguous;
    const btn = document.createElement('button');
    btn.className = 'session-stale';
    btn.dataset.key = 'stale';
    btn.textContent = `${parts.join(' · ')} ref${total === 1 ? '' : 's'}`;
    btn.title = total === 1 ? 'Select the node that holds it' : 'Select the next node that holds one';
    btn.addEventListener('click', () => state.onSelectStale?.());
    frag.push(btn);
  }

  if (m.threats) {
    const btn = document.createElement('button');
    btn.className = m.threatsContained ? 'session-threats is-contained' : 'session-threats';
    btn.dataset.key = 'threats';
    btn.textContent = m.threats;
    btn.title = 'Open the next threat';
    btn.addEventListener('click', () => state.onSelectThreat?.());
    frag.push(btn);
  }

  // Change notes, counted at board level like stale refs (spec 2026-10-16).
  const notesText = changeNotesText(m.changeNotes);
  if (notesText !== '') {
    const btn = document.createElement('button');
    btn.className = 'session-notes';
    btn.dataset.key = 'notes';
    btn.textContent = notesText;
    btn.title = 'Select the next node with a change note';
    btn.addEventListener('click', () => state.onSelectNote?.());
    frag.push(btn);
  }

  // Overlay on with zero refs on a session board: one line, inside the block.
  if (m.codeOverlay && m.refCount === 0) {
    frag.push(div('session-hint', 'no code refs yet — the agent adds them at checkpoints'));
  }

  frag.push(div('rail-divider'));
  el.hidden = false;
  el.replaceChildren(...frag);
  restoreFocus(el, mark);
}

const NOTE_KIND_NOUN: Record<string, [string, string]> = {
  migration: ['migration', 'migrations'],
  'breaking-api': ['breaking API change', 'breaking API changes'],
  'data-loss': ['data-loss change', 'data-loss changes'],
  dependency: ['new dependency', 'new dependencies'],
};
const count = (n: number, [one, many]: [string, string]) => `${n} ${n === 1 ? one : many}`;

/** "1 migration · 1 reader not updated · 1 unconfirmed migration", or '' when there is nothing to say. */
function changeNotesText(c: SessionModel['changeNotes']): string {
  if (!c) return '';
  const parts = Object.entries(c.counts.byKind).flatMap(([kind, n]) => (n ? [count(n, NOTE_KIND_NOUN[kind] ?? ['change', 'changes'])] : []));
  if (c.counts.staleReaders > 0) parts.push(`${count(c.counts.staleReaders, ['reader', 'readers'])} not updated`);
  if (c.unconfirmed > 0) parts.push(count(c.unconfirmed, ['unconfirmed migration', 'unconfirmed migrations']));
  return parts.join(' · ');
}
