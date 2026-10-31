import { describe, expect, it } from 'vitest';
import { IDLE, IDLE_MS, MARKS_EXPIRED, MARKS_USAGE, NOBODY_MS, runMarks } from './marks';

const ORIGIN = 'https://mcp.redcrayon.test';
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Answers in order, or from a function of the fake clock (an Error is thrown as a network failure); records each request and each backoff.
 *  Each request takes 25 s of the fake clock, like the server's wait; each backoff its own length. */
function harness(answers: (Response | Error)[] | ((now: number) => Response | Error), stop = new AbortController()) {
  const requests: { url: string; auth: string }[] = [];
  const sleeps: number[] = [];
  const clock = { now: 0 };
  const io = {
    out: [] as string[],
    err: [] as string[],
    signal: stop.signal,
    fetch: (async (url: string, init?: RequestInit) => {
      requests.push({ url, auth: (init?.headers as Record<string, string>).authorization });
      clock.now += 25_000;
      const next = typeof answers === 'function' ? answers(clock.now) : answers.shift();
      if (!next) throw new Error('no more answers');
      if (next instanceof Error) throw next;
      return next;
    }) as typeof fetch,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      clock.now += ms;
    },
    now: () => clock.now,
  };
  return { io, requests, sleeps, clock };
}

describe('redcrayon marks', () => {
  it('asks again after an empty wait, then prints the claimed marks and exits 0', async () => {
    const h = harness([
      json(200, { board: '5', claimed: 0 }),
      json(200, { board: '5', claimed: 2, marks: [{ mark: '7', label: 'db', note: 'index this' }, { mark: '9', label: 'api\nx', note: '' }] }),
    ]);
    expect(await runMarks(['--token', 'tok'], ORIGIN, h.io)).toBe(0);
    expect(h.requests).toEqual([
      { url: `${ORIGIN}/marks/wait`, auth: 'Bearer tok' },
      { url: `${ORIGIN}/marks/wait`, auth: 'Bearer tok' },
    ]);
    expect(h.sleeps).toEqual([]);
    expect(h.io.out).toEqual([
      '2 mark(s) claimed on board 5:',
      '- db: index this',
      '- api x: (no note)',
      'Call wait_for_marks with your seat, answer each with reply_to_mark, then run this command again.',
    ]);
    expect(h.io.err).toEqual([]);
  });

  it('stops 10 minutes after the last person closed the board, counting from the start before anyone opened it', async () => {
    // nobody for 9 minutes, a person until minute 15, then nobody
    const h = harness(now => json(200, { board: '5', claimed: 0, people: now > 9 * 60_000 && now <= 15 * 60_000 ? 1 : 0 }));
    expect(await runMarks(['--token', 'tok'], ORIGIN, h.io)).toBe(0);
    expect(h.io.out).toEqual([
      'stopped: nobody has board 5 open',
      'Nobody has board 5 open; stopped watching. Ask the person to open the board and say "review my marks" to resume.',
    ]);
    expect(h.clock.now).toBeGreaterThan(15 * 60_000 + NOBODY_MS);
    expect(h.clock.now).toBeLessThanOrEqual(15 * 60_000 + NOBODY_MS + 25_000);
  });

  it('nobody yet for under 10 minutes: keeps waiting and still prints the marks', async () => {
    const h = harness(now => json(200, now < NOBODY_MS ? { board: '5', claimed: 0, people: 0 } : { board: '5', claimed: 1, people: 0, marks: [{ label: 'db', note: 'x' }] }));
    expect(await runMarks(['--token', 'tok'], ORIGIN, h.io)).toBe(0);
    expect(h.io.out[0]).toBe('1 mark(s) claimed on board 5:');
  });

  it('idle after 100 minutes without marks while someone has the board open, before a 2-hour task limit', async () => {
    const h = harness(() => json(200, { board: '5', claimed: 0, people: 1 }));
    expect(await runMarks(['--token', 'tok'], ORIGIN, h.io)).toBe(0);
    expect(h.io.out).toEqual([IDLE]);
    expect(h.clock.now).toBeGreaterThan(IDLE_MS);
    expect(h.clock.now).toBeLessThanOrEqual(IDLE_MS + 25_000);
  });

  it('an older server without people never stops the watch; idle still ends it', async () => {
    const h = harness(() => json(200, { board: '5', claimed: 0 }));
    expect(await runMarks(['--token', 'tok'], ORIGIN, h.io)).toBe(0);
    expect(h.io.out).toEqual([IDLE]);
  });

  it('idle also ends a watch that cannot reach the server', async () => {
    const h = harness(() => new TypeError('fetch failed'));
    expect(await runMarks(['--token', 'tok'], ORIGIN, h.io)).toBe(0);
    expect(h.io.out).toEqual([IDLE]);
    expect(h.clock.now).toBeLessThanOrEqual(IDLE_MS + 25_000 + 30_000);
  });

  it('401: the token expired, exit 1', async () => {
    const h = harness([json(401, { error: 'invalid_token' })]);
    expect(await runMarks(['--token', 'tok'], ORIGIN, h.io)).toBe(1);
    expect(h.io.err).toEqual([MARKS_EXPIRED]);
  });

  it("403: the server's sentence, exit 1", async () => {
    const h = harness([json(403, { error: 'forbidden', error_description: 'REJECTED: not authorized: board is read only' })]);
    expect(await runMarks(['--token', 'tok'], ORIGIN, h.io)).toBe(1);
    expect(h.io.err).toEqual(['redcrayon: REJECTED: not authorized: board is read only']);
  });

  it('backs off 2 s doubling to 30 s on network errors, 5xx and garbled answers, and resets after an answer', async () => {
    const down = new TypeError('fetch failed');
    const h = harness([down, json(500, {}), down, down, new Response('<html>'), down, json(200, { claimed: 0 }), down, json(401, {})]);
    expect(await runMarks(['--token', 'tok'], ORIGIN, h.io)).toBe(1);
    expect(h.sleeps).toEqual([2000, 4000, 8000, 16000, 30000, 30000, 2000]);
  });

  it('SIGINT or SIGTERM: exits 0 quietly, even mid-request', async () => {
    const stop = new AbortController();
    const h = harness([], stop);
    h.io.fetch = (async () => {
      stop.abort();
      throw new DOMException('aborted', 'AbortError');
    }) as typeof fetch;
    expect(await runMarks(['--token', 'tok'], ORIGIN, h.io)).toBe(0);
    expect(h.io.out).toEqual([]);
    expect(h.io.err).toEqual([]);
  });

  it('refuses anything but --token <t>', async () => {
    const h = harness([]);
    for (const argv of [[], ['--token'], ['--token', ''], ['--board', '5'], ['--token', 't', 'x']]) {
      await expect(runMarks(argv, ORIGIN, h.io)).rejects.toThrow(MARKS_USAGE);
    }
  });
});
