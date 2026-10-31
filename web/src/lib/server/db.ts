import postgres from 'postgres';
import { env } from '$env/dynamic/private';

// One client per request (Workers forbid reusing a socket across requests);
// postgres() connects lazily. Callers check DATABASE_URL first and always
// `await sql.end()`. fetch_types: false skips a pg_catalog round trip, so
// avoid array columns (they would come back as raw strings).
// A HYPERDRIVE binding pools warm database connections, so a request skips
// the TCP, TLS and auth round trips. DATABASE_URL stays the fallback and
// the "is it configured" check.
// The config must have caching disabled: a cached SELECT would hide events the
// read just drained.
type Hyperdrive = { env?: { HYPERDRIVE?: { connectionString: string } } };
export const connect = (platform?: App.Platform) =>
  postgres((platform as Hyperdrive | undefined)?.env?.HYPERDRIVE?.connectionString ?? env.DATABASE_URL!, {
    max: 1,
    fetch_types: false
  });

export type Sql = ReturnType<typeof connect>;
