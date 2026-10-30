import { describe, it, expect } from 'vitest';
import type { TimeseriesData } from '../../../module/src/chart-contracts';
import { renderTimeseries } from './timeseries';
import { textW } from './scale';
import { attr, group, INLINE_COLOR } from './test-util';

const BOX = { x: 16, y: 40, w: 320, h: 150 };
const MIN = 60_000;
const t0 = Date.UTC(2026, 9, 9, 10, 0);

function ts(over: Partial<TimeseriesData> = {}, series = [
  { name: 'checkout', values: [120, 135, 180, 160, 140, 128, 122] as (number | null)[] },
  { name: 'search', values: [95, 98, 102, 99, 97, 96, 98] as (number | null)[] },
]): TimeseriesData {
  return {
    type: 'timeseries',
    options: { style: 'line', unit: 'ms' },
    xName: 'time',
    xKind: 'iso',
    xs: series[0].values.map((_, i) => t0 + i * 5 * MIN),
    series,
    ...over,
  };
}

const render = (d: TimeseriesData, dense = false) => group(renderTimeseries(d, BOX, dense));
const points = (p: Element) => (p.getAttribute('points') ?? '').split(' ').map(s => s.split(',').map(Number));

describe('renderTimeseries', () => {
  it('draws one 2 px round-joined line per series with series classes in order', () => {
    const g = render(ts());
    const lines = [...g.querySelectorAll('polyline.chart-line')];
    expect(lines.map(l => l.getAttribute('class'))).toEqual(['chart-line series-1', 'chart-line series-2']);
    for (const l of lines) {
      expect(l.getAttribute('stroke-width')).toBe('2');
      expect(l.getAttribute('stroke-linejoin')).toBe('round');
      expect(l.getAttribute('stroke-linecap')).toBe('round');
      expect(l.getAttribute('fill')).toBe('none');
      expect(points(l)).toHaveLength(7);
    }
  });

  it('maps x by time and y from a zero baseline', () => {
    const g = render(ts());
    const pts = points(g.querySelector('polyline.series-1')!);
    const step = pts[1][0] - pts[0][0];
    for (let i = 1; i < pts.length; i++) expect(pts[i][0] - pts[i - 1][0]).toBeCloseTo(step, 1);
    const base = g.querySelector('line.chart-base')!;
    expect(g.querySelector('text.chart-tick')!.textContent).toBe('0');
    const baseY = attr(base, 'y1');
    const topTick = [...g.querySelectorAll('line.chart-grid')].map(l => attr(l, 'y1')).sort((a, b) => a - b)[0];
    // 180 on a 0..200 axis sits at 90 % of the height.
    expect(pts[2][1]).toBeCloseTo(baseY - 0.9 * (baseY - topTick), 1);
  });

  it('uses a nice minimum when a line sits far from zero', () => {
    const g = render(ts({}, [{ name: 'availability', values: [99.91, 99.93, 99.9, 99.95] }]));
    const ticks = [...g.querySelectorAll('text.chart-tick')].map(t => t.textContent);
    expect(ticks[0]).not.toBe('0');
    expect(Number(ticks[0])).toBeGreaterThan(99);
  });

  it('splits the line at a null and marks a lone point', () => {
    const g = render(ts({}, [{ name: 'p99', values: [10, 12, null, 14, null, 11, 13] }]));
    const lines = [...g.querySelectorAll('polyline.chart-line')];
    expect(lines.map(l => points(l).length)).toEqual([2, 2]);
    expect(g.querySelectorAll('circle.chart-point')).toHaveLength(1);
    expect(g.querySelector('circle.chart-point')!.getAttribute('class')).toBe('chart-point series-1');
  });

  it('M2: the default line style washes only series 1, at 10 % opacity', () => {
    const areas = [...render(ts()).querySelectorAll('path.chart-area')];
    expect(areas.map(a => a.getAttribute('class'))).toEqual(['chart-area series-1']);
    expect(areas[0].getAttribute('fill-opacity')).toBe('0.1');
  });

  it('fills areas at 10 % opacity as an attribute', () => {
    const g = render(ts({ options: { style: 'area', unit: 'ms' } }));
    const areas = [...g.querySelectorAll('path.chart-area')];
    expect(areas).toHaveLength(2);
    for (const a of areas) expect(a.getAttribute('fill-opacity')).toBe('0.1');
    expect(g.querySelectorAll('polyline.chart-line')).toHaveLength(2);
  });

  it('stacks: the second line draws the running total, its band sits on the first', () => {
    const series = [
      { name: 'a', values: [10, 20, 30] as (number | null)[] },
      { name: 'b', values: [5, null, 5] as (number | null)[] },
    ];
    const g = render(ts({ options: { style: 'stacked', unit: '' } }, series));
    const [la, lb] = [...g.querySelectorAll('polyline.chart-line')].map(points);
    expect(lb).toHaveLength(3); // a null counts as 0 in a stack: no split
    expect(lb[1][1]).toBeCloseTo(la[1][1], 5); // 20 + 0 = 20
    expect(lb[0][1]).toBeLessThan(la[0][1]); // 15 above 10
    const band = g.querySelectorAll('path.chart-area')[1].getAttribute('d')!;
    expect(band).toContain(`${la[2][0]},${la[2][1]}`);
    const total = g.querySelectorAll('rect.chart-hit')[0].getAttribute('data-tip')!;
    expect(total.split('\n')).toContain('total: 15');
  });

  it('puts a 4 px ringed dot at each last value and labels up to four series', () => {
    const g = render(ts());
    const dots = [...g.querySelectorAll('circle.chart-dot')];
    expect(dots.map(c => c.getAttribute('class'))).toEqual(['chart-dot chart-ring series-1', 'chart-dot chart-ring series-2']);
    expect(dots.every(c => c.getAttribute('r') === '4' && c.getAttribute('stroke-width') === '2')).toBe(true);
    const labels = [...g.querySelectorAll('text.chart-label')];
    expect(labels.map(l => l.textContent).sort()).toEqual(['122\u2009ms', '98\u2009ms']);
    expect(labels.every(l => !/series-/.test(l.getAttribute('class')!))).toBe(true);
    const ys = labels.map(l => attr(l, 'y')).sort((a, b) => a - b);
    expect(ys[1] - ys[0]).toBeGreaterThanOrEqual(12);
  });

  it('drops end labels past four series', () => {
    const five = ['a', 'b', 'c', 'd', 'e'].map((name, k) => ({ name, values: [k, k + 1] as (number | null)[] }));
    const g = render(ts({}, five));
    expect(g.querySelectorAll('text.chart-label')).toHaveLength(0);
    expect([...g.querySelectorAll('polyline')].map(p => p.getAttribute('class'))).toEqual(
      ['series-1', 'series-2', 'series-3', 'series-4', 'series-5'].map(c => `chart-line ${c}`),
    );
  });

  it('emits one transparent hit column per x with the crosshair x and every series value', () => {
    const g = render(ts());
    const hits = [...g.querySelectorAll('rect.chart-hit')];
    expect(hits).toHaveLength(7);
    expect(hits.every(h => h.getAttribute('fill') === 'transparent')).toBe(true);
    const pts = points(g.querySelector('polyline.series-1')!);
    hits.forEach((h, i) => expect(attr(h, 'data-x')).toBeCloseTo(pts[i][0], 1));
    expect(hits[2].getAttribute('data-tip')).toBe('10:10\ncheckout: 180\u2009ms\nsearch: 102\u2009ms');
    // columns tile the plot without gaps
    for (let i = 1; i < hits.length; i++) {
      expect(attr(hits[i], 'x')).toBeCloseTo(attr(hits[i - 1], 'x') + attr(hits[i - 1], 'width'), 1);
    }
  });

  it('shows a null as a dash in the tooltip', () => {
    const g = render(ts({}, [{ name: 'p99', values: [10, null, 12] }, { name: 'p50', values: [5, 6, 7] }]));
    expect(g.querySelectorAll('rect.chart-hit')[1].getAttribute('data-tip')).toBe('10:05\np99: —\np50: 6\u2009ms');
  });

  it('labels x ticks in HH:MM and dedupes repeats', () => {
    const g = render(ts());
    const xt = [...g.querySelectorAll('text.chart-tick')].map(t => t.textContent).filter(s => s!.includes(':'));
    expect(xt[0]).toBe('10:00');
    expect(xt[xt.length - 1]).toBe('10:30');
    expect(new Set(xt).size).toBe(xt.length);
  });

  it('adds a legend for two or more series and none for one', () => {
    expect(render(ts()).querySelectorAll('.chart-legend .chart-swatch')).toHaveLength(2);
    expect(render(ts({}, [{ name: 'only', values: [1, 2] }])).querySelector('.chart-legend')).toBeNull();
  });

  it('dense drops axes, ticks, labels and legend but keeps marks and hits', () => {
    const g = render(ts(), true);
    expect(g.querySelectorAll('text')).toHaveLength(0);
    expect(g.querySelectorAll('.chart-grid, .chart-base, .chart-legend')).toHaveLength(0);
    expect(g.querySelectorAll('polyline.chart-line')).toHaveLength(2);
    expect(g.querySelectorAll('circle.chart-dot')).toHaveLength(2);
    expect(g.querySelectorAll('rect.chart-hit')).toHaveLength(7);
  });

  it('stays inside the box and carries no inline colour', () => {
    const g = render(ts({ options: { style: 'area', unit: 'ms' } }));
    expect(g.outerHTML).not.toMatch(INLINE_COLOR);
    for (const p of g.querySelectorAll('polyline')) {
      for (const [x, y] of points(p)) {
        expect(x).toBeGreaterThanOrEqual(BOX.x);
        expect(x).toBeLessThanOrEqual(BOX.x + BOX.w);
        expect(y).toBeGreaterThanOrEqual(BOX.y);
        expect(y).toBeLessThanOrEqual(BOX.y + BOX.h);
      }
    }
  });

  it('draws degenerate numbers without NaN or Infinity', () => {
    const cases: TimeseriesData[] = [
      ts({}, [{ name: 'flat', values: [5, 5, 5] }]),
      ts({}, [{ name: 'zero', values: [0, 0, 0] }]),
      ts({}, [{ name: 'neg0', values: [-0, -0, -0] }]),
      ts({}, [{ name: 'big', values: [1e21, 2e21] }]),
      // the contract accepts these; max - min overflows
      ts({}, [{ name: 'huge', values: [-1e308, 1e308, 0] }]),
      ts({ options: { style: 'area', unit: 'ms' } }, [{ name: 'huge', values: [-1e308, 1e308, 0] }]),
      // flat at the top of the float range: niceTicks gives a single tick
      ts({}, [{ name: 'top', values: [1.7e308, 1.7e308] }]),
      ts({ xs: [t0] }, [{ name: 'one', values: [3] }]),
      ts({ options: { style: 'stacked', unit: '' } }, [{ name: 'a', values: [1e308, 0] }, { name: 'b', values: [7e307, 1] }]),
    ];
    for (const d of cases) {
      for (const dense of [false, true]) {
        expect(render(d, dense).outerHTML).not.toMatch(/NaN|Infinity/);
      }
    }
  });

  /** Ink box of a text mark, from the same measure the renderer uses (cap height 0.7 em). */
  const ink = (t: Element) => {
    const size = attr(t, 'font-size');
    const w = textW(t.textContent ?? '', size);
    const x = attr(t, 'x');
    const anchor = t.getAttribute('text-anchor');
    const x0 = anchor === 'middle' ? x - w / 2 : anchor === 'end' ? x - w : x;
    return { x0, x1: x0 + w, y0: attr(t, 'y') - 0.7 * size, y1: attr(t, 'y') };
  };
  const xLabels = (g: SVGGElement) => [...g.querySelectorAll('text.chart-tick')].filter(t => t.textContent!.includes(':'));
  const yLabels = (g: SVGGElement) => [...g.querySelectorAll('text.chart-tick')].filter(t => !t.textContent!.includes(':'));
  const FIVE = ['checkout', 'search', 'cart', 'login', 'orders'].map((name, k) => ({
    name, values: [120, 135, 180, 160, 140, 128, 122].map(v => v / (k + 1)) as (number | null)[],
  }));

  it('I1: x labels step by a fixed index stride, first and last on real points, never touching', () => {
    for (const [series, box] of [[FIVE, BOX], [ts().series, BOX], [ts().series, { x: 0, y: 0, w: 672, h: 236 }]] as const) {
      const d = ts({}, series);
      const g = group(renderTimeseries(d, box, false));
      const pts = points(g.querySelector('polyline.series-1')!).map(p => p[0]);
      const labels = xLabels(g);
      expect(labels.length).toBeGreaterThanOrEqual(2);
      // every label is a real point's label, centred on that point
      const idx = labels.map(l => d.xs.findIndex(x => new Date(x).toISOString().slice(11, 16) === l.textContent));
      expect(idx.every(i => i >= 0)).toBe(true);
      expect(idx[0]).toBe(0);
      labels.forEach((l, j) => {
        if (l.getAttribute('text-anchor') === 'middle') expect(attr(l, 'x')).toBeCloseTo(pts[idx[j]], 1);
      });
      // one stride from the first label to the last
      const strides = new Set(idx.slice(1).map((v, j) => v - idx[j]));
      expect(strides.size).toBe(1);
      for (let j = 1; j < labels.length; j++) {
        expect(ink(labels[j]).x0 - ink(labels[j - 1]).x1).toBeGreaterThanOrEqual(6);
      }
    }
    // 7 points 5 min apart on the standard card: 10:00, 10:10, 10:20, 10:30
    expect(xLabels(render(ts({}, FIVE))).map(l => l.textContent)).toEqual(['10:00', '10:10', '10:20', '10:30']);
  });

  it('M3: the y label at the baseline keeps clear of the first x label', () => {
    const g = render(ts());
    const zero = yLabels(g).find(t => t.textContent === '0')!;
    const first = ink(xLabels(g)[0]);
    const z = ink(zero);
    const apart = first.x0 >= z.x1 + 3 || z.x0 >= first.x1 + 3 || first.y0 >= z.y1 + 3 || z.y0 >= first.y1 + 3;
    expect(apart).toBe(true);
  });

  it('M15: a wide card draws at most five value gridlines and no x gridlines', () => {
    const g = group(renderTimeseries(ts(), { x: 0, y: 0, w: 672, h: 236 }, false));
    const lines = [...g.querySelectorAll('line.chart-grid, line.chart-base')];
    expect(lines.length).toBeLessThanOrEqual(5);
    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const l of lines) expect(l.getAttribute('y1')).toBe(l.getAttribute('y2'));
  });

  it('M9: end dots closer than 2r + 2 collapse into one, the end labels stay apart', () => {
    const close = [100, 98, 97, 40].map((last, k) => ({ name: `s${k}`, values: [10, 20, last] as (number | null)[] }));
    const g = render(ts({}, close));
    const dots = [...g.querySelectorAll('circle.chart-dot')].map(c => [attr(c, 'cx'), attr(c, 'cy')]);
    expect(dots.length).toBeLessThan(4);
    expect(dots.length).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < dots.length; i++) {
      for (let j = i + 1; j < dots.length; j++) {
        expect(Math.hypot(dots[i][0] - dots[j][0], dots[i][1] - dots[j][1])).toBeGreaterThanOrEqual(10);
      }
    }
    // series 1 keeps its dot
    expect(g.querySelector('circle.chart-dot.series-1')).not.toBeNull();
    const ys = [...g.querySelectorAll('text.chart-label')].map(l => attr(l, 'y')).sort((a, b) => a - b);
    expect(ys).toHaveLength(4);
    for (let i = 1; i < ys.length; i++) expect(ys[i] - ys[i - 1]).toBeGreaterThanOrEqual(12);
  });

  it('I3: each hit column carries a structured readout: header, then one row per series with its slot and point y', () => {
    const g = render(ts());
    const hit = g.querySelectorAll('rect.chart-hit')[2];
    expect(hit.getAttribute('data-tip-head')).toBe('10:10');
    const rows = JSON.parse(hit.getAttribute('data-tip-rows')!) as { slot?: number; name: string; value: string; y?: number }[];
    expect(rows.map(r => [r.slot, r.name, r.value])).toEqual([[1, 'checkout', '180\u2009ms'], [2, 'search', '102\u2009ms']]);
    const lines = [...g.querySelectorAll('polyline.chart-line')].map(points);
    expect(rows[0].y).toBeCloseTo(lines[0][2][1], 1);
    expect(rows[1].y).toBeCloseTo(lines[1][2][1], 1);
    // a null has no point: no y
    const gap = render(ts({}, [{ name: 'p99', values: [10, null, 12] }]));
    const row = JSON.parse(gap.querySelectorAll('rect.chart-hit')[1].getAttribute('data-tip-rows')!)[0];
    expect(row).toEqual({ slot: 1, name: 'p99', value: '—' });
    // a stack adds its total, without a slot
    const st = render(ts({ options: { style: 'stacked', unit: '' } }));
    const stRows = JSON.parse(st.querySelectorAll('rect.chart-hit')[0].getAttribute('data-tip-rows')!);
    expect(stRows[2]).toEqual({ name: 'total', value: '215' });
  });
});
