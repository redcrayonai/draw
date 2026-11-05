import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readPlugins, importProblems, generate } from './plugin-build.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const manifest = (id = 'sample') => ({ id, name: 'Sample', description: 'An optional feature.', settings: [], tables: {} });
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'draw-plugin-build-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function put(root, file, text) {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), text);
}
const plugin = (root, value = manifest(), folder = value.id) => put(root, `plugins/${folder}/plugin.json`, JSON.stringify(value));

test('reads minimal manifests in id order and discovers part directories', t => {
  const dir = fixture(t);
  plugin(dir, manifest('zeta'));
  plugin(dir, manifest('alpha'));
  plugin(dir, { id: 'bare', name: 'Sample', description: 'An optional feature.' });
  mkdirSync(join(dir, 'plugins/alpha/module'));
  mkdirSync(join(dir, 'plugins/alpha/web'));
  assert.deepEqual(readPlugins(dir), [
    { ...manifest('alpha'), parts: { module: true, server: false, web: true } },
    { ...manifest('bare'), parts: { module: false, server: false, web: false } },
    { ...manifest('zeta'), parts: { module: false, server: false, web: false } },
  ]);
});

test('manifest validation refuses missing, malformed and unknown fields', t => {
  const dir = fixture(t);
  const invalid = [
    null, [], {}, { ...manifest(), extra: true },
    ...['id', 'name', 'description'].map(key => { const m = manifest(); delete m[key]; return m; }),
    ...['a', '1bad', 'Bad', 'bad-id', 'a'.repeat(32), 1].map(id => ({ ...manifest(), id })),
    ...['', 'x'.repeat(41), 3].map(name => ({ ...manifest(), name })),
    ...['', 'x'.repeat(201), false].map(description => ({ ...manifest(), description })),
    ...['SETTING', null, ['bad'], ['A-B'], [1], ['OK', 'OK']].map(settings => ({ ...manifest(), settings })),
    ...[null, [], { 'Bad': { why: 'reason' } }, { 'bad-key': { why: 'reason' } },
      { table: null }, { table: {} }, { table: { why: '' } }, { table: { why: 'x'.repeat(81) } },
      { table: { why: 1 } }, { table: { why: 'reason', extra: true } },
      { table: { why: 'reason', board: 'part' } }, { table: { why: 'reason', board: true } },
    ].map(tables => ({ ...manifest(), tables })),
  ];
  for (const value of invalid) {
    plugin(dir, value, 'sample');
    assert.throws(() => readPlugins(dir), /plugin rule:/, JSON.stringify(value));
  }
  plugin(dir, manifest('other'), 'sample');
  assert.throws(() => readPlugins(dir), /plugin rule:.*folder/);
  put(dir, 'plugins/sample/plugin.json', '{broken');
  assert.throws(() => readPlugins(dir), /plugin rule:.*JSON/);
  rmSync(join(dir, 'plugins/sample/plugin.json'));
  assert.throws(() => readPlugins(dir), /plugin rule:.*plugin.json/);
});

test('aggregates errors, including shared settings and tables across plugins', t => {
  const dir = fixture(t);
  const data = { settings: ['SHARED'], tables: { sharedTable: { why: 'reason', board: 'outlives' } } };
  plugin(dir, { ...manifest('alpha'), ...data });
  plugin(dir, { ...manifest('bravo'), ...data, extra: 1 });
  assert.throws(() => readPlugins(dir), error => {
    const lines = error.message.split('\n');
    assert.ok(lines.length >= 3);
    assert.ok(lines.every(line => line.startsWith('plugin rule:')));
    assert.match(error.message, /SHARED/);
    assert.match(error.message, /sharedTable/);
    return true;
  });
});

test('each part allows its own alias and relative files, including imports in Svelte scripts', t => {
  const dir = fixture(t);
  plugin(dir);
  for (const [part, alias] of [['module', '@draw/module'], ['server', '@draw/server'], ['web', '@draw/client']]) {
    put(dir, `plugins/sample/${part}/child/feature.ts`, `
      import type { Hooks } from '${alias}';
      export { value } from '../helper';
      import '../helper.js';
      const lazy = import('./inside');
      const value = require('../helper');
      // import 'forbidden';
      /* require('forbidden') */
      const ordinary = "import 'forbidden'";
      const template = \`import('forbidden')\`;
      const pattern = /import('forbidden')/;
      if (true) /import('forbidden')/.test('');
      if ((true)) /require('forbidden')/.test('');
    `);
    put(dir, `plugins/sample/${part}/helper.js`, 'export const value = 1;');
  }
  put(dir, 'plugins/sample/web/View.svelte', `<p>import 'ordinary text'</p><script lang="ts">import { value } from './helper';</script>`);
  assert.deepEqual(importProblems(dir, readPlugins(dir)), []);
});

test('checks JavaScript and TypeScript module helper extensions', t => {
  const dir = fixture(t);
  plugin(dir);
  for (const extension of ['mjs', 'cjs', 'mts', 'cts']) {
    put(dir, `plugins/sample/module/helper.${extension}`, "import 'forbidden'");
  }
  assert.equal(importProblems(dir, readPlugins(dir)).length, 4);
});

