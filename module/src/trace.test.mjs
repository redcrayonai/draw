import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTraceSpans, MAX_TRACE_SPANS } from './trace.ts';

const on = new Set([1n, 2n, 3n]);
const parse = spans => parseTraceSpans(JSON.stringify(spans), id => on.has(id));
const span = (id, extra = {}) => ({ id, node: '1', startMs: 0, durationMs: 5, ...extra });

test('normalises spans: parent null and status ok by default', () => {
  const r = parse([span('a'), span('b', { parent: 'a', node: '2', startMs: 1, status: 'error' })]);
  assert.equal(r.ok, true);
  assert.deepEqual(JSON.parse(r.json), [
    { id: 'a', parent: null, node: '1', startMs: 0, durationMs: 5, status: 'ok' },
    { id: 'b', parent: 'a', node: '2', startMs: 1, durationMs: 5, status: 'error' },
  ]);
});

test('rejects any field outside the whitelist (no request data reaches a board)', () => {
  const r = parse([span('a', { attributes: { 'http.url': 'https://x/?email=a@b' } })]);
  assert.deepEqual(r, { ok: false, error: 'span 0 has fields outside id, parent, node, startMs, durationMs, status: attributes' });
});

test('rejects bad shapes, unknown nodes, bad numbers, dangling or self parents', () => {
  for (const [spans, error] of [
    [[], 'spans must be a non-empty array'],
    [[span('a'), span('a')], 'span id a repeats'],
    [[span('a', { node: '9' })], 'span a node 9 is not on this board'],
    [[span('a', { node: 1 })], 'span a node 1 is not on this board'],
    [[span('a', { durationMs: -1 })], 'span a durationMs must be a number from 0 to 600000'],
    [[span('a', { startMs: 'soon' })], 'span a startMs must be a number from 0 to 600000'],
    [[span('a', { parent: 'z' })], 'span a parent z is not in the trace'],
    [[span('a', { parent: 'a' })], 'span a is its own parent'],
    [[span('a', { status: 'timeout' })], 'span a status must be ok or error'],
    [Array.from({ length: MAX_TRACE_SPANS + 1 }, (_, i) => span(String(i))), `at most ${MAX_TRACE_SPANS} spans`],
  ]) {
    assert.deepEqual(parse(spans), { ok: false, error });
  }
  assert.deepEqual(parseTraceSpans('{', () => true), { ok: false, error: 'spans must be a JSON array' });
});
