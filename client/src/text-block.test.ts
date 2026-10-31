import { describe, it, expect } from 'vitest';
import { drawTextBlock, layoutText, parseInline, toggleMark } from './text-block';

const plain = { b: false, i: false, s: false, code: false };

describe('parseInline', () => {
  it('splits bold, italic, strike and code runs, nesting inside markers', () => {
    expect(parseInline('a **b *c* g** ~~d~~ `e*f*`')).toEqual([
      { text: 'a ', ...plain },
      { text: 'b ', ...plain, b: true },
      { text: 'c', ...plain, b: true, i: true },
      { text: ' g', ...plain, b: true },
      { text: ' ', ...plain },
      { text: 'd', ...plain, s: true },
      { text: ' ', ...plain },
      { text: 'e*f*', ...plain, code: true },
    ]);
  });

  it('closes an italic last word inside its bold, and a bold one inside its italic', () => {
    expect(parseInline('**bold *italic***')).toEqual([
      { text: 'bold ', ...plain, b: true },
      { text: 'italic', ...plain, b: true, i: true },
    ]);
    expect(parseInline('*lean **heavy***')).toEqual([
      { text: 'lean ', ...plain, i: true },
      { text: 'heavy', ...plain, b: true, i: true },
    ]);
    expect(parseInline('**a** and *b*')).toEqual([
      { text: 'a', ...plain, b: true },
      { text: ' and ', ...plain },
      { text: 'b', ...plain, i: true },
    ]);
  });

  it('reads ***x*** as bold italic and leaves stray or spaced stars as text', () => {
    expect(parseInline('***x***')).toEqual([{ text: 'x', ...plain, b: true, i: true }]);
    expect(parseInline('2 * 3 * 4')).toEqual([{ text: '2 * 3 * 4', ...plain }]);
    expect(parseInline('snake_case_name')).toEqual([{ text: 'snake_case_name', ...plain }]);
  });
});

describe('toggleMark', () => {
  it('wraps, then unwraps, keeping the selection on the same text', () => {
    const on = toggleMark('a word', 2, 6, '**');
    expect(on).toEqual({ value: 'a **word**', start: 4, end: 8 });
    expect(toggleMark(on.value, on.start, on.end, '**')).toEqual({ value: 'a word', start: 2, end: 6 });
  });

  it('unwraps a selection that carries its own markers, as after ⌘A', () => {
    expect(toggleMark('**Payments**', 0, 12, '**')).toEqual({ value: 'Payments', start: 0, end: 8 });
    expect(toggleMark('*x*', 0, 3, '*').value).toBe('x');
    expect(toggleMark('~~x~~', 0, 5, '~~').value).toBe('x');
    // Italic on a fully selected bold word stacks, not strips a star.
    expect(toggleMark('**x**', 0, 5, '*').value).toBe('***x***');
    expect(toggleMark('***x***', 0, 7, '**').value).toBe('*x*');
  });

  it('toggles each line of a selection that spans lines', () => {
    expect(toggleMark('one\ntwo', 0, 7, '**')).toEqual({ value: '**one**\n**two**', start: 0, end: 15 });
    expect(toggleMark('**one**\n\n**two**', 0, 16, '**').value).toBe('one\n\ntwo');
    // Mixed: on where missing, never doubled.
    expect(toggleMark('~~one~~\ntwo', 0, 11, '~~').value).toBe('~~one~~\n~~two~~');
  });

  it('stacks italic on bold and peels each off on its own', () => {
    const bold = '**x**';
    const both = toggleMark(bold, 2, 3, '*');
    expect(both.value).toBe('***x***');
    expect(toggleMark(both.value, both.start, both.end, '**').value).toBe('*x*');
    expect(toggleMark(both.value, both.start, both.end, '*').value).toBe('**x**');
  });
});

describe('layoutText', () => {
  it('sizes the font by node size and fits the box on the grid, one line box per line', () => {
    const m = layoutText('one\n**two**', 'm');
    expect([m.fontSize, m.lineHeight, m.h]).toEqual([20, 28, 56]);
    expect(m.w % 4).toBe(0);
    expect(layoutText('one', 'l').w).toBeGreaterThan(layoutText('one', 's').w);
    expect(layoutText('', 'm')).toMatchObject({ w: 16, h: 28 });
  });
});

describe('drawTextBlock', () => {
  it('keeps spaces and strikes through with attributes, which the SVG export keeps', () => {
    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    drawTextBlock(text, 'a    ~~b~~', 'm');
    expect(text.getAttributeNS('http://www.w3.org/XML/1998/namespace', 'space')).toBe('preserve');
    const spans = text.querySelectorAll('tspan tspan');
    expect(spans[0].textContent).toBe('a    ');
    expect(spans[1].getAttribute('text-decoration')).toBe('line-through');
  });
});
