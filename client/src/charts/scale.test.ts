import { describe, it, expect, vi } from 'vitest';
import { textWidth } from '../node-text';
import { axisTicks, fitText, formatValue, formatX, niceTicks, squarify, textW, timeTicks } from './scale';

describe('axisTicks', () => {
  const valid = (t: number[]) => t.every((v, i) => Number.isFinite(v) && !Object.is(v, -0) && (i === 0 || v > t[i - 1]));

  it('keeps 3 to 5 classic ticks when they hug the data', () => {
    expect(axisTicks(0, 180, 98, 24)).toEqual([0, 50, 100, 150, 200]);
    expect(axisTicks(0, 7, 98, 24)).toEqual([0, 2, 4, 6, 8]);
  });

  it('M4: puts the nice max at most ~25 % above the data max where a nice step allows', () => {
    // 106K: 0-120K in steps of 40K, not 0-150K
    expect(axisTicks(0, 106500, 98, 24)).toEqual([0, 40000, 80000, 120000]);
    // a 420 ms trace: 0-500 ms, not 0-600 ms
    expect(axisTicks(0, 420, 188, 54)).toEqual([0, 250, 500]);
    expect(axisTicks(-37, 120, 98, 24)).toEqual([-40, 0, 40, 80, 120]);
  });

  it('I2: on a short axis it shows fewer ticks rather than pad the domain', () => {
    // the 224x144 card: an 18 px bars axis fits two ticks, 0 and a nice max
    expect(axisTicks(0, 106500, 18, 24)).toEqual([0, 120000]);
    const three = axisTicks(0, 106500, 50, 24);
    expect(three.length).toBeLessThanOrEqual(3);
    expect(three[three.length - 1]).toBeGreaterThanOrEqual(106500);
    expect(three[three.length - 1]).toBeLessThanOrEqual(1.25 * 106500);
  });

  it('M15: never more than five ticks, however long the axis', () => {
    for (const [lo, hi] of [[0, 180], [0, 1], [-5, 5], [99.88, 99.98], [0, 1e9]]) {
      const t = axisTicks(lo, hi, 2000, 10);
      expect(t.length, `${lo}..${hi}`).toBeLessThanOrEqual(5);
      expect(t.length).toBeGreaterThanOrEqual(3);
      expect(t[0]).toBeLessThanOrEqual(lo);
      expect(t[t.length - 1]).toBeGreaterThanOrEqual(hi);
      expect(valid(t)).toBe(true);
    }
  });

  it('degenerate ranges still give finite, increasing ticks', () => {
    for (const [lo, hi] of [[5, 5], [0, 0], [-1e308, 1e308], [1.7e308, 1.7e308], [0, 1e21], [NaN, 1], [0, Number.MIN_VALUE]]) {
      for (const px of [18, 98, NaN]) {
        const t = axisTicks(lo, hi, px, 24);
        expect(t.length, `${lo}..${hi} @ ${px}`).toBeGreaterThan(0);
        expect(valid(t), `${lo}..${hi} @ ${px}`).toBe(true);
      }
    }
  });
});

