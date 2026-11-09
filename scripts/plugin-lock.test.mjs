import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRange, satisfies, drawVersion, rangeProblems } from './plugin-lock.mjs';

test('caret ranges follow npm semantics', () => {
  assert.ok(satisfies('1.4.0', '^1.4.0'));
  assert.ok(satisfies('1.9.3', '^1.4.0'));
  assert.ok(!satisfies('2.0.0', '^1.4.0'));
  assert.ok(!satisfies('1.3.9', '^1.4.0'));
  assert.ok(satisfies('0.3.7', '^0.3.0'));
  assert.ok(!satisfies('0.4.0', '^0.3.0'));
  assert.ok(!satisfies('0.2.9', '^0.3.0'));
  assert.ok(satisfies('0.0.3', '^0.0.3'));
  assert.ok(!satisfies('0.0.4', '^0.0.3'));
  assert.ok(satisfies('2.1.5', '^1.0.0 || ^2.1.0'));
  assert.ok(satisfies('1.0.0', '^1.0.0 || ^2.1.0'));
  assert.ok(!satisfies('2.0.9', '^1.0.0 || ^2.1.0'));
});

test('anything but caret ranges is refused', () => {
  for (const bad of ['>=1', '~1.2.0', '1.2', '1.2.0', '^1.2', '^1.2.0-beta', '', '||', '^1.0.0 ||', 3, null]) {
    assert.throws(() => parseRange(bad), /plugin rule: draw must be a caret range/, String(bad));
  }
  assert.deepEqual(parseRange('^0.3.0 || ^1.0.0'), [[0, 3, 0], [1, 0, 0]]);
  assert.throws(() => satisfies('dev', '^1.0.0'), /not a draw version/);
});

