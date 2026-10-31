import { env } from '$env/dynamic/private';
import { dbHttp, type DbHttp } from '$shared/db-http';

export { DbError, type DbRow } from '$shared/db-http';

// This deployment's board database over HTTP (db.ts is Postgres). env is read
// per call, not at import: it is configured per request, and per test.
const db = () => dbHttp(env.SPACETIMEDB_URL!, env.SPACETIMEDB_DB!);
export const sqlAs: DbHttp['sqlAs'] = (...args) => db().sqlAs(...args);
export const callAs: DbHttp['callAs'] = (...args) => db().callAs(...args);
export const procedureAs: DbHttp['procedureAs'] = (...args) => db().procedureAs(...args);
