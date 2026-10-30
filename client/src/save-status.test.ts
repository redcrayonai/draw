import { describe, expect, it, vi } from 'vitest';
import { trackBoardWrites } from './save-status';

describe('write acknowledgements', () => {
  it('keeps saving until every overlapping write is acknowledged', async () => {
    let finishOne!: () => void, finishTwo!: () => void;
    const report = vi.fn();
    const conn = {reducers: {
      moveNode: () => new Promise<void>(resolve => { finishOne = resolve; }),
      createNode: () => new Promise<void>(resolve => { finishTwo = resolve; }),
      updateCursor: async () => {},
    }};
    trackBoardWrites(conn, report);
    const one = conn.reducers.moveNode();
    const two = conn.reducers.createNode();
    await conn.reducers.updateCursor();
    expect(report.mock.calls.map(call => call[0])).toEqual(['pending', 'pending']);
    finishOne(); await one;
    expect(report).not.toHaveBeenCalledWith('saved');
    finishTwo(); await two;
    expect(report).toHaveBeenLastCalledWith('saved');
  });

  it('leaves the board badge alone for library writes, which report themselves', async () => {
    const report = vi.fn();
    const conn = {reducers: {
      saveLibraryItem: async () => { throw new Error('your library holds 200 items; delete one before saving another'); },
      renameLibraryItem: async () => {},
      deleteLibraryItem: async () => {},
    }};
    trackBoardWrites(conn, report);
    await expect(conn.reducers.saveLibraryItem()).rejects.toThrow('200 items');
    await conn.reducers.renameLibraryItem();
    await conn.reducers.deleteLibraryItem();
    expect(report).not.toHaveBeenCalled();
  });

  it('does not mask a failed overlapping write as saved', async () => {
    let finish!: () => void;
    const report = vi.fn();
    const conn = {reducers: {
      createNode: async () => { throw new Error('offline'); },
      moveNode: () => new Promise<void>(resolve => { finish = resolve; }),
    }};
    trackBoardWrites(conn, report);
    const failed = conn.reducers.createNode();
    const pending = conn.reducers.moveNode();
    await expect(failed).rejects.toThrow('offline');
    finish(); await pending;
    expect(report).toHaveBeenLastCalledWith('error', 'offline');
  });
});
