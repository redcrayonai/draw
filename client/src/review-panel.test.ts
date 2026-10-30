import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

import { LISTENING_MICROS } from '../../module/src/marks';

type Review = typeof import('./review-panel');
let review: Review;

const A = 'aa'.repeat(16);
const B = 'bb'.repeat(16);
const S = 60_000_000n; // a minute in micros

beforeAll(async () => {
  // chrome.ts (imported for dismissible) dereferences these in its module body.
  document.body.innerHTML = `
    <div id="error-strip" hidden><span id="error-text"></span><button id="error-dismiss"></button></div>
    <button id="participants-label"><span id="participant-chips"></span></button>
    <div id="presence-pop" hidden></div>
    <aside id="inspector" hidden tabindex="0"></aside>`;
  review = await import('./review-panel');
});

type Row = import('./review-panel').MarkRow;
const ts = (micros: bigint) => ({ microsSinceUnixEpoch: micros });
const mark = (o: Partial<Row> = {}): Row => ({
  id: 1n, nodeId: 10n, nodeLabel: 'api', note: 'auth is tangled into the router', round: 1, claimedBy: '', status: 'sent',
  reply: '', files: '[]', sentAt: ts(100n), answeredAt: ts(0n), leaseUntil: ts(1n << 62n), ...o,
});

describe('unreadCount', () => {
  it('counts fixed and kept replies answered after the read cursor; equal is read', () => {
    const marks = [
      mark({ id: 1n, status: 'fixed', answeredAt: ts(50n) }),
      mark({ id: 2n, status: 'kept', answeredAt: ts(51n) }),
      mark({ id: 3n, status: 'claimed', answeredAt: ts(99n) }),
      mark({ id: 4n, status: 'sent' }),
    ];
    expect(review.unreadCount(marks, 49n)).toBe(2);
    expect(review.unreadCount(marks, 50n)).toBe(1);
    expect(review.unreadCount(marks, 51n)).toBe(0);
  });
});

describe('rounds', () => {
  it('groups newest round first, marks by id', () => {
    const r = review.rounds([
      mark({ id: 5n, round: 1, sentAt: ts(10n) }),
      mark({ id: 9n, round: 2, sentAt: ts(20n) }),
      mark({ id: 7n, round: 2, sentAt: ts(20n) }),
      mark({ id: 3n, round: 1, sentAt: ts(10n) }),
    ]);
    expect(r.map(x => x.round)).toEqual([2, 1]);
    expect(r[0].sentAt).toBe(20n);
    expect(r[0].marks.map(m => m.id)).toEqual([7n, 9n]);
    expect(r[1].marks.map(m => m.id)).toEqual([3n, 5n]);
    expect(review.rounds([])).toEqual([]);
  });
});

