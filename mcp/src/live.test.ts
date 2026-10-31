import { describe, expect, it } from 'vitest';
import { mint, mintMarks, mintTap, verifyMarks, verifyTap } from './issuer';
import { ACCESS_TTL_MS, AUTH_MS, CLOSE, LiveHub, TAP_EXPIRED, TAP_STOPPED, MAX_EDGES, MAX_MESSAGE_BYTES, MAX_STRIKES, MIN_INTERVAL_MS, REAUTH_MS, type Attachment, type LiveSocket } from './live';
import { newJwk, testEnv } from './test/env';

class FakeSocket implements LiveSocket {
  sent: unknown[] = [];
  closedWith: [number, string] | null = null;
  constructor(private a: Attachment | null) {}
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code: number, reason: string) {
    this.closedWith = [code, reason];
  }
  attachment() {
    return this.a;
  }
  setAttachment(a: Attachment) {
    this.a = a;
  }
}

// Tap tokens the fake verifier knows: iat and exp in seconds, as in a JWT.
const TAPS: Record<string, { board: bigint; iat: number; exp: number }> = {
  'tap-5': { board: 5n, iat: 1, exp: 12 * 3600 },
  'tap-6': { board: 6n, iat: 1, exp: 12 * 3600 },
  'tap-5-short': { board: 5n, iat: 1, exp: 60 },
  'tap-5-later': { board: 5n, iat: 100, exp: 12 * 3600 },
};

function hub(opts: { readers?: string[]; now?: () => number } = {}) {
  const sockets: FakeSocket[] = [];
  const readers = opts.readers ?? ['viewer'];
  let clock = 0;
  let revoked = 0;
  const now = opts.now ?? (() => clock);
  const h = new LiveHub(
    {
      verifyTap: async t => (TAPS[t] ? { ...TAPS[t], sub: 'agent:user_ada' } : null),
      canRead: async t => readers.includes(t),
      revokedBefore: async () => revoked,
      revoke: async at => void (revoked = at),
      now,
    },
    () => sockets.filter(s => s.closedWith === null)
  );
  const open = () => {
    const s = new FakeSocket({ role: 'pending', board: '5', at: now() });
    sockets.push(s);
    return s;
  };
  return { h, open, readers, tick: (ms: number) => (clock += ms) };
}

const summary = (edges = [{ from: '1', to: '2', count: 3, errors: 0, p50: 4, p95: 9, max: 9 }]) => JSON.stringify({ t: 1, window_ms: 1000, edges, unmapped: 0 });

