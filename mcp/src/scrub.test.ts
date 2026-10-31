import { describe, expect, it } from 'vitest';
import { DbError } from '../../shared/db-http';
import { DENYLIST, TEXT_DENYLIST } from './copy';
import { Refusal, isModuleSentence, scrub } from './scrub';

const VENDOR = /spacetime|maincloud|bsatn|clockwork|\bstdb\b/i;

describe('scrub (spec §3 Outcome mapping)', () => {
  it('passes a module sentence through verbatim, with the board', () => {
    const s = scrub(new DbError(530, 'grid rule: x = 3 is not divisible by 4; all coordinates and dimensions must sit on the 4px grid'), { write: true, board: 'main' });
    expect(s).toMatchObject({ text: 'REJECTED: grid rule: x = 3 is not divisible by 4; all coordinates and dimensions must sit on the 4px grid board=main', outcome: 'rejected' });
  });

  it.each([
    ['402 energy', new DbError(402, 'the database answered 402 to call/x: out of energy on maincloud'), true, 'UNAVAILABLE: redcrayon is unavailable. Nothing was written.'],
    ['400 with host text', new DbError(400, 'the database answered 400 to sql: spacetimedb parse error'), false, 'UNAVAILABLE: redcrayon is unavailable. Call again'],
    ['404 unknown database', new DbError(404, 'the database answered 404 to call/x: no such database'), true, 'UNAVAILABLE: redcrayon is unavailable. Nothing was written.'],
    ['503', new DbError(503, 'the database answered 503 to call/x: busy'), true, 'UNAVAILABLE: redcrayon is unavailable. Nothing was written.'],
    ['530 panic', new DbError(530, 'The module panicked: index out of bounds at wasm'), true, 'UNAVAILABLE: redcrayon hit an internal error.'],
    ['network error naming the host', new TypeError('fetch failed: getaddrinfo maincloud.spacetimedb.com'), true, 'UNCONFIRMED: redcrayon did not confirm the write within 15 s.'],
    ['timeout on a read', Object.assign(new Error('signal timed out'), { name: 'TimeoutError' }), false, 'UNAVAILABLE: redcrayon is unavailable. Call again'],
    ['JSON parse failure', new SyntaxError('Unexpected token < in JSON at position 0'), true, 'UNAVAILABLE: redcrayon hit an internal error.'],
  ])('%s never reaches the model', (_name, err, write, start) => {
    const s = scrub(err, { write, board: 'main' });
    expect(s.text.startsWith(start)).toBe(true);
    expect(s.text).not.toMatch(VENDOR);
    expect(s.text).not.toMatch(TEXT_DENYLIST);
    expect(s.text).toMatch(/\(ref [0-9a-f]{6}\)|ref [0-9a-f]{6}\./);
    expect(s.original).toBeDefined(); // the log gets the error name (and status) under the ref, never the text
  });

  it('logs the error name and the status, never the message (RC-690)', () => {
    const code = 'const secret = 1';
    expect(scrub(new TypeError(`unexpected token near ${code}`), { write: true }).original).toBe('TypeError');
    expect(scrub(new SyntaxError(`bad json: ${code}`), { write: false }).original).toBe('SyntaxError');
    expect(scrub(new DbError(500, `the database answered 500 to sql: ${code}`), { write: false }).original).toBe('Error 500');
    expect(scrub(new DbError(530, `The module panicked at ${code}`), { write: true }).original).toBe('Error 530');
    expect(scrub(`thrown text ${code}`, { write: true }).original).not.toContain(code);
  });

  it('keeps a refusal the Worker decided as it is', () => {
    expect(scrub(new Refusal('REJECTED: board 42 not found. Nothing was written.'), { write: true }).text).toBe('REJECTED: board 42 not found. Nothing was written.');
  });

  it('a 530 that matches no template, or names the vendor, is not a module sentence', () => {
    expect(isModuleSentence('evidence rule: source path ' + "'nope' does not exist in the repo imported for board 1")).toBe(true);
    expect(isModuleSentence('something the module never says')).toBe(false);
    expect(isModuleSentence("evidence rule: source path 'spacetime' does not exist in the repo imported for board 1")).toBe(false);
  });

  it('the encoded denylist is the spec list', () => {
    expect(DENYLIST.source).toBe('spacetime|stdb|maincloud|clockwork|bsatn|panic|wasm|energy');
    expect(DENYLIST.flags).toBe('i');
  });
});
