import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHART_TYPES, isChartType, MAX_CSV_BYTES, MAX_LIBRARY_PAYLOAD_BYTES, MAX_SOURCE_CHARS, MAX_SERIES, CHART_MIN_W, CHART_MIN_H,
  SAMPLE_SOURCE, MAX_OPTIONS_BYTES, MAX_OPTION_CHARS, CHART_KIND_RULE, AGENT_SOURCE_RULE, SAMPLE_RESERVED, SAMPLE_NEEDS_SOURCE,
  ARCHITECTURE_CHART_RULE, ChartInputError, utf8Bytes, parseCsv, parseNumberCell, parseTimeColumn, parseOptions,
  CHART_CONTRACTS, parseChart,
} from './chart-contracts.ts';

const fails = (fn, message) => assert.throws(fn, err => err instanceof ChartInputError && err.message === message);
const csvError = (text, message) => assert.deepEqual(parseCsv(text), { ok: false, error: message });

test('C1 constants and shared sentences are exact', () => {
  assert.deepEqual(CHART_TYPES, ['timeseries', 'bars', 'toplist', 'pie', 'treemap', 'table', 'stat', 'waterfall', 'scatter', 'schedule', 'kanban']);
  assert.equal(isChartType('pie'), true);
  assert.equal(isChartType('heatmap'), false);
  assert.equal(isChartType('Pie'), false);
  assert.deepEqual(
    [MAX_CSV_BYTES, MAX_LIBRARY_PAYLOAD_BYTES, MAX_SOURCE_CHARS, MAX_SERIES, CHART_MIN_W, CHART_MIN_H, SAMPLE_SOURCE, MAX_OPTIONS_BYTES, MAX_OPTION_CHARS],
    [32768, 262144, 200, 5, 224, 144, 'sample', 4096, 40],
  );
  assert.equal(CHART_KIND_RULE, 'use create_chart for charts');
  assert.equal(AGENT_SOURCE_RULE, "agents must say where chart data came from: pass source (for example 'agent: npm run bench @ <sha>')");
  assert.equal(SAMPLE_RESERVED, "source 'sample' is reserved for library examples; say where the data came from");
  assert.equal(SAMPLE_NEEDS_SOURCE, 'this chart holds sample data; pass source to say where the new data came from');
  assert.equal(ARCHITECTURE_CHART_RULE, 'charts are not supported on architecture boards yet');
});

test('C1 utf8Bytes counts UTF-8 bytes, not UTF-16 units', () => {
  assert.equal(utf8Bytes(''), 0);
  assert.equal(utf8Bytes('x,é\n1,2'), 8);
  assert.equal(utf8Bytes('→'), 3);
  assert.equal(utf8Bytes('😀'), 4);
});

test('C1 parseCsv reads commas, quotes, CRLF and a BOM', () => {
  assert.deepEqual(parseCsv('a,b\n1,2\n3,4'), { ok: true, header: ['a', 'b'], rows: [['1', '2'], ['3', '4']], delimiter: ',' });
  assert.deepEqual(parseCsv('a,b\r\n1,2\r\n'), { ok: true, header: ['a', 'b'], rows: [['1', '2']], delimiter: ',' });
  assert.deepEqual(parseCsv('a,b\r1,2\r'), { ok: true, header: ['a', 'b'], rows: [['1', '2']], delimiter: ',' });
  assert.deepEqual(parseCsv('\ufeffa,b\n1,2'), { ok: true, header: ['a', 'b'], rows: [['1', '2']], delimiter: ',' });
  assert.deepEqual(
    parseCsv('name,note\n"Smith, J","said ""hi""\nthen left"\n"",x'),
    { ok: true, header: ['name', 'note'], rows: [['Smith, J', 'said "hi"\nthen left'], ['', 'x']], delimiter: ',' },
  );
  assert.deepEqual(parseCsv('a,b\nx"y,2'), { ok: true, header: ['a', 'b'], rows: [['x"y', '2']], delimiter: ',' });
  assert.deepEqual(parseCsv(' a , b \n 1 , 2 '), { ok: true, header: [' a ', ' b '], rows: [[' 1 ', ' 2 ']], delimiter: ',' });
  assert.deepEqual(parseCsv('a,b'), { ok: true, header: ['a', 'b'], rows: [], delimiter: ',' });
  assert.deepEqual(parseCsv('a,"b\r\nc"\n1,2'), { ok: true, header: ['a', 'b\r\nc'], rows: [['1', '2']], delimiter: ',' });
});

test('C1 parseCsv picks a tab when the first line has one, else a comma', () => {
  assert.deepEqual(parseCsv('time\tp99\n10:00\t1,284\n'), { ok: true, header: ['time', 'p99'], rows: [['10:00', '1,284']], delimiter: '\t' });
  assert.deepEqual(parseCsv('a,b\n1\t2,3'), { ok: true, header: ['a', 'b'], rows: [['1\t2', '3']], delimiter: ',' });
  assert.deepEqual(parseCsv('a\tb\r\n"x\ty"\t2'), { ok: true, header: ['a', 'b'], rows: [['x\ty', '2']], delimiter: '\t' });
});

test('C1 parseCsv ignores blank trailing lines and rejects blank lines in the middle', () => {
  assert.deepEqual(parseCsv('a,b\n1,2\n\n\r\n  \n,\n'), { ok: true, header: ['a', 'b'], rows: [['1', '2']], delimiter: ',' });
  assert.deepEqual(parseCsv('a\tb\n1\t2\n\t\n'), { ok: true, header: ['a', 'b'], rows: [['1', '2']], delimiter: '\t' });
  csvError('a,b\n1,2\n\n3,4', 'row 3 is blank; delete it or fill it in');
  csvError('\na,b\n1,2', 'row 1 is blank; delete it or fill it in');
  csvError('value\n1\n""\n2', 'row 3 is blank; delete it or fill it in');
});

test('C1 parseCsv rejects empty input, ragged rows and broken quotes', () => {
  for (const text of ['', '\n', '\r\n\r\n', '   ', ',,\n', '\ufeff']) csvError(text, 'the CSV is empty; put the column names on the first line');
  csvError('a,b,c\n1,2\n', 'row 2 has 2 cells; the header has 3');
  csvError('a,b\n1,2\n3\n', 'row 3 has 1 cell; the header has 2');
  csvError('a,b\n1,2,3\n', 'row 2 has 3 cells; the header has 2');
  csvError('a,b\n"1,2\n', 'row 2 has a quote that is never closed');
  csvError('a,b\n"1"x,2\n', 'row 2 has text after a closing quote; put the whole field inside the quotes');
  csvError('a,b\n"1" ,2\n', 'row 2 has text after a closing quote; put the whole field inside the quotes');
});

test('C1 parseCsv holds the 32 KB cap in UTF-8 bytes', () => {
  const atCap = 'v\n' + 'x'.repeat(MAX_CSV_BYTES - 2);
  assert.equal(utf8Bytes(atCap), 32768);
  assert.equal(parseCsv(atCap).ok, true);
  csvError(atCap + 'x', 'the CSV is 32769 bytes; the limit is 32768 bytes (32 KB)');
  const accents = 'v\n' + 'é'.repeat(16384);
  assert.equal(accents.length, 16386);
  csvError(accents, 'the CSV is 32770 bytes; the limit is 32768 bytes (32 KB)');
});

test('C1 parseNumberCell accepts plain decimals with sign and exponent', () => {
  assert.equal(parseNumberCell('12', 2, 'p99'), 12);
  assert.equal(parseNumberCell(' -3.5e2 ', 2, 'p99'), -350);
  assert.equal(parseNumberCell('+.5', 2, 'p99'), 0.5);
  assert.equal(parseNumberCell('5.', 2, 'p99'), 5);
  assert.equal(parseNumberCell('1E-3', 2, 'p99'), 0.001);
  assert.equal(parseNumberCell('0', 2, 'p99'), 0);
});

test('C1 parseNumberCell rejects units, separators and words with a helpful sentence', () => {
  fails(() => parseNumberCell('12ms', 4, 'p99'), "row 4, column 'p99': '12ms' is not a number; put the unit in the unit option");
  fails(() => parseNumberCell('45%', 3, 'cpu'), "row 3, column 'cpu': '45%' is not a number; put the unit in the unit option");
  fails(() => parseNumberCell('$1.6k', 3, 'cost'), "row 3, column 'cost': '$1.6k' is not a number; put the unit in the unit option");
  fails(() => parseNumberCell('1,284', 5, 'requests'), "row 5, column 'requests': '1,284' has a thousands separator; write 1284");
  fails(() => parseNumberCell('12 400 000.5', 5, 'requests'), "row 5, column 'requests': '12 400 000.5' has a thousands separator; write 12400000.5");
  fails(() => parseNumberCell('n/a', 2, 'p99'), "row 2, column 'p99': 'n/a' is not a number");
  fails(() => parseNumberCell('10:00', 2, 'p99'), "row 2, column 'p99': '10:00' is not a number");
  fails(() => parseNumberCell('NaN', 2, 'p99'), "row 2, column 'p99': 'NaN' is not a number");
  fails(() => parseNumberCell('0x10', 2, 'p99'), "row 2, column 'p99': '0x10' is not a number");
  fails(() => parseNumberCell('1e999', 2, 'p99'), "row 2, column 'p99': '1e999' is too large");
  fails(() => parseNumberCell('  ', 6, 'p99'), "row 6, column 'p99' is empty; every row needs a number");
});