describe('LiveHub', () => {
  // A DO delivers frames while canRead's fetch is in flight: without a guard each would start its own DB query.
  it('checks one auth frame per socket at a time, dropping frames sent while it is checked', async () => {
    let release!: (ok: boolean) => void;
    const held = new Promise<boolean>(r => (release = r));
    const reads: string[] = [];
    const sockets: FakeSocket[] = [];
    const h = new LiveHub({ verifyTap: async () => null, canRead: t => (reads.push(t), held), revokedBefore: async () => 0, revoke: async () => {}, now: () => 0 }, () => sockets);
    const v = new FakeSocket({ role: 'pending', board: '5', at: 0 });
    sockets.push(v);
    const frames = [h.message(v, JSON.stringify({ auth: 'viewer', role: 'viewer' })), h.message(v, JSON.stringify({ auth: 'viewer', role: 'viewer' }))];
    release(true);
    await Promise.all(frames);
    expect(reads).toHaveLength(1);
    expect(v.sent).toEqual([{ ok: true, role: 'viewer' }, { tap: 'gone' }]);
  });

  it('authenticates a tap and a viewer, and tells each what the other is doing', async () => {
    const { h, open } = hub();
    const v = open();
    await h.message(v, JSON.stringify({ auth: 'viewer', role: 'viewer' }));
    expect(v.sent).toEqual([{ ok: true, role: 'viewer' }, { tap: 'gone' }]);
    const t = open();
    await h.message(t, JSON.stringify({ auth: 'tap-5', role: 'tap' }));
    expect(t.sent).toEqual([{ ok: true, role: 'tap' }, { watching: false }]);
    expect(v.sent.at(-1)).toEqual({ tap: 'connected' });
  });

  it('tells the tap when someone starts and stops watching, and when the last watcher leaves', async () => {
    const { h, open } = hub();
    const t = open();
    await h.message(t, JSON.stringify({ auth: 'tap-5', role: 'tap' }));
    const a = open();
    const b = open();
    for (const v of [a, b]) await h.message(v, JSON.stringify({ auth: 'viewer', role: 'viewer' }));
    await h.message(a, JSON.stringify({ live: true }));
    await h.message(b, JSON.stringify({ live: true }));
    await h.message(a, JSON.stringify({ live: false }));
    expect(t.sent.slice(2)).toEqual([{ watching: true }, { watching: true }, { watching: true }]);
    h.closed(b);
    b.close(1000, 'bye');
    expect(t.sent.at(-1)).toEqual({ watching: false });
  });

  it('sends summaries only to viewers who turned Live on', async () => {
    const { h, open, tick } = hub();
    const t = open();
    await h.message(t, JSON.stringify({ auth: 'tap-5', role: 'tap' }));
    const on = open();
    const off = open();
    for (const v of [on, off]) await h.message(v, JSON.stringify({ auth: 'viewer', role: 'viewer' }));
    await h.message(on, JSON.stringify({ live: true }));
    tick(1000);
    await h.message(t, summary());
    expect(on.sent.at(-1)).toMatchObject({ edges: [{ from: '1', to: '2' }] });
    expect(off.sent.some(m => (m as { edges?: unknown }).edges)).toBe(false);
  });

  it('refuses a tap token for another board, a bad token, a second tap, and an unreadable viewer', async () => {
    const { h, open } = hub();
    const wrongBoard = open();
    await h.message(wrongBoard, JSON.stringify({ auth: 'tap-6', role: 'tap' }));
    expect(wrongBoard.closedWith?.[0]).toBe(CLOSE.auth);
    const garbage = open();
    await h.message(garbage, 'hello');
    expect(garbage.closedWith).toEqual([CLOSE.auth, 'The first message must be { auth, role }.']);
    const first = open();
    await h.message(first, JSON.stringify({ auth: 'tap-5', role: 'tap' }));
    const second = open();
    await h.message(second, JSON.stringify({ auth: 'tap-5', role: 'tap' }));
    expect(second.closedWith?.[0]).toBe(CLOSE.conflict);
    const stranger = open();
    await h.message(stranger, JSON.stringify({ auth: 'someone-else', role: 'viewer' }));
    expect(stranger.closedWith).toEqual([CLOSE.auth, 'You cannot read this board.']);
  });

  it('drops summaries sent too fast, too large or malformed, and closes a tap that keeps doing it', async () => {
    const { h, open, tick } = hub();
    const t = open();
    await h.message(t, JSON.stringify({ auth: 'tap-5', role: 'tap' }));
    const v = open();
    await h.message(v, JSON.stringify({ auth: 'viewer', role: 'viewer' }));
    await h.message(v, JSON.stringify({ live: true }));
    tick(1000);
    await h.message(t, summary());
    await h.message(t, summary()); // within MIN_INTERVAL_MS
    tick(MIN_INTERVAL_MS);
    await h.message(t, 'x'.repeat(MAX_MESSAGE_BYTES + 1));
    await h.message(t, JSON.stringify({ edges: 'nope' }));
    expect(v.sent.filter(m => (m as { edges?: unknown }).edges)).toHaveLength(1);
    for (let i = 0; i < MAX_STRIKES; i++) await h.message(t, '{');
    expect(t.closedWith?.[0]).toBe(CLOSE.abuse);
  });

  // The tap sends up to MAX_EDGES edges a window; the size cap must not strike it out for a busy system.
  it(`relays a full window of ${MAX_EDGES} edges with 20-digit node ids`, async () => {
    const { h, open, tick } = hub();
    const t = open();
    await h.message(t, JSON.stringify({ auth: 'tap-5', role: 'tap' }));
    const v = open();
    await h.message(v, JSON.stringify({ auth: 'viewer', role: 'viewer' }));
    await h.message(v, JSON.stringify({ live: true }));
    const id = (i: number) => String(10n ** 19n + BigInt(i));
    const edges = Array.from({ length: MAX_EDGES }, (_, i) => ({ from: id(i), to: id(i + 1), count: 123456789, errors: 12345, p50: 12345.6, p95: 123456.7, max: 1234567.8 }));
    for (let i = 0; i < MAX_STRIKES; i++) {
      tick(MIN_INTERVAL_MS);
      await h.message(t, summary(edges));
    }
    expect(t.closedWith).toBeNull();
    expect(v.sent.filter(m => (m as { edges?: unknown[] }).edges?.length === MAX_EDGES)).toHaveLength(MAX_STRIKES);
  });

  it('closes a viewer whose read access is revoked, and one that stops re-sending its token', async () => {
    const { h, open, readers, tick } = hub({ readers: ['viewer', 'other'] });
    const t = open();
    await h.message(t, JSON.stringify({ auth: 'tap-5', role: 'tap' }));
    const revoked = open();
    const silent = open();
    const kept = open();
    for (const [v, token] of [[revoked, 'viewer'], [silent, 'viewer'], [kept, 'other']] as const) {
      await h.message(v, JSON.stringify({ auth: token, role: 'viewer' }));
      await h.message(v, JSON.stringify({ live: true }));
    }
    tick(REAUTH_MS);
    await h.message(kept, JSON.stringify({ auth: 'other' }));
    readers.splice(readers.indexOf('viewer'), 1); // the link, grant or membership is gone
    await h.message(revoked, JSON.stringify({ auth: 'viewer' }));
    expect(revoked.closedWith).toEqual([CLOSE.auth, 'You can no longer read this board.']);
    tick(ACCESS_TTL_MS - REAUTH_MS + 1);
    await h.message(t, summary());
    expect(silent.closedWith?.[0]).toBe(CLOSE.auth);
    expect(silent.sent.some(m => (m as { edges?: unknown }).edges)).toBe(false);
    expect(kept.closedWith).toBeNull();
    expect(kept.sent.at(-1)).toMatchObject({ edges: [{ from: '1', to: '2' }] });
  });

  it('checks a viewer token at most once per half interval', async () => {
    const reads: string[] = [];
    const sockets: FakeSocket[] = [];
    let clock = 0;
    const h = new LiveHub({ verifyTap: async () => null, canRead: async t => (reads.push(t), true), revokedBefore: async () => 0, revoke: async () => {}, now: () => clock }, () => sockets);
    const v = new FakeSocket({ role: 'pending', board: '5', at: 0 });
    sockets.push(v);
    await h.message(v, JSON.stringify({ auth: 'viewer', role: 'viewer' }));
    for (let i = 0; i < 5; i++) await h.message(v, JSON.stringify({ auth: 'viewer' }));
    clock += REAUTH_MS / 2;
    await h.message(v, JSON.stringify({ auth: 'viewer' }));
    expect(reads).toHaveLength(2);
  });

  it('reports its tap, when it last published, and whether anyone watches (tap_status)', async () => {
    const { h, open, tick } = hub();
    expect(h.status()).toEqual({ tap: false, since: null, lastPublish: null, sub: null, watching: false });
    tick(1000);
    const t = open();
    await h.message(t, JSON.stringify({ auth: 'tap-5', role: 'tap' }));
    const v = open();
    await h.message(v, JSON.stringify({ auth: 'viewer', role: 'viewer' }));
    await h.message(v, JSON.stringify({ live: true }));
    tick(1000);
    await h.message(t, summary());
    expect(h.status()).toEqual({ tap: true, since: 1000, lastPublish: 2000, sub: 'agent:user_ada', watching: true });
  });

  it('reports a tap that connected before its subject was recorded', () => {
    const sockets = [new FakeSocket({ role: 'tap', board: '5', at: 7, last: 0, strikes: 0 })];
    const h = new LiveHub({ verifyTap: async () => null, canRead: async () => false, revokedBefore: async () => 0, revoke: async () => {}, now: () => 0 }, () => sockets);
    expect(h.status()).toEqual({ tap: true, since: 7, lastPublish: null, sub: null, watching: false });
  });

  it('closes a tap once its token expires, and lets a fresh tap take its place', async () => {
    const { h, open, tick } = hub();
    const t = open();
    await h.message(t, JSON.stringify({ auth: 'tap-5-short', role: 'tap' }));
    const v = open();
    await h.message(v, JSON.stringify({ auth: 'viewer', role: 'viewer' }));
    await h.message(v, JSON.stringify({ live: true }));
    tick(59_000);
    await h.message(t, summary());
    tick(1_000);
    await h.message(t, summary());
    expect(t.closedWith).toEqual([CLOSE.auth, TAP_EXPIRED]);
    expect(v.sent.filter(m => (m as { edges?: unknown }).edges)).toHaveLength(1);
    const fresh = open();
    await h.message(fresh, JSON.stringify({ auth: 'tap-5', role: 'tap' }));
    expect(fresh.sent[0]).toEqual({ ok: true, role: 'tap' });
    // the expired tap finishes closing after the fresh one connected: viewers still have a tap
    h.closed(t);
    expect(v.sent.at(-1)).toEqual({ tap: 'connected' });
  });

  it('closes an idle expired tap when a viewer arrives or the status is asked', async () => {
    const a = hub();
    const idle = a.open();
    await a.h.message(idle, JSON.stringify({ auth: 'tap-5-short', role: 'tap' }));
    a.tick(60_000);
    const v = a.open();
    await a.h.message(v, JSON.stringify({ auth: 'viewer', role: 'viewer' }));
    expect(v.sent.at(-1)).toEqual({ tap: 'gone' });
    expect(idle.closedWith).toEqual([CLOSE.auth, TAP_EXPIRED]);

    const b = hub();
    const asked = b.open();
    await b.h.message(asked, JSON.stringify({ auth: 'tap-5-short', role: 'tap' }));
    b.tick(60_000);
    expect(b.h.status().tap).toBe(false);
    expect(asked.closedWith).toEqual([CLOSE.auth, TAP_EXPIRED]);
  });

  it('stops the tap and refuses every token issued up to the stop (stop_tap)', async () => {
    const { h, open, tick } = hub();
    const t = open();
    await h.message(t, JSON.stringify({ auth: 'tap-5', role: 'tap' }));
    tick(10_000);
    expect(await h.stop()).toBe(true);
    expect(t.closedWith).toEqual([CLOSE.auth, TAP_STOPPED]);
    const again = open();
    await h.message(again, JSON.stringify({ auth: 'tap-5', role: 'tap' }));
    expect(again.closedWith).toEqual([CLOSE.auth, TAP_STOPPED]);
    const later = open();
    await h.message(later, JSON.stringify({ auth: 'tap-5-later', role: 'tap' }));
    expect(later.sent[0]).toEqual({ ok: true, role: 'tap' });
    expect(h.status().tap).toBe(true);
  });

  it('revokes tokens on a stop even when no tap is connected', async () => {
    const { h, open, tick } = hub();
    tick(10_000);
    expect(await h.stop()).toBe(false);
    const t = open();
    await h.message(t, JSON.stringify({ auth: 'tap-5', role: 'tap' }));
    expect(t.closedWith).toEqual([CLOSE.auth, TAP_STOPPED]);
  });

  it('closes connections that never authenticate', async () => {
    const { h, open, tick } = hub();
    const s = open();
    expect(h.sweep()).toBe(true);
    tick(AUTH_MS);
    expect(h.sweep()).toBe(false);
    expect(s.closedWith?.[0]).toBe(CLOSE.auth);
  });
});

