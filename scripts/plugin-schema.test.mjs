import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pluginSchema, schemaProblems, renderRetained } from './plugin-schema.mjs';

// Trimmed from the pinned database's describe output (spike S1, 2026-11-09).
const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/describe/${name}.json`, import.meta.url), 'utf8'));
const VERSIONS = { boardVersion: { why: 'index', board: 'outlives' }, boardVersionChunk: { why: 'staging' }, versionCooldown: { why: 'rate limit' } };
const versions = () => pluginSchema(fixture('versions'), fixture('core'), VERSIONS);
const clone = value => structuredClone(value);
const only = (problems, pattern) => { assert.equal(problems.length, 1, problems.join('\n')); assert.match(problems[0], pattern); };

test('pluginSchema reads Versions: tables, TypeScript keys, constraints and its public view', () => {
  const { schema, problems } = versions();
  assert.deepEqual(problems, []);
  assert.deepEqual(Object.keys(schema.tables).sort(), ['boardVersion', 'boardVersionChunk', 'versionCooldown']);
  const table = schema.tables.boardVersion;
  assert.equal(table.name, 'board_version');
  assert.equal(table.public, false);
  assert.deepEqual(table.columns.slice(0, 3), [['id', { U64: [] }], ['workspace_id', { U64: [] }], ['board_id', { U64: [] }]]);
  assert.deepEqual(table.keys, { object_key: 'objectKey', board_id: 'boardId', workspace_id: 'workspaceId' });
  assert.deepEqual(table.primaryKey, ['id']);
  assert.deepEqual(table.autoInc, ['id']);
  assert.deepEqual(table.unique, [['id'], ['object_key']]);
  assert.deepEqual(table.indexes.map(i => i.name), ['boardVersion_boardId_idx_btree', 'boardVersion_id_idx_btree', 'boardVersion_objectKey_idx_btree', 'boardVersion_workspaceId_idx_btree']);
  assert.deepEqual(Object.keys(schema.wire), ['my_board_versions']);
  assert.equal('default_values' in table, false);
});

test('pluginSchema keeps named types and multi-column indexes', () => {
  const { schema, problems } = pluginSchema(fixture('meta'), fixture('core'), { versionMeta: { why: 'spike' } });
  assert.deepEqual(problems, []);
  assert.deepEqual(schema.types, { PinMeta: { Product: [['a', { U32: [] }], ['b', { String: [] }]] }, PinKind: { Sum: [['plain', { Product: [] }], ['weight', { U32: [] }]] } });
  assert.deepEqual(schema.tables.versionMeta.columns.map(([n, t]) => [n, Object.keys(t)[0]]), [['id', 'U64'], ['meta', 'Named'], ['tag', 'Sum'], ['kind', 'Named'], ['list', 'Array']]);
  assert.deepEqual(schema.tables.versionMeta.indexes[1], { name: 'versionMeta_id_list_idx_btree', accessor: 'byKindTag', algorithm: 'btree', columns: ['id', 'list'] });
});

test('pluginSchema problems: undeclared, missing, board_id without outlives, scheduled, unsupported types', () => {
  const { boardVersion, ...rest } = VERSIONS;
  assert.match(pluginSchema(fixture('versions'), fixture('core'), rest).problems.join('\n'), /table 'boardVersion' is not declared in plugin\.json/);
  assert.match(pluginSchema(fixture('versions'), fixture('core'), { ...VERSIONS, ghost: { why: 'x' } }).problems.join('\n'), /table 'ghost' is declared in plugin\.json but missing from the database/);
  only(pluginSchema(fixture('versions'), fixture('core'), { ...VERSIONS, boardVersion: { why: 'x' } }).problems, /table 'boardVersion' has a board_id column; declare "board": "outlives"/);
  const scheduled = fixture('versions');
  scheduled.sections.find(s => s.Schedules).Schedules = [{ source_name: { some: 'x' }, table_name: 'version_cooldown', schedule_at_col: 1, function_name: 'f' }];
  only(pluginSchema(scheduled, fixture('core'), VERSIONS).problems, /table 'versionCooldown' is scheduled/);
  const sum = fixture('meta');
  const types = sum.sections.find(s => s.Typespace).Typespace.types;
  const row = types[sum.sections.find(s => s.Tables).Tables.find(t => t.source_name === 'versionMeta').product_type_ref];
  row.Product.elements[2].algebraic_type = { Sum: { variants: [{ name: { some: 'a' }, algebraic_type: { U8: [] } }, { name: { some: 'b' }, algebraic_type: { U8: [] } }] } };
  only(pluginSchema(sum, fixture('core'), { versionMeta: { why: 'x' } }).problems, /column 'tag' has a type a retired plugin cannot rebuild/);
});

test('upgrade rules: appended private column, new table and new index pass', () => {
  const v1 = versions().schema, v2 = clone(v1);
  v2.tables.boardVersionChunk.columns.push(['pinned', { Bool: [] }]);
  v2.tables.pinTag = clone(v1.tables.versionCooldown);
  v2.tables.boardVersion.indexes.push({ name: 'boardVersion_status_idx_btree', accessor: 'status', algorithm: 'btree', columns: ['status'] });
  v2.wire.my_pin_tags = clone(v1.wire.my_board_versions);
  assert.deepEqual(schemaProblems(v1, v2, 'versions'), []);
  assert.deepEqual(schemaProblems(v1, clone(v1), 'versions'), []);
});

test('upgrade rules refuse each incompatible change with one message', () => {
  const v1 = versions().schema;
  const change = (edit, pattern) => { const v2 = clone(v1); edit(v2); only(schemaProblems(v1, v2, 'pin'), pattern); };
  change(v => { v.tables.boardVersionChunk.columns[5][1] = { U32: [] }; },
    /^plugin rule: pin: changes table board_version_chunk: column 'data' was String, is now U32\. Plugin database changes may only add tables, add indexes and append columns to private tables\. Keep the old column and add a new one\.$/);
  change(v => { v.tables.boardVersionChunk.columns.pop(); }, /removes column 'data' from table board_version_chunk/);
  change(v => { const c = v.tables.versionCooldown.columns; [c[0], c[1]] = [c[1], c[0]]; }, /changes table version_cooldown: column 1 was 'key', is now 'until'/);
  change(v => { v.tables.boardVersion.indexes.splice(0, 1); }, /removes or renames index boardVersion_boardId_idx_btree on table board_version/);
  change(v => { v.tables.versionCooldown.primaryKey = ['until']; }, /changes the primary key of table version_cooldown/);
  change(v => { delete v.tables.versionCooldown; }, /removes table version_cooldown\..*retiring the plugin keeps its data/);
  change(v => { v.wire.my_board_versions.row.Array.Product.push(['extra', { Bool: [] }]); }, /changes public view my_board_versions/);
  change(v => { delete v.wire.my_board_versions; }, /removes public view my_board_versions/);
  change(v => { v.tables.versionCooldown.public = true; }, /makes table version_cooldown public/);
  change(v => { v.tables.versionCooldown.unique = []; }, /changes the unique columns of table version_cooldown/);
  const pub = clone(v1);
  pub.tables.versionCooldown.public = true;
  const appended = clone(pub);
  appended.tables.versionCooldown.columns.push(['note', { String: [] }]);
  only(schemaProblems(pub, appended, 'pin'), /appends columns to public table version_cooldown/);
});

test('type names do not matter to the upgrade rules; structure does', () => {
  const v1 = pluginSchema(fixture('meta'), fixture('core'), { versionMeta: { why: 'x' } }).schema;
  const renamed = clone(v1);
  renamed.types = { Other: v1.types.PinMeta, PinKind: v1.types.PinKind };
  renamed.tables.versionMeta.columns[1][1] = { Named: 'Other' };
  assert.deepEqual(schemaProblems(v1, renamed, 'meta'), []);
  const changed = clone(v1);
  changed.types.PinMeta.Product[0][1] = { U64: [] };
  only(schemaProblems(v1, changed, 'meta'), /column 'meta' was PinMeta, is now PinMeta/);
});

test('renderRetained rebuilds Versions as the spike stub that the database accepted unchanged', () => {
  assert.equal(renderRetained('versions', versions().schema), `const retained_versions = {
  tables: {
    boardVersionChunk: retainedTable({}, {
      id: retainedT.u64().primaryKey().autoInc(),
      owner: retainedT.identity().index('btree'),
      version_id: retainedT.u64(),
      request_key: retainedT.string(),
      index: retainedT.u32(),
      data: retainedT.string(),
    }),
    versionCooldown: retainedTable({}, {
      key: retainedT.string().primaryKey(),
      until: retainedT.timestamp(),
    }),
    boardVersion: retainedTable({}, {
      id: retainedT.u64().primaryKey().autoInc(),
      workspaceId: retainedT.u64().index('btree'),
      boardId: retainedT.u64().index('btree'),
      board_name: retainedT.string(),
      objectKey: retainedT.string().unique(),
      sha_256: retainedT.string(),
      bytes: retainedT.u64(),
      format_version: retainedT.u32(),
      status: retainedT.string(),
      created_by: retainedT.identity(),
      created_at: retainedT.timestamp(),
    }),
  },
};
`);
});

test('renderRetained writes named types, options, arrays and table-level indexes', () => {
  const text = renderRetained('meta', pluginSchema(fixture('meta'), fixture('core'), { versionMeta: { why: 'x' } }).schema);
  assert.match(text, /versionMeta: retainedTable\(\{ indexes: \[\{ accessor: "byKindTag", algorithm: 'btree', columns: \["id", "list"\] \}\] \}, \{/);
  assert.match(text, /meta: retainedT\.object\("PinMeta", \{ a: retainedT\.u32\(\), b: retainedT\.string\(\) \}\),/);
  assert.match(text, /tag: retainedT\.option\(retainedT\.string\(\)\),/);
  assert.match(text, /kind: retainedT\.enum\("PinKind", \{ plain: retainedT\.unit\(\), weight: retainedT\.u32\(\) \}\),/);
  assert.match(text, /list: retainedT\.array\(retainedT\.u64\(\)\),/);
});
