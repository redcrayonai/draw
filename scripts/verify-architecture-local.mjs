import { test, before } from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.STDB_URL, DB = process.env.STDB_DB, OWNER = process.env.STDB_OWNER_TOKEN;
if (!BASE || !DB || !OWNER || DB === 'redcrayon') throw new Error('use an isolated STDB_URL/STDB_DB/STDB_OWNER_TOKEN');
const RUN = Date.now().toString(36), SHA = 'a'.repeat(40), SHA2 = 'b'.repeat(40), SHA3 = 'c'.repeat(40), NONE = { none: [] };
const named = name => `${name}-${RUN}`;
const camel = s => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
async function mint() { const r = await fetch(`${BASE}/v1/identity`, { method: 'POST' }); assert.equal(r.status, 200); return r.json(); }
async function call(token, reducer, args = []) {
  const r = await fetch(`${BASE}/v1/database/${DB}/call/${reducer}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(args, (_, v) => typeof v === 'bigint' ? JSON.rawJSON(v.toString()) : v) });
  return { status: r.status, text: await r.text() };
}
async function ok(token, reducer, args) { const r = await call(token, reducer, args); assert.equal(r.status, 200, `${reducer}: ${r.text}`); }
async function rejects(token, reducer, args, message) { const r = await call(token, reducer, args); assert.equal(r.status, 530, `${reducer}: ${r.text}`); assert.ok(r.text.includes(message), r.text); }
async function sql(token, query) {
  const r = await fetch(`${BASE}/v1/database/${DB}/sql`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' }, body: query });
  const text = await r.text(); assert.equal(r.status, 200, text);
  const [res] = JSON.parse(text, (_, v, ctx) => typeof v === 'number' && !Number.isSafeInteger(v) ? BigInt(ctx.source) : v);
  const cols = res.schema.elements.map(e => camel(e.name?.some ?? e.name));
  return res.rows.map(r => Object.fromEntries(cols.map((c, i) => [c, r[i]])));
}
const node = (key, kind = 'service') => ({ key, label: key, sublabel: '', kind });
const edge = (from, to, evidence = 'import') => ({ from, to, label: 'uses', relation: 'import', evidence });
const graph = (nodes = [node('a'), node('b')], edges = [edge('a', 'b')]) => ({ nodes, edges, files: ['a.ts'] });
let svc;
before(async () => { svc = await mint(); await sql(OWNER, `INSERT INTO service_account (identity, label) VALUES (0x${svc.identity}, 'architecture-tests')`); });
async function history(who, name) {
  await ok(who.token, 'create_architecture_history', [named(name), 'https://github.com/example/repo', JSON.stringify([{ ref: 'main', sha: SHA }, { ref: 'next', sha: SHA2 }, { ref: 'future', sha: SHA3 }]), named(name)]);
  return (await sql(who.token, 'SELECT * FROM my_architecture_histories')).find(h => h.requestKey === named(name));
}
async function publish(h, index = 0, g = graph()) { await ok(svc.token, 'publish_architecture_snapshot', [h.id, index, ['main', 'next', 'future'][index], [SHA, SHA2, SHA3][index], JSON.stringify(g)]); return (await sql(OWNER, `SELECT * FROM architecture_version WHERE history_id = ${h.id}`)).find(v => v.assertionMode === 'fact' && v.index === index); }
async function proposal(who, base, name) { await ok(who.token, 'create_architecture_proposal', [base.boardId, named(name), named(name)]); return (await sql(OWNER, `SELECT * FROM architecture_version WHERE history_id = ${base.historyId}`)).find(v => v.requestKey === named(name)); }
const nodes = async v => sql(OWNER, `SELECT * FROM node WHERE board_id = ${v.boardId}`);
const edges = async v => sql(OWNER, `SELECT * FROM edge WHERE board_id = ${v.boardId}`);
const version = async v => (await sql(OWNER, `SELECT * FROM architecture_version WHERE board_id = ${v.boardId}`))[0];
const nodeArgs = (boardId, label) => [boardId, label, '', 0, 0, 160, 80, 'ink', false, ...Array(7).fill(NONE)];

test('architecture publication is pinned, service-only, atomic and retry-idempotent', async () => {
  const user = await mint(), stranger = await mint(), h = await history(user, 'publication');
  assert.equal((await sql(stranger.token, 'SELECT * FROM my_architecture_histories')).some(r => r.id === h.id), false);
  const args = [h.id, 0, 'main', SHA, JSON.stringify(graph())];
  await rejects(user.token, 'set_architecture_import_status', [h.id, 'running', ''], 'service account only');
  await rejects(user.token, 'publish_architecture_snapshot', args, 'service account only');
  await rejects(svc.token, 'publish_architecture_snapshot', [h.id, 0, 'main', SHA2, JSON.stringify(graph())], 'pinned');
  await rejects(svc.token, 'publish_architecture_snapshot', [h.id, 0, 'main', SHA, JSON.stringify(graph([node('a')], [edge('a', 'missing')]))], 'endpoint');
  assert.equal((await sql(OWNER, `SELECT * FROM architecture_version WHERE history_id = ${h.id}`)).length, 0);
  const v = await publish(h); await publish(h);
  await publish(h, 0, graph([node('different')], []));
  assert.equal((await sql(OWNER, `SELECT * FROM architecture_version WHERE history_id = ${h.id}`)).length, 1);
  assert.equal((await nodes(v)).length, 2); assert.equal((await edges(v))[0].evidence, 'import');
  assert.equal((await sql(user.token, 'SELECT * FROM my_boards')).find(b => b.boardId === v.boardId)?.access, 'owner');
  await rejects(svc.token, 'publish_architecture_snapshot', [h.id, 1, 'next', SHA2, JSON.stringify(graph(Array.from({ length: 5001 }, (_, i) => node(String(i))), []))], 'limit');
  await rejects(svc.token, 'publish_architecture_snapshot', [h.id, 1, 'next', SHA2, JSON.stringify(graph(undefined, [edge('a', 'b', '')]))], 'import evidence');
});

test('agent evidence is a valid intent edge at submission', async () => {
  const user = await mint(), h = await history(user, 'agentev'), base = await publish(h);
  const p = await proposal(user, base, 'agentev-p');
  const [a, b] = await nodes(p);
  await ok(user.token, 'create_edge', [p.boardId, b.id, a.id, 'calls back', 'agent: read api.ts', NONE, NONE, NONE]);
  await ok(user.token, 'submit_architecture_proposal', [p.boardId]);
  assert.equal((await version(p)).status, 'submitted');
});

async function plainBoard(who, name) {
  const key = named(name).padEnd(32, 'x'); // request keys are 32–128 URL-safe characters
  await ok(who.token, 'create_requested_board', [named(name), '', key]);
  const [made] = await sql(OWNER, `SELECT * FROM board_creation WHERE request_key = '${key}'`);
  return made.boardId;
}
test('a plain board forks into a branch: keys backfilled, icons and charts copied, branch of branch refused', async () => {
  const user = await mint(), boardId = await plainBoard(user, 'plain');
  await ok(user.token, 'create_node', nodeArgs(boardId, 'A')); await ok(user.token, 'create_node', nodeArgs(boardId, 'B'));
  const [a, b] = await sql(OWNER, `SELECT * FROM node WHERE board_id = ${boardId}`);
  await ok(user.token, 'create_edge', [boardId, a.id, b.id, 'reads', 'human:me', NONE, NONE, NONE]);
  await ok(user.token, 'create_edge', [boardId, a.id, b.id, 'writes', 'human:me', NONE, NONE, NONE]);
  await ok(user.token, 'set_node_icon', [a.id, 'aws']);
  await ok(user.token, 'create_chart', [boardId, 'Latency', 'ms', 0, 200, 320, 200, 'bars', 'route,p50\n/a,12', NONE, { some: 'agent: bench' }]);
  await ok(user.token, 'create_architecture_proposal', [boardId, named('b1'), named('b1')]);
  const v = (await sql(OWNER, `SELECT * FROM architecture_version WHERE base_board_id = ${boardId}`))[0];
  assert.equal(v.historyId, 0); assert.equal(v.ref, ''); assert.equal(v.status, 'draft'); assert.ok(v.sha.startsWith('{"nodes"'));
  const baseNodes = await sql(OWNER, `SELECT * FROM node WHERE board_id = ${boardId}`);
  assert.deepEqual(baseNodes.filter(n => n.kind !== 'chart').map(n => n.sourceKey).sort(), [`node:${a.id}`, `node:${b.id}`].sort());
  assert.equal(baseNodes.find(n => n.kind === 'chart').sourceKey, '');
  const baseEdges = await sql(OWNER, `SELECT * FROM edge WHERE board_id = ${boardId}`);
  assert.deepEqual(baseEdges.map(e => e.relation).sort(), baseEdges.map(e => `edge:${e.id}`).sort());
  const branchNodes = await sql(OWNER, `SELECT * FROM node WHERE board_id = ${v.boardId}`);
  assert.deepEqual(branchNodes.map(n => n.sourceKey).sort(), baseNodes.map(n => n.sourceKey).sort());
  assert.equal((await sql(OWNER, `SELECT * FROM node_icon WHERE board_id = ${v.boardId}`)).length, 1);
  assert.equal((await sql(OWNER, `SELECT * FROM chart WHERE board_id = ${v.boardId}`)).length, 1);
  assert.equal((await sql(user.token, `SELECT * FROM visible_architecture_version WHERE board_id = ${v.boardId}`))[0].sha, '');
  await ok(user.token, 'submit_architecture_proposal', [v.boardId]);
  await rejects(user.token, 'create_architecture_proposal', [v.boardId, named('b2'), named('b2')], 'not another branch');
  await rejects(user.token, 'delete_board', [boardId], 'open branches');
  await ok(user.token, 'set_node_icon', [branchNodes.find(n => n.label === 'B').id, 'aws']);
  await ok(user.token, 'create_chart', [v.boardId, 'Errors', '', 0, 400, 320, 200, 'bars', 'route,p50\n/a,1', NONE, { some: 'agent: bench' }]);
});
test('a fork keeps importer keys and a second fork does not rekey', async () => {
  const user = await mint(), h = await history(user, 'keep'), base = await publish(h);
  const before = (await nodes(base)).map(n => n.sourceKey).sort();
  await ok(user.token, 'create_architecture_proposal', [base.boardId, named('k1'), named('k1')]);
  assert.deepEqual((await nodes(base)).map(n => n.sourceKey).sort(), before);
});

async function branchOf(user, boardId, name) {
  await ok(user.token, 'create_architecture_proposal', [boardId, named(name), named(name)]);
  return (await sql(OWNER, `SELECT * FROM architecture_version WHERE base_board_id = ${boardId}`)).find(v => v.requestKey === named(name));
}
async function review(user, v) { await ok(user.token, 'submit_architecture_proposal', [v.boardId]); await ok(user.token, 'review_architecture_proposal', [v.boardId, 'accept']); }
const labelOnly = label => [{ some: label }, ...Array(8).fill(NONE)];
test('merge applies branch adds, removes and changes; keeps base work since the fork; rewrites empty evidence', async () => {
  const user = await mint(), boardId = await plainBoard(user, 'merge');
  for (const l of ['A', 'B', 'C']) await ok(user.token, 'create_node', nodeArgs(boardId, l));
  const [a, b] = await sql(OWNER, `SELECT * FROM node WHERE board_id = ${boardId}`);
  await ok(user.token, 'create_edge', [boardId, a.id, b.id, 'reads', 'human:me', NONE, NONE, NONE]);
  const v = await branchOf(user, boardId, 'm1');
  const bn = await sql(OWNER, `SELECT * FROM node WHERE board_id = ${v.boardId}`);
  const bc = bn.find(n => n.label === 'C'), bb = bn.find(n => n.label === 'B');
  await ok(user.token, 'delete_node', [bc.id]);
  await ok(user.token, 'update_node', [bb.id, ...labelOnly('B2')]);
  await ok(user.token, 'create_node', nodeArgs(v.boardId, 'D'));
  const d = (await sql(OWNER, `SELECT * FROM node WHERE board_id = ${v.boardId} AND label = 'D'`))[0];
  await ok(user.token, 'create_edge', [v.boardId, bb.id, d.id, 'enqueues', '', NONE, NONE, NONE]);
  await ok(user.token, 'create_node', nodeArgs(boardId, 'E'));
  const v2 = await branchOf(user, boardId, 'm2');
  await review(user, v);
  await rejects(user.token, 'merge_architecture_proposal', [v2.boardId], 'accepted branch');
  await ok(user.token, 'merge_architecture_proposal', [v.boardId]);
  const after = await sql(OWNER, `SELECT * FROM node WHERE board_id = ${boardId}`);
  assert.deepEqual(after.map(n => n.label).sort(), ['A', 'B2', 'D', 'E']);
  assert.ok(after.every(n => n.sourceKey.startsWith('node:')), JSON.stringify(after.map(n => n.sourceKey)));
  const edgesAfter = await sql(OWNER, `SELECT * FROM edge WHERE board_id = ${boardId}`);
  assert.deepEqual(edgesAfter.map(e => e.label).sort(), ['enqueues', 'reads']);
  assert.ok(edgesAfter.find(e => e.label === 'enqueues').evidence.startsWith('human:'));
  const merged = await version(v);
  assert.equal(merged.status, 'implemented'); assert.equal(merged.implementedBoardId, boardId);
  await rejects(user.token, 'create_node', nodeArgs(v.boardId, 'F'), 'merged branch');
  await ok(user.token, 'delete_board', [v.boardId]);
});
test('merge refuses a fact base and an agent caller', async () => {
  const user = await mint(), agent = await mint(), h = await history(user, 'factmerge'), base = await publish(h);
  const p = await proposal(user, base, 'fm'); await review(user, p);
  await rejects(user.token, 'merge_architecture_proposal', [p.boardId], 'newer import');
  const boardId = await plainBoard(user, 'agentmerge'), code = `merge-${RUN}`.padEnd(32, 'a');
  await ok(agent.token, 'join_board', ['Agent', 'agent']);
  await ok(agent.token, 'offer_agent_link', [code]); await ok(user.token, 'redeem_agent_link', [code]);
  await ok(user.token, 'grant_agent_board', [boardId, { __identity__: `0x${agent.identity}` }]);
  const v = await branchOf(agent, boardId, 'am');
  await ok(agent.token, 'submit_architecture_proposal', [v.boardId]); await ok(user.token, 'review_architecture_proposal', [v.boardId, 'accept']);
  await rejects(agent.token, 'merge_architecture_proposal', [v.boardId], 'human owner');
  await ok(user.token, 'merge_architecture_proposal', [v.boardId]);
});

test('merge carries cited files, rewrites relations, and cascades base edges of a node deleted on the branch', async () => {
  const user = await mint(), boardId = await plainBoard(user, 'cite');
  for (const l of ['A', 'B', 'C']) await ok(user.token, 'create_node', nodeArgs(boardId, l));
  const [, b, c] = await sql(OWNER, `SELECT * FROM node WHERE board_id = ${boardId}`);
  await ok(user.token, 'create_edge', [boardId, b.id, c.id, 'reads', 'human:me', NONE, NONE, NONE]);
  const v = await branchOf(user, boardId, 'c1');
  const bn = await sql(OWNER, `SELECT * FROM node WHERE board_id = ${v.boardId}`);
  const ba = bn.find(n => n.label === 'A'), bb = bn.find(n => n.label === 'B'), bc = bn.find(n => n.label === 'C');
  await ok(user.token, 'add_repo_files', [v.boardId, ['src/a.ts']]);
  await ok(user.token, 'create_edge', [v.boardId, ba.id, bb.id, 'calls', 'source:src/a.ts:3', NONE, NONE, NONE]);
  await ok(user.token, 'delete_node', [bc.id]);
  await review(user, v);
  await ok(user.token, 'merge_architecture_proposal', [v.boardId]);
  const baseEdges = await sql(OWNER, `SELECT * FROM edge WHERE board_id = ${boardId}`);
  assert.deepEqual(baseEdges.map(e => e.label), ['calls']);
  assert.ok(baseEdges[0].relation.startsWith('edge:'), baseEdges[0].relation);
  assert.ok((await sql(OWNER, `SELECT * FROM repo_file WHERE board_id = ${boardId}`)).some(f => f.path === 'src/a.ts'));
  const v2 = await branchOf(user, boardId, 'c2');
  await ok(user.token, 'submit_architecture_proposal', [v2.boardId]);
  assert.equal((await version(v2)).status, 'submitted');
});
test('label and doc edits on an accepted branch of a plain board return it to draft', async () => {
  const user = await mint(), boardId = await plainBoard(user, 'content');
  await ok(user.token, 'create_node', nodeArgs(boardId, 'A'));
  const v = await branchOf(user, boardId, 'ct1');
  const [a] = await sql(OWNER, `SELECT * FROM node WHERE board_id = ${v.boardId}`);
  await review(user, v);
  await ok(user.token, 'update_node', [a.id, ...labelOnly('A2')]);
  assert.equal((await version(v)).status, 'draft');
  await review(user, v);
  await ok(user.token, 'set_node_doc', [a.id, 'why']);
  assert.equal((await version(v)).status, 'draft');
});
test('a branch of a snapshot keeps its commit on the wire; a branch of a plain board hides its fork record', async () => {
  const user = await mint(), h = await history(user, 'wire'), base = await publish(h), p = await proposal(user, base, 'wire-p');
  assert.equal((await sql(user.token, `SELECT * FROM visible_architecture_version WHERE board_id = ${p.boardId}`))[0].sha, SHA);
  const boardId = await plainBoard(user, 'wire-plain'), v = await branchOf(user, boardId, 'wire-b');
  assert.equal((await sql(user.token, `SELECT * FROM visible_architecture_version WHERE board_id = ${v.boardId}`))[0].sha, '');
});

const focalArgs = (boardId, label) => [boardId, label, '', 0, 0, 160, 80, 'ink', true, ...Array(7).fill(NONE)];
test('merge needs the current owner of the base, not the owner the branch remembers', async () => {
  const user = await mint(), next = await mint(), boardId = await plainBoard(user, 'handoff');
  await ok(user.token, 'create_node', nodeArgs(boardId, 'A'));
  const v = await branchOf(user, boardId, 'h1'); await review(user, v);
  await sql(OWNER, `UPDATE board_grant SET grantee = 0x${next.identity} WHERE board_id = ${boardId} AND role = 'owner'`);
  await rejects(user.token, 'merge_architecture_proposal', [v.boardId], 'owner');
  assert.deepEqual((await sql(OWNER, `SELECT * FROM node WHERE board_id = ${boardId}`)).map(n => n.label), ['A']);
});
test('merge carries evidence status with evidence, caps focal nodes at two, and drops icons a new kind cannot show', async () => {
  const user = await mint(), boardId = await plainBoard(user, 'carry');
  await ok(user.token, 'set_code_consent', [true]); // the merge carries a cited line (RC-690)
  await ok(user.token, 'create_node', nodeArgs(boardId, 'A')); await ok(user.token, 'create_node', nodeArgs(boardId, 'B'));
  const [a, b] = await sql(OWNER, `SELECT * FROM node WHERE board_id = ${boardId}`);
  await ok(user.token, 'add_repo_files', [boardId, ['src/a.ts']]);
  await ok(user.token, 'create_edge', [boardId, a.id, b.id, 'reads', 'source:src/a.ts:3', NONE, { some: 'const x = 1' }, { some: 'ok' }]);
  await ok(user.token, 'set_node_icon', [a.id, 'aws']);
  const v = await branchOf(user, boardId, 'carry1');
  const bn = await sql(OWNER, `SELECT * FROM node WHERE board_id = ${v.boardId}`), ba = bn.find(n => n.label === 'A');
  const [be] = await sql(OWNER, `SELECT * FROM edge WHERE board_id = ${v.boardId}`);
  await ok(user.token, 'update_edge_evidence', [be.id, 'source:src/a.ts:3', 'stale']); // status-only change
  await ok(user.token, 'update_node', [ba.id, NONE, NONE, NONE, NONE, { some: 'note' }, NONE, NONE, NONE, NONE]);
  await ok(user.token, 'create_node', focalArgs(v.boardId, 'F3'));
  await ok(user.token, 'create_node', focalArgs(boardId, 'F1')); await ok(user.token, 'create_node', focalArgs(boardId, 'F2'));
  await review(user, v);
  // the base filled its two focal slots while the branch was open: the owner demotes one before merging
  await rejects(user.token, 'merge_architecture_proposal', [v.boardId], 'focal limit');
  const f1 = (await sql(OWNER, `SELECT * FROM node WHERE board_id = ${boardId} AND label = 'F1'`))[0];
  await ok(user.token, 'update_node', [f1.id, NONE, NONE, NONE, { some: false }, NONE, NONE, NONE, NONE, NONE]);
  await ok(user.token, 'merge_architecture_proposal', [v.boardId]);
  const [edge] = await sql(OWNER, `SELECT * FROM edge WHERE board_id = ${boardId}`);
  assert.equal(edge.evidence, 'source:src/a.ts:3'); assert.equal(edge.evidenceStatus, 'stale');
  const after = await sql(OWNER, `SELECT * FROM node WHERE board_id = ${boardId}`);
  assert.equal(after.filter(n => n.focal).length, 2);
  assert.equal(after.find(n => n.label === 'F3').focal, true);
  assert.equal(after.find(n => n.label === 'A').kind, 'note');
  assert.deepEqual(await sql(OWNER, `SELECT * FROM node_icon WHERE board_id = ${boardId}`), []);
});

test('facts reject semantics; proposals copy presentation, files and references atomically', async () => {
  const user = await mint(), stranger = await mint(), h = await history(user, 'copy'), v = await publish(h), [a] = await nodes(v), [e] = await edges(v);
  await ok(user.token, 'set_code_consent', [true]); // the proposal copies a code ref's snippet (RC-690)
  await rejects(user.token, 'create_node', nodeArgs(v.boardId, 'fact-added'), 'factual snapshots');
  await rejects(user.token, 'delete_node', [a.id], 'factual snapshots');
  await rejects(user.token, 'delete_edge', [e.id], 'factual snapshots');
  const b = (await nodes(v)).find(n => n.id !== a.id);
  await rejects(user.token, 'create_edge', [v.boardId, a.id, b.id, 'fact edge', 'import', NONE, NONE, NONE], 'factual snapshots');
  await rejects(user.token, 'update_edge_evidence', [e.id, 'source:a.ts:1', 'stale'], 'factual snapshots');
  await rejects(user.token, 'update_node', [a.id, NONE, NONE, NONE, NONE, { some: 'datastore' }, ...Array(4).fill(NONE)], 'factual snapshots');
  await ok(user.token, 'move_node', [a.id, 40, 80]);
  await ok(user.token, 'set_node_hidden', [a.id, true, { some: 'vendor' }]);
  await ok(user.token, 'update_node', [a.id, { some: 'Renamed' }, ...Array(8).fill(NONE)]);
  await ok(user.token, 'add_code_ref', [v.boardId, 'node', a.id, 'a.ts', 'a', 1, 1, SHA, 'const a = 1', 'human']);
  await rejects(stranger.token, 'create_architecture_proposal', [v.boardId, named('bad-copy'), named('bad-copy')], 'owner');
  const p = await proposal(user, v, 'copy-proposal');
  await ok(user.token, 'create_architecture_proposal', [v.boardId, named('copy-proposal'), named('copy-proposal')]);
  const copied = (await nodes(p)).find(n => n.sourceKey === 'a');
  await rejects(stranger.token, 'create_node', nodeArgs(p.boardId, 'stranger'), 'not authorized');
  await rejects(stranger.token, 'delete_node', [copied.id], 'not authorized');
  await rejects(stranger.token, 'set_architecture_node_key', [copied.id, copied.sourceKey], 'not authorized');
  const copiedEdge = (await edges(p))[0];
  await rejects(stranger.token, 'set_architecture_edge_relation', [copiedEdge.id, copiedEdge.relation], 'not authorized');
  await rejects(stranger.token, 'delete_edge', [copiedEdge.id], 'not authorized');
  assert.deepEqual([copied.x, copied.y, copied.label, copied.hidden], [40, 80, 'Renamed', true]);
  assert.equal((await sql(OWNER, `SELECT * FROM repo_file WHERE board_id = ${p.boardId}`)).length, 1);
  const ref = (await sql(OWNER, `SELECT * FROM code_ref WHERE board_id = ${p.boardId}`))[0]; assert.equal(ref.targetId, copied.id);
  const set = (await sql(OWNER, `SELECT * FROM hide_set WHERE board_id = ${p.boardId}`))[0];
  assert.equal((await sql(OWNER, `SELECT * FROM hide_set_member WHERE set_id = ${set.id}`))[0].targetId, copied.id);
});

test('review guards ownership and human decisions; edits invalidate acceptance; reconciliation permits unrelated changes', async () => {
  const user = await mint(), stranger = await mint(), h = await history(user, 'review'), base = await publish(h), p = await proposal(user, base, 'intent');
  const [a] = await nodes(p), [e] = await edges(p);
  await ok(user.token, 'delete_edge', [e.id]);
  await ok(user.token, 'update_node', [a.id, NONE, NONE, NONE, NONE, { some: 'datastore' }, ...Array(4).fill(NONE)]);
  await rejects(stranger.token, 'submit_architecture_proposal', [p.boardId], 'owner');
  await ok(user.token, 'submit_architecture_proposal', [p.boardId]);
  await ok(user.token, 'join_board', ['Agent', 'agent']);
  await rejects(user.token, 'review_architecture_proposal', [p.boardId, 'accept'], 'human');
  await ok(user.token, 'join_board', ['Human', 'human']);
  await ok(user.token, 'review_architecture_proposal', [p.boardId, 'accept']);
  const accepted = await version(p); assert.equal(accepted.status, 'accepted'); assert.ok(accepted.reviewedSignature);
  await ok(user.token, 'move_node', [a.id, 20, 24]); assert.equal((await version(p)).status, 'accepted');
  await ok(user.token, 'update_node', [a.id, { some: 'Presentation only' }, ...Array(8).fill(NONE)]); assert.equal((await version(p)).reviewedSignature, accepted.reviewedSignature);
  const reality = await publish(h, 1, graph([node('a', 'datastore'), node('b'), node('unrelated')], [edge('b', 'unrelated')]));
  await ok(user.token, 'reconcile_architecture_proposal', [p.boardId, reality.boardId]);
  assert.equal((await version(p)).status, 'implemented'); assert.equal((await version(p)).implementedBoardId, reality.boardId);
  await ok(user.token, 'create_node', nodeArgs(p.boardId, 'proposed-new'));
  const fresh = (await nodes(p)).find(n => n.label === 'proposed-new'); assert.match(fresh.sourceKey, /^proposal:/); assert.equal((await version(p)).status, 'draft');
  await ok(user.token, 'create_edge', [p.boardId, a.id, fresh.id, 'proposed', '', NONE, NONE, NONE]);
  // A second edge over the same endpoints would share the 'imports' identity and
  // only surface at submission as "duplicate graph edge".
  await rejects(user.token, 'create_edge', [p.boardId, a.id, fresh.id, 'duplicate', '', NONE, NONE, NONE], 'already exists for these endpoints');
  const added = (await edges(p))[0]; assert.equal(added.relation, 'imports'); await ok(user.token, 'set_architecture_edge_relation', [added.id, 'import']);
  await ok(user.token, 'create_edge', [p.boardId, a.id, fresh.id, 'now distinct', '', NONE, NONE, NONE]);
  await ok(user.token, 'delete_edge', [(await edges(p)).find(e => e.label === 'now distinct').id]);
  await ok(user.token, 'set_architecture_node_key', [fresh.id, 'new-source']);
  await ok(user.token, 'submit_architecture_proposal', [p.boardId]); await ok(user.token, 'review_architecture_proposal', [p.boardId, 'accept']);
  const final = await publish(h, 2, graph([node('a', 'datastore'), node('b'), node('new-source')], [edge('a', 'new-source')]));
  await ok(user.token, 'reconcile_architecture_proposal', [p.boardId, final.boardId]); assert.equal((await version(p)).status, 'implemented');
});

test('a reviewed no-op requires a fresh commit and source-key edits reset review', async () => {
  const user = await mint(), name = named('fresh-commit');
  await ok(user.token, 'create_architecture_history', [name, 'https://github.com/example/repo', JSON.stringify([{ ref: 'main', sha: SHA }, { ref: 'next', sha: SHA }, { ref: 'future', sha: SHA3 }]), name]);
  const h = (await sql(user.token, 'SELECT * FROM my_architecture_histories')).find(r => r.requestKey === name), base = await publish(h), p = await proposal(user, base, 'no-op');
  await ok(user.token, 'submit_architecture_proposal', [p.boardId]); await ok(user.token, 'review_architecture_proposal', [p.boardId, 'accept']);
  await rejects(user.token, 'reconcile_architecture_proposal', [p.boardId, base.boardId], 'newer commit');
  await ok(svc.token, 'publish_architecture_snapshot', [h.id, 1, 'next', SHA, JSON.stringify(graph())]);
  const same = (await sql(OWNER, `SELECT * FROM architecture_version WHERE history_id = ${h.id}`)).find(v => v.assertionMode === 'fact' && v.index === 1);
  await rejects(user.token, 'reconcile_architecture_proposal', [p.boardId, same.boardId], 'newer commit');
  assert.equal((await version(p)).status, 'accepted');
  const fresh = await publish(h, 2); await ok(user.token, 'reconcile_architecture_proposal', [p.boardId, fresh.boardId]);
  const [a] = await nodes(p); await ok(user.token, 'set_architecture_node_key', [a.id, 'explicit-source']);
  const reset = await version(p); assert.equal(reset.status, 'draft'); assert.equal(reset.reviewedSignature, ''); assert.equal(reset.implementedBoardId, 0);
});

test('new package keys append layout slots while known and absent keys keep positions', async () => {
  const user = await mint(), h = await history(user, 'layout'), first = await publish(h), positions = new Map((await nodes(first)).map(n => [n.sourceKey, [n.x, n.y]]));
  const second = await publish(h, 1, graph([node('0'), node('a'), node('b')], []));
  for (const n of await nodes(second)) if (positions.has(n.sourceKey)) assert.deepEqual([n.x, n.y], positions.get(n.sourceKey));
  assert.deepEqual((await nodes(second)).filter(n => n.sourceKey === '0').map(n => [n.x, n.y]), [[448, 0]]);
  const third = await publish(h, 2, graph([node('b'), node('c')], []));
  assert.deepEqual((await nodes(third)).filter(n => n.sourceKey === 'b').map(n => [n.x, n.y]), [positions.get('b')]);
  assert.deepEqual((await nodes(third)).filter(n => n.sourceKey === 'c').map(n => [n.x, n.y]), [[672, 0]]);
});

test('completed history stays ready after delayed failure and retry status callbacks', async () => {
  const user = await mint(), h = await history(user, 'durable-ready');
  await publish(h, 0); await publish(h, 1); await publish(h, 2);
  for (const status of ['failed', 'partial', 'running', 'queued']) {
    await ok(svc.token, 'set_architecture_import_status', [h.id, status, 'delayed callback']);
    const updated = (await sql(user.token, 'SELECT * FROM my_architecture_histories')).find(r => r.id === h.id);
    assert.deepEqual([updated.status, updated.error], ['ready', '']);
  }
});

test('a linked agent drafts and submits proposals owned and reviewed by its human', async () => {
  const human = await mint(), agent = await mint(), stranger = await mint(), h = await history(human, 'agent-proposal'), base = await publish(h), code = `architecture-${RUN}`.padEnd(32, 'a');
  await ok(agent.token, 'join_board', ['Agent', 'agent']);
  await ok(agent.token, 'offer_agent_link', [code]); await ok(human.token, 'redeem_agent_link', [code]);
  assert.equal((await sql(agent.token, `SELECT * FROM visible_architecture_history WHERE id = ${h.id}`)).length, 0);
  await rejects(agent.token, 'create_architecture_proposal', [base.boardId, named('no-grant'), named('no-grant')], 'shared this board');
  await ok(human.token, 'grant_agent_board', [base.boardId, { __identity__: `0x${agent.identity}` }]);
  assert.equal((await sql(agent.token, `SELECT * FROM visible_architecture_history WHERE id = ${h.id}`)).length, 1);
  const p = await proposal(agent, base, 'agent-intent'), [a, b] = await nodes(p);
  assert.equal((await sql(human.token, 'SELECT * FROM my_boards')).find(r => r.boardId === p.boardId)?.access, 'owner');
  assert.equal((await sql(agent.token, 'SELECT * FROM my_boards')).find(r => r.boardId === p.boardId)?.access, 'grant');
  await ok(agent.token, 'create_node', nodeArgs(p.boardId, 'agent-added'));
  const added = (await nodes(p)).find(n => n.label === 'agent-added');
  await ok(agent.token, 'set_architecture_node_key', [added.id, 'agent-source']);
  await ok(agent.token, 'create_edge', [p.boardId, b.id, added.id, '', '', NONE, NONE, NONE]);
  const newEdge = (await edges(p)).find(e => e.toNode === added.id);
  await ok(agent.token, 'set_architecture_edge_relation', [newEdge.id, 'custom']);
  await ok(agent.token, 'delete_edge', [newEdge.id]);
  await ok(agent.token, 'delete_node', [a.id]);
  await rejects(stranger.token, 'create_node', nodeArgs(p.boardId, 'stranger'), 'not authorized');
  await ok(agent.token, 'submit_architecture_proposal', [p.boardId]);
  await rejects(agent.token, 'review_architecture_proposal', [p.boardId, 'accept'], 'owner');
  await ok(human.token, 'review_architecture_proposal', [p.boardId, 'accept']);
  await ok(agent.token, 'set_architecture_node_key', [added.id, 'agent-source-updated']);
  assert.equal((await version(p)).status, 'draft');
  await ok(agent.token, 'join_board', ['Pretending human', 'human']);
  const ownHistory = await history(agent, 'linked-owned-history'), ownBase = await publish(ownHistory), ownProposal = await proposal(agent, ownBase, 'linked-owned-proposal');
  await ok(agent.token, 'submit_architecture_proposal', [ownProposal.boardId]);
  await rejects(agent.token, 'review_architecture_proposal', [ownProposal.boardId, 'accept'], 'human');
  await ok(human.token, 'unlink_agent', [{ __identity__: `0x${agent.identity}` }]);
  await rejects(agent.token, 'delete_node', [added.id], 'not authorized');
});

test('accepted intent can reconcile a later import history of the same canonical repository', async () => {
  const user = await mint();
  async function oneRef(name, repository, sha) {
    const key = named(name);
    await ok(user.token, 'create_architecture_history', [key, repository, JSON.stringify([{ ref: 'main', sha }]), key]);
    return (await sql(user.token, 'SELECT * FROM my_architecture_histories')).find(h => h.requestKey === key);
  }
  const stale = await oneRef('cross-history-stale', 'https://github.com/example/repo', SHA3);
  await ok(svc.token, 'publish_architecture_snapshot', [stale.id, 0, 'main', SHA3, JSON.stringify(graph(undefined, []))]);
  const staleVersion = (await sql(OWNER, `SELECT * FROM architecture_version WHERE history_id = ${stale.id}`))[0];
  const original = await oneRef('cross-history-base', 'https://github.com/example/repo', SHA), base = await publish(original), p = await proposal(user, base, 'cross-history-intent');
  await ok(user.token, 'delete_edge', [(await edges(p))[0].id]);
  await ok(user.token, 'submit_architecture_proposal', [p.boardId]); await ok(user.token, 'review_architecture_proposal', [p.boardId, 'accept']);
  await rejects(user.token, 'reconcile_architecture_proposal', [p.boardId, staleVersion.boardId], 'newer commit');
  const unrelated = await oneRef('cross-history-unrelated', 'https://github.com/example/other', SHA3);
  await ok(svc.token, 'publish_architecture_snapshot', [unrelated.id, 0, 'main', SHA3, JSON.stringify(graph(undefined, []))]);
  const otherVersion = (await sql(OWNER, `SELECT * FROM architecture_version WHERE history_id = ${unrelated.id}`))[0];
  await rejects(user.token, 'reconcile_architecture_proposal', [p.boardId, otherVersion.boardId], 'same repository');
  const later = await oneRef('cross-history-later', 'https://github.com/EXAMPLE/Repo.git/', SHA2);
  await ok(svc.token, 'publish_architecture_snapshot', [later.id, 0, 'main', SHA2, JSON.stringify(graph([node('a'), node('b'), node('unrelated')], []))]);
  const latest = (await sql(OWNER, `SELECT * FROM architecture_version WHERE history_id = ${later.id}`))[0];
  await ok(user.token, 'reconcile_architecture_proposal', [p.boardId, latest.boardId]);
  assert.equal((await version(p)).implementedBoardId, latest.boardId);
});

test('reconciliation ranks candidates by history creation, the only order the canvas can see', async () => {
  const user = await mint();
  async function oneRef(name, sha) {
    const key = named(name);
    await ok(user.token, 'create_architecture_history', [key, 'https://github.com/example/repo', JSON.stringify([{ ref: 'main', sha }]), key]);
    return (await sql(user.token, 'SELECT * FROM my_architecture_histories')).find(h => h.requestKey === key);
  }
  const base = await oneRef('rank-base', SHA), later = await oneRef('rank-later', SHA2);
  // The later history publishes FIRST, so its snapshot board is the older row.
  // board_stats is private, so the rail ranks on history creation and would
  // offer this snapshot; ordering the reducer on board age refused it.
  await ok(svc.token, 'publish_architecture_snapshot', [later.id, 0, 'main', SHA2, JSON.stringify(graph([node('a'), node('b'), node('extra')], []))]);
  await ok(svc.token, 'publish_architecture_snapshot', [base.id, 0, 'main', SHA, JSON.stringify(graph())]);
  const baseVersion = (await sql(OWNER, `SELECT * FROM architecture_version WHERE history_id = ${base.id}`))[0];
  const laterVersion = (await sql(OWNER, `SELECT * FROM architecture_version WHERE history_id = ${later.id}`))[0];
  const p = await proposal(user, baseVersion, 'rank-intent');
  await ok(user.token, 'delete_edge', [(await edges(p))[0].id]);
  await ok(user.token, 'submit_architecture_proposal', [p.boardId]);
  await ok(user.token, 'review_architecture_proposal', [p.boardId, 'accept']);
  await ok(user.token, 'reconcile_architecture_proposal', [p.boardId, laterVersion.boardId]);
  assert.equal((await version(p)).implementedBoardId, laterVersion.boardId);
});

test('shared curation retains absent source keys and named hides for future snapshots', async () => {
  const user = await mint(), h = await history(user, 'curation'), first = await publish(h), [a] = await nodes(first);
  await ok(user.token, 'move_node', [a.id, 120, 240]); await ok(user.token, 'set_node_hidden', [a.id, true, { some: 'vendor' }]);
  await ok(user.token, 'propagate_architecture_curation', [first.boardId]);
  const missing = await publish(h, 1, graph([node('b')], []));
  await ok(user.token, 'propagate_architecture_curation', [missing.boardId]);
  const future = await publish(h, 2), restored = (await nodes(future)).find(n => n.sourceKey === 'a');
  assert.deepEqual([restored.x, restored.y, restored.hidden], [120, 240, true]);
  const set = (await sql(OWNER, `SELECT * FROM hide_set WHERE board_id = ${future.boardId}`)).find(s => s.name === 'vendor');
  assert.ok(set); assert.equal((await sql(OWNER, `SELECT * FROM hide_set_member WHERE set_id = ${set.id}`)).some(m => m.targetId === restored.id && m.targetKind === 'node'), true);
});

test("a proposal and shared curation carry an edge's colour, line and weight (RC-688)", async () => {
  const user = await mint(), h = await history(user, 'edge-style'), first = await publish(h), [e] = await edges(first);
  const weightOf = async id => (await sql(OWNER, `SELECT * FROM edge_weight WHERE edge_id = ${id}`))[0]?.weight ?? 'regular';
  const style = async row => [row.color, row.strokeStyle, await weightOf(row.id)];
  // style is presentation: allowed on a fact snapshot
  await ok(user.token, 'update_edge_style', [e.id, { some: 'blue' }, { some: 'dotted' }]);
  await ok(user.token, 'set_edge_weight', [e.id, 'bold']);
  const p = await proposal(user, first, 'edge-style-proposal');
  assert.deepEqual(await style((await edges(p))[0]), ['blue', 'dotted', 'bold']);
  await ok(user.token, 'propagate_architecture_curation', [first.boardId]);
  const later = await publish(h, 1), [carried] = await edges(later);
  assert.deepEqual(await style(carried), ['blue', 'dotted', 'bold']);
  // back to regular travels the same way, to every snapshot in the history
  await ok(user.token, 'set_edge_weight', [carried.id, 'regular']);
  await ok(user.token, 'propagate_architecture_curation', [later.boardId]);
  assert.equal(await weightOf(e.id), 'regular');
});

test('curation normalizes merged focal choices to two and keeps documentation local', async () => {
  const user = await mint(), h = await history(user, 'focal-view'), first = await publish(h), a = (await nodes(first)).find(n => n.sourceKey === 'a');
  await ok(user.token, 'update_node', [a.id, NONE, NONE, NONE, { some: true }, ...Array(5).fill(NONE)]);
  await ok(user.token, 'set_node_doc', [a.id, 'Snapshot-specific documentation']);
  await ok(user.token, 'propagate_architecture_curation', [first.boardId]);
  const missing = await publish(h, 1, graph([node('b'), node('c'), node('d')], []));
  for (const n of (await nodes(missing)).filter(n => n.sourceKey === 'c' || n.sourceKey === 'd')) await ok(user.token, 'update_node', [n.id, NONE, NONE, NONE, { some: true }, ...Array(5).fill(NONE)]);
  await ok(user.token, 'propagate_architecture_curation', [missing.boardId]);
  const future = await publish(h, 2, graph([node('a'), node('b'), node('c'), node('d')], [])), rows = await nodes(future);
  assert.deepEqual(rows.filter(n => n.focal).map(n => n.sourceKey).sort(), ['a', 'c']);
  assert.equal(rows.find(n => n.sourceKey === 'a').doc, '');
});

test('a proposal deletes with its board while a fact snapshot stays with its history', async () => {
  const user = await mint(), stranger = await mint(), h = await history(user, 'delete-proposal'), base = await publish(h), p = await proposal(user, base, 'doomed');
  await rejects(stranger.token, 'delete_board', [p.boardId], 'owner');
  await ok(user.token, 'delete_board', [p.boardId]);
  assert.equal(await version(p), undefined);
  assert.deepEqual(await sql(OWNER, `SELECT * FROM board WHERE id = ${p.boardId}`), []);
  assert.deepEqual(await nodes(p), []);
  await rejects(user.token, 'delete_board', [base.boardId], 'managed through their history');
  assert.equal((await version(base)).assertionMode, 'fact');
});

test('a fact snapshot cannot be shared by link', async () => {
  const user = await mint(), h = await history(user, 'link-share');
  const v = await publish(h);
  await rejects(user.token, 'set_link_share', [v.boardId, 'view', '0123456789abcdef0123456789abcdef'], 'managed through their history');
});
