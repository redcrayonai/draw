import { describe, it, expect } from 'vitest';
import type { ScatterData, ScatterPoint } from '../../../module/src/chart-contracts';
import { renderScatter } from './scatter';
import { textW } from './scale';
import { attr, group, INLINE_COLOR } from './test-util';

const BOX = { x: 16, y: 40, w: 320, h: 160 };
/** formatValue puts a thin space between a value and its unit. */
const THIN = '\u2009';
const pt = (x: number, y: number, g = 0, label = ''): ScatterPoint => ({ x, y, group: g, label });
const POINTS = [pt(2, 140, 0, '/login'), pt(12, 520, 0, '/search'), pt(48, 1240, 1, '/checkout'), pt(92, 2210, 1, '/export')];

function sc(points = POINTS, groups = ['auth', 'web'], over: Partial<ScatterData> = {}): ScatterData {
  return { type: 'scatter', options: { xUnit: 'KB', yUnit: 'ms' }, xName: 'payload', yName: 'p99', groups, points, ...over };
}

const render = (d: ScatterData, dense = false, box = BOX) => group(renderScatter(d, box, dense));
const dots = (g: SVGGElement) => [...g.querySelectorAll('circle.chart-point')];
const hits = (g: SVGGElement) => [...g.querySelectorAll('circle.chart-hit')];

describe('renderScatter', () => {
  it('places every point on two linear axes, larger x to the right and larger y up', () => {
    const d = dots(render(sc()));
    expect(d).toHaveLength(4);
    const cx = d.map(c => attr(c, 'cx'));
    const cy = d.map(c => attr(c, 'cy'));
    // linear: equal steps in x are equal steps in px
    const perX = (cx[3] - cx[0]) / (92 - 2);
    expect(cx[1] - cx[0]).toBeCloseTo(perX * 10, 1);
    expect(cx[2] - cx[0]).toBeCloseTo(perX * 46, 1);
    const perY = (cy[0] - cy[3]) / (2210 - 140);
    expect(cy[0] - cy[1]).toBeCloseTo(perY * 380, 1);
    for (const c of d) {
      expect(attr(c, 'cx')).toBeGreaterThanOrEqual(BOX.x);
      expect(attr(c, 'cx')).toBeLessThanOrEqual(BOX.x + BOX.w);
      expect(attr(c, 'cy')).toBeGreaterThanOrEqual(BOX.y);
      expect(attr(c, 'cy')).toBeLessThanOrEqual(BOX.y + BOX.h);
    }
  });

  it('colours points by group slot, ringed, with a legend for two or more groups', () => {
    const g = render(sc());
    expect(dots(g).map(c => c.getAttribute('class'))).toEqual([
      'chart-point chart-ring series-1', 'chart-point chart-ring series-1', 'chart-point chart-ring series-2', 'chart-point chart-ring series-2',
    ]);
    expect([...g.querySelectorAll('.chart-legend .chart-legend-text')].map(t => t.textContent)).toEqual(['auth', 'web']);
    expect(render(sc(POINTS.map(p => ({ ...p, group: 0 })), [])).querySelector('.chart-legend')).toBeNull();
    expect(render(sc(POINTS.map(p => ({ ...p, group: 0 })), ['only'])).querySelector('.chart-legend')).toBeNull();
    expect(g.outerHTML).not.toMatch(INLINE_COLOR);
  });

  it('titles both axes with their units; no x tick label runs under the x title', () => {
    const g = render(sc());
    const titles = [...g.querySelectorAll('text.chart-axis-title')];
    expect(titles.map(t => [t.textContent, t.getAttribute('text-anchor')])).toEqual([['p99 (ms)', 'start'], ['payload (KB)', 'end']]);
    const xTitle = titles[1];
    const titleLeft = attr(xTitle, 'x') - textW('payload (KB)', 10);
    const xTicks = [...g.querySelectorAll('text.chart-tick')].filter(t => t.getAttribute('y') === xTitle.getAttribute('y'));
    expect(xTicks.length).toBeGreaterThan(1);
    for (const t of xTicks) expect(attr(t, 'x') + textW(t.textContent ?? '', 10) / 2).toBeLessThanOrEqual(titleLeft);
    // the y title starts where the plot does, right of every y tick label
    const yTicks = [...g.querySelectorAll('text.chart-tick')].filter(t => t.getAttribute('text-anchor') === 'end');
    for (const t of yTicks) expect(attr(t, 'x')).toBeLessThan(attr(titles[0], 'x'));
    expect(render(sc(POINTS, ['auth', 'web'], { options: { xUnit: '', yUnit: '' } })).querySelector('text.chart-axis-title')?.textContent).toBe('p99');
  });

  it('gives each point a hit circle with its label, group and both values', () => {
    const h = hits(render(sc()));
    expect(h).toHaveLength(4);
    expect(h[2].getAttribute('data-tip-head')).toBe('/checkout · web');
    expect(JSON.parse(h[2].getAttribute('data-tip-rows')!)).toEqual([
      { slot: 2, name: 'payload', value: `48${THIN}KB` },
      { slot: 2, name: 'p99', value: `1,240${THIN}ms` },
    ]);
    expect(h[2].getAttribute('data-tip')).toBe(`/checkout · web\npayload: 48${THIN}KB\np99: 1,240${THIN}ms`);
    // the hit circle sits on its dot and is larger than it
    const d = dots(render(sc()));
    expect([attr(h[2], 'cx'), attr(h[2], 'cy')]).toEqual([attr(d[2], 'cx'), attr(d[2], 'cy')]);
    expect(attr(h[2], 'r')).toBeGreaterThan(attr(d[2], 'r'));
    // no label and no group: no head
    const plain = hits(render(sc([pt(1, 2)], [])))[0];
    expect(plain.hasAttribute('data-tip-head')).toBe(false);
    expect(plain.getAttribute('data-tip')).toBe(`payload: 1${THIN}KB\np99: 2${THIN}ms`);
  });

  it('a flat axis still places its points inside the plot', () => {
    const d = dots(render(sc([pt(5, 7), pt(5, 7), pt(5, 9)], [])));
    for (const c of d) {
      expect(Number.isFinite(attr(c, 'cx')) && Number.isFinite(attr(c, 'cy'))).toBe(true);
      expect(attr(c, 'cx')).toBeGreaterThan(BOX.x);
      expect(attr(c, 'cx')).toBeLessThan(BOX.x + BOX.w);
    }
  });

  it('a short card drops the legend, then the y title, so the plot keeps its height', () => {
    const tall = render(sc());
    expect(tall.querySelector('.chart-legend')).not.toBeNull();
    const short = render(sc(), false, { x: 0, y: 0, w: 192, h: 60 });
    expect(short.querySelector('.chart-legend')).toBeNull();
    expect([...short.querySelectorAll('text.chart-axis-title')].map(t => t.textContent)).toEqual(['payload (KB)']);
    const ys = dots(short).map(c => attr(c, 'cy'));
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThanOrEqual(30);
  });

  it('dense keeps only the dots and their hit circles', () => {
    const g = render(sc(), true);
    expect(dots(g)).toHaveLength(4);
    expect(hits(g)).toHaveLength(4);
    expect(g.querySelector('text, line, .chart-legend')).toBeNull();
  });
});
