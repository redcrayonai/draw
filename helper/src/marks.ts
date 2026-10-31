/**
 * redcrayon marks: wait in the background for red crayon marks (spec
 * 2026-10-19 D18). Asks the server's /marks/wait, which claims marks for the
 * watch_marks token's seat, until it claims some; then prints them and exits,
 * so the agent's harness wakes the agent. It also exits once nobody has had the
 * board open for 10 minutes (`stopped:`), and after 100 minutes without marks
 * (`idle:`), before an agent harness's 2-hour limit on background tasks.
 */
import { setTimeout as sleepFor } from 'node:timers/promises';
import { HelperError } from './capture';

export const MARKS_USAGE = 'redcrayon: usage: redcrayon marks --token <token from watch_marks>';
export const MARKS_EXPIRED = 'redcrayon: this marks token expired or is invalid; call watch_marks again.';
// The server answers within ~35 s (a 25 s wait plus one slow database request).
const REQUEST_MS = 60_000;
const FIRST_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 30_000;
/** Nobody has had the board open this long: stop, the agent does not restart. */
export const NOBODY_MS = 10 * 60_000;
/** No marks this long: exit so the agent restarts the command, under a harness's 2-hour limit. */
export const IDLE_MS = 100 * 60_000;
export const IDLE = 'idle: no marks in 100 minutes; run this command again to keep listening.';

export interface MarksIo {
  out: string[];
  err: string[];
  /** aborted on SIGINT or SIGTERM: stop quietly, exit 0 */
  signal: AbortSignal;
  fetch?: typeof fetch;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
}

type Claimed = { board?: unknown; claimed?: unknown; people?: unknown; marks?: { label?: unknown; note?: unknown }[] };

// Labels and notes are people's free text: one line each, no control characters.
const oneLine = (v: unknown) => String(v ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').trim();

export async function runMarks(argv: string[], origin: string, io: MarksIo): Promise<number> {
  if (argv.length !== 2 || argv[0] !== '--token' || !argv[1]) throw new HelperError(MARKS_USAGE);
  const token = argv[1];
  const get = io.fetch ?? fetch;
  const sleep = io.sleep ?? ((ms, signal) => sleepFor(ms, undefined, { signal }).catch(() => {}));
  const now = io.now ?? Date.now;
  const started = now();
  // From the start, so the agent can run this before the person opens the link.
  let lastSeen = started;
  let backoff = 0;
  while (!io.signal.aborted) {
    if (now() - started > IDLE_MS) {
      io.out.push(IDLE);
      return 0;
    }
    let res: Response | undefined;
    let body: Claimed | undefined;
    try {
      res = await get(`${origin}/marks/wait`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.any([io.signal, AbortSignal.timeout(REQUEST_MS)]) });
      body = (await res.json()) as Claimed;
    } catch {
      body = undefined;
    }
    if (io.signal.aborted) return 0;
    if (res?.status === 401) {
      io.err.push(MARKS_EXPIRED);
      return 1;
    }
    if (res?.status === 403) {
      const text = (body as { error_description?: unknown } | undefined)?.error_description;
      io.err.push(`redcrayon: ${oneLine(text) || 'you cannot take marks on this board any more.'}`);
      return 1;
    }
    if (res?.ok && body && typeof body.claimed === 'number') {
      backoff = 0;
      if (body.claimed > 0) {
        io.out.push(`${body.claimed} mark(s) claimed on board ${oneLine(body.board)}:`);
        for (const m of body.marks ?? []) io.out.push(`- ${oneLine(m.label)}: ${oneLine(m.note) || '(no note)'}`);
        io.out.push('Call wait_for_marks with your seat, answer each with reply_to_mark, then run this command again.');
        return 0;
      }
      // A server without `people` is older: it never stops the watch.
      if (typeof body.people !== 'number' || body.people > 0) lastSeen = now();
      else if (now() - lastSeen > NOBODY_MS) {
        const board = oneLine(body.board);
        io.out.push(`stopped: nobody has board ${board} open`);
        io.out.push(`Nobody has board ${board} open; stopped watching. Ask the person to open the board and say "review my marks" to resume.`);
        return 0;
      }
      continue; // the server already waited ~25 s
    }
    // Offline, a 5xx, a rate limit or a garbled answer: wait longer each time, never spin.
    backoff = backoff ? Math.min(backoff * 2, MAX_BACKOFF_MS) : FIRST_BACKOFF_MS;
    await sleep(backoff, io.signal);
  }
  return 0;
}
