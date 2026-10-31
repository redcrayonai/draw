import { describe, it, expect } from 'vitest';
import type { Span, WaterfallData } from '../../../module/src/chart-contracts';
import { renderWaterfall } from './waterfall';
import { textW } from './scale';
import { attr, group, INLINE_COLOR } from './test-util';

const BOX = { x: 16, y: 40, w: 340, h: 170 };
const span = (id: string, parentId: string, name: string, service: string, start: number, duration: number, depth: number, status: 'ok' | 'error' = 'ok'): Span =>
  ({ id, parentId, name, service, start, duration, status, depth });
const SPANS = [
  span('1', '', 'GET /checkout', 'gateway', 0, 400, 0),
  span('2', '1', 'auth', 'auth', 10, 40, 1),
  span('3', '1', 'cart.load', 'cart', 60, 120, 1),
  span('4', '3', 'SELECT cart', 'postgres', 70, 80, 2, 'error'),
  span('5', '1', 'charge', 'payments', 190, 200, 1),
];

function wf(spans = SPANS, services = ['gateway', 'auth', 'cart', 'postgres', 'payments']): WaterfallData {
  return { type: 'waterfall', options: {}, spans, services, end: Math.max(...spans.map(s => s.start + s.duration)) };
}

const render = (d: WaterfallData, dense = false, box = BOX) => group(renderWaterfall(d, box, dense));
const bars = (g: SVGGElement) => [...g.querySelectorAll('rect.chart-bar')];

