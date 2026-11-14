import { afterEach, expect, it, vi } from 'vitest';
import type { Node } from './module_bindings/types';
import { positionOnly, scheduleTableRefresh } from './table-refresh';

const node: Node = { id: 1n, boardId: 2n, x: 0, y: 0, w: 160, h: 80, label: 'Service', sublabel: '', token: '', focal: false, doc: '', hidden: false, imported: false, kind: 'node', shape: '', color: '', strokeStyle: '', size: '', sourceKey: '' };
afterEach(() => vi.restoreAllMocks());

it('accepts movement and rejects every non-position field change, including new fields', () => {
  expect(positionOnly(node, { ...node, x: 20, y: 40 })).toBe(true);
  for (const key of Object.keys(node) as (keyof Node)[]) {
    if (key === 'x' || key === 'y') continue;
    const value = node[key];
    const changed = typeof value === 'bigint' ? value + 1n : typeof value === 'number' ? value + 20 : typeof value === 'boolean' ? !value : `${value}changed`;
    expect(positionOnly(node, { ...node, [key]: changed }), key).toBe(false);
  }
  expect(positionOnly(node, { ...node, futureField: true } as Node)).toBe(false);
  expect(positionOnly({ ...node, futureField: true } as Node, node)).toBe(false);
});

it.each([[true, false], [false, true], [true, true, false, true]])('a full change wins a mixed frame: %j', (...changes) => {
  const frames: FrameRequestCallback[] = [];
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(cb => frames.push(cb));
  const full = vi.fn(), positions = vi.fn();
  const schedule = scheduleTableRefresh(full, positions);
  changes.forEach(schedule);
  expect(frames).toHaveLength(1);
  frames.shift()!(0);
  expect(full).toHaveBeenCalledOnce();
  expect(positions).not.toHaveBeenCalled();
  schedule(true); schedule(true);
  frames.shift()!(16);
  expect(positions).toHaveBeenCalledOnce();
  expect(full).toHaveBeenCalledOnce();
});
