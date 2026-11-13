import { afterEach, expect, it, vi } from 'vitest';
import { closeSync, fsyncSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWrite, LocalStore } from './local-store';

vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, openSync: vi.fn(fs.openSync), fsyncSync: vi.fn(fs.fsyncSync), renameSync: vi.fn(fs.renameSync), closeSync: vi.fn(fs.closeSync) };
});
const directories: string[] = [];
afterEach(() => { vi.clearAllMocks(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function directory() { const path = mkdtempSync(join(tmpdir(), 'draw-sync-')); directories.push(path); return path; }

it('syncs the snapshot before rename and its directory afterward', () => {
  const dir = directory(), file = join(dir, 'boards.json');
  atomicWrite(file, 'snapshot');
  const sync = vi.mocked(fsyncSync).mock, rename = vi.mocked(renameSync).mock;
  expect(sync.calls).toHaveLength(2);
  expect(sync.invocationCallOrder[0]).toBeLessThan(rename.invocationCallOrder[0]);
  expect(sync.invocationCallOrder[1]).toBeGreaterThan(rename.invocationCallOrder[0]);
  expect(openSync).toHaveBeenLastCalledWith(dir, 'r');
  expect(sync.calls[1][0]).toBe(vi.mocked(openSync).mock.results.at(-1)!.value);
  expect(closeSync).toHaveBeenLastCalledWith(sync.calls[1][0]);
  expect(readFileSync(file, 'utf8')).toBe('snapshot');
});

it('fails closed after a post-rename sync failure until the store is reopened', () => {
  const dir = directory(), store = new LocalStore(dir);
  const board = store.create('Before', dir);
  vi.mocked(fsyncSync).mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw new Error('sync failed'); });
  try {
    expect(() => store.mutate(board.slug, 0, [{ type: 'node.put', patch: { label: 'After' } }])).toThrow('sync failed');
    expect(() => store.mutate(board.slug, 0, [{ type: 'node.put', patch: { label: 'Overwrite' } }])).toThrow('restart');
    expect(() => new LocalStore(dir)).toThrow('locked');
  } finally { store.close(); }
  const reopened = new LocalStore(dir);
  try { expect(reopened.read(board.slug).nodes[0].label).toBe('After'); } finally { reopened.close(); }
});
