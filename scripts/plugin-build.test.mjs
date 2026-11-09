import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readPlugins, importProblems, generate } from './plugin-build.mjs';
import * as build from './plugin-build.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const configFile = 'docker/prod/dashboard.capnp';
const startMarker = '    # plugin settings: scripts/plugin-build.mjs writes these from plugins/*/plugin.json';
const endMarker = '    # end of plugin settings';
const settingsRegion = `${startMarker}\n${endMarker}\n`;
const manifest = (id = 'sample') => ({ id, name: 'Sample', description: 'An optional feature.', settings: [], tables: {} });
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'draw-plugin-build-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  put(dir, configFile, settingsRegion);
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

test('the optional draw field must be a caret range and is kept', t => {
  const dir = fixture(t);
  plugin(dir, { ...manifest(), draw: '^0.2.0 || ^1.0.0' });
  assert.equal(readPlugins(dir)[0].draw, '^0.2.0 || ^1.0.0');
  for (const draw of [3, '>=1', '', '^1.2']) {
    plugin(dir, { ...manifest(), draw });
    assert.throws(() => readPlugins(dir), /plugin rule: plugins\/sample\/plugin\.json: draw must be a caret range/, String(draw));
  }
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

test('refuses JSX and TSX source instead of missing imports in JSX text', t => {
  const dir = fixture(t);
  plugin(dir);
  for (const extension of ['jsx', 'tsx']) {
    put(dir, `plugins/sample/web/helper.${extension}`, `<p>Don't skip this<button onClick={() => import('$lib/private')}>Run</button></p>`);
    assert.ok(importProblems(dir, readPlugins(dir)).some(problem => problem.includes(`helper.${extension}`) && problem.includes('JSX and TSX')));
  }
});

test('checks imports and require calls in Svelte markup expressions', t => {
  const dir = fixture(t);
  plugin(dir);
  const bad = [
    `<button onclick={() => import('$lib/private')}>Run</button>`,
    `<button onclick="{() => import('$lib/private')}">Run</button>`,
    `<Widget options={{ run: () => import('$lib/private') }} />`,
    `{import('$lib/private')}`,
    `{#await import('$lib/private')}{/await}`,
    `{#if visible}<p>Shown</p>{/if}{import('$lib/private')}`,
    `{#if visible}{:else if /}/.test('}') && import('$lib/private')}{/if}`,
    `<button onclick={() => require('$lib/private')}>Run</button>`,
    `{import(path)}`,
    `<button onclick={() => import('./' + name)}>Run</button>`,
    '{`value ${import("$lib/private")}`}',
    `<textarea><style></textarea>{import('$lib/private')}`,
    `<textarea><!-- {import('$lib/private')} --></textarea>`,
    `<style-guide><button onclick={() => import('$lib/private')}>Run</button></style-guide>`,
    `<script-widget>Don't skip<button onclick={() => import('$lib/private')}>Run</button></script-widget>`,
    `<textarea-panel><button onclick={() => import('$lib/private')}>Run</button></textarea-panel>`,
    `<Style><button onclick={() => import('$lib/private')}>Run</button></Style>`,
    `<textarea></textarea-other><style></textarea>{import('$lib/private')}`,
    `<textarea>Text</TEXTAREA><script>import '$lib/private';</script>`,
  ];
  for (const source of bad) {
    put(dir, 'plugins/sample/web/View.svelte', source);
    assert.ok(importProblems(dir, readPlugins(dir)).length > 0, source);
  }
  put(dir, 'plugins/sample/web/View.svelte', `
    <!-- {import('$lib/private')} <script>import '$lib/private'</script> -->
    <style>p { content: "import('$lib/private')"; }</style>
    <p>import('$lib/private')</p>
    <p title="import('$lib/private')">Text</p>
    <textarea><script>import('$lib/private')</script>{import('@draw/client')}</textarea>
    <p title="<style>">{import('@draw/client')}</p>
    <button onclick={() => { /* import('$lib/private') */ return import('@draw/client'); }}>Run</button>
    <Widget options={{ run: () => require('./helper') }} />
    {import('./helper')}
    {#if /}/.test('}')}<p>Shown</p>{/if}
    {"import('$lib/private')"}
  `);
  assert.deepEqual(importProblems(dir, readPlugins(dir)), []);
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
  assert.deepEqual([...files.keys()], ['module/src/plugin-meta.generated.ts', 'module/src/plugin-parts.generated.ts', 'web/src/lib/server/plugins.generated.ts', 'web/src/lib/plugins.generated.ts', configFile]);
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

test('generates sorted namespace imports and literal table spreads for present module entry points', t => {
  const dir = fixture(t);
  for (const id of ['zeta', 'default', 'absent']) plugin(dir, manifest(id));
  put(dir, 'plugins/zeta/module/index.ts', 'export const tables = {};');
  put(dir, 'plugins/default/module/index.ts', 'export const tables = {};');
  const output = generate(dir, readPlugins(dir)).get('module/src/plugin-parts.generated.ts');
  assert.equal(output, `// Generated by scripts/plugin-build.mjs from plugins/*/plugin.json; do not edit.
import * as plugin_default from '../../plugins/default/module/index';
import * as plugin_zeta from '../../plugins/zeta/module/index';
export const pluginTables = {
  ...plugin_default.tables,
  ...plugin_zeta.tables,
};
export const PLUGIN_PARTS = {
  default: plugin_default,
  zeta: plugin_zeta,
};
`);
});

test('retained plugins add only their tables, from rendered source, in id order', t => {
  const dir = fixture(t);
  plugin(dir, { ...manifest('zeta'), settings: ['ZETA_URL'], tables: { zNote: { why: 'notes' } } });
  for (const part of ['module', 'server', 'web']) put(dir, `plugins/zeta/${part}/index.ts`, 'export {};');
  const source = 'const retained_alpha = { tables: { aNote: retainedTable({}, { id: retainedT.u64() }) } };\n';
  const retained = [{ id: 'alpha', tables: { aNote: { why: 'alpha notes', board: 'outlives' } }, source }];
  const files = generate(dir, readPlugins(dir), retained);
  assert.equal(files.get('module/src/plugin-meta.generated.ts'), `// Generated by scripts/plugin-build.mjs from plugins/*/plugin.json; do not edit.
export const PLUGIN_IDS = [
  "zeta"
] as const;
export type PluginId = (typeof PLUGIN_IDS)[number];
export const PLUGIN_TABLES = {
  "aNote": {
    "plugin": "alpha",
    "why": "alpha notes",
    "board": "outlives"
  },
  "zNote": {
    "plugin": "zeta",
    "why": "notes"
  }
} as const;
`);
  assert.equal(files.get('module/src/plugin-parts.generated.ts'), `// Generated by scripts/plugin-build.mjs from plugins/*/plugin.json; do not edit.
import * as plugin_zeta from '../../plugins/zeta/module/index';
import { table as retainedTable, t as retainedT } from './plugin-api';
${source}export const pluginTables = {
  ...retained_alpha.tables,
  ...plugin_zeta.tables,
};
export const PLUGIN_PARTS = {
  alpha: retained_alpha,
  zeta: plugin_zeta,
};
`);
  const plain = generate(dir, readPlugins(dir));
  for (const file of ['web/src/lib/server/plugins.generated.ts', 'web/src/lib/plugins.generated.ts', configFile]) {
    assert.equal(files.get(file), plain.get(file), file);
    assert.ok(!files.get(file).includes('alpha'), file);
  }
});

test('retained plugins refuse bad ids, included ids and table collisions', t => {
  const dir = fixture(t);
  plugin(dir, { ...manifest('zeta'), tables: { zNote: { why: 'notes' } } });
  const kept = (id, tables = {}) => ({ id, tables, source: `const retained_${id} = { tables: {} };` });
  const cases = [
    [[kept('Bad')], /retained plugin id 'Bad'/],
    [[kept('zeta')], /retained plugin 'zeta' is also included/],
    [[kept('alpha'), kept('alpha')], /retained plugin 'alpha' is also included/],
    [[kept('alpha', { zNote: { why: 'x' } })], /retained table 'zNote' of 'alpha' is already owned by zeta/],
    [[kept('alpha', { aNote: { why: 'x' } }), kept('beta', { aNote: { why: 'x' } })], /retained table 'aNote' of 'beta' is already owned by alpha/],
  ];
  for (const [retained, message] of cases) assert.throws(() => generate(dir, readPlugins(dir), retained), message);
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
  for (const name of ['plugin-build.mjs', 'plugin-lock.mjs']) cpSync(join(root, 'scripts', name), join(dir, 'scripts', name));
  const run = (...args) => spawnSync(process.execPath, ['scripts/plugin-build.mjs', ...args], { cwd: dir, encoding: 'utf8' });
  assert.equal(run('--check').status, 1);
  assert.equal(existsSync(join(dir, 'module')), false);
  assert.equal(run().status, 0);
  assert.equal(run('--check').status, 0);
  for (const [file, content] of generate(dir, readPlugins(dir))) {
    put(dir, file, 'stale');
    const checked = run('--check');
    assert.equal(checked.status, 1);
    assert.match(checked.stderr, new RegExp(file));
    assert.equal(readFileSync(join(dir, file), 'utf8'), 'stale');
    put(dir, file, content);
  }
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


test('generates sorted server metadata, importing only existing server entry points', t => {
  const dir = fixture(t);
  for (const id of ['zeta', 'default', 'absent']) plugin(dir, manifest(id));
  put(dir, 'plugins/zeta/server/index.ts', 'export const configured = () => true;');
  put(dir, 'plugins/default/server/index.ts', 'export const handle = async () => new Response();');
  const output = generate(dir, readPlugins(dir)).get('web/src/lib/server/plugins.generated.ts');
  assert.ok(output);
  assert.match(output, /import type \{ ServerPart \} from '.\/plugin-api';/);
  assert.match(output, /import \* as plugin_default from '..\/..\/..\/..\/plugins\/default\/server\/index';/);
  assert.match(output, /import \* as plugin_zeta from '..\/..\/..\/..\/plugins\/zeta\/server\/index';/);
  assert.ok(output.indexOf('plugin_default from') < output.indexOf('plugin_zeta from'));
  assert.ok(!output.includes('plugin_absent'));
  assert.match(output, /export const PLUGIN_LIST.* = \[/);
  assert.ok(output.indexOf('"id": "absent"') < output.indexOf('"id": "default"'));
  assert.match(output, /server: plugin_default/);
  assert.match(output, /server\?: ServerPart/);
});


test('present part folders require an entry point instead of silently disappearing', t => {
  for (const part of ['module', 'server', 'web']) {
    const dir = fixture(t);
    plugin(dir);
    mkdirSync(join(dir, `plugins/sample/${part}`));
    assert.throws(() => generate(dir, readPlugins(dir)), new RegExp(`plugin rule: plugins/sample: missing ${part}/index\\.ts`));
  }
});

test('generates sorted web namespace imports only for present web entry points', t => {
  const dir = fixture(t);
  for (const id of ['zeta', 'default', 'absent']) plugin(dir, manifest(id));
  put(dir, 'plugins/zeta/web/index.ts', 'export const reset = () => {};');
  put(dir, 'plugins/default/web/index.ts', 'export const reset = () => {};');
  assert.equal(generate(dir, readPlugins(dir)).get('web/src/lib/plugins.generated.ts'), `// Generated by scripts/plugin-build.mjs from plugins/*/plugin.json; do not edit.
import type { WebPart } from './plugin-api';
import * as plugin_default from '../../../plugins/default/web/index';
import * as plugin_zeta from '../../../plugins/zeta/web/index';
export const WEB_PARTS: { id: string; web: WebPart }[] = [
  { id: 'default', web: plugin_default },
  { id: 'zeta', web: plugin_zeta },
];
`);
});


test('generates settings in plugin and manifest order, preserving all bytes outside the region', t => {
  const dir = fixture(t);
  plugin(dir, { ...manifest('zeta'), settings: ['LAST', 'THEN_THIS'] });
  plugin(dir, { ...manifest('alpha'), settings: ['FIRST'] });
  const prefix = 'bindings = [\n  # core comment\n  (name = "CORE", fromEnvironment = "CORE"),\n';
  const suffix = '];\n# keep this too\n';
  put(dir, configFile, prefix + startMarker + '\n    old generated bytes\n' + endMarker + '\n' + suffix);
  assert.equal(generate(dir, readPlugins(dir)).get(configFile), prefix + startMarker + '\n'
    + ['FIRST', 'LAST', 'THEN_THIS'].map(name => `    (name = "${name}", fromEnvironment = "${name}"),\n`).join('')
    + endMarker + '\n' + suffix);
});

test('settings refuse core binding collisions and missing or malformed regions', t => {
  const dir = fixture(t);
  plugin(dir, { ...manifest(), settings: ['CORE'] });
  for (const source of ['', startMarker, endMarker, endMarker + '\n' + startMarker,
    settingsRegion + settingsRegion, settingsRegion + endMarker + '\n', startMarker + '\n' + settingsRegion,
    '(name = "CORE", fromEnvironment = "OTHER"),\n' + settingsRegion,
    settingsRegion + '(name = "CORE", text = "existing"),\n']) {
    put(dir, configFile, source);
    assert.throws(() => generate(dir, readPlugins(dir)), /plugin rule:.*dashboard\.capnp/, source);
  }
  rmSync(join(dir, configFile));
  assert.throws(() => generate(dir, readPlugins(dir)), /dashboard\.capnp/);
});

test('exportedNames reads named declarations and aliases without comment or string exports', () => {
  assert.equal(typeof build.exportedNames, 'function');
  assert.deepEqual(build.exportedNames(`
    // export * from 'ignore'; export const Comment = 1;
    /* export interface Block {} */
    const text = "export const String = 1";
    const brace = "{";
    const template = \`export * from 'ignore'\`;
    const pattern = /export const Pattern/;
    export { alpha, beta as renamed, default as Button } from './other';
    export{local};
    export type { Shape, Input as Request };
    export { type Typed, type Other as Alias } from './types';
    export const constant = 1;
    export let mutable = 2;
    export function handler() {}
    export async function asyncHandler() {}
    export class Model {}
    export interface Options {}
    export type Status = string;
    export enum Kind { One }
    export { alpha };
  `), ['Alias', 'Button', 'Kind', 'Model', 'Options', 'Request', 'Shape', 'Status', 'Typed', 'alpha', 'asyncHandler', 'constant', 'handler', 'local', 'mutable', 'renamed']);
});

test('exportedNames refuses wildcard exports including namespace exports', () => {
  assert.equal(typeof build.exportedNames, 'function');
  for (const source of ["export * from './other';", "export * as namespace from './other';", "export type * from './other';"]) {
    assert.throws(() => build.exportedNames(source), /wildcard/);
  }
});

test('exportedNames includes later variable declarations and generator functions', () => {
  assert.deepEqual(build.exportedNames(`
    export const first = { nested: [1, 2] }, second = call(1, 2);
    export let third = 3, fourth = () => ({ nested: [3, 4] });
    export const text = \`value: \${first, second}\`, afterTemplate = 5;
    export function* iterate() { yield 1; }
    export async function* asyncIterate() { yield 2; }
  `), ['afterTemplate', 'asyncIterate', 'first', 'fourth', 'iterate', 'second', 'text', 'third']);
});

test('exportedNames refuses destructured declarations rather than missing their names', () => {
  for (const source of [
    'export const { first, second } = source;',
    'export let [first, second] = source;',
    'export const first = 1, { second } = source;',
  ]) assert.throws(() => build.exportedNames(source), /destructur/);
});

test('exportedNames keeps later bindings after const assertions and keyword properties', () => {
  assert.deepEqual(build.exportedNames(`
    export const first = 1 as const, second = 2;
    export const property = source.const, afterProperty = source.export;
  `), ['afterProperty', 'first', 'property', 'second']);
});

test('exportedNames keeps generic annotation commas inside the type', () => {
  assert.deepEqual(build.exportedNames(`
    export const values: Map<string, number> = new Map();
    export let nested: Map<string, Array<number>>, other: Set<string>;
    export const factory: () => Map<string, number> = make, afterFactory = 2;
    export let callback: Map<() => number, string>, afterCallback: number;
  `), ['afterCallback', 'afterFactory', 'callback', 'factory', 'nested', 'other', 'values']);
});

test('exportedNames fails closed on unrecognized export declarations', () => {
  for (const source of [
    'export declare function external(): void;',
    'export default function main() {}',
    'export namespace Nested {}',
    'export const enum Kind { One }',
  ]) assert.throws(() => build.exportedNames(source), /unsupported.*export/);
});

function git(dir, ...args) {
  const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function baseline(dir) {
  git(dir, 'init', '-q');
  git(dir, 'add', '.');
  git(dir, '-c', 'user.name=Plugin Test', '-c', 'user.email=plugin@example.test', 'commit', '-qm', 'baseline');
  git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
}

test('API gate compares names with git, permitting additions and newly introduced interface files', t => {
  assert.equal(typeof build.apiProblems, 'function');
  const dir = fixture(t), file = 'module/src/plugin-api.ts';
  put(dir, file, 'export const before = 1; export type Kept = string;');
  baseline(dir);
  put(dir, file, 'export const after = 1; export type Kept = number;');
  put(dir, 'web/src/lib/plugin-api.ts', 'export const first = 1;');
  assert.deepEqual(build.apiProblems(dir), [`${file}: removes 'before' from the plugin interface; that needs a major release`]);
  put(dir, file, 'export const before = 2; export const added = 1; export type Kept = number;');
  assert.deepEqual(build.apiProblems(dir), []);
  rmSync(join(dir, file));
  assert.deepEqual(build.apiProblems(dir), [
    `${file}: removes 'Kept' from the plugin interface; that needs a major release`,
    `${file}: removes 'before' from the plugin interface; that needs a major release`,
  ]);
  assert.throws(() => build.apiProblems(dir, 'invalid-reference'), /invalid-reference/);
  const outsideGit = fixture(t);
  assert.throws(() => build.apiProblems(outsideGit), /git|repository/i);
});

test('API gate catches removals of later variable declarations and generator exports', t => {
  const dir = fixture(t), file = 'module/src/plugin-api.ts';
  put(dir, file, `
    export const first = 1, second = 2;
    export let third = 3, fourth = 4;
    export function* iterate() {}
    export async function* asyncIterate() {}
  `);
  baseline(dir);
  put(dir, file, 'export const first = 1; export let third = 3;');
  assert.deepEqual(build.apiProblems(dir), ['asyncIterate', 'fourth', 'iterate', 'second'].map(name =>
    `${file}: removes '${name}' from the plugin interface; that needs a major release`));
});

test('API gate catches removal of a later binding after a const assertion', t => {
  const dir = fixture(t), file = 'module/src/plugin-api.ts';
  put(dir, file, 'export const first = 1 as const, second = 2;');
  baseline(dir);
  put(dir, file, 'export const first = 1 as const;');
  assert.deepEqual(build.apiProblems(dir), [
    `${file}: removes 'second' from the plugin interface; that needs a major release`,
  ]);
});

test('CLI API major override permits only removals and combined checks still refuse stale files', t => {
  const dir = fixture(t), file = 'module/src/plugin-api.ts';
  plugin(dir);
  put(dir, file, 'export const removed = 1;');
  mkdirSync(join(dir, 'scripts'));
  for (const name of ['plugin-build.mjs', 'plugin-lock.mjs']) cpSync(join(root, 'scripts', name), join(dir, 'scripts', name));
  const run = (major, ...args) => spawnSync(process.execPath, ['scripts/plugin-build.mjs', ...args], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, PLUGIN_API_MAJOR: major },
  });
  assert.equal(run('', '--unexpected').status, 1);
  assert.equal(run('').status, 0);
  baseline(dir);
  put(dir, file, '');
  const refused = run('', '--check', '--api');
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /removes 'removed'/);
  assert.equal(run('false', '--check', '--api').status, 1);
  assert.equal(run('true', '--check', '--api').status, 0);
  put(dir, 'module/src/plugin-meta.generated.ts', 'stale');
  assert.equal(run('true', '--check', '--api').status, 1);
  assert.equal(readFileSync(join(dir, 'module/src/plugin-meta.generated.ts'), 'utf8'), 'stale');
  assert.equal(run('true').status, 0);
  put(dir, 'plugins/sample/module/index.ts', 'export const tables = {};');
  assert.equal(run('true').status, 0);
  put(dir, 'plugins/sample/module/index.ts', "import 'forbidden';");
  const badImport = run('true', '--check', '--api');
  assert.equal(badImport.status, 1);
  assert.match(badImport.stderr, /import 'forbidden'/);
  rmSync(join(dir, 'plugins/sample/module'), { recursive: true });
  assert.equal(run('true').status, 0);
  plugin(dir, { ...manifest(), extra: true });
  const badManifest = run('true', '--check', '--api');
  assert.equal(badManifest.status, 1);
  assert.match(badManifest.stderr, /unknown field 'extra'/);
  plugin(dir);
  put(dir, file, "export * from './other';");
  const wildcard = run('true', '--check', '--api');
  assert.equal(wildcard.status, 1);
  assert.match(wildcard.stderr, /wildcard/);
  put(dir, file, '');
  git(dir, 'update-ref', '-d', 'refs/remotes/origin/main');
  assert.equal(run('true', '--api').status, 1);
  assert.equal(run('true', '--check').status, 0);
});
