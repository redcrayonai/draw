import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { publicWire, wireDifferences } from './check-wire-compat.mjs';

const u64 = { U64: [] };
const string = { String: [] };
const field = (name, algebraic_type) => ({ name: { some: name }, algebraic_type });
const product = (...elements) => ({ Product: { elements } });
const option = type => ({ Sum: { variants: [field('some', type), field('none', product())] } });
const row = () => product(field('id', u64), field('label', string), field('details', { Array: { Ref: 1 } }));

// Pinned CLI's actual V10 describe representation, including private storage
// behind a public view and separately declared view primary keys.
function schema() {
  return { sections: [
    { Typespace: { types: [row(), product(field('source', option(string)))] } },
    { Tables: [{ source_name: 'edge', product_type_ref: 0, primary_key: [0], table_access: { Private: [] }, is_event: false }] },
    { Views: [{ source_name: 'visibleEdge', is_public: true, is_anonymous: false, params: { elements: [] }, return_type: { Array: { Ref: 0 } } }] },
    { ExplicitNames: { entries: [{ Function: { source_name: 'visibleEdge', canonical_name: 'visible_edge' } }] } },
    { ViewPrimaryKeys: [{ view_source_name: 'visibleEdge', columns: ['id'] }] },
  ] };
}
const section = (schema, name) => schema.sections.find(value => name in value)[name];

test('resolves structural refs and permits private storage expansion plus a new public view', () => {
  const before = schema();
  const after = schema();
  const types = section(after, 'Typespace').types;
  types.unshift({ Bool: [] });
  types[1].Product.elements[2].algebraic_type.Array.Ref = 2;
  section(after, 'Views')[0].return_type.Array.Ref = 1;
  types.push(product(...types[1].Product.elements, field('latency', { F32: [] })));
  section(after, 'Tables')[0].product_type_ref = 3;
  section(after, 'Views').push({ source_name: 'edgeLatency', is_public: true, is_anonymous: false, params: { elements: [] }, return_type: { Array: { Ref: 3 } } });
  section(after, 'ExplicitNames').entries.push({ Function: { source_name: 'edgeLatency', canonical_name: 'edge_latency' } });
  assert.deepEqual(wireDifferences(before, after), []);
});

test('rejects the RC-603 append even when it is a migration default on private storage', () => {
  const after = schema();
  section(after, 'Typespace').types[0].Product.elements.push(field('latency_ms', { F32: [] }));
  section(after, 'Tables')[0].default_values = [{ col_id: 3, value: '000080bf' }];
  assert.match(wireDifferences(schema(), after).join('\n'), /visible_edge.*changed/);
});

test('compares ordered nested products, arrays and option/enum payloads rather than coarse type labels', () => {
  const mutations = [
    module => section(module, 'Typespace').types[0].Product.elements.reverse(),
    module => { section(module, 'Typespace').types[0].Product.elements[1].name.some = 'name'; },
    module => { section(module, 'Typespace').types[1].Product.elements[0].algebraic_type.Sum.variants[0].algebraic_type = u64; },
    module => { section(module, 'Typespace').types[1].Product.elements[0].algebraic_type.Sum.variants.reverse(); },
    module => { section(module, 'Typespace').types[0].Product.elements[2].algebraic_type = { Array: string }; },
  ];
  for (const mutate of mutations) {
    const after = schema();
    mutate(after);
    assert.equal(wireDifferences(schema(), after).length, 1);
  }
});

test('rejects removed/privatized/renamed public names and changed primary keys or view parameters', () => {
  for (const mutate of [
    module => { section(module, 'Views').length = 0; },
    module => { section(module, 'Views')[0].is_public = false; },
    module => { section(module, 'ExplicitNames').entries[0].Function.canonical_name = 'visible_edge_v2'; },
    module => { section(module, 'ViewPrimaryKeys')[0].columns = ['label']; },
    module => { section(module, 'Views')[0].params.elements.push(field('filter', string)); },
    module => { section(module, 'Views')[0].is_anonymous = true; },
  ]) {
    const after = schema();
    mutate(after);
    assert.equal(wireDifferences(schema(), after).length, 1);
  }
});

test('also protects public tables while allowing unrelated private rows to change', () => {
  const before = schema();
  section(before, 'Tables')[0].table_access = { Public: [] };
  const after = structuredClone(before);
  section(after, 'Tables')[0].primary_key = [1];
  assert.match(wireDifferences(before, after).join('\n'), /edge.*changed/);
  assert.equal(Object.keys(publicWire(before)).length, 2);
});

test('canonical names survive source renames and explicit case conversion policies', () => {
  const after = schema();
  section(after, 'Views')[0].source_name = 'renamedInSource';
  section(after, 'ExplicitNames').entries[0].Function.source_name = 'renamedInSource';
  section(after, 'ViewPrimaryKeys')[0].view_source_name = 'renamedInSource';
  assert.deepEqual(wireDifferences(schema(), after), []);
  const implicit = schema();
  section(implicit, 'ExplicitNames').entries.length = 0;
  assert.deepEqual(wireDifferences(schema(), implicit), []);
  implicit.sections.push({ CaseConversionPolicy: { None: [] } });
  assert.deepEqual(Object.keys(publicWire(implicit)), ['visibleEdge']);
});

test('fails closed on unsupported or malformed metadata and reachable types', () => {
  const bad = [
    {}, { typespace: { types: [] }, tables: [], misc_exports: [] },
    { sections: [] },
    ...[
      module => { module.sections.push({ Submodules: [{}] }); },
      module => { module.sections.push({ FutureSchema: [] }); },
      module => { module.sections.push({ Views: [] }); },
      module => { section(module, 'Views')[0].return_type.Array.Ref = 99; },
      module => { section(module, 'Typespace').types[1] = { Ref: 0 }; },
      module => { section(module, 'Typespace').types[1] = { FutureType: [] }; },
      module => { section(module, 'Views')[0].is_public = 'yes'; },
    ].map(mutate => { const module = schema(); mutate(module); return module; }),
  ];
  for (const module of bad) assert.throws(() => wireDifferences(schema(), module));
  const empty = schema();
  section(empty, 'Views').length = 0;
  assert.throws(() => wireDifferences(empty, schema()), /no public/);
});

test('CLI rejects incompatible schemas before deployment and exits cleanly for a compatible one', () => {
  const root = mkdtempSync(join(tmpdir(), 'wire-compat-'));
  try {
    const baseline = join(root, 'baseline.json');
    const candidate = join(root, 'candidate.json');
    writeFileSync(baseline, JSON.stringify(schema()));
    writeFileSync(candidate, JSON.stringify(schema()));
    const command = new URL('./check-wire-compat.mjs', import.meta.url).pathname;
    assert.equal(spawnSync(process.execPath, [command, baseline, candidate]).status, 0);
    const incompatible = schema();
    section(incompatible, 'Typespace').types[0].Product.elements.push(field('extra', string));
    writeFileSync(candidate, JSON.stringify(incompatible));
    const result = spawnSync(process.execPath, [command, baseline, candidate], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /visible_edge/);
    writeFileSync(candidate, '{}');
    assert.equal(spawnSync(process.execPath, [command, baseline, candidate]).status, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
