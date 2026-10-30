import { describe, it, expect } from 'vitest';
import type { StatData } from '../../../module/src/chart-contracts';
import { renderStat } from './stat';
import { textW } from './scale';
import { attr, group, INLINE_COLOR } from './test-util';

const BOX = { x: 16, y: 40, w: 320, h: 140 };
const TREND = [99.91, 99.93, 99.9, 99.94, 99.95, 99.92, 99.96, 99.94, 99.95, 99.97, 99.93, 99.95];

function stat(over: Partial<StatData> = {}, options: Partial<StatData['options']> = {}): StatData {
  return {
    type: 'stat',
    options: { unit: '%', deltaLabel: 'vs last week', upIsGood: true, precision: 2, ...options },
    valueName: 'availability',
    value: 99.95,
    previous: 99.93,
    trend: TREND,
    ...over,
  };
}

const render = (d: StatData, dense = false, box = BOX) => group(renderStat(d, box, dense));

describe('renderStat', () => {
  it('shows the value at its precision with the unit in a muted tspan', () => {
    const g = render(stat());
    const v = g.querySelector('text.chart-stat-value')!;
    expect(v.firstChild!.textContent).toBe('99.95');
    expect(v.querySelector('tspan')!.textContent).toBe('%');
    expect(v.querySelector('tspan')!.getAttribute('class')).toBe('chart-muted');
    expect(v.getAttribute('font-variant-numeric')).toBe('tabular-nums');
    expect(v.getAttribute('data-tip')).toBe('availability: 99.95 %');
    expect(attr(v, 'font-size')).toBeLessThanOrEqual(44);
  });

  it('writes an up delta in the good class when up is good', () => {
    const g = render(stat());
    const [change, label] = [...g.querySelectorAll('text.chart-delta tspan')];
    expect(change.getAttribute('class')).toBe('chart-good');
    expect(label.textContent).toBe(' vs last week');
    expect(change.textContent!.startsWith('▲ ')).toBe(true);
  });

  it('writes a down delta in the bad class when up is good, and good when up is bad', () => {
    const down = render(stat({ value: 120, previous: 150 }, { unit: 'ms', precision: 0, upIsGood: true }));
    expect(down.querySelector('text.chart-delta tspan')!.textContent).toBe('▼ 30 ms');
    expect(down.querySelector('text.chart-delta tspan')!.getAttribute('class')).toBe('chart-bad');
    const latency = render(stat({ value: 120, previous: 150 }, { unit: 'ms', precision: 0, upIsGood: false }));
    expect(latency.querySelector('text.chart-delta tspan')!.getAttribute('class')).toBe('chart-good');
  });

  it('fits the delta line to the plot width by shortening the label, never the change', () => {
    const box = { x: 16, y: 40, w: 192, h: 80 }; // the plot of a minimum card
    const g = render(stat({}, { deltaLabel: 'vs same week last year, all regions' }), false, box);
    const [change, label] = [...g.querySelectorAll('text.chart-delta tspan')];
    expect(change.textContent!.startsWith('▲ ')).toBe(true);
    expect(label.textContent!.endsWith('…')).toBe(true);
    expect(textW(change.textContent!, 12) + textW(label.textContent!, 12)).toBeLessThanOrEqual(box.w);
    // the readout keeps the whole label
    expect(g.querySelector('text.chart-delta')!.getAttribute('data-tip')).toContain('vs same week last year, all regions');
    // a label that fits is left alone
    expect([...render(stat()).querySelectorAll('text.chart-delta tspan')][1].textContent).toBe(' vs last week');
  });

  it('says no change for an equal previous value and drops the delta without one', () => {
    expect(render(stat({ previous: 99.95 })).querySelector('text.chart-delta tspan')!.textContent).toBe('no change');
    expect(render(stat({ previous: null })).querySelector('text.chart-delta')).toBeNull();
  });

  it('draws the trend faint with the last segment and end dot in series-1', () => {
    const g = render(stat());
    const faint = g.querySelector('polyline.chart-spark')!;
    expect(faint.getAttribute('points')!.split(' ')).toHaveLength(TREND.length - 1);
    expect(faint.getAttribute('stroke-linejoin')).toBe('round');
    const last = g.querySelector('polyline.chart-line')!;
    expect(last.getAttribute('class')).toBe('chart-line series-1');
    const lastPts = last.getAttribute('points')!.split(' ');
    expect(lastPts).toHaveLength(2);
    expect(faint.getAttribute('points')!.split(' ').pop()).toBe(lastPts[0]);
    const dot = g.querySelector('circle.chart-dot')!;
    expect(dot.getAttribute('class')).toBe('chart-dot chart-ring series-1');
    expect(`${dot.getAttribute('cx')},${dot.getAttribute('cy')}`).toBe(lastPts[1]);
    // the highest trend point is the top of the sparkline
    const ys = faint.getAttribute('points')!.split(' ').map(p => Number(p.split(',')[1]));
    expect(ys[9]).toBe(Math.min(...ys));
  });

  it('draws no axes, gridlines or legend', () => {
    expect(render(stat()).querySelectorAll('line, .chart-tick, .chart-legend')).toHaveLength(0);
  });

  it('skips the sparkline for a single value', () => {
    expect(render(stat({ trend: [99.95], previous: null })).querySelectorAll('polyline, circle')).toHaveLength(0);
  });

  it('dense keeps the value and the sparkline and drops the delta line', () => {
    const g = render(stat(), true);
    expect(g.querySelector('text.chart-stat-value')).not.toBeNull();
    expect(g.querySelector('text.chart-delta')).toBeNull();
    expect(g.querySelectorAll('polyline')).toHaveLength(2);
  });

  it('shrinks the number to fit a narrow card', () => {
    const g = render(stat({ value: 1284567.25 }, { unit: 'requests', precision: 0 }), false, { ...BOX, w: 190 });
    const v = g.querySelector('text.chart-stat-value')!;
    const fs = attr(v, 'font-size');
    expect(textW(v.firstChild!.textContent!, fs) + textW('requests', Math.round(fs * 0.55)) + fs * 0.08).toBeLessThanOrEqual(190);
  });

  it('carries no inline colour', () => {
    expect(render(stat()).outerHTML).not.toMatch(INLINE_COLOR);
  });

  it('shows a delta too large for a double as unavailable, without NaN or Infinity', () => {
    // The contract takes value and previous from the trend; 1e308 - -1e308 overflows.
    const d = stat({ value: 1e308, previous: -1e308, trend: [-1e308, 1e308] });
    const g = render(d);
    expect(g.outerHTML).not.toMatch(/NaN|Infinity/);
    const change = g.querySelector('text.chart-delta tspan')!;
    expect(change.textContent).toBe('change unavailable');
    expect(change.getAttribute('class')).toBe('chart-muted');
    expect(g.querySelector('text.chart-delta')!.getAttribute('data-tip')).toBe('previous: -1e+308 %\nchange: unavailable vs last week');
    expect(render(d, true).outerHTML).not.toMatch(/NaN|Infinity/);
  });

  it('draws other degenerate numbers without NaN or Infinity', () => {
    const cases: StatData[] = [
      stat({ value: 5, previous: 5, trend: [5, 5, 5] }),
      stat({ value: 5, previous: 0, trend: [0, 5] }),
      stat({ value: 0, previous: -0, trend: [-0, 0] }),
      stat({ value: 1e21, previous: 1e21, trend: [1e21, 1e21] }),
      stat({ value: 1e10, previous: 1e-300, trend: [1e-300, 1e10] }),
      stat({ value: 5e-324, previous: 0, trend: [0, 5e-324] }),
      stat({ value: 1e308, previous: 1.7e308, trend: [-1.7e308, 1.7e308, 1e308] }),
    ];
    for (const d of cases) {
      for (const dense of [false, true]) {
        expect(render(d, dense).outerHTML).not.toMatch(/NaN|Infinity/);
      }
    }
  });

  it('M13: a % value changes in percentage points, on the card and in the readout', () => {
    const g = render(stat({ value: 99.95, previous: 99.94 }));
    expect(g.querySelector('text.chart-delta tspan')!.textContent).toBe('▲ 0.01\u2009pp');
    expect(g.querySelector('text.chart-delta')!.getAttribute('data-tip')).toBe('previous: 99.94\u2009%\nchange: +0.01\u2009pp vs last week');
    // other units keep the unit and the relative change
    const ms = render(stat({ value: 120, previous: 150 }, { unit: 'ms', precision: 0, deltaLabel: '' }));
    expect(ms.querySelector('text.chart-delta')!.getAttribute('data-tip')).toBe('previous: 150\u2009ms\nchange: -30\u2009ms (-20%)');
  });

  it('M7: the sparkline runs under the delta line across the card and fills the height left', () => {
    for (const box of [BOX, { ...BOX, h: 268 }, { x: 0, y: 0, w: 640, h: 236 }]) {
      const g = render(stat(), false, box);
      const delta = attr(g.querySelector('text.chart-delta')!, 'y');
      const pts = [...g.querySelectorAll('polyline')].flatMap(p => p.getAttribute('points')!.split(' ').map(q => q.split(',').map(Number)));
      const xs = pts.map(p => p[0]);
      const ys = pts.map(p => p[1]);
      // no empty band between the delta line and the sparkline
      expect(Math.min(...ys) - delta).toBeGreaterThan(0);
      expect(Math.min(...ys) - delta).toBeLessThanOrEqual(16);
      expect(Math.max(...ys)).toBeGreaterThanOrEqual(box.y + box.h - 6);
      expect(Math.max(...ys)).toBeLessThanOrEqual(box.y + box.h);
      expect(Math.min(...xs)).toBeLessThanOrEqual(box.x + 1);
      expect(Math.max(...xs)).toBeGreaterThanOrEqual(box.x + box.w - 6);
    }
  });

  it('M7: keeps the sparkline when the card width already holds the number small', () => {
    // A long unit on a narrow, tall card: the width sets the number below 24 px, and the sparkline costs it nothing.
    const box = { x: 16, y: 40, w: 192, h: 200 };
    const d = stat({ value: 1284, previous: 1200 }, { unit: 'requests per second', precision: 0 });
    const g = render(d, false, box);
    const alone = render({ ...d, trend: [1284] }, false, box);
    expect(g.querySelectorAll('polyline')).toHaveLength(2);
    expect(attr(g.querySelector('text.chart-stat-value')!, 'font-size')).toBe(attr(alone.querySelector('text.chart-stat-value')!, 'font-size'));
  });
});
