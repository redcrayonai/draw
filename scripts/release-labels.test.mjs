import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apiBreak, nextTag, parseLabels, plan } from './release-labels.mjs';

test('release labels need a component and exactly one bump', () => {
  assert.deepEqual(parseLabels(['bug', 'size:S']), { components: [], bump: null });
  assert.deepEqual(parseLabels(['release:plugin', 'release:mcp', 'minor']), { components: ['plugin', 'mcp'], bump: 'minor' });
  assert.throws(() => parseLabels(['release:plugin']), /exactly one of major, minor, patch; found none/);
  assert.throws(() => parseLabels(['release:plugin', 'major', 'patch']), /exactly one/);
  assert.throws(() => parseLabels(['minor']), /needs a release:<component>/);
  assert.deepEqual(parseLabels(['major', 'dependencies'], 'dependabot[bot]'), { components: [], bump: null });
  assert.deepEqual(plan(['major', 'dependencies'], [], undefined, 'dependabot[bot]'), []);
  assert.throws(() => parseLabels(['major', 'dependencies'], 'someone'), /needs a release:<component>/);
  assert.deepEqual(parseLabels(['release:core', 'patch', 'dependencies'], 'dependabot[bot]'), { components: ['core'], bump: 'patch' });
  assert.throws(() => parseLabels(['release:core', 'dependencies'], 'dependabot[bot]'), /exactly one/);
  assert.throws(() => parseLabels(['release:web', 'patch']), /unknown label release:web/);
});

test('the next tag follows the highest own tag, never another component', () => {
  const tags = ['v0.9.0', 'v0.10.0', 'v0.2.0', 'plugin-v3.0.0', 'mcp-v9.9.9', 'vnext', 'v1.0.0-rc.1'];
  assert.deepEqual(nextTag('v', tags, 'patch'), { tag: 'v0.10.1', last: 'v0.10.0' });
  assert.deepEqual(nextTag('v', tags, 'minor'), { tag: 'v0.11.0', last: 'v0.10.0' });
  assert.deepEqual(nextTag('plugin-v', tags, 'major'), { tag: 'plugin-v4.0.0', last: 'plugin-v3.0.0' });
});

test('with no tag yet the seed version is the base', () => {
  assert.deepEqual(nextTag('plugin-v', [], 'patch', '1.0.1'), { tag: 'plugin-v1.0.2', last: null });
  assert.deepEqual(nextTag('v', [], 'minor'), { tag: 'v0.1.0', last: null });
  // a hand bump in the files above the last tag wins
  assert.deepEqual(nextTag('mcp-v', ['mcp-v0.1.0'], 'patch', '0.3.0'), { tag: 'mcp-v0.3.1', last: 'mcp-v0.1.0' });
});

test('plan releases every labelled component with one bump', () => {
  const seed = c => ({ plugin: '1.0.1', mcp: '0.1.0', core: '0.0.0' })[c];
  assert.deepEqual(plan(['release:plugin', 'release:core', 'minor'], ['plugin-v1.0.2'], seed), [
    { component: 'plugin', tag: 'plugin-v1.1.0', last: 'plugin-v1.0.2' },
    { component: 'core', tag: 'v0.1.0', last: null },
  ]);
});

test('a core minor may break the plugin interface on 0.x; from 1.0 only a major may', () => {
  const zero = ['v0.2.1', 'v0.1.0', 'plugin-v1.0.3'], one = ['v1.4.0', 'v0.9.0'];
  assert.equal(apiBreak(['release:core', 'minor'], zero), true);
  assert.equal(apiBreak(['release:core', 'minor'], []), true);
  assert.equal(apiBreak(['release:core', 'minor'], one), false);
  assert.equal(apiBreak(['release:core', 'major'], one), true);
  assert.equal(apiBreak(['release:core', 'patch'], zero), false);
  assert.equal(apiBreak(['release:plugin', 'minor'], zero), false);
  assert.equal(apiBreak([], zero), false);
});