test('U1 a number cell is read in linear time, and the accepted set is the old one', () => {
  // the old, backtracking pattern as the reference: one digit run could split two ways
  const OLD = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
  const accepts = s => { try { parseNumberCell(s, 2, 'n'); return true; } catch { return false; } };
  for (const s of ['0', '12', '007', '5.', '.5', '+.5', '-3.5e2', '1E-3', '1e+3', '1.e5', '00.00', '.', '+', '-', 'e5', '1e', '1.2.3', '..5', '5..', '1e5.5', '+-1', '1 2', '.e1', '1_000', '−7']) {
    assert.equal(accepts(s), OLD.test(s.replace(/^−/, '-')), s);
  }
  // a 32 KB CSV holds one 32,700-digit cell; the old pattern took about 0.6 s to refuse it
  const cell = `${'1'.repeat(32700)}x`;
  // Keep the 50 ms work budget without counting time a shared CI runner deschedules this process.
  const start = process.cpuUsage();
  assert.equal(accepts(cell), false);
  assert.equal(parseChart('table', `a\n${cell}`, '{}').ok, true);
  const elapsed = process.cpuUsage(start);
  const cpuMs = (elapsed.user + elapsed.system) / 1000;
  assert.ok(cpuMs < 50, `used ${Math.round(cpuMs)} ms of CPU`);
});

test('C1 parseTimeColumn reads ISO 8601 as UTC unless an offset is given', () => {
  const t = Date.UTC(2026, 9, 9, 10, 0, 0);
  assert.deepEqual(parseTimeColumn(['2026-10-09T10:00:00Z', '2026-10-09T10:05:00Z'], 'time', 2), { kind: 'iso', xs: [t, t + 300000] });
  assert.deepEqual(parseTimeColumn(['2026-10-09T10:00', '2026-10-09 10:00:01.5'], 'time', 2), { kind: 'iso', xs: [t, t + 1500] });
  assert.deepEqual(parseTimeColumn(['2026-10-09T12:00:00+02:00', '2026-10-09T07:30:00-03:30'], 'time', 2), { kind: 'iso', xs: [t, t + 3600000] });
  assert.deepEqual(parseTimeColumn(['2026-10-08', '2026-10-09'], 'day', 2), { kind: 'iso', xs: [Date.UTC(2026, 9, 8), Date.UTC(2026, 9, 9)] });
  assert.deepEqual(parseTimeColumn(['2024-02-29T00:00:00.123Z'], 'time', 2), { kind: 'iso', xs: [Date.UTC(2024, 1, 29, 0, 0, 0, 123)] });
});

test('C1 an epoch past the last date a Date can hold is refused, for the time series too', () => {
  fails(() => parseTimeColumn(['1791540000000', '8640000000000001'], 'ts', 2), "row 3, column 'ts': '8640000000000001' is past the last date a chart can show; epoch milliseconds go up to 8640000000000000");
  fails(() => parseTimeColumn(['99999999999999999999'], 'ts', 2), "row 2, column 'ts': '99999999999999999999' is past the last date a chart can show; epoch milliseconds go up to 8640000000000000");
  assert.deepEqual(parseTimeColumn(['8640000000000000'], 'ts', 2), { kind: 'epoch', xs: [8.64e15] });
});

test('C1 parseTimeColumn reads clock times and epoch milliseconds', () => {
  assert.deepEqual(parseTimeColumn(['9:00', '10:05', '23:59:59'], 'time', 2), { kind: 'clock', xs: [32400000, 36300000, 86399000] });
  assert.deepEqual(parseTimeColumn(['1791540000000', '1791540060000'], 'ts', 2), { kind: 'epoch', xs: [1791540000000, 1791540060000] });
});

test('C1 parseTimeColumn rejects invalid times, mixed formats and unsorted rows', () => {
  const help = 'use ISO 8601 (2026-10-09T10:00:00Z), HH:MM[:SS], or epoch milliseconds';
  for (const bad of ['yesterday', '2026-02-30T00:00:00Z', '2026-13-01', '2026-10-09T24:00:00Z', '2026-10-09T10:00:60Z', '24:00', '10:60', '2026-10-09T10:00+25:00', '2026/10/09', '10am']) {
    fails(() => parseTimeColumn([bad], 'time', 2), `row 2, column 'time': '${bad}' is not a time; ${help}`);
  }
  fails(() => parseTimeColumn(['10:00', '2026-10-09T10:05:00Z'], 'time', 2), "row 3, column 'time': '2026-10-09T10:05:00Z' is not HH:MM[:SS] like row 2; use one time format in the column");
  fails(() => parseTimeColumn(['2026-10-09', '1791540000000'], 'time', 2), "row 3, column 'time': '1791540000000' is not ISO 8601 like row 2; use one time format in the column");
  fails(() => parseTimeColumn(['1791540000000', '10:05'], 'time', 2), "row 3, column 'time': '10:05' is not epoch milliseconds like row 2; use one time format in the column");
  fails(() => parseTimeColumn(['10:00', '10:05', '10:05'], 'time', 2), "row 4, column 'time': '10:05' is not later than row 3; sort the rows by time, oldest first");
  fails(() => parseTimeColumn(['10:05', '10:00'], 'time', 2), "row 3, column 'time': '10:00' is not later than row 2; sort the rows by time, oldest first");
  fails(() => parseTimeColumn(['10:00', ''], 'time', 2), "row 3, column 'time' is empty; every row needs a time");
});

const SPECS = [
  { name: 'style', kind: 'enum', values: ['line', 'area', 'stacked'], default: 'line', note: '' },
  { name: 'unit', kind: 'string', default: '', note: '' },
  { name: 'donut', kind: 'boolean', default: true, note: '' },
  { name: 'limit', kind: 'integer', min: 1, max: 25, default: 10, note: '' },
  { name: 'thresholds', kind: 'thresholds', default: [], note: '' },
];
const optionsError = (json, message) => fails(() => parseOptions('demo', SPECS, json), message);

test('C1 parseOptions fills defaults and keeps given values', () => {
  const defaults = { style: 'line', unit: '', donut: true, limit: 10, thresholds: [] };
  assert.deepEqual(parseOptions('demo', SPECS, ''), defaults);
  assert.deepEqual(parseOptions('demo', SPECS, '  \n '), defaults);
  assert.deepEqual(parseOptions('demo', SPECS, '{}'), defaults);
  assert.notEqual(parseOptions('demo', SPECS, '{}').thresholds, SPECS[4].default);
  assert.deepEqual(
    parseOptions('demo', SPECS, '{"style":"area","unit":"ms","donut":false,"limit":25,"thresholds":[{"column":" cpu ","warn":80,"crit":90}]}'),
    { style: 'area', unit: 'ms', donut: false, limit: 25, thresholds: [{ column: 'cpu', warn: 80, crit: 90, direction: 'above' }] },
  );
  assert.deepEqual(parseOptions('waterfall', [], ''), {});
});

test('C1 parseOptions rejects bad JSON, unknown keys and wrong values', () => {
  for (const json of ['{', '[]', 'null', '7', '"x"', 'true']) optionsError(json, 'options must be a JSON object, for example {"unit":"ms"}');
  optionsError('{"colour":"red"}', "demo has no option 'colour'; options are style, unit, donut, limit, thresholds");
  fails(() => parseOptions('waterfall', [], '{"unit":"ms"}'), 'waterfall has no options; pass {}');
  optionsError('{"style":"bar"}', `option 'style' must be one of line, area, stacked; got "bar"`);
  optionsError('{"style":1}', "option 'style' must be one of line, area, stacked; got 1");
  optionsError('{"unit":5}', "option 'unit' must be a string; got 5");
  optionsError(`{"unit":"${'u'.repeat(41)}"}`, "option 'unit' is 41 characters; the limit is 40");
  optionsError('{"donut":"yes"}', `option 'donut' must be true or false; got "yes"`);
  optionsError('{"limit":0}', "option 'limit' must be a whole number from 1 to 25; got 0");
  optionsError('{"limit":26}', "option 'limit' must be a whole number from 1 to 25; got 26");
  optionsError('{"limit":2.5}', "option 'limit' must be a whole number from 1 to 25; got 2.5");
  optionsError('{"limit":"5"}', `option 'limit' must be a whole number from 1 to 25; got "5"`);
  optionsError('{"limit":null}', "option 'limit' must be a whole number from 1 to 25; got null");
  optionsError(`{"unit":"${'u'.repeat(4100)}"}`, 'options are 4111 bytes; the limit is 4096 bytes');
});

