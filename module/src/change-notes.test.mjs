import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NOTE_JSON_RULE,
  NOTE_KIND_RULE,
  NOTE_ALIAS_RULE,
  NOTE_LIMIT_RULE,
  NOTE_SEVERITY_RULE,
  NOTE_SUMMARY_RULE,
  NOTE_TITLE_RULE,
  READER_SUBJECT_RULE,
  SCHEMA_FOOT_H,
  SCHEMA_HEAD_H,
  SCHEMA_ROW_H,
  STEP_RANGE_RULE,
  MAX_ROWS_SHOWN,
  mergeSchemas,
  rebaseSteps,
  stepsFor,
  storeSteps,
  checkAliases,
  checkKind,
  checkSeverity,
  checkText,
  hasTerm,
  isMigrationPath,
  parseReaderInputs,
  parseReaders,
  parseSchema,
  parseSteps,
  parseSubjects,
  readerStatus,
  schemaCardHeight,
  schemaRows,
  termsOf,
} from './change-notes.ts';

test('hasTerm matches whole identifiers only, literally', () => {
  assert.equal(hasTerm('SELECT name, email', ['name']), true);
  assert.equal(hasTerm('first_name text', ['name']), false);
  assert.equal(hasTerm('row.name ?? x', ['name']), true);
  assert.equal(hasTerm('const $name = 1', ['$name']), true);
  assert.equal(hasTerm('const xname = 1', ['$name']), false);
  assert.equal(hasTerm('a.b', ['a.b']), true);
  assert.equal(hasTerm('aXb', ['a.b']), false); // '.' is not a wildcard
  assert.equal(hasTerm('anything', []), false);
});

test('readerStatus follows D4 in order', () => {
  const t = ['name'];
  assert.equal(readerStatus('ok', 'SELECT name', 'irrelevant', t), 'stale');
  assert.equal(readerStatus('ok', 'SELECT first_name', 'SELECT name', t), 'updated'); // ok ref: snippet decides
  assert.equal(readerStatus('stale', 'SELECT name', 'x = first_name', t), 'updated');
  assert.equal(readerStatus('ambiguous', '', 'x = row.name', t), 'unknown');
  assert.equal(readerStatus('stale', '', 'missing', t), 'updated');
  assert.equal(readerStatus('stale', '', 'unreadable', t), 'unknown');
});

test('parseSteps refuses lines outside the ref', () => {
  assert.deepEqual(parseSteps('', { startLine: 1, endLine: 13 }), []);
  assert.deepEqual(parseSteps('[{"label":"drop","startLine":12,"endLine":12,"irreversible":true}]', { startLine: 1, endLine: 13 }), [
    { label: 'drop', startLine: 12, endLine: 12, irreversible: true },
  ]);
  assert.throws(() => parseSteps('[{"label":"drop","startLine":12,"endLine":14}]', { startLine: 1, endLine: 13 }), { message: STEP_RANGE_RULE });
  assert.throws(() => parseSteps('[{"label":"drop","startLine":5,"endLine":4}]', { startLine: 1, endLine: 13 }), { message: STEP_RANGE_RULE });
  assert.throws(() => parseSteps('{"x":1}', { startLine: 1, endLine: 13 }), { message: NOTE_JSON_RULE });
  assert.throws(() => parseSteps('not json', { startLine: 1, endLine: 13 }), { message: NOTE_JSON_RULE });
  const many = JSON.stringify(Array.from({ length: 13 }, () => ({ label: 's', startLine: 1, endLine: 1 })));
  assert.throws(() => parseSteps(many, { startLine: 1, endLine: 13 }), { message: NOTE_LIMIT_RULE });
});

test('parseReaderInputs needs a valid subject index and string ids', () => {
  assert.deepEqual(parseReaderInputs('', 0), []);
  assert.deepEqual(parseReaderInputs('[{"refId":"7","subject":0}]', 1), [{ refId: '7', subject: 0 }]);
  assert.throws(() => parseReaderInputs('[{"refId":"7","subject":1}]', 1), { message: READER_SUBJECT_RULE });
  assert.throws(() => parseReaderInputs('[{"refId":"7"}]', 1), { message: READER_SUBJECT_RULE });
  assert.throws(() => parseReaderInputs('[{"refId":7,"subject":0}]', 1), { message: NOTE_JSON_RULE });
  assert.throws(() => parseReaderInputs('[{"refId":"x7","subject":0}]', 1), { message: NOTE_JSON_RULE });
});