describe('bannerState', () => {
  const now = 10n * S;
  const live = [{ lastWaitAt: now - S + 1n }];
  const stale = [{ lastWaitAt: now - S }]; // exactly 60 s ago is stale

  it('no rounds: waiting with a live waiter, otherwise none', () => {
    expect(LISTENING_MICROS).toBe(S);
    expect(review.bannerState([], live, now)).toEqual({ kind: 'waiting', done: 0, total: 0 });
    expect(review.bannerState([], stale, now).kind).toBe('none');
    expect(review.bannerState([], [], now).kind).toBe('none');
  });

  it('latest round: unclaimed with nobody listening, working, answered', () => {
    const old = mark({ id: 1n, round: 1, status: 'fixed' });
    const sent = mark({ id: 2n, round: 2, status: 'sent' });
    const claimed = mark({ id: 3n, round: 2, status: 'claimed' });
    const kept = mark({ id: 4n, round: 2, status: 'kept' });
    expect(review.bannerState([old, sent, kept], stale, now)).toEqual({ kind: 'not-listening', done: 1, total: 2 });
    expect(review.bannerState([old, sent, kept], live, now)).toEqual({ kind: 'working', done: 1, total: 2 });
    expect(review.bannerState([old, claimed, kept], [], now)).toEqual({ kind: 'working', done: 1, total: 2 });
  });

  it('a claim whose lease ran out counts as sent again', () => {
    const lapsed = mark({ id: 3n, round: 2, status: 'claimed', leaseUntil: ts(now) }); // exactly now has lapsed
    const kept = mark({ id: 4n, round: 2, status: 'kept' });
    expect(review.bannerState([lapsed, kept], stale, now)).toEqual({ kind: 'not-listening', done: 1, total: 2 });
    expect(review.bannerState([mark({ ...lapsed, leaseUntil: ts(now + 1n) }), kept], stale, now).kind).toBe('working');
  });

  it('latest round all answered: waiting while an agent listens, answered for 10 min, then hidden', () => {
    expect(review.ANSWERED_SHOW_MICROS).toBe(10n * S);
    const old = mark({ id: 1n, round: 1, status: 'sent' });
    const fixed = mark({ id: 2n, round: 2, status: 'fixed', answeredAt: ts(now - 20n * S) });
    const kept = (ago: bigint) => mark({ id: 3n, round: 2, status: 'kept', answeredAt: ts(now - ago) });
    expect(review.bannerState([old, fixed, kept(S)], live, now)).toEqual({ kind: 'waiting', done: 2, total: 2 });
    expect(review.bannerState([old, fixed, kept(10n * S - 1n)], [], now)).toEqual({ kind: 'answered', done: 2, total: 2 });
    expect(review.bannerState([old, fixed, kept(10n * S)], stale, now)).toEqual({ kind: 'none', done: 2, total: 2 }); // exactly 10 min is hidden
    expect(review.bannerState([old, fixed, kept(60n * S)], [], now).kind).toBe('none');
  });
});

