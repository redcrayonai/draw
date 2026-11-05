import { beforeEach, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { Identity, Timestamp } from 'spacetimedb';
import type { DbConnection } from '@draw/client';
import { attach, boardVersions, reset } from './store';

const version = (id: bigint) => ({ id, workspaceId: 4n, boardId: 2n, boardName: 'Payments', objectKey: 'k', sha256: 's', bytes: 10n, formatVersion: 1,
  createdBy: new Identity('aa'.repeat(32)), creatorName: 'Ada', createdAt: new Timestamp(id) });
function connection() {
  let rows = [version(1n), version(3n)];
  const table = { iter: () => rows.values(), onInsert: vi.fn(), onUpdate: vi.fn(), onDelete: vi.fn() };
  const subscription = { onApplied: vi.fn(), onError: vi.fn(), subscribe: vi.fn() };
  subscription.onApplied.mockReturnValue(subscription);
  subscription.onError.mockReturnValue(subscription);
  const c = { db: { myBoardVersions: table }, subscriptionBuilder: () => subscription } as unknown as DbConnection;
  return { c, table, subscription, rows: (next: typeof rows) => { rows = next; } };
}
beforeEach(reset);

it('subscribes separately and rebuilds versions newest first on applied and row changes', () => {
  const { c, table, subscription, rows } = connection();
  attach(c, () => false);
  expect(subscription.subscribe).toHaveBeenCalledWith(['SELECT * FROM my_board_versions']);
  subscription.onApplied.mock.calls[0][0]();
  expect(get(boardVersions).map(row => row.id)).toEqual([3n, 1n]);
  for (const callback of [table.onInsert, table.onUpdate, table.onDelete]) {
    rows([version(2n)]);
    callback.mock.calls[0][0]();
    expect(get(boardVersions).map(row => row.id)).toEqual([2n]);
  }
});

it('ignores stale row, applied, and error callbacks after a new account has rows', () => {
  const { c, table, subscription } = connection();
  let stale = false;
  attach(c, () => stale);
  stale = true;
  boardVersions.set([version(9n)]);
  for (const callback of [table.onInsert, table.onUpdate, table.onDelete, subscription.onApplied, subscription.onError]) {
    callback.mock.calls[0][0]();
    expect(get(boardVersions).map(row => row.id)).toEqual([9n]);
  }
});

it('clears rows on subscription failure and reset', () => {
  const { c, subscription } = connection();
  attach(c, () => false);
  boardVersions.set([version(9n)]);
  subscription.onError.mock.calls[0][0]();
  expect(get(boardVersions)).toEqual([]);
  boardVersions.set([version(9n)]);
  reset();
  expect(get(boardVersions)).toEqual([]);
});

it('leaves older servers without the optional view usable', () => {
  const c = { db: {}, subscriptionBuilder: vi.fn() };
  expect(() => attach(c as unknown as DbConnection, () => false)).not.toThrow();
  expect(c.subscriptionBuilder).not.toHaveBeenCalled();
});
