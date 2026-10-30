import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateGraph, graphDiff, edgeKey, proposalSatisfied, graphSignature } from './architecture.ts';

const node = (key, extra = {}) => ({ key, label: key, sublabel: '', kind: 'service', ...extra });
const edge = (from, to, extra = {}) => ({ from, to, relation: 'import', label: 'uses', evidence: 'import', ...extra });
const graph = (nodes, edges = []) => ({ nodes, edges, files: ['src/a.ts'] });

test('validation rejects duplicates, missing endpoints, invalid fields and oversized graphs', () => {
  assert.deepEqual(validateGraph(graph([node('a'), node('b')], [edge('a', 'b')])), graph([node('a'), node('b')], [edge('a', 'b')]));
  for (const raw of [null, graph([node('')]), graph([node('a'), node('a')]), graph([node('a')], [edge('a', 'b')]), graph([node('a', { kind: 'bogus' })]), graph([node('a')], [edge('a', 'a'), edge('a', 'a')]), graph(Array.from({ length: 5001 }, (_, i) => node(String(i))))]) {
    assert.throws(() => validateGraph(raw));
  }
  assert.notEqual(edgeKey('a:b', 'c', 'd'), edgeKey('a', 'b:c', 'd'));
  assert.equal(validateGraph(graph(Array.from({ length: 5000 }, (_, i) => node(String(i))))).nodes.length, 5000);
  assert.throws(() => validateGraph(graph([node('a'), node('b')], Array.from({ length: 20001 }, (_, i) => edge('a', 'b', { relation: String(i) })))), /limit/);
});

test('diff uses stable keys and reports semantic changes without ordering noise', () => {
  const base = graph([node('a'), node('b')], [edge('a', 'b')]);
  const head = graph([node('c'), node('a', { kind: 'datastore' })], [edge('a', 'c')]);
  assert.deepEqual(graphDiff(base, head), { addedNodes: ['c'], removedNodes: ['b'], changedNodes: ['a'], addedEdges: [edgeKey('a', 'c', 'import')], removedEdges: [edgeKey('a', 'b', 'import')], changedEdges: [] });
  assert.deepEqual(graphDiff(base, graph([...base.nodes].reverse(), base.edges)).changedNodes, []);
  assert.deepEqual(graphDiff(base, graph(base.nodes.map(n => ({ ...n, label: 'renamed' })), base.edges)).changedNodes, []);
  assert.deepEqual(graphDiff(base, graph(base.nodes, [edge('a', 'b', { evidence: 'test-import' })])).changedEdges, [edgeKey('a', 'b', 'import')]);
});

test('reconciliation checks only the proposal delta and requires proposed keys to be mapped', () => {
  const base = graph([node('a'), node('b')], [edge('a', 'b')]);
  const intent = graph([node('a', { kind: 'datastore' }), node('b'), node('c')], [edge('b', 'c', { evidence: '' })]);
  const reality = graph([node('a', { kind: 'datastore', label: 'new name' }), node('b', { sublabel: 'unrelated' }), node('c'), node('d')], [edge('b', 'c'), edge('c', 'd')]);
  assert.equal(proposalSatisfied(base, intent, reality), true);
  assert.equal(proposalSatisfied(base, intent, graph(reality.nodes, [...reality.edges, edge('a', 'b')])), false);
  assert.equal(proposalSatisfied(base, intent, graph(reality.nodes.map(n => n.key === 'a' ? node('a') : n), reality.edges)), false);
  assert.equal(proposalSatisfied(base, graph([...base.nodes, node('proposal:1')], base.edges), graph([...base.nodes, node('proposal:1')], base.edges)), false);
});

test('review signatures use exact identity order even for canonically equivalent unicode keys', () => {
  const a = graph([node('é'), node('e\u0301')]);
  assert.equal(graphSignature(a), graphSignature(graph([...a.nodes].reverse())));
});