describe('renderWaterfall', () => {
  it('places each bar from start to start + duration on one shared ms axis', () => {
    const g = render(wf());
    const b = bars(g);
    expect(b).toHaveLength(5);
    const root = b[0];
    const x0 = attr(root, 'x');
    const perMs = attr(root, 'width') / 400;
    SPANS.forEach((s, i) => {
      expect(attr(b[i], 'x')).toBeCloseTo(x0 + s.start * perMs, 1);
      expect(attr(b[i], 'width')).toBeCloseTo(s.duration * perMs, 1);
      expect(attr(b[i], 'height')).toBeLessThanOrEqual(24);
    });
  });

  it('puts one span per row, in the given order', () => {
    const ys = bars(render(wf())).map(r => attr(r, 'y'));
    for (let i = 1; i < ys.length; i++) expect(ys[i] - ys[i - 1]).toBeCloseTo(ys[1] - ys[0], 5);
    expect(ys[1] - ys[0]).toBeGreaterThanOrEqual(18);
  });

  it('indents names by depth', () => {
    const names = [...render(wf()).querySelectorAll('text.chart-label')];
    expect(names.map(n => n.textContent)).toEqual(SPANS.map(s => s.name));
    SPANS.forEach((s, i) => expect(attr(names[i], 'x')).toBe(BOX.x + s.depth * 12));
  });

  it('colours bars by service slot and folds later services into chart-other', () => {
    const spans = [...SPANS, span('6', '1', 'email', 'other services', 300, 50, 1)];
    const g = render(wf(spans, ['gateway', 'auth', 'cart', 'postgres', 'payments', 'other services']), false, { ...BOX, w: 640 });
    expect(bars(g).map(b => b.getAttribute('class'))).toEqual([
      'chart-bar series-1', 'chart-bar series-2', 'chart-bar series-3', 'chart-bar series-4 chart-error', 'chart-bar series-5', 'chart-bar chart-other',
    ]);
    expect([...g.querySelectorAll('.chart-legend .chart-swatch')].map(s => s.getAttribute('class'))).toContain('chart-swatch chart-other');
  });

  it('marks an error span with chart-error and a ! glyph', () => {
    const g = render(wf());
    const glyphs = [...g.querySelectorAll('text.chart-glyph')];
    expect(glyphs.map(t => [t.textContent, t.getAttribute('class')])).toEqual([['!', 'chart-glyph chart-error']]);
    expect(attr(glyphs[0], 'y')).toBeCloseTo(attr(g.querySelectorAll('text.chart-label')[3], 'y'), 5);
  });

  it('gives each span a tooltip: name, service, start and duration', () => {
    const b = bars(render(wf()));
    expect(b[2].getAttribute('data-tip')).toBe('cart.load · cart · 60 ms → 120 ms');
    expect(b[3].getAttribute('data-tip')).toBe('SELECT cart · postgres · 70 ms → 80 ms\nstatus: error');
  });

  it('a tooltip start is an offset from the trace start, as the axis is', () => {
    const t0 = 1_760_000_000_000; // epoch ms, as OTel exports give
    const shifted = SPANS.map(s => ({ ...s, start: s.start + t0 }));
    // the same readout as the trace that starts at 0
    expect(bars(render(wf(shifted))).map(b => b.getAttribute('data-tip'))).toEqual(bars(render(wf())).map(b => b.getAttribute('data-tip')));
    const ticks = (d: WaterfallData) => [...render(d).querySelectorAll('text.chart-tick')].map(t => t.textContent);
    expect(ticks(wf(shifted))).toEqual(ticks(wf()));
  });

  it('labels the ms axis with ticks', () => {
    const ticks = [...render(wf()).querySelectorAll('text.chart-tick')].map(t => t.textContent);
    expect(ticks[0]).toBe('0 ms');
    expect(ticks[ticks.length - 1]).toBe('400 ms');
  });

  it('cuts spans that do not fit and says how many', () => {
    const many = Array.from({ length: 30 }, (_, i) => span(String(i + 1), i ? '1' : '', `op-${i}`, 'gateway', i * 10, 20, i ? 1 : 0));
    const g = render(wf(many, ['gateway']));
    // (170 - 16) / 18 = 8 rows fit; one gives way to the '+N more spans' line
    expect(bars(g)).toHaveLength(7);
    expect(g.querySelector('text.chart-more')!.textContent).toBe('+23 more spans');
  });

  it('gives a zero-duration span a visible 2 px bar', () => {
    const g = render(wf([span('1', '', 'root', 'gateway', 0, 100, 0), span('2', '1', 'mark', 'gateway', 50, 0, 1)], ['gateway']));
    expect(attr(bars(g)[1], 'width')).toBe(2);
  });

  it('dense keeps the bars and drops names, axis and legend', () => {
    const g = render(wf(), true);
    expect(g.querySelectorAll('text, line, .chart-legend')).toHaveLength(0);
    expect(bars(g)).toHaveLength(5);
  });

  it('dense keeps a mark beside each error span, so the error is never colour alone', () => {
    const g = render(wf(), true);
    const errors = bars(g).filter(b => b.classList.contains('chart-error'));
    const marks = [...g.querySelectorAll('.chart-glyph.chart-error')];
    expect(errors).toHaveLength(1);
    expect(marks).toHaveLength(1);
    // on the error span's row, right after its bar
    const err = errors[0];
    expect(attr(marks[0], 'x')).toBeGreaterThanOrEqual(attr(err, 'x') + attr(err, 'width'));
    expect(attr(marks[0], 'y')).toBeCloseTo(attr(err, 'y'), 5);
  });

  it('dense keeps the error mark inside the plot box when the error span fills the whole trace', () => {
    // the common case: a root marked error because a child failed
    for (const end of [400, 370, 1000]) {
      const g = render(wf([span('1', '', 'GET /checkout', 'gateway', 0, end, 0, 'error'), span('2', '1', 'auth', 'auth', 10, 40, 1)], ['gateway', 'auth']), true);
      const marks = [...g.querySelectorAll('.chart-glyph.chart-error')];
      expect(marks).toHaveLength(1);
      expect(attr(marks[0], 'x')).toBeGreaterThanOrEqual(BOX.x);
      expect(attr(marks[0], 'x') + attr(marks[0], 'width')).toBeLessThanOrEqual(BOX.x + BOX.w);
    }
  });

  it('dense keeps every bar even when the row height rounds down', () => {
    // 148 / (148 / 29) is 28.999...; flooring that once dropped the last span
    const many = Array.from({ length: 29 }, (_, i) => span(String(i + 1), i ? '1' : '', `op-${i}`, 'gateway', i * 10, 20, i ? 1 : 0));
    expect(bars(render(wf(many, ['gateway']), true, { ...BOX, h: 148 }))).toHaveLength(29);
  });

  it('carries no inline colour', () => {
    expect(render(wf()).outerHTML).not.toMatch(INLINE_COLOR);
  });

  it('draws degenerate numbers without NaN or Infinity', () => {
    const lone = wf([span('1', '', 'mark', 'gateway', 0, 0, 0)], ['gateway']);
    expect(attr(bars(render(lone))[0], 'width')).toBe(2);
    const cases: WaterfallData[] = [
      // a single zero-duration span: the trace has no length at all
      lone,
      wf([span('1', '', 'a', 'gateway', 50, 0, 0), span('2', '1', 'b', 'gateway', 50, 0, 1)], ['gateway']),
      wf([span('1', '', 'root', 'gateway', 1e21, 5, 0)], ['gateway']),
      // the contract caps start + duration at the largest finite double
      wf([span('1', '', 'root', 'gateway', 0, 1.7e308, 0), span('2', '1', 'late', 'gateway', 1.7e308, 0, 1)], ['gateway']),
    ];
    for (const d of cases) {
      for (const dense of [false, true]) {
        expect(render(d, dense).outerHTML).not.toMatch(/NaN|Infinity/);
      }
    }
  });

  it('M12: rows take the height there is up to 20 px, and the legend sits right under the axis', () => {
    const tall = { ...BOX, h: 268 };
    const g = render(wf(), false, tall);
    const ys = bars(g).map(r => attr(r, 'y'));
    expect(ys[1] - ys[0]).toBeCloseTo(20, 5);
    const axis = Math.max(...[...g.querySelectorAll('text.chart-tick')].map(t => attr(t, 'y')));
    const legendY = Math.min(...[...g.querySelectorAll('.chart-legend text')].map(t => attr(t, 'y')));
    expect(legendY - axis).toBeGreaterThan(8);
    expect(legendY - axis).toBeLessThanOrEqual(24);
    // a short card fills its rows instead
    const fits = render(wf(), false, { ...BOX, h: 150 });
    const ys2 = bars(fits).map(r => attr(r, 'y'));
    expect(ys2[1] - ys2[0]).toBeLessThanOrEqual(20);
    expect(fits.querySelector('text.chart-more')).toBeNull();
  });

  it('M11: a cut keeps the root, then error spans and their ancestors; the legend and +N count follow what is shown', () => {
    const spans = [
      span('1', '', 'root', 'gateway', 0, 400, 0),
      span('2', '1', 'a', 'auth', 10, 20, 1),
      span('3', '1', 'b', 'auth', 30, 20, 1),
      span('4', '1', 'c', 'cart', 50, 20, 1),
      span('5', '1', 'd', 'cart', 70, 20, 1),
      span('6', '1', 'pay', 'payments', 100, 200, 1),
      span('7', '6', 'charge', 'stripe', 120, 150, 2, 'error'),
    ];
    const g = render(wf(spans, ['gateway', 'auth', 'cart', 'payments', 'stripe']), false, { ...BOX, h: 120 });
    const names = [...g.querySelectorAll('text.chart-label')].map(t => t.textContent);
    expect(names[0]).toBe('root');
    expect(names).toContain('pay');
    expect(names).toContain('charge');
    // depth-first order is kept among the shown rows
    expect(names.indexOf('pay')).toBeLessThan(names.indexOf('charge'));
    expect(g.querySelector('text.chart-more')!.textContent).toBe(`+${spans.length - names.length} more spans`);
    const legend = [...g.querySelectorAll('.chart-legend text')].map(t => t.textContent);
    const shownServices = new Set(spans.filter(sp => names.includes(sp.name)).map(sp => sp.service));
    expect(legend.filter(t => !t!.startsWith('+'))).toEqual(['gateway', 'auth', 'cart', 'payments', 'stripe'].filter(sv => shownServices.has(sv)));
  });

  it('M5: the last ms label sits on its gridline, or ends at the edge when it would overflow, never on top of its neighbour', () => {
    for (const w of [192, 340, 672]) {
      const box = { ...BOX, w };
      const g = render(wf(), false, box);
      const grid = [...g.querySelectorAll('line.chart-grid, line.chart-base')].map(l => attr(l, 'x1')).sort((a, b) => a - b);
      const boxes = [...g.querySelectorAll('text.chart-tick')].map(t => {
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
        expect(last.x0).toBeLessThanOrEqual(grid[grid.length - 1]);
      } else {
        expect(last.x).toBeCloseTo(grid[grid.length - 1], 1);
      }
    }
  });
});
