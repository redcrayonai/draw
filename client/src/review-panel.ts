// Red crayon review history (spec 2026-10-19 D5, D6): #act-review's unread
// badge and #review-pop, plus #mark-banner with the agents' state on the canvas.
import { dismissible } from './chrome';
import { LISTENING_MICROS } from '../../module/src/marks';

/** A fully answered round shows "N of M answered" this long after its last reply, then the banner hides. */
export const ANSWERED_SHOW_MICROS = 10n * 60_000_000n;

type Micros = { microsSinceUnixEpoch: bigint };
/** The visible_mark columns the panel reads (a module_bindings Mark fits). */
export interface MarkRow {
  id: bigint;
  nodeId: bigint;
  nodeLabel: string;
  note: string;
  round: number;
  claimedBy: string;
  leaseUntil: Micros;
  status: string;
  reply: string;
  files: string;
  sentAt: Micros;
  answeredAt: Micros;
}
export interface Round { round: number; sentAt: bigint; marks: MarkRow[] }
export interface BannerState { kind: 'none' | 'not-listening' | 'waiting' | 'working' | 'answered'; done: number; total: number }
/** Marks, waiters and the sender's read cursor of the shown board. */
export interface ReviewModel { marks: MarkRow[]; lastReadAt: bigint; waiters: { owner: string; lastWaitAt: bigint }[]; now: bigint }
export interface ReviewDeps {
  /** The person may only read this board: no crayon, so no Review button either. */
  readOnly(): boolean;
  markRead(): Promise<unknown>;
  /** display name for an identity hex; "an agent" when unknown */
  agentName(hex: string): string;
  exists(nodeId: bigint): boolean;
  hoverNode(nodeId: bigint | null): void;
  panTo(nodeId: bigint): void;
}

const answered = (m: MarkRow) => m.status === 'fixed' || m.status === 'kept';
/** A claim whose lease ran out is open again (marks.ts claimable): the panel shows it sent. */
const statusOf = (m: MarkRow, now: bigint) => (m.status === 'claimed' && m.leaseUntil.microsSinceUnixEpoch <= now ? 'sent' : m.status);

export function unreadCount(marks: MarkRow[], lastReadAt: bigint): number {
  return marks.filter(m => answered(m) && m.answeredAt.microsSinceUnixEpoch > lastReadAt).length;
}

export function rounds(marks: MarkRow[]): Round[] {
  const by = new Map<number, MarkRow[]>();
  for (const m of marks) by.set(m.round, [...(by.get(m.round) ?? []), m]);
  return [...by]
    .sort(([a], [b]) => b - a)
    .map(([round, ms]) => {
      const sorted = ms.sort((a, b) => (a.id < b.id ? -1 : 1));
      return { round, sentAt: sorted[0].sentAt.microsSinceUnixEpoch, marks: sorted };
    });
}

const live = <W extends { lastWaitAt: bigint }>(waiters: W[], now: bigint) => waiters.filter(w => now - w.lastWaitAt < LISTENING_MICROS);
/** Some agent waited on the board's marks recently enough to count as listening. */
export const listening = (waiters: { lastWaitAt: bigint }[], now: bigint) => live(waiters, now).length > 0;

export function bannerState(marks: MarkRow[], waiters: { lastWaitAt: bigint }[], now: bigint): BannerState {
  const latest = rounds(marks)[0];
  const isListening = listening(waiters, now);
  if (latest === undefined) return { kind: isListening ? 'waiting' : 'none', done: 0, total: 0 };
  const done = latest.marks.filter(answered).length;
  const total = latest.marks.length;
  if (!isListening && latest.marks.some(m => statusOf(m, now) === 'sent')) return { kind: 'not-listening', done, total };
  if (done < total) return { kind: 'working', done, total };
  // All answered: a listening agent is news again; otherwise the result shows for a while, then goes.
  if (isListening) return { kind: 'waiting', done, total };
  const last = latest.marks.reduce((t, m) => (m.answeredAt.microsSinceUnixEpoch > t ? m.answeredAt.microsSinceUnixEpoch : t), 0n);
  return { kind: now - last < ANSWERED_SHOW_MICROS ? 'answered' : 'none', done, total };
}

const hexOf = (owner: string) => owner.split('/')[0];

function since(sentAt: bigint, now: bigint): string {
  const min = Number((now - sentAt) / 60_000_000n);
  return min < 1 ? 'just now' : min < 60 ? `${min} min ago` : `${Math.floor(min / 60)} h ago`;
}

function files(json: string): string[] {
  try {
    const list: unknown = JSON.parse(json);
    return Array.isArray(list) ? list.filter((f): f is string => typeof f === 'string') : [];
  } catch {
    return [];
  }
}

function span(cls: string, text: string): HTMLSpanElement {
  const s = document.createElement('span');
  s.className = cls;
  s.textContent = text;
  return s;
}