test('C1 parseOptions checks the thresholds shape', () => {
  optionsError('{"thresholds":{}}', "option 'thresholds' must be a list of {column, warn, crit, direction}; got {}");
  optionsError(`{"thresholds":${JSON.stringify(Array.from({ length: 9 }, (_, i) => ({ column: `c${i}`, warn: 1, crit: 2 })))}}`, "option 'thresholds' allows at most 8 entries; got 9");
  optionsError('{"thresholds":[5]}', 'threshold 1 must be an object with column, warn, crit and direction');
  optionsError('{"thresholds":[{"column":"cpu","warn":1,"crit":2,"color":"red"}]}', "threshold 1 has no field 'color'; fields are column, warn, crit, direction");
  optionsError('{"thresholds":[{"warn":1,"crit":2}]}', 'threshold 1: column must be a column name; got undefined');
  optionsError('{"thresholds":[{"column":" ","warn":1,"crit":2}]}', 'threshold 1: column must be a column name; got " "');
  optionsError('{"thresholds":[{"column":"cpu","warn":"90","crit":95}]}', 'threshold 1: warn must be a number; got "90"');
  optionsError('{"thresholds":[{"column":"cpu","warn":90}]}', 'threshold 1: crit must be a number; got undefined');
  optionsError('{"thresholds":[{"column":"cpu","warn":1,"crit":2,"direction":"up"}]}', 'threshold 1: direction must be above or below; got "up"');
  optionsError('{"thresholds":[{"column":"cpu","warn":95,"crit":90}]}', 'threshold 1: with direction above, warn (95) must not be greater than crit (90)');
  optionsError('{"thresholds":[{"column":"a","warn":1,"crit":2},{"column":"free","warn":10,"crit":20,"direction":"below"}]}', 'threshold 2: with direction below, warn (10) must not be less than crit (20)');
  assert.deepEqual(
    parseOptions('demo', SPECS, '{"thresholds":[{"column":"free","warn":20,"crit":10,"direction":"below"},{"column":"cpu","warn":90,"crit":90}]}').thresholds,
    [{ column: 'free', warn: 20, crit: 10, direction: 'below' }, { column: 'cpu', warn: 90, crit: 90, direction: 'above' }],
  );
});

test('C1 spreadsheet paste quirks: a trailing tab on every row parses evenly, an uneven one names the row', () => {
  assert.deepEqual(parseCsv('time\tp99\t\r\n10:00\t12\t\r\n10:05\t14\t\r\n'), { ok: true, header: ['time', 'p99', ''], rows: [['10:00', '12', ''], ['10:05', '14', '']], delimiter: '\t' });
  csvError('time\tp99\n10:00\t12\t\n', 'row 2 has 3 cells; the header has 2');
});

test('C1 spreadsheet paste quirks: a decimal comma is refused with the row and column, a U+2212 minus is read as a minus', () => {
  fails(() => parseNumberCell('12,5', 3, 'p99'), "row 3, column 'p99': '12,5' is not a number");
  assert.equal(parseNumberCell('\u22125', 4, 'delta'), -5);
  assert.equal(parseNumberCell('-5', 4, 'delta'), -5);
});

const parseOk = (type, csv, options = '{}') => {
  const r = parseChart(type, csv, options);
  assert.equal(r.ok, true, r.ok ? '' : r.error);
  return r;
};
const parseFails = (type, csv, options, message) => assert.deepEqual(parseChart(type, csv, options), { ok: false, error: message });
const rowsOf = (header, cells, n) => [header, ...Array.from({ length: n }, (_, i) => cells(i))].join('\n');

test('C2 every contract is complete and its example parses with default options', () => {
  assert.deepEqual(Object.keys(CHART_CONTRACTS), CHART_TYPES);
  const titles = {};
  for (const type of CHART_TYPES) {
    const c = CHART_CONTRACTS[type];
    assert.equal(c.type, type);
    titles[type] = c.title;
    for (const text of [c.purpose, c.renders]) assert.match(text, /^[A-Z].*\.$/);
    assert.ok(c.columns.length > 0);
    for (const col of c.columns) assert.ok(col.name && col.count && col.note);
    for (const o of c.options) assert.ok(o.note);
    for (const options of ['{}', '', '  ']) {
      const r = parseOk(type, c.example, options);
      assert.equal(r.data.type, type);
      assert.deepEqual(r.summary.warnings, []);
      assert.equal(r.summary.rows, c.example.trim().split('\n').length - 1);
    }
    assert.ok(utf8Bytes(c.example) < 2048);
  }
  assert.deepEqual(titles, {
    timeseries: 'Time series', bars: 'Bars', toplist: 'Top list', pie: 'Pie', treemap: 'Treemap', table: 'Table', stat: 'Stat', waterfall: 'Waterfall',
    scatter: 'Scatter', schedule: 'Schedule', kanban: 'Kanban',
  });
});

test('C2 contract limits and option defaults match the spec', () => {
  const limits = Object.fromEntries(CHART_TYPES.map(t => [t, CHART_CONTRACTS[t].limits]));
  assert.deepEqual(limits, {
    timeseries: { minRows: 2, maxRows: 500, maxSeries: 5 },
    bars: { minRows: 1, maxRows: 50, maxSeries: 5 },
    toplist: { minRows: 1, maxRows: 500 },
    pie: { minRows: 1, maxRows: 50 },
    treemap: { minRows: 1, maxRows: 100 },
    table: { minRows: 1, maxRows: 50 },
    stat: { minRows: 1, maxRows: 60 },
    waterfall: { minRows: 1, maxRows: 200 },
    scatter: { minRows: 1, maxRows: 500 },
    schedule: { minRows: 1, maxRows: 100 },
    kanban: { minRows: 1, maxRows: 100 },
  });
  const defaults = Object.fromEntries(CHART_TYPES.map(t => [t, parseOk(t, CHART_CONTRACTS[t].example).data.options]));
  assert.deepEqual(defaults, {
    timeseries: { style: 'line', unit: '' },
    bars: { layout: 'stacked', orientation: 'vertical', unit: '' },
    toplist: { limit: 10, order: 'desc', unit: '' },
    pie: { donut: true, unit: '' },
    treemap: { unit: '' },
    table: { thresholds: [] },
    stat: { unit: '', deltaLabel: 'vs previous', upIsGood: true, precision: 2 },
    waterfall: {},
    scatter: { xUnit: '', yUnit: '' },
    schedule: { marker: '' },
    kanban: {},
  });
  assert.deepEqual(CHART_CONTRACTS.timeseries.options[0].values, ['line', 'area', 'stacked']);
  assert.deepEqual(CHART_CONTRACTS.bars.options.map(o => o.values), [['stacked', 'grouped'], ['vertical', 'horizontal'], undefined]);
  assert.deepEqual([CHART_CONTRACTS.toplist.options[0].min, CHART_CONTRACTS.toplist.options[0].max], [1, 25]);
  assert.deepEqual([CHART_CONTRACTS.stat.options[3].min, CHART_CONTRACTS.stat.options[3].max], [0, 4]);
});

test('C2 parseChart rejects unknown types, header problems and bad options in that order', () => {
  parseFails('heatmap', 'a,b\n1,2', '{}', "chart type 'heatmap' is not supported; use one of timeseries, bars, toplist, pie, treemap, table, stat, waterfall, scatter, schedule, kanban");
  parseFails('bars', '', '{}', 'the CSV is empty; put the column names on the first line');
  parseFails('bars', 'region,\nus,1', '{}', 'column 2 has no name; put a name in the first row');
  parseFails('bars', 'region, a ,a\nus,1,2', '{}', "column 'a' appears twice; column names must be unique");
  parseFails('bars', 'region,a\n', '{"layout":"pile"}', `option 'layout' must be one of stacked, grouped; got "pile"`);
  parseFails('pie', 'client,sessions\nweb,1', '{"unit":"x","colour":"red"}', "pie has no option 'colour'; options are donut, unit");
  parseFails('waterfall', CHART_CONTRACTS.waterfall.example, '{"unit":"ms"}', 'waterfall has no options; pass {}');
  parseFails('timeseries', 'time\tp99\n10:00\t12ms', '{}', 'timeseries needs at least 2 data rows; got 1');
});

test('C2 parseChart enforces row limits for every type', () => {
  for (const type of CHART_TYPES) {
    const { limits, example } = CHART_CONTRACTS[type];
    const [header, first] = example.split('\n');
    parseFails(type, rowsOf(header, () => first, limits.maxRows + 1), '{}', `${type} allows at most ${limits.maxRows} data rows; got ${limits.maxRows + 1}`);
    const fewer = limits.minRows - 1;
    parseFails(type, rowsOf(header, () => first, fewer), '{}', `${type} needs at least ${limits.minRows} data row${limits.minRows === 1 ? '' : 's'}; got ${fewer}`);
  }
});

test('FW column counts are checked before the header names (a duplicate check never walks a huge header)', () => {
  parseFails('table', 'a,a,c,d,e,f,g,h,i\n1,2,3,4,5,6,7,8,9', '{}', 'table allows at most 8 columns; got 9');
  parseFails('timeseries', 'time,s,s,s,s,s,s\n10:00,1,1,1,1,1,1\n10:01,1,1,1,1,1,1', '{}', "timeseries allows at most 5 series; got 6 — fold the smallest into 'other' or split into two charts");
  const huge = Array.from({ length: 4000 }, (_, i) => String(i)).join(',');
  parseFails('bars', `${huge}\n${Array(4000).fill('1').join(',')}`, '{}', "bars allows at most 5 series; got 3999 — fold the smallest into 'other' or split into two charts");
  parseFails('bars', 'region,a,b,a\nus,1,2,3', '{}', "column 'a' appears twice; column names must be unique");
});

test('FW a table column of U+2212 minus numbers is numeric, as parseNumberCell reads them', () => {
  const r = parseOk('table', 'host,delta\na,\u22125\nb,4', '{"thresholds":[{"column":"delta","warn":2,"crit":3}]}');
  assert.deepEqual(r.data.numeric, [false, true]);
});

