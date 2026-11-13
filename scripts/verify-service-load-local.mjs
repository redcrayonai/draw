// Run alone through stdb-test.sh: the procedure and SQL oracle read separate
// snapshots of global participant counts, which concurrent suites change.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.STDB_URL;
const DB = process.env.STDB_DB;
const OWNER = process.env.STDB_OWNER_TOKEN;
if (!BASE || !DB || !OWNER) {
  throw new Error('set STDB_URL, STDB_DB and STDB_OWNER_TOKEN (scripts/stdb-test.sh run does)');
}
if (DB === 'redcrayon') {
  throw new Error("refusing to run against the shared 'redcrayon' database; use scripts/stdb-test.sh");
}

const bigints = (_k, v, ctx) => (typeof v === 'number' && !Number.isSafeInteger(v) ? BigInt(ctx.source) : v);
const camel = s => s.replace(/_([a-z])/g, (_m, c) => c.toUpperCase());

async function mint() {
  const r = await fetch(`${BASE}/v1/identity`, { method: 'POST' });
  assert.equal(r.status, 200, 'POST /v1/identity');
  return r.json(); // { identity: '<hex, no 0x>', token }
}

async function call(token, reducer, args = []) {
  const r = await fetch(`${BASE}/v1/database/${DB}/call/${reducer}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args, (_k, v) => (typeof v === 'bigint' ? JSON.rawJSON(v.toString()) : v)),
  });
  return { status: r.status, text: await r.text() };
}

async function ok(token, reducer, args) {
  const r = await call(token, reducer, args);
  assert.equal(r.status, 200, `${reducer} should succeed, got ${r.status}: ${r.text}`);
}

// rows as objects keyed by camelCase column names
async function sql(token, query) {
  const r = await fetch(`${BASE}/v1/database/${DB}/sql`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' },
    body: query,
  });
  const text = await r.text();
  assert.equal(r.status, 200, `sql ${r.status}: ${text} (${query})`);
  const [res] = JSON.parse(text, bigints);
  const cols = res.schema.elements.map(e => camel(e.name?.some ?? e.name));
  return res.rows.map(row => Object.fromEntries(cols.map((c, i) => [c, row[i]])));
}

const micros = v => Number(Array.isArray(v) ? v[0] : v.__timestamp_micros_since_unix_epoch__);

test('service_load returns only aggregate metrics and refuses non-service callers', async () => {
  const svc = await mint(), guest = await mint(), agent = await mint();
  await ok(agent.token, 'join_board', ['load-agent', 'agent']);
  await sql(OWNER, `INSERT INTO service_account (identity, label) VALUES (0x${svc.identity}, 'metrics-test')`);
  const refused = await call(guest.token, 'service_load');
  assert.equal(refused.status, 500); // Procedures report thrown errors as 500, unlike reducers' 530.
  assert.match(refused.text, /service account only/);
  const result = await call(svc.token, 'service_load');
  assert.equal(result.status, 200, result.text);
  const counts = JSON.parse(JSON.parse(result.text));
  const rows = await sql(svc.token, 'SELECT * FROM visible_participant');
  const hourAgo = (Date.now() - 3_600_000) * 1000;
  assert.deepEqual(counts, {
    participants: rows.length,
    online: rows.filter(r => r.connections > 0).length,
    connections: rows.reduce((sum, r) => sum + r.connections, 0),
    agents: rows.filter(r => r.kind === 'agent' && micros(r.lastSeenAt) > hourAgo).length,
  });
});