function row(m: MarkRow, model: ReviewModel, deps: ReviewDeps): HTMLButtonElement {
  const gone = !deps.exists(m.nodeId);
  const unread = answered(m) && m.answeredAt.microsSinceUnixEpoch > model.lastReadAt;
  const b = document.createElement('button');
  b.type = 'button';
  const status = statusOf(m, model.now);
  b.className = `mark-row ${status}${unread ? ' unread' : ''}${gone ? ' gone' : ''}`;
  if (gone) b.title = 'This node is no longer on the board';
  const head = span('mr-head', '');
  head.append(span('mr-label', m.nodeLabel), span(`mr-tag ${status}`, status));
  if (answered(m)) head.append(span('mr-who', deps.agentName(hexOf(m.claimedBy))));
  b.append(head);
  if (m.note !== '') b.append(span('mr-note', m.note));
  if (status === 'claimed') b.append(span('mr-reply', `claimed by ${deps.agentName(hexOf(m.claimedBy))}`));
  if (answered(m)) {
    const reply = span('mr-reply', m.reply);
    b.append(reply);
    const list = files(m.files);
    if (list.length > 0) b.append(span('mr-files', list.join(' · ')));
  }
  if (!gone) {
    b.addEventListener('pointerenter', () => deps.hoverNode(m.nodeId));
    b.addEventListener('focus', () => deps.hoverNode(m.nodeId));
    b.addEventListener('pointerleave', () => deps.hoverNode(null));
    b.addEventListener('blur', () => deps.hoverNode(null));
    b.addEventListener('click', () => deps.panTo(m.nodeId));
  }
  return b;
}

function renderPop(pop: HTMLElement, model: ReviewModel, deps: ReviewDeps): void {
  const all = rounds(model.marks);
  const head = document.createElement('div');
  head.className = 'review-head';
  head.append(span('review-title', 'Review'));
  if (all.length > 0) head.append(span('review-sum', `round ${all[0].round} · ${all[0].marks.filter(answered).length} answered`));
  const body = document.createElement('div');
  body.className = 'review-list';
  if (all.length === 0) body.append(span('review-empty', 'No marks yet. Circle a node with the red crayon (C) and Send.'));
  for (const r of all) {
    body.append(span('mr-round', `Round ${r.round} · ${since(r.sentAt, model.now)}`), ...r.marks.map(m => row(m, model, deps)));
  }
  pop.replaceChildren(head, body);
}

function paintBanner(banner: HTMLElement, model: ReviewModel, deps: ReviewDeps): void {
  const s = bannerState(model.marks, model.waiters, model.now);
  banner.hidden = s.kind === 'none';
  const dot = span('mb-dot', '');
  dot.setAttribute('aria-hidden', 'true');
  const b = (text: string) => { const el = document.createElement('b'); el.textContent = text; return el; };
  const open = s.total - s.done;
  const waiters = live(model.waiters, model.now);
  const parts: (Node | string)[] =
    s.kind === 'not-listening' ? ['No agent listening']
    : s.kind === 'working' ? ['Working on ', b(`${open} mark${open === 1 ? '' : 's'}`)]
    : s.kind === 'answered' ? [b(`${s.done} of ${s.total}`), ' answered']
    : s.kind === 'waiting'
      ? [b(deps.agentName(hexOf(waiters[0].owner))), waiters.length > 1 ? ` and ${waiters.length - 1} more are waiting for your marks` : ' is waiting for your marks']
      : [];
  // role="status": replacing unchanged copy on every waiter heartbeat would re-announce it.
  const text = parts.map(p => (typeof p === 'string' ? p : p.textContent)).join('');
  if (banner.dataset.state === s.kind && banner.textContent === text) return;
  banner.dataset.state = s.kind;
  banner.replaceChildren(dot, ...parts);
}

/** Wire the button and popover once; call the result with the board's marks on every change. */
export function setupReview(deps: ReviewDeps): (model: ReviewModel) => void {
  const btn = document.getElementById('act-review') as HTMLButtonElement;
  const pop = document.getElementById('review-pop') as HTMLElement;
  const badge = document.getElementById('review-badge') as HTMLElement;
  const banner = document.getElementById('mark-banner') as HTMLElement;
  let model: ReviewModel = { marks: [], lastReadAt: 0n, waiters: [], now: 0n };
  let reading = false;
  let drawn = '';
  const paint = (next: ReviewModel): void => {
    model = next;
    const readOnly = deps.readOnly();
    btn.hidden = readOnly;
    if (readOnly && !pop.hidden) setOpen(false);
    const unread = unreadCount(model.marks, model.lastReadAt);
    badge.hidden = unread === 0;
    badge.textContent = unread > 99 ? '99+' : String(unread);
    btn.setAttribute('aria-label', unread === 0 ? 'Review' : `Review, ${unread} unread`);
    paintBanner(banner, model, deps);
    if (pop.hidden) return;
    // Opening (or a reply landing while open) marks replies read; one call until it settles.
    if (unread > 0 && !reading) {
      reading = true;
      void deps.markRead().catch(() => {}).finally(() => { reading = false; });
    }
    // Waiter heartbeats repaint often: keep the list (and the hovered row) unless it changed.
    const key = JSON.stringify([...model.marks.map(m => [m.id, statusOf(m, model.now), m.reply, m.claimedBy, deps.exists(m.nodeId)]), model.lastReadAt, rounds(model.marks).map(r => since(r.sentAt, model.now))], (_k, v: unknown) => (typeof v === 'bigint' ? String(v) : v));
    if (key === drawn) return;
    drawn = key;
    renderPop(pop, model, deps);
  };
  const setOpen = (open: boolean): void => {
    pop.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    drawn = '';
    if (open) paint(model);
    else deps.hoverNode(null);
  };
  btn.addEventListener('click', () => setOpen(pop.hidden));
  dismissible(pop, btn, () => setOpen(false));
  return paint;
}
