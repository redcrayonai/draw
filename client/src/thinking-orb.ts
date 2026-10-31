import { MODE_DRAWS, resolvePreset, type OrbSize, type OrbState } from 'thinking-orbs/engine';
import { isDarkTheme } from '../../shared/themes';

/**
 * A dotted thinking orb (thinking-orbs) on a plain canvas: the library's
 * React component, minus React. Animates only while the canvas is on screen
 * (a `hidden` ancestor stops it); reduced motion gets one still frame. Ink
 * follows the live theme's scheme, neo-brutalism reading as light paper.
 */
export function mountThinkingOrb(canvas: HTMLCanvasElement, state: OrbState, size: OrbSize): void {
  const ctx = canvas.getContext('2d');
  if (ctx === null) {
    return;
  }
  const dpr = Math.min(2, devicePixelRatio || 1);
  canvas.width = Math.round(size * dpr);
  canvas.height = Math.round(size * dpr);
  canvas.style.width = canvas.style.height = `${size}px`;
  const { mode, speed, opts } = resolvePreset(state, size);
  const draw = MODE_DRAWS[mode];
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  const frame = (): void => {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    const dark = isDarkTheme(document.documentElement.dataset.theme);
    draw(ctx, size, reduced ? 0.6 : (performance.now() / 1000) * speed, dark, opts);
  };

  let raf = 0;
  const loop = (): void => {
    frame();
    raf = requestAnimationFrame(loop);
  };
  new IntersectionObserver(([entry]) => {
    cancelAnimationFrame(raf);
    if (entry?.isIntersecting) {
      reduced ? frame() : loop();
    }
  }).observe(canvas);
  // The animated loop picks the theme up each frame; the still one repaints.
  if (reduced) {
    new MutationObserver(frame).observe(document.documentElement, { attributeFilter: ['data-theme'] });
  }
}
