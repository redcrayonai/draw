import { describe, it, expect } from 'vitest';
import { parseChart, type KanbanData } from '../../../module/src/chart-contracts';
import { renderKanban } from './kanban';
import { attr, group, INLINE_COLOR } from './test-util';

const BOX = { x: 16, y: 40, w: 640, h: 240 };

function kb(csv: string): KanbanData {
  const r = parseChart('kanban', csv, '{}');
  if (!r.ok) throw new Error(r.error);
  return r.data as KanbanData;
}

const BOARD = kb([
  'stage,card,lane,group,detail',
  'todo,Rate-limit login,api,bug,RC-612',
  'todo,Retry webhooks,api,,RC-618',
  'doing,Split cart,api,feature,RC-597',
  'review,,api,,',
  'done,Share menu,web,feature,RC-604',
].join('\n'));

const render = (d: KanbanData, dense = false, box = BOX) => group(renderKanban(d, box, dense));
const cards = (g: SVGGElement) => [...g.querySelectorAll('rect.chart-card')];
const texts = (g: SVGGElement, cls: string) => [...g.querySelectorAll(`text.${cls}`)].map(t => t.textContent);

describe('renderKanban', () => {
  it('draws one column per stage in first-seen order, with its card count; an empty stage still shows', () => {
    const g = render(BOARD);
    expect(texts(g, 'chart-stage')).toEqual(['todo', 'doing', 'review', 'done']);
    expect(texts(g, 'chart-count')).toEqual(['2', '1', '0', '1']);
    const xs = [...g.querySelectorAll('text.chart-stage')].map(t => attr(t, 'x'));
    for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeGreaterThan(xs[i - 1]);
    // every card sits under its stage's header and as wide as the column
    const c = cards(g);
    expect(c).toHaveLength(4);
    expect(attr(c[0], 'x')).toBe(xs[0]);
    expect(attr(c[2], 'x')).toBe(xs[1]);
    expect(attr(c[3], 'x')).toBe(xs[3]);
    expect(attr(c[0], 'width')).toBeCloseTo((BOX.w - 3 * 8) / 4, 5);
  });

  it('stacks a cell top down and puts each swim lane in its own band under its name', () => {
    const g = render(BOARD);
    expect(texts(g, 'chart-lane')).toEqual(['api', 'web']);
    const c = cards(g);
    expect(attr(c[1], 'y')).toBeGreaterThan(attr(c[0], 'y') + attr(c[0], 'height'));
    const webName = [...g.querySelectorAll('text.chart-lane')][1];
    expect(attr(webName, 'y')).toBeGreaterThan(attr(c[1], 'y') + attr(c[1], 'height'));
    expect(attr(c[3], 'y')).toBeGreaterThan(attr(webName, 'y'));
  });

  it('writes the title and the detail on each card, and gives a grouped card an edge and a legend', () => {
    const g = render(BOARD);
    expect(texts(g, 'chart-label.chart-text')).toEqual(['Rate-limit login', 'Retry webhooks', 'Split cart', 'Share menu']);
    expect(texts(g, 'chart-label.chart-muted')).toEqual(['RC-612', 'RC-618', 'RC-597', 'RC-604']);
    expect([...g.querySelectorAll('rect.chart-edge')].map(e => e.getAttribute('class'))).toEqual([
      'chart-edge series-1', 'chart-edge series-2', 'chart-edge series-2',
    ]);
    expect(texts(g, 'chart-legend-text')).toEqual(['bug', 'feature']);
    expect(g.outerHTML).not.toMatch(INLINE_COLOR);
  });

  it('gives each card a readout: title, detail, then stage, lane and group', () => {
    const c = cards(render(BOARD));
    expect(c[0].getAttribute('data-tip')).toBe('Rate-limit login\nRC-612\ntodo · api · bug');
    expect(c[1].getAttribute('data-tip')).toBe('Retry webhooks\nRC-618\ntodo · api');
    expect(cards(render(kb('stage,card\ntodo,a')))[0].getAttribute('data-tip')).toBe('a\ntodo');
  });

  it('a cut cell shows what fits and its last card counts the rest', () => {
    const tall = kb(['stage,card', ...Array.from({ length: 9 }, (_, i) => `todo,card ${i + 1}`), 'done,shipped'].join('\n'));
    const g = render(tall, false, { ...BOX, h: 120 });
    const shown = cards(g).length - 1; // less the done card
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(9);
    expect(texts(g, 'chart-more')).toEqual([`+${9 - shown}`]);
    expect(texts(g, 'chart-count')).toEqual(['9', '1']);
  });

  it('drops the detail lines before it cuts a card, then the legend, and merges lanes last', () => {
    const roomy = render(BOARD);
    expect(texts(roomy, 'chart-label.chart-muted')).toHaveLength(4);
    // too short for details: every card still shows, without them, legend kept
    const short = render(BOARD, false, { ...BOX, h: 170 });
    expect(cards(short)).toHaveLength(4);
    expect(texts(short, 'chart-label.chart-muted')).toEqual([]);
    expect(texts(short, 'chart-lane')).toEqual(['api', 'web']);
    expect(short.querySelector('.chart-legend')).not.toBeNull();
    // shorter: the legend goes so every card still shows
    const shorter = render(BOARD, false, { ...BOX, h: 150 });
    expect(cards(shorter)).toHaveLength(4);
    expect(shorter.querySelector('.chart-legend')).toBeNull();
    expect(texts(shorter, 'chart-lane')).toEqual(['api', 'web']);
    // shorter: the lanes merge into one band rather than leave a lane without a row
    const tiny = render(BOARD, false, { x: 0, y: 0, w: 192, h: 60 });
    expect(texts(tiny, 'chart-lane')).toEqual([]);
    expect(tiny.querySelector('.chart-legend')).toBeNull();
    expect(cards(tiny).length).toBeGreaterThan(0);
  });

  it('keeps the lanes while each lane with cards gets a row, even if a cell is cut', () => {
    const lanes = kb(['stage,card,lane', 'todo,a1,a', 'todo,a2,a', 'todo,a3,a', 'todo,b1,b'].join('\n'));
    const g = render(lanes, false, { ...BOX, h: 120 });
    expect(texts(g, 'chart-lane')).toEqual(['a', 'b']);
    expect(texts(g, 'chart-label.chart-text')).toContain('b1');
    expect(texts(g, 'chart-more')).toHaveLength(1);
    // five lanes in the same height cannot each have a row: they merge
    const five = kb(['stage,card,lane', ...Array.from({ length: 5 }, (_, i) => `todo,c${i},l${i}`)].join('\n'));
    const merged = render(five, false, { ...BOX, h: 120 });
    expect(texts(merged, 'chart-lane')).toEqual([]);
    const shown = cards(merged).length;
    expect(texts(merged, 'chart-more')).toEqual([`+${5 - shown}`]);
  });

  it('dense keeps the card boxes and their edges only', () => {
    const g = render(BOARD, true);
    expect(cards(g)).toHaveLength(4);
    expect(g.querySelectorAll('rect.chart-edge')).toHaveLength(3);
    expect(g.querySelector('text, .chart-grid, .chart-legend')).toBeNull();
  });
});
