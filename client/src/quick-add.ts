// Quick add: a click (not a drag) on one of a node's side handles offers what to put on that side,
// joined to the node by an edge: a new node, or a link to another board.

export type Side = 'left' | 'right' | 'top' | 'bottom';
export interface Box { x: number; y: number; w: number; h: number }

/** How far from the node the new one lands: room for an edge and its label. */
export const BESIDE_GAP = 96;
const STEP_GAP = 32;
const GRID = 4;
const snap = (v: number) => Math.round(v / GRID) * GRID;

/** The side of `node` a point on its border is on (the handles sit at the four mid-sides). */
export function sideOf(node: Box, at: { x: number; y: number }): Side {
  const dx = (at.x - (node.x + node.w / 2)) / (node.w / 2);
  const dy = (at.y - (node.y + node.h / 2)) / (node.h / 2);
  return Math.abs(dx) >= Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : dy < 0 ? 'top' : 'bottom';
}

const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

/**
 * Where a `size` node goes on `side` of `node`: centred on it, BESIDE_GAP away, then stepped along
 * the side (down for left and right, right for top and bottom) past whatever is already drawn there.
 * A node the new one would sit wholly inside (a frame around both) is not in the way.
 */
export function placeBeside(node: Box, side: Side, size: { w: number; h: number }, others: readonly Box[]): { x: number; y: number } {
  const across = side === 'left' || side === 'right';
  const spot: Box = {
    x: side === 'right' ? node.x + node.w + BESIDE_GAP : side === 'left' ? node.x - BESIDE_GAP - size.w : node.x + (node.w - size.w) / 2,
    y: side === 'bottom' ? node.y + node.h + BESIDE_GAP : side === 'top' ? node.y - BESIDE_GAP - size.h : node.y + (node.h - size.h) / 2,
    ...size,
  };
  // Strictly larger: a node of the same size on the same spot is the thing to step past, not a frame.
  const inside = (outer: Box) => outer.w * outer.h > spot.w * spot.h && outer.x <= spot.x && outer.y <= spot.y && outer.x + outer.w >= spot.x + spot.w && outer.y + outer.h >= spot.y + spot.h;
  for (let tries = 0; tries < 24 && others.some(other => overlaps(spot, other) && !inside(other)); tries++) {
    if (across) spot.y += size.h + STEP_GAP;
    else spot.x += size.w + STEP_GAP;
  }
  return { x: snap(spot.x), y: snap(spot.y) };
}

export interface QuickAction { label: string; hint?: string; run: () => void }

/**
 * The menu at the handle. One at a time; Escape, a press elsewhere or a choice closes it.
 * Returns the function that closes it.
 */
export function openQuickAdd(el: HTMLElement, at: { x: number; y: number }, actions: QuickAction[]): () => void {
  const close = () => {
    el.hidden = true;
    el.replaceChildren();
    window.removeEventListener('pointerdown', outside, true);
    window.removeEventListener('keydown', key, true);
  };
  const outside = (evt: Event) => { if (!el.contains(evt.target as Node)) close(); };
  const key = (evt: KeyboardEvent) => {
    if (evt.key !== 'Escape') return;
    evt.stopPropagation();
    close();
  };
  el.replaceChildren(...actions.map(action => {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'menuitem');
    button.textContent = action.label;
    if (action.hint) button.title = action.hint;
    button.addEventListener('click', () => { close(); action.run(); });
    return button;
  }));
  el.hidden = false;
  // Beside the pointer, kept on screen.
  const parent = (el.offsetParent as HTMLElement | null)?.getBoundingClientRect() ?? { left: 0, top: 0, width: innerWidth, height: innerHeight };
  el.style.left = `${Math.max(8, Math.min(at.x - parent.left + 12, parent.width - el.offsetWidth - 8))}px`;
  el.style.top = `${Math.max(8, Math.min(at.y - parent.top - 12, parent.height - el.offsetHeight - 8))}px`;
  // The menu opens when the press on the handle is let go, so no press is still on its way here.
  window.addEventListener('pointerdown', outside, true);
  window.addEventListener('keydown', key, true);
  (el.firstElementChild as HTMLElement | null)?.focus();
  return close;
}
