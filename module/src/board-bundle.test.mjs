import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// board-bundle.ts imports './sha256' without an extension, as the module bundler resolves it.
registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); } catch (e) { if (specifier.startsWith('.')) return next(`${specifier}.ts`, context); throw e; }
} });
const { BUNDLE_VERSION, MAX_BUNDLE_BYTES, SECTIONS, bundleText, captureBoard, parseBundle, restoreBoard } = await import('./board-bundle.ts');
const { sha256Hex } = await import('./sha256.ts');

// A stand-in for ctx.db: every column is an index, ids auto-increment per table.
function fakeDb() {
  const tables = {};
  const table = () => {
    const rows = [];
    let seq = 100n;
    const eq = (a, b) => a === b || (a?.toHexString && a.toHexString() === b?.toHexString?.());
    const api = { rows, insert(r) { const row = 'id' in r && r.id === 0n ? { ...r, id: ++seq } : { ...r }; rows.push(row); return row; } };
    return new Proxy(api, { get: (o, k) => (k in o ? o[k] : { filter: v => rows.filter(r => eq(r[k], v)), find: v => rows.find(r => eq(r[k], v)) }) });
  };
  return new Proxy(tables, { get: (o, k) => (o[k] ??= table()) });
}
const time = m => ({ microsSinceUnixEpoch: m });
const who = hex => ({ toHexString: () => hex });
const ALICE = 'a'.repeat(64);
const conv = { time, identity: who };

// One board with a row in every section, including hidden, charted, cited and dangling-history content.
function seed(db, boardId = 7n) {
  db.board.insert({ id: boardId, name: 'Payments', slug: 'old-slug' });
  const node = (id, extra = {}) => db.node.insert({ id, boardId, label: `n${id}`, sublabel: '', x: 0, y: 0, w: 176, h: 80, token: 'ink', focal: false, doc: 'doc', hidden: false, imported: false, kind: 'service', shape: 'rect', color: '', strokeStyle: 'solid', size: 'm', sourceKey: '', ...extra });
  node(1n); node(2n, { hidden: true }); node(3n, { kind: 'chart', w: 224, h: 144 });
  db.edge.insert({ id: 11n, boardId, fromNode: 1n, toNode: 2n, label: 'calls', evidence: 'source:src/a.ts:3', hidden: true, imported: false, color: '', strokeStyle: 'solid', evidenceSnippet: 'secret code', evidenceStatus: 'ok', relation: '', latencyMs: 12.5, latencySource: 'local' });
  db.edgeWeight.insert({ edgeId: 11n, boardId, weight: 'bold' });
  db.edgeEvidenceHash.insert({ edgeId: 11n, boardId, lineHash: 'f'.repeat(32) });
  db.chart.insert({ nodeId: 3n, boardId, type: 'bars', csv: 'a,1', options: '{}', source: 'human:x', updatedAt: time(5n) });
  db.nodeIcon.insert({ nodeId: 1n, boardId, icon: 'database' });
  db.hideSet.insert({ id: 21n, boardId, name: 'vendor', createdBy: 'someone' });
  db.hideSetMember.insert({ id: 22n, setId: 21n, targetKind: 'node', targetId: 2n });
  db.hideSetMember.insert({ id: 23n, setId: 21n, targetKind: 'edge', targetId: 11n });
  db.repoFile.insert({ id: 31n, boardId, path: 'src/a.ts' });
  db.codeRef.insert({ id: 41n, boardId, targetKind: 'node', targetId: 1n, path: 'src/a.ts', symbol: 'pay', startLine: 1, endLine: 4, blobSha: 'b'.repeat(40), snippet: 'secret code', author: 'agent', checkpoint: 2, status: 'ok' });
  db.codeRefHash.insert({ refId: 41n, boardId, lineHashes: 'c'.repeat(32) });
  db.changeNote.insert({ id: 51n, boardId, anchorId: 1n, refId: 41n, kind: 'migration', severity: 'notable', title: 't', summary: 's', steps: '[]', schema: '', subjects: '[]', readers: JSON.stringify([{ refId: '41', subject: 0, status: 'stale', checkpoint: 2 }, { refId: '999', subject: 0, status: 'unknown', checkpoint: 1, removed: true }]), refFileSha: '', author: 'agent', checkpoint: 2, reviewedBy: 'Bo', reviewedAt: time(9n), reviewedSha: '' });
  db.threat.insert({ id: 61n, boardId, anchorId: 1n, stage: 'vulnerable', severity: 'high', title: 'CVE', summary: 's', cvss: '', package: '', fixedIn: '', flags: '[]', source: '', author: 'agent', createdAt: time(3n), containedBy: '', containedAt: time(0n) });
  db.mark.insert({ id: 71n, boardId, nodeId: 999n, nodeLabel: 'gone', note: 'why?', author: who(ALICE), round: 1, preferredAgent: 'b'.repeat(64), claimedBy: 'x/seat', leaseUntil: time(77n), claimGen: 3, status: 'claimed', reply: '', files: '[]', sentAt: time(1n), answeredAt: time(0n) });
  db.routeEvent.insert({ id: 81n, boardId, kind: 'plan', revision: 1, nodeId: 2n, nodeIds: [1n, 999n], reason: '', checkpoint: 1, at: time(4n) });
  db.session.insert({ id: 91n, boardId, repoRoot: '/r', baseSha: 'b', headSha: 'h', checkpoint: 2, coverage: '{}', startedAt: time(1n), updatedAt: time(2n) });
  db.sessionRoute.insert({ boardId, nodeIds: [1n, 2n], currentIndex: 1, revision: 1, currentCheckpoint: 2, updatedAt: time(2n) });
  db.sessionRemote.insert({ boardId, remoteUrl: 'https://github.com/o/r', pushedHead: '', dirtyPaths: ['src/a.ts'] });
  db.tracePlayback.insert({ boardId, spans: JSON.stringify([{ id: 'a', parent: null, node: '1', startMs: 0, durationMs: 5, status: 'ok' }]), source: 'local', title: 't', seq: 1, playedAt: time(6n) });
}

