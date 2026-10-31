/** Short chart transitions with a clock that stops offscreen. Never changes data. */
const DURATION = 650;
const NUMBER = /-?\d*\.?\d+(?:e[-+]?\d+)?/gi;
type Step = (t: number) => void;

/** Only interpolate compatible geometry, including unchanged SVG arc flags. */
export function geometryTween(from: string, to: string): ((t: number) => string) | null {
  if (from.replace(NUMBER, '#') !== to.replace(NUMBER, '#')) return null;
  const a = (from.match(NUMBER) ?? []).map(Number);
  const b = (to.match(NUMBER) ?? []).map(Number);
  if (a.length !== b.length || a.length > 4096) return null;
  // Arc flags cannot be fractional. A changed sweep uses the entry transition.
  const arcs = [...to.matchAll(/A([^A-Za-z]+)/g)];
  for (const arc of arcs) {
    const start = (to.slice(0, arc.index! + 1).match(NUMBER) ?? []).length;
    if ([start + 2, start + 3, start + 4].some(i => a[i] !== b[i])) return null;
  }
  return t => { let i = 0; return to.replace(NUMBER, () => String(a[i] + (b[i] - a[i++]) * t)); };
}

export class ChartMotion {
  private steps: Step[] = [];
  private raf = 0;
  private elapsed = 0;
  private last = 0;
  private paused = false;
  private reduced = false;
  constructor(private plot: SVGGElement) {}

  setPaused(paused: boolean): void {
    this.paused = paused;
    if (paused) { cancelAnimationFrame(this.raf); this.raf = 0; }
    else this.start();
  }

  setReduced(reduced: boolean): void {
    this.reduced = reduced;
    if (reduced) this.finish();
  }

  private finish(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    for (const step of this.steps) step(1);
    this.steps = [];
  }

  replace(elements: SVGElement[], animate = true): void {
    const previous = new Map([...this.plot.querySelectorAll<SVGElement>('[data-motion-key]')]
      .map(mark => [mark.dataset.motionKey!, mark.getAttribute('d') ?? mark.getAttribute('points') ?? '']));
    this.finish();
    this.plot.replaceChildren(...elements);
    this.prepare(animate ? previous : null);
  }

  replay(): void { this.finish(); this.prepare(new Map()); }
  settle(): void { this.finish(); }
  clear(): void { this.finish(); this.plot.replaceChildren(); }

  private prepare(previous: Map<string, string> | null): void {
    if (previous === null || this.reduced) return;
    this.elapsed = 0;
    const marks = [...this.plot.querySelectorAll<SVGElement>('[data-motion-key]')].slice(0, 120);
    for (const mark of marks) {
      const attribute = mark.hasAttribute('d') ? 'd' : 'points';
      const final = mark.getAttribute(attribute)!;
      const before = previous.get(mark.dataset.motionKey!);
      const tween = before && before !== final ? geometryTween(before, final) : null;
      if (tween) {
        this.steps.push(t => mark.setAttribute(attribute, t === 1 ? final : tween(t)));
      } else if (!before || before !== final) {
        if (mark.classList.contains('chart-bar')) {
          const vertical = mark.dataset.motionAxis === 'y';
          const base = mark.dataset.motionBase ?? '0';
          mark.style.transformOrigin = vertical ? `0px ${base}px` : `${base}px 0px`;
          this.steps.push(t => { mark.style.transform = t === 1 ? '' : vertical ? `scaleY(${t})` : `scaleX(${t})`; });
        } else if (typeof (mark as SVGGeometryElement).getTotalLength === 'function') {
          const length = (mark as SVGGeometryElement).getTotalLength();
          mark.style.strokeDasharray = String(length);
          this.steps.push(t => {
            mark.style.strokeDashoffset = t === 1 ? '' : String(length * (1 - t));
            if (t === 1) mark.style.strokeDasharray = '';
          });
        }
      }
    }
    // Other chart types, axes and labels settle with a small fade.
    this.steps.push(t => { this.plot.style.opacity = t === 1 ? '' : String(0.55 + 0.45 * t); });
    for (const step of this.steps) step(0);
    this.start();
  }

  private start(): void {
    if (this.raf || this.paused || this.reduced || this.steps.length === 0) return;
    this.last = performance.now();
    const frame = (now: number) => {
      this.elapsed += now - this.last;
      this.last = now;
      const t = Math.min(1, this.elapsed / DURATION);
      const eased = 1 - Math.pow(1 - t, 3);
      for (const step of this.steps) step(eased);
      if (t < 1) this.raf = requestAnimationFrame(frame);
      else { this.steps = []; this.raf = 0; }
    };
    this.raf = requestAnimationFrame(frame);
  }
}
