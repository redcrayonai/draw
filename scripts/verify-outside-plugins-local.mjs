#!/usr/bin/env node
// The outside-plugin builder against a real local database (scripts/stdb-test.sh outside):
// the test plugin (scripts/fixtures/outside-plugin) added, upgraded, refused when
// incompatible, refused when its tag moves, skipped, retired, rolled back, and a
// hand-edited lock caught. Rows written in one step must still be there in the next.
// Needs the database CLI on PATH and module/node_modules installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { database, fetchAll, fetchPlugin, gitEnv, lock, lockProblems, prepare, verifyLocked } from './builder.mjs';
import { readLock } from './plugin-lock.mjs';
import { makeRepo } from './fixtures/outside-plugin/versions.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'draw-outside-'));
const repoDir = join(scratch, 'repo'), config = join(scratch, 'config'), cache = join(scratch, 'cache');
const env = { ...process.env, DRAW_VERSION: '0.2.1' };
const commits = makeRepo(repoDir, '^0.2.0');
const url = `file://${repoDir}`;
execFileSync('mkdir', ['-p', config]);
const plugins = entry => writeFileSync(join(config, 'draw-plugins.json'), JSON.stringify({ plugins: { pinboard: entry } }));
const locked = () => readLock(config);

let db, step = 0;
test.before(() => { db = database(root); });
test.after(() => { db?.stop(); rmSync(scratch, { recursive: true, force: true }); });

/** Prepares draw with the plugin included (from its locked commit) or retained, publishes as an update to `live`. */
function deploy({ retain = false, fresh = false, ref } = {}) {
  const work = join(scratch, `work-${++step}`), lockData = locked(), entry = lockData.plugins.pinboard;
  const sources = {};
  if (!retain) {
    const into = join(scratch, `sources-${step}`);
    fetchPlugin({ id: 'pinboard', repo: url, ref: ref ?? entry.ref, commit: ref ? undefined : entry.commit }, { into, cache, env: gitEnv(env, { credentials: null }) });
    sources.pinboard = join(into, 'pinboard');
  }
  const prepared = prepare(root, work, { sources, retained: retain ? [{ id: 'pinboard', tables: entry.tables, schema: entry.schema }] : [] });
  execFileSync(process.execPath, [join(work, 'scripts/module-env.mjs'), 'local']);
  return { work, prepared, ...db.publish(join(work, 'module'), 'live', { fresh }) };
}
const rows = () => db.sql('live', 'SELECT id, text FROM pinboard_note').split('\n').filter(line => /^\s*\d+\s*\|/.test(line)).length;
const reducers = () => JSON.stringify(db.describe('live')).includes('add_pinboard_note');

test('add: lock v1.0.0, publish, write rows', () => {
  plugins({ repo: url, ref: 'v1.0.0' });
  lock({ config, cache, env, root });
  assert.equal(locked().plugins.pinboard.commit, commits['v1.0.0']);
  const result = deploy({ fresh: true });
  assert.ok(result.ok, result.log);
  for (const text of ['one', 'two', 'three']) db.sql('live', `INSERT INTO pinboard_note (id, workspace_id, board_id, text) VALUES (0, 1, 2, '${text}')`);
  assert.equal(rows(), 3);
  assert.ok(reducers());
});

test('upgrade: v1.1.0 locks and publishes as an update; rows remain, the new column is there', () => {
  plugins({ repo: url, ref: 'v1.1.0' });
  lock({ config, cache, env, root });
  const result = deploy();
  assert.ok(result.ok, result.log);
  assert.equal(rows(), 3);
  assert.match(db.sql('live', 'SELECT pinned FROM pinboard_note'), /false/);
});

test('incompatible upgrades are refused and leave the lock as it was', () => {
  const before = readFileSync(join(config, 'draw-plugins.lock.json'), 'utf8');
  plugins({ repo: url, ref: 'v2.0.0' });
  assert.throws(() => lock({ config, cache, env, root }), /column 'text' was String, is now U32/);
  plugins({ repo: url, ref: 'v2.1.0' });
  assert.throws(() => lock({ config, cache, env, root }), /changes public view my_pinboard_notes/);
  plugins({ repo: url, ref: 'v3.0.0' });
  assert.throws(() => lock({ config, cache, env, root }), /the lock drops its database schema/);
  assert.equal(readFileSync(join(config, 'draw-plugins.lock.json'), 'utf8'), before);
  plugins({ repo: url, ref: 'v1.1.0' });
});

test('a moved tag is refused by deploy fetch and by lock', () => {
  const git = (...args) => execFileSync('git', args, { cwd: repoDir });
  git('tag', '-f', 'v1.1.0', commits['v2.0.0']);
  try {
    assert.throws(() => fetchAll({ config, into: join(scratch, 'moved'), cache: join(scratch, 'cache-moved'), root, env }), /tag v1\.1\.0 now points at .*A moved tag is refused/);
    assert.throws(() => lock({ config, cache: join(scratch, 'cache-moved2'), env, root }), /A moved tag is refused/);
  } finally { git('tag', '-f', 'v1.1.0', commits['v1.1.0']); }
});

