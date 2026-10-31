/**
 * One mapping from whatever went wrong to what the model reads (spec §3
 * Outcome mapping). A 530 body reaches the model only when it is one of the
 * module's own sentences (errors.gen.ts) and names no vendor; anything else
 * becomes UNAVAILABLE or UNCONFIRMED with a ref. The log gets the error name
 * (and the status of a database error) under that ref, never the error text,
 * and the model gets neither.
 */
import { DbError } from '../../shared/db-http';
import { DENYLIST, internalError, newRef, ruleViolation, unavailableRead, unavailableWrite, unconfirmed } from './copy';
import { SENDER_ERRORS } from './errors.gen';

export type Outcome = 'ok' | 'rejected' | 'unavailable' | 'unconfirmed' | 'limited' | 'ratelimited';

export type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

/** A refusal the Worker itself decided, with its exact text: never scrubbed further. */
export class Refusal extends Error {
  constructor(readonly text: string, readonly outcome: Outcome = 'rejected') {
    super(text);
    this.name = 'Refusal';
  }
}

/** The module's own refusal sentence, as the 530 body carries it. */
export const isModuleSentence = (body: string) =>
  body.length <= 2000 && !/[\r\n]/.test(body) && !DENYLIST.test(body) && SENDER_ERRORS.some(re => re.test(body));

/** What a log line says about an error: its name, and a database error's status, never its text: a message can carry database response text, and with it code (RC-690). */
export const errorKind = (err: unknown): string =>
  err instanceof DbError ? `${err.name} ${err.status}` : err instanceof Error ? err.name : 'NonError';

export type Scrubbed = { text: string; outcome: Outcome; ref?: string; original?: string; status?: number };

/** `write`: the call may have changed the board, so a lost answer is UNCONFIRMED. */
export function scrub(err: unknown, opts: { write: boolean; board?: string }): Scrubbed {
  if (err instanceof Refusal) return { text: err.text, outcome: err.outcome };
  const ref = newRef();
  const original = errorKind(err);
  if (err instanceof DbError) {
    if (err.status === 530) {
      return isModuleSentence(err.message)
        ? { text: ruleViolation(err.message, opts.board), outcome: 'rejected', status: 530 }
        : { text: internalError(ref), outcome: 'unavailable', ref, original, status: 530 };
    }
    // 4xx answers never commit (P0.1); a 5xx is the host's, before or instead of the reducer.
    return { text: opts.write ? unavailableWrite(ref) : unavailableRead(ref), outcome: 'unavailable', ref, original, status: err.status };
  }
  // No answer: a timeout or a dropped connection after the request left, so a write may have landed.
  if (isTransport(err)) {
    return opts.write ? { text: unconfirmed(ref), outcome: 'unconfirmed', ref, original } : { text: unavailableRead(ref), outcome: 'unavailable', ref, original };
  }
  return { text: internalError(ref), outcome: 'unavailable', ref, original };
}

export function isTransport(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === 'TimeoutError' || err.name === 'AbortError' || err.name === 'TypeError' || /network|fetch failed|timed? ?out/i.test(err.message);
}

export const okResult = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
export const errorResult = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });
