import { describe, it, expect } from 'vitest';
import { CHART_CONTRACTS, CHART_TYPES, parseChart, type ChartData } from '../../../module/src/chart-contracts';
import { renderPlot } from './index';
import { textW } from './scale';
import { group, INLINE_COLOR } from './test-util';

const BOX = { x: 16, y: 40, w: 320, h: 150 };
const t0 = Date.UTC(2026, 9, 9, 10, 0);

const SAMPLES: ChartData[] = [
  { type: 'timeseries', options: { style: 'line', unit: 'ms' }, xName: 'time', xKind: 'iso', xs: [t0, t0 + 60_000, t0 + 120_000], series: [{ name: 'a', values: [1, 2, 3] }, { name: 'b', values: [3, 2, 1] }] },
  { type: 'bars', options: { layout: 'stacked', orientation: 'vertical', unit: '' }, xName: 'k', categories: ['x', 'y'], series: [{ name: 'a', values: [1, 2] }, { name: 'b', values: [2, 1] }] },
  { type: 'toplist', options: { limit: 10, order: 'desc', unit: '' }, labelName: 'k', valueName: 'v', items: [{ label: 'a', value: 2 }, { label: 'b', value: 1 }], totalRows: 2 },
  { type: 'pie', options: { donut: true, unit: '' }, valueName: 'v', slices: [{ label: 'a', value: 2, other: false }, { label: 'b', value: 1, other: false }], total: 3 },
  { type: 'treemap', options: { unit: '' }, valueName: 'v', parents: ['p', 'q'], leaves: [{ label: 'a', value: 2, parent: 'p' }, { label: 'b', value: 1, parent: 'q' }] },
  { type: 'table', options: { thresholds: [{ column: 'v', warn: 1, crit: 2, direction: 'above' }] }, header: ['k', 'v'], numeric: [false, true], rows: [['a', '2'], ['b', '1']], values: [[null, 2], [null, 1]] },
  { type: 'stat', options: { unit: 'ms', deltaLabel: 'vs before', upIsGood: false, precision: 0 }, valueName: 'v', value: 2, previous: 3, trend: [3, 1, 2] },
  { type: 'waterfall', options: {}, spans: [{ id: '1', parentId: '', name: 'root', service: 's', start: 0, duration: 10, status: 'ok', depth: 0 }, { id: '2', parentId: '1', name: 'child', service: 't', start: 2, duration: 5, status: 'error', depth: 1 }], services: ['s', 't'], end: 10 },
  { type: 'scatter', options: { xUnit: 'KB', yUnit: 'ms' }, xName: 'kb', yName: 'ms', groups: ['a', 'b'], points: [{ x: 1, y: 2, group: 0, label: 'p' }, { x: 3, y: 1, group: 1, label: '' }] },
  {
    type: 'schedule', options: { marker: '2026-10-10' }, xKind: 'iso', marker: t0 + 86_400_000, lanes: ['l', 'm'], groups: [], items: [
      { lane: 0, label: 'a', start: t0, end: t0 + 86_400_000, milestone: false, group: 0, status: 'done', startText: '2026-10-09', endText: '2026-10-09' },
      { lane: 1, label: 'b', start: t0 + 86_400_000, end: t0 + 86_400_000, milestone: true, group: 0, status: 'blocked', startText: '2026-10-10', endText: '' },
    ],
  },
  { type: 'kanban', options: {}, stages: ['todo', 'done'], lanes: [], groups: ['g'], cards: [{ stage: 0, lane: 0, title: 'a', detail: 'd', group: 0 }, { stage: 1, lane: 0, title: 'b', detail: '', group: -1 }] },
];

