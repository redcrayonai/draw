import { describe, it, expect } from 'vitest';
import type { BarsData } from '../../../module/src/chart-contracts';
import { CHART_CONTRACTS, parseChart } from '../../../module/src/chart-contracts';
import { renderBars } from './bars';
import { textW } from './scale';
import { attr, group, INLINE_COLOR, pathBox } from './test-util';

const BOX = { x: 16, y: 40, w: 320, h: 150 };
const HOURS = ['09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00'];
const SERIES = [
  { name: 'us-east', values: [30, 34, 40, 52, 60, 55, 48, 42] },
  { name: 'eu-west', values: [20, 22, 25, 30, 28, 26, 24, 22] },
  { name: 'ap-south', values: [10, 12, 14, 15, 18, 16, 14, 12] },
];

function bars(over: Partial<BarsData['options']> = {}, series = SERIES, categories = HOURS): BarsData {
  return {
    type: 'bars',
    options: { layout: 'stacked', orientation: 'vertical', unit: '', ...over },
    xName: 'hour',
    categories,
    series,
  };
}

const render = (d: BarsData, dense = false, box = BOX) => group(renderBars(d, box, dense));
const segs = (g: SVGGElement) => [...g.querySelectorAll('path.chart-bar')];

/** Pixel position of value v on the vertical axis, from the base and top gridlines. */
function yScale(g: SVGGElement) {
  const base = Number(g.querySelector('line.chart-base')!.getAttribute('y1'));
  const grid = [...g.querySelectorAll('line.chart-grid')].map(l => Number(l.getAttribute('y1')));
  const top = Math.min(...grid);
  const ticks = [...g.querySelectorAll('text.chart-tick')].map(t => Number(t.textContent)).filter(n => !Number.isNaN(n));
  const max = Math.max(...ticks);
  return (v: number) => ((base - top) * v) / max;
}