test('parseReaders reads the stored form', () => {
  assert.deepEqual(parseReaders(''), []);
  const stored = [{ refId: '7', subject: 0, status: 'stale', checkpoint: 2 }, { refId: '8', subject: 0, status: 'unknown', checkpoint: 3, removed: true }];
  assert.deepEqual(parseReaders(JSON.stringify(stored)), stored);
  assert.throws(() => parseReaders('[{"refId":"7","subject":0,"status":"green","checkpoint":1}]'), { message: NOTE_JSON_RULE });
});

test('parseSchema and parseSubjects', () => {
  assert.equal(parseSchema(''), null);
  const schema = { table: 'customers', columns: [{ name: 'name', type: 'text', change: 'dropped' }, { name: 'id', type: 'uuid', change: null }] };
  assert.deepEqual(parseSchema(JSON.stringify(schema)), schema);
  assert.throws(() => parseSchema('{"table":"t","columns":[{"name":"a","type":"text","change":"moved"}]}'), { message: NOTE_JSON_RULE });
  assert.deepEqual(parseSubjects(''), []);
  assert.deepEqual(parseSubjects('[{"table":"customers","column":"name","aliases":["fullName"]}]'), [
    { table: 'customers', column: 'name', aliases: ['fullName'] },
  ]);
  assert.throws(() => parseSubjects('[{"table":"customers"}]'), { message: NOTE_JSON_RULE });
  assert.deepEqual(termsOf({ table: 'customers', column: 'name', aliases: ['fullName'] }), ['name', 'fullName']);
  assert.deepEqual(termsOf({ table: 'customers', column: 'name' }), ['name']);
});

test('checkAliases caps aliases: every reader check compiles them all into one regex', () => {
  const subjects = aliases => [{ table: 'customers', column: 'name', aliases }];
  const sixteen = Array.from({ length: 16 }, (_, i) => `alias${i}`);
  assert.deepEqual(checkAliases(subjects(sixteen)), subjects(sixteen));
  assert.throws(() => checkAliases(subjects([...sixteen, 'alias16'])), { message: NOTE_ALIAS_RULE });
  assert.deepEqual(checkAliases(subjects(['x'.repeat(100)])), subjects(['x'.repeat(100)]));
  assert.throws(() => checkAliases(subjects(['x'.repeat(101)])), { message: NOTE_ALIAS_RULE });
  assert.deepEqual(checkAliases([{ table: 'customers', column: 'name' }]), [{ table: 'customers', column: 'name' }]);
  // a row stored before the cap still reads: only caller-supplied subjects are capped
  const stored = Array.from({ length: 17 }, (_, i) => `alias${i}`);
  assert.deepEqual(parseSubjects(JSON.stringify(subjects(stored)))[0].aliases, stored);
});

test('kind, severity and text checks', () => {
  assert.equal(checkKind('migration'), 'migration');
  assert.throws(() => checkKind('refactor'), { message: NOTE_KIND_RULE });
  assert.equal(checkSeverity('notable'), 'notable');
  assert.throws(() => checkSeverity('caution'), { message: NOTE_SEVERITY_RULE });
  checkText('Migration 0042', 'Splits name into first/last, then drops it.');
  assert.throws(() => checkText('', 'x'), { message: NOTE_TITLE_RULE });
  assert.throws(() => checkText('x'.repeat(81), 'x'), { message: NOTE_TITLE_RULE });
  assert.throws(() => checkText('t', ''), { message: NOTE_SUMMARY_RULE });
  assert.throws(() => checkText('t', 'x'.repeat(201)), { message: NOTE_SUMMARY_RULE });
});

test('wide schema shows changed columns, 4 unchanged and a more count', () => {
  const cols = Array.from({ length: 100 }, (_, i) => ({ name: `c${i}`, type: 'text', change: i === 50 ? 'dropped' : null }));
  const { rows, more } = schemaRows({ table: 't', columns: cols });
  assert.equal(rows.length, 5);
  assert.equal(more, 95);
  assert.ok(rows.some(r => r.name === 'c50'));
  assert.deepEqual(rows.map(r => r.name), ['c0', 'c1', 'c2', 'c3', 'c50']); // column order kept
  assert.equal(schemaCardHeight({ table: 't', columns: cols }), SCHEMA_HEAD_H + 5 * SCHEMA_ROW_H + SCHEMA_FOOT_H); // "+95 more" sits in the footer row
  const small = { table: 't', columns: [{ name: 'a', type: 'text', change: 'added' }] };
  assert.equal(schemaCardHeight(small), SCHEMA_HEAD_H + SCHEMA_ROW_H + SCHEMA_FOOT_H);
});

