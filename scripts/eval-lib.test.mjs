import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import * as evalLib from './eval-lib.mjs';
// The one symbol rule. eval-session imports it from here too (F18): the eval
// must not keep its own copy. Plain `node` loads this file because resolver.ts
// has no extensionless relative imports (Node 22.18+ strips types by default).
import { symbolNeedle, RESOLVABLE_EXTENSIONS } from '../agent/src/resolver.ts';
// The chart contracts have zero imports, so plain `node` loads them too.
import * as chartContracts from '../module/src/chart-contracts.ts';
import {
  splitNul,
  parseHunks,
  rangeIntersectsHunks,
  parseCoverage,
  reconcile,
  disclosureCovers,
  vacuityReasons,
  disclosureVerdict,
  needleInSnippet,
  isResolvablePath,
  coveredPaths,
  flagValue,
  errorLine,
  reresolveCheck,
} from './eval-lib.mjs';

const DIFF = [
  'diff --git a/client/src/chrome.ts b/client/src/chrome.ts',
  'index 1111111..2222222 100644',
  '--- a/client/src/chrome.ts',
  '+++ b/client/src/chrome.ts',
  '@@ -10,0 +11,3 @@ import { x } from "./x";',
  '+a',
  '+b',
  '+c',
  '@@ -40 +43 @@ function f() {',
  '-old',
  '+new',
  '@@ -60,2 +62,0 @@ function g() {',
  '-gone',
  '-gone2',
].join('\n');

test('splitNul drops the trailing empty element', () => {
  assert.deepEqual(splitNul('a\0b c\0'), ['a', 'b c']);
  assert.deepEqual(splitNul(''), []);
});

test('parseHunks reads new-side ranges, defaults count to 1, drops pure deletions', () => {
  assert.deepEqual(parseHunks(DIFF), [
    { start: 11, end: 13 },
    { start: 43, end: 43 },
  ]);
  assert.deepEqual(parseHunks(''), []);
});

test('rangeIntersectsHunks is inclusive on both ends', () => {
  const hunks = [{ start: 11, end: 13 }];
  assert.equal(rangeIntersectsHunks(1, 10, hunks), false);
  assert.equal(rangeIntersectsHunks(1, 11, hunks), true);
  assert.equal(rangeIntersectsHunks(13, 20, hunks), true);
  assert.equal(rangeIntersectsHunks(14, 20, hunks), false);
  assert.equal(rangeIntersectsHunks(5, 20, [{ start: 1, end: Infinity }]), true);
  assert.equal(rangeIntersectsHunks(5, 20, []), false);
});

// ---- F18: one needle rule, no drifting copies ---------------------------------

// What the module (module/src/index.ts) and the agent (agent/src/resolver.ts)
// return: the last dotted segment, or the whole symbol when it has no dot or
// the last segment is empty.
const NEEDLE_FIXTURES = [
  ['A.b.c', 'c'],
  ['x', 'x'],
  ['', ''],
  ['A.', 'A.'],
  ['.', '.'],
];

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_DIRS = ['module/src', 'agent/src', 'client/src', 'scripts'];
function sourceFiles(dir) {
  const out = [];
  for (const e of readdirSync(join(repoRoot, dir), { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'module_bindings') continue;
    const rel = join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(rel));
    else if (/\.(m?[jt]s)$/.test(e.name) && !/\.test\.m?[jt]s$/.test(e.name)) out.push(rel);
  }
  return out;
}

/** Every `function symbolNeedle` in the repo, as a callable built from its own source text. */
function needleCopies() {
  const copies = [];
  for (const rel of SOURCE_DIRS.flatMap(sourceFiles)) {
    const text = readFileSync(join(repoRoot, rel), 'utf8');
    const at = text.search(/function symbolNeedle\s*\(/);
    if (at === -1) continue;
    let depth = 0;
    let end = text.indexOf('{', at);
    for (; end < text.length; end++) {
      if (text[end] === '{') depth++;
      else if (text[end] === '}' && --depth === 0) break;
    }
    const js = stripTypeScriptTypes(text.slice(at, end + 1));
    copies.push({ rel, fn: new Function(`${js}\nreturn symbolNeedle;`)() });
  }
  return copies;
}

test('symbolNeedle (agent/src/resolver.ts, the copy eval-session imports) matches the fixtures', () => {
  for (const [symbol, needle] of NEEDLE_FIXTURES) assert.equal(symbolNeedle(symbol), needle, `symbolNeedle('${symbol}')`);
  assert.equal(symbolNeedle('Limiter.allow'), 'allow');
});

test('every remaining copy of symbolNeedle in the repo matches the fixtures', () => {
  const copies = needleCopies();
  const found = copies.map(c => c.rel);
  // The module cannot be imported (it needs the SpacetimeDB server runtime), so
  // its copy is pinned here by its own source text; the agent's is the original.
  assert.ok(found.includes('module/src/index.ts'), `module copy not found; copies: ${found.join(', ')}`);
  assert.ok(found.includes('agent/src/resolver.ts'), `agent copy not found; copies: ${found.join(', ')}`);
  for (const { rel, fn } of copies) {
    for (const [symbol, needle] of NEEDLE_FIXTURES) assert.equal(fn(symbol), needle, `${rel}: symbolNeedle('${symbol}')`);
  }
});

test('the eval keeps no symbolNeedle of its own', () => {
  assert.equal('symbolNeedle' in evalLib, false);
  const session = readFileSync(join(repoRoot, 'scripts/eval-session.mjs'), 'utf8');
  assert.match(session, /\{[^}]*\bsymbolNeedle\b[^}]*\}\s*=\s*await import\('\.\.\/agent\/src\/resolver\.ts'\)/);
});

test('needleInSnippet: the needle must be non-empty and occur in the snippet', () => {
  const snippet = '  allow(now: number): boolean {\n    return now > this.until;\n  }';
  assert.equal(needleInSnippet(symbolNeedle('allow'), snippet), true);
  assert.equal(needleInSnippet(symbolNeedle('Limiter.allow'), snippet), true);
  assert.equal(needleInSnippet(symbolNeedle('Limiter.deny'), snippet), false);
  assert.equal(needleInSnippet(symbolNeedle(''), snippet), false);
  // The server accepts 'Limiter.' (needle 'Limiter.') when the snippet spells it.
  assert.equal(needleInSnippet(symbolNeedle('Limiter.'), 'new Limiter.allow()'), true);
});