test('C2 parseChart enforces column counts and the series cap', () => {
  parseFails('timeseries', 'time\n10:00\n10:05', '{}', 'timeseries needs a time column and at least one number column; got 1 column');
  parseFails('bars', 'region\nus', '{}', 'bars needs a label column and at least one number column; got 1 column');
  parseFails('toplist', 'endpoint,p99,p50\n/a,1,2', '{}', 'toplist needs exactly 2 columns (label, value); got 3 columns');
  parseFails('pie', 'client\nweb', '{}', 'pie needs exactly 2 columns (label, value); got 1 column');
  parseFails('treemap', 'a,b,c,d\nx,1,g,z', '{}', 'treemap needs 2 or 3 columns (label, value, optional parent); got 4 columns');
  parseFails('table', 'a,b,c,d,e,f,g,h,i\n1,2,3,4,5,6,7,8,9', '{}', 'table allows at most 8 columns; got 9');
  parseFails('stat', 'w,x,value\n1,2,3', '{}', 'stat needs 1 or 2 columns (value, or x and value); got 3 columns');
  const wide = n => rowsOf(['time', ...Array.from({ length: n }, (_, i) => `s${i + 1}`)].join(','), i => [`10:0${i}`, ...Array(n).fill('1')].join(','), 2);
  parseOk('timeseries', wide(5));
  parseFails('timeseries', wide(7), '{}', "timeseries allows at most 5 series; got 7 — fold the smallest into 'other' or split into two charts");
  parseFails('bars', wide(6), '{}', "bars allows at most 5 series; got 6 — fold the smallest into 'other' or split into two charts");
});

test('C2 timeseries data, gaps and stacked values', () => {
  const r = parseOk('timeseries', CHART_CONTRACTS.timeseries.example);
  assert.deepEqual(r.data.xs, [0, 1, 2, 3, 4, 5, 6].map(i => 36000000 + i * 300000));
  assert.deepEqual({ ...r.data, xs: undefined }, {
    type: 'timeseries', options: { style: 'line', unit: '' }, xName: 'time', xKind: 'clock', xs: undefined,
    series: [{ name: 'checkout', values: [120, 135, 180, 160, 140, 128, 122] }, { name: 'search', values: [95, 98, 102, 99, 97, 96, 98] }],
  });
  assert.deepEqual(r.summary, { rows: 7, series: ['checkout', 'search'], xRange: '10:00 → 10:30', warnings: [] });
  const gap = parseOk('timeseries', 'ts,before,after\n1791540000000,120,\n1791540060000,,95\n1791540120000,118,96', '{"style":"area","unit":"ms"}');
  assert.equal(gap.data.xKind, 'epoch');
  assert.deepEqual(gap.data.series.map(s => s.values), [[120, null, 118], [null, 95, 96]]);
  assert.deepEqual(gap.data.options, { style: 'area', unit: 'ms' });
  assert.equal(gap.summary.xRange, '1791540000000 → 1791540120000');
  parseFails('timeseries', 'time,a,b\n10:00,1,\n10:05,2,', '{}', "column 'b' has no numbers; fill at least one cell");
  parseFails('timeseries', 'time,p99\n10:00,12\n10:05,12ms', '{}', "row 3, column 'p99': '12ms' is not a number; put the unit in the unit option");
  parseFails('timeseries', 'time,p99\n10:05,12\n10:00,13', '{}', "row 3, column 'time': '10:00' is not later than row 2; sort the rows by time, oldest first");
  parseOk('timeseries', 'time,delta\n10:00,-3\n10:05,4');
  parseFails('timeseries', 'time,delta\n10:00,-3\n10:05,4', '{"style":"stacked"}', "row 2, column 'delta': stacked values must be 0 or more; got -3");
  assert.deepEqual(parseOk('timeseries', ' time , p99 \n 10:00 , 1 \n10:05,2').data.series, [{ name: 'p99', values: [1, 2] }]);
});

test('C2 bars data, labels and stacked values', () => {
  const r = parseOk('bars', CHART_CONTRACTS.bars.example);
  assert.deepEqual(r.data.categories, ['09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00']);
  assert.deepEqual(r.data.series.map(s => s.name), ['us-east', 'eu-west', 'ap-south']);
  assert.deepEqual(r.data.series[2].values, [9800, 12200, 13900, 15200, 17800, 16100, 14400, 12300]);
  assert.equal(r.data.xName, 'hour');
  assert.deepEqual(r.summary, { rows: 8, series: ['us-east', 'eu-west', 'ap-south'], xRange: '09:00 → 16:00', warnings: [] });
  parseFails('bars', 'region,req\nus,1\n,2', '{}', "row 3, column 'region' is empty; every row needs a label");
  parseFails('bars', 'region,req\nus,1\neu,', '{}', "row 3, column 'req' is empty; every row needs a number");
  parseFails('bars', 'region,req\nus,-1', '{}', "row 2, column 'req': stacked values must be 0 or more; got -1");
  assert.deepEqual(parseOk('bars', 'region,delta\nus,-1\neu,2', '{"layout":"grouped","orientation":"horizontal"}').data, {
    type: 'bars', options: { layout: 'grouped', orientation: 'horizontal', unit: '' }, xName: 'region', categories: ['us', 'eu'], series: [{ name: 'delta', values: [-1, 2] }],
  });
});

test('C2 toplist sorts, cuts at the limit and reports the cut', () => {
  const r = parseOk('toplist', CHART_CONTRACTS.toplist.example);
  assert.deepEqual(r.data.items.map(i => i.label), ['/checkout', '/search', '/cart/items', '/login', '/api/v2/orders', '/health']);
  assert.deepEqual([r.data.labelName, r.data.valueName, r.data.totalRows], ['endpoint', 'p99_ms', 6]);
  assert.deepEqual(r.summary, { rows: 6, series: ['p99_ms'], xRange: '', warnings: [] });
  const many = rowsOf('endpoint,hits', i => `/e${i},${i % 3}`, 12);
  const cut = parseOk('toplist', many);
  assert.deepEqual(cut.data.items.map(i => i.label), ['/e2', '/e5', '/e8', '/e11', '/e1', '/e4', '/e7', '/e10', '/e0', '/e3']);
  assert.equal(cut.data.totalRows, 12);
  assert.deepEqual(cut.summary.warnings, ['toplist: showing 10 of 12 rows']);
  const asc = parseOk('toplist', many, '{"order":"asc","limit":3}');
  assert.deepEqual(asc.data.items, [{ label: '/e0', value: 0 }, { label: '/e3', value: 0 }, { label: '/e6', value: 0 }]);
  assert.deepEqual(asc.summary.warnings, ['toplist: showing 3 of 12 rows']);
  parseFails('toplist', 'endpoint,p99\n/a,1\n/b,1,284', '{}', 'row 3 has 3 cells; the header has 2');
  parseFails('toplist', 'endpoint\tp99\n/a\t1,284', '{}', "row 2, column 'p99': '1,284' has a thousands separator; write 1284");
  parseFails('toplist', 'endpoint,p99\n/a,1', '{"limit":30}', "option 'limit' must be a whole number from 1 to 25; got 30");
});

test('C2 pie sorts slices, folds past 5 and checks values', () => {
  const r = parseOk('pie', CHART_CONTRACTS.pie.example);
  assert.deepEqual(r.data, {
    type: 'pie', options: { donut: true, unit: '' }, valueName: 'sessions', total: 2400000,
    slices: [{ label: 'web', value: 1104000, other: false }, { label: 'ios', value: 648000, other: false }, { label: 'android', value: 456000, other: false }, { label: 'api', value: 192000, other: false }],
  });
  assert.deepEqual(r.summary, { rows: 4, series: ['sessions'], xRange: '', warnings: [] });
  const five = parseOk('pie', 'k,v\na,1\nb,5\nc,2\nd,4\ne,3');
  assert.deepEqual(five.data.slices.map(s => s.label), ['b', 'd', 'e', 'c', 'a']);
  assert.deepEqual(five.summary.warnings, []);
  const six = parseOk('pie', 'k,v\na,1\nb,5\nc,2\nd,4\ne,3\nf,6');
  assert.deepEqual(six.data.slices.map(s => `${s.label}=${s.value}`), ['f=6', 'b=5', 'd=4', 'e=3', 'other=3']);
  assert.deepEqual(six.summary.warnings, ["pie: 2 slices folded into 'other'"]);
  const seven = parseOk('pie', 'k,v\na,1\nb,7\nc,2\nd,6\ne,3\nf,5\ng,4', '{"donut":false}');
  assert.deepEqual(seven.data.slices, [
    { label: 'b', value: 7, other: false }, { label: 'd', value: 6, other: false }, { label: 'f', value: 5, other: false },
    { label: 'g', value: 4, other: false }, { label: 'other', value: 6, other: true },
  ]);
  assert.equal(seven.data.total, 28);
  assert.equal(seven.data.options.donut, false);
  assert.deepEqual(seven.summary.warnings, ["pie: 3 slices folded into 'other'"]);
  parseFails('pie', 'k,v\na,1\nb,-2', '{}', "row 3, column 'v': pie values must be 0 or more; got -2");
  parseFails('pie', 'k,v\na,0\nb,0', '{}', 'pie values add up to 0; at least one value must be greater than 0');
  parseFails('pie', 'k,v\n,1', '{}', "row 2, column 'k' is empty; every row needs a label");
});