describe('niceTicks', () => {
  it('steps by 1, 2 or 5 × 10^k and covers the range', () => {
    expect(niceTicks(0, 200, 4)).toEqual([0, 50, 100, 150, 200]);
    expect(niceTicks(0, 180, 4)).toEqual([0, 50, 100, 150, 200]);
    expect(niceTicks(-37, 120, 4)).toEqual([-50, 0, 50, 100, 150]);
    expect(niceTicks(99.88, 99.98, 4)).toEqual([99.88, 99.9, 99.92, 99.94, 99.96, 99.98]);
  });

  it('keeps decimal steps free of float noise', () => {
    expect(niceTicks(0, 0.3, 3)).toEqual([0, 0.1, 0.2, 0.3]);
  });

  it('opens a flat range', () => {
    expect(niceTicks(0, 0, 4)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
    const t = niceTicks(5, 5, 4);
    expect(t[0]).toBeLessThan(5);
    expect(t[t.length - 1]).toBeGreaterThan(5);
  });

  it('accepts min and max in either order and survives non-finite input', () => {
    expect(niceTicks(200, 0, 4)).toEqual([0, 50, 100, 150, 200]);
    expect(niceTicks(NaN, 1, 4)).toEqual([0, 1]);
  });

  describe('degenerate numbers never yield NaN or Infinity', () => {
    const clean = (ticks: number[]) => {
      expect(ticks.length).toBeGreaterThan(0);
      expect(ticks.every(Number.isFinite)).toBe(true);
      expect(ticks.some(v => Object.is(v, -0))).toBe(false);
    };

    it('flat series of any magnitude', () => {
      for (const v of [0, -0, 1, -1, 5, 1e-9, -1e-9, 1e21, -1e21, 1e308, -1e308, Number.MIN_VALUE]) {
        const t = niceTicks(v, v, 4);
        clean(t);
        expect(t.length).toBeLessThan(50);
      }
    });

    it('a range whose span overflows', () => {
      const t = niceTicks(-1e308, 1e308, 4);
      clean(t);
      expect(t.length).toBeLessThan(50);
      expect(t[0]).toBeLessThanOrEqual(-1e308);
      expect(t[t.length - 1]).toBeGreaterThanOrEqual(1e308);
    });

    it('huge values and a degenerate count', () => {
      clean(niceTicks(0, 1e21, 4));
      clean(niceTicks(0, 1e308, 4));
      clean(niceTicks(0, 10, 0));
      clean(niceTicks(0, 10, -3));
      clean(niceTicks(0, 10, NaN));
      expect(niceTicks(0, 10, 1e9).length).toBeLessThan(1000);
    });

    it('spans too small or too fine for the floats around them', () => {
      expect(niceTicks(1e16, 1e16 + 2, 4)).toEqual([1e16, 1e16 + 2]);
      expect(niceTicks(0, 4e-300, 4)).toEqual([0, 4e-300]);
      expect(niceTicks(0, Number.MIN_VALUE, 4)).toEqual([0, Number.MIN_VALUE]);
      expect(niceTicks(Number.MAX_VALUE, Number.MAX_VALUE, 4)).toEqual([Number.MAX_VALUE]);
      expect(niceTicks(-Number.MAX_VALUE, Number.MAX_VALUE, 4)).toEqual([-Number.MAX_VALUE, Number.MAX_VALUE]);
    });

    it('negative zero', () => {
      clean(niceTicks(-0, 1, 4));
      clean(niceTicks(-1, -0, 4));
      expect(niceTicks(-0, -0, 4).every(v => !Object.is(v, -0))).toBe(true);
    });

    it('non-finite input', () => {
      for (const [a, b] of [[NaN, NaN], [Infinity, 1], [-Infinity, Infinity], [0, NaN]]) {
        expect(niceTicks(a, b, 4)).toEqual([0, 1]);
      }
    });
  });
});

describe('formatValue', () => {
  it('builds one Intl.NumberFormat per precision, not one per call', () => {
    const Real = Intl.NumberFormat;
    const spy = vi.spyOn(Intl, 'NumberFormat').mockImplementation(function (...args: ConstructorParameters<typeof Intl.NumberFormat>) {
      return new Real(...args);
    } as unknown as typeof Intl.NumberFormat);
    try {
      for (let i = 0; i < 500; i++) {
        formatValue(i + 0.5, 'ms');
        formatValue(i, '', 3);
      }
      expect(spy.mock.calls.length).toBeLessThanOrEqual(2);
      expect(formatValue(1.5, '', 3)).toBe('1.500');
    } finally {
      spy.mockRestore();
    }
  });

  it('shows small numbers in full with grouping', () => {
    expect(formatValue(1284, '')).toBe('1,284');
    expect(formatValue(98, '')).toBe('98');
    expect(formatValue(0.125, '')).toBe('0.13');
    expect(formatValue(-42.5, '')).toBe('-42.5');
  });

  it('compacts from 10,000 up', () => {
    expect(formatValue(12900, '')).toBe('12.9K');
    expect(formatValue(12000, '')).toBe('12K');
    expect(formatValue(4_200_000, '')).toBe('4.2M');
    expect(formatValue(2_400_000_000, '')).toBe('2.4B');
    expect(formatValue(-15300, '')).toBe('-15.3K');
  });

  it('rolls over to the next suffix when rounding reaches 1000', () => {
    expect(formatValue(999_960, '')).toBe('1M');
  });

  it('honours precision below the compact range', () => {
    expect(formatValue(99.95, '%', 2)).toBe('99.95 %');
    expect(formatValue(3, 'ms', 1)).toBe('3.0 ms');
    expect(formatValue(1284.5, '', 0)).toBe('1,285');
  });

  it('appends the unit after a thin space and never prints -0', () => {
    expect(formatValue(180, 'ms')).toBe('180 ms');
    expect(formatValue(-0.001, '')).toBe('0');
    expect(formatValue(NaN, 'ms')).toBe('— ms');
  });

  describe('degenerate numbers never print NaN or Infinity', () => {
    const BAD = /NaN|Infinity/;

    it('1e21 and beyond go exponential instead of a long run of digits', () => {
      expect(formatValue(1e21, '')).toBe('1e+21');
      expect(formatValue(-2.5e21, 'ms')).toBe('-2.5e+21\u2009ms');
      expect(formatValue(1e15, '')).toBe('1e+15');
      expect(formatValue(999_000_000_000_000, '')).toBe('999T');
      expect(formatValue(1e308, '')).toBe('1e+308');
      expect(formatValue(Number.MAX_VALUE, '')).toBe('1.8e+308');
    });

    it('prints a dash for every non-finite value', () => {
      expect(formatValue(NaN, '')).toBe('—');
      expect(formatValue(Infinity, '')).toBe('—');
      expect(formatValue(-Infinity, 'ms')).toBe('— ms');
    });

    it('never prints -0 for zero in any form', () => {
      expect(formatValue(-0, '')).toBe('0');
      expect(formatValue(-0, 'ms')).toBe('0 ms');
      expect(formatValue(-0, '', 2)).toBe('0.00');
      expect(formatValue(-0.001, '%', 1)).toBe('0.0 %');
      expect(formatValue(-0.0001, '', 2)).toBe('0.00');
    });

    it('a flat series shows its value, not a range artefact', () => {
      expect(formatValue(5, '')).toBe('5');
      expect(formatValue(Number.MIN_VALUE, '')).toBe('0');
    });
  });
});

describe('formatX', () => {
  const at = (h: number, m: number, s = 0, day = 9) => Date.UTC(2026, 9, day, h, m, s);

  it('shows HH:MM within a day and MMM D across days, in UTC (as parseChart reads it)', () => {
    expect(formatX(at(10, 5), 'iso', 3_600_000)).toBe('10:05');
    expect(formatX(at(10, 5), 'epoch', 3 * 86_400_000)).toBe('Oct 9');
  });

  it('adds seconds when the span is under two minutes', () => {
    expect(formatX(at(10, 5, 7), 'iso', 60_000)).toBe('10:05:07');
  });

  it('reads clock values as ms since midnight, independent of the time zone', () => {
    expect(formatX((9 * 60 + 30) * 60_000, 'clock', 3_600_000)).toBe('09:30');
    expect(formatX((23 * 60 + 59) * 60_000, 'clock', 2 * 86_400_000)).toBe('23:59');
  });

  it('shows a dash for a value no date can hold', () => {
    expect(formatX(NaN, 'iso', 3_600_000)).toBe('—');
    expect(formatX(Infinity, 'epoch', 3_600_000)).toBe('—');
    expect(formatX(1e300, 'epoch', 3_600_000)).toBe('—');
  });
});

describe('text measurement (M6)', () => {
  it('measures with the canvas text measure the node labels use', () => {
    expect(textW('ap-south', 11)).toBe(textWidth('ap-south', 11, false));
    expect(textW('/checkout', 11, true)).toBe(textWidth('/checkout', 11, true));
  });

  it('cuts with an ellipsis only when the text does not fit', () => {
    expect(fitText('checkout', 100, 10)).toBe('checkout');
    const cut = fitText('checkout-service', 60, 10);
    expect(cut.endsWith('…')).toBe(true);
    expect(textW(cut, 10)).toBeLessThanOrEqual(60);
    expect(fitText('checkout', 5, 10)).toBe('');
    expect(fitText('checkout', NaN, 10)).toBe('');
    expect(fitText('checkout', -20, 10)).toBe('');
  });
});

describe('squarify', () => {
  const box = { x: 10, y: 20, w: 300, h: 150 };
  const values = [6, 6, 4, 3, 2, 2, 1];

  it('returns boxes in input order with areas proportional to the values', () => {
    const out = squarify(values, box);
    const total = values.reduce((s, v) => s + v, 0);
    expect(out).toHaveLength(values.length);
    out.forEach((b, i) => {
      expect(b.w * b.h).toBeCloseTo((values[i] / total) * box.w * box.h, 6);
    });
  });

  it('tiles the box without overlap or overflow', () => {
    const out = squarify(values, box);
    const area = out.reduce((s, b) => s + b.w * b.h, 0);
    expect(area).toBeCloseTo(box.w * box.h, 6);
    for (const b of out) {
      expect(b.x).toBeGreaterThanOrEqual(box.x - 1e-9);
      expect(b.y).toBeGreaterThanOrEqual(box.y - 1e-9);
      expect(b.x + b.w).toBeLessThanOrEqual(box.x + box.w + 1e-9);
      expect(b.y + b.h).toBeLessThanOrEqual(box.y + box.h + 1e-9);
    }
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i];
        const b = out[j];
        const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        expect(ox <= 1e-9 || oy <= 1e-9).toBe(true);
      }
    }
  });

  it('keeps cells close to square (worst aspect under 3 for this input)', () => {
    for (const b of squarify(values, box)) {
      expect(Math.max(b.w / b.h, b.h / b.w)).toBeLessThan(3);
    }
  });

  it('gives zero and negative values an empty box and survives an empty total', () => {
    const out = squarify([3, 0, -2, 1], box);
    expect(out[1]).toEqual({ x: 10, y: 20, w: 0, h: 0 });
    expect(out[2]).toEqual({ x: 10, y: 20, w: 0, h: 0 });
    expect(out[0].w * out[0].h).toBeCloseTo(0.75 * box.w * box.h, 6);
    expect(squarify([0, 0], box).every(b => b.w === 0 && b.h === 0)).toBe(true);
  });

  it('treats NaN and infinite values as empty instead of poisoning the layout', () => {
    const out = squarify([3, NaN, Infinity, 1], box);
    expect(out[1]).toEqual({ x: 10, y: 20, w: 0, h: 0 });
    expect(out[2]).toEqual({ x: 10, y: 20, w: 0, h: 0 });
    expect(out[0].w * out[0].h).toBeCloseTo(0.75 * box.w * box.h, 6);
    expect(JSON.stringify(out)).not.toMatch(/null|NaN|Infinity/);
    expect(squarify([1, 2], { x: 0, y: 0, w: NaN, h: 10 }).every(b => b.w === 0)).toBe(true);
  });
});