test('draw version: env first, then the builder image file, then git tags', t => {
  const dir = mkdtempSync(join(tmpdir(), 'draw-version-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'VERSION');
  assert.equal(drawVersion(dir, { DRAW_VERSION: 'v0.4.1' }, file), '0.4.1');
  writeFileSync(file, '0.3.2\n');
  assert.equal(drawVersion(dir, {}, file), '0.3.2');
  writeFileSync(file, 'dev\n');
  assert.equal(drawVersion(dir, {}, file), null); // not a git repo, no usable file
});

test('range problems: outside plugins must declare a range that includes this draw', () => {
  assert.deepEqual(rangeProblems({ id: 'versions' }, '0.2.1'), []);
  assert.match(rangeProblems({ id: 'pin' }, '0.2.1', { outside: true })[0], /must declare the draw versions/);
  assert.deepEqual(rangeProblems({ id: 'pin', draw: '^0.2.0' }, '0.2.1', { outside: true }), []);
  assert.match(rangeProblems({ id: 'pin', draw: '^0.3.0' }, '0.4.0', { label: 'pin@v1.2.0' })[0],
    /pin@v1\.2\.0 supports draw \^0\.3\.0; this is draw 0\.4\.0\. Upgrade the plugin, or mark it "skip": true\./);
  assert.match(rangeProblems({ id: 'pin', draw: '^0.3.0' }, null)[0], /cannot tell draw's version/);
});

// ---- Task 2: plugins file and lock rules ----
import { readConfig, readLock, writeLock, lockPlan, deployProblems } from './plugin-lock.mjs';
import { readFileSync } from 'node:fs';

const SHA = 'a'.repeat(40);
function configDir(t, plugins, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'draw-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  if (plugins !== undefined) writeFileSync(join(dir, 'draw-plugins.json'), JSON.stringify({ plugins, ...extra }));
  return dir;
}
const refuses = (t, plugins, pattern, extra) => assert.throws(() => readConfig(configDir(t, plugins, extra)), pattern, JSON.stringify(plugins));
const repo = (ref = 'v1.0.0', more = {}) => ({ repo: 'https://example.com/acme/pin.git', ref, ...more });

test('readConfig: missing file is empty; valid entries are typed', t => {
  assert.deepEqual(readConfig(configDir(t)), { plugins: {} });
  const config = readConfig(configDir(t, {
    pin: repo(), audit: { repo: 'git@example.com:acme/audit.git', ref: SHA, skip: true },
    sshrepo: { repo: 'ssh://git@example.com/acme/x.git', ref: 'release-2' }, local: { repo: 'file:///tmp/x.git', ref: 'v2' },
    scratch: { path: '../scratch' }, legacy: { retired: true },
  }));
  assert.deepEqual(config.plugins.pin, { kind: 'repo', repo: 'https://example.com/acme/pin.git', ref: 'v1.0.0', skip: false });
  assert.deepEqual(config.plugins.audit, { kind: 'repo', repo: 'git@example.com:acme/audit.git', ref: SHA, skip: true });
  assert.deepEqual(config.plugins.scratch, { kind: 'path', path: '../scratch', skip: false });
  assert.deepEqual(config.plugins.legacy, { kind: 'retired' });
});

test('readConfig: top level is exactly { plugins }', t => {
  refuses(t, {}, /plugin rule: draw-plugins\.json: unknown field 'extra'/, { extra: 1 });
  const dir = configDir(t);
  writeFileSync(join(dir, 'draw-plugins.json'), '[]');
  assert.throws(() => readConfig(dir), /plugin rule: draw-plugins\.json: must be \{ "plugins": \{ … \} \}/);
  writeFileSync(join(dir, 'draw-plugins.json'), '{ nope');
  assert.throws(() => readConfig(dir), /plugin rule: draw-plugins\.json: cannot read JSON/);
});

test('readConfig: ids must match the manifest id rule', t => {
  for (const id of ['A', 'a', '1x', 'bad-id', 'a'.repeat(32)]) refuses(t, { [id]: repo() }, /id must match/);
});

test('readConfig: repository URLs carry no credentials and use git transports', t => {
  for (const url of ['https://user:token@example.com/a.git', 'https://token@example.com/a.git', 'http://example.com/a.git',
    'git://example.com/a.git', 'https://example.com/a.git?x=1', 'https://example.com/a.git#v1', 'ftp://example.com/a', 'example.com/a', '', 3]) {
    refuses(t, { pin: { repo: url, ref: 'v1' } }, /plugin rule: draw-plugins\.json: pin: repo/, url);
  }
});

test('readConfig: refs are tags or full commits', t => {
  for (const ref of ['abc1234', 'a'.repeat(39), 'HEAD', 'refs/tags/v1', 'refs/heads/main', '', 'v1..2', 'v1 2', '-v1', 'v1.lock', 3]) {
    refuses(t, { pin: repo(ref) }, /pin: ref must be a tag or a full commit/, String(ref));
  }
});

test('readConfig: exact keys per kind and boolean skip', t => {
  refuses(t, { pin: { ...repo(), path: '../x' } }, /pin: use repo \+ ref, path, or \{ "retired": true \}/);
  refuses(t, { pin: { repo: 'https://example.com/a.git' } }, /pin: use repo \+ ref/);
  refuses(t, { pin: { ...repo(), extra: 1 } }, /pin: unknown field 'extra'/);
  refuses(t, { pin: { retired: true, skip: true } }, /pin: a retired entry is exactly \{ "retired": true \}/);
  refuses(t, { pin: { retired: false } }, /pin: a retired entry is exactly/);
  refuses(t, { pin: { ...repo(), skip: 'yes' } }, /pin: skip must be true or false/);
  refuses(t, { pin: { path: '' } }, /pin: path must be a non-empty string/);
  refuses(t, { pin: null }, /pin: must be an object/);
});

test('readConfig aggregates every problem into one error', t => {
  assert.throws(() => readConfig(configDir(t, { Bad: repo(), pin: repo('HEAD') })), error =>
    error.message.split('\n').length === 2 && error.message.split('\n').every(line => line.startsWith('plugin rule: draw-plugins.json: ')));
});

test('lock: missing is empty; newer or malformed is refused; write sorts keys', t => {
  const dir = configDir(t);
  assert.deepEqual(readLock(dir), { lockVersion: 1, plugins: {} });
  writeFileSync(join(dir, 'draw-plugins.lock.json'), JSON.stringify({ lockVersion: 2, plugins: {} }));
  assert.throws(() => readLock(dir), /plugin rule: draw-plugins\.lock\.json: lockVersion 2 is newer than this builder reads \(1\)/);
  for (const bad of [[], { lockVersion: 1 }, { lockVersion: 1, plugins: [] }, { lockVersion: 1, plugins: { pin: { repo: 'x' } } }, { lockVersion: 1, plugins: {}, extra: 1 }]) {
    writeFileSync(join(dir, 'draw-plugins.lock.json'), JSON.stringify(bad));
    assert.throws(() => readLock(dir), /plugin rule: draw-plugins\.lock\.json:/, JSON.stringify(bad));
  }
  const lock = { plugins: { zed: { schema: null, commit: SHA, ref: 'v1', repo: 'r', tables: {} }, abc: { tables: { b: 1, a: 2 }, schema: null, commit: SHA, ref: 'v1', repo: 'r' } }, lockVersion: 1 };
  writeLock(dir, lock);
  const text = readFileSync(join(dir, 'draw-plugins.lock.json'), 'utf8');
  assert.ok(text.endsWith('}\n'));
  assert.ok(text.indexOf('"lockVersion"') < text.indexOf('"plugins"') && text.indexOf('"abc"') < text.indexOf('"zed"') && text.indexOf('"a": 2') < text.indexOf('"b": 1'));
  assert.deepEqual(readLock(dir), lock);
});

const entry = (more = {}) => ({ repo: 'https://example.com/acme/pin.git', ref: 'v1.0.0', commit: SHA, draw: '^0.2.0', tables: {}, schema: null, ...more });
const lockOf = plugins => ({ lockVersion: 1, plugins });
const configOf = plugins => ({ plugins });
const repoEntry = (ref = 'v1.0.0', more = {}) => ({ kind: 'repo', repo: 'https://example.com/acme/pin.git', ref, skip: false, ...more });
const SCHEMA = { types: {}, tables: { pinNote: {} }, wire: {} };

test('lockPlan: new, unchanged and changed entries', () => {
  const plan = lockPlan(configOf({ fresh: repoEntry(), same: repoEntry(), moved: repoEntry('v2.0.0'), other: repoEntry('v1.0.0', { repo: 'https://example.com/acme/other.git' }) }),
    lockOf({ same: entry(), moved: entry(), other: entry() }), ['versions']);
  assert.deepEqual(plan, { resolve: ['fresh', 'moved', 'other'], keep: ['same'], skip: [], retire: [], drop: [], problems: [] });
});

test('lockPlan: skip and retire need a lock entry; path entries are ignored', () => {
  assert.deepEqual(lockPlan(configOf({ pin: repoEntry('v1.0.0', { skip: true }), old: { kind: 'retired' }, dev: { kind: 'path', path: '../x', skip: false } }),
    lockOf({ pin: entry(), old: entry({ schema: SCHEMA }) }), []), { resolve: [], keep: [], skip: ['pin'], retire: ['old'], drop: [], problems: [] });
  const plan = lockPlan(configOf({ pin: repoEntry('v1.0.0', { skip: true }), old: { kind: 'retired' } }), lockOf({}), []);
  assert.match(plan.problems[0], /plugin rule: pin: "skip": true needs an entry in the lock; remove the entry instead, nothing would be kept/);
  assert.match(plan.problems[1], /plugin rule: old: \{ "retired": true \} needs an entry in the lock/);
});

test('lockPlan: a retired plugin turned back into repo + ref is re-resolved', () => {
  assert.deepEqual(lockPlan(configOf({ pin: repoEntry() }), lockOf({ pin: entry({ retired: true, schema: SCHEMA }) }), []).resolve, ['pin']);
});

test('lockPlan: dropping a plugin with tables is refused; without tables it is dropped', () => {
  const plan = lockPlan(configOf({}), lockOf({ pin: entry({ schema: SCHEMA }), plain: entry() }), []);
  assert.deepEqual(plan.drop, ['plain']);
  assert.deepEqual(plan.problems, ["plugin rule: draw-plugins.json drops 'pin', which has database tables. Mark it { \"retired\": true }: its tables and data stay. Deleting its data is a manual cleanup."]);
});

test('lockPlan and deployProblems refuse in-repo plugin ids', () => {
  assert.match(lockPlan(configOf({ versions: repoEntry() }), lockOf({}), ['versions']).problems[0], /plugin rule: versions: is a plugin in this repository; it is always included/);
  assert.match(deployProblems(configOf({ versions: repoEntry() }), lockOf({ versions: entry() }), ['versions'])[0], /versions: is a plugin in this repository/);
});

test('deployProblems: a locked, unchanged plugins file passes', () => {
  assert.deepEqual(deployProblems(configOf({ pin: repoEntry(), sk: repoEntry('v1.0.0', { skip: true }), old: { kind: 'retired' } }),
    lockOf({ pin: entry(), sk: entry(), old: entry({ retired: true, schema: SCHEMA }) }), []), []);
});

test('deployProblems: local folders, unlocked, stale and dropped entries', () => {
  assert.deepEqual(deployProblems(configOf({ scratch: { kind: 'path', path: '../x', skip: false } }), lockOf({}), []),
    ["plugin rule: draw-plugins.json: 'scratch' is a local folder; deploy builds take only repo + ref. Use builder build --dev, or pin a tag."]);
  assert.match(deployProblems(configOf({ pin: repoEntry() }), lockOf({}), [])[0], /plugin rule: pin: not in the lock; run builder lock/);
  assert.match(deployProblems(configOf({ pin: repoEntry('v2.0.0') }), lockOf({ pin: entry() }), [])[0], /plugin rule: pin: lock is stale; run builder lock/);
  assert.match(deployProblems(configOf({ pin: repoEntry() }), lockOf({ pin: entry({ retired: true, schema: SCHEMA }) }), [])[0], /pin: lock is stale/);
  assert.match(deployProblems(configOf({ old: { kind: 'retired' } }), lockOf({ old: entry({ schema: SCHEMA }) }), [])[0], /old: lock is stale/);
  assert.match(deployProblems(configOf({}), lockOf({ pin: entry({ schema: SCHEMA }) }), [])[0], /drops 'pin', which has database tables/);
  assert.match(deployProblems(configOf({}), lockOf({ plain: entry() }), [])[0], /plugin rule: plain: lock is stale; run builder lock/);
  assert.match(deployProblems(configOf({ sk: repoEntry('v1.0.0', { skip: true }), old: { kind: 'retired' } }), lockOf({}), []).join('\n'),
    /sk: "skip": true needs an entry in the lock[\s\S]*old: \{ "retired": true \} needs an entry in the lock/);
});
