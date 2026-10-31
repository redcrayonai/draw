/**
 * The USER Durable Object's logic (spec §10 Metering, §3 Duplicate client
 * requests): one instance per account, so its methods run one at a time.
 * - charge: counts this month's tools/call and refuses past the plan limit.
 *   Billing-grade counts come from here; Analytics Engine is sampled.
 * - claim/settle: a 30 s window over create calls. A 2026-07-28 client re-sends
 *   a request when its stream breaks; the repeat waits for the first and gets
 *   its result instead of writing again.
 */

/** Every plan is unlimited at launch (D5); the hook is proven at a limit of 3 in tests. */
export const PLANS: Record<string, { callsPerMonth: number }> = { free: { callsPerMonth: Infinity } };

export const DEDUPE_MS = 30_000;
// A first call that never settles (an evicted isolate) frees its key after the tool budget.
const PENDING_MS = 16_000;

export interface Storage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

type Entry = { at: number; text?: string; done: Promise<void>; resolve: () => void };

export class UserLedger {
  private readonly recent = new Map<string, Entry>();

  constructor(private readonly storage: Storage, private readonly now: () => number = Date.now) {}

  /** month as YYYY-MM (UTC). `limit` comes from the plan; Infinity never refuses. */
  async charge(month: string, limit: number): Promise<{ ok: boolean; used: number }> {
    const key = `calls:${month}`;
    const used = (await this.storage.get<number>(key)) ?? 0;
    if (used >= limit) return { ok: false, used };
    await this.storage.put(key, used + 1);
    return { ok: true, used: used + 1 };
  }

  async used(month: string): Promise<number> {
    return (await this.storage.get<number>(`calls:${month}`)) ?? 0;
  }

  /** The first caller of `key` in the window gets { first: true }; a repeat gets the first one's result. */
  async claim(key: string): Promise<{ first: true } | { first: false; text: string; ageS: number }> {
    const now = this.now();
    for (const [k, e] of this.recent) if (now - e.at > (e.text === undefined ? PENDING_MS : DEDUPE_MS)) this.recent.delete(k);
    const entry = this.recent.get(key);
    if (entry) {
      if (entry.text === undefined) await Promise.race([entry.done, new Promise(r => setTimeout(r, PENDING_MS))]);
      if (entry.text !== undefined) return { first: false, text: entry.text, ageS: Math.round((this.now() - entry.at) / 1000) };
    }
    let resolve!: () => void;
    const done = new Promise<void>(r => (resolve = r));
    this.recent.set(key, { at: now, done, resolve });
    return { first: true };
  }

  /** The first call's result text, or null when it wrote nothing (a repeat may then try again). */
  async settle(key: string, text: string | null): Promise<void> {
    const entry = this.recent.get(key);
    if (!entry) return;
    if (text === null) this.recent.delete(key);
    else entry.text = text;
    entry.resolve();
  }
}

export const monthOf = (d: Date) => d.toISOString().slice(0, 7);
