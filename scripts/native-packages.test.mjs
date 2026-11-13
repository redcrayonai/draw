import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const fixture = () => mkdtempSync(join(tmpdir(), 'draw launcher '));
const write = (file, content, executable = false) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  if (executable) chmodSync(file, 0o755);
};

test('launcher resolves npm symlinks and nested or hoisted native packages with no JS runtime', () => {
  for (const nested of [true, false]) {
    const directory = fixture();
    try {
      const plugin = join(directory, 'node_modules/@redcrayonai/draw');
      const launcher = join(plugin, 'bin/draw');
      mkdirSync(dirname(launcher), { recursive: true });
      copyFileSync(join(root, 'plugin/bin/draw'), launcher);
      const native = join(nested ? join(plugin, 'node_modules/@redcrayonai') : dirname(plugin), `draw-${process.platform}-${process.arch}/draw`);
      write(native, '#!/bin/sh\nprintf "%s\\n" "$@"\nexit 7\n', true);
      const bin = join(directory, 'bin');
      mkdirSync(bin);
      symlinkSync('../node_modules/@redcrayonai/draw/bin/draw', join(bin, 'draw'));
      symlinkSync('draw', join(bin, 'redcrayon'));
      for (const name of ['draw', 'redcrayon']) {
        const result = spawnSync(join(bin, name), ['capture', '--repo', 'a folder', 'literal $text'], { env: { PATH: bin }, encoding: 'utf8' });
        assert.equal(result.status, 7, result.stderr);
        assert.equal(result.stdout, 'capture\n--repo\na folder\nliteral $text\n');
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
});

test('Darwin launcher prefers the shell architecture and accepts the other installed architecture', { skip: process.platform !== 'darwin' }, () => {
  const directory = fixture();
  try {
    const scope = join(directory, 'node_modules/@redcrayonai'), launcher = join(scope, 'draw/bin/draw');
    mkdirSync(dirname(launcher), { recursive: true });
    copyFileSync(join(root, 'plugin/bin/draw'), launcher);
    const machine = spawnSync('/usr/bin/uname', ['-m'], { encoding: 'utf8' }).stdout.trim();
    const preferred = machine === 'arm64' ? 'arm64' : 'x64', other = preferred === 'arm64' ? 'x64' : 'arm64';
    write(join(scope, `draw-darwin-${other}/draw`), '#!/bin/sh\nprintf fallback\n', true);
    const invoke = () => spawnSync(launcher, [], { env: { PATH: directory }, encoding: 'utf8' });
    assert.equal(invoke().stdout, 'fallback');
    write(join(scope, `draw-darwin-${preferred}/draw`), '#!/bin/sh\nprintf preferred\n', true);
    assert.equal(invoke().stdout, 'preferred');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('launcher reports missing optional package and preserves historical Node helper and chat-hook paths', () => {
  const directory = fixture();
  try {
    const bin = join(directory, 'bin');
    mkdirSync(bin);
    const launcher = join(bin, 'draw');
    copyFileSync(join(root, 'plugin/bin/draw'), launcher);
    const invoke = args => spawnSync(launcher, args, { env: { PATH: bin }, encoding: 'utf8' });
    assert.match(invoke(['--help']).stderr, /^UNAVAILABLE: .*optional dependencies enabled/);
    assert.equal(invoke(['--help']).status, 1);
    symlinkSync(process.execPath, join(bin, 'node'));
    for (const name of ['redcrayon', 'chat-hook']) write(join(bin, `${name}.mjs`), `console.log(JSON.stringify([${JSON.stringify(name)}, ...process.argv.slice(2)]));\n`);
    assert.deepEqual(JSON.parse(invoke(['capture', '--kind', 'ref']).stdout), ['redcrayon', 'capture', '--kind', 'ref']);
    assert.deepEqual(JSON.parse(invoke(['chat-hook', '--wait', '--codex']).stdout), ['chat-hook', '--wait', '--codex']);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('release stamping pins all native packages for stable and preview versions', () => {
  const directory = fixture();
  try {
    const files = ['plugin/package.json', 'plugin/.claude-plugin/plugin.json', 'plugin/.codex-plugin/plugin.json', 'helper/package.json'];
    for (const file of files) write(join(directory, file), readFileSync(join(root, file)));
    write(join(directory, 'helper/src/capture.ts'), "export const HELPER_VERSION = '1.0.2';\n");
    const stamp = version => spawnSync(process.execPath, [join(root, 'scripts/release-labels.mjs'), 'stamp-plugin', version], { cwd: directory, encoding: 'utf8' });
    for (const version of ['1.2.3', '1.3.0-rc.1', '1.3.0-rc-01']) {
      const result = stamp(version);
      assert.equal(result.status, 0, result.stderr);
      for (const file of files) assert.equal(JSON.parse(readFileSync(join(directory, file))).version, version);
      const manifest = JSON.parse(readFileSync(join(directory, files[0])));
      assert(Object.values(manifest.optionalDependencies).every(value => value === version));
      assert(readFileSync(join(directory, 'helper/src/capture.ts'), 'utf8').includes(`'${version}'`));
    }
    for (const bad of ['1.2', '01.2.3', '1.2.3-rc.01', '1.2.3-', '../1.2.3']) assert.equal(stamp(bad).status, 1, bad);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