test('imports refuse other interfaces, packages and escapes; tests are exempt', t => {
  const dir = fixture(t);
  plugin(dir);
  const bad = [
    "import { x } from '@draw/server'", "export { x } from '@draw/client'", "export * from 'node:fs'",
    "import 'package'", "import '$lib/secret'", "import '$env/static/private'",
    "import '@draw/module/internal'", "import '../../module/src/core'", "import '../server/feature'",
    "const x = import('package')", "const x = require('package')", "import(path)", "require(name)",
    "import('./' + name)", "require(`./${name}`)", "import('/absolute/path')",
    "import './child/../../server/feature'", "import './helper\\\\..\\\\..\\\\secret'",
    "const text = `value ${import('forbidden')}`",
    "allowed() / import('forbidden') / 2",
    "allowed.if() / import('forbidden') / 2",
    "const ratio = /allowed/ / import('forbidden') / 2",
  ];
  for (const source of bad) {
    put(dir, 'plugins/sample/module/feature.ts', source);
    const problems = importProblems(dir, readPlugins(dir));
    assert.ok(problems.length > 0, source);
    assert.ok(problems.every(p => p.startsWith('plugin rule:')), source);
  }
  put(dir, 'plugins/sample/module/feature.ts', "import './inside'");
  put(dir, 'plugins/sample/module/feature.test.ts', "import 'package'; import(path)");
  assert.deepEqual(importProblems(dir, readPlugins(dir)), []);
});

test('relative imports and part folders cannot escape through symlinks', t => {
  const dir = fixture(t);
  plugin(dir);
  put(dir, 'outside/helper.ts', 'export const value = 1;');
  put(dir, 'plugins/sample/module/feature.ts', "import './linked/helper'");
  symlinkSync(join(dir, 'outside'), join(dir, 'plugins/sample/module/linked'));
  assert.ok(importProblems(dir, readPlugins(dir)).length > 0);
  rmSync(join(dir, 'plugins/sample/module'), { recursive: true });
  symlinkSync(join(dir, 'outside'), join(dir, 'plugins/sample/module'));
  assert.ok(importProblems(dir, readPlugins(dir)).length > 0);
});

test('generates deterministic data-only metadata with sorted ids and manifest table order', t => {
  const dir = fixture(t);
  plugin(dir, { ...manifest('zeta'), tables: { zTable: { why: 'staging' }, aTable: { why: 'index', board: 'outlives' } } });
  plugin(dir, manifest('class'));
  const files = generate(dir, readPlugins(dir));
  assert.deepEqual([...files.keys()], ['module/src/plugin-meta.generated.ts']);
  const output = files.get('module/src/plugin-meta.generated.ts');
  assert.ok(output.startsWith('// Generated by scripts/plugin-build.mjs from plugins/*/plugin.json; do not edit.\n'));
  assert.match(output, /export const PLUGIN_IDS = \[\s*"class",\s*"zeta"\s*\] as const;/);
  assert.match(output, /export type PluginId = \(typeof PLUGIN_IDS\)\[number\];/);
  assert.ok(output.indexOf('"zTable"') < output.indexOf('"aTable"'));
  assert.match(output, /"plugin": "zeta"/);
  assert.match(output, /"board": "outlives"/);
  assert.ok(!output.includes('import '));
  assert.deepEqual(generate(dir, readPlugins(dir)), files);
});

test('committed metadata matches the manifests and Versions settings match the server config', () => {
  const plugins = readPlugins(root);
  for (const [file, output] of generate(root, plugins)) assert.equal(readFileSync(join(root, file), 'utf8'), output, file);
  const versions = plugins.find(p => p.id === 'versions');
  assert.equal(versions.description, 'Save versions of a board. Restore any one as a new private board; the original stays as it is.');
  const settings = [...readFileSync(join(root, 'docker/prod/dashboard.capnp'), 'utf8').matchAll(/name = "((?:VERSIONS_S3_|AWS_CONTAINER_)[A-Z_]+)"/g)].map(m => m[1]);
  assert.deepEqual(versions.settings, settings);
  assert.deepEqual(importProblems(root, plugins), []);
});

test('CLI writes generated files; --check fails stale output without writing anything', t => {
  const dir = fixture(t);
  plugin(dir);
  mkdirSync(join(dir, 'scripts'));
  cpSync(join(root, 'scripts/plugin-build.mjs'), join(dir, 'scripts/plugin-build.mjs'));
  const run = (...args) => spawnSync(process.execPath, ['scripts/plugin-build.mjs', ...args], { cwd: dir, encoding: 'utf8' });
  assert.equal(run('--check').status, 1);
  assert.equal(existsSync(join(dir, 'module')), false);
  assert.equal(run().status, 0);
  assert.equal(run('--check').status, 0);
  const output = 'module/src/plugin-meta.generated.ts';
  put(dir, output, 'stale');
  const result = run('--check');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /plugin rule:.*stale/);
  assert.equal(readFileSync(join(dir, output), 'utf8'), 'stale');
  put(dir, 'plugins/sample/module/feature.ts', "import 'forbidden'");
  assert.equal(run().status, 1);
  assert.equal(run('--check').status, 1);
  assert.equal(readFileSync(join(dir, output), 'utf8'), 'stale');
});