test('isResolvablePath lowercases the extension, as the agent does', () => {
  assert.equal(isResolvablePath('agent/src/session.ts', RESOLVABLE_EXTENSIONS), true);
  assert.equal(isResolvablePath('Legacy/Main.TS', RESOLVABLE_EXTENSIONS), true);
  assert.equal(isResolvablePath('web/App.JSX', RESOLVABLE_EXTENSIONS), true);
  assert.equal(isResolvablePath('web/src/App.svelte', RESOLVABLE_EXTENSIONS), false);
  assert.equal(isResolvablePath('Makefile', RESOLVABLE_EXTENSIONS), false);
});

test('parseCoverage: malformed -> empty, well-formed -> typed', () => {
  const empty = { changed: 0, uncovered: [], excluded: [], deleted: [] };
  assert.deepEqual(parseCoverage('{}'), empty);
  assert.deepEqual(parseCoverage('not json'), empty);
  assert.deepEqual(parseCoverage('[1,2]'), empty);
  assert.deepEqual(
    parseCoverage('{"changed":2,"uncovered":["a"],"excluded":[{"reason":"r","paths":["b"]}],"deleted":["z"]}'),
    { changed: 2, uncovered: ['a'], excluded: [{ reason: 'r', paths: ['b'] }], deleted: ['z'] }
  );
});

test('reconcile: exact ledger passes', () => {
  const r = reconcile({
    changed: ['a.ts', 'b.ts', 'c.lock', 'd.ts'],
    covered: ['a.ts', 'b.ts'],
    uncovered: ['d.ts'],
    excluded: [{ reason: 'lockfiles', paths: ['c.lock'] }],
  });
  assert.equal(r.ok, true);
  assert.equal(r.total, 4);
  assert.equal(r.ledger, '4 changed = 2 covered + 1 excluded + 1 uncovered');
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.extra, []);
  assert.deepEqual(r.overlap, []);
});

test('reconcile: a changed path in no bucket is missing', () => {
  const r = reconcile({ changed: ['a.ts', 'z.ts'], covered: ['a.ts'], uncovered: [], excluded: [] });
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ['z.ts']);
});

test('reconcile: a bucket path that did not change is extra', () => {
  const r = reconcile({ changed: ['a.ts'], covered: ['a.ts'], uncovered: ['ghost.ts'], excluded: [] });
  assert.equal(r.ok, false);
  assert.deepEqual(r.extra, ['ghost.ts']);
});

test('reconcile: a path in two buckets is overlap', () => {
  const r = reconcile({ changed: ['a.ts'], covered: ['a.ts'], uncovered: ['a.ts'], excluded: [] });
  assert.equal(r.ok, false);
  assert.deepEqual(r.overlap, [{ path: 'a.ts', buckets: ['covered', 'uncovered'] }]);
});

test('reconcile: duplicates inside one bucket count once', () => {
  const r = reconcile({ changed: ['a.ts'], covered: ['a.ts', 'a.ts'], uncovered: [], excluded: [] });
  assert.equal(r.ok, true);
  assert.equal(r.counts.covered, 1);
});

test('disclosureCovers: inclusion, not equality; normalises ./', () => {
  const d = disclosureCovers(['./d.ts', 'c.lock ', 'x.ts'], ['d.ts', 'c.lock']);
  assert.equal(d.ok, true);
  assert.equal(d.named, 2);
  assert.equal(d.total, 2);
  assert.deepEqual(d.extra, ['x.ts']);
  const m = disclosureCovers(['d.ts'], ['d.ts', 'e.ts']);
  assert.equal(m.ok, false);
  assert.deepEqual(m.missing, ['e.ts']);
});

// ---- F6: the evals must not pass on nothing ----------------------------------

test('reconcile is ok on an empty or never-drawn board — why the vacuity guard exists', () => {
  assert.equal(reconcile({ changed: [], covered: [], uncovered: [], excluded: [] }).ok, true);
  assert.equal(reconcile({ changed: ['a', 'b'], covered: [], uncovered: ['a', 'b'], excluded: [] }).ok, true);
});

test('vacuityReasons: a never-checkpointed board is vacuous', () => {
  const r = vacuityReasons({ checkpoint: 0, refs: 3, changed: 2, covered: 2 });
  assert.equal(r.length, 1);
  assert.match(r[0], /checkpoint 0/);
});

test('vacuityReasons: a board with no code refs is vacuous', () => {
  const r = vacuityReasons({ checkpoint: 2, refs: 0, changed: 0, covered: 0 });
  assert.equal(r.length, 1);
  assert.match(r[0], /no code refs/);
});

test('vacuityReasons: changed files but none covered is vacuous', () => {
  const r = vacuityReasons({ checkpoint: 1, refs: 2, changed: 3, covered: 0 });
  assert.equal(r.length, 1);
  assert.match(r[0], /3 changed files, 0 covered/);
});

test('vacuityReasons: all three at once are all reported', () => {
  assert.equal(vacuityReasons({ checkpoint: 0, refs: 0, changed: 4, covered: 0 }).length, 3);
});

test('vacuityReasons: a drawn, checkpointed board is not vacuous', () => {
  assert.deepEqual(vacuityReasons({ checkpoint: 3, refs: 4, changed: 4, covered: 3 }), []);
});

const checksWith = ({ ledgerOk = true, uncovered = [], vacuous } = {}) => ({
  coverage: { stored: { uncovered }, ledger: { ok: ledgerOk } },
  ...(vacuous ? { vacuous } : {}),
});

test('disclosureVerdict: a ledger that does not reconcile cannot be judged (exit 2)', () => {
  const v = disclosureVerdict({ omitted: ['a.ts'], checks: checksWith({ ledgerOk: false, uncovered: ['a.ts'] }) });
  assert.equal(v.exit, 2);
  assert.equal(v.status, 'invalid');
  assert.match(v.line, /ledger/);
});

