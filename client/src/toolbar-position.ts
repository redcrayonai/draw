import type { Rect } from './render';

interface Bounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Screen-space placement; bounds reserve space for visible side panels.
 *  `side` says where the bar ended up relative to the selection. */
export function toolbarPosition(
  selection: Rect,
  bar: { w: number; h: number },
  bounds: Bounds
): { left: number; top: number; side: 'above' | 'below' } {
  const above = selection.y - bar.h - 12;
  const side = above >= bounds.top ? 'above' : 'below';
  const top = side === 'above' ? above : selection.y + selection.h + 12;
  return {
    left: Math.max(bounds.left, Math.min(selection.x + selection.w / 2 - bar.w / 2, bounds.right - bar.w)),
    top: Math.max(bounds.top, Math.min(top, bounds.bottom - bar.h)),
    side,
  };
}

function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * Where a toolbar popover opens (G14), in the same space as its inputs: above
 * the bar, else right of it, else left of it, else below it, else below the
 * selection — the first that fits the bounds without covering the selection.
 * When none does, the placement covering the least of the bar and the
 * selection wins: a panel over its own bar hides the button that closes it.
 */
export function popoverPosition(
  bar: Rect,
  anchorLeft: number,
  panel: { w: number; h: number },
  selection: Rect,
  bounds: Bounds
): { left: number; top: number } {
  const clampX = (x: number) => Math.max(bounds.left, Math.min(x, bounds.right - panel.w));
  const clampY = (y: number) => Math.max(bounds.top, Math.min(y, bounds.bottom - panel.h));
  const candidates = [
    { left: clampX(anchorLeft), top: bar.y - 8 - panel.h },
    { left: bar.x + bar.w + 8, top: clampY(bar.y) },
    { left: bar.x - 8 - panel.w, top: clampY(bar.y) },
    { left: clampX(anchorLeft), top: bar.y + bar.h + 8 },
    { left: clampX(anchorLeft), top: selection.y + selection.h + 8 },
  ];
  const fits = (c: { left: number; top: number }) =>
    c.left >= bounds.left && c.left + panel.w <= bounds.right &&
    c.top >= bounds.top && c.top + panel.h <= bounds.bottom;
  const over = (c: { left: number; top: number }, r: Rect) => overlap({ x: c.left, y: c.top, w: panel.w, h: panel.h }, r);
  const covered = (c: { left: number; top: number }) => over(c, selection);
  const best = candidates.find(c => fits(c) && covered(c) === 0 && over(c, bar) === 0);
  if (best !== undefined) {
    return best;
  }
  const clamped = candidates.map(c => ({ left: clampX(c.left), top: clampY(c.top) }));
  const cost = (c: { left: number; top: number }) => covered(c) + over(c, bar);
  return clamped.reduce((a, b) => (cost(b) < cost(a) ? b : a));
}
