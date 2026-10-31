import { describe, it, expect } from 'vitest';
import type { PieData } from '../../../module/src/chart-contracts';
import { renderPie } from './pie';
import { group, INLINE_COLOR, pathPoints } from './test-util';

const BOX = { x: 16, y: 40, w: 320, h: 140 };
const SLICES = [
  { label: 'web', value: 46, other: false },
  { label: 'ios', value: 27, other: false },
  { label: 'android', value: 19, other: false },
  { label: 'api', value: 8, other: false },
];

function pie(slices = SLICES, donut = true): PieData {
  return {
    type: 'pie',
    options: { donut, unit: '' },
    valueName: 'sessions',
    slices,
    total: slices.reduce((s, x) => s + x.value, 0),
  };
}

const render = (d: PieData, dense = false) => group(renderPie(d, BOX, dense));
const slicesOf = (g: SVGGElement) => [...g.querySelectorAll('path.chart-slice')];
const TAU = Math.PI * 2;

/** Outer arc sweep of a slice path, from its first two points around the centre. */
function sweep(d: string, cx: number, cy: number): number {
  const [[x0, y0], [x1, y1]] = pathPoints(d);
  const a0 = Math.atan2(y0 - cy, x0 - cx);
  const a1 = Math.atan2(y1 - cy, x1 - cx);
  return (((a1 - a0) % TAU) + TAU) % TAU;
}

describe('renderPie', () => {
  // Not dense: diameter = min(h - 8, 0.45 w) = 132 (8 px kept above the footnote), centred at (x + 66, y + 66).
  const cx = BOX.x + 66;
  const cy = BOX.y + 66;
  const r = 66;

  it('sweeps each slice in proportion to its value, less a 2 px gap', () => {
    const g = render(pie());
    const paths = slicesOf(g);
    expect(paths).toHaveLength(4);
    paths.forEach((p, i) => {
      const expected = (SLICES[i].value / 100) * TAU - 2 / r;
      expect(sweep(p.getAttribute('d')!, cx, cy)).toBeCloseTo(expected, 2);
    });
  });

  it('starts at 12 o\'clock and goes clockwise', () => {
    const [[x, y]] = pathPoints(slicesOf(render(pie()))[0].getAttribute('d')!);
    expect(x).toBeGreaterThan(cx);
    expect(x - cx).toBeLessThan(2);
    expect(y).toBeCloseTo(cy - r, 0);
  });

  it('cuts a donut hole at 70 % and puts the total and value name in it', () => {
    const g = render(pie());
    const pts = pathPoints(slicesOf(g)[0].getAttribute('d')!);
    const inner = Math.hypot(pts[2][0] - cx, pts[2][1] - cy);
    expect(inner).toBeCloseTo(r * 0.7, 0);
    expect(g.querySelector('text.chart-center')!.textContent).toBe('100');
    expect(g.querySelector('text.chart-center-label')!.textContent).toBe('sessions');
  });

  it('draws wedges to the centre when donut is false, with no centre text', () => {
    const g = render(pie(SLICES, false));
    expect(slicesOf(g)[0].getAttribute('d')).toContain(`L${cx} ${cy} Z`);
    expect(g.querySelector('text.chart-center')).toBeNull();
  });

  it('gives slices series slots in order and the folded slice the neutral class', () => {
    const folded = [...SLICES.slice(0, 3), { label: 'other', value: 8, other: true }];
    const g = render(pie(folded));
    expect(slicesOf(g).map(p => p.getAttribute('class'))).toEqual([
      'chart-slice series-1', 'chart-slice series-2', 'chart-slice series-3', 'chart-slice chart-other',
    ]);
    expect([...g.querySelectorAll('.chart-legend .chart-swatch')].map(s => s.getAttribute('class'))).toEqual([
      'chart-swatch series-1', 'chart-swatch series-2', 'chart-swatch series-3', 'chart-swatch chart-other',
    ]);
  });

  it('lists every slice with its share in the legend', () => {
    const g = render(pie([...SLICES, { label: 'tv', value: 0.5, other: false }]));
    const rows = [...g.querySelectorAll('.chart-legend text.chart-value')].map(t => t.textContent);
    expect(rows).toEqual(['46%', '27%', '19%', '8%', '0.5%']);
  });

  it('gives each slice a tooltip with value and share', () => {
    expect(slicesOf(render(pie()))[1].getAttribute('data-tip')).toBe('ios\n27 · 27%');
  });

  it('draws a single slice as a full ring', () => {
    const g = render(pie([{ label: 'all', value: 5, other: false }]));
    const p = slicesOf(g)[0];
    expect(p.getAttribute('fill-rule')).toBe('evenodd');
    expect(p.getAttribute('d')!.match(/A/g)).toHaveLength(4);
  });

  it('skips zero slices but keeps them in the legend', () => {
    const g = render(pie([...SLICES, { label: 'tv', value: 0, other: false }]));
    expect(slicesOf(g)).toHaveLength(4);
    expect(g.querySelectorAll('.chart-legend .chart-swatch')).toHaveLength(5);
  });

  it('dense fills the box with the ring and drops text and legend', () => {
    const g = render(pie(), true);
    expect(g.querySelectorAll('text, .chart-legend')).toHaveLength(0);
    expect(slicesOf(g)).toHaveLength(4);
    const [[x, y]] = pathPoints(slicesOf(g)[0].getAttribute('d')!);
    // centred in the box, outer radius = half the box height (1 px gap offset at the start)
    expect(Math.abs(x - (BOX.x + BOX.w / 2))).toBeLessThan(2);
    expect(y).toBeCloseTo(BOX.y, 0);
  });

  it('carries no inline colour', () => {
    expect(render(pie()).outerHTML).not.toMatch(INLINE_COLOR);
  });

  it('draws degenerate numbers without NaN or Infinity', () => {
    const cases = [
      [...SLICES, { label: 'tv', value: 0, other: false }],
      [{ label: 'zero', value: 0, other: false }, { label: 'all', value: 5, other: false }],
      [{ label: 'neg0', value: -0, other: false }, { label: 'all', value: 5, other: false }],
      [{ label: 'a', value: 5, other: false }, { label: 'b', value: 5, other: false }],
      [{ label: 'big', value: 1e308, other: false }, { label: 'tiny', value: 1e-300, other: false }, { label: 'mid', value: 1e21, other: true }],
    ];
    for (const slices of cases) {
      for (const donut of [true, false]) {
        for (const dense of [false, true]) {
          expect(render(pie(slices, donut), dense).outerHTML).not.toMatch(/NaN|Infinity/);
        }
      }
    }
  });

  it('keeps each share next to its label on a wide card', () => {
    // Visual check (R3b): at 672 px the shares sat 400 px right of their labels.
    const g = group(renderPie(pie(), { x: 0, y: 0, w: 672, h: 236 }, false));
    const swatches = [...g.querySelectorAll('.chart-legend .chart-swatch')];
    const shares = [...g.querySelectorAll('.chart-legend .chart-value')];
    expect(shares).toHaveLength(4);
    shares.forEach((s, i) => {
      expect(Number(s.getAttribute('x')) - Number(swatches[i].getAttribute('x'))).toBeLessThanOrEqual(200);
    });
  });

  it('M8: the ring leaves at least 8 px above the footnote (the bottom of the plot box)', () => {
    for (const donut of [true, false]) {
      const pts = slicesOf(render(pie(SLICES, donut))).flatMap(p => pathPoints(p.getAttribute('d')!));
      expect(Math.max(...pts.map(p => p[1]))).toBeLessThanOrEqual(BOX.y + BOX.h - 8);
    }
  });
});