test('isMigrationPath', () => {
  for (const p of ['migrations/0042_split.sql', 'db/migrate/20261016_add.rb', 'prisma/migrations/2026/migration.sql', 'alembic/versions/abc.py', 'drizzle/0001_x.sql', 'apps/api/migrations/1.ts'])
    assert.equal(isMigrationPath(p), true, p);
  for (const p of ['src/migrate-users.ts', 'docs/migrations.md', 'schema.sql', 'migrations/README.md'])
    assert.equal(isMigrationPath(p), false, p);
});

test('the card shows at most MAX_ROWS_SHOWN rows, so its height is bounded even when every column changed', () => {
  const added = { table: 't', columns: Array.from({ length: 60 }, (_, i) => ({ name: `c${i}`, type: 'text', change: 'added' })) };
  const { rows, more } = schemaRows(added);
  assert.equal(MAX_ROWS_SHOWN, 10);
  assert.equal(rows.length, 10);
  assert.equal(more, 50);
  assert.equal(schemaCardHeight(added), SCHEMA_HEAD_H + 10 * SCHEMA_ROW_H + SCHEMA_FOOT_H);
  assert.equal(schemaCardHeight(added) % 4, 0, 'on the 4px grid');
  assert.equal(SCHEMA_FOOT_H, 28, 'the footer row holds the ref badge and "+N more", like a chart card');
  const max = { table: 't', columns: Array.from({ length: 200 }, (_, i) => ({ name: `c${i}`, type: 'text', change: 'added' })) };
  assert.equal(schemaCardHeight(max), schemaCardHeight(added));
});

test('mergeSchemas merges by table and column, and names every table', () => {
  assert.equal(mergeSchemas([]), null);
  const customers = { table: 'customers', columns: [{ name: 'id', type: 'uuid', change: null }, { name: 'name', type: 'text', change: 'dropped' }] };
  const later = { table: 'customers', columns: [{ name: 'id', type: 'uuid', change: null }, { name: 'email', type: 'text', change: 'renamed' }] };
  assert.deepEqual(mergeSchemas([customers, later]), {
    table: 'customers',
    columns: [{ name: 'id', type: 'uuid', change: null }, { name: 'name', type: 'text', change: 'dropped' }, { name: 'email', type: 'text', change: 'renamed' }],
  });
  const orders = { table: 'orders', columns: [{ name: 'id', type: 'uuid', change: null }, { name: 'legacy', type: 'text', change: 'dropped' }] };
  const both = mergeSchemas([customers, orders]);
  assert.equal(both.table, 'customers · orders');
  assert.deepEqual(both.columns.map(c => [c.name, c.change]), [['customers.id', null], ['customers.name', 'dropped'], ['orders.id', null], ['orders.legacy', 'dropped']]);
});

test('steps are stored relative to the ref and read back at its current lines', () => {
  const steps = [{ label: 'add', startLine: 3, endLine: 5 }, { label: 'drop', startLine: 12, endLine: 12, irreversible: true }];
  const stored = storeSteps(steps, 1);
  assert.deepEqual(JSON.parse(stored), [{ label: 'add', startLine: 2, endLine: 4 }, { label: 'drop', startLine: 11, endLine: 11, irreversible: true }]);
  assert.deepEqual(stepsFor(stored, { startLine: 1, endLine: 13 }), steps);
  // the ref moved down 10 lines: the steps follow it
  assert.deepEqual(stepsFor(stored, { startLine: 11, endLine: 23 }).map(s => s.startLine), [13, 22]);
  // the ref shrank: a step past its end is dropped, not every step
  assert.deepEqual(stepsFor(stored, { startLine: 1, endLine: 8 }).map(s => s.label), ['add']);
  assert.deepEqual(stepsFor('not json', { startLine: 1, endLine: 8 }), []);
});

test('rebaseSteps moves stored offsets onto a new ref, so the steps keep their lines', () => {
  const stored = storeSteps([{ label: 'drop', startLine: 12, endLine: 12, irreversible: true }], 1);
  const moved = rebaseSteps(stored, 1, 5); // the new ref starts at line 5
  assert.deepEqual(stepsFor(moved, { startLine: 5, endLine: 17 }), [{ label: 'drop', startLine: 12, endLine: 12, irreversible: true }]);
  assert.equal(rebaseSteps('', 1, 5), '');
  assert.equal(rebaseSteps('not json', 1, 5), 'not json');
});
