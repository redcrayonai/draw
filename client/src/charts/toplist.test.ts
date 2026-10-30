import { describe, it, expect } from 'vitest';
import type { ToplistData } from '../../../module/src/chart-contracts';
import { renderToplist } from './toplist';
import { textW } from './scale';
import { attr, group, INLINE_COLOR, pathBox } from './test-util';

const BOX = { x: 16, y: 40, w: 320, h: 130 };
const ITEMS = [
  { label: '/checkout', value: 1840 },
  { label: '/search', value: 1210 },
  { label: '/cart/items', value: 880 },
  { label: '/login', value: 512 },
  { label: '/api/v2/orders', value: 301 },
];

function top(items = ITEMS, unit = ''): ToplistData {
  return {
    type: 'toplist',
    options: { limit: 10, order: 'desc', unit },
    labelName: 'endpoint',
    valueName: '5xx',
    items,
    totalRows: items.length,
  };
}

const render = (d: ToplistData, dense = false, box = BOX) => group(renderToplist(d, box, dense));

describe('renderToplist', () => {
  it('writes rank, label and right-aligned tabular value per row', () => {
    const g = render(top());
    expect([...g.querySelectorAll('text.chart-rank')].map(t => t.textContent)).toEqual(['1', '2', '3', '4', '5']);
    expect([...g.querySelectorAll('text.chart-label')].map(t => t.textContent)).toEqual(ITEMS.map(i => i.label));
    const values = [...g.querySelectorAll('text.chart-value')];
    expect(values.map(t => t.textContent)).toEqual(['1,840', '1,210', '880', '512', '301']);
    for (const v of values) {
      expect(v.getAttribute('text-anchor')).toBe('end');
      expect(v.getAttribute('font-variant-numeric')).toBe('tabular-nums');
      expect(attr(v, 'x')).toBe(BOX.x + BOX.w);
    }
  });

  it('draws bars on equal tracks, proportional to the largest value', () => {
    const g = render(top());
    const tracks = [...g.querySelectorAll('rect.chart-track')];
    const bars = [...g.querySelectorAll('path.chart-bar')].map(b => pathBox(b.getAttribute('d')!));
    expect(tracks).toHaveLength(5);
    const trackW = attr(tracks[0], 'width');
    expect(bars[0].w).toBeCloseTo(trackW, 1);
    bars.forEach((b, i) => {
      expect(b.x).toBeCloseTo(attr(tracks[0], 'x'), 1);
      expect(b.w / trackW).toBeCloseTo(ITEMS[i].value / 1840, 2);
      expect(b.h).toBeLessThanOrEqual(24);
    });
    expect(g.querySelectorAll('path.chart-bar.series-1')).toHaveLength(5);
  });

  it('gives each bar and track a tooltip with rank, label and value', () => {
    const g = render(top(ITEMS, 'ms'));
    expect(g.querySelectorAll('path.chart-bar')[1].getAttribute('data-tip')).toBe('2. /search\n5xx: 1,210\u2009ms');
    expect(g.querySelectorAll('rect.chart-track')[1].getAttribute('data-tip')).toBe('2. /search\n5xx: 1,210\u2009ms');
  });

  it('cuts rows that do not fit and says how many', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ label: `/r${i}`, value: 100 - i }));
    const g = render(top(many), false, { ...BOX, h: 100 });
    expect(g.querySelectorAll('text.chart-rank')).toHaveLength(5);
    expect(g.querySelector('text.chart-more')!.textContent).toBe('+7 more');
  });

  it('ellipsizes long labels to 40 % of the width', () => {
    const g = render(top([{ label: '/a/very/long/path/that/never/ends/at/all/really', value: 1 }]));
    const label = g.querySelector('text.chart-label')!.textContent!;
    expect(label.endsWith('…')).toBe(true);
    expect(textW(label, 11, true)).toBeLessThanOrEqual(BOX.w * 0.4 + 0.01);
  });

  it('dense keeps the bars and drops all text', () => {
    const g = render(top(), true);
    expect(g.querySelectorAll('text')).toHaveLength(0);
    expect(g.querySelectorAll('path.chart-bar')).toHaveLength(5);
  });

  it('carries no inline colour', () => {
    expect(render(top()).outerHTML).not.toMatch(INLINE_COLOR);
  });

  it('draws degenerate numbers without NaN or Infinity', () => {
    const cases = [
      [{ label: '/only', value: 7 }],
      [{ label: '/a', value: 0 }, { label: '/b', value: -0 }],
      [{ label: '/a', value: 5 }, { label: '/b', value: 5 }],
      [{ label: '/a', value: 1.7e308 }, { label: '/b', value: 1e21 }, { label: '/c', value: -1.7e308 }],
    ];
    for (const items of cases) {
      for (const dense of [false, true]) {
        expect(render(top(items), dense).outerHTML).not.toMatch(/NaN|Infinity/);
      }
    }
  });

  it('I4: when the limit cut rows, a final muted row says how many', () => {
    const d = { ...top(), totalRows: 6 };
    const g = render(d);
    expect(g.querySelectorAll('text.chart-rank')).toHaveLength(5);
    const more = g.querySelector('text.chart-more')!;
    expect(more.textContent).toBe('+1 more');
    expect(more.getAttribute('class')).toBe('chart-more chart-faint');
    // below the last row, inside the box
    const lastRow = Math.max(...[...g.querySelectorAll('text.chart-rank')].map(t => attr(t, 'y')));
    expect(attr(more, 'y')).toBeGreaterThan(lastRow);
    expect(attr(more, 'y')).toBeLessThanOrEqual(BOX.y + BOX.h);
    // a box cut adds to the limit cut
    const many = Array.from({ length: 12 }, (_, i) => ({ label: `/r${i}`, value: 100 - i }));
    const cut = render({ ...top(many), totalRows: 40 }, false, { ...BOX, h: 100 });
    expect(cut.querySelector('text.chart-more')!.textContent).toBe(`+${40 - cut.querySelectorAll('text.chart-rank').length} more`);
    // nothing cut: no line
    expect(render(top()).querySelector('text.chart-more')).toBeNull();
  });
});
