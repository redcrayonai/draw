import { expect, it, vi } from 'vitest';
import { CreateBatch } from './create-batch';
import type { Database } from './db';

const args = { boardId: 1n, label: 'api', sublabel: '', x: 0, y: 0, w: 160, h: 64, token: 'ink', focal: false };
const signal = AbortSignal.timeout(1000);
const fake = (procedure = vi.fn(async () => [{ id: 1n }, { id: 2n }])) => ({ procedure, stats: { dbCalls: 0, dbMs: 0, writes: 0 } }) as unknown as Database;

it('coalesces a wave and releases it when another item is refused before submitting', async () => {
  const db = fake();
  const batch = new CreateBatch(3);
  const first = batch.submit(0, 'a'.repeat(64), 'create_node', args, db, signal);
  const second = batch.submit(1, 'b'.repeat(64), 'create_node', { ...args, label: 'db' }, db, signal);
  expect(db.procedure).not.toHaveBeenCalled();
  batch.finish(2);
  expect(await Promise.all([first, second])).toEqual([1n, 2n]);
  expect(db.procedure).toHaveBeenCalledTimes(1);
  expect(db.stats.writes).toBe(2);
});

it('does not wait for a duplicate that is waiting on the first create to settle', async () => {
  const db = fake(vi.fn().mockResolvedValue([{ id: 1n }])), batch = new CreateBatch(2);
  batch.claim(0, 'same');
  batch.claim(1, 'same');
  expect(await batch.submit(0, 'a'.repeat(64), 'create_node', args, db, signal)).toBe(1n);
});

it('retries a lost HTTP response with the exact same receipt keys', async () => {
  const procedure = vi.fn().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce([{ id: 7n }]);
  const db = fake(procedure);
  expect(await new CreateBatch(1).submit(0, 'a'.repeat(64), 'create_node', args, db, signal)).toBe(7n);
  expect(procedure.mock.calls[1]).toEqual(procedure.mock.calls[0]);
  expect(db.stats.writes).toBe(1);
});

it('encodes the icon as optional in a batch even though create_icon_node requires it', async () => {
  const procedure = vi.fn().mockResolvedValue([{ id: 1n }]);
  await new CreateBatch(1).submit(0, 'a'.repeat(64), 'create_icon_node', { ...args, icon: 'agent' }, fake(procedure), signal);
  expect(procedure.mock.calls[0][1][0][0][1].some.at(-1)).toEqual({ some: 'agent' });
});

it('keeps successful items when a peer is refused and allows a consent retry after the wave', async () => {
  const procedure = vi.fn().mockResolvedValueOnce([{ id: 1n }, { error: 'consent', refused: true }]).mockResolvedValueOnce([{ id: 2n }]);
  const db = fake(procedure), batch = new CreateBatch(2);
  const a = batch.submit(0, 'a'.repeat(64), 'create_node', args, db, signal);
  const b = batch.submit(1, 'b'.repeat(64), 'create_node', args, db, signal);
  expect(await a).toBe(1n);
  await expect(b).rejects.toMatchObject({ status: 530, message: 'consent' });
  expect(db.stats.writes).toBe(1);
  expect(await batch.submit(1, 'b'.repeat(64), 'create_node', args, db, signal)).toBe(2n);
  expect(db.stats.writes).toBe(2);
});