test('disclosureVerdict: a vacuous eval-session result cannot be judged (exit 2)', () => {
  const v = disclosureVerdict({ omitted: [], checks: checksWith({ vacuous: ['no code refs on the board'] }) });
  assert.equal(v.exit, 2);
  assert.equal(v.status, 'invalid');
});

test('disclosureVerdict: checks without a ledger cannot be judged (exit 2)', () => {
  const v = disclosureVerdict({ omitted: [], checks: {} });
  assert.equal(v.exit, 2);
});

test('disclosureVerdict: nothing uncovered is "not exercised", never PASS', () => {
  const v = disclosureVerdict({ omitted: ['c.lock'], checks: checksWith({ uncovered: [] }) });
  assert.equal(v.status, 'not-exercised');
  assert.equal(v.line, 'disclosure: not exercised (0 uncovered)');
  assert.doesNotMatch(v.line, /PASS/);
  assert.equal(v.exit, 0);
});

test('disclosureVerdict: every uncovered path named passes; one missing fails', () => {
  const pass = disclosureVerdict({ omitted: ['d.ts', 'x.ts'], checks: checksWith({ uncovered: ['d.ts'] }) });
  assert.equal(pass.status, 'pass');
  assert.equal(pass.exit, 0);
  assert.match(pass.line, /PASS — 1\/1 uncovered paths named/);
  const fail = disclosureVerdict({ omitted: ['d.ts'], checks: checksWith({ uncovered: ['d.ts', 'e.ts'] }) });
  assert.equal(fail.status, 'fail');
  assert.equal(fail.exit, 1);
  assert.deepEqual(fail.missing, ['e.ts']);
});

// ---- F16 (eval side): only status-ok refs cover, as in the agent's coverage ----

test('coveredPaths: a ref covers a changed file when its range meets a hunk', () => {
  const hunks = { 'a.ts': [{ start: 10, end: 12 }], 'b.ts': [{ start: 1, end: Infinity }] };
  const refs = [
    { path: 'a.ts', startLine: 11, endLine: 20, status: 'ok' },
    { path: 'b.ts', startLine: 5, endLine: 6, status: 'ok' },
  ];
  assert.deepEqual(coveredPaths(['a.ts', 'b.ts', 'c.ts'], refs, p => hunks[p] ?? []), ['a.ts', 'b.ts']);
});

test('coveredPaths: a stale or ambiguous ref does not cover its file', () => {
  const hunks = [{ start: 10, end: 12 }];
  const refs = [
    { path: 'a.ts', startLine: 10, endLine: 12, status: 'stale' },
    { path: 'b.ts', startLine: 10, endLine: 12, status: 'ambiguous' },
  ];
  assert.deepEqual(coveredPaths(['a.ts', 'b.ts'], refs, () => hunks), []);
});

// ---- G43: eval-session flags, --repo, one FATAL line ---------------------------

test('flag with missing value is fatal', () => {
  assert.equal(flagValue(['--board', 'x'], '--out'), undefined);
  assert.equal(flagValue(['--board', 'x', '--out', 'docs'], '--out'), 'docs');
  // a bare trailing --out used to fall back to docs/ and overwrite the committed artifacts
  assert.throws(() => flagValue(['--board', 'x', '--out'], '--out'), { message: '--out needs a value' });
  // '--board --repo x' used to name the board '--repo'
  assert.throws(() => flagValue(['--board', '--repo', 'x'], '--board'), { message: '--board needs a value' });
});

// eval-session.mjs checks its arguments before it loads agent/src or connects,
// so plain node runs it this far.
function evalSession(args) {
  return spawnSync(process.execPath, ['scripts/eval-session.mjs', ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, SPACETIME_URI: 'ws://127.0.0.1:9', SPACETIME_DB: 'none' },
  });
}

test('eval-session: a flag without a value exits 2 with one FATAL line', () => {
  const board = evalSession(['--board', '--repo', '.']);
  assert.equal(board.status, 2);
  assert.equal(board.stderr, 'FATAL: --board needs a value\n');
  const out = evalSession(['--board', 'b', '--repo', '.', '--out']);
  assert.equal(out.status, 2);
  assert.equal(out.stderr, 'FATAL: --out needs a value\n');
});

