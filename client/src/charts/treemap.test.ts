import { describe, it, expect } from 'vitest';
import type { TreemapData } from '../../../module/src/chart-contracts';
import { renderTreemap } from './treemap';
import { attr, group, INLINE_COLOR } from './test-util';

const BOX = { x: 16, y: 40, w: 300, h: 170 };
const LEAVES = [
  { label: 'checkout', value: 4100, parent: 'app services' },
  { label: 'cart', value: 1600, parent: 'app services' },
  { label: 'search', value: 1300, parent: 'app services' },
  { label: 'postgres', value: 2200, parent: 'data stores' },
  { label: 'redis', value: 900, parent: 'data stores' },
  { label: 'kafka', value: 800, parent: 'data stores' },
];

function tree(leaves = LEAVES, parents = ['app services', 'data stores']): TreemapData {
  return { type: 'treemap', options: { unit: 'USD' }, valueName: 'cost', parents, leaves };
}

const render = (d: TreemapData, dense = false, box = BOX) => group(renderTreemap(d, box, dense));
const cells = (g: SVGGElement) => [...g.querySelectorAll('rect.chart-cell')];
/** Undo the 1 px inset on every side. */
const outer = (r: Element) => (attr(r, 'width') + 2) * (attr(r, 'height') + 2);

describe('renderTreemap', () => {
  it('sizes every cell in proportion to its value (2 px gaps put back)', () => {
    const g = render(tree());
    const plotArea = BOX.w * (BOX.h - 20 - 2);
    const total = LEAVES.reduce((s, l) => s + l.value, 0);
    const rects = cells(g);
    expect(rects).toHaveLength(6);
    rects.forEach(r => {
      const leaf = LEAVES.find(l => r.getAttribute('data-tip')!.includes(`/ ${l.label}\n`))!;
      expect(outer(r) / plotArea).toBeCloseTo(leaf.value / total, 2);
    });
  });

  it('keeps each parent\'s leaves together in one slot, in parent order', () => {
    const g = render(tree());
    const byClass = (cls: string) => cells(g).filter(r => r.classList.contains(cls)).map(r => r.getAttribute('data-tip')!.split('\n')[0]);
    expect(byClass('series-1').sort()).toEqual(['app services / cart', 'app services / checkout', 'app services / search']);
    expect(byClass('series-2').sort()).toEqual(['data stores / kafka', 'data stores / postgres', 'data stores / redis']);
    expect([...g.querySelectorAll('.chart-legend text')].map(t => t.textContent)).toEqual(['app services', 'data stores']);
  });

  it('separates neighbours by a 2 px gap', () => {
    const rects = cells(render(tree())).map(r => ({ x: attr(r, 'x'), y: attr(r, 'y'), w: attr(r, 'width'), h: attr(r, 'height') }));
    for (const a of rects) {
      for (const b of rects) {
        if (a === b) continue;
        const gapX = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w));
        const gapY = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h));
        expect(Math.max(gapX, gapY)).toBeGreaterThanOrEqual(1.99);
      }
    }
  });

  it('uses series-1 for every cell when there is no parent column, and no legend', () => {
    const flat = LEAVES.map(l => ({ ...l, parent: '' }));
    const g = render(tree(flat, []));
    expect(cells(g).every(r => r.getAttribute('class') === 'chart-cell series-1')).toBe(true);
    expect(g.querySelector('.chart-legend')).toBeNull();
    expect(cells(g)[0].getAttribute('data-tip')).toBe('checkout\n4,100 USD · 37.6%');
  });

  it('labels a cell only when the label fits, in the on-fill class for its slot', () => {
    const g = render(tree());
    const labels = [...g.querySelectorAll('text.chart-cell-label')];
    expect(labels.length).toBeGreaterThan(0);
    for (const t of labels) {
      // R4 paints on-fill text by on-series-N; a series-* class on text would set its color, not its fill.
      expect(t.getAttribute('class')).toMatch(/^chart-cell-label chart-on-fill on-series-[12]$/);
      const cell = cells(g).find(r => r.getAttribute('data-tip')!.includes(`/ ${t.textContent}\n`))!;
      expect(t.textContent!.length * 11 * 0.6 + 16).toBeLessThanOrEqual(attr(cell, 'width') + 2);
    }
    const tiny = render(tree(), false, { ...BOX, w: 90, h: 80 });
    for (const t of tiny.querySelectorAll('text.chart-cell-label')) {
      const cell = cells(tiny).find(r => r.getAttribute('data-tip')!.includes(`/ ${t.textContent}\n`))!;
      expect(t.textContent!.length * 11 * 0.6 + 16).toBeLessThanOrEqual(attr(cell, 'width') + 2);
    }
  });

  it('puts leaves of an unlisted parent in a neutral last group', () => {
    const g = render(tree([...LEAVES, { label: 'misc', value: 500, parent: '' }]));
    const misc = cells(g).find(r => r.getAttribute('data-tip')!.startsWith('misc'))!;
    expect(misc.getAttribute('class')).toBe('chart-cell chart-other');
    const big = render(tree([...LEAVES, { label: 'misc', value: 4000, parent: '' }]));
    const label = [...big.querySelectorAll('text.chart-cell-label')].find(t => t.textContent === 'misc')!;
    expect(label.getAttribute('class')).toBe('chart-cell-label chart-on-fill on-other');
  });

  it('dense keeps the cells and drops labels and legend', () => {
    const g = render(tree(), true);
    expect(g.querySelectorAll('text, .chart-legend')).toHaveLength(0);
    expect(cells(g)).toHaveLength(6);
    const total = LEAVES.reduce((s, l) => s + l.value, 0);
    expect(outer(cells(g)[0]) / (BOX.w * BOX.h)).toBeCloseTo(4100 / total, 2);
  });

  it('carries no inline colour', () => {
    expect(render(tree()).outerHTML).not.toMatch(INLINE_COLOR);
  });

  it('draws degenerate numbers without NaN or Infinity', () => {
    const single = render(tree([{ label: 'only', value: 5, parent: '' }], []));
    expect(cells(single)).toHaveLength(1);
    expect(attr(cells(single)[0], 'width')).toBe(BOX.w - 2);
    expect(cells(single)[0].getAttribute('data-tip')).toBe('only\n5 USD · 100%');
    const cases: TreemapData[] = [
      tree([{ label: 'only', value: 5, parent: '' }], []),
      tree([{ label: 'only', value: 5, parent: 'p' }], ['p']),
      tree([{ label: 'a', value: 5, parent: '' }, { label: 'b', value: 5, parent: '' }], []),
      tree([...LEAVES, { label: 'zero', value: 0, parent: 'data stores' }, { label: 'neg0', value: -0, parent: 'app services' }]),
      tree([{ label: 'big', value: 1e21, parent: '' }, { label: 'tiny', value: 1, parent: '' }], []),
      // the contract caps the sum at the largest finite double
      tree([{ label: 'max', value: 1e308, parent: '' }, { label: 'near', value: 7e307, parent: '' }], []),
    ];
    for (const d of cases) {
      for (const dense of [false, true]) {
        expect(render(d, dense).outerHTML).not.toMatch(/NaN|Infinity/);
      }
    }
  });
});
