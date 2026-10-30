import type { XKind } from '../../../module/src/chart-contracts';
import { ellipsize } from '../node-layout';
import { textWidth } from '../node-text';

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Text width in px, from the canvas measure node labels use (cached; jsdom estimates). */
export function textW(s: string, size: number, mono = false): number {
  return textWidth(s, size, mono);
}

/** s, or s cut with an ellipsis to fit room px at size; '' when not even one character fits. */
export function fitText(s: string, room: number, size: number, mono = false): string {
  const cut = ellipsize(s, room, size, mono);
  return cut.cut && cut.text === '…' ? '' : cut.text;
}

/**
 * Round tick values (steps of 1, 2 or 5 × 10^k) whose range covers [min, max].
 * Always finite and strictly increasing, never -0. Non-finite input gives
 * [0, 1]; a range too extreme for nice steps (±1e308, a span below float
 * resolution) gives just its bounds.
 */
export function niceTicks(min: number, max: number, count: number): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return [0, 1];
  }
  // + 0 turns -0 into 0
  let lo = Math.min(min, max) + 0;
  let hi = Math.max(min, max) + 0;
  const bounds = lo === hi ? [lo] : [lo, hi];
  if (lo === hi) {
    const pad = Math.abs(hi) / 10 || 1;
    if (lo !== 0) {
      lo -= pad;
    }
    hi += pad;
  }
  // divide before subtracting: hi - lo overflows for ±1e308
  const n = Math.max(1, count) || 1;
  const raw = hi / n - lo / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const err = raw / mag;
  const step = mag * (err >= 7.07 ? 10 : err >= 3.16 ? 5 : err >= 1.41 ? 2 : 1);
  const decimals = Math.min(100, Math.max(0, -Math.floor(Math.log10(step))));
  const first = Math.floor(lo / step + 1e-9);
  const last = Math.ceil(hi / step - 1e-9);
  // also false for NaN (hi overflowed to Infinity): a runaway count never loops
  if (!(last - first <= 1000)) {
    return bounds;
  }
  const ticks: number[] = [];
  // first + k, not i++: i++ stalls once i passes 2^53
  for (let k = 0; k <= last - first; k++) {
    const v = Number(((first + k) * step).toFixed(decimals));
    ticks.push(v === 0 ? 0 : v);
  }
  return ticks.every((v, i) => Number.isFinite(v) && (i === 0 || v > ticks[i - 1])) ? ticks : bounds;
}

/** Steps for an axis of any length: the classic 1, 2, 5 first, then 2.5 and 4 (106K: 0-120K, not 0-150K). */
const STEPS = [1, 2, 5, 2.5, 4];
const CLASSIC = 3;
/** A two-tick axis is its two ends, so its one step may be any of these (106K: 0 and 120K). */
const SPANS = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8];
const MAX_TICKS = 5;
/** The domain may run at most this far past the data where a nice step allows. */
const HEADROOM = 1.25;

/**
 * Ticks for a value axis px long whose neighbours sit at least gap px apart:
 * 2 to 5 round values that cover [lo, hi] and hug it. Among the domains at
 * most 25 % wider than the data it takes the most ticks, then a classic step,
 * then the tightest; with none that tight, the tightest domain. Fewer ticks
 * win over a padded domain: a short axis shows 0 and a nice max. A flat or
 * non-finite range falls back to niceTicks.
 */
export function axisTicks(lo: number, hi: number, px: number, gap: number): number[] {
  const fit = Math.floor(px / gap) + 1;
  const most = fit >= 2 ? Math.min(MAX_TICKS, fit) : 2;
  const range = hi - lo;
  type Candidate = { ticks: number[]; span: number; classic: boolean };
  const found: Candidate[] = [];
  if (range > 0 && range < Infinity) {
    const k0 = Math.floor(Math.log10(range));
    for (let k = k0 - 1; k <= k0 + 1; k++) {
      for (const [ms, max] of [[STEPS, most], [SPANS, 2]] as const) {
        for (const m of ms) {
          const step = m * 10 ** k;
          const first = Math.floor(lo / step + 1e-9);
          const last = Math.ceil(hi / step - 1e-9);
          const n = last - first + 1;
          if (!(n >= 2 && n <= max)) {
            continue;
          }
          const decimals = Math.min(100, Math.max(0, (Number.isInteger(m) ? 0 : 1) - k));
          const ticks = Array.from({ length: n }, (_, i) => Number(((first + i) * step).toFixed(decimals)) + 0);
          if (ticks.every((v, i) => Number.isFinite(v) && (i === 0 || v > ticks[i - 1]))) {
            found.push({ ticks, span: ticks[n - 1] - ticks[0], classic: ms === STEPS && STEPS.indexOf(m) < CLASSIC });
          }
        }
      }
    }
  }
  const tight = found.filter(c => c.span <= HEADROOM * range * (1 + 1e-9));
  const best = tight.length > 0
    ? tight.sort((a, b) => b.ticks.length - a.ticks.length || Number(b.classic) - Number(a.classic) || a.span - b.span)[0]
    : found.sort((a, b) => a.span - b.span || b.ticks.length - a.ticks.length)[0];
  if (best !== undefined) {
    return best.ticks;
  }
  const t = niceTicks(lo, hi, most - 1);
  return t.length > most ? [t[0], t[t.length - 1]] : t;
}