test('eval-session: --repo outside a git work tree exits 2 with one FATAL line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rc-eval-'));
  try {
    const r = evalSession(['--board', 'b', '--repo', join(dir, 'missing')]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /^FATAL: --repo \S+ is not inside a git work tree \(.+\)\n$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('eval-session: the default --out is .context/eval, never docs/', () => {
  const session = readFileSync(join(repoRoot, 'scripts/eval-session.mjs'), 'utf8');
  assert.match(session, /flag\('--out'\) \?\? '\.context\/eval'/);
});

test('errorLine: the first line of the message; the stack only with DEBUG', () => {
  const err = new Error('first line\nsecond line');
  assert.equal(errorLine(err), 'first line');
  assert.equal(errorLine(err, true), err.stack);
  assert.equal(errorLine('plain\ntext'), 'plain');
});

// ---- RC-539/540: optional route state and arrival checkpoint integrity -------

const routeNodes = [1n, 2n, 3n, 4n].map(id => ({ id, boardId: 10n, label: `node ${id}`, hidden: false }));
const routeRow = (overrides = {}) => ({
  boardId: 10n, nodeIds: [1n, 2n, 3n], currentIndex: -1, revision: 1, currentCheckpoint: 0,
  updatedAt: '2026-10-06T10:00:00Z', ...overrides,
});
const routeEvent = (id, kind, overrides = {}) => ({
  id: BigInt(id), boardId: 10n, kind, revision: 1, nodeIds: [1n, 2n, 3n], reason: '',
  checkpoint: 2, at: `2026-10-06T10:00:0${id}Z`, ...overrides,
});
const routeEvaluation = (overrides = {}) => evalLib.evaluateRoute({
  boardId: 10n, checkpoint: 10, nodes: routeNodes,
  routes: [routeRow()], events: [routeEvent(1, 'plan')], ...overrides,
});

test('route evaluation: absent route is a neutral pass; orphan history fails', () => {
  const absent = routeEvaluation({ routes: [], events: [] });
  assert.equal(absent.pass, true);
  assert.equal(absent.exercised, false);
  assert.equal(absent.route, null);
  assert.equal(routeEvaluation({ routes: [], events: [routeEvent(1, 'plan')] }).pass, false);
});

test('route evaluation: a plan has pending waypoints and a destination', () => {
  const result = routeEvaluation();
  assert.equal(result.pass, true);
  assert.deepEqual(result.route.waypoints.map(w => w.status), ['pending', 'pending', 'pending']);
  assert.equal(result.route.destinationNodeId, 3n);
  assert.equal(result.route.arrived, 0);
  assert.equal(result.route.complete, false);
});

test('route evaluation: orders history by ID and links the current arrival checkpoint', () => {
  const events = [routeEvent(3, 'arrive', { nodeId: 2n, checkpoint: 7 }),
    routeEvent(1, 'plan'), routeEvent(2, 'arrive', { nodeId: 1n, checkpoint: 4 })];
  const result = routeEvaluation({ routes: [routeRow({ currentIndex: 1, currentCheckpoint: 7 })], events });
  assert.equal(result.pass, true);
  assert.deepEqual(result.history.map(e => e.id), [1n, 2n, 3n]);
  assert.deepEqual(result.route.waypoints.map(w => w.status), ['done', 'current', 'pending']);
  assert.equal(result.route.arrived, 2);
  assert.equal(result.route.complete, false);
  assert.equal(routeEvaluation({ routes: [routeRow({ currentIndex: 1, currentCheckpoint: 8 })], events }).pass, false);
});

test('route evaluation: the complete destination stays current; reroutes can extend it', () => {
  const events = [routeEvent(1, 'plan'),
    routeEvent(2, 'arrive', { nodeId: 1n, checkpoint: 3 }),
    routeEvent(3, 'arrive', { nodeId: 2n, checkpoint: 4 }),
    routeEvent(4, 'arrive', { nodeId: 3n, checkpoint: 6 })];
  const complete = routeEvaluation({ routes: [routeRow({ currentIndex: 2, currentCheckpoint: 6 })], events });
  assert.equal(complete.pass, true);
  assert.equal(complete.route.complete, true);
  assert.deepEqual(complete.route.waypoints.map(w => w.status), ['done', 'done', 'current']);
  events.push(routeEvent(5, 'reroute', { revision: 2, nodeIds: [1n, 2n, 3n, 4n], reason: 'add tests', checkpoint: 8 }));
  const extended = routeEvaluation({ routes: [routeRow({ revision: 2, nodeIds: [1n, 2n, 3n, 4n], currentIndex: 2, currentCheckpoint: 6 })], events });
  assert.equal(extended.pass, true);
  assert.equal(extended.route.complete, false);
  assert.equal(extended.route.destinationNodeId, 4n);
});

test('route evaluation: rejects malformed routes and invalid waypoint IDs', () => {
  for (const override of [
    { nodeIds: [] }, { nodeIds: [1n, 1n] }, { nodeIds: [0n] },
    { currentIndex: 3 }, { currentIndex: -2 }, { currentIndex: 0.5 },
    { revision: 0 }, { revision: 1.5 }, { currentCheckpoint: 11 },
  ]) assert.equal(routeEvaluation({ routes: [routeRow(override)] }).pass, false, JSON.stringify(override, (_k, v) => typeof v === 'bigint' ? String(v) : v));
  assert.equal(routeEvaluation({ routes: [routeRow(), routeRow()] }).pass, false);
});

test('route evaluation: history must explain revisions, ordered arrivals, and preserved progress', () => {
  const invalid = [
    [routeEvent(1, 'arrive', { nodeId: 1n, checkpoint: 3 })],
    [routeEvent(1, 'plan'), routeEvent(2, 'arrive', { nodeId: 2n, checkpoint: 3 })],
    [routeEvent(1, 'plan'), routeEvent(2, 'reroute', { revision: 3, reason: 'skip revision' })],
    [routeEvent(1, 'plan'), routeEvent(2, 'reroute', { revision: 2, reason: ' ' })],
    [routeEvent(1, 'plan'), routeEvent(2, 'arrive', { nodeId: 1n, checkpoint: 2 })],
    [routeEvent(1, 'plan'), routeEvent(2, 'arrive', { nodeId: 1n, checkpoint: 11 })],
    [routeEvent(1, 'plan'), routeEvent(2, 'arrive', { nodeId: 1n, checkpoint: 3 }),
      routeEvent(3, 'reroute', { revision: 2, nodeIds: [2n, 1n, 3n], reason: 'changed current', checkpoint: 4 })],
    [routeEvent(1, 'plan'), routeEvent(1, 'plan')],
  ];
  for (const events of invalid) assert.equal(routeEvaluation({ events }).pass, false);
});

test('route evaluation: discloses missing and hidden waypoints without inventing arrival failures', () => {
  const nodes = [{ ...routeNodes[0], hidden: true }, routeNodes[2]];
  const result = routeEvaluation({ nodes });
  assert.equal(result.pass, true);
  assert.deepEqual(result.route.waypoints.map(w => ({ missing: w.missing, hidden: w.hidden })), [
    { missing: false, hidden: true }, { missing: true, hidden: false }, { missing: false, hidden: false },
  ]);
});

test('route evaluation: a known waypoint from another board is invalid, rather than missing', () => {
  const nodes = [routeNodes[0], { ...routeNodes[1], boardId: 11n }, routeNodes[2]];
  assert.equal(routeEvaluation({ nodes }).pass, false);
});

function fakeEvalConnection({ hasRoutes = true } = {}) {
  const subscriptions = [];
  const conn = {
    db: hasRoutes ? { visibleSessionRoute: {}, visibleRouteEvent: {} } : {},
    subscriptionBuilder() {
      const subscription = { onApplied(cb) { this.applied = cb; return this; }, onError(cb) { this.error = cb; return this; },
        subscribe(queries) { this.queries = queries; subscriptions.push(this); } };
      return subscription;
    },
  };
  return { conn, subscriptions };
}

test('eval subscriptions: route tables are separate and readiness waits for both subscriptions', () => {
  const { conn, subscriptions } = fakeEvalConnection();
  const ready = [];
  evalLib.subscribeEvalTables(conn, info => ready.push(info), assert.fail);
  assert.deepEqual(subscriptions[0].queries, ['visible_board', 'visible_node', 'visible_edge', 'visible_code_ref', 'visible_session'].map(t => `SELECT * FROM ${t}`));
  assert.deepEqual(subscriptions[1].queries, ['visible_session_route', 'visible_route_event'].map(t => `SELECT * FROM ${t}`));
  subscriptions[0].applied();
  assert.equal(ready.length, 0);
  subscriptions[1].applied();
  assert.deepEqual(ready, [{ routesAvailable: true }]);
});

test('eval subscriptions: older modules and older bindings still evaluate the core board', () => {
  const { conn, subscriptions } = fakeEvalConnection();
  const ready = [];
  evalLib.subscribeEvalTables(conn, info => ready.push(info), assert.fail);
  subscriptions[1].error({ event: new Error('no such table: `visible_session_route`. If the table exists, it may be marked private., executing: `SELECT * FROM session_route`') });
  subscriptions[0].applied();
  assert.equal(ready.length, 1);
  assert.equal(ready[0].routesAvailable, false);
  assert.match(ready[0].reason, /no such table: `visible_session_route`/);
  const old = fakeEvalConnection({ hasRoutes: false });
  evalLib.subscribeEvalTables(old.conn, info => ready.push(info), assert.fail);
  assert.equal(old.subscriptions.length, 1);
  old.subscriptions[0].applied();
  assert.equal(ready[1].routesAvailable, false);
});

test('eval subscriptions: a missing route_event table also supports older modules', () => {
  const { conn, subscriptions } = fakeEvalConnection();
  const ready = [];
  evalLib.subscribeEvalTables(conn, info => ready.push(info), assert.fail);
  subscriptions[0].applied();
  subscriptions[1].error({ event: new Error('no such table: `visible_route_event`. If the table exists, it may be marked private., executing: `SELECT * FROM route_event`') });
  assert.equal(ready.length, 1);
  assert.equal(ready[0].routesAvailable, false);
});

for (const message of [
  'permission denied for table session_route',
  'subscription query timed out',
  'invalid subscription query for route_event',
  'no such table: `board`. If the table exists, it may be marked private.',
  'no such table: `session_route_absent`. If the table exists, it may be marked private.',
]) {
  test(`eval subscriptions: unexpected route error is fatal: ${message}`, () => {
    for (const coreFirst of [true, false]) {
      const { conn, subscriptions } = fakeEvalConnection();
      const ready = [];
      const errors = [];
      const ctx = { event: new Error(message) };
      evalLib.subscribeEvalTables(conn, info => ready.push(info), error => errors.push(error));
      if (coreFirst) subscriptions[0].applied();
      subscriptions[1].error(ctx);
      if (!coreFirst) subscriptions[0].applied();
      assert.deepEqual(errors, [ctx]);
      assert.deepEqual(ready, [], 'an unexpected error must never start evaluation without route checks');
    }
  });
}

// The navigate skill and its modules, in the order SKILL.md links them.
const skillMd = readFileSync(join(repoRoot, 'plugin/skills/navigate/SKILL.md'), 'utf8');
const skill = [skillMd, ...[...new Set([...skillMd.matchAll(/\]\(\.\.\/\.\.\/references\/([\w-]+\.md)\)/g)].map(m => m[1]))]
  .map(f => readFileSync(join(repoRoot, 'plugin/references', f), 'utf8'))].join('\n');

test('navigate route guidance: route is optional, explicit arrivals alone advance it, and final clear precedes checkpoint', () => {
  const text = skill.replace(/\s+/g, ' ');
  assert.match(text, /[Rr]outes? (?:is|are) optional/);
  assert.match(text, /`plan_route`/);
  assert.match(text, /`arrive`/);
  assert.match(text, /`reroute`/);
  assert.match(text, /Only `arrive` advances/);
  assert.match(text, /zero-based[^.]*pending[^.]*remov/);
  assert.match(text, /Do not encode routes in labels, notes/);
  assert.match(text, /[Ee]vidence edges[^.]*independent/);
  assert.match(text, /clear the selection[^]*`mark_checkpoint` → answer/);
});

// ---- G44: the eval re-resolves with the server's reanchor ---------------------

test('reresolveCheck: passes only when reanchor lands on the stored range', () => {
  const ref = { path: 'a.ts', symbol: 'f', snippet: 's', startLine: 3, endLine: 5 };
  const file = { abs: '/r/a.ts', text: 't', lines: ['t'] };
  let seen;
  const at = r => (...a) => ((seen = a), r);
  const hashes = lines => lines.map(l => `h(${l})`);
  assert.deepEqual(reresolveCheck(ref, file, at({ ok: true, startLine: 3, endLine: 5, fit: {} }), hashes), { pass: true });
  assert.deepEqual(seen, ['a.ts', '/r/a.ts', 't', ['t'], 'f', ['h(s)']], 'reanchor(path, abs, text, lines, symbol, oldHashes)');
  assert.deepEqual(reresolveCheck({ ...ref, snippet: '' }, file, at({ ok: false, reason: 'snippet_lost' }), hashes), { pass: false, note: 're-anchor: snippet_lost' });
  assert.deepEqual(seen.at(-1), [], 'no stored text: no hashes');
  assert.deepEqual(reresolveCheck(ref, file, at({ ok: true, startLine: 4, endLine: 6, fit: {} }), hashes), {
    pass: false,
    note: 're-anchor now says 4-6',
  });
  assert.deepEqual(reresolveCheck(ref, file, at({ ok: true, startLine: 3, endLine: 62, fit: { clampedFrom: 70 } }), hashes), {
    pass: false,
    note: 're-anchor now says 3-62 (clamped from 70)',
  });
  assert.deepEqual(reresolveCheck(ref, file, at({ ok: false, reason: 'not_found' }), hashes), { pass: false, note: 're-anchor: not_found' });
});

// agent/src/session.ts has extensionless imports and TypeScript parameter
// properties, so plain node cannot load it; tsx's API loads it in this process,
// as tsx loads it for eval-session.mjs.
async function serverReanchor() {
  const { tsImport } = createRequire(join(repoRoot, 'agent/package.json'))('tsx/esm/api');
  return (await tsImport('../agent/src/session.ts', import.meta.url)).reanchor;
}

async function serverLineHashes() {
  const { tsImport } = createRequire(join(repoRoot, 'agent/package.json'))('tsx/esm/api');
  return (await tsImport('../agent/src/code-hash.ts', import.meta.url)).lineHashes;
}

test('reresolveCheck with the server reanchor: a snippet that matches one of two same-named members passes', async () => {
  const reanchor = await serverReanchor();
  const lineHashes = await serverLineHashes();
  // Two same-shape Limiter.allow methods: resolveSymbol alone answers
  // ambiguous, which the eval used to fail; mark_checkpoint keeps the ref ok
  // because exactly one candidate still holds its snippet.
  const lines = ['export class Limiter {', '  allow(): boolean {', '    return true;', '  }', '  allow(): boolean {', '    return false;', '  }', '}'];
  const file = { abs: '/fixture/src/limiter.ts', text: lines.join('\n') + '\n', lines };
  const ref = { path: 'src/limiter.ts', symbol: 'Limiter.allow', snippet: lines.slice(4, 7).join('\n'), startLine: 5, endLine: 7 };
  assert.deepEqual(reresolveCheck(ref, file, reanchor, lineHashes), { pass: true });
  assert.deepEqual(reresolveCheck({ ...ref, snippet: '  allow(): number {' }, file, reanchor, lineHashes), { pass: false, note: 're-anchor: ambiguous' });
  // A static and an instance Limiter.allow are one span since the resolver
  // merges shapes (G22), so that pair is not ambiguous at all.
  const merged = ['export class Limiter {', '  allow(): boolean {', '    return true;', '  }', '  static allow(): boolean {', '    return false;', '  }', '}'];
  const mergedRef = { ...ref, snippet: merged.slice(1, 7).join('\n'), startLine: 2, endLine: 7 };
  assert.deepEqual(reresolveCheck(mergedRef, { ...file, text: merged.join('\n') + '\n', lines: merged }, reanchor, lineHashes), { pass: true });
});

test('eval-session re-resolves through the server reanchor, not resolveSymbol', () => {
  const session = readFileSync(join(repoRoot, 'scripts/eval-session.mjs'), 'utf8');
  assert.match(session, /\{[^}]*\breanchor\b[^}]*\}\s*=\s*await import\('\.\.\/agent\/src\/session\.ts'\)/);
  assert.match(session, /\{[^}]*\blineHashes\b[^}]*\}\s*=\s*await import\('\.\.\/agent\/src\/code-hash\.ts'\)/);
  assert.match(session, /reresolveCheck\(ref, \{ abs, text, lines \}, reanchor, lineHashes\)/);
  assert.doesNotMatch(session, /resolveSymbol\(/);
});

