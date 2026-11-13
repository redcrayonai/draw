const MIN_SCALE = 0.1;
const MAX_SCALE = 4;
const FIT_MARGIN = 64;
/** Panels that leave less free room than this are ignored (narrow screens). */
export const MIN_FREE = 240;
/** Space kept between a floating panel and the content or selection. */
export const PANEL_GAP = 16;

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Screen space covered by floating chrome, per side of the canvas. */
export interface Insets {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

const NO_INSETS: Insets = { left: 0, right: 0, top: 0, bottom: 0 };

/** A floating panel's rect when it is on screen (not hidden, not dismissed, takes space), else null. */
function shownRect(id: string): DOMRect | null {
  const el = document.getElementById(id);
  if (el === null || el.hidden || el.classList.contains('collapsed')) return null;
  // A display: none panel (the walk-through hides side panels so) has an all-zero rect.
  const r = el.getBoundingClientRect();
  return r.width > 0 || r.height > 0 ? r : null;
}

/**
 * Canvas insets for the rail (left), the inspector (right) and the dock HUD
 * (bottom), each including a PANEL_GAP, in canvas-wrap pixels. A panel wider
 * than 70% of the canvas is a narrow-screen sheet: the rail then reserves the
 * top and the inspector, which docks at the bottom, the bottom.
 */
export function chromeInsets(wrap: HTMLElement): Insets {
  const w = wrap.getBoundingClientRect();
  const insets = { ...NO_INSETS };
  const rail = shownRect('rail');
  if (rail) {
    if (rail.width < w.width * 0.7) {
      insets.left = rail.right - w.left + PANEL_GAP;
    } else {
      insets.top = rail.bottom - w.top + PANEL_GAP;
    }
  }
  const dock = shownRect('dock');
  if (dock) {
    insets.bottom = w.bottom - dock.top + PANEL_GAP;
  }
  // The depth trail sits top centre while the view is inside a frame: keep the frame clear of it.
  const trail = shownRect('depth-trail');
  if (trail) {
    insets.top = Math.max(insets.top, trail.bottom - w.top);
  }
  // The walk-through bar replaces the dock while it plays; reserve from its top edge down.
  const bar = shownRect('telling-bar');
  if (bar) {
    insets.bottom = Math.max(insets.bottom, w.bottom - bar.top + PANEL_GAP);
  }
  const inspector = shownRect('inspector');
  if (inspector) {
    if (inspector.width < w.width * 0.7) {
      insets.right = w.right - inspector.left + PANEL_GAP;
    } else {
      insets.bottom = Math.max(insets.bottom, w.bottom - inspector.top + PANEL_GAP);
    }
  }
  return insets;
}

/**
 * Smallest pan that brings `sel` inside `free` (both screen rects), per
 * axis; a selection larger than the free rect on an axis is centred in it.
 */
export function revealDelta(
  sel: { x: number; y: number; w: number; h: number },
  free: { left: number; right: number; top: number; bottom: number }
): { dx: number; dy: number } {
  const axis = (start: number, size: number, lo: number, hi: number): number => {
    if (size > hi - lo) return (lo + hi) / 2 - (start + size / 2);
    if (start < lo) return lo - start;
    if (start + size > hi) return hi - (start + size);
    return 0;
  };
  return {
    dx: axis(sel.x, sel.w, free.left, free.right),
    dy: axis(sel.y, sel.h, free.top, free.bottom),
  };
}

/** Exponential ease-out. */
function easeOutExpo(t: number): number {
  return t >= 1 ? 1 : 1 - Math.pow(2, -10 * t);
}

export class Viewport {
  tx = 0;
  ty = 0;
  scale = 1;

  constructor(
    private svg: SVGSVGElement,
    private world: SVGGElement,
    private onChange: () => void
  ) {}

  screenToWorld(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.svg.getBoundingClientRect();
    return {
      x: (clientX - rect.left - this.tx) / this.scale,
      y: (clientY - rect.top - this.ty) / this.scale,
    };
  }

  worldToScreen(x: number, y: number): { x: number; y: number } {
    return { x: x * this.scale + this.tx, y: y * this.scale + this.ty };
  }

  private anim: { raf: number; tx: number; ty: number } | null = null;

  /** Stop a running panTo where it is: any direct gesture or zoom takes over
   *  (the canvas pointerdown calls it before starting a drag, marquee or pan). */
  stopAnimation(): void {
    if (this.anim !== null) {
      cancelAnimationFrame(this.anim.raf);
      this.anim = null;
    }
  }

  /** Pan to a translation, eased over `ms` (0 jumps). Re-requesting the
   *  running target is a no-op, so repeated reveals do not restart it. */
  panTo(tx: number, ty: number, ms: number): void {
    if (this.anim !== null && this.anim.tx === tx && this.anim.ty === ty) {
      return;
    }
    this.stopAnimation();
    if (ms <= 0 || typeof requestAnimationFrame !== 'function') {
      this.tx = tx;
      this.ty = ty;
      this.apply();
      return;
    }
    const fromX = this.tx;
    const fromY = this.ty;
    const t0 = performance.now();
    const step = (now: number) => {
      const k = easeOutExpo(Math.min(1, (now - t0) / ms));
      this.tx = fromX + (tx - fromX) * k;
      this.ty = fromY + (ty - fromY) * k;
      if (k < 1 && this.anim !== null) {
        this.anim.raf = requestAnimationFrame(step);
      } else {
        this.anim = null;
      }
      this.apply();
    };
    this.anim = { raf: requestAnimationFrame(step), tx, ty };
  }