test('C2 treemap groups leaves under at most 5 parents', () => {
  const r = parseOk('treemap', CHART_CONTRACTS.treemap.example);
  assert.deepEqual(r.data.parents, ['app services', 'data stores']);
  assert.deepEqual(r.data.leaves[0], { label: 'checkout', value: 4100, parent: 'app services' });
  assert.equal(r.data.valueName, 'cost');
  for (const p of r.data.parents) assert.ok(r.data.leaves.some(l => l.parent === p));
  assert.deepEqual(r.summary, { rows: 6, series: ['cost'], xRange: '', warnings: [] });
  assert.deepEqual(parseOk('treemap', 'svc,cost\na,1\nb,0').data, {
    type: 'treemap', options: { unit: '' }, valueName: 'cost', parents: [], leaves: [{ label: 'a', value: 1, parent: '' }, { label: 'b', value: 0, parent: '' }],
  });
  parseFails('treemap', 'svc,cost,group\na,1,g\nb,2,', '{}', "row 3, column 'group' is empty; every row needs a parent when there is a parent column");
  parseFails('treemap', rowsOf('svc,cost,group', i => `s${i},1,g${i}`, 6), '{}', 'treemap allows at most 5 parents; got 6 — merge small groups or split into two charts');
  parseOk('treemap', rowsOf('svc,cost,group', i => `s${i},1,g${i}`, 5));
  parseFails('treemap', 'svc,cost,group\napp,1,app\nb,2,app', '{}', "row 2: 'app' is both a leaf and a parent; treemaps have one level");
  parseFails('treemap', 'svc,cost,group\na,1,g\nb,0,h', '{}', "parent 'h' adds up to 0; give one of its leaves a value greater than 0");
  parseFails('treemap', 'svc,cost\na,0', '{}', 'treemap values add up to 0; at least one value must be greater than 0');
  parseFails('treemap', 'svc,cost\na,-1', '{}', "row 2, column 'cost': treemap values must be 0 or more; got -1");
});

test('C2 table finds number columns and checks thresholds against them', () => {
  const r = parseOk('table', CHART_CONTRACTS.table.example);
  assert.deepEqual(r.data.header, ['host', 'cpu', 'mem_gb', 'p50_ms']);
  assert.deepEqual(r.data.numeric, [false, true, true, true]);
  assert.deepEqual(r.data.rows[1], ['api-2', '94', '1.9', '88']);
  assert.deepEqual(r.summary, { rows: 4, series: ['host', 'cpu', 'mem_gb', 'p50_ms'], xRange: '', warnings: [] });
  const cpu = '{"thresholds":[{"column":"cpu","warn":80,"crit":90,"direction":"above"}]}';
  assert.ok(CHART_CONTRACTS.table.options[0].note.includes('[{"column":"cpu","warn":80,"crit":90,"direction":"above"}]'));
  assert.deepEqual(parseOk('table', CHART_CONTRACTS.table.example, cpu).data.options, { thresholds: [{ column: 'cpu', warn: 80, crit: 90, direction: 'above' }] });
  assert.deepEqual(parseOk('table', 'host,p50\na,—\nb,', '{}').data.numeric, [false, false]);
  parseFails('table', CHART_CONTRACTS.table.example, '{"thresholds":[{"column":"gpu","warn":1,"crit":2}]}', "threshold 1: column 'gpu' is not in the header; columns are host, cpu, mem_gb, p50_ms");
  parseFails('table', CHART_CONTRACTS.table.example, '{"thresholds":[{"column":"cpu","warn":1,"crit":2},{"column":"cpu","warn":3,"crit":4}]}', "threshold 2: column 'cpu' already has a threshold");
  parseFails('table', 'host,p50\na,4\nb,—', '{"thresholds":[{"column":"p50","warn":50,"crit":100}]}', "threshold 1: column 'p50' must hold only numbers; row 3 holds '—'");
  parseFails('table', 'host,p50\na,\nb,4', '{"thresholds":[{"column":"p50","warn":50,"crit":100}]}', "threshold 1: column 'p50' must hold only numbers; row 2 holds ''");
  parseFails('table', 'host,cpu\na,1', '{"thresholds":[{"column":"cpu","warn":2,"crit":1}]}', 'threshold 1: with direction above, warn (2) must not be greater than crit (1)');
  assert.deepEqual(parseOk('table', 'note\nhello').data, { type: 'table', options: { thresholds: [] }, header: ['note'], numeric: [false], rows: [['hello']], values: [[null]] });
});

test('BUG1 table values hold the parsed number of every numeric cell, reading U+2212 as minus', () => {
  const r = parseOk('table', 'host,cpu\na,−5\nb,72\nc,94', '{"thresholds":[{"column":"cpu","warn":-10,"crit":-20,"direction":"below"}]}');
  assert.deepEqual(r.data.numeric, [false, true]);
  assert.deepEqual(r.data.rows.map(row => row[1]), ['−5', '72', '94']);
  assert.deepEqual(r.data.values, [[null, -5], [null, 72], [null, 94]]);
});

test('C2 stat reads the last row as current, the row before as previous, every row as trend', () => {
  const r = parseOk('stat', CHART_CONTRACTS.stat.example);
  assert.deepEqual({ ...r.data, trend: r.data.trend.length }, {
    type: 'stat', options: { unit: '', deltaLabel: 'vs previous', upIsGood: true, precision: 2 }, valueName: 'availability', value: 99.95, previous: 99.94, trend: 12,
  });
  assert.equal(r.data.trend[0], 99.91);
  assert.deepEqual(r.summary, { rows: 12, series: ['availability'], xRange: '', warnings: [] });
  assert.deepEqual(parseOk('stat', 'p99\n182', '{"unit":"ms","deltaLabel":"vs last deploy","upIsGood":false,"precision":0}').data, {
    type: 'stat', options: { unit: 'ms', deltaLabel: 'vs last deploy', upIsGood: false, precision: 0 }, valueName: 'p99', value: 182, previous: null, trend: [182],
  });
  assert.deepEqual(parseOk('stat', 'errors\n3\n5').data.previous, 3);
  parseFails('stat', 'week,availability\nW1,99.9%', '{}', "row 2, column 'availability': '99.9%' is not a number; put the unit in the unit option");
  parseFails('stat', 'p99\n1', '{"precision":5}', "option 'precision' must be a whole number from 0 to 4; got 5");
  parseFails('stat', 'p99\n1', '{"upIsGood":"no"}', `option 'upIsGood' must be true or false; got "no"`);
});

const TRACE = 'span_id,parent_id,name,service,start_ms,duration_ms,status';

test('C2 waterfall orders spans depth first with depths, services and end', () => {
  const r = parseOk('waterfall', CHART_CONTRACTS.waterfall.example);
  assert.deepEqual(r.data.spans.map(s => [s.id, s.depth]), [['1', 0], ['2', 1], ['3', 1], ['4', 2], ['5', 1], ['6', 1], ['7', 2]]);
  assert.deepEqual(r.data.spans[0], { id: '1', parentId: '', name: 'POST /checkout', service: 'web', start: 0, duration: 420, status: 'error', depth: 0 });
  assert.deepEqual(r.data.spans.filter(s => s.status === 'error').map(s => s.id), ['1', '6', '7']);
  assert.deepEqual(r.data.services, ['web', 'auth', 'cart', 'postgres', 'payments']);
  assert.equal(r.data.end, 420);
  assert.deepEqual(r.data.options, {});
  assert.deepEqual(r.summary, { rows: 7, series: ['web', 'auth', 'cart', 'postgres', 'payments'], xRange: '', warnings: [] });
});

test('C2 waterfall matches columns by name in any order and status is optional', () => {
  const shuffled = 'duration_ms,service,span_id,name,start_ms,parent_id\n50,api,b,child late,40,a\n100,api,a,root,0,\n10,db,c,child early,5,a\n10,db,d,child tie,5,a';
  const r = parseOk('waterfall', shuffled);
  assert.deepEqual(r.data.spans.map(s => `${s.id}:${s.depth}:${s.status}`), ['a:0:ok', 'c:1:ok', 'd:1:ok', 'b:1:ok']);
  assert.deepEqual(r.data.services, ['api', 'db']);
  assert.equal(r.data.end, 100);
  assert.deepEqual(parseOk('waterfall', `${TRACE}\nx,,root,api,0,5,ERROR\ny,,other root,api,0,1,`).data.spans.map(s => `${s.id}:${s.status}`), ['x:error', 'y:ok']);
});

