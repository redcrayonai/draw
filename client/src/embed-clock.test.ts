import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { EmbedClock } from './embed-clock';

describe('diagram playback clock', () => {
  let frame: FrameRequestCallback | undefined;
  let now = 0;
  beforeEach(() => {
    now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frame = cb; return 1; });
    vi.stubGlobal('cancelAnimationFrame', () => { frame = undefined; });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  const tick = (ms: number) => { now += ms; const cb = frame; frame = undefined; cb?.(now); };
  it('keeps the same position through pause, offscreen suspension and resume', () => {
    const paint = vi.fn(), clock = new EmbedClock(1000, paint, vi.fn());
    clock.play(); tick(200); clock.pause(); tick(5000);
    expect(clock.elapsed).toBe(200);
    clock.play(); tick(100); clock.setBlocked(true); tick(5000);
    expect(clock.elapsed).toBe(300);
    expect(frame).toBeUndefined();
    clock.setBlocked(false); tick(150);
    expect(clock.elapsed).toBe(450);
    expect(paint).toHaveBeenLastCalledWith(450);
    clock.destroy(); expect(frame).toBeUndefined();
  });
  it('finishes once, replays from zero, and loops only when selected', () => {
    const clock = new EmbedClock(1000, vi.fn(), vi.fn());
    clock.play(); tick(1200); expect(clock.elapsed).toBe(1000); expect(clock.playing).toBe(false);
    clock.replay(); expect(clock.elapsed).toBe(0); expect(clock.playing).toBe(true);
    clock.loop = true; tick(1200); expect(clock.elapsed).toBe(200); expect(clock.playing).toBe(true);
  });
  it('settles to the final static view for reduced motion and never autoplays when disabled', () => {
    const paint = vi.fn(), clock = new EmbedClock(1000, paint, vi.fn());
    clock.play(); tick(200); clock.setReduced(true); tick(5000);
    expect(clock.elapsed).toBe(1000); expect(clock.playing).toBe(false);
    expect(paint).toHaveBeenLastCalledWith(1000);
    clock.replay(); expect(frame).toBeUndefined();
    clock.setReduced(false); expect(frame).toBeUndefined();
    clock.play(); tick(100); expect(clock.elapsed).toBe(100);
  });
});
