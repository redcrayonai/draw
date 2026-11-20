import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EDGE_COLORS, HUES, NODE_COLORS, colorParts } from './colors.ts';

test('a node takes every hue at three strengths, an edge a hue only', () => {
  assert.equal(NODE_COLORS.length, HUES.length * 3);
  assert.ok(NODE_COLORS.includes('teal') && NODE_COLORS.includes('teal-soft') && NODE_COLORS.includes('teal-bold'));
  assert.deepEqual(EDGE_COLORS.filter(c => c.includes('-')), []);
});

test('colorParts splits the strength off and leaves anything else whole', () => {
  assert.deepEqual(colorParts('blue-bold'), { hue: 'blue', tone: 'bold' });
  assert.deepEqual(colorParts('yellow-soft'), { hue: 'yellow', tone: 'soft' });
  assert.deepEqual(colorParts('pink'), { hue: 'pink', tone: '' });
  assert.deepEqual(colorParts(''), { hue: '', tone: '' });
  assert.deepEqual(colorParts('blue-loud'), { hue: 'blue-loud', tone: '' });
});