describe('tap tokens', () => {
  it('verify for their board until they expire', async () => {
    const env = await testEnv();
    const token = await mintTap(env, 'agent:user_ada', 42n, 1_000_000);
    expect(await verifyTap(env, token, 1_000_000)).toEqual({ sub: 'agent:user_ada', board: 42n, iat: 1_000, exp: 1_000 + 12 * 3600 });
    expect(await verifyTap(env, token, 1_000_000 + 12 * 3600 * 1000)).toBeNull();
  });

  it('are not database tokens, and database tokens are not tap tokens', async () => {
    const env = await testEnv();
    const tap = await mintTap(env, 'agent:user_ada', 42n);
    const claims = JSON.parse(atob(tap.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    expect(claims.iss).toBe('https://mcp.redcrayon.test/tap');
    expect(claims.aud).toBe('redcrayon-tap');
    expect(await verifyTap(env, await mint(env, 'agent:user_ada'))).toBeNull();
  });

  it('reject another key, a tampered payload and junk', async () => {
    const env = await testEnv();
    const other = await testEnv({ AGENT_JWK: await newJwk('k1') });
    const token = await mintTap(other, 'agent:user_ada', 42n);
    expect(await verifyTap(env, token)).toBeNull();
    const mine = await mintTap(env, 'agent:user_ada', 42n);
    const [h, , sig] = mine.split('.');
    const forged = btoa(JSON.stringify({ iss: 'https://mcp.redcrayon.test/tap', aud: 'redcrayon-tap', sub: 'x', board: '7', exp: 9e9 })).replace(/=+$/, '');
    expect(await verifyTap(env, `${h}.${forged}.${sig}`)).toBeNull();
    expect(await verifyTap(env, 'not.a.token')).toBeNull();
  });

  it('reject a forged signature, another algorithm, and a token without a kid', async () => {
    const env = await testEnv();
    const [h, p, sig] = (await mintTap(env, 'agent:user_ada', 42n)).split('.');
    const b64 = (v: unknown) => btoa(JSON.stringify(v)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const flipped = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1);
    expect(await verifyTap(env, `${h}.${p}.${flipped}`)).toBeNull();
    const kid = JSON.parse(atob(h.replace(/-/g, '+').replace(/_/g, '/'))).kid;
    expect(await verifyTap(env, `${b64({ alg: 'ES384', typ: 'JWT', kid })}.${p}.${sig}`)).toBeNull();
    expect(await verifyTap(env, `${b64({ alg: 'none', typ: 'JWT', kid })}.${p}.`)).toBeNull();
    expect(await verifyTap(env, `${b64({ alg: 'HS256', typ: 'JWT', kid })}.${p}.${sig}`)).toBeNull();
    // the right key and signature, but no kid in a re-signed header
    const key = await crypto.subtle.importKey('jwk', { ...JSON.parse(env.AGENT_JWK!), key_ops: ['sign'] }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    const bare = b64({ alg: 'ES256', typ: 'JWT' });
    const signed = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(`${bare}.${p}`)));
    const s64 = btoa(String.fromCharCode(...signed)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(await verifyTap(env, `${bare}.${p}.${s64}`)).toBeNull();
    expect(await verifyTap(env, `${h}.${p}.${sig}`)).toMatchObject({ sub: 'agent:user_ada', board: 42n });
  });

  it('still verify during a key rotation (signed by the previous key)', async () => {
    const old = await newJwk('k0');
    const before = await testEnv({ AGENT_JWK: old });
    const token = await mintTap(before, 'agent:user_ada', 42n);
    const after = await testEnv({ AGENT_JWK: await newJwk('k1'), AGENT_JWK_PREV: old });
    expect(await verifyTap(after, token)).toMatchObject({ sub: 'agent:user_ada', board: 42n });
  });
});

describe('marks tokens', () => {
  const seat = 'abcDEF0123456789';
  it('verify for their board and seat until they expire', async () => {
    const env = await testEnv();
    const token = await mintMarks(env, 'agent:user_ada', 42n, seat, 1_000_000);
    expect(await verifyMarks(env, token, 1_000_000)).toEqual({ sub: 'agent:user_ada', board: 42n, seat });
    expect(await verifyMarks(env, token, 1_000_000 + 12 * 3600 * 1000)).toBeNull();
  });

  it('are neither tap tokens nor database tokens, and vice versa', async () => {
    const env = await testEnv();
    const marks = await mintMarks(env, 'agent:user_ada', 42n, seat);
    const claims = JSON.parse(atob(marks.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    expect(claims.iss).toBe('https://mcp.redcrayon.test/marks');
    expect(claims.aud).toBe('redcrayon-marks');
    expect(await verifyTap(env, marks)).toBeNull();
    expect(await verifyMarks(env, await mintTap(env, 'agent:user_ada', 42n))).toBeNull();
    expect(await verifyMarks(env, await mint(env, 'agent:user_ada'))).toBeNull();
  });

  it('reject another key, a tampered payload and junk', async () => {
    const env = await testEnv();
    const other = await testEnv({ AGENT_JWK: await newJwk('k1') });
    expect(await verifyMarks(env, await mintMarks(other, 'agent:user_ada', 42n, seat))).toBeNull();
    const [h, , sig] = (await mintMarks(env, 'agent:user_ada', 42n, seat)).split('.');
    const forged = btoa(JSON.stringify({ iss: 'https://mcp.redcrayon.test/marks', aud: 'redcrayon-marks', sub: 'x', board: '7', seat, exp: 9e9 })).replace(/=+$/, '');
    expect(await verifyMarks(env, `${h}.${forged}.${sig}`)).toBeNull();
    expect(await verifyMarks(env, 'not.a.token')).toBeNull();
  });
});
