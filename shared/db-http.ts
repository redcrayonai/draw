/**
 * The database's HTTP API, server-side: `/sql` reads and `/call` reducer calls
 * as the caller's token. The only code that builds database URLs; `web/` and
 * `mcp/` both use it. Nothing here names the vendor: its text can reach users.
 */

/** A non-2xx answer from the database. 530 means the reducer threw; `message` is its text. */
export class DbError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

export type DbRow = Record<string, unknown>;

/** A column's algebraic type as /sql's schema states it, e.g. {"U64":[]} or {"Array":{"U64":[]}}. */
export type DbType = Record<string, unknown>;

// u64 values above 2^53 must not round: parse them as bigint, send bigints as raw JSON numbers.
const reviver = (_key: string, value: unknown, ctx?: { source: string }) =>
  typeof value === 'number' && !Number.isSafeInteger(value) && ctx && /^-?\d+$/.test(ctx.source)
    ? BigInt(ctx.source)
    : value;
const replacer = (_key: string, value: unknown) =>
  typeof value === 'bigint'
    ? (JSON as unknown as { rawJSON(text: string): unknown }).rawJSON(value.toString())
    : value;

/** The client for database `db` on the server at `url`. */
export function dbHttp(url: string, db: string) {
  // Every HTTP call runs the module's onConnect/onDisconnect as the token's identity.
  async function post(token: string, path: string, body: string, contentType: string, signal?: AbortSignal): Promise<string> {
    const res = await fetch(`${url}/v1/database/${db}/${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': contentType },
      body,
      signal
    });
    const text = await res.text();
    if (res.ok) return text;
    // Callers pass user and service tokens alike, so the text names neither; routes add their own advice.
    if (res.status === 401) throw new DbError(401, `the database rejected the token sent to ${path}: ${text}`);
    if (res.status === 530) throw new DbError(530, text);
    throw new DbError(res.status, `the database answered ${res.status} to ${path}: ${text}`);
  }

  async function sqlResult(token: string, query: string, signal?: AbortSignal) {
    const [result] = JSON.parse(await post(token, 'sql', query, 'text/plain', signal), reviver) as {
      schema: { elements: { name: { some?: string }; algebraic_type: DbType }[] };
      rows: unknown[][];
    }[];
    return result;
  }

  return {
    /** Run one SQL statement as the token's identity (views see that caller). Rows are keyed by column name. */
    async sqlAs(token: string, query: string, signal?: AbortSignal): Promise<DbRow[]> {
      const result = await sqlResult(token, query, signal);
      const columns = result.schema.elements.map((e) => e.name.some ?? '');
      return result.rows.map((row) => Object.fromEntries(columns.map((c, i) => [c, row[i]])));
    },

    /** The same read with each column's type, for callers that decode options, arrays and u64s by type. */
    async sqlTypedAs(token: string, query: string, signal?: AbortSignal): Promise<{ columns: { name: string; type: DbType }[]; rows: unknown[][] }> {
      const result = await sqlResult(token, query, signal);
      return { columns: result.schema.elements.map((e) => ({ name: e.name.some ?? '', type: e.algebraic_type })), rows: result.rows };
    },

    /** Call a reducer by its snake_case name with positional arguments. */
    async callAs(token: string, reducer: string, args: unknown[], signal?: AbortSignal): Promise<void> {
      await post(token, `call/${reducer}`, JSON.stringify(args, replacer), 'application/json', signal);
    }
  };
}

export type DbHttp = ReturnType<typeof dbHttp>;

/** An identity (hex, with or without 0x) as a reducer argument. */
export const identityArg = (hex: string) => ({ __identity__: `0x${hex.replace(/^0x/, '')}` });

// SQL cells of special types come as [value] or {"__<tag>__": value}.
const unwrap = (cell: unknown, tag: string) =>
  Array.isArray(cell) ? cell[0] : cell && typeof cell === 'object' ? (cell as DbRow)[tag] : cell;

/** Identity cell → lowercase hex without 0x. */
export const hexOf = (cell: unknown) =>
  String(unwrap(cell, '__identity__')).replace(/^0x/, '').toLowerCase();

const micros = (cell: unknown) => unwrap(cell, '__timestamp_micros_since_unix_epoch__');

/** Timestamp cell (microseconds since the Unix epoch) → Date. */
export const dateOf = (cell: unknown) => new Date(Number(micros(cell)) / 1000);

/** Timestamp cell → exact microseconds since the Unix epoch. */
export const microsOf = (cell: unknown) => BigInt(micros(cell) as number | bigint);
