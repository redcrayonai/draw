import { describe, it, expect } from 'vitest';
import { parseChart, type ScheduleData } from '../../../module/src/chart-contracts';
import { renderSchedule } from './schedule';
import { textW } from './scale';
import { attr, group, INLINE_COLOR } from './test-util';

const BOX = { x: 16, y: 40, w: 416, h: 160 };

/** Parse a schedule as the card would, so the tests read in CSV. */
function sched(csv: string, options = '{}'): ScheduleData {
  const r = parseChart('schedule', csv, options);
  if (!r.ok) throw new Error(r.error);
  return r.data as ScheduleData;
}

const PLAN_CSV = [
  'lane,item,start,end,status',
  'platform,schema,2026-10-01,2026-10-07,done',
  'platform,backfill,2026-10-08,2026-10-16,active',
  'platform,cutover,2026-10-22,,planned',
  'api,dual writes,2026-10-05,2026-10-13,',
  'api,read switch,2026-10-14,2026-10-21,planned',
  'web,load test,2026-10-20,2026-10-25,blocked',
].join('\n');
const PLAN = sched(PLAN_CSV);

const render = (d: ScheduleData, dense = false, box = BOX) => group(renderSchedule(d, box, dense));
const bars = (g: SVGGElement) => [...g.querySelectorAll('rect.chart-bar')];
const labels = (g: SVGGElement) => [...g.querySelectorAll('text.chart-label')].map(t => t.textContent);

