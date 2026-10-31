import { describe, it, expect, vi, beforeEach } from 'vitest';

const parseChart = vi.fn((type: string, csv: string, options: string) => ({ ok: false as const, error: `${type}|${options}|${csv}` }));
vi.mock('../../../module/src/chart-contracts', () => ({ parseChart }));

const { parsedChart } = await import('./index');

describe('parsedChart', () => {
  beforeEach(() => {
    parseChart.mockClear();
  });

  it('parses a row once and returns the same result for the same type, options and csv', () => {
    const row = { type: 'pie', csv: 'a,b\nx,1', options: '{}' };
    const first = parsedChart(row);
    const again = parsedChart({ ...row });
    expect(parseChart).toHaveBeenCalledTimes(1);
    expect(parseChart).toHaveBeenCalledWith('pie', 'a,b\nx,1', '{}');
    expect(again).toBe(first);
  });

  it('keys on type, options and csv separately', () => {
    parsedChart({ type: 'bars', csv: 'k,v\na,1', options: '{}' });
    parsedChart({ type: 'toplist', csv: 'k,v\na,1', options: '{}' });
    parsedChart({ type: 'bars', csv: 'k,v\na,1', options: '{"unit":"ms"}' });
    parsedChart({ type: 'bars', csv: 'k,v\na,2', options: '{}' });
    expect(parseChart).toHaveBeenCalledTimes(4);
  });

  it('evicts the least recently used entry past 64', () => {
    const row = (i: number) => ({ type: 'stat', csv: `value\n${i}`, options: '{}' });
    for (let i = 0; i < 64; i++) parsedChart(row(i));
    parsedChart(row(0)); // touch 0: now 1 is the oldest
    parseChart.mockClear();
    parsedChart(row(64)); // evicts 1
    parsedChart(row(0));
    expect(parseChart).toHaveBeenCalledTimes(1);
    parsedChart(row(1));
    expect(parseChart).toHaveBeenCalledTimes(2);
  });
});