describe('renderBars', () => {
  it('stacks segments so each stack spans exactly the scaled total, gaps included', () => {
    const g = render(bars());
    const px = yScale(g);
    const all = segs(g);
    expect(all).toHaveLength(24);
    for (let i = 0; i < HOURS.length; i++) {
      const stack = [all[i * 3], all[i * 3 + 1], all[i * 3 + 2]].map(s => pathBox(s.getAttribute('d')!));
      const sum = stack.reduce((s, b) => s + b.h, 0) + 2 * (stack.length - 1);
      const total = SERIES.reduce((s, x) => s + x.values[i], 0);
      expect(sum).toBeCloseTo(px(total), 0);
      // each upper segment starts 2 px above the one below
      expect(stack[0].y - (stack[1].y + stack[1].h)).toBeCloseTo(2, 1);
      expect(stack[1].y - (stack[2].y + stack[2].h)).toBeCloseTo(2, 1);
    }
  });

  it('rounds only the data end of the top segment', () => {
    const g = render(bars());
    const [bottom, middle, top] = segs(g).slice(0, 3).map(s => s.getAttribute('d')!);
    expect(bottom).not.toContain('A');
    expect(middle).not.toContain('A');
    expect(top.match(/A4 4/g)).toHaveLength(2);
    // the square base: the path starts and ends on the same baseline y
    const box = pathBox(top);
    expect(top.startsWith(`M${box.x} ${box.y + box.h}`)).toBe(true);
  });

  it('keeps every bar at most 24 px thick, even when there is room for more', () => {
    const two = SERIES.map(s => ({ name: s.name, values: s.values.slice(0, 2) }));
    const wide = render(bars({}, [two[0]], ['a', 'b']));
    for (const s of segs(wide)) expect(pathBox(s.getAttribute('d')!).w).toBe(24);
    const grouped = render(bars({ layout: 'grouped' }, two, ['a', 'b']));
    for (const s of segs(grouped)) expect(pathBox(s.getAttribute('d')!).w).toBeLessThanOrEqual(24);
  });

  it('assigns series classes in fixed order', () => {
    const g = render(bars());
    expect(segs(g).slice(0, 3).map(s => s.getAttribute('class'))).toEqual(['chart-bar series-1', 'chart-bar series-2', 'chart-bar series-3']);
  });

  it('groups bars side by side with a 2 px gap, each from the baseline', () => {
    const g = render(bars({ layout: 'grouped' }));
    const first = segs(g).slice(0, 3).map(s => pathBox(s.getAttribute('d')!));
    expect(first[1].x - (first[0].x + first[0].w)).toBeCloseTo(2, 1);
    expect(first[2].x - (first[1].x + first[1].w)).toBeCloseTo(2, 1);
    const base = Number(g.querySelector('line.chart-base')!.getAttribute('y1'));
    for (const b of first) expect(b.y + b.h).toBeCloseTo(base, 1);
    const px = yScale(g);
    expect(first[0].h).toBeCloseTo(px(30), 0);
  });

  it('draws negative grouped bars down from the zero line, rounded at the bottom', () => {
    const g = render(bars({ layout: 'grouped' }, [{ name: 'a', values: [10, -5] }, { name: 'b', values: [4, 3] }], ['x', 'y']));
    const base = Number(g.querySelector('line.chart-base')!.getAttribute('y1'));
    const neg = segs(g).find(s => s.getAttribute('data-tip') === 'y\na: -5')!;
    const b = pathBox(neg.getAttribute('d')!);
    expect(b.y).toBeCloseTo(base, 1);
    expect(neg.getAttribute('d')).toContain('A4 4 0 0 0');
  });

  it('lays horizontal bars from the left baseline with the round on the right', () => {
    const g = render(bars({ orientation: 'horizontal' }, [SERIES[0]]));
    const all = segs(g).map(s => pathBox(s.getAttribute('d')!));
    const base = Math.min(...all.map(b => b.x));
    for (const b of all) {
      expect(b.x).toBeCloseTo(base, 1);
      expect(b.h).toBeLessThanOrEqual(24);
    }
    expect(all[4].w / all[0].w).toBeCloseTo(60 / 30, 1);
    const labels = [...g.querySelectorAll('text.chart-label')];
    expect(labels.some(l => l.textContent === '09:00' && l.getAttribute('text-anchor') === 'end')).toBe(true);
  });

  it('writes the value at the tip for a single series, and a tooltip per segment', () => {
    const g = render(bars({ unit: 'req' }, [{ name: 'us-east', values: [30, 34, 40, 52] }], HOURS.slice(0, 4)));
    const values = [...g.querySelectorAll('text.chart-label')].map(t => t.textContent);
    expect(values).toEqual(['30\u2009req', '34\u2009req', '40\u2009req', '52\u2009req']);
    expect(segs(g)[3].getAttribute('data-tip')).toBe('12:00\nus-east: 52\u2009req');
    expect(g.querySelector('.chart-legend')).toBeNull();
  });

  it('lists the stack total in a stacked tooltip and adds a legend for two or more series', () => {
    const g = render(bars());
    expect(segs(g)[0].getAttribute('data-tip')).toBe('09:00\nus-east: 30\ntotal: 60');
    expect([...g.querySelectorAll('.chart-legend text')].map(t => t.textContent)).toEqual(['us-east', 'eu-west', 'ap-south']);
  });

  it('skips zero segments without breaking the stack', () => {
    const g = render(bars({}, [{ name: 'a', values: [10] }, { name: 'b', values: [0] }, { name: 'c', values: [5] }], ['x']));
    const all = segs(g);
    expect(all.map(s => s.getAttribute('class'))).toEqual(['chart-bar series-1', 'chart-bar series-3']);
    expect(all[1].getAttribute('d')).toContain('A');
  });

  it('thins category labels that would collide', () => {
    const many = Array.from({ length: 40 }, (_, i) => `2026-10-${String(i + 1).padStart(2, '0')}`);
    const g = render(bars({}, [{ name: 'a', values: many.map((_, i) => i + 1) }], many));
    const cats = [...g.querySelectorAll('text.chart-tick')].filter(t => t.textContent!.startsWith('2026') || t.textContent!.endsWith('…'));
    expect(cats.length).toBeLessThan(40);
    expect(cats.length).toBeGreaterThan(1);
  });

  it('puts vertical category labels just under the base line, inside the box', () => {
    const g = render(bars());
    const base = Number(g.querySelector('line.chart-base')!.getAttribute('y1'));
    const cats = [...g.querySelectorAll('text.chart-tick')].filter(t => HOURS.includes(t.textContent!));
    // how many fit depends on the measured label width (M6): at least every other one
    expect(cats.length).toBeGreaterThanOrEqual(HOURS.length / 2);
    for (const c of cats) {
      const y = Number(c.getAttribute('y'));
      expect(y).toBeGreaterThan(base);
      expect(y).toBeLessThanOrEqual(base + 16);
      expect(y).toBeLessThanOrEqual(BOX.y + BOX.h);
    }
  });

  it('a negative value label never sits on a category label, vertical or horizontal', () => {
    const boxOf = (t: Element) => {
      const px = Number(t.getAttribute('font-size'));
      const w = textW(t.textContent!, px);
      const x = attr(t, 'x');
      const anchor = t.getAttribute('text-anchor');
      const x0 = anchor === 'end' ? x - w : anchor === 'middle' ? x - w / 2 : x;
      return { x0, x1: x0 + w, y0: attr(t, 'y') - px, y1: attr(t, 'y') + px * 0.25 };
    };
    const overlap = (a: ReturnType<typeof boxOf>, b: ReturnType<typeof boxOf>) =>
      a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
    for (const orientation of ['vertical', 'horizontal'] as const) {
      for (const values of [[10, -5], [-5, 10], [-5, -10]]) {
        const g = render(bars({ orientation, layout: 'grouped' }, [{ name: 'a', values }], ['alpha', 'beta']));
        const shown = [...g.querySelectorAll('text.chart-label')].filter(t => t.getAttribute('font-size') === '10');
        const cats = [...g.querySelectorAll('text')].filter(t => ['alpha', 'beta'].includes(t.textContent!));
        expect(shown, `${orientation} ${values}`).toHaveLength(2);
        expect(cats, `${orientation} ${values}`).toHaveLength(2);
        for (const v of shown) {
          for (const c of cats) {
            expect(overlap(boxOf(v), boxOf(c)), `${orientation} ${values}: '${v.textContent}' on '${c.textContent}'`).toBe(false);
          }
          // and inside the plot box
          const b = boxOf(v);
          expect(b.x0 >= BOX.x - 0.5 && b.x1 <= BOX.x + BOX.w + 0.5 && b.y1 <= BOX.y + BOX.h + 0.5, `${orientation} ${values}: '${v.textContent}' inside`).toBe(true);
        }
      }
    }
  });

  it('writes horizontal value labels only when every row has room for them', () => {
    const values = (g: SVGGElement) => [...g.querySelectorAll('text.chart-label[font-size="10"]')];
    const few = render(bars({ orientation: 'horizontal' }, [{ name: 'a', values: [30, 34, 40, 52] }], HOURS.slice(0, 4)));
    expect(values(few).map(t => t.textContent)).toEqual(['30', '34', '40', '52']);
    const names = Array.from({ length: 20 }, (_, i) => `row-${i}`);
    const many = render(bars({ orientation: 'horizontal' }, [{ name: 'a', values: names.map((_, i) => i + 1) }], names));
    const ys = values(many).map(t => Number(t.getAttribute('y')));
    for (let i = 1; i < ys.length; i++) expect(ys[i] - ys[i - 1]).toBeGreaterThanOrEqual(10);
  });

  it('dense drops axes, labels and legend but keeps every segment', () => {
    const g = render(bars(), true);
    expect(g.querySelectorAll('text, line, .chart-legend')).toHaveLength(0);
    expect(segs(g)).toHaveLength(24);
  });

  it('carries no inline colour', () => {
    expect(render(bars()).outerHTML).not.toMatch(INLINE_COLOR);
    expect(render(bars({ layout: 'grouped', orientation: 'horizontal' })).outerHTML).not.toMatch(INLINE_COLOR);
  });

  it('draws degenerate numbers without NaN or Infinity', () => {
    const cases: BarsData[] = [
      bars({}, [{ name: 'a', values: [5] }], ['only']),
      bars({}, [{ name: 'a', values: [5, 5, 5] }], ['x', 'y', 'z']),
      bars({}, [{ name: 'a', values: [0, -0] }], ['x', 'y']),
      bars({}, [{ name: 'a', values: [1e21] }, { name: 'b', values: [-0] }], ['x']),
      // the contract accepts these; max - min overflows
      bars({ layout: 'grouped' }, [{ name: 'a', values: [-1e308, 1e308] }, { name: 'b', values: [1.7e308, -1.7e308] }], ['x', 'y']),
      bars({}, [{ name: 'a', values: [1e308] }, { name: 'b', values: [7e307] }], ['x']),
    ];
    for (const d of cases) {
      for (const orientation of ['vertical', 'horizontal'] as const) {
        for (const dense of [false, true]) {
          const g = render({ ...d, options: { ...d.options, orientation } }, dense);
          expect(g.outerHTML).not.toMatch(/NaN|Infinity/);
        }
      }
    }
  });

  it('I2: at the 224x144 minimum the value axis hugs the data (106K max: 0 and 120K, not 0-200K)', () => {
    const r = parseChart('bars', CHART_CONTRACTS.bars.example, '{}');
    if (!r.ok) throw new Error(r.error);
    const d = r.data as BarsData;
    const max = Math.max(...d.categories.map((_, i) => d.series.reduce((s, x) => s + x.values[i], 0)));
    const g = render(d, false, { x: 0, y: 0, w: 192, h: 60 });
    const ticks = [...g.querySelectorAll('text.chart-tick')].map(t => t.textContent).filter(t => !t!.includes(':'));
    expect(ticks[0]).toBe('0');
    const top = Number(ticks[ticks.length - 1]!.replace('K', '')) * 1000;
    expect(top).toBeGreaterThanOrEqual(max);
    expect(top).toBeLessThanOrEqual(1.25 * max);
    // the tallest stack fills at least 80 % of the axis
    const base = attr(g.querySelector('line.chart-base')!, 'y1');
    const axis = base - Math.min(...[...g.querySelectorAll('line.chart-grid')].map(l => attr(l, 'y1')));
    const tallest = Math.max(...segs(g).map(s => base - pathBox(s.getAttribute('d')!).y));
    expect(tallest / axis).toBeGreaterThanOrEqual(0.8);
  });

  it('I3: each segment carries a structured readout: category header, its series row, and the stack total', () => {
    const g = render(bars());
    const seg = segs(g)[1];
    expect(seg.getAttribute('data-tip-head')).toBe('09:00');
    expect(JSON.parse(seg.getAttribute('data-tip-rows')!)).toEqual([
      { slot: 2, name: 'eu-west', value: '20' },
      { name: 'total', value: '60' },
    ]);
  });

  it('M5: the last value label sits on its gridline, or ends at the edge when it would overflow; neighbours never overlap', () => {
    for (const w of [192, 320, 672]) {
      const box = { x: 0, y: 0, w, h: 140 };
      const g = render(bars({ orientation: 'horizontal' }), false, box);
      const grid = [...g.querySelectorAll('line.chart-grid, line.chart-base')].map(l => attr(l, 'x1')).sort((a, b) => a - b);
      const labels = [...g.querySelectorAll('text.chart-tick')];
      const boxes = labels.map(t => {
        const lw = textW(t.textContent!, attr(t, 'font-size'));
        const x = attr(t, 'x');
        const a = t.getAttribute('text-anchor');
        const x0 = a === 'middle' ? x - lw / 2 : a === 'end' ? x - lw : x;
        return { x0, x1: x0 + lw, x, a };
      });
      for (let i = 1; i < boxes.length; i++) expect(boxes[i].x0 - boxes[i - 1].x1, `w ${w}`).toBeGreaterThanOrEqual(3);
      const last = boxes[boxes.length - 1];
      if (last.a === 'end') {
        expect(last.x).toBeCloseTo(box.x + box.w, 5);
        // still over its gridline
        expect(last.x0).toBeLessThanOrEqual(grid[grid.length - 1]);
      } else {
        expect(last.a).toBe('middle');
        expect(last.x).toBeCloseTo(grid[grid.length - 1], 1);
      }
      for (const b of boxes) expect(b.x1).toBeLessThanOrEqual(box.x + box.w + 0.01);
    }
  });
});
