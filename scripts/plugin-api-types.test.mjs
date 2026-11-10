// Needs module/node_modules (typescript); module-tests.yml runs it after the module install.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { apiTypeProblems, compatSource } from './plugin-api-types.mjs';
import { exportedTypes } from './plugin-build.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const skip = !existsSync(join(root, 'module/node_modules/.bin/tsc')) && 'needs pnpm -C module install';
const BASE = `export const helper = (n: number): string => String(n);
export interface ModuleApi { spend: (ctx: unknown) => void; }
export type ModulePart = { tables: Record<string, unknown>; features?: () => void };
`;

function repo(t) {
  const dir = mkdtempSync(join(tmpdir(), 'draw-api-types-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'module/src'), { recursive: true });
  cpSync(join(root, 'module/tsconfig.json'), join(dir, 'module/tsconfig.json'));
  symlinkSync(join(root, 'module/node_modules'), join(dir, 'module/node_modules'));
  writeFileSync(join(dir, 'module/src/plugin-api.ts'), BASE);
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-q'); git('add', 'module/src', 'module/tsconfig.json');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base');
  return dir;
}
const check = (t, current) => {
  const dir = repo(t);
  writeFileSync(join(dir, 'module/src/plugin-api.ts'), current);
  return apiTypeProblems(dir, 'module', exportedTypes, 'HEAD');
};

test('compat source checks values once and types by direction', () => {
  const { text } = compatSource({ Module: 'src/plugin-api' }, () => ['ModuleApi', 'ModulePart']);
  assert.match(text, /export const valuesModule: typeof OldModule = NewModule;/);
  assert.match(text, /Is<\[NewModule\.ModuleApi\] extends \[OldModule\.ModuleApi\]/);
  assert.match(text, /Is<\[OldModule\.ModulePart\] extends \[NewModule\.ModulePart\]/);
});

test('unchanged and additive interfaces pass', { skip }, t => {
  assert.deepEqual(check(t, BASE), []);
  assert.deepEqual(check(t, `${BASE}export const added = 1;\n`), []);
  // draw hands ModuleApi to plugins: a new required member is fine for them
  assert.deepEqual(check(t, BASE.replace('spend: (ctx: unknown) => void;', 'spend: (ctx: unknown) => void; emit: () => void;')), []);
  // plugins hand ModulePart to draw: a new optional member is fine
  assert.deepEqual(check(t, BASE.replace('features?: () => void', 'features?: () => void; label?: string')), []);
});

test('breaking changes fail with the name and the compiler message', { skip }, t => {
  const cases = [
    [BASE.replace(/^export const helper.*\n/, ''), /values changed incompatibly.*'helper' is missing/],
    [BASE.replace('(n: number)', '(n: number, extra: string)'), /values changed incompatibly/],
    [BASE.replace('spend: (ctx: unknown) => void;', ''), /'ModuleApi' changed incompatibly/],
    [BASE.replace('features?: () => void', 'features?: () => void; label: string'), /'ModulePart' changed incompatibly/],
  ];
  for (const [source, pattern] of cases) {
    const problems = check(t, source);
    assert.equal(problems.length, 1, source);
    assert.match(problems[0], pattern);
    assert.match(problems[0], /^plugin rule: src\/plugin-api: .*a minor on 0\.x, a major from 1\.0/);
  }
});

test('the check leaves no files behind', { skip }, t => {
  const dir = repo(t);
  apiTypeProblems(dir, 'module', exportedTypes, 'HEAD');
  for (const file of ['module/.api-base', 'module/api-compat.generated.ts', 'module/tsconfig.api.json']) assert.equal(existsSync(join(dir, file)), false, file);
});

test('a checker that cannot run is a problem, not a pass', { skip }, t => {
  const dir = repo(t);
  rmSync(join(dir, 'module/node_modules'));
  const problems = apiTypeProblems(dir, 'module', exportedTypes, 'HEAD');
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^plugin rule: the interface check did not run: /);
});

test('a breaking-release label never excuses a check that could not run', { skip }, t => {
  const dir = repo(t);
  rmSync(join(dir, 'module/node_modules'));
  execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: dir }); // the CLI compares with origin/main
  mkdirSync(join(dir, 'scripts'));
  for (const name of ['plugin-build.mjs', 'plugin-lock.mjs', 'plugin-api-types.mjs']) cpSync(join(root, 'scripts', name), join(dir, 'scripts', name));
  const result = spawnSync(process.execPath, ['scripts/plugin-build.mjs', '--api-types', 'module'], { cwd: dir, encoding: 'utf8', env: { ...process.env, PLUGIN_API_MAJOR: 'true' } });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /the interface check did not run/);
});

test('the canvas interface is checked with the client\'s compiler, CanvasPart in the plugins-provide direction', { skip: !existsSync(join(root, 'client/node_modules/.bin/tsc')) && 'needs pnpm -C client install' }, t => {
  const dir = mkdtempSync(join(tmpdir(), 'draw-api-types-client-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'client/src'), { recursive: true });
  cpSync(join(root, 'client/tsconfig.json'), join(dir, 'client/tsconfig.json'));
  symlinkSync(join(root, 'client/node_modules'), join(dir, 'client/node_modules'));
  cpSync(join(root, 'client/src/plugin-api.ts'), join(dir, 'client/src/plugin-api.ts'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-q'); git('add', 'client');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base');
  const current = readFileSync(join(root, 'client/src/plugin-api.ts'), 'utf8');
  const run = source => { writeFileSync(join(dir, 'client/src/plugin-api.ts'), source); return apiTypeProblems(dir, 'client', exportedTypes, 'HEAD'); };
  assert.deepEqual(run(current), []);
  // draw hands Canvas to plugins: removing a member breaks them
  assert.match(run(current.replace(/  token\(\): Promise<string \| null>;\n/, '')).join('\n'), /'Canvas' changed incompatibly/);
  // plugins hand CanvasPart to draw: a new required member breaks plugins written for the old one
  assert.match(run(current.replace('export type CanvasPart = { panel?: CanvasPanel };', 'export type CanvasPart = { panel?: CanvasPanel; toolbar: string };')).join('\n'), /'CanvasPart' changed incompatibly/);
  for (const file of ['client/.api-base', 'client/api-compat.generated.ts', 'client/tsconfig.api.json']) assert.equal(existsSync(join(dir, file)), false, file);
});
