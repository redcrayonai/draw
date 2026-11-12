import { test } from 'node:test';
import assert from 'node:assert/strict';
import { audienceKey, parseTellingSteps, remapTellingSteps, tellingHeadError } from './tellings.ts';

const yes = () => true;
const err = (json, onBoard = yes) => {
  const r = parseTellingSteps(json, onBoard);
  assert.equal(r.ok, false);
  return r.error;
};
const step = (o) => JSON.stringify([{ nodes: ['1'], title: 'A', body: 'B', ...o }]);

test('parses and normalises a step', () => {
  const r = parseTellingSteps('[{"nodes":["1"],"title":"A","body":"B"}]', yes);
  assert.equal(r.ok, true);
  const want = { nodes: ['1'], frame: [], title: 'A', body: 'B', source: '' };
  assert.deepEqual(r.steps[0], want);
  assert.deepEqual(JSON.parse(r.json), [want]);
});

test('trims strings and drops duplicate ids', () => {
  const r = parseTellingSteps(step({ nodes: ['1', '1', '2'], title: ' A ', source: ' s ' }), yes);
  assert.deepEqual(r.steps[0].nodes, ['1', '2']);
  assert.equal(r.steps[0].title, 'A');
  assert.equal(r.steps[0].source, 's');
});

test('rejects bad steps with exact sentences', () => {
  assert.equal(err('nope'), 'steps must be a JSON array');
  assert.equal(err('[]'), 'steps must be a non-empty array');
  assert.equal(err(JSON.stringify(Array(13).fill({ nodes: ['1'], title: 'A', body: 'B' }))), 'at most 12 steps');
  assert.equal(err(step({ extra: 1 })), 'step 0 has fields outside nodes, frame, title, body, source: extra');
  assert.equal(err(step({ nodes: [] })), 'step 0 must light 1 to 12 nodes');
  assert.equal(err(step({ nodes: '1' })), 'step 0 must light 1 to 12 nodes');
  assert.equal(err(step({ nodes: ['7'] }),(id) => id !== 7n), 'step 0 names node 7, which is not on this board');
  assert.equal(err(step({ frame: ['7'] }), (id) => id !== 7n), 'step 0 names node 7, which is not on this board');
  assert.equal(err(step({ nodes: ['x'] })), 'step 0 names node x, which is not on this board');
  assert.equal(err(step({ frame: Array.from({ length: 13 }, (_, i) => String(i + 1)) })), 'step 0 frame must be at most 12 nodes');
  assert.equal(err(step({ title: 'a'.repeat(81) })), 'step 0 title must be 1 to 80 characters');
  assert.equal(err(step({ body: 'a'.repeat(281) })), 'step 0 body must be 1 to 280 characters');
  assert.equal(err(step({ body: undefined })), 'step 0 body must be 1 to 280 characters');
  assert.equal(err(step({ source: 'a'.repeat(201) })), 'step 0 source must be at most 200 characters');
});

test('audience key and head rules', () => {
  assert.equal(audienceKey('  Product   Managers '), 'product managers');
  assert.equal(tellingHeadError('', 'T'), 'audience must be 1 to 40 characters');
  assert.equal(tellingHeadError('A', ''), 'title must be 1 to 120 characters');
  assert.equal(tellingHeadError(' A ', ' T '), null);
  assert.equal(tellingHeadError('a'.repeat(41), 'T'), 'audience must be 1 to 40 characters');
});

test('remap drops ids mapped to 0 and leaves bad json alone', () => {
  const json = JSON.stringify([{ nodes: ['1', '2'], frame: ['2', '3'], title: 'A', body: 'B', source: '' }]);
  const out = JSON.parse(remapTellingSteps(json, (id) => (id === 2n ? 0n : id + 10n)));
  assert.deepEqual(out[0].nodes, ['11']);
  assert.deepEqual(out[0].frame, ['13']);
  assert.equal(remapTellingSteps('not json', (id) => id), 'not json');
});