  apply(): void {
    this.world.setAttribute(
      'transform',
      `translate(${this.tx} ${this.ty}) scale(${this.scale})`
    );
    this.onChange();
  }

  panBy(dx: number, dy: number): void {
    this.stopAnimation();
    this.tx += dx;
    this.ty += dy;
    this.apply();
  }

  /** Zoom by `factor`, keeping the world point under (clientX, clientY) fixed. */
  zoomAt(clientX: number, clientY: number, factor: number): void {
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, this.scale * factor));
    if (next === this.scale) {
      return;
    }
    this.stopAnimation();
    const rect = this.svg.getBoundingClientRect();
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    const wx = (sx - this.tx) / this.scale;
    const wy = (sy - this.ty) / this.scale;
    this.scale = next;
    this.tx = sx - wx * next;
    this.ty = sy - wy * next;
    this.apply();
  }

  /** Zoom by a factor, anchored at the viewport center. */
  zoomCentered(factor: number): void {
    const rect = this.svg.getBoundingClientRect();
    this.zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
  }

  /** Reset to 100%, anchored at the viewport center. */
  reset(): void {
    this.stopAnimation();
    const rect = this.svg.getBoundingClientRect();
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    const wx = (cx - this.tx) / this.scale;
    const wy = (cy - this.ty) / this.scale;
    this.scale = 1;
    this.tx = cx - wx;
    this.ty = cy - wy;
    this.apply();
  }

  /**
   * Frame `bounds` with a margin inside the part of the canvas that floating
   * chrome leaves free (`insets`, see chromeInsets). Insets that would leave
   * less than MIN_FREE across (MIN_FREE / 2 down) are ignored on that axis.
   * With `ms`, the view zooms there over that time (stepping into a frame and out).
   */
  fit(bounds: Bounds | null, insets: Insets = NO_INSETS, ms = 0): void {
    this.frame(bounds, insets, ms, MAX_SCALE);
  }

  /** fit over `ms` that never zooms past `maxScale`: a walk-through step stays in its surroundings. */
  flyTo(bounds: Bounds | null, insets: Insets, ms: number, maxScale = 1.5): void {
    this.frame(bounds, insets, ms, maxScale);
  }

  private frame(bounds: Bounds | null, insets: Insets, ms: number, maxScale: number): void {
    if (!bounds) {
      // Nothing to frame: a zoom still on its way to bounds that are gone stops where it is.
      this.stopAnimation();
      return;
    }
    const rect = this.svg.getBoundingClientRect();
    const w = bounds.maxX - bounds.minX;
    const h = bounds.maxY - bounds.minY;
    if (w <= 0 || h <= 0 || rect.width === 0 || rect.height === 0) {
      return;
    }
    this.stopAnimation();
    const side = (inset: number) => Math.max(FIT_MARGIN, inset + PANEL_GAP);
    let left = side(insets.left);
    let right = rect.width - side(insets.right);
    if (right - left < MIN_FREE) {
      left = FIT_MARGIN;
      right = rect.width - FIT_MARGIN;
    }
    let top = side(insets.top);
    let bottom = rect.height - side(insets.bottom);
    if (bottom - top < MIN_FREE / 2) {
      top = FIT_MARGIN;
      bottom = rect.height - FIT_MARGIN;
    }
    const scale = Math.min(
      maxScale,
      Math.max(MIN_SCALE, Math.min((right - left) / w, (bottom - top) / h))
    );
    const tx = left + (right - left - w * scale) / 2 - bounds.minX * scale;
    const ty = top + (bottom - top - h * scale) / 2 - bounds.minY * scale;
    if (ms <= 0 || typeof requestAnimationFrame !== 'function') {
      this.scale = scale;
      this.tx = tx;
      this.ty = ty;
      this.apply();
      return;
    }
    // Zoom about the middle of the free canvas: the world point under it glides from where it is
    // to the bounds' centre while the scale steps evenly, so the target never swings off screen.
    const cx = (left + right) / 2, cy = (top + bottom) / 2;
    const fromScale = this.scale;
    const fromX = (cx - this.tx) / fromScale, fromY = (cy - this.ty) / fromScale;
    const toX = (cx - tx) / scale, toY = (cy - ty) / scale;
    const t0 = performance.now();
    const step = (now: number) => {
      const k = easeOutExpo(Math.min(1, (now - t0) / ms));
      this.scale = fromScale * Math.pow(scale / fromScale, k);
      this.tx = cx - (fromX + (toX - fromX) * k) * this.scale;
      this.ty = cy - (fromY + (toY - fromY) * k) * this.scale;
      if (k < 1 && this.anim !== null) {
        this.anim.raf = requestAnimationFrame(step);
      } else {
        this.anim = null;
      }
      this.apply();
    };
    this.anim = { raf: requestAnimationFrame(step), tx, ty };
  }
}
