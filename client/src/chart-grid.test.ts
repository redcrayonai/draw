import { describe, it, expect } from 'vitest';
import { parseChart, parseCsv } from '../../module/src/chart-contracts';
import { csvToGrid, gridToCsv } from './chart-grid';

describe('csvToGrid', () => {
  it('reads a comma CSV, header row first', () => {
    expect(csvToGrid('time,p50,p99\n10:00,12,40\n10:05,13,42')).toEqual([
      ['time', 'p50', 'p99'],
      ['10:00', '12', '40'],
      ['10:05', '13', '42'],
    ]);
  });

  it('reads a tab-separated paste the same way', () => {
    expect(csvToGrid('time\tp99\n10:00\t40')).toEqual([['time', 'p99'], ['10:00', '40']]);
  });

  it('unquotes RFC 4180 fields: commas, doubled quotes and newlines', () => {
    expect(csvToGrid('name,note\n"x, y","say ""hi"""\n"two\nlines",z')).toEqual([
      ['name', 'note'],
      ['x, y', 'say "hi"'],
      ['two\nlines', 'z'],
    ]);
  });

  it('returns no rows when the text does not parse', () => {
    const bad = ['', '"unclosed', 'a,b\n"x'].find(s => !parseCsv(s).ok);
    expect(bad).toBeDefined();
    expect(csvToGrid(bad!)).toEqual([]);
  });
});

describe('gridToCsv', () => {
  it('writes commas and \\n line ends, with no trailing newline', () => {
    expect(gridToCsv([['time', 'p99'], ['10:00', '40']])).toBe('time,p99\n10:00,40');
  });

  it('quotes only the cells that need it', () => {
    expect(gridToCsv([['name', 'note'], ['x, y', 'say "hi"'], ['two\nlines', 'z'], [' padded', 'tab\there']]))
      .toBe('name,note\n"x, y","say ""hi"""\n"two\nlines",z\n" padded","tab\there"');
  });

  it('round-trips awkward cells through the parser', () => {
    const grid = [['label', 'value'], ['a, b', '1'], ['"quoted"', '2'], ['line\nbreak', '3']];
    expect(csvToGrid(gridToCsv(grid))).toEqual(grid);
  });

  it('turns a tab paste into comma CSV', () => {
    expect(gridToCsv(csvToGrid('time\tp99\n10:00\t40'))).toBe('time,p99\n10:00,40');
  });

  // Review Focus 1: a spreadsheet paste (UTF-8 BOM, CRLF line ends) through the grid stays valid.
  it('a BOM + CRLF paste comes back as clean comma CSV that the parser accepts', () => {
    const pasted = '﻿time\tp50\tp99\r\n10:00\t12\t40\r\n10:05\t13\t42\r\n';
    const csv = gridToCsv(csvToGrid(pasted));
    expect(csv).toBe('time,p50,p99\n10:00,12,40\n10:05,13,42');
    const r = parseChart('timeseries', csv, '{}');
    expect(r.ok).toBe(true);
    expect(r.ok ? r.summary.series : []).toEqual(['p50', 'p99']);
  });
});
