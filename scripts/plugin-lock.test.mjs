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
