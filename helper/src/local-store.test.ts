import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalStore } from './local-store';

const directories: string[] = [];
const stores: LocalStore[] = [];
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'draw-local-'));
  directories.push(directory);
  const store = new LocalStore(directory);
  stores.push(store);
  return { directory, store, board: store.create('Architecture', directory) };
}
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('local authoritative store', () => {
  it('restores deleted graph elements with stable review anchors and rejects invalid restores', () => {
    const { store, board } = setup();
    const original = store.mutate(board.slug, 0, [{ type: 'node.put', patch: { label: 'API' } }, { type: 'note.add', target: '1', text: 'Review' }]);
    store.mutate(board.slug, 1, [{ type: 'element.delete', id: '1' }]);
    const restored = store.mutate(board.slug, 2, [{ type: 'graph.restore', nodes: original.nodes, edges: [] }]);
    expect(restored.nodes[0].id).toBe(restored.notes[0].target);
    expect(() => store.mutate(board.slug, 3, [{ type: 'graph.restore', nodes: [{ ...original.nodes[0], id: '2' }], edges: [] }])).toThrow('identifier');
    expect(store.read(board.slug)).toEqual(restored);
  });
  it('preserves graph, layout, refs and review across restart; detached notes survive deletion', () => {
    const { directory, store, board } = setup();
    let current = store.mutate(board.slug, 0, [
      { type: 'node.put', patch: { label: 'API', x: 240, refs: [{ path: 'src/api.ts', start: 2, end: 8 }] } },
      { type: 'node.put', patch: { label: 'Database' } },
      { type: 'edge.put', patch: { from: '1', to: '2' } },
      { type: 'note.add', target: '3', text: 'Check timeout' },
      { type: 'note.reply', id: '4', text: 'Timeout added' },
      { type: 'note.resolve', id: '4', resolved: true },
    ]);
    store.close();
    const reopened = new LocalStore(directory); stores.push(reopened);
    expect(reopened.read(board.slug)).toEqual(current);
    current = reopened.mutate(board.slug, 1, [{ type: 'node.put', id: '1', patch: { description: 'Updated by agent' } }]);
    expect(current.nodes[0].x).toBe(240);
    current = reopened.mutate(board.slug, 2, [{ type: 'element.delete', id: '1' }]);
    expect(current.edges).toEqual([]);
    expect(current.notes[0]).toMatchObject({ target: '3', resolved: true, replies: [{ text: 'Timeout added' }] });
  });
  it('rejects stale edits and rolls back invalid batches', () => {
    const { store, board } = setup();
    const current = store.mutate(board.slug, 0, [{ type: 'node.put', patch: { label: 'First tab' } }]);
    expect(() => store.mutate(board.slug, 0, [{ type: 'node.put', patch: { label: 'Second tab' } }])).toThrow('board changed');
    expect(() => store.mutate(board.slug, 1, [
      { type: 'node.put', patch: { label: 'Must roll back' } },
      { type: 'edge.put', patch: { from: '1', to: 'missing' } },
    ])).toThrow('endpoints');
    expect(store.read(board.slug)).toEqual(current);
    current.nodes[0].x = 999;
    expect(store.read(board.slug).nodes[0].x).toBe(0);
  });
  it('keeps durable and in-memory state on failed writes', () => {
    const { directory, store, board } = setup(); store.close();
    const before = readFileSync(join(directory, 'boards.json'), 'utf8');
    const failing = new LocalStore(directory, () => { throw new Error('disk full'); }); stores.push(failing);
    expect(() => failing.mutate(board.slug, 0, [{ type: 'node.put', patch: {} }])).toThrow('disk full');
    expect(failing.read(board.slug)).toEqual(board);
    expect(readFileSync(join(directory, 'boards.json'), 'utf8')).toBe(before);
  });
  it('refuses independent writers and unsupported schema versions', () => {
    const { directory, store } = setup();
    expect(() => new LocalStore(directory)).toThrow('locked');
    store.close();
    writeFileSync(join(directory, 'boards.json'), '{"version":99,"boards":[]}');
    expect(() => new LocalStore(directory)).toThrow('unsupported');
    expect(readFileSync(join(directory, 'boards.json'), 'utf8')).toContain('99');
  });
  it('refuses corrupted current-version state without overwriting it', () => {
    const { directory, store, board } = setup(); store.close();
    const corrupt = JSON.stringify({ version: 1, boards: [{ ...board, nextId: -1 }] });
    writeFileSync(join(directory, 'boards.json'), corrupt);
    expect(() => new LocalStore(directory)).toThrow('invalid stored board');
    expect(readFileSync(join(directory, 'boards.json'), 'utf8')).toBe(corrupt);
  });
  it.each([
    { x: NaN }, { w: -1 }, { label: 3 }, { id: 'injected' },
    { refs: [{ path: '../secret', start: 1, end: 2 }] },
    { refs: [{ path: 'ok.ts', start: 0, end: 2 }] },
  ])('rejects malformed node patches %j', patch => {
    const { store, board } = setup();
    expect(() => store.mutate(board.slug, 0, [{ type: 'node.put', patch: patch as never }])).toThrow('REJECTED');
    expect(store.read(board.slug)).toEqual(board);
  });
});
