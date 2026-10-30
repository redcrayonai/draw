import { describe, it, expect } from 'vitest';
import { parseChart, type TableData } from '../../../module/src/chart-contracts';
import { renderTable } from './table';
import { attr, group, INLINE_COLOR } from './test-util';

const BOX = { x: 16, y: 40, w: 320, h: 140 };
const ROWS = [
  ['api-1', '72', '1.2', '41'],
  ['api-2', '94', '1.9', '88'],
  ['worker-1', '38', '0.8', ''],
  ['db-primary', '61', '6.1', '4'],
];

function table(rows = ROWS, thresholds: TableData['options']['thresholds'] = []): TableData {
  const values = rows.map(r => r.map((s, c) => (c > 0 && s !== '' ? Number(s) : null)));
  return { type: 'table', options: { thresholds }, header: ['host', 'cpu', 'mem', 'p50'], numeric: [false, true, true, true], rows, values };
}

const render = (d: TableData, dense = false, box = BOX) => group(renderTable(d, box, dense));
const cellTexts = (g: SVGGElement) => [...g.querySelectorAll('text.chart-cell-text')];

describe('renderTable', () => {
  it('draws a muted header and one text per cell', () => {
    const g = render(table());
    expect([...g.querySelectorAll('text.chart-head')].map(t => t.textContent)).toEqual(['host', 'cpu', 'mem', 'p50']);
    expect(g.querySelector('text.chart-head')!.getAttribute('class')).toBe('chart-head chart-faint');
    expect(cellTexts(g).map(t => t.textContent)).toEqual(ROWS.flat());
  });

  it('right-aligns number columns in tabular figures and left-aligns text columns', () => {
    const g = render(table());
    const cells = cellTexts(g);
    const first = cells[0];
    expect(first.getAttribute('text-anchor')).toBe('start');
    expect(first.getAttribute('class')).toContain('chart-mono');
    for (const c of [cells[1], cells[2], cells[3]]) {
      expect(c.getAttribute('text-anchor')).toBe('end');
      expect(c.getAttribute('font-variant-numeric')).toBe('tabular-nums');
    }
    // number cells of one column share their right edge
    expect(attr(cells[1], 'x')).toBe(attr(cells[5], 'x'));
  });

  it('separates rows with hairlines (one under the header, none after the last row)', () => {
    const g = render(table());
    expect(g.querySelectorAll('line.chart-grid')).toHaveLength(1 + ROWS.length - 1);
  });

  it('marks threshold breaches with a glyph per level and a status class, not colour alone', () => {
    const g = render(table(ROWS, [
      { column: 'cpu', warn: 70, crit: 90, direction: 'above' },
      { column: 'p50', warn: 5, crit: 2, direction: 'below' },
    ]));
    const glyphs = [...g.querySelectorAll('text.chart-glyph')];
    expect(glyphs.map(t => [t.textContent, t.getAttribute('class')])).toEqual([
      ['▲', 'chart-glyph chart-warn'],
      ['●', 'chart-glyph chart-crit'],
      ['▲', 'chart-glyph chart-warn'],
    ]);
    // the value text itself keeps the ink class
    expect(cellTexts(g)[5].getAttribute('class')).toBe('chart-cell-text chart-text');
    // the glyph sits left of its value
    expect(attr(glyphs[1], 'x')).toBeLessThan(attr(cellTexts(g)[5], 'x'));
    const tip = g.querySelectorAll('rect.chart-hit')[1].getAttribute('data-tip')!;
    expect(tip).toBe('host: api-2\ncpu: 94 · crit (≥ 90)\nmem: 1.9\np50: 88');
  });

  it('ignores empty cells for thresholds', () => {
    const g = render(table(ROWS, [{ column: 'p50', warn: 50, crit: 80, direction: 'below' }]));
    // worker-1 has no p50: no glyph on that row
    const statuses = [...g.querySelectorAll('rect.chart-hit')].map(r => r.getAttribute('data-tip')!.includes('·'));
    expect(statuses).toEqual([true, false, false, true]);
  });

  it('cuts rows that do not fit and says how many', () => {
    const many = Array.from({ length: 30 }, (_, i) => [`host-${i}`, String(i), '1', '2']);
    const g = render(table(many));
    // (140 - 20) / 22 = 5 rows fit; one gives way to the '+N more rows' line
    expect(g.querySelectorAll('rect.chart-hit')).toHaveLength(4);
    expect(g.querySelector('text.chart-more')!.textContent).toBe('+26 more rows');
  });

  it('ellipsizes cells that do not fit their column', () => {
    const long = [['a-very-long-host-name-that-goes-on-and-on-and-on-forever', '1', '2', '3']];
    const g = render(table(long), false, { ...BOX, w: 200 });
    expect(cellTexts(g)[0].textContent!.endsWith('…')).toBe(true);
    expect(g.querySelector('rect.chart-hit')!.getAttribute('data-tip')).toContain('a-very-long-host-name-that-goes-on-and-on-and-on-forever');
  });

  it('M10: dense drops every text and keeps the row hairlines and threshold dots', () => {
    const g = render(table(ROWS, [{ column: 'cpu', warn: 70, crit: 90, direction: 'above' }]), true);
    expect(g.querySelectorAll('text')).toHaveLength(0);
    expect(g.querySelectorAll('line.chart-grid')).toHaveLength(ROWS.length - 1);
    // warn and crit differ in shape too: a triangle and a dot
    const dots = [...g.querySelectorAll('.chart-glyph')];
    expect(dots.map(c => [c.tagName, c.getAttribute('class')])).toEqual([
      ['path', 'chart-glyph chart-warn'],
      ['circle', 'chart-glyph chart-crit'],
    ]);
    // each dot on its row, inside the cpu column
    const hits = [...g.querySelectorAll('rect.chart-hit')];
    expect(hits).toHaveLength(4);
    // a circle's centre, or a triangle's apex (the first point of its path)
    const cy = (c: Element) => (c.tagName === 'circle' ? attr(c, 'cy') : Number(c.getAttribute('d')!.match(/-?[\d.]+/g)![1]));
    const inRow = (c: Element, r: Element) => cy(c) > attr(r, 'y') && cy(c) < attr(r, 'y') + attr(r, 'height');
    expect(inRow(dots[0], hits[0])).toBe(true);
    expect(inRow(dots[1], hits[1])).toBe(true);
  });

  it('carries no inline colour', () => {
    expect(render(table(ROWS, [{ column: 'cpu', warn: 70, crit: 90, direction: 'above' }])).outerHTML).not.toMatch(INLINE_COLOR);
  });

  it('draws degenerate cells without NaN or Infinity', () => {
    // Cells stay strings; this table marks the '−5' column as text, so it draws as a text cell.
    const d: TableData = {
      type: 'table',
      options: { thresholds: [{ column: 'n', warn: 1, crit: 2, direction: 'above' }] },
      header: ['delta', 'n'],
      numeric: [false, true],
      rows: [['−5', '-0'], ['', '1e21'], ['0', '0']],
      values: [[null, -0], [null, 1e21], [null, 0]],
    };
    const single: TableData = { type: 'table', options: { thresholds: [] }, header: ['x'], numeric: [true], rows: [['5']], values: [[5]] };
    for (const dense of [false, true]) {
      const g = render(d, dense);
      expect(g.outerHTML).not.toMatch(/NaN|Infinity/);
      if (!dense) {
        expect(cellTexts(g)[0].textContent).toBe('−5');
        expect(cellTexts(g)[0].getAttribute('text-anchor')).toBe('start');
      }
      expect(g.querySelectorAll('rect.chart-hit')[0].getAttribute('data-tip')).toBe('delta: −5\nn: -0');
      expect(render(single, dense).outerHTML).not.toMatch(/NaN|Infinity/);
    }
  });

  it('BUG1: a U+2212 minus breaches a threshold exactly like an ASCII minus', () => {
    const opts = '{"thresholds":[{"column":"cpu","warn":-10,"crit":-20,"direction":"below"}]}';
    const parse = (minus: string) => {
      const r = parseChart('table', `host,cpu\na,${minus}15\nb,${minus}25\nc,3`, opts);
      if (!r.ok) throw new Error(r.error);
      return r.data as TableData;
    };
    const glyphs = (d: TableData, dense: boolean) => [...render(d, dense).querySelectorAll('.chart-glyph')].map(g => g.outerHTML);
    const unicode = parse('−');
    const ascii = parse('-');
    const g = render(unicode);
    expect([...g.querySelectorAll('text.chart-glyph')].map(t => [t.textContent, t.getAttribute('class')])).toEqual([
      ['▲', 'chart-glyph chart-warn'],
      ['●', 'chart-glyph chart-crit'],
    ]);
    expect([...g.querySelectorAll('rect.chart-hit')].map(r => r.getAttribute('data-tip'))).toEqual([
      'host: a\ncpu: −15 · warn (≤ -10)',
      'host: b\ncpu: −25 · crit (≤ -20)',
      'host: c\ncpu: 3',
    ]);
    expect([...render(unicode, true).querySelectorAll('.chart-glyph')].map(c => [c.tagName, c.getAttribute('class')])).toEqual([
      ['path', 'chart-glyph chart-warn'],
      ['circle', 'chart-glyph chart-crit'],
    ]);
    for (const dense of [false, true]) {
      expect(glyphs(unicode, dense)).toEqual(glyphs(ascii, dense));
    }
  });

  it('never cuts a number: number columns keep their width and text columns shrink', () => {
    // Visual check (R3b): 8 columns in 320 px cut cpu to '' and mem to '0…'.
    const wide: TableData = {
      type: 'table',
      options: { thresholds: [{ column: 'cpu', warn: 80, crit: 90, direction: 'above' }] },
      header: ['host', 'cpu', 'mem_gb', 'p50_ms', 'p99_ms', 'free', 'region', 'owner'],
      numeric: [false, true, true, true, true, true, false, false],
      rows: [['host-with-long-name-0', '94', '0.7', '10', '100', '14', 'us-east-1', 'team-platform']],
      values: [[null, 94, 0.7, 10, 100, 14, null, null]],
    };
    const g = render(wide);
    const texts = cellTexts(g).map(t => t.textContent);
    expect(texts.slice(1, 6)).toEqual(['94', '0.7', '10', '100', '14']);
    expect([...g.querySelectorAll('text.chart-head')].map(t => t.textContent).slice(1, 6)).toEqual(['cpu', 'mem_gb', 'p50_ms', 'p99_ms', 'free']);
    expect(g.querySelector('.chart-glyph.chart-crit')).not.toBeNull();
    expect(texts[0]).toMatch(/…$/);
  });
});