test('rollback: the older program is refused for the column it lacks, recognized, and the data stays', () => {
  const older = deploy({ ref: 'v1.0.0' });
  assert.equal(older.ok, false);
  const log = join(scratch, 'publish.log');
  writeFileSync(log, older.log);
  const recognized = spawnSync('sh', ['-c', `. "${join(root, 'docker/prod/rollback.sh')}"; older_program "${log}"`]);
  assert.equal(recognized.status, 0, older.log);
  assert.equal(rows(), 3);
  assert.ok(deploy().ok);
});

test('skip: the plugin code goes, its tables and rows stay; unskip brings the actions back', () => {
  plugins({ repo: url, ref: 'v1.1.0', skip: true });
  const skipped = deploy({ retain: true });
  assert.ok(skipped.ok, skipped.log);
  assert.equal(rows(), 3);
  assert.equal(reducers(), false);
  assert.equal(skipped.prepared.some(p => p.id === 'pinboard'), false);
  assert.match(readFileSync(join(skipped.work, 'module/src/plugin-meta.generated.ts'), 'utf8'), /"plugin": "pinboard"/);
  assert.doesNotMatch(readFileSync(join(skipped.work, 'module/src/plugin-meta.generated.ts'), 'utf8').split('PLUGIN_TABLES')[0], /pinboard/);
  plugins({ repo: url, ref: 'v1.1.0' });
  const back = deploy();
  assert.ok(back.ok, back.log);
  assert.ok(reducers());
  assert.equal(rows(), 3);
});

test('retire: the lock keeps the entry; tables and rows stay; dropping the entry is refused', () => {
  plugins({ retired: true });
  lock({ config, cache, env, root });
  assert.equal(locked().plugins.pinboard.retired, true);
  const retired = deploy({ retain: true });
  assert.ok(retired.ok, retired.log);
  assert.equal(rows(), 3);
  writeFileSync(join(config, 'draw-plugins.json'), JSON.stringify({ plugins: {} }));
  assert.throws(() => lock({ config, cache, env, root }), /drops 'pinboard', which has database tables/);
  plugins({ retired: true });
});

test('a hand-edited lock is caught by the build check and by check-lock', () => {
  const lockFile = join(config, 'draw-plugins.lock.json'), real = locked(), edited = structuredClone(real);
  const columns = edited.plugins.pinboard.schema.tables.pinboardNote.columns;
  columns[columns.findIndex(([name]) => name === 'text')][1] = { U32: [] };
  writeFileSync(lockFile, JSON.stringify(edited));
  const candidate = db.describe('live');
  assert.match(verifyLocked(candidate, edited, { pinboard: 'retired' }, ['pinboardNote', 'pinboardTag']).join('\n'), /table pinboard_note differs from the lock/);
  assert.deepEqual(verifyLocked(candidate, real, { pinboard: 'retired' }, ['pinboardNote', 'pinboardTag']), []);
  assert.match(lockProblems(real, edited).join('\n'), /column 'text' was String, is now U32/);
  writeFileSync(lockFile, JSON.stringify(real));
});

test('a local folder builds only in development; deploy builds refuse it', async () => {
  const { deployProblems, readConfig } = await import('./plugin-lock.mjs');
  plugins({ path: repoDir });
  assert.match(deployProblems(readConfig(config), locked(), ['versions']).join('\n'), /'pinboard' is a local folder; deploy builds take only repo \+ ref/);
  const work = join(scratch, 'work-local');
  assert.ok(prepare(root, work, { sources: { pinboard: repoDir }, modulesOnly: true }).some(p => p.id === 'pinboard'));
  plugins({ retired: true });
});

test('a client part compiles into the canvas; its canvas setting is read as VITE_<name>', () => {
  const into = join(scratch, 'sources-canvas'), work = join(scratch, 'work-canvas');
  fetchPlugin({ id: 'pinboard', repo: url, ref: 'v1.0.0' }, { into, cache, env: gitEnv(env, { credentials: null }) });
  assert.ok(prepare(root, work, { sources: { pinboard: join(into, 'pinboard') } }).find(p => p.id === 'pinboard').parts.client);
  const registry = readFileSync(join(work, 'client/src/plugins.generated.ts'), 'utf8');
  assert.match(registry, /import \* as plugin_pinboard from '\.\.\/\.\.\/plugins\/pinboard\/client\/index';/);
  assert.match(registry, /PINBOARD_BANNER: import\.meta\.env\.VITE_PINBOARD_BANNER \?\? ''/);
  const tsc = spawnSync(join(work, 'client/node_modules/.bin/tsc'), ['--noEmit', '-p', 'tsconfig.json'], { cwd: join(work, 'client'), encoding: 'utf8' });
  assert.equal(tsc.status, 0, tsc.stdout + tsc.stderr);
  // A type error in the plugin's canvas code fails the canvas check.
  writeFileSync(join(work, 'plugins/pinboard/client/index.ts'), "import type { CanvasPanel } from '@draw/canvas';\nexport const panel: CanvasPanel = { label: 1, mount() {} };\n");
  assert.notEqual(spawnSync(join(work, 'client/node_modules/.bin/tsc'), ['--noEmit', '-p', 'tsconfig.json'], { cwd: join(work, 'client') }).status, 0);
});