const THIN = ' ';
const COMPACT: [number, string][] = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']];

/** One formatter per precision: building one costs ~10 µs, and a 500-row
 *  chart formats thousands of values per layout. */
const formats = new Map<number | undefined, Intl.NumberFormat>();
function numberFormat(precision: number | undefined): Intl.NumberFormat {
  let f = formats.get(precision);
  if (f === undefined) {
    f = new Intl.NumberFormat('en-US', { minimumFractionDigits: precision ?? 0, maximumFractionDigits: precision ?? 2 });
    formats.set(precision, f);
  }
  return f;
}

/**
 * Compact numbers: 1,284 · 12.9K · 4.2M. Below 10,000 the number is shown in
 * full with up to two decimals, or exactly `precision` decimals when given.
 * From 1000T up it is exponential (1e+21). A non-finite value shows as '—'.
 * A set unit follows after a thin space.
 */
export function formatValue(v: number, unit: string, precision?: number): string {
  let s: string;
  if (!Number.isFinite(v)) {
    s = '—';
  } else if (Math.abs(v) >= 1e4) {
    let i = COMPACT.findIndex(([d]) => Math.abs(v) >= d);
    let q = Math.round((v / COMPACT[i][0]) * 10) / 10;
    if (Math.abs(q) >= 1000 && i > 0) {
      i--;
      q = Math.round((v / COMPACT[i][0]) * 10) / 10;
    }
    s = Math.abs(q) >= 1000 ? v.toExponential(1).replace('.0', '') : `${q.toFixed(1).replace(/\.0$/, '')}${COMPACT[i][1]}`;
  } else {
    const digits = precision ?? 2;
    const shown = Math.abs(v) < 0.5 * 10 ** -digits ? 0 : v;
    s = numberFormat(precision).format(shown);
  }
  return unit ? `${s}${THIN}${unit}` : s;
}

const DAY = 86400000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * An x label, always in UTC. `clock` values are ms since midnight; `iso` and
 * `epoch` are epoch ms (parseChart reads offset-less ISO as UTC). Shown as
 * HH:MM within a day and MMM D across days. A span under two minutes adds seconds.
 * A value no date can hold shows as '—'.
 */
export function formatX(x: number, kind: XKind, span: number): string {
  const d = new Date(x);
  if (Number.isNaN(d.getTime())) {
    return '—';
  }
  if (kind !== 'clock' && span >= DAY) {
    return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  }
  const [h, m, s] = [d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()];
  return span < 120000 ? `${pad2(h)}:${pad2(m)}:${pad2(s)}` : `${pad2(h)}:${pad2(m)}`;
}

const SECOND = 1000;
const MINUTE = 60000;
const HOUR = 3600000;
/** Monday 1970-01-05, four days after the epoch: weeks start on Mondays. */
const MONDAY = 4 * DAY;
/** Calendar steps, finest first: a fixed length in ms, or a whole number of months. */
const TIME_STEPS: { ms: number; months: number }[] = [
  ...[1, 5, 15, 30].map(n => ({ ms: n * SECOND, months: 0 })),
  ...[1, 5, 15, 30].map(n => ({ ms: n * MINUTE, months: 0 })),
  ...[1, 3, 6, 12].map(n => ({ ms: n * HOUR, months: 0 })),
  ...[1, 2, 7].map(n => ({ ms: n * DAY, months: 0 })),
  ...[1, 3, 6, 12, 24, 60, 120].map(n => ({ ms: 0, months: n })),
];
/** More ticks than this in the range means the step is far too fine to try. */
const MAX_TIME_TICKS = 400;
/** The instants a Date can hold: past them a month count is NaN and no label can be written. */
const MAX_DATE_MS = 8.64e15;

function stepTicks(from: number, to: number, step: { ms: number; months: number }): number[] | null {
  const out: number[] = [];
  const lo = Math.max(from, -MAX_DATE_MS);
  const hi = Math.min(to, MAX_DATE_MS);
  if (!(hi >= lo)) {
    return null;
  }
  if (step.months === 0) {
    if ((hi - lo) / step.ms > MAX_TIME_TICKS) {
      return null;
    }
    const base = step.ms === 7 * DAY ? MONDAY : 0;
    for (let t = Math.ceil((lo - base) / step.ms) * step.ms + base; t <= hi; t += step.ms) {
      out.push(t);
    }
    return out;
  }
  if ((hi - lo) / (step.months * 28 * DAY) > MAX_TIME_TICKS) {
    return null;
  }
  // Months counted from year 0, so a 3-month step lands on Jan, Apr, Jul and Oct.
  const d = new Date(lo);
  let m = d.getUTCFullYear() * 12 + d.getUTCMonth();
  m = Math.ceil(m / step.months) * step.months;
  for (;;) {
    const t = new Date(0).setUTCFullYear(Math.floor(m / 12), m % 12, 1);
    // NaN compares false both ways: without this, a month past the last Date never ends the loop.
    if (!(t <= hi)) {
      return out;
    }
    if (t >= lo) {
      out.push(t);
    }
    m += step.months;
  }
}

