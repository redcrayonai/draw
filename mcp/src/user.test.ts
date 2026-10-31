import { describe, expect, it } from 'vitest';
import { DEDUPE_MS, UserLedger, type Storage } from './user';

const memory = (): Storage => {
  const m = new Map<string, unknown>();
  return { get: async <T>(k: string) => m.get(k) as T | undefined, put: async (k, v) => void m.set(k, v) };
};

describe('USER ledger', () => {
  it('the plan-limit hook refuses the 4th call at a limit of 3, and counts nothing it refused', async () => {
    const l = new UserLedger(memory());
    for (let i = 1; i <= 3; i++) expect(await l.charge('2026-10', 3)).toEqual({ ok: true, used: i });
    expect(await l.charge('2026-10', 3)).toEqual({ ok: false, used: 3 });
    expect(await l.used('2026-10')).toBe(3);
    expect(await l.charge('2026-11', 3)).toEqual({ ok: true, used: 1 });
  });

  it('unlimited plans never refuse', async () => {
    const l = new UserLedger(memory());
    for (let i = 0; i < 50; i++) expect((await l.charge('2026-10', Infinity)).ok).toBe(true);
  });

  it('a repeat inside 30 s waits for the first call and returns its result', async () => {
    let now = 0;
    const l = new UserLedger(memory(), () => now);
    expect(await l.claim('k')).toEqual({ first: true });
    const repeat = l.claim('k');
    now = 2_000;
    await l.settle('k', 'committed id=7');
    expect(await repeat).toEqual({ first: false, text: 'committed id=7', ageS: 2 });
    now = DEDUPE_MS + 1;
    expect(await l.claim('k')).toEqual({ first: true });
  });

  it('a first call that wrote nothing lets the repeat try again', async () => {
    const l = new UserLedger(memory());
    await l.claim('k');
    const repeat = l.claim('k');
    await l.settle('k', null);
    expect(await repeat).toEqual({ first: true });
  });
});
