// One-time rollout step for code consent (RC-690). Every board
// has no consent when the release ships, so the code text stored before it must go. Two passes:
//
//   1. Hashes: for every code ref and source citation that holds text, write the line
//      hashes of that text. Refs and citations keep tracking their code without it.
//      Nothing is deleted. Run it right after the deploy, and again before a wipe.
//   2. --wipe: blank the text on every board without consent. It cannot be undone.
//      It never runs when a hash in pass 1 failed.
//
//   STDB_OWNER_TOKEN=<owner token> STDB_SERVICE_TOKEN=<service token> \
//     node --experimental-strip-types scripts/wipe-stored-code.mjs --url <db url> --db <name> [--wipe]
//
// The owner token reads the private tables; the service token (a service_account
// identity) calls the reducers. The flag lets Node load the hash from agent/src, the one
// place that defines it.
import { lineHash, lineHashes } from '../agent/src/code-hash.ts';

const flag = name => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? undefined : process.argv[i + 1];
};
const BASE = flag('url');
const DB = flag('db');
const WIPE = process.argv.includes('--wipe');
const OWNER = process.env.STDB_OWNER_TOKEN;
const SERVICE = process.env.STDB_SERVICE_TOKEN;
if (!BASE || !DB || !OWNER || !SERVICE) {
  console.error('usage: STDB_OWNER_TOKEN=… STDB_SERVICE_TOKEN=… node --experimental-strip-types scripts/wipe-stored-code.mjs --url <db url> --db <name> [--wipe]');
  process.exit(2);
}

/** Rows as objects keyed by column name. */
async function sql(query) {
  const r = await fetch(`${BASE}/v1/database/${DB}/sql`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${OWNER}`, 'Content-Type': 'text/plain' },
    body: query,
  });
  const text = await r.text();
  if (r.status !== 200) throw new Error(`sql ${r.status}: ${text} (${query})`);
  const [res] = JSON.parse(text);
  const cols = res.schema.elements.map(e => e.name?.some ?? e.name);
  return res.rows.map(row => Object.fromEntries(cols.map((c, i) => [c, row[i]])));
}

async function call(reducer, args) {
  const r = await fetch(`${BASE}/v1/database/${DB}/call/${reducer}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  return { ok: r.status === 200, text: await r.text() };
}

/** Hashes the `rows` that `done` lacks with `write`; counts the rows hashed now, hashed before and failed. */
async function backfill(rows, done, write) {
  const n = { now: 0, before: 0, failed: 0 };
  for (const row of rows) {
    if (done.has(row.id)) { n.before++; continue; }
    const r = await write(row);
    if (r.ok) n.now++;
    // A row deleted since it was read needs no hash.
    else if (!r.text.includes('does not exist')) { n.failed++; console.error(`${row.what} ${row.id}: ${r.text}`); }
  }
  return n;
}

const report = (what, rows, n) => console.log(`${what} with text: ${rows.length} (hashed now: ${n.now}, already hashed: ${n.before}, failed: ${n.failed})`);

const refs = (await sql("SELECT id, snippet FROM code_ref WHERE snippet <> ''"))
  .map(r => ({ id: r.id, what: 'code ref', snippet: r.snippet }));
const refsDone = new Set((await sql('SELECT ref_id FROM code_ref_hash')).map(r => r.ref_id));
// A snippet of blank text has no line worth tracking, as in the flows (agent/src/session.ts).
const cites = (await sql("SELECT id, evidence, evidence_snippet FROM edge WHERE evidence_snippet <> ''"))
  .filter(e => e.evidence.startsWith('source:') && e.evidence_snippet.trim() !== '')
  .map(e => ({ id: e.id, what: 'source citation', snippet: e.evidence_snippet }));
const citesDone = new Set((await sql('SELECT edge_id FROM edge_evidence_hash')).map(r => r.edge_id));

const refN = await backfill(refs, refsDone, r =>
  call('set_code_ref_hashes', [r.id, lineHashes(r.snippet.split('\n')).join(' ')]));
const citeN = await backfill(cites, citesDone, r =>
  call('set_edge_evidence_code', [r.id, lineHash(r.snippet), { none: [] }]));
report('code refs', refs, refN);
report('source citations', cites, citeN);

if (refN.failed + citeN.failed > 0) {
  console.error(WIPE ? 'no text was wiped: fix the failures above and run it again' : 'fix the failures above before a wipe');
  process.exit(1);
}
if (!WIPE) {
  console.log('hashes written, no text changed. Run again with --wipe to blank the text on boards without consent.');
  process.exit(0);
}

const wiped = await call('wipe_stored_code', []);
if (!wiped.ok) {
  console.error(`wipe_stored_code failed: ${wiped.text}`);
  process.exit(1);
}
const left = {
  refs: (await sql("SELECT id FROM code_ref WHERE snippet <> ''")).length,
  cites: (await sql("SELECT id FROM edge WHERE evidence_snippet <> ''")).length,
};
console.log(`wiped. Text left, on boards with consent: ${left.refs} code refs, ${left.cites} source citations`);
