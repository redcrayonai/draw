/**
 * The Worker's database access (spec §3): shared/db-http.ts with a token we
 * minted, typed SQL holes, the reducer argument builder, and per-request
 * counters for the log line. The only file that reads DB_URL and DB_NAME.
 *
 * SQL holes accept only SafeU64 (an integer below 2^53) and SafeToken
 * (^[A-Za-z0-9_]{1,64}$): a plain string fails tsc (Decision 16). Lookups by
 * name, path or symbol read by board id and filter in Worker code, so no
 * string from a model, a user or a capture is ever interpolated.
 */
import { dbHttp } from '../../shared/db-http';
import { decodeRows } from './decode';
import type { Env } from './env';
import { REDUCER_ARGS } from './reducers.gen';

declare const safe: unique symbol;
export type SafeU64 = bigint & { readonly [safe]: 'u64' };
export type SafeToken = string & { readonly [safe]: 'token' };
export type Query = { readonly text: string };

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/** An id from a model, or undefined when it is not an integer below 2^53. */
export function safeU64(value: string | number | bigint): SafeU64 | undefined {
  const text = String(value);
  if (!/^\d{1,16}$/.test(text)) return undefined;
  const n = BigInt(text);
  return n <= MAX_SAFE ? (n as SafeU64) : undefined;
}

export function safeToken(value: string): SafeToken | undefined {
  return /^[A-Za-z0-9_]{1,64}$/.test(value) ? (value as SafeToken) : undefined;
}

export function sql(strings: TemplateStringsArray, ...holes: (SafeU64 | SafeToken)[]): Query {
  let text = strings[0];
  holes.forEach((hole, i) => {
    // Re-checked at run time too: a cast must not smuggle text past the type.
    if (typeof hole === 'bigint' ? hole > MAX_SAFE || hole < 0n : !/^[A-Za-z0-9_]{1,64}$/.test(hole)) throw new Error('unsafe SQL hole');
    text += String(hole) + strings[i + 1];
  });
  return { text };
}

export type Reducer = keyof typeof REDUCER_ARGS;

// Optional arguments travel as the sum's JSON form; u64s as bigint (db-http sends them raw).
const SOME = (v: unknown) => ({ some: v });
const NONE = { none: [] as [] };

/** `{ boardId, label, … }` -> the positional list /call/<reducer> takes; unknown or missing keys are a bug. */
export function positional(reducer: Reducer, args: Record<string, unknown>): unknown[] {
  const spec = (REDUCER_ARGS as Record<string, readonly (readonly [string, string, boolean])[]>)[reducer];
  if (!spec) throw new Error(`no argument list for ${reducer}; run node mcp/scripts/gen.mjs`);
  const known = new Set(spec.map(([k]) => k));
  for (const k of Object.keys(args)) if (!known.has(k)) throw new Error(`${reducer} takes no argument ${k}`);
  return spec.map(([key, type, optional]) => {
    const v = args[key];
    if (v === undefined) {
      if (optional) return NONE;
      throw new Error(`${reducer} needs ${key}`);
    }
    const value = type === 'u64' && typeof v !== 'bigint' ? BigInt(v as string | number) : v;
    return optional ? SOME(value) : value;
  });
}

/** Per request: DB requests, their time, and how many writes committed (a later failure must not say "Nothing was written"). */
export type Stats = { dbCalls: number; dbMs: number; writes: number };

/** The database as one caller (`token`), counting requests and time for the log line. */
export function database(env: Env, token: () => Promise<string>, stats: Stats = { dbCalls: 0, dbMs: 0, writes: 0 }) {
  const http = dbHttp(env.DB_URL.replace(/\/$/, ''), env.DB_NAME);
  const timed = async <T>(run: () => Promise<T>): Promise<T> => {
    const started = Date.now();
    stats.dbCalls += 1;
    try {
      return await run();
    } finally {
      stats.dbMs += Date.now() - started;
    }
  };
  // Each request gets 5 s (spec §3 Budgets), and also stops with the tool's own signal.
  const signalFor = (outer?: AbortSignal) => (outer ? AbortSignal.any([outer, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000));
  return {
    stats,
    http,
    token,
    /** Rows decoded by their schema (decode.ts): camelCase keys, u64s as bigint, options as value or undefined. */
    async read<T = Record<string, unknown>>(query: Query, signal?: AbortSignal): Promise<T[]> {
      const t = await token();
      return decodeRows(await timed(() => http.sqlTypedAs(t, query.text, signalFor(signal)))) as T[];
    },
    async call(reducer: Reducer, args: Record<string, unknown>, signal?: AbortSignal): Promise<void> {
      const t = await token();
      const list = positional(reducer, args);
      await timed(() => http.callAs(t, reducer, list, signalFor(signal)));
      stats.writes += 1;
    },
  };
}

export type Database = ReturnType<typeof database>;
