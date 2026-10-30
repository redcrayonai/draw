import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Viewport, chromeInsets, revealDelta, type Insets } from './viewport';

const NONE: Insets = { left: 0, right: 0, top: 0, bottom: 0 };

function mkViewport(width = 1440, height = 848): Viewport {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.getBoundingClientRect = () => ({ left: 0, top: 0, right: width, bottom: height, width, height, x: 0, y: 0 }) as DOMRect;
  const world = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  svg.append(world);
  return new Viewport(svg, world, () => {});
}

const bounds = { minX: 0, minY: 0, maxX: 1200, maxY: 600 };

describe('Viewport.fit insets (G6)', () => {
  it('fit with left inset keeps content right of the inset', () => {
    const vp = mkViewport();
    vp.fit(bounds, { ...NONE, left: 264 });
    const tl = vp.worldToScreen(bounds.minX, bounds.minY);
    const br = vp.worldToScreen(bounds.maxX, bounds.maxY);
    expect(tl.x).toBeGreaterThanOrEqual(264);
    expect(br.x).toBeLessThanOrEqual(1440);
    expect(br.y).toBeLessThanOrEqual(848);
  });

  it('centres the content inside the free sub-rect, clear of every inset', () => {
    const vp = mkViewport();
    const insets = { left: 264, right: 352, top: 0, bottom: 98 };
    vp.fit(bounds, insets);
    const tl = vp.worldToScreen(bounds.minX, bounds.minY);
    const br = vp.worldToScreen(bounds.maxX, bounds.maxY);
    expect(tl.x).toBeGreaterThanOrEqual(264);
    expect(br.x).toBeLessThanOrEqual(1440 - 352);
    expect(br.y).toBeLessThanOrEqual(848 - 98);
    // the slack is split evenly between the two free-rect sides
    expect(Math.abs((tl.x - 264) - (1440 - 352 - br.x))).toBeLessThan(1);
  });

  it('without insets fits as before', () => {
    const a = mkViewport();
    const b = mkViewport();
    a.fit(bounds);
    b.fit(bounds, NONE);
    expect([a.tx, a.ty, a.scale]).toEqual([b.tx, b.ty, b.scale]);
    expect(a.worldToScreen(0, 0).x).toBeGreaterThanOrEqual(64);
  });

  it('ignores insets that leave no usable room (narrow screens)', () => {
    const vp = mkViewport(400, 700);
    vp.fit(bounds, { ...NONE, left: 380 });
    expect(vp.scale).toBeGreaterThan(0.1);
    expect(vp.worldToScreen(bounds.maxX, 0).x).toBeLessThanOrEqual(400);
  });
});

describe('Viewport.stopAnimation (G7)', () => {
  it('stops a running reveal pan where it is: later frames move nothing', () => {
    const frames = new Map<number, FrameRequestCallback>();
    let next = 0;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.set(++next, cb); return next; });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
    const flush = (t: number) => { const due = [...frames.values()]; frames.clear(); for (const cb of due) cb(t); };
    try {
      const vp = mkViewport();
      const t0 = performance.now();
      vp.panTo(400, 0, 200);
      flush(t0 + 50);
      const mid = vp.tx;
      expect(mid).toBeGreaterThan(0);
      expect(mid).toBeLessThan(400);
      vp.stopAnimation();
      expect(frames.size).toBe(0);
      flush(t0 + 400);
      expect(vp.tx).toBe(mid);
      // nothing is left running: the same target pans again
      vp.panTo(400, 0, 0);
      expect(vp.tx).toBe(400);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('is a no-op when nothing runs', () => {
    const vp = mkViewport();
    vp.stopAnimation();
    expect([vp.tx, vp.ty, vp.scale]).toEqual([0, 0, 1]);
  });
});

describe('revealDelta (G7)', () => {
  // 1440-wide canvas: rail right edge 248, inspector left edge 1104, 16 px margins
  const free = { left: 248 + 16, right: 1104 - 16, top: 72, bottom: 750 };

  it('selection under inspector → pan left by overlap + margin', () => {
    const sel = { x: 1100, y: 300, w: 200, h: 80 };
    const overlap = sel.x + sel.w - 1104;
    expect(revealDelta(sel, free)).toEqual({ dx: -(overlap + 16), dy: 0 });
  });

  it('selection under the rail → pan right by the smallest delta', () => {
    expect(revealDelta({ x: 100, y: 300, w: 160, h: 80 }, free)).toEqual({ dx: 164, dy: 0 });
  });

  it('a selection already inside the free rect does not move', () => {
    expect(revealDelta({ x: 400, y: 300, w: 160, h: 80 }, free)).toEqual({ dx: 0, dy: 0 });
  });

  it('a selection wider than the free rect is centred in it', () => {
    const sel = { x: 0, y: 300, w: 1000, h: 80 };
    const d = revealDelta(sel, free);
    expect(sel.x + d.dx + sel.w / 2).toBe((free.left + free.right) / 2);
  });

  it('vertical: a selection under the toolbar margin pans down', () => {
    expect(revealDelta({ x: 400, y: 20, w: 160, h: 80 }, free)).toEqual({ dx: 0, dy: 52 });
  });
});

describe('chromeInsets (G6/G7)', () => {
  const rect = (left: number, top: number, width: number, height: number) =>
    () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top }) as DOMRect;

  beforeEach(() => {
    document.body.innerHTML = `
      <div id="canvas-wrap">
        <aside id="rail"></aside>
        <aside id="inspector" hidden></aside>
        <div id="dock"></div>
      </div>`;
    const wrap = document.getElementById('canvas-wrap')!;
    wrap.getBoundingClientRect = rect(0, 52, 1440, 848);
    document.getElementById('rail')!.getBoundingClientRect = rect(16, 68, 232, 400);
    document.getElementById('inspector')!.getBoundingClientRect = rect(1104, 68, 320, 500);
    document.getElementById('dock')!.getBoundingClientRect = rect(548, 818, 344, 58);
  });

  it('reserves the rail, the dock and (when open) the inspector', () => {
    const wrap = document.getElementById('canvas-wrap')!;
    expect(chromeInsets(wrap)).toEqual({ left: 264, right: 0, top: 0, bottom: 900 - 818 + 16 });
    document.getElementById('inspector')!.hidden = false;
    expect(chromeInsets(wrap).right).toBe(1440 - 1104 + 16);
  });

  it('narrow screens: the rail sheet reserves the top, the inspector sheet the bottom', () => {
    const wrap = document.getElementById('canvas-wrap')!;
    document.getElementById('rail')!.getBoundingClientRect = rect(16, 68, 1408, 350);
    document.getElementById('inspector')!.getBoundingClientRect = rect(16, 500, 1408, 300);
    document.getElementById('inspector')!.hidden = false;
    expect(chromeInsets(wrap)).toEqual({ left: 0, right: 0, top: 68 + 350 - 52 + 16, bottom: 900 - 500 + 16 });
  });

  it('a dismissed rail reserves nothing', () => {
    document.getElementById('rail')!.classList.add('collapsed');
    expect(chromeInsets(document.getElementById('canvas-wrap')!).left).toBe(0);
  });
});
