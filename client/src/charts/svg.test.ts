import { describe, it, expect } from 'vitest';
import { barPath, legend, lineAttrs, num, seriesClass, svgEl, txt } from './svg';

describe('svgEl', () => {
  it('creates a namespaced element with attributes and text', () => {
    const e = svgEl('text', { x: '4', class: 'chart-muted' }, 'hello');
    expect(e.namespaceURI).toBe('http://www.w3.org/2000/svg');
    expect(e.tagName).toBe('text');
    expect(e.getAttribute('x')).toBe('4');
    expect(e.getAttribute('class')).toBe('chart-muted');
    expect(e.textContent).toBe('hello');
  });

  it('defaults to no attributes and no text', () => {
    const e = svgEl('g');
    expect(e.attributes).toHaveLength(0);
    expect(e.textContent).toBe('');
  });
});

describe('helpers', () => {
  it('num rounds to two decimals and drops -0', () => {
    expect(num(1.23456)).toBe('1.23');
    expect(num(-0.001)).toBe('0');
    expect(num(12)).toBe('12');
  });

  it('seriesClass is 1-based and fixed', () => {
    expect([0, 1, 2, 3, 4].map(seriesClass)).toEqual(['series-1', 'series-2', 'series-3', 'series-4', 'series-5']);
  });

  it('txt sets size, anchor and tabular figures as attributes', () => {
    const t = txt(10, 20, '1,284', 'chart-value', 12, 'end', true);
    expect(t.getAttribute('font-size')).toBe('12');
    expect(t.getAttribute('text-anchor')).toBe('end');
    expect(t.getAttribute('font-variant-numeric')).toBe('tabular-nums');
    expect(txt(0, 0, 'a', 'c', 10).hasAttribute('font-variant-numeric')).toBe(false);
  });

  it('lineAttrs carries round joins and caps as attributes', () => {
    expect(lineAttrs('chart-line series-1')).toEqual({
      class: 'chart-line series-1', fill: 'none', 'stroke-width': '2', 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
    });
  });
});

describe('barPath', () => {
  it('rounds the data end of an upward bar and keeps the base square', () => {
    expect(barPath(true, 10, 20, 100, 40, 4)).toBe('M10 100 L10 44 A4 4 0 0 1 14 40 L26 40 A4 4 0 0 1 30 44 L30 100 Z');
  });

  it('rounds the right end of a horizontal bar', () => {
    expect(barPath(false, 10, 8, 0, 50, 4)).toBe('M0 10 L46 10 A4 4 0 0 1 50 14 L50 14 A4 4 0 0 1 46 18 L0 18 Z');
  });

  it('rounds the bottom of a downward (negative) bar', () => {
    expect(barPath(true, 0, 10, 50, 80, 4)).toBe('M0 50 L0 76 A4 4 0 0 0 4 80 L6 80 A4 4 0 0 0 10 76 L10 50 Z');
  });

  it('clamps the radius to the bar and draws a plain box when it is zero', () => {
    expect(barPath(true, 0, 10, 50, 48, 4)).toBe('M0 50 L0 50 A2 2 0 0 1 2 48 L8 48 A2 2 0 0 1 10 50 L10 50 Z');
    expect(barPath(true, 0, 10, 50, 30, 0)).toBe('M0 50 L0 30 L10 30 L10 50 Z');
  });
});

describe('legend', () => {
  it('draws a swatch with the slot class and a muted name per item', () => {
    const g = legend([{ name: 'checkout', cls: 'series-1' }, { name: 'search', cls: 'series-2' }], 0, 100, 300);
    expect(g.getAttribute('class')).toBe('chart-legend');
    expect([...g.querySelectorAll('rect')].map(r => r.getAttribute('class'))).toEqual(['chart-swatch series-1', 'chart-swatch series-2']);
    expect([...g.querySelectorAll('text')].map(t => t.textContent)).toEqual(['checkout', 'search']);
    expect([...g.querySelectorAll('text')].every(t => !/series-/.test(t.getAttribute('class') ?? ''))).toBe(true);
  });

  it('collapses items that do not fit into a +N count', () => {
    const items = ['us-east-1', 'eu-west-1', 'ap-south-1', 'sa-east-1', 'ca-central-1'].map((name, i) => ({ name, cls: seriesClass(i) }));
    const g = legend(items, 0, 100, 160);
    const texts = [...g.querySelectorAll('text')].map(t => t.textContent);
    expect(texts[texts.length - 1]).toMatch(/^\+\d$/);
    const shown = g.querySelectorAll('rect').length;
    expect(shown + Number(texts[texts.length - 1]!.slice(1))).toBe(5);
  });
});
