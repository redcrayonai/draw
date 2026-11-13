import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BESIDE_GAP, openQuickAdd, placeBeside, sideOf } from './quick-add';

const node = { x: 400, y: 200, w: 160, h: 80 };
const size = { w: 160, h: 80 };

describe('quick add', () => {
  it('sideOf names the side a handle is on', () => {
    expect(sideOf(node, { x: 560, y: 240 })).toBe('right');
    expect(sideOf(node, { x: 400, y: 240 })).toBe('left');
    expect(sideOf(node, { x: 480, y: 200 })).toBe('top');
    expect(sideOf(node, { x: 480, y: 280 })).toBe('bottom');
    // A wide, flat node: its top handle is nearer the centre in pixels than its right one.
    expect(sideOf({ x: 0, y: 0, w: 800, h: 40 }, { x: 400, y: 0 })).toBe('top');
  });

  it('places the new node centred on that side, a gap away, on the grid', () => {
    expect(placeBeside(node, 'right', size, [node])).toEqual({ x: 560 + BESIDE_GAP, y: 200 });
    expect(placeBeside(node, 'left', size, [node])).toEqual({ x: 400 - BESIDE_GAP - 160, y: 200 });
    expect(placeBeside(node, 'bottom', size, [node])).toEqual({ x: 400, y: 280 + BESIDE_GAP });
    expect(placeBeside(node, 'top', size, [node])).toEqual({ x: 400, y: 200 - BESIDE_GAP - 80 });
    // Centred on a taller node, snapped to the 4 px grid.
    expect(placeBeside({ x: 0, y: 0, w: 160, h: 90 }, 'right', size, [])).toEqual({ x: 256, y: 4 });
  });

  it('steps past what is already there, so a second add does not land on the first', () => {
    const first = { ...placeBeside(node, 'right', size, [node]), ...size };
    const second = placeBeside(node, 'right', size, [node, first]);
    expect(second).toEqual({ x: first.x, y: first.y + 80 + 32 });
    const third = placeBeside(node, 'right', size, [node, first, { ...second, ...size }]);
    expect(third.y).toBe(second.y + 80 + 32);
    const under = { ...placeBeside(node, 'bottom', size, [node]), ...size };
    expect(placeBeside(node, 'bottom', size, [node, under])).toEqual({ x: under.x + 160 + 32, y: under.y });
  });

  it('clears a whole column however many are stacked there, and a tall node in one move', () => {
    const column = Array.from({ length: 40 }, (_, i) => ({ x: 560 + BESIDE_GAP, y: 200 + i * (80 + 32), ...size }));
    const spot = placeBeside(node, 'right', size, [node, ...column]);
    expect(spot).toEqual({ x: 560 + BESIDE_GAP, y: 200 + 40 * (80 + 32) });
    expect(column.some(c => spot.y < c.y + c.h && spot.y + 80 > c.y)).toBe(false);
    // Narrower than the new node, so it is something in the way and not a frame around it.
    const tall = { x: 700, y: 100, w: 60, h: 900 };
    expect(placeBeside(node, 'right', size, [node, tall])).toEqual({ x: 560 + BESIDE_GAP, y: 1000 + 32 });
  });

  it('a frame drawn around both is not in the way', () => {
    const frame = { x: 0, y: 0, w: 2000, h: 1000 };
    expect(placeBeside(node, 'right', size, [frame, node])).toEqual({ x: 560 + BESIDE_GAP, y: 200 });
  });

  describe('the menu', () => {
    beforeEach(() => { document.body.innerHTML = '<div id="quick-add" hidden></div>'; vi.useFakeTimers(); });

    it('shows the actions, runs the one chosen and closes', () => {
      const el = document.getElementById('quick-add')!;
      const add = vi.fn(), link = vi.fn();
      openQuickAdd(el, { x: 100, y: 100 }, [{ label: 'Add connected node', run: add }, { label: 'Link a board…', run: link }]);
      expect(el.hidden).toBe(false);
      expect([...el.querySelectorAll('button')].map(b => b.textContent)).toEqual(['Add connected node', 'Link a board…']);
      el.querySelectorAll('button')[1].click();
      expect(link).toHaveBeenCalledTimes(1);
      expect(add).not.toHaveBeenCalled();
      expect(el.hidden).toBe(true);
      expect(el.children).toHaveLength(0);
      vi.useRealTimers();
    });

    it('Escape or a press elsewhere closes it without running anything', () => {
      const el = document.getElementById('quick-add')!;
      const run = vi.fn();
      openQuickAdd(el, { x: 100, y: 100 }, [{ label: 'Add connected node', run }]);
      vi.runAllTimers();
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(el.hidden).toBe(true);
      openQuickAdd(el, { x: 100, y: 100 }, [{ label: 'Add connected node', run }]);
      vi.runAllTimers();
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      expect(el.hidden).toBe(true);
      expect(run).not.toHaveBeenCalled();
      vi.useRealTimers();
    });
  });
});
