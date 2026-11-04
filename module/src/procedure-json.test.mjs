import { it } from 'node:test';
import assert from 'node:assert/strict';
import { procedureJson, parseProcedureJson } from './procedure-json.ts';

it('round trips nested ids, times and literal user text without rounding', () => {
  const value = { id: 18446744073709551615n, at: { microsSinceUnixEpoch: -1n }, ids: [7n], text: '{"$bigint":"123"}', count: 2, empty: null };
  assert.deepEqual(parseProcedureJson(procedureJson(value)), value);
});