describe('review popover, badge and banner', () => {
  const DOM = `
    <button id="act-review" aria-expanded="false" aria-controls="review-pop">R<span id="review-badge" hidden></span></button>
    <div id="review-pop" hidden></div>
    <div id="mark-banner" hidden></div>
    <button id="elsewhere">x</button>`;
  const $ = (id: string) => document.getElementById(id)!;
  const now = 100n * S;

  function setup(over: Partial<import('./review-panel').ReviewDeps> = {}) {
    document.body.insertAdjacentHTML('beforeend', DOM);
    const deps = {
      markRead: vi.fn(async () => {}),
      agentName: (hex: string) => (hex === A ? 'Claude (A)' : hex === B ? 'Claude (B)' : 'an agent'),
      exists: (id: bigint) => id !== 99n,
      hoverNode: vi.fn(),
      panTo: vi.fn(),
      readOnly: () => false,
      ...over,
    };
    return { deps, paint: review.setupReview(deps) };
  }

  beforeEach(() => {
    for (const id of ['act-review', 'review-pop', 'mark-banner', 'elsewhere']) document.getElementById(id)?.remove();
  });

  const answered = [
    mark({ id: 1n, round: 2, nodeLabel: 'api', status: 'fixed', claimedBy: `${A}/seat1`, reply: 'Split auth into its own middleware.', files: '["api/auth.ts","api/router.ts"]', sentAt: ts(now - 9n), answeredAt: ts(now - 5n) }),
    mark({ id: 2n, round: 2, nodeId: 11n, nodeLabel: 'web', status: 'kept', claimedBy: `${B}/seat2`, reply: 'SSR reads it.', sentAt: ts(now - 9n), answeredAt: ts(now - 4n) }),
    mark({ id: 3n, round: 1, nodeId: 99n, nodeLabel: 'gone-svc', status: 'claimed', claimedBy: `${A}/seat1`, sentAt: ts(now - 14n * S) }),
  ];

  it('rows show label, note, reply, files and status; claimed names its agent', () => {
    const { paint } = setup();
    paint({ marks: answered, lastReadAt: 0n, waiters: [], now });
    $('act-review').click();
    const rows = [...$('review-pop').querySelectorAll<HTMLElement>('.mark-row')];
    expect(rows).toHaveLength(3);
    expect(rows[0].classList.contains('fixed')).toBe(true);
    expect(rows[0].querySelector('.mr-label')!.textContent).toBe('api');
    expect(rows[0].querySelector('.mr-note')!.textContent).toBe('auth is tangled into the router');
    expect(rows[0].querySelector('.mr-who')!.textContent).toBe('Claude (A)');
    expect(rows[0].querySelector('.mr-reply')!.textContent).toBe('Split auth into its own middleware.');
    expect(rows[0].querySelector('.mr-files')!.textContent).toBe('api/auth.ts · api/router.ts');
    expect(rows[1].classList.contains('kept')).toBe(true);
    expect(rows[1].querySelector('.mr-files')).toBeNull();
    expect(rows[2].classList.contains('claimed')).toBe(true);
    expect(rows[2].querySelector('.mr-reply')!.textContent).toBe('claimed by Claude (A)');
    expect([...$('review-pop').querySelectorAll('.mr-round')].map(r => r.textContent)).toEqual(['Round 2 · just now', 'Round 1 · 14 min ago']);
  });

  it('a lapsed claim reads as sent, with no claimed-by line', () => {
    const { paint } = setup();
    paint({ marks: [mark({ status: 'claimed', claimedBy: `${A}/seat1`, leaseUntil: ts(now - 1n) })], lastReadAt: 0n, waiters: [], now });
    $('act-review').click();
    const row = $('review-pop').querySelector<HTMLElement>('.mark-row')!;
    expect(row.classList.contains('sent')).toBe(true);
    expect(row.classList.contains('claimed')).toBe(false);
    expect(row.querySelector('.mr-tag')!.textContent).toBe('sent');
    expect(row.querySelector('.mr-reply')).toBeNull();
  });

  it('a read-only board hides the Review button and closes its popover', () => {
    let readOnly = false;
    const { paint } = setup({ readOnly: () => readOnly });
    paint({ marks: answered, lastReadAt: 0n, waiters: [], now });
    expect($('act-review').hidden).toBe(false);
    $('act-review').click();
    expect($('review-pop').hidden).toBe(false);
    readOnly = true;
    paint({ marks: answered, lastReadAt: 0n, waiters: [], now });
    expect($('act-review').hidden).toBe(true);
    expect($('review-pop').hidden).toBe(true);
  });

  it('hover lights the node, click pans to it; a removed node renders without pan', () => {
    const { deps, paint } = setup();
    paint({ marks: answered, lastReadAt: 0n, waiters: [], now });
    $('act-review').click();
    const rows = [...$('review-pop').querySelectorAll<HTMLElement>('.mark-row')];
    rows[0].dispatchEvent(new Event('pointerenter'));
    expect(deps.hoverNode).toHaveBeenLastCalledWith(10n);
    rows[0].dispatchEvent(new Event('pointerleave'));
    expect(deps.hoverNode).toHaveBeenLastCalledWith(null);
    rows[1].click();
    expect(deps.panTo).toHaveBeenCalledWith(11n);
    expect(rows[2].classList.contains('gone')).toBe(true);
    expect(() => rows[2].click()).not.toThrow();
    rows[2].dispatchEvent(new Event('pointerenter'));
    expect(deps.panTo).toHaveBeenCalledTimes(1);
    expect(deps.hoverNode).not.toHaveBeenCalledWith(99n);
  });

  it('opening marks replies read once; the badge counts unread and hides at 0', () => {
    const { deps, paint } = setup();
    paint({ marks: answered, lastReadAt: 0n, waiters: [], now });
    expect($('review-badge').hidden).toBe(false);
    expect($('review-badge').textContent).toBe('2');
    expect(deps.markRead).not.toHaveBeenCalled();
    $('act-review').click();
    expect($('review-pop').hidden).toBe(false);
    expect($('act-review').getAttribute('aria-expanded')).toBe('true');
    paint({ marks: answered, lastReadAt: 0n, waiters: [], now }); // a table change before the cursor lands
    expect(deps.markRead).toHaveBeenCalledTimes(1);
    paint({ marks: answered, lastReadAt: now, waiters: [], now });
    expect($('review-badge').hidden).toBe(true);
    $('elsewhere').dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect($('review-pop').hidden).toBe(true);
    expect(deps.hoverNode).toHaveBeenLastCalledWith(null);
  });

  it('banner copy per state, hidden for none', () => {
    const { paint } = setup();
    const banner = $('mark-banner');
    paint({ marks: [], lastReadAt: 0n, waiters: [], now });
    expect(banner.hidden).toBe(true);
    paint({ marks: [], lastReadAt: 0n, waiters: [{ owner: `${A}/s`, lastWaitAt: now }], now });
    expect(banner.hidden).toBe(false);
    expect(banner.textContent).toBe('Claude (A) is waiting for your marks');
    paint({ marks: [], lastReadAt: 0n, waiters: [{ owner: `${A}/s`, lastWaitAt: now }, { owner: `${B}/s`, lastWaitAt: now }, { owner: `${B}/t`, lastWaitAt: now }], now });
    expect(banner.textContent).toBe('Claude (A) and 2 more are waiting for your marks');
    paint({ marks: [mark({ status: 'sent' })], lastReadAt: 0n, waiters: [], now });
    expect(banner.textContent).toBe('No agent listening');
    paint({ marks: [mark({ status: 'claimed' }), mark({ id: 2n, status: 'sent' }), mark({ id: 3n, status: 'fixed' })], lastReadAt: 0n, waiters: [{ owner: `${A}/s`, lastWaitAt: now }], now });
    expect(banner.textContent).toBe('Working on 2 marks');
    paint({ marks: [mark({ status: 'claimed' })], lastReadAt: 0n, waiters: [], now });
    expect(banner.textContent).toBe('Working on 1 mark');
    paint({ marks: [mark({ status: 'fixed', answeredAt: ts(now - S) }), mark({ id: 2n, status: 'kept', answeredAt: ts(now - S) })], lastReadAt: 0n, waiters: [], now });
    expect(banner.textContent).toBe('2 of 2 answered');
    expect(banner.dataset.state).toBe('answered');
    paint({ marks: [mark({ status: 'fixed', answeredAt: ts(now - 11n * S) })], lastReadAt: 0n, waiters: [], now });
    expect(banner.hidden).toBe(true);
    paint({ marks: [mark({ status: 'fixed', answeredAt: ts(now - 11n * S) })], lastReadAt: 0n, waiters: [{ owner: `${B}/s`, lastWaitAt: now }], now });
    expect(banner.textContent).toBe('Claude (B) is waiting for your marks');
  });

  it('a heartbeat that changes nothing keeps the banner\'s nodes, so screen readers stay quiet', () => {
    const { paint } = setup();
    const banner = $('mark-banner');
    const waiting = (at: bigint) => paint({ marks: [], lastReadAt: 0n, waiters: [{ owner: `${A}/s`, lastWaitAt: at }], now });
    waiting(now - 2n);
    const first = banner.firstChild;
    const replace = vi.spyOn(banner, 'replaceChildren');
    waiting(now);
    expect(replace).not.toHaveBeenCalled();
    expect(banner.firstChild).toBe(first);
    paint({ marks: [mark({ status: 'sent' })], lastReadAt: 0n, waiters: [], now });
    expect(replace).toHaveBeenCalledTimes(1);
    expect(banner.textContent).toBe('No agent listening');
  });
});
