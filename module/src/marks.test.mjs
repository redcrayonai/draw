import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HEAD_START_MICROS,
  LEASE_MICROS,
  LISTENING_MICROS,
  MARK_NOTE_RULE,
  MARK_REPLY_RULE,
  MARK_SEND_RULE,
  SEAT_RE,
  claimable,
  replyRefusal,
  staleWaiter,
  waiterDue,
  WAITER_REFRESH_MICROS,
  validateReply,
  validateSend,
} from './marks.ts';

const row = (o = {}) => ({ status: 'sent', claimedBy: '', leaseUntil: 0n, preferredAgent: '', sentAt: 1000n, ...o });

test('timings', () => {
  assert.equal(LEASE_MICROS, 15n * 60n * 1_000_000n);
  assert.equal(HEAD_START_MICROS, 20n * 1_000_000n);
  assert.equal(LISTENING_MICROS, 60n * 1_000_000n);
  assert.ok(SEAT_RE.test('abcDEF0123456789'));
  assert.ok(!SEAT_RE.test('abcDEF012345678'));
  assert.ok(!SEAT_RE.test('abcDEF0123456789x'));
});

test('claimable: preferred agent gets a head start', () => {
  assert.equal(claimable(row({ preferredAgent: 'me' }), 1000n, 'me'), true);
  const other = row({ preferredAgent: 'other' });
  assert.equal(claimable(other, 1000n + HEAD_START_MICROS - 1n, 'me'), false);
  assert.equal(claimable(other, 1000n + HEAD_START_MICROS, 'me'), true);
  assert.equal(claimable(row(), 1000n, 'me'), true);
});

test('claimable: lease expires lazily, answered marks are closed', () => {
  assert.equal(claimable(row({ status: 'claimed', claimedBy: 'a', leaseUntil: 2000n }), 1999n, 'me'), false);
  assert.equal(claimable(row({ status: 'claimed', claimedBy: 'a', leaseUntil: 2000n }), 2000n, 'me'), true);
  for (const status of ['fixed', 'kept']) assert.equal(claimable(row({ status }), 1n << 60n, 'me'), false, status);
});

test('validateSend', () => {
  validateSend([1n], ['']);
  validateSend([1n, 2n], ['a', 'b']);
  validateSend([1n], ['x'.repeat(500)]);
  validateSend(Array.from({ length: 20 }, (_, i) => BigInt(i)), Array(20).fill(''));
  assert.throws(() => validateSend([], []), { message: MARK_SEND_RULE });
  assert.throws(() => validateSend(Array.from({ length: 21 }, (_, i) => BigInt(i)), Array(21).fill('')), { message: MARK_SEND_RULE });
  assert.throws(() => validateSend([1n, 1n], ['', '']), { message: MARK_SEND_RULE });
  assert.throws(() => validateSend([1n, 2n], ['']), { message: MARK_SEND_RULE });
  assert.throws(() => validateSend([1n], ['x'.repeat(501)]), { message: MARK_NOTE_RULE });
});

test('validateReply', () => {
  validateReply('fixed', 'done it', ['a.ts']);
  validateReply('kept', 'x'.repeat(400), []);
  validateReply('kept', 'ok', Array(20).fill('f'.repeat(300)));
  assert.throws(() => validateReply('done', 'ok', []), { message: MARK_REPLY_RULE });
  assert.throws(() => validateReply('fixed', '', []), { message: MARK_REPLY_RULE });
  assert.throws(() => validateReply('fixed', 'x'.repeat(401), []), { message: MARK_REPLY_RULE });
  assert.throws(() => validateReply('fixed', 'ok', Array(21).fill('f')), { message: MARK_REPLY_RULE });
  assert.throws(() => validateReply('fixed', 'ok', ['f'.repeat(301)]), { message: MARK_REPLY_RULE });
});

test('staleWaiter: a waiter goes stale only after LISTENING_MICROS', () => {
  assert.equal(staleWaiter(1000n, 1000n + LISTENING_MICROS), false);
  assert.equal(staleWaiter(1000n, 1000n + LISTENING_MICROS + 1n), true);
});

test('waiterDue: write when there is no row or it is older than WAITER_REFRESH_MICROS', () => {
  assert.equal(WAITER_REFRESH_MICROS, 20n * 1_000_000n);
  assert.ok(WAITER_REFRESH_MICROS < LISTENING_MICROS);
  assert.equal(waiterDue(undefined, 5n), true);
  assert.equal(waiterDue(1000n, 1000n + WAITER_REFRESH_MICROS), false);
  assert.equal(waiterDue(1000n, 1000n + WAITER_REFRESH_MICROS + 1n), true);
});

test('replyRefusal: seat-mismatch only for the same claim; every other loss is reclaimed', () => {
  const A = 'ab/seatA';
  const B = 'ab/seatB';
  const m = (o = {}) => ({ status: 'claimed', claimedBy: A, claimGen: 2, ...o });
  assert.equal(replyRefusal(m(), A, 'ab', 2), null);
  // seat A is behind: it reclaimed or lost the mark since gen 1
  assert.equal(replyRefusal(m(), A, 'ab', 1), 'reclaimed');
  // seat B of the same agent, same claim: retry with seat A
  assert.equal(replyRefusal(m(), B, 'ab', 2), 'seat');
  // seat B holds an older gen: seat A reclaimed it
  assert.equal(replyRefusal(m(), B, 'ab', 1), 'reclaimed');
  // another agent holds it
  assert.equal(replyRefusal(m({ claimedBy: 'cd/seatA' }), A, 'ab', 2), 'reclaimed');
  assert.equal(replyRefusal(m({ status: 'fixed' }), A, 'ab', 2), 'reclaimed');
  assert.equal(replyRefusal(m({ status: 'sent', claimedBy: '' }), A, 'ab', 2), 'reclaimed');
});
