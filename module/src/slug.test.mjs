import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backfillSlugs, newSlug } from './slug.ts';

// The board table as the reducers use it: a slug index and a primary-key update.
function table(rows) {
  const byId = new Map(rows.map(r => [r.id, { ...r }]));
  return {
    rows: () => [...byId.values()],
    slug: { filter: slug => [...byId.values()].filter(r => r.slug === slug) },
    id: { update: row => byId.set(row.id, { ...row }) },
  };
}
let seed = 0;
const random = { fill: bytes => bytes.map(() => (seed = (seed * 31 + 7) % 256)) };

test('newSlug is 20 hex characters no board has yet', () => {
  const taken = newSlug(table([]), { fill: b => b.fill(0xab) });
  assert.match(taken, /^[0-9a-f]{20}$/);
  let calls = 0;
  const flaky = { fill: b => b.fill(calls++ === 0 ? 0xab : 0xcd) };
  assert.equal(newSlug(table([{ id: 1n, name: 'a', slug: taken }]), flaky), 'cd'.repeat(10));
});

test('backfill gives every board without a slug a unique one; a second run is a no-op', () => {
  const boards = table([
    { id: 1n, name: 'old', slug: '' },
    { id: 2n, name: 'new', slug: 'ab'.repeat(10) },
    { id: 3n, name: 'older', slug: '' },
  ]);
  assert.equal(backfillSlugs(boards, random), 2);
  const after = boards.rows();
  assert.ok(after.every(b => /^[0-9a-f]{20}$/.test(b.slug)), after.map(b => b.slug).join());
  assert.equal(new Set(after.map(b => b.slug)).size, 3);
  assert.equal(after.find(b => b.id === 2n).slug, 'ab'.repeat(10), 'an existing slug never changes');
  assert.deepEqual(after.map(b => b.name), ['old', 'new', 'older']);
  assert.equal(backfillSlugs(boards, random), 0);
  assert.deepEqual(boards.rows(), after);
});
