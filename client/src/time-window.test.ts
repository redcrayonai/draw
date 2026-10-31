import { describe, expect, it } from 'vitest';
import { parseChart, type ChartData } from '../../module/src/chart-contracts';
import { WINDOW_MAX_MS, clipToWindow, formatWindow, zoomOut } from './time-window';

const series = (csv: string): ChartData => {
  const r = parseChart('timeseries', csv, '{}');
  if (!r.ok) throw new Error(r.error);
  return r.data;
};
const T = (hhmm: string) => Date.parse(`2026-10-31T${hhmm}:00Z`);
const CSV = 'time,p95\n2026-10-31T14:00:00Z,1\n2026-10-31T14:10:00Z,2\n2026-10-31T14:20:00Z,3';

describe('clipToWindow', () => {
  it('keeps the points inside the window, every series alike', () => {
    const d = clipToWindow(series(CSV), { startMs: T('14:05'), endMs: T('14:20') });
    expect(d).toMatchObject({ xs: [T('14:10'), T('14:20')], series: [{ name: 'p95', values: [2, 3] }] });
  });

  it('is null when no point falls inside, and the data itself without a window', () => {
    const data = series(CSV);
    expect(clipToWindow(data, { startMs: T('15:00'), endMs: T('16:00') })).toBeNull();
    expect(clipToWindow(data, null)).toBe(data);
    expect(clipToWindow(data, { startMs: T('13:00'), endMs: T('15:00') })).toBe(data);
  });

  it('leaves clock times and other chart types alone: they have no date to compare', () => {
    const clock = series('time,p95\n14:00,1\n14:10,2');
    expect(clipToWindow(clock, { startMs: T('15:00'), endMs: T('16:00') })).toBe(clock);
    const bars = parseChart('bars', 'service,calls\napi,3', '{}');
    if (!bars.ok) throw new Error(bars.error);
    expect(clipToWindow(bars.data, { startMs: 0, endMs: 1 })).toBe(bars.data);
  });
});

describe('zoomOut and formatWindow', () => {
  it('doubles around the centre, never before the epoch nor past the cap', () => {
    expect(zoomOut({ startMs: T('14:10'), endMs: T('14:20') })).toEqual({ startMs: T('14:05'), endMs: T('14:25') });
    expect(zoomOut({ startMs: 0, endMs: 1000 })).toEqual({ startMs: 0, endMs: 2000 });
    const wide = zoomOut({ startMs: 0, endMs: WINDOW_MAX_MS });
    expect(wide.endMs - wide.startMs).toBe(WINDOW_MAX_MS);
  });

  it('names the day once inside a day, and both days across midnight, in UTC like the chart axes', () => {
    expect(formatWindow({ startMs: T('14:30'), endMs: T('14:45') })).toBe('Oct 31 14:30–14:45 UTC');
    expect(formatWindow({ startMs: T('23:30'), endMs: T('23:30') + 3600_000 })).toBe('Oct 31 23:30 – Nov 1 00:30 UTC');
  });
});