describe('renderSchedule', () => {
  it('runs each bar from its start to its end on one time axis, whole days for end dates', () => {
    const b = bars(render(PLAN));
    expect(b).toHaveLength(5);
    // schema: Oct 1 → end of Oct 7 (7 days); backfill: Oct 8 → end of Oct 16 (9 days)
    const perDay = (attr(b[1], 'x') - attr(b[0], 'x')) / 7;
    expect(attr(b[0], 'width') + 2).toBeCloseTo(7 * perDay, 1);
    expect(attr(b[1], 'width') + 2).toBeCloseTo(9 * perDay, 1);
    expect(attr(b[2], 'x') - attr(b[0], 'x')).toBeCloseTo(4 * perDay, 1);
    // back to back: the next bar starts where the last day ends, 2 px after the bar
    expect(attr(b[1], 'x') - (attr(b[0], 'x') + attr(b[0], 'width'))).toBeCloseTo(2, 1);
  });

  it('puts one band per lane in first-seen order, and back-to-back items share a row', () => {
    const g = render(PLAN);
    const names = [...g.querySelectorAll('text.chart-label')].filter(t => attr(t, 'x') === BOX.x).map(t => t.textContent);
    expect(names).toEqual(['platform', 'api', 'web']);
    const y = bars(g).map(r => attr(r, 'y'));
    expect(y[0]).toBe(y[1]); // schema and backfill
    expect(y[2]).toBe(y[3]); // dual writes and read switch
    expect(y[2]).toBeGreaterThan(y[0]);
    expect(y[4]).toBeGreaterThan(y[2]);
  });

  it('stacks items that overlap in time inside their lane', () => {
    const g = render(sched('lane,item,start,end\nops,a,10:00,12:00\nops,b,11:00,13:00\nops,c,12:30,14:00\nweb,d,10:00,11:00'));
    const y = bars(g).map(r => attr(r, 'y'));
    expect(y[1]).toBeGreaterThan(y[0]); // b overlaps a
    expect(y[2]).toBe(y[0]); // c starts after a ends
    expect(y[3]).toBeGreaterThan(y[1]); // the web lane comes after both ops rows
  });

  it('never shows status by colour alone: planned is outlined, done has ✓, blocked has the error outline and !', () => {
    const g = render(PLAN);
    expect(bars(g).map(r => r.getAttribute('class'))).toEqual([
      'chart-bar series-1', 'chart-bar series-1', 'chart-bar series-1', 'chart-bar series-1 chart-planned', 'chart-bar series-1 chart-error',
    ]);
    const diamond = g.querySelector('path.chart-milestone')!;
    expect(diamond.getAttribute('class')).toBe('chart-milestone series-1 chart-planned');
    expect(labels(g)).toContain('✓ schema');
    expect([...g.querySelectorAll('text.chart-glyph')].map(t => [t.textContent, t.getAttribute('class')])).toEqual([['!', 'chart-glyph chart-error']]);
    expect(g.outerHTML).not.toMatch(INLINE_COLOR);
  });

  it('labels a bar on its fill when it fits, else after it, else before it, else only in the readout', () => {
    const g = render(PLAN);
    const at = (text: string) => [...g.querySelectorAll('text.chart-label')].find(t => t.textContent === text)!;
    const b = bars(g);
    // on the fill: the theme's text colour for that series
    expect(at('backfill').getAttribute('class')).toBe('chart-label chart-on-fill on-series-1');
    expect(attr(at('backfill'), 'x')).toBe(attr(b[1], 'x') + 5);
    // an outlined bar keeps ink
    expect(at('read switch').getAttribute('class')).toBe('chart-label chart-text');
    // a milestone's label goes after the diamond
    expect(attr(at('cutover'), 'x')).toBeGreaterThan(attr(b[1], 'x') + attr(b[1], 'width'));
    // too short for its label, with neighbours on both sides: the readout only
    const tight = render(sched('lane,item,start,end\na,first,2026-10-01,2026-10-04\na,a very long name,2026-10-05,2026-10-05\na,last,2026-10-06,2026-10-09'));
    expect(labels(tight)).not.toContain('a very long name');
    expect([...tight.querySelectorAll('rect.chart-bar')][1].getAttribute('data-tip')).toBe('a very long name\na · 2026-10-05 → 2026-10-05');
    // room only before it: the label ends just left of the bar
    const before = render(sched('lane,item,start,end\na,x,2026-10-01,2026-10-04\na,wrap up,2026-10-20,2026-10-20\na,y,2026-10-21,2026-10-31'));
    const t = [...before.querySelectorAll('text.chart-label')].find(e => e.textContent === 'wrap up')!;
    const wrap = [...before.querySelectorAll('rect.chart-bar')][1];
    expect(t.getAttribute('text-anchor')).toBe('end');
    expect(attr(t, 'x')).toBe(attr(wrap, 'x') - 4);
  });

  it('never puts a label over a neighbour\'s label or bar in its row', () => {
    // review case: the first label goes after its bar, the second before its own, into the same gap
    const cases = [
      sched('lane,item,start,end\na,first long task,00:00,00:10\na,next long task,00:40,00:50\na,x,00:51,01:00'),
      sched('lane,item,start,end,status\na,alpha,00:00,00:05,blocked\na,beta release,00:30,00:31,\na,gamma,00:32,00:40,'),
      sched('lane,item,start,end\na,kickoff,00:00,\na,design review,00:20,\na,ship it,00:40,'),
    ];
    for (const d of cases) {
      const g = render(d, false, { x: 0, y: 0, w: 320, h: 120 });
      const boxes = [...g.querySelectorAll('text.chart-label, text.chart-glyph')]
        .filter(t => attr(t, 'x') !== 0) // lane names sit in their own column
        .map(t => {
          const w = textW(t.textContent ?? '', attr(t, 'font-size'));
          const x = attr(t, 'x');
          const x0 = t.getAttribute('text-anchor') === 'end' ? x - w : x;
          return { text: t.textContent, y: attr(t, 'y'), x0, x1: x0 + w, inside: (t.getAttribute('class') ?? '').includes('chart-on-fill') };
        });
      for (const [i, a] of boxes.entries()) {
        for (const b of boxes.slice(i + 1)) {
          if (a.y === b.y) expect(a.x1 <= b.x0 || b.x1 <= a.x0, `'${a.text}' overlaps '${b.text}'`).toBe(true);
        }
      }
      // an outside label never sits on a bar or a diamond of its row
      const marks = [...g.querySelectorAll('rect.chart-bar')].map(r => ({ y: attr(r, 'y') + attr(r, 'height') / 2, x0: attr(r, 'x'), x1: attr(r, 'x') + attr(r, 'width') }));
      for (const a of boxes.filter(b => !b.inside)) {
        for (const m of marks.filter(m => Math.abs(m.y + 3.5 - a.y) < 1)) {
          expect(a.x1 <= m.x0 || m.x1 <= a.x0, `'${a.text}' sits on a bar`).toBe(true);
        }
      }
    }
  });

  it('gives the last milestone room for its label at the right edge', () => {
    const g = render(sched('lane,item,start,end\nweb,build,2026-10-01,2026-10-20\nweb,launch day,2026-10-27,'));
    const label = [...g.querySelectorAll('text.chart-label')].find(t => t.textContent === 'launch day')!;
    expect(label).toBeDefined();
    expect(attr(label, 'x')).toBeLessThan(BOX.x + BOX.w);
  });

  it('gives each item a readout: name, lane, times as written, status and group', () => {
    const b = bars(render(PLAN));
    expect(b[0].getAttribute('data-tip')).toBe('schema\nplatform · 2026-10-01 → 2026-10-07\nstatus: done');
    const d = sched('lane,item,start,end,group\nalice,primary,09:00,17:00,eu\nalice,handoff,17:00,,eu');
    const g = render(d);
    expect(g.querySelector('rect.chart-bar')!.getAttribute('data-tip')).toBe('primary\nalice · 09:00 → 17:00\ngroup: eu');
    expect(g.querySelector('path.chart-milestone')!.getAttribute('data-tip')).toBe('handoff\nalice · 17:00\ngroup: eu');
  });

  it('labels the time axis with calendar ticks and draws the marker with its date', () => {
    const g = render(sched(PLAN_CSV, '{"marker":"2026-10-18"}'));
    const ticks = [...g.querySelectorAll('text.chart-tick')].map(t => t.textContent);
    expect(ticks.length).toBeGreaterThanOrEqual(2);
    for (const t of ticks) expect(t).toMatch(/^Oct \d+$/);
    const marker = g.querySelector('line.chart-marker')!;
    expect(marker).not.toBeNull();
    expect(g.querySelector('text.chart-marker-label')!.textContent).toBe('Oct 18');
    // Oct 18 sits between the start of backfill (Oct 8) and the end of read switch (Oct 22)
    const b = bars(g);
    expect(attr(marker, 'x1')).toBeGreaterThan(attr(b[1], 'x'));
    expect(attr(marker, 'x1')).toBeLessThan(attr(b[3], 'x') + attr(b[3], 'width'));
  });

  it('cuts whole lanes that do not fit and counts them', () => {
    const many = sched(['lane,item,start,end', ...Array.from({ length: 8 }, (_, i) => `l${i},x${i},2026-10-0${i + 1},2026-10-0${i + 2}`)].join('\n'));
    const g = render(many, false, { ...BOX, h: 100 });
    const more = g.querySelector('text.chart-more')!;
    const shown = bars(g).length;
    expect(shown).toBeLessThan(8);
    expect(more.textContent).toBe(`+${8 - shown} more lanes`);
    // every shown bar sits above the count line
    for (const r of bars(g)) expect(attr(r, 'y') + attr(r, 'height')).toBeLessThan(attr(more, 'y'));
  });

  it('shows the group legend only when it costs no lane', () => {
    const csv = ['lane,item,start,end,group', ...Array.from({ length: 4 }, (_, i) => `l${i},x,2026-10-01,2026-10-03,${i % 2 ? 'eu' : 'us'}`)].join('\n');
    expect(render(sched(csv)).querySelector('.chart-legend')).not.toBeNull();
    const short = render(sched(csv), false, { ...BOX, h: 90 });
    expect(short.querySelector('.chart-legend')).toBeNull();
    expect(short.querySelector('.chart-more')).toBeNull();
  });

  it('dense keeps the bars, the milestones and the marker line', () => {
    const g = render(sched(PLAN_CSV, '{"marker":"2026-10-18"}'), true);
    expect(bars(g)).toHaveLength(5);
    expect(g.querySelectorAll('path.chart-milestone')).toHaveLength(1);
    expect(g.querySelector('line.chart-marker')).not.toBeNull();
    expect(g.querySelector('text, .chart-grid, .chart-legend')).toBeNull();
  });
});
