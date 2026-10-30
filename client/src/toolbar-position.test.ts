import { describe, it, expect } from 'vitest';
import { toolbarPosition, popoverPosition } from './toolbar-position';
import type { Rect } from './render';

describe('toolbarPosition', () => {
  it('centers the compact toolbar above the selection', () => {
    expect(toolbarPosition({ x: 400, y: 300, w: 200, h: 80 }, { w: 320, h: 44 }, { left: 16, right: 1200, top: 16, bottom: 800 }))
      .toEqual({ left: 340, top: 244, side: 'above' });
  });

  it('clamps away from the rail and inspector', () => {
    const bounds = { left: 260, right: 1000, top: 16, bottom: 800 };
    expect(toolbarPosition({ x: 20, y: 300, w: 160, h: 80 }, { w: 320, h: 44 }, bounds).left).toBe(260);
    expect(toolbarPosition({ x: 940, y: 300, w: 160, h: 80 }, { w: 320, h: 44 }, bounds).left).toBe(680);
  });

  it('moves below the selection when there is no room above', () => {
    expect(toolbarPosition({ x: 400, y: 20, w: 160, h: 80 }, { w: 320, h: 44 }, { left: 16, right: 1200, top: 16, bottom: 800 }).top).toBe(112);
  });

  it('below side reported', () => {
    const bounds = { left: 16, right: 1200, top: 16, bottom: 800 };
    expect(toolbarPosition({ x: 400, y: 20, w: 160, h: 80 }, { w: 320, h: 44 }, bounds).side).toBe('below');
    expect(toolbarPosition({ x: 400, y: 300, w: 160, h: 80 }, { w: 320, h: 44 }, bounds).side).toBe('above');
  });
});

describe('popoverPosition (G14)', () => {
  const bounds = { left: 264, right: 1088, top: 68, bottom: 884 };
  const bar = { w: 330, h: 44 };
  const panel = { w: 220, h: 242 };
  const intersects = (a: Rect, b: Rect) =>
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

  /** Place the bar the way syncChrome does, then the popover from its Style summary. */
  function place(sel: Rect) {
    const t = toolbarPosition(sel, bar, bounds);
    const barRect = { x: t.left, y: t.top, w: bar.w, h: bar.h };
    const anchorLeft = barRect.x + 200;
    const p = popoverPosition(barRect, anchorLeft, panel, sel, bounds);
    return { side: t.side, barRect, pop: { x: p.left, y: p.top, w: panel.w, h: panel.h } };
  }

  it('popover rect never intersects the selection near the top edge', () => {
    for (const y of [68, 80, 100, 140, 180, 220, 300, 420, 560]) {
      for (const x of [300, 520, 760, 900]) {
        const sel = { x, y, w: 180, h: 80 };
        const { pop } = place(sel);
        expect(intersects(pop, sel), `selection at ${x},${y}`).toBe(false);
      }
    }
  });

  it('opens above the bar when the bar sits above the selection and there is room', () => {
    const sel = { x: 520, y: 500, w: 180, h: 80 };
    const { barRect, pop } = place(sel);
    expect(pop.y + pop.h).toBeLessThanOrEqual(barRect.y);
  });

  it('with the bar flipped below a node at the top, never opens back over the node', () => {
    const sel = { x: 520, y: 80, w: 180, h: 80 };
    const { side, pop } = place(sel);
    expect(side).toBe('below');
    expect(intersects(pop, sel)).toBe(false);
    expect(pop.y).toBeGreaterThanOrEqual(sel.y + sel.h);
  });

  it('stays inside the bounds', () => {
    for (const y of [68, 140, 560]) {
      const { pop } = place({ x: 900, y, w: 180, h: 80 });
      expect(pop.x).toBeGreaterThanOrEqual(bounds.left);
      expect(pop.x + pop.w).toBeLessThanOrEqual(bounds.right);
      expect(pop.y).toBeGreaterThanOrEqual(bounds.top);
      expect(pop.y + pop.h).toBeLessThanOrEqual(bounds.bottom);
    }
  });
});