function timeLabel(t: number, step: { ms: number; months: number }, kind: XKind): string {
  const d = new Date(t);
  const date = `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  if (step.months >= 12) {
    return String(d.getUTCFullYear());
  }
  if (step.months > 0) {
    return d.getUTCMonth() === 0 ? `Jan ${d.getUTCFullYear()}` : MONTHS[d.getUTCMonth()];
  }
  if (step.ms >= DAY || (kind !== 'clock' && ((t % DAY) + DAY) % DAY === 0)) {
    return date;
  }
  const clock = `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
  return step.ms < MINUTE ? `${clock}:${pad2(d.getUTCSeconds())}` : clock;
}

/**
 * Ticks for a time axis px long over [lo, hi], always in UTC: the finest
 * calendar step whose labels, centred on their ticks, keep `air` px apart.
 * Steps run from 1 s to 10 years. Seconds, minutes and hours sit on the
 * clock, days at midnight, weeks on Mondays, months on the 1st, and years on
 * 1 January. Labels are HH:MM (HH:MM:SS below a minute), MMM D from a day,
 * MMM from a month (each January adds its year), and the year from a year.
 * On an hour step a tick at midnight shows its date, except on a clock axis.
 * When no step fits, the coarsest step that has a tick in range is used;
 * [] when none has one.
 */
export function timeTicks(lo: number, hi: number, px: number, kind: XKind, size: number, air = 12): { at: number; text: string }[] {
  if (!(hi > lo) || !Number.isFinite(lo) || !Number.isFinite(hi)) {
    return [];
  }
  let fallback: { at: number; text: string }[] = [];
  for (const step of TIME_STEPS) {
    const ticks = stepTicks(lo, hi, step);
    if (ticks === null || ticks.length === 0) {
      continue;
    }
    const items = ticks.map(t => ({ at: t, text: timeLabel(t, step, kind) }));
    const pos = (t: number) => ((t - lo) / (hi - lo)) * px;
    const fits = items.every((it, i) => i === 0
      || pos(it.at) - pos(items[i - 1].at) >= (textW(it.text, size) + textW(items[i - 1].text, size)) / 2 + air);
    if (fits) {
      return items;
    }
    fallback = items.slice(0, 1);
  }
  return fallback;
}

/**
 * Squarified treemap layout (Bruls, Huizing and van Wijk). Each box's area is
 * proportional to its value; boxes come back in input order. Values ≤ 0 (and
 * NaN or infinite ones) get an empty box at the corner.
 */
export function squarify(values: number[], box: Box): Box[] {
  const out: Box[] = values.map(() => ({ x: box.x, y: box.y, w: 0, h: 0 }));
  const pos = values.map(v => (Number.isFinite(v) && v > 0 ? v : 0));
  const total = pos.reduce((s, v) => s + v, 0);
  if (!(total > 0 && total < Infinity) || !(box.w > 0) || !(box.h > 0)) {
    return out;
  }
  const k = (box.w * box.h) / total;
  const items = pos
    .map((v, i) => ({ i, a: v * k }))
    .filter(it => it.a > 0)
    .sort((p, q) => q.a - p.a || p.i - q.i);
  let { x, y, w, h } = box;
  const worst = (row: { a: number }[], side: number) => {
    const sum = row.reduce((s, it) => s + it.a, 0);
    const big = Math.max(...row.map(it => it.a));
    const small = Math.min(...row.map(it => it.a));
    return Math.max((side * side * big) / (sum * sum), (sum * sum) / (side * side * small));
  };
  const place = (row: { i: number; a: number }[], last: boolean) => {
    const sum = row.reduce((s, it) => s + it.a, 0);
    if (w >= h) {
      const cw = last ? w : sum / h;
      let cy = y;
      for (const it of row) {
        const ch = it.a / cw;
        out[it.i] = { x, y: cy, w: cw, h: ch };
        cy += ch;
      }
      x += cw;
      w -= cw;
    } else {
      const rh = last ? h : sum / w;
      let cx = x;
      for (const it of row) {
        const cw = it.a / rh;
        out[it.i] = { x: cx, y, w: cw, h: rh };
        cx += cw;
      }
      y += rh;
      h -= rh;
    }
  };
  let row: { i: number; a: number }[] = [];
  for (let n = 0; n < items.length; ) {
    const side = Math.min(w, h);
    if (row.length === 0 || worst([...row, items[n]], side) <= worst(row, side)) {
      row.push(items[n]);
      n++;
    } else {
      place(row, false);
      row = [];
    }
  }
  place(row, true);
  return out;
}
