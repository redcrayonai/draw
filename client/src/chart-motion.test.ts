import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { ChartMotion, geometryTween } from './chart-motion';
import { svgEl } from './charts/svg';

describe('chart transition clock', () => {
  let frame: FrameRequestCallback | undefined;
  let now = 0;
  beforeEach(() => {
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frame = cb; return 1; });
    vi.stubGlobal('cancelAnimationFrame', () => { frame = undefined; });
    now = 0;
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  const tick = (ms: number) => { now += ms; const cb = frame; frame = undefined; cb?.(now); };
  const bar = (end: number) => svgEl('path', { class: 'chart-bar', d: `M0 20 L0 ${end} L10 ${end} L10 20 Z`, 'data-motion-key': 'a', 'data-motion-axis': 'y', 'data-motion-base': '20' });

  it('pauses the clock offscreen and resumes from the same point', () => {
    const plot = svgEl('g'), motion = new ChartMotion(plot);
    const mark = bar(2);
    motion.replace([mark]);
    tick(150);
    const midway = mark.style.transform;
    motion.setPaused(true);
    tick(5000);
    expect(frame).toBeUndefined();
    expect(mark.style.transform).toBe(midway);
    motion.setPaused(false);
    tick(100);
    expect(mark.style.transform).not.toBe(midway);
    tick(650);
    expect(mark.style.transform).toBe('');
  });
  it('morphs changed geometry and settles immediately when reduced motion is enabled', () => {
    const plot = svgEl('g'), motion = new ChartMotion(plot);
    motion.replace([bar(2)], false);
    const mark = bar(10);
    motion.replace([mark]);
    expect(mark.getAttribute('d')).toContain('L0 2');
    tick(200);
    expect(mark.getAttribute('d')).not.toBe(bar(2).getAttribute('d'));
    motion.setReduced(true);
    expect(mark.getAttribute('d')).toBe(bar(10).getAttribute('d'));
    expect(frame).toBeUndefined();
    motion.replay();
    expect(frame).toBeUndefined();
  });
  it('refuses incompatible paths and changed arc flags', () => {
    expect(geometryTween('M0 0 L2 3', 'M0 0 L4 7')?.(0.5)).toBe('M0 0 L3 5');
    expect(geometryTween('M0 0', 'M0 0 L2 3')).toBeNull();
    expect(geometryTween('M0 0 A2 2 0 0 1 4 4', 'M0 0 A2 2 0 0 0 4 4')).toBeNull();
  });
});