describe('timeTicks', () => {
  const day = (d: number, h = 0) => Date.UTC(2026, 9, d, h);
  const texts = (t: { text: string }[]) => t.map(x => x.text);

  it('takes the finest calendar step whose labels fit: weeks start on Monday', () => {
    const t = timeTicks(day(1), day(29), 320, 'iso', 10);
    expect(texts(t)).toEqual(['Oct 5', 'Oct 12', 'Oct 19', 'Oct 26']);
    expect(t.map(x => new Date(x.at).getUTCDay())).toEqual([1, 1, 1, 1]);
    // more room per day: one tick each midnight, and with more still, every 12 hours
    expect(texts(timeTicks(day(1), day(8), 420, 'iso', 10))).toEqual(['Oct 1', 'Oct 2', 'Oct 3', 'Oct 4', 'Oct 5', 'Oct 6', 'Oct 7', 'Oct 8']);
    expect(texts(timeTicks(day(1), day(3), 200, 'iso', 10))).toEqual(['Oct 1', '12:00', 'Oct 2', '12:00', 'Oct 3']);
  });

  it('labels hours as HH:MM and a midnight tick with its date', () => {
    const t = timeTicks(day(12, 18), day(13, 12), 400, 'iso', 10);
    expect(texts(t)).toEqual(['18:00', '21:00', 'Oct 13', '03:00', '06:00', '09:00', '12:00']);
  });

  it('a clock axis never shows a date', () => {
    const t = timeTicks(0, 24 * 3600000, 300, 'clock', 10);
    expect(texts(t)).toEqual(['00:00', '06:00', '12:00', '18:00', '00:00']);
  });

  it('steps by months on the 1st and by years on 1 January, with the year on each January', () => {
    const months = timeTicks(Date.UTC(2026, 9, 10), Date.UTC(2027, 2, 20), 320, 'iso', 10);
    expect(texts(months)).toEqual(['Nov', 'Dec', 'Jan 2027', 'Feb', 'Mar']);
    expect(months.every(x => new Date(x.at).getUTCDate() === 1)).toBe(true);
    const years = timeTicks(Date.UTC(2020, 5, 1), Date.UTC(2031, 0, 1), 320, 'iso', 10);
    expect(texts(years)).toEqual(['2022', '2024', '2026', '2028', '2030']);
  });

  it('keeps neighbouring labels apart and every tick inside the range', () => {
    for (const [lo, hi, px] of [[day(1), day(2), 200], [day(1), day(31), 180], [0, 90000, 400]] as const) {
      const t = timeTicks(lo, hi, px, 'iso', 10);
      expect(t.length).toBeGreaterThan(0);
      for (const [i, x] of t.entries()) {
        expect(x.at).toBeGreaterThanOrEqual(lo);
        expect(x.at).toBeLessThanOrEqual(hi);
        if (i > 0) {
          const gap = ((x.at - t[i - 1].at) / (hi - lo)) * px;
          expect(gap).toBeGreaterThanOrEqual((textW(x.text, 10) + textW(t[i - 1].text, 10)) / 2 + 12);
        }
      }
    }
  });

  it('ends on a range past the last date a Date can hold, with only ticks it can label', () => {
    // a safe integer, but past 8.64e15 ms: the month loop once spun on NaN here
    expect(timeTicks(9e15, 9.0001e15, 320, 'epoch', 10)).toEqual([]);
    const edge = timeTicks(8.6e15, 9e15, 320, 'epoch', 10);
    expect(edge.length).toBeGreaterThan(0);
    for (const t of edge) {
      expect(t.at).toBeLessThanOrEqual(8.64e15);
      expect(t.text).not.toMatch(/NaN|undefined/);
    }
  });

  it('falls back to one tick when no step fits, and to none for an empty range', () => {
    expect(timeTicks(day(1), day(29), 20, 'iso', 10)).toHaveLength(1);
    expect(timeTicks(day(1), day(1), 300, 'iso', 10)).toEqual([]);
    expect(timeTicks(NaN, day(1), 300, 'iso', 10)).toEqual([]);
  });
});
