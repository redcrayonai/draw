// node --test scripts/live-drift.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { drift, liveReducers, parseReducerArgs } from './live-drift.mjs';

const T = { u64: { U64: [] }, string: { String: [] }, i32: { I32: [] } };
const opt = t => ({ Sum: { variants: [{ name: { some: 'some' }, algebraic_type: t }, { name: { some: 'none' }, algebraic_type: { Product: { elements: [] } } }] } });
const param = (name, algebraic_type) => ({ name: { some: name }, algebraic_type });
// The shape `spacetime describe --json` prints (2.8.1).
const describe = {
  sections: [
    { Typespace: { types: [] } },
    {
      Reducers: [
        { source_name: 'moveNode', params: { elements: [param('nodeId', T.u64), param('x', T.i32), param('y', T.i32)] } },
        { source_name: 'createEdge', params: { elements: [param('boardId', T.u64), param('label', T.string), param('evidenceSnippet', opt(T.string))] } },
        { source_name: 'unlinkAgent', params: { elements: [param('agent', { Product: { elements: [param('__identity__', { U256: [] })] } })] } },
      ],
    },
    { ExplicitNames: { entries: [{ Function: { source_name: 'moveNode', canonical_name: 'move_node' } }] } },
  ],
};

test('reads names, order, types and optionality from the describe output', () => {
  assert.deepEqual(liveReducers(describe), {
    move_node: [['nodeId', 'u64', false], ['x', 'i32', false], ['y', 'i32', false]],
    create_edge: [['boardId', 'u64', false], ['label', 'string', false], ['evidenceSnippet', 'string', true]],
    unlink_agent: [['agent', 'identity', false]],
  });
});

test('no drift when the signatures match; extra live reducers are ignored', () => {
  assert.deepEqual(drift({ move_node: [['nodeId', 'u64', false], ['x', 'i32', false], ['y', 'i32', false]] }, liveReducers(describe)), []);
});

test('no drift when the database reports the parameters in snake_case', () => {
  const snake = { sections: [{ Reducers: [{ source_name: 'moveNode', params: { elements: [param('node_id', T.u64), param('x', T.i32), param('y', T.i32)] } }] }] };
  assert.deepEqual(drift({ move_node: [['nodeId', 'u64', false], ['x', 'i32', false], ['y', 'i32', false]] }, liveReducers(snake)), []);
  assert.equal(drift({ move_node: [['nodeId', 'u64', false], ['y', 'i32', false]] }, liveReducers(snake)).length, 1);
});

test('reports a missing reducer, an added argument, a reorder, a type and an optionality change', () => {
  const live = liveReducers(describe);
  const lines = drift(
    {
      gone: [['id', 'u64', false]],
      create_edge: [['boardId', 'u64', false], ['label', 'string', false], ['evidenceSnippet', 'string', true], ['weight', 'u32', false]],
      move_node: [['nodeId', 'u64', false], ['y', 'i32', false], ['x', 'i32', false]],
      unlink_agent: [['agent', 'string', false]],
    },
    live
  );
  assert.equal(lines.length, 4);
  assert.match(lines[0], /^gone: missing on the database/);
  assert.match(lines[1], /^create_edge: the Worker calls \(.*weight: u32\)\n +the database has \(boardId: u64, label: string, evidenceSnippet\?: string\)$/);
  assert.match(lines[2], /^move_node: /);
  assert.match(lines[3], /^unlink_agent: /);
  assert.deepEqual(drift({ create_edge: [['boardId', 'u64', false], ['label', 'string', false], ['evidenceSnippet', 'string', false]] }, live).length, 1);
});

test('parses the committed reducers.gen.ts, every row', () => {
  const text = readFileSync(new URL('../mcp/src/reducers.gen.ts', import.meta.url), 'utf8');
  const args = parseReducerArgs(text);
  assert.equal(Object.keys(args).length, text.match(/^ {2}\w+: \[/gm).length);
  assert.deepEqual(args.move_node, [['nodeId', 'u64', false], ['x', 'i32', false], ['y', 'i32', false]]);
  assert.deepEqual(args.create_edge.at(-1), ['evidenceStatus', 'string', true]);
});