const ctxFor = (db, boardId = 7n) => ({ db, timestamp: time(1000n), sender: who(ALICE), boardId });
const capture = (db, boardId = 7n) => captureBoard(ctxFor(db), boardId, { workspaceId: 3n, architecture: null });

test('a capture covers every section, without code text or live claims', () => {
  const db = fakeDb();
  seed(db);
  const board = capture(db);
  for (const key of Object.keys(SECTIONS)) assert.ok(SECTIONS[key].one ? board[key] : board[key].length > 0, `section ${key} is empty`);
  const text = bundleText(board);
  assert.ok(!text.includes('secret code'), 'code text never enters a bundle');
  assert.equal(board.marks[0].status, 'sent');
  assert.ok(!('claimedBy' in board.marks[0]) && !('preferredAgent' in board.marks[0]));
  assert.equal(board.source.boardId, '7');
  assert.equal(board.source.capturedBy, ALICE);
});

test('capture, parse and restore round-trip every row with consistent new ids', () => {
  const db = fakeDb();
  seed(db);
  const text = bundleText(capture(db));
  restoreBoard(ctxFor(db), parseBundle(text, conv), 500n, time(0n));
  db.board.insert({ id: 500n, name: 'copy' });
  const again = capture(db, 500n);
  const ids = new Map(db.node.boardId.filter(500n).map(n => [n.label, n.id]));
  const n1 = String(ids.get('n1')), n2 = String(ids.get('n2'));
  const e = db.edge.boardId.filter(500n)[0];
  assert.equal(String(e.fromNode), n1);
  assert.equal(String(e.toNode), n2);
  assert.equal(e.evidenceSnippet, '');
  assert.deepEqual(again.hideSetMembers.map(m => m.targetId), [n2, String(e.id)]);
  assert.equal(again.charts[0].nodeId, String(ids.get('n3')));
  assert.equal(again.codeRefs[0].targetId, n1);
  assert.deepEqual(JSON.parse(again.changeNotes[0].readers).map(r => r.refId), [again.codeRefs[0].id, '0']);
  assert.equal(again.marks[0].nodeId, '0', 'a mark on a deleted node never points at another row');
  assert.deepEqual(again.routeEvents[0].nodeIds, [n1, '0']);
  assert.deepEqual(again.sessionRoute.nodeIds, [n1, n2]);
  assert.equal(JSON.parse(again.tracePlayback.spans)[0].node, n1);
  // Everything else is equal once ids are put back.
  const ID = new Set(['id', 'fromNode', 'toNode', 'nodeId', 'edgeId', 'setId', 'targetId', 'refId', 'anchorId', 'node']);
  const strip = v => Array.isArray(v) ? v.map(strip)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k,
      ID.has(k) && typeof x === 'string' ? '#' : k === 'nodeIds' ? x.map(() => '#') : (k === 'readers' || k === 'spans') ? strip(JSON.parse(x)) : strip(x)]))
    : v;
  assert.deepEqual(strip({ ...again, name: '', source: null }), strip({ ...capture(db), name: '', source: null }));
});

test('parseBundle refuses corrupt, unsupported, oversized and inconsistent bundles', () => {
  const db = fakeDb();
  seed(db);
  const board = capture(db);
  const text = bundleText(board);
  const rejects = (t, needle) => assert.throws(() => parseBundle(t), e => e.message.startsWith('bundle rule:') && e.message.includes(needle), needle);
  rejects(text.slice(0, -5), 'not valid JSON');
  rejects(text.replace('"label":"n1"', '"label":"nX"'), 'checksum does not match');
  rejects(text.replace(`"version":${BUNDLE_VERSION}`, '"version":99'), 'format 99');
  rejects(text.replace('draw.board-bundle', 'other'), 'not a board bundle');
  rejects(' '.repeat(MAX_BUNDLE_BYTES + 1), 'at most 16 MiB');
  const resealed = b => bundleText(b);
  rejects(resealed({ ...board, edges: [{ ...board.edges[0], toNode: '4242' }] }), 'points at node 4242');
  rejects(resealed({ ...board, charts: [{ ...board.charts[0], nodeId: board.nodes[0].id }] }), 'as a chart node');
  rejects(resealed({ ...board, nodes: [...board.nodes, board.nodes[0]] }), 'nodes repeats id');
  rejects(resealed({ ...board, nodes: [{ ...board.nodes[0], x: 1.5 }] }), 'board.nodes[0].x must be an integer');
  rejects(resealed({ ...board, nodes: [{ ...board.nodes[0], extra: 1 }] }), 'must have exactly the fields');
  rejects(resealed({ ...board, source: { ...board.source, boardId: 7 } }), 'decimal u64 string');
  rejects(resealed({ ...board, changeNotes: [{ ...board.changeNotes[0], refId: '4242' }] }), 'code ref 4242');
  const { threats, ...missing } = board;
  rejects(resealed(missing), 'board must have exactly the fields');
  // Checksum over the canonical board JSON: a re-encoded but identical board still verifies.
  const pretty = JSON.stringify({ format: 'draw.board-bundle', version: 1, sha256: sha256Hex(JSON.stringify(board)), board }, null, 2);
  assert.equal(parseBundle(pretty).name, 'Payments');
});