test('C2 waterfall rejects bad columns, ids, parents, cycles and negative times', () => {
  const help = 'use span_id, parent_id, name, service, start_ms, duration_ms, and optional status';
  parseFails('waterfall', `${TRACE},host\na,,r,api,0,1,ok,h1`, '{}', `waterfall has no column 'host'; ${help}`);
  parseFails('waterfall', 'span_id,parent_id,name,start_ms,duration_ms\na,,r,0,1', '{}', `waterfall needs a 'service' column; ${help}`);
  parseFails('waterfall', `${TRACE}\n,,r,api,0,1,ok`, '{}', "row 2, column 'span_id' is empty; every span needs an id");
  parseFails('waterfall', `${TRACE}\na,,,api,0,1,ok`, '{}', "row 2, column 'name' is empty; every span needs a name");
  parseFails('waterfall', `${TRACE}\na,,r,,0,1,ok`, '{}', "row 2, column 'service' is empty; every span needs a service");
  parseFails('waterfall', `${TRACE}\na,,r,api,0,1,ok\na,,s,api,0,1,ok`, '{}', "row 3: span_id 'a' is used twice; span ids must be unique");
  parseFails('waterfall', `${TRACE}\na,,r,api,0,1,ok\nb,cache,s,api,0,1,ok`, '{}', "row 3: parent_id 'cache' is not a span_id in this CSV; leave it empty for a root span");
  parseFails('waterfall', `${TRACE}\nr,,root,api,0,9,ok\na,b,x,api,0,1,ok\nb,a,y,api,0,1,ok`, '{}', "span 'a' is in a parent cycle (a → b → a); every chain must end at a root span");
  parseFails('waterfall', `${TRACE}\na,a,x,api,0,1,ok`, '{}', "span 'a' is in a parent cycle (a → a); every chain must end at a root span");
  parseFails('waterfall', `${TRACE}\na,,x,api,-1,1,ok`, '{}', "row 2, column 'start_ms': waterfall times must be 0 or more; got -1");
  parseFails('waterfall', `${TRACE}\na,,x,api,0,-5,ok`, '{}', "row 2, column 'duration_ms': waterfall times must be 0 or more; got -5");
  parseFails('waterfall', `${TRACE}\na,,x,api,0,5ms,ok`, '{}', "row 2, column 'duration_ms': '5ms' is not a number; put the unit in the unit option");
  parseFails('waterfall', `${TRACE}\na,,x,api,0,5,failed`, '{}', "row 2, column 'status': 'failed' is not a status; use ok or error");
});

test('C2 waterfall folds services past the first 5 into other services', () => {
  const csv = rowsOf(TRACE, i => (i === 0 ? 'root,,root,svc0,0,100,ok' : `s${i},root,op${i},svc${i},${i},10,ok`), 8);
  const r = parseOk('waterfall', csv);
  assert.deepEqual(r.data.services, ['svc0', 'svc1', 'svc2', 'svc3', 'svc4', 'other services']);
  assert.deepEqual(r.data.spans.map(s => s.service), ['svc0', 'svc1', 'svc2', 'svc3', 'svc4', 'other services', 'other services', 'other services']);
  assert.deepEqual(r.summary.warnings, ["waterfall: 3 services folded into 'other services'"]);
  assert.deepEqual(r.summary.series, r.data.services);
  const six = parseOk('waterfall', rowsOf(TRACE, i => `s${i},,op${i},svc${i},${i},1,ok`, 6));
  assert.deepEqual(six.data.services, ['svc0', 'svc1', 'svc2', 'svc3', 'svc4', 'other services']);
  assert.deepEqual(six.summary.warnings, ["waterfall: 1 service folded into 'other services'"]);
  assert.deepEqual(parseOk('waterfall', rowsOf(TRACE, i => `s${i},,op${i},svc${i},${i},1,ok`, 5)).summary.warnings, []);
});

test('C2 a header-only paste is refused for every type with the row count sentence', () => {
  for (const type of CHART_TYPES) {
    const { limits, example } = CHART_CONTRACTS[type];
    const header = example.split('\n')[0];
    for (const csv of [header, `${header}\n`, `${header}\r\n`, `\ufeff${header}\r\n`]) {
      parseFails(type, csv, '{}', `${type} needs at least ${limits.minRows} data row${limits.minRows === 1 ? '' : 's'}; got 0`);
    }
  }
});

test('C2 a spreadsheet paste with a trailing tab on every row is refused with the unnamed column', () => {
  parseFails('timeseries', 'time\tp99\t\n10:00\t12\t\n10:05\t13\t', '{}', 'column 3 has no name; put a name in the first row');
  parseFails('table', 'host\tcpu\t\r\napi-1\t72\t', '{}', 'column 3 has no name; put a name in the first row');
});

test('C2 waterfall span ids that are Object.prototype names parse like any other id', () => {
  const names = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__', 'isPrototypeOf', 'toLocaleString'];
  for (const name of names) {
    const r = parseOk('waterfall', `${TRACE}\n${name},,root,api,0,10,ok\nkid,${name},child,api,1,2,ok`);
    assert.deepEqual(r.data.spans.map(s => `${s.id}:${s.parentId}:${s.depth}`), [`${name}::0`, `kid:${name}:1`]);
  }
  const chain = parseOk('waterfall', `${TRACE}\n__proto__,,a,api,0,10,ok\nconstructor,__proto__,b,api,1,5,ok\ntoString,constructor,c,api,2,1,ok`);
  assert.deepEqual(chain.data.spans.map(s => [s.id, s.depth]), [['__proto__', 0], ['constructor', 1], ['toString', 2]]);
  // a prototype name used as a parent but never defined is still "not a span_id"
  parseFails('waterfall', `${TRACE}\na,constructor,x,api,0,1,ok`, '{}', "row 2: parent_id 'constructor' is not a span_id in this CSV; leave it empty for a root span");
  parseFails('waterfall', `${TRACE}\na,__proto__,x,api,0,1,ok`, '{}', "row 2: parent_id '__proto__' is not a span_id in this CSV; leave it empty for a root span");
  // duplicates and cycles are still found
  parseFails('waterfall', `${TRACE}\n__proto__,,a,api,0,1,ok\n__proto__,,b,api,0,1,ok`, '{}', "row 3: span_id '__proto__' is used twice; span ids must be unique");
  parseFails('waterfall', `${TRACE}\nconstructor,,a,api,0,1,ok\nconstructor,,b,api,0,1,ok`, '{}', "row 3: span_id 'constructor' is used twice; span ids must be unique");
  parseFails('waterfall', `${TRACE}\n__proto__,constructor,x,api,0,1,ok\nconstructor,__proto__,y,api,0,1,ok`, '{}', "span '__proto__' is in a parent cycle (__proto__ → constructor → __proto__); every chain must end at a root span");
});

test('Cfix ISO 8601 accepts 1 to 9 fraction digits and a lowercase t or z', () => {
  const ms = Date.UTC(2026, 9, 9, 10, 0, 0, 123);
  const iso = cells => parseTimeColumn(cells, 'time', 2);
  assert.deepEqual(iso(['2026-10-09T10:00:00.123Z', '2026-10-09T10:00:01Z']), { kind: 'iso', xs: [ms, ms + 877] });
  assert.deepEqual(iso(['2026-10-09T10:00:00.123456Z']), { kind: 'iso', xs: [ms] });
  assert.deepEqual(iso(['2026-10-09T10:00:00.123456789Z']), { kind: 'iso', xs: [ms] });
  assert.deepEqual(iso(['2026-10-09T10:00:00.123456789+02:00']), { kind: 'iso', xs: [ms - 7200000] });
  assert.deepEqual(iso(['2026-10-09t10:00:00z']), { kind: 'iso', xs: [Date.UTC(2026, 9, 9, 10)] });
  assert.deepEqual(iso(['2026-10-09t10:00:00.123456z']), { kind: 'iso', xs: [ms] });
  assert.deepEqual(iso(['2026-10-09 10:00:00.1234567Z', '2026-10-09t10:00:01Z']), { kind: 'iso', xs: [ms, ms + 877] });
  assert.deepEqual(iso(['2026-10-09T10:00:00.9999999Z']), { kind: 'iso', xs: [Date.UTC(2026, 9, 9, 10, 0, 0, 999)] });
  assert.deepEqual(iso(['2026-10-09T10:00:00.0005Z']), { kind: 'iso', xs: [Date.UTC(2026, 9, 9, 10)] });
  const help = 'use ISO 8601 (2026-10-09T10:00:00Z), HH:MM[:SS], or epoch milliseconds';
  fails(() => iso(['2026-10-09T10:00:00.1234567890Z']), `row 2, column 'time': '2026-10-09T10:00:00.1234567890Z' is not a time; ${help}`);
  fails(() => iso(['2026-10-09T10:00:00.Z']), `row 2, column 'time': '2026-10-09T10:00:00.Z' is not a time; ${help}`);
});

test('Cfix parseCsv honours quotes when it looks for a tab in the first record', () => {
  assert.deepEqual(parseCsv('"a\tb",c\n1,2'), { ok: true, header: ['a\tb', 'c'], rows: [['1', '2']], delimiter: ',' });
  assert.deepEqual(parseCsv('c,"a\tb"\n1,2'), { ok: true, header: ['c', 'a\tb'], rows: [['1', '2']], delimiter: ',' });
  assert.deepEqual(parseCsv('"a""\tb",c\n1,2'), { ok: true, header: ['a"\tb', 'c'], rows: [['1', '2']], delimiter: ',' });
  assert.deepEqual(parseCsv('"a\r\nb\t",c\n1,2'), { ok: true, header: ['a\r\nb\t', 'c'], rows: [['1', '2']], delimiter: ',' });
  assert.deepEqual(parseCsv('"a,b"\tc\n1\t2'), { ok: true, header: ['a,b', 'c'], rows: [['1', '2']], delimiter: '\t' });
  assert.deepEqual(parseCsv('"a b"\t"c\td"\r\n1\t2'), { ok: true, header: ['a b', 'c\td'], rows: [['1', '2']], delimiter: '\t' });
  assert.deepEqual(parseCsv('a"b\tc\n1\t2'), { ok: true, header: ['a"b', 'c'], rows: [['1', '2']], delimiter: '\t' });
  csvError('"a\tb,c\n1,2', 'row 1 has a quote that is never closed');
});