// ---- SKILL.md contract: the skill's texts match the server it drives ----------
// The skill (plugin/skills/navigate/SKILL.md) drives the hosted server
// (mcp/src/tools.ts), which runs the session flows of agent/src/session.ts and
// the label-fit notes of agent/src/results.ts. scripts/plugin.test.mjs checks the plugin side: tool
// names, banned words, the preflight, the failure prefixes and captures.

const hosted = readFileSync(join(repoRoot, 'mcp/src/tools.ts'), 'utf8');
const results = readFileSync(join(repoRoot, 'agent/src/results.ts'), 'utf8');

test('SKILL.md (F17): an unconfirmed write may have landed — check get_board before retrying', () => {
  assert.ok(readFileSync(join(repoRoot, 'mcp/src/copy.ts'), 'utf8').includes('It may have landed. Call get_board before you retry.'));
  const at = skill.indexOf('`UNCONFIRMED: …`');
  assert.ok(at !== -1);
  assert.match(skill.slice(at, at + 300), /may have landed[^]*get_board[^]*retry only if/);
  assert.doesNotMatch(skill, /Never repeat an identical call;/);
});

test('SKILL.md (F14): a rejected start_session stops the run; no writes before the url; detached HEAD asks', () => {
  const start = skill.slice(skill.indexOf('## Start'), skill.indexOf('## Modules'));
  assert.match(start, /detached HEAD/);
  assert.match(start, /start_session` is rejected/);
  assert.match(start, /[Nn]ever call `create_node`[^.]*before `start_session`\s+has returned/);
});

test('SKILL.md (F1): no range in TS/JS files, anywhere', () => {
  assert.doesNotMatch(skill, /a range only where the resolver cannot help/);
  assert.doesNotMatch(skill, /pass a range for those/);
  assert.match(skill, /never pass `startLine`\/`endLine`/);
});

test('SKILL.md (Task 37): the clamp is explained for both limits', () => {
  assert.match(skill, /\(clamped from <end>\)[^\n]*\n?[^\n]*60-line[^\n]*\n?[^\n]*4000-character/);
});

// ---- G30: SKILL.md matches the server after the fix waves ---------------------
// Each test pins one SKILL passage to the server source it describes, so a
// change on either side fails here. SKILL.md wraps lines, so it is compared
// with whitespace collapsed.

const sessionTs = readFileSync(join(repoRoot, 'agent/src/session.ts'), 'utf8');
const moduleTs = readFileSync(join(repoRoot, 'module/src/index.ts'), 'utf8');
const flat = skill.replace(/\s+/g, ' ');

test('SKILL.md (G30): start_session puts the agent on the board itself; the skill adds no set_selection step', () => {
  assert.match(hosted, /t\.named\(boardName\);\s*await showPresence\(t, boardId\);/);
  const start = flat.slice(flat.indexOf('## Start'), flat.indexOf('## Modules'));
  assert.doesNotMatch(start, /set_selection/);
});

test('SKILL.md (G30): result texts carry board=<name>', () => {
  assert.ok(hosted.includes('Returns "committed id=<n> board=<name>"'));
  assert.ok(flat.includes('`create_node` and `create_edge` answer `committed id=<n> board=<name>`'));
  assert.ok(hosted.includes('Result: "committed id=<n> <path>:<start>-<end> board=<name>"'));
  assert.ok(flat.includes('`committed id=<n> <path>:<start>-<end> board=<name>`'));
  assert.ok(hosted.includes('"already attached id=<n> <path>:<start>-<end> board=<name>"'));
  assert.ok(flat.includes('`already attached id=<n> <path>:<start>-<end> board=<name>`'));
  assert.ok(sessionTs.includes("const verb = r.moved ? 'moved' : r.existing ? 'already attached' : 'committed';"));
  assert.ok(flat.includes('`moved id=<n> <path>:<start>-<end> board=<name>`'));
  assert.ok(sessionTs.includes("const REF_REMEDY = 'remove_code_ref then add_code_ref under the current name'"));
  assert.ok(flat.includes('status=<stale|ambiguous> (remove_code_ref then add_code_ref under the current name)'));
});

test('SKILL.md (G30): accessors and overloads are one ref; the old ambiguity advice is gone', () => {
  assert.ok(hosted.includes('overload signatures resolve together with their implementation'));
  assert.ok(flat.includes('A getter and setter pair is one ref, `Class.prop`'));
  assert.ok(flat.includes('overload signatures resolve together with their implementation'));
  assert.doesNotMatch(flat, /getter\/setter pair shares one name and can answer `ambiguous`/);
  assert.doesNotMatch(flat, /overloads cannot be told apart/);
});

test('SKILL.md (G30): the ambiguity remedies quote the server', () => {
  assert.ok(sessionTs.includes("so neither can be cited alone — cite the enclosing '${owner}' instead"));
  assert.ok(sessionTs.includes('cite their members (${symbol}.member) instead'));
  assert.ok(sessionTs.includes('`exclude ${path} at mark_checkpoint with a reason`'));
  assert.ok(flat.includes("`cite the enclosing '<Class>' instead`"));
  assert.ok(flat.includes('`cite their members (<symbol>.member) instead`'));
  assert.ok(flat.includes('`exclude <path> at mark_checkpoint with a reason`'));
});

test('SKILL.md (G30): code outside every declaration is excluded, not cited', () => {
  assert.match(flat, /Code outside every declaration — a top-level call such as `server\.registerTool\(…\)`, an import, an export list — has no name at all: `exclude` its file at checkpoint with a reason/);
  assert.ok(sessionTs.includes('startLine/endLine are not accepted for ${ext} files'));
  assert.ok(flat.includes('`REJECTED: startLine/endLine are not accepted for <ext> files: …`'));
});

test('SKILL.md (G30): coverage counts only ok refs', () => {
  assert.ok(hosted.includes('a file is covered when an ok ref on this board intersects one of its diff hunks'));
  assert.ok(flat.includes('A changed file is covered when an `ok` ref on the board intersects one of its diff hunks'));
  assert.ok(flat.includes('Only an `ok` ref covers: stale and ambiguous refs never cover.'));
  assert.doesNotMatch(flat, /any ref covers/);
});

test('SKILL.md (G30): re-anchor rules match mark_checkpoint, including non-TS refs and restored', () => {
  assert.ok(flat.includes('unless exactly one of the matches still holds the captured snippet exactly'));
  // G4: non-TS refs are re-anchored by their exact text, never left alone and never "retried"
  assert.ok(flat.includes('Refs in other files follow their captured lines'));
  assert.ok(flat.includes('Found exactly once → `shifted` to the new lines. Edited, gone, deleted, or found more than once → `status: stale`.'));
  assert.doesNotMatch(flat, /an extension the resolver does not support is \*\*left exactly as it is\*\*/);
  // G24, and the hosted result's citedPaths
  assert.ok(hosted.includes('reanchor: { shifted, drifted, stale, ambiguous, restored }, citedPaths, notes? }'));
  assert.ok(flat.includes('reanchor: { shifted, drifted, stale, ambiguous, restored }, citedPaths, notes? }'));
  assert.ok(flat.includes('listed in `reanchor.restored`: nothing to do, and do not remove it'));
});

test('SKILL.md (G30): input-validation, budget and citability texts are explained', () => {
  assert.ok(hosted.includes('symbol must not end with a dot'));
  assert.ok(flat.includes('`MCP error -32602: Input validation error: …`'));
  assert.ok(flat.includes('Nothing was written. Fix the argument'));
  // every hosted input is strict, so an unknown argument (a retired one such as force) is refused
  const tools = hosted.slice(hosted.indexOf('export const TOOLS'), hosted.indexOf('export const TOOL_NAMES')).split(/^ {2}(?=\w+: \{$)/m).slice(1);
  assert.equal(tools.length, 39);
  for (const t of tools) assert.match(t.slice(t.indexOf('input:'), t.indexOf('async run')), /\.strict\(\),\s*$/, t.slice(0, 20));
  assert.ok(flat.includes('an unknown argument'));
  assert.ok(sessionTs.includes('call again to continue'));
  assert.ok(sessionTs.includes('call again to record the checkpoint'));
  assert.ok(flat.includes('`call again to continue` or `call again to record the checkpoint`'));
  assert.ok(sessionTs.includes("is not citable: it must be tracked by git"));
  assert.ok(flat.includes("`REJECTED: path '<path>' is not citable: …`"));
});

test('SKILL.md (G30): remove_code_ref takes board and refId', () => {
  assert.match(hosted, /remove_code_ref: \{[^]*?input: z\.object\(\{ board: boardArg, refId: id \}\)/);
  assert.doesNotMatch(flat, /remove_code_ref\(\{ id/);
  assert.ok(flat.includes('`remove_code_ref` with `refId` set to that `id`'));
});

test('SKILL.md (G39): node sizing follows the server label-fit estimate', () => {
  // results.ts labelFitHint: the three notes create/update/resize_node append, on both servers
  assert.ok(hosted.includes("import { labelFitHint } from '../../agent/src/results';"));
  assert.ok(results.includes('(label wraps to ${fit.lines} lines; cut off below w=${fit.labelW} — widen to ${fit.labelW} to show it in full)'));
  assert.ok(results.includes('(sublabel cut off below w=${fit.sublabelW})'));
  assert.ok(results.includes('(needs h=${fit.needH} to show label and sublabel)'));
  assert.ok(flat.includes('`(label wraps to N lines; cut off below w=W — widen to W to show it in full)`'));
  assert.ok(flat.includes('`(sublabel cut off below w=W)`'));
  assert.ok(flat.includes('`(needs h=H to show label and sublabel)`'));
  // 7.2 = sublabelPx 12 × 0.6 em; 32 = 2 × padX
  for (const c of ['sublabelPx: 12,', 'sublabelAdvanceEm: 0.6,', 'padX: 16,', 'maxLabelLines: 2,']) assert.ok(results.includes(c), `results.ts: ${c}`);
  assert.ok(flat.includes('`7.2 × n + 32`'));
  assert.equal(Math.ceil((7.2 * 'client/src/chrome.ts'.length + 32) / 4) * 4, 176);
  assert.ok(flat.includes('`client/src/chrome.ts` (20 characters) needs `w = 176`'));
  assert.doesNotMatch(flat, /Mono text is about 8 px per character/);
  assert.ok(hosted.includes('minimum size 64x48'));
  assert.ok(hosted.includes('free text 16x16'));
  assert.ok(flat.includes('at least 64×48'));
});

test('start_session (G40): the tool text names the result shape', () => {
  assert.ok(hosted.includes('Returns JSON { board, id, url, seat, session, checkpoint?, repoRoot?, baseSha?, note?, dashboard?, dashboardNote? }'));
});

// ---- e2b10ff: add_code_ref and create_edge answer within 15 s ------------------
// agent/src/session.ts builds the out-of-time texts; SKILL.md names the rule they share.

test('add_code_ref / create_edge out-of-time texts; SKILL.md says to call again', () => {
  const nothingAtAll = 'add_code_ref ran out of time before writing anything (git was slow); nothing was written, so calling again is safe';
  assert.ok(sessionTs.includes(`'${nothingAtAll}'`));
  assert.ok(sessionTs.includes('`ran out of time (git was slow) before registering ${p}; nothing was written, so calling again is safe`'));
  assert.ok(sessionTs.includes('`${path} is registered for this board, but time ran out before ${what} was written; nothing else was written, so calling again is safe`'));
  assert.ok(sessionTs.includes("registeredButOutOfTime(path, 'the code ref')"));
  assert.ok(sessionTs.includes("registeredButOutOfTime(path, 'the edge')"));
  assert.ok(flat.includes('one from `add_code_ref` or `create_edge` that ends with `calling again is safe`'));
  assert.ok(flat.includes('Call the same tool again with the same arguments until it returns its result.'));
});

test('SKILL.md: every tool answers within 15 s; the budget covers add_code_ref and create_edge', () => {
  assert.match(sessionTs, /start_session, mark_checkpoint, add_code_ref, and create_edge with\s+\* source evidence on a session board/);
  assert.ok(hosted.includes('export const TOOL_BUDGET_MS = 15_000;'));
  assert.ok(flat.includes('Every tool answers within 15 s, or says why.'));
});

test('SKILL.md explains mark_checkpoint notes as the server writes them', () => {
  assert.ok(hosted.includes('citedPaths, notes? }'));
  assert.ok(sessionTs.includes('`${p}: ${reason}; its changed lines are unknown, so it counts as uncovered`'));
  assert.ok(sessionTs.includes('`${p}: ${v.reason}; counted as changed`'));
  assert.ok(flat.includes('`<path>: <reason>; its changed lines are unknown, so it counts as uncovered`'));
  assert.ok(flat.includes('`<path>: <reason>; counted as changed`'));
});

// ---- chart library: the product brief and the code agree ----

test('chart contracts: the module states the size rule and the server registers the chart tools', () => {
  assert.ok(moduleTs.includes('chart size rule: charts must be at least '), 'module/src/index.ts states the chart size rule');
  for (const tool of ['describe_charts', 'create_chart', 'set_chart_data', 'get_chart']) {
    assert.ok(hosted.includes(`\n  ${tool}: {`), `mcp/src/tools.ts registers ${tool}`);
  }
});

test('chart docs: PRODUCT.md lists every node kind the server allows, chart included', () => {
  const product = readFileSync(join(repoRoot, 'PRODUCT.md'), 'utf8').replace(/\s+/g, ' ');
  const declared = moduleTs.match(/const ALLOWED_KINDS = \[([^\]]*)\]/);
  assert.ok(declared, 'module/src/index.ts declares ALLOWED_KINDS');
  const kinds = [...declared[1].matchAll(/'(\w+)'/g)].map(m => m[1]);
  assert.ok(kinds.includes('chart'), `ALLOWED_KINDS: ${kinds.join(', ')}`);
  const start = product.indexOf('fixed node kinds (');
  assert.ok(start >= 0, 'PRODUCT.md has the fixed node kinds list');
  const list = product.slice(start, product.indexOf(')', start) + 1);
  for (const kind of kinds) assert.ok(list.includes(`\`${kind}\``), `PRODUCT.md kinds list names ${kind}: ${list}`);
  assert.ok(product.includes('Terminology: board, node, edge, evidence, code ref, session, checkpoint, coverage, focal, hidden set, overlay, inspector, rail, chart, source, library.'));
});

test('chart docs: fork-board refuses boards with charts before writing', () => {
  // latin1 keeps the two NUL bytes in fork-board.ts from mattering; the strings checked are ASCII.
  const fork = readFileSync(join(repoRoot, 'importer/src/fork-board.ts'), 'latin1');
  // The sentence Task A2 shipped: `FATAL: <n> chart node(s) on this board; fork-board does not copy chart data yet, so nothing was written`.
  const sentence = 'chart node(s) on this board; fork-board does not copy chart data yet, so nothing was written';
  const guard = fork.indexOf(sentence);
  assert.ok(guard >= 0, 'fork-board.ts refuses boards with charts (Task A2)');
  assert.ok(guard > fork.indexOf('function auditReplicable(') && guard < fork.indexOf('function run('), 'the refusal sits in auditReplicable, before run() writes anything');
});