describe('renderPlot', () => {
  it.each(SAMPLES.map(d => [d.type, d] as const))('draws %s with hoverable marks and no inline colour', (_, d) => {
    const g = group(renderPlot(d, BOX, false));
    expect(g.childElementCount).toBeGreaterThan(0);
    expect(g.querySelectorAll('[data-tip]').length).toBeGreaterThan(0);
    expect(g.outerHTML).not.toMatch(INLINE_COLOR);
  });

  it.each(SAMPLES.map(d => [d.type, d] as const))('dense %s drops every legend and label', (_, d) => {
    const g = group(renderPlot(d, BOX, true));
    expect(g.childElementCount).toBeGreaterThan(0);
    // a dense table keeps its row hairlines (M10): they are its marks, not an axis
    expect(g.querySelector(d.type === 'table' ? '.chart-legend, .chart-tick' : '.chart-legend, .chart-tick, .chart-grid')).toBeNull();
    // marks stay, labels drop; a stat's number is its mark
    if (d.type !== 'stat') expect(g.querySelector('text')).toBeNull();
  });

  it('draws nothing into an empty box', () => {
    expect(renderPlot(SAMPLES[0], { x: 0, y: 0, w: 0, h: 100 }, false)).toEqual([]);
  });

  it('is pure: the same input gives the same markup', () => {
    for (const d of SAMPLES) {
      expect(group(renderPlot(d, BOX, false)).outerHTML).toBe(group(renderPlot(d, BOX, false)).outerHTML);
    }
  });

  // Visual check (R3b): at the 224x144 minimum card the value axes stacked
  // 3-4 labels into 18-30 px and the waterfall ms labels ran into each other.
  const PLOTS = [{ x: 0, y: 0, w: 192, h: 60 }, { x: 0, y: 0, w: 320, h: 140 }, { x: 0, y: 0, w: 672, h: 236 }];
  const VARIANTS: [string, string][] = [
    ...CHART_TYPES.map(t => [t, '{}'] as [string, string]),
    ['bars', '{"orientation":"horizontal"}'],
    ['timeseries', '{"style":"stacked"}'],
    ['schedule', '{"marker":"2026-10-18"}'],
  ];
  /** Estimated ink box: 0.6 em per character (textW), cap height 0.7 em above the baseline. */
  const ink = (t: Element) => {
    const size = Number(t.getAttribute('font-size'));
    const w = textW(t.textContent ?? '', size);
    const x = Number(t.getAttribute('x'));
    const anchor = t.getAttribute('text-anchor');
    const x0 = anchor === 'middle' ? x - w / 2 : anchor === 'end' ? x - w : x;
    const y = Number(t.getAttribute('y'));
    return { text: t.textContent, x, y, x0, x1: x0 + w, y0: y - 0.7 * size, y1: y };
  };

  it.each(VARIANTS.flatMap(([type, options]) => PLOTS.map(b => [type, options, `${b.w}x${b.h}`, b] as const)))(
    '%s %s at %s: tick labels neither overlap nor leave the box',
    (type, options, _, box) => {
      const r = parseChart(type, CHART_CONTRACTS[type as keyof typeof CHART_CONTRACTS].example, options);
      if (!r.ok) throw new Error(r.error);
      const ticks = [...group(renderPlot(r.data, box, false)).querySelectorAll('text.chart-tick')].map(ink);
      for (const [i, a] of ticks.entries()) {
        expect(a.x0, `${a.text} left edge`).toBeGreaterThanOrEqual(box.x - 0.01);
        expect(a.x1, `${a.text} right edge`).toBeLessThanOrEqual(box.x + box.w + 0.01);
        for (const b of ticks.slice(i + 1)) {
          // Labels on one axis (same baseline or same anchor x) also keep 3 px of air.
          const pad = a.y === b.y || a.x === b.x ? 3 : 0;
          const apart = a.x1 + pad <= b.x0 || b.x1 + pad <= a.x0 || a.y1 + pad <= b.y0 || b.y1 + pad <= a.y0;
          expect(apart, `'${a.text}' overlaps '${b.text}'`).toBe(true);
        }
      }
    },
  );
});