test('Cfix parseNumberCell returns 0, never -0', () => {
  for (const cell of ['-0', '-0.0', '+0', '-0e5', ' -0 ', '\u22120']) assert.ok(Object.is(parseNumberCell(cell, 2, 'p99'), 0), cell);
  assert.ok(Object.is(parseChart('stat', 'delta\n-0', '{}').data.value, 0));
  assert.ok(Object.is(parseChart('bars', 'region,delta\nus,-0', '{"layout":"grouped"}').data.series[0].values[0], 0));
});

test('Cfix parseNumberCell reads U+2212 as a leading minus and gives the unit hint only for one number with a unit', () => {
  assert.equal(parseNumberCell('\u22125', 2, 'delta'), -5);
  assert.equal(parseNumberCell(' \u22122.5e3 ', 2, 'delta'), -2500);
  assert.equal(parseNumberCell('\u2212.5', 2, 'delta'), -0.5);
  fails(() => parseNumberCell('\u22125ms', 4, 'delta'), "row 4, column 'delta': '\u22125ms' is not a number; put the unit in the unit option");
  fails(() => parseNumberCell('\u2212abc', 4, 'delta'), "row 4, column 'delta': '\u2212abc' is not a number");
  fails(() => parseNumberCell('\u22121,284', 4, 'delta'), "row 4, column 'delta': '\u22121,284' has a thousands separator; write -1284");
  fails(() => parseNumberCell('1\u22122', 4, 'delta'), "row 4, column 'delta': '1\u22122' is not a number");
  fails(() => parseNumberCell('12ms', 4, 'p99'), "row 4, column 'p99': '12ms' is not a number; put the unit in the unit option");
  fails(() => parseNumberCell('95%', 4, 'cpu'), "row 4, column 'cpu': '95%' is not a number; put the unit in the unit option");
  fails(() => parseNumberCell('ms12', 4, 'p99'), "row 4, column 'p99': 'ms12' is not a number; put the unit in the unit option");
  fails(() => parseNumberCell('12.5 ms', 4, 'p99'), "row 4, column 'p99': '12.5 ms' is not a number; put the unit in the unit option");
  // the hint is only for a number next to letters, % or a currency sign
  fails(() => parseNumberCell('€12.50', 4, 'cost'), "row 4, column 'cost': '€12.50' is not a number; put the unit in the unit option");
  for (const bad of ['1.2.3', '1..2', '10:00', '1-2', '12ms 14ms', 'v1.2.3', '1e5ms', 'abc', '(5)', '5-', '#12', '<5', '~5', '5+', '\u2212\u22125']) {
    fails(() => parseNumberCell(bad, 4, 'p99'), `row 4, column 'p99': '${bad}' is not a number`);
  }
});

const TOO_LARGE = type => `${type} values are too large; a total is not a finite number`;

test('Cfix a total that overflows to Infinity is refused for pie, treemap, waterfall and stacked charts', () => {
  parseFails('pie', 'k,v\na,1e308\nb,1e308', '{}', TOO_LARGE('pie'));
  parseFails('pie', 'k,v\na,1e308\nb,1e308\nc,1\nd,1\ne,1\nf,1', '{"donut":false}', TOO_LARGE('pie'));
  parseOk('pie', 'k,v\na,1e308\nb,1e307');
  parseFails('treemap', 'svc,cost\na,1e308\nb,1e308', '{}', TOO_LARGE('treemap'));
  parseFails('treemap', 'svc,cost,group\na,1e308,g\nb,1e308,h', '{}', TOO_LARGE('treemap'));
  parseOk('treemap', 'svc,cost,group\na,1e308,g\nb,1e307,h');
  parseFails('waterfall', `${TRACE}\na,,x,api,1e308,1e308,ok`, '{}', TOO_LARGE('waterfall'));
  parseFails('waterfall', `${TRACE}\nr,,root,api,0,5,ok\na,r,x,api,1.5e308,1.5e308,ok`, '{}', TOO_LARGE('waterfall'));
  parseOk('waterfall', `${TRACE}\na,,x,api,1e308,1e307,ok`);
  parseFails('bars', 'region,a,b\nus,1,2\neu,1e308,1e308', '{}', TOO_LARGE('bars'));
  parseFails('bars', 'region,a,b\nus,1e308,1e308', '{"layout":"stacked","orientation":"horizontal"}', TOO_LARGE('bars'));
  parseOk('bars', 'region,a,b\nus,1e308,1e308', '{"layout":"grouped"}');
  parseOk('bars', 'region,a,b\nus,1e308,1e307');
  parseFails('timeseries', 'time,a,b\n10:00,1,2\n10:05,1e308,1e308', '{"style":"stacked"}', TOO_LARGE('timeseries'));
  parseOk('timeseries', 'time,a,b\n10:00,1e308,\n10:05,1,\n10:10,,1e308', '{"style":"stacked"}');
  parseOk('timeseries', 'time,a,b\n10:00,1e308,1e308\n10:05,1,1', '{"style":"area"}');
});

test('Cfix a cell too large for a number still names its row and column', () => {
  parseFails('pie', 'k,v\na,1e999', '{}', "row 2, column 'v': '1e999' is too large");
  parseFails('bars', 'region,a\nus,1\neu,1e999', '{}', "row 3, column 'a': '1e999' is too large");
});

test('Cfix options hold exactly 40 characters and exactly 4096 bytes', () => {
  assert.equal(parseOptions('demo', SPECS, `{"unit":"${'u'.repeat(40)}"}`).unit, 'u'.repeat(40));
  optionsError(`{"unit":"${'u'.repeat(41)}"}`, "option 'unit' is 41 characters; the limit is 40");
  const atCap = '{}' + ' '.repeat(MAX_OPTIONS_BYTES - 2);
  assert.equal(utf8Bytes(atCap), 4096);
  assert.equal(parseOptions('demo', SPECS, atCap).limit, 10);
  optionsError(atCap + ' ', 'options are 4097 bytes; the limit is 4096 bytes');
  const accents = '{"unit":"é"}' + ' '.repeat(MAX_OPTIONS_BYTES - 13);
  assert.equal(utf8Bytes(accents), 4096);
  assert.equal(parseOptions('demo', SPECS, accents).unit, 'é');
  optionsError(accents + ' ', 'options are 4097 bytes; the limit is 4096 bytes');
});

test('S1 scatter takes x and y by position and group and label by header, in any order', () => {
  const r = parseOk('scatter', 'label,payload_kb,p99_ms,group\n/a,4,120,web\n/b,1.5,−3,auth\n/c,9,80,web');
  assert.deepEqual(r.data, {
    type: 'scatter', options: { xUnit: '', yUnit: '' }, xName: 'payload_kb', yName: 'p99_ms', groups: ['web', 'auth'],
    points: [{ x: 4, y: 120, group: 0, label: '/a' }, { x: 1.5, y: -3, group: 1, label: '/b' }, { x: 9, y: 80, group: 0, label: '/c' }],
  });
  assert.deepEqual(r.summary, { rows: 3, series: ['web', 'auth'], xRange: '1.5 → 9', warnings: [] });
  const plain = parseOk('scatter', 'size,ms\n3,10\n1,20\n2,30');
  assert.deepEqual([plain.data.groups, plain.data.points.map(p => [p.group, p.label])], [[], [[0, ''], [0, ''], [0, '']]]);
  assert.deepEqual(plain.summary.series, ['ms']);
  assert.deepEqual(parseOk('scatter', 'group,x,label,y\ng,1,,2').data.points, [{ x: 1, y: 2, group: 0, label: '' }]);
  assert.deepEqual(parseOk('scatter', 'x,y\n1,2', '{"xUnit":"KB","yUnit":"ms"}').data.options, { xUnit: 'KB', yUnit: 'ms' });
});

test('S1 scatter rejects missing or extra columns, bad numbers, empty groups and more than 5 groups', () => {
  parseFails('scatter', 'x\n1', '{}', 'scatter needs an x column and a y column, then optional group and label columns; got 1 column');
  parseFails('scatter', 'label,x\na,1', '{}', 'scatter needs an x column and a y column besides group and label; got 1 column');
  parseFails('scatter', 'x,y,z\n1,2,3', '{}', "scatter has no column 'z'; after an x column and a y column, the optional columns are group and label");
  parseFails('scatter', 'x,y,Group\n1,2,a', '{}', "scatter has no column 'Group'; after an x column and a y column, the optional columns are group and label");
  parseFails('scatter', 'x,y,group,label,z\n1,2,a,b,c', '{}', 'scatter needs an x column and a y column, then optional group and label columns; got 5 columns');
  parseFails('scatter', 'x,y\n1,12ms', '{}', "row 2, column 'y': '12ms' is not a number; put the unit in the yUnit option");
  parseFails('scatter', 'x,y\n4KB,1', '{}', "row 2, column 'x': '4KB' is not a number; put the unit in the xUnit option");
  parseFails('scatter', 'x,y\n1,', '{}', "row 2, column 'y' is empty; every row needs a number");
  parseFails('scatter', 'x,y,group\n1,2,a\n3,4,', '{}', "row 3, column 'group' is empty; every row needs a label");
  parseFails('scatter', rowsOf('x,y,group', i => `${i},${i},g${i}`, 6), '{}', 'scatter allows at most 5 groups; got 6 — merge small groups or split into two charts');
  parseFails('scatter', 'x,y\n1,2', '{"unit":"ms"}', "scatter has no option 'unit'; options are xUnit, yUnit");
});

