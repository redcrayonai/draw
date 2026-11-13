import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activityLayer, beyondKeep, newestFirst, oldestBatch } from './activity-feed.ts';

test('activityLayer puts code-ref and threat events behind their board layer', () => {
  assert.equal(activityLayer('coderef.added'), 'code');
  assert.equal(activityLayer('coderef.status'), 'code');
  assert.equal(activityLayer('threat.contained'), 'threats');
  assert.equal(activityLayer('node.created'), undefined);
  assert.equal(activityLayer('board.link_includes'), undefined);
});

const row = (id, lastAt) => ({ id: BigInt(id), lastAt: { microsSinceUnixEpoch: BigInt(lastAt) } });

test('newestFirst orders by latest activity, then by the newer row', () => {
  const rows = [row(1, 10), row(3, 30), row(2, 30), row(4, 20)];
  assert.deepEqual(rows.sort(newestFirst).map(r => r.id), [3n, 2n, 4n, 1n]);
});

test('beyondKeep drops only what falls past the newest `keep`', () => {
  const rows = [row(1, 10), row(2, 50), row(3, 20), row(4, 40)];
  assert.deepEqual(beyondKeep(rows, 2).map(r => r.id), [3n, 1n]);
  assert.deepEqual(beyondKeep(rows, 4), []);
  assert.deepEqual(rows.map(r => r.id), [1n, 2n, 3n, 4n], 'the input keeps its order');
});

test('a merged burst that moved forward survives over newer-but-quieter rows', () => {
  // row 1 was inserted first but its burst kept going (lastAt moved forward)
  assert.deepEqual(beyondKeep([row(1, 90), row(2, 60), row(3, 70)], 2).map(r => r.id), [2n]);
});


test('oldestBatch matches a full sort for unordered, sparse, large ids and all batch sizes', () => {
  const rows = Array.from({ length: 1200 }, (_, i) => ({ id: 2n ** 60n + BigInt((i * 719) % 1200) * 19n }));
  for (const input of [rows, [...rows].sort((a, b) => a.id < b.id ? -1 : 1), [...rows].sort((a, b) => a.id > b.id ? -1 : 1)]) {
    for (const limit of [0, 1, 500, 1200, 1300]) {
      const expected = [...input].sort((a, b) => a.id < b.id ? -1 : 1).slice(0, limit);
      assert.deepEqual(oldestBatch(input.values(), limit), expected);
    }
  }
  assert.deepEqual(oldestBatch([], 500), []);
});
