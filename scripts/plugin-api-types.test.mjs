// Needs module/node_modules (typescript); module-tests.yml runs it after the module install.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
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