test('S2 schedule reads lanes in first-seen order, end dates as whole days and empty ends as milestones', () => {
  const r = parseOk('schedule', 'team,task,from,to,status\nweb,build,2026-10-01,2026-10-03,done\napi,spec,2026-10-02T09:00:00Z,2026-10-02T17:00:00Z,\nweb,ship,2026-10-05,,Planned\napi,demo,2026-10-04T10:00Z,2026-10-04T10:00Z,BLOCKED');
  const day = d => Date.UTC(2026, 9, d);
  assert.deepEqual(r.data.lanes, ['web', 'api']);
  assert.equal(r.data.xKind, 'iso');
  assert.deepEqual(r.data.items.map(i => [i.lane, i.label, i.start, i.end, i.milestone, i.status, i.startText, i.endText]), [
    [0, 'build', day(1), day(4), false, 'done', '2026-10-01', '2026-10-03'],
    [1, 'spec', day(2) + 9 * 3600000, day(2) + 17 * 3600000, false, '', '2026-10-02T09:00:00Z', '2026-10-02T17:00:00Z'],
    [0, 'ship', day(5), day(5), true, 'planned', '2026-10-05', ''],
    [1, 'demo', day(4) + 10 * 3600000, day(4) + 10 * 3600000, true, 'blocked', '2026-10-04T10:00Z', '2026-10-04T10:00Z'],
  ]);
  assert.deepEqual(r.summary, { rows: 4, series: ['web', 'api'], xRange: '2026-10-01 → 2026-10-05', warnings: [] });
  // a one-day item: start and end on the same date covers that day
  const one = parseOk('schedule', 'lane,item,start,end\na,b,2026-10-09,2026-10-09').data.items[0];
  assert.deepEqual([one.end - one.start, one.milestone], [86400000, false]);
  const clock = parseOk('schedule', 'lane,item,start,end,group\nprimary,alice,00:00,08:00,eu\nprimary,bo,08:00,16:00,us', '{"marker":"09:30"}');
  assert.deepEqual([clock.data.xKind, clock.data.marker, clock.data.groups, clock.data.items.map(i => i.group)], ['clock', 9.5 * 3600000, ['eu', 'us'], [0, 1]]);
  assert.equal(parseOk('schedule', 'lane,item,start,end\na,b,2026-10-01,', '{"marker":"2026-10-18"}').data.marker, day(18));
  assert.equal(parseOk('schedule', 'lane,item,start,end\na,b,2026-10-01,', '{"marker":"  "}').data.marker, null);
});

test('S2 schedule rejects bad times, ends before starts, unknown statuses, bad markers and too many lanes', () => {
  parseFails('schedule', 'lane,item,start\na,b,2026-10-01', '{}', 'schedule needs lane, item, start and end columns, then optional group and status columns; got 3 columns');
  parseFails('schedule', 'lane,item,start,status\na,b,2026-10-01,done', '{}', 'schedule needs lane, item, start and end columns besides group and status; got 3 columns');
  parseFails('schedule', 'lane,item,start,end,owner\na,b,2026-10-01,,x', '{}', "schedule has no column 'owner'; after lane, item, start and end columns, the optional columns are group and status");
  parseFails('schedule', 'lane,item,start,end\n,b,2026-10-01,', '{}', "row 2, column 'lane' is empty; every row needs a label");
  parseFails('schedule', 'lane,item,start,end\na,,2026-10-01,', '{}', "row 2, column 'item' is empty; every row needs an item");
  parseFails('schedule', 'lane,item,start,end\na,b,,2026-10-01', '{}', "row 2, column 'start' is empty; every row needs a start time");
  parseFails('schedule', 'lane,item,start,end\na,b,Oct 1,', '{}', "row 2, column 'start': 'Oct 1' is not a time; use ISO 8601 (2026-10-09T10:00:00Z), HH:MM[:SS], or epoch milliseconds");
  parseFails('schedule', 'lane,item,start,end\na,b,2026-10-01,\na,c,09:00,', '{}', "row 3, column 'start': '09:00' is not ISO 8601 like row 2; use one time format in start and end");
  parseFails('schedule', 'lane,item,start,end\na,b,2026-10-03,2026-10-02', '{}', "row 2: end '2026-10-02' is before start '2026-10-03'; an item ends at or after its start");
  parseFails('schedule', 'lane,item,start,end\na,b,22:00,06:00', '{}', "row 2: end '06:00' is before start '22:00'; an item ends at or after its start");
  parseFails('schedule', 'lane,item,start,end\na,b,2026-10-03T12:00Z,2026-10-02', '{}', "row 2: end '2026-10-02' is before start '2026-10-03T12:00Z'; an item ends at or after its start");
  // an end date may share the start's date: it runs to the end of that day
  const sameDay = parseOk('schedule', 'lane,item,start,end\na,b,2026-10-03T12:00Z,2026-10-03').data.items[0];
  assert.deepEqual([sameDay.end - sameDay.start, sameDay.milestone], [12 * 3600000, false]);
  parseFails('schedule', 'lane,item,start,end,status\na,b,2026-10-01,,late', '{}', "row 2, column 'status': 'late' is not a status; use planned, active, done or blocked, or leave it empty");
  parseFails('schedule', 'lane,item,start,end,group\na,b,2026-10-01,,', '{}', "row 2, column 'group' is empty; every row needs a label");
  parseFails('schedule', 'lane,item,start,end\na,b,2026-10-01,', '{"marker":"today"}', "option 'marker': 'today' is not a time; use ISO 8601 (2026-10-09T10:00:00Z), HH:MM[:SS], or epoch milliseconds");
  parseFails('schedule', 'lane,item,start,end\na,b,2026-10-01,', '{"marker":"10:00"}', "option 'marker': '10:00' is not ISO 8601 like the start column");
  // a safe integer can still be past every Date (8.64e15 ms): no tick or label could be drawn for it
  parseFails('schedule', 'lane,item,start,end\na,b,9000000000000000,9000100000000000', '{}', "row 2, column 'start': '9000000000000000' is past the last date a chart can show; epoch milliseconds go up to 8640000000000000");
  parseFails('schedule', 'lane,item,start,end\na,b,1,', '{"marker":"9000000000000000"}', "option 'marker': '9000000000000000' is past the last date a chart can show; epoch milliseconds go up to 8640000000000000");
  assert.equal(parseOk('schedule', 'lane,item,start,end\na,b,8639999999999999,8640000000000000').data.items[0].end, 8.64e15);
  parseFails('schedule', rowsOf('lane,item,start,end', i => `l${i},x,2026-10-01,`, 13), '{}', 'schedule allows at most 12 lanes; got 13 — merge lanes or split into two charts');
  parseFails('schedule', rowsOf('lane,item,start,end,group', i => `a,x,2026-10-01,,g${i}`, 6), '{}', 'schedule allows at most 5 groups; got 6 — merge small groups or split into two charts');
});

test('S3 kanban keeps stages and lanes in first-seen order; an empty card adds a stage with no card', () => {
  const r = parseOk('kanban', 'status,task,lane,group,detail\ntodo,a,api,bug,RC-1\ndoing,,api,,\ndone,b,web,,RC-2\ntodo,c,web,chore,');
  assert.deepEqual(r.data, {
    type: 'kanban', options: {}, stages: ['todo', 'doing', 'done'], lanes: ['api', 'web'], groups: ['bug', 'chore'],
    cards: [
      { stage: 0, lane: 0, title: 'a', detail: 'RC-1', group: 0 },
      { stage: 2, lane: 1, title: 'b', detail: 'RC-2', group: -1 },
      { stage: 0, lane: 1, title: 'c', detail: '', group: 1 },
    ],
  });
  assert.deepEqual(r.summary, { rows: 4, series: ['todo', 'doing', 'done'], xRange: '', warnings: [] });
  const plain = parseOk('kanban', 'stage,card\ntodo,a\ndone,');
  assert.deepEqual([plain.data.stages, plain.data.lanes, plain.data.cards], [['todo', 'done'], [], [{ stage: 0, lane: 0, title: 'a', detail: '', group: -1 }]]);
});

test('S3 kanban rejects extra columns, empty stages, stray details and too many stages, lanes or groups', () => {
  parseFails('kanban', 'stage,lane\ntodo,a', '{}', 'kanban needs a stage column and a card column besides lane, group and detail; got 1 column');
  parseFails('kanban', 'stage,card,owner\ntodo,a,x', '{}', "kanban has no column 'owner'; after a stage column and a card column, the optional columns are lane, group and detail");
  parseFails('kanban', 'stage,card\n,a', '{}', "row 2, column 'stage' is empty; every row needs a label");
  parseFails('kanban', 'stage,card,lane\ntodo,a,', '{}', "row 2, column 'lane' is empty; every row needs a label");
  parseFails('kanban', 'stage,card,detail\ntodo,,RC-1', '{}', 'row 2 has no card; leave group and detail empty on a row that only adds a stage');
  parseFails('kanban', rowsOf('stage,card', i => `s${i},x`, 9), '{}', 'kanban allows at most 8 stages; got 9 — merge stages or split into two charts');
  parseFails('kanban', rowsOf('stage,card,lane', i => `todo,x,l${i}`, 7), '{}', 'kanban allows at most 6 lanes; got 7 — merge lanes or split into two charts');
  parseFails('kanban', rowsOf('stage,card,group', i => `todo,x,g${i}`, 6), '{}', 'kanban allows at most 5 groups; got 6 — merge small groups or split into two charts');
  parseFails('kanban', 'stage,card\ntodo,a', '{"lanes":true}', 'kanban has no options; pass {}');
});
