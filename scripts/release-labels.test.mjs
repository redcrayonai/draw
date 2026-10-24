import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextTag, parseLabels, plan } from './release-labels.mjs';

test('release labels need a component and exactly one bump', () => {
  assert.deepEqual(parseLabels(['bug', 'size:S']), { components: [], bump: null });
  assert.deepEqual(parseLabels(['release:plugin', 'minor']), { components: ['plugin'], bump: 'minor' });
  assert.throws(() => parseLabels(['release:plugin']), /exactly one of major, minor, patch; found none/);
  assert.throws(() => parseLabels(['release:plugin', 'major', 'patch']), /exactly one/);
  assert.throws(() => parseLabels(['minor']), /needs a release:<component>/);
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

test('plan releases the plugin, the one component here', () => {
  assert.deepEqual(plan(['release:plugin', 'minor'], ['plugin-v1.0.2'], () => '1.0.1'), [
    { component: 'plugin', tag: 'plugin-v1.1.0', last: 'plugin-v1.0.2' },
  ]);
  assert.throws(() => plan(['release:core', 'minor'], []), /unknown label release:core/);
});
