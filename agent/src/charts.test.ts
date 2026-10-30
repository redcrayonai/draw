import { describe, it, expect } from 'vitest';
import {
  AGENT_SOURCE_RULE,
  CHART_CONTRACTS,
  CHART_TYPES,
  HUMAN_DATA_NEEDS_SOURCE,
  HUMAN_SOURCE_RESERVED,
  SAMPLE_NEEDS_SOURCE,
  SAMPLE_RESERVED,
  parseChart,
} from '../../module/src/chart-contracts';
import {
  chartNodeSummary,
  chartSummaryText,
  chartTypesText,
  checkChartInput,
  checkChartUpdate,
  describeChartsText,
  notAChart,
  optionsText,
} from './charts';

const SRC = 'agent: npm run bench @ 1a2b3c4';
const TS = 'time,p50,p99\n10:00,12,40\n10:05,14,52\n';
const PIE = 'service,cost\na,7\nb,6\nc,5\nd,4\ne,3\nf,2\ng,1\n';

// What the module's own parser says, so these tests never restate its sentences.
const summaryOf = (type: string, csv: string, options = '') => {
  const r = parseChart(type, csv, options);
  if (!r.ok) throw new Error(`expected ${type} to parse: ${r.error}`);
  return r.summary;
};
const errorOf = (type: string, csv: string, options = '') => {
  const r = parseChart(type, csv, options);
  if (r.ok) throw new Error(`expected ${type} to be rejected`);
  return r.error;
};

describe('describeChartsText', () => {
  it('lists all eleven contracts in CHART_TYPES order, with the source and sample rules', () => {
    const d = describeChartsText();
    if (!d.ok) throw new Error(d.error);
    const out = JSON.parse(d.text);
    expect(out.charts).toHaveLength(11);
    expect(out.charts.map((c: { type: string }) => c.type)).toEqual([...CHART_TYPES]);
    expect(out.charts).toEqual(JSON.parse(JSON.stringify(CHART_TYPES.map(t => CHART_CONTRACTS[t]))));
    for (const c of out.charts) {
      for (const key of ['purpose', 'columns', 'options', 'limits', 'renders', 'example']) expect(c, `${c.type}.${key}`).toHaveProperty(key);
    }
    expect(out.rules.source).toBe(AGENT_SOURCE_RULE);
    expect(out.rules.sample).toBe(SAMPLE_RESERVED);
  });

  it('every example it hands out passes the pre-check with a real source', () => {
    for (const t of CHART_TYPES) {
      const example = CHART_CONTRACTS[t].example;
      expect(checkChartInput({ type: t, csv: example, source: SRC }), t).toEqual({ ok: true, summary: summaryOf(t, example) });
    }
  });

  it('describes one type when asked', () => {
    const d = describeChartsText('pie');
    if (!d.ok) throw new Error(d.error);
    const out = JSON.parse(d.text);
    expect(out.charts).toEqual([JSON.parse(JSON.stringify(CHART_CONTRACTS.pie))]);
    expect(out.rules.source).toBe(AGENT_SOURCE_RULE);
  });

  it('names the eleven types when the type is unknown', () => {
    expect(describeChartsText('heatmap')).toEqual({
      ok: false,
      error: "unknown chart type 'heatmap'; the types are timeseries, bars, toplist, pie, treemap, table, stat, waterfall, scatter, schedule, kanban",
    });
  });
});

describe('checkChartInput (create_chart pre-check)', () => {
  it('rejects a missing, blank or reserved source before it parses anything', () => {
    expect(checkChartInput({ type: 'timeseries', csv: TS })).toEqual({ ok: false, error: AGENT_SOURCE_RULE });
    expect(checkChartInput({ type: 'timeseries', csv: TS, source: '' })).toEqual({ ok: false, error: AGENT_SOURCE_RULE });
    expect(checkChartInput({ type: 'timeseries', csv: TS, source: '   ' })).toEqual({ ok: false, error: AGENT_SOURCE_RULE });
    expect(checkChartInput({ type: 'timeseries', csv: TS, source: 'sample' })).toEqual({ ok: false, error: SAMPLE_RESERVED });
    expect(checkChartInput({ type: 'timeseries', csv: TS, source: 'human:alice' })).toEqual({ ok: false, error: HUMAN_SOURCE_RESERVED });
    expect(checkChartInput({ type: 'timeseries', csv: TS, source: '  Human: alice' })).toEqual({ ok: false, error: HUMAN_SOURCE_RESERVED });
    // the source rule wins over a CSV that would also fail
    expect(checkChartInput({ type: 'nope', csv: '', source: undefined })).toEqual({ ok: false, error: AGENT_SOURCE_RULE });
  });

  it('returns the parser summary for valid input', () => {
    const r = checkChartInput({ type: 'timeseries', csv: TS, source: SRC });
    if (!r.ok) throw new Error(r.error);
    expect(r.summary.rows).toBe(2);
    expect(r.summary.series).toEqual(['p50', 'p99']);
    expect(r.summary).toEqual(summaryOf('timeseries', TS));
  });

  it("passes the parser's sentence through unchanged", () => {
    const unit = 'time,p50,p99\n10:00,12,40\n10:05,14,12ms\n';
    expect(checkChartInput({ type: 'timeseries', csv: unit, source: SRC })).toEqual({ ok: false, error: errorOf('timeseries', unit) });
    expect(errorOf('timeseries', unit)).toContain("'12ms' is not a number");
    const seven = 't,a,b,c,d,e,f,g\n10:00,1,1,1,1,1,1,1\n10:01,2,2,2,2,2,2,2\n';
    expect(checkChartInput({ type: 'timeseries', csv: seven, source: SRC })).toEqual({ ok: false, error: errorOf('timeseries', seven) });
    expect(errorOf('timeseries', seven)).toContain('at most 5 series; got 7');
    expect(checkChartInput({ type: 'heatmap', csv: TS, source: SRC })).toEqual({ ok: false, error: errorOf('heatmap', TS) });
  });

  it('reports folds as warnings', () => {
    const r = checkChartInput({ type: 'pie', csv: PIE, source: SRC });
    if (!r.ok) throw new Error(r.error);
    expect(r.summary.series).toEqual(['cost']);
    expect(r.summary.warnings).toEqual(["pie: 3 slices folded into 'other'"]);
    expect(chartSummaryText(r.summary)).toContain("; pie: 3 slices folded into 'other')");
  });

  it('treats omitted, empty and {} options alike, and accepts an options object', () => {
    const none = checkChartInput({ type: 'timeseries', csv: TS, source: SRC });
    expect(checkChartInput({ type: 'timeseries', csv: TS, options: '', source: SRC })).toEqual(none);
    expect(checkChartInput({ type: 'timeseries', csv: TS, options: '{}', source: SRC })).toEqual(none);
    expect(optionsText(undefined)).toBeUndefined();
    expect(optionsText('{"style":"area"}')).toBe('{"style":"area"}');
    expect(optionsText({ style: 'area' })).toBe('{"style":"area"}');
    expect(checkChartInput({ type: 'timeseries', csv: TS, options: optionsText({ style: 'area' }), source: SRC }).ok).toBe(true);
    const bad = optionsText({ colour: 'red' });
    expect(checkChartInput({ type: 'timeseries', csv: TS, options: bad, source: SRC })).toEqual({ ok: false, error: errorOf('timeseries', TS, bad) });
  });
});

describe('checkChartUpdate (set_chart_data pre-check)', () => {
  // stored rows hold options as the reducer stores them: blank becomes '{}'
  const sample = { type: 'pie', csv: PIE, options: '{}', source: 'sample' };
  const measured = { type: 'pie', csv: PIE, options: '{}', source: SRC };
  const ONE = 'service,cost\na,1\n';

  it('sample data needs a source once the numbers change; sample stays reserved', () => {
    expect(checkChartUpdate(sample, { csv: ONE })).toEqual({ ok: false, error: SAMPLE_NEEDS_SOURCE });
    expect(checkChartUpdate(sample, { type: 'toplist' })).toEqual({ ok: false, error: SAMPLE_NEEDS_SOURCE });
    // options only: the numbers and their source stay
    expect(checkChartUpdate(sample, { options: '{"donut":false}' })).toEqual({ ok: true, summary: summaryOf('pie', PIE, '{"donut":false}') });
    expect(checkChartUpdate(sample, { csv: PIE })).toEqual({ ok: true, summary: summaryOf('pie', PIE) });
    expect(checkChartUpdate(sample, { csv: ONE, source: SRC })).toEqual({ ok: true, summary: summaryOf('pie', ONE) });
    expect(checkChartUpdate(sample, { source: 'sample' })).toEqual({ ok: false, error: SAMPLE_RESERVED });
  });

  it('normalizes options and source as the reducer does', () => {
    // '' and '  ' are stored as '{}', so they do not change a sample chart's data
    expect(checkChartUpdate(sample, { options: '' })).toEqual({ ok: true, summary: summaryOf('pie', PIE) });
    expect(checkChartUpdate(sample, { options: '  ' })).toEqual({ ok: true, summary: summaryOf('pie', PIE) });
    // the reducer trims the source before it compares it with 'sample'
    expect(checkChartUpdate(measured, { source: ' sample ' })).toEqual({ ok: false, error: SAMPLE_RESERVED });
    expect(checkChartInput({ type: 'pie', csv: PIE, source: ' sample ' })).toEqual({ ok: false, error: SAMPLE_RESERVED });
  });

  it("a person's data needs a source once the numbers change; a human: source is reserved", () => {
    const human = { type: 'pie', csv: PIE, options: '{}', source: 'human:alice' };
    expect(checkChartUpdate(human, { csv: ONE })).toEqual({ ok: false, error: HUMAN_DATA_NEEDS_SOURCE });
    expect(checkChartUpdate(human, { type: 'toplist' })).toEqual({ ok: false, error: HUMAN_DATA_NEEDS_SOURCE });
    expect(checkChartUpdate(human, { options: '{"donut":false}' })).toEqual({ ok: true, summary: summaryOf('pie', PIE, '{"donut":false}') });
    expect(checkChartUpdate(human, { csv: ONE, source: SRC })).toEqual({ ok: true, summary: summaryOf('pie', ONE) });
    expect(checkChartUpdate(measured, { csv: ONE, source: 'HUMAN:bob' })).toEqual({ ok: false, error: HUMAN_SOURCE_RESERVED });
  });

  it('an omitted source keeps a real stored source; a blank one is rejected', () => {
    expect(checkChartUpdate(measured, { csv: ONE })).toEqual({ ok: true, summary: summaryOf('pie', ONE) });
    expect(checkChartUpdate(measured, { csv: ONE, source: '  ' })).toEqual({ ok: false, error: AGENT_SOURCE_RULE });
    expect(checkChartUpdate(measured, { source: '' })).toEqual({ ok: false, error: AGENT_SOURCE_RULE });
  });

  it('parses the merged type, csv and options, as the reducer does', () => {
    const ts = { type: 'timeseries', csv: TS, options: '{"style":"area"}', source: SRC };
    expect(checkChartUpdate(ts, { type: 'waterfall' })).toEqual({ ok: false, error: errorOf('waterfall', TS, '{"style":"area"}') });
    // the stored timeseries option is unknown to bars, so the switch also needs new options
    expect(checkChartUpdate(ts, { type: 'bars' })).toEqual({ ok: false, error: errorOf('bars', TS, '{"style":"area"}') });
    expect(checkChartUpdate(ts, { type: 'bars', options: '{}' })).toEqual({ ok: true, summary: summaryOf('bars', TS, '{}') });
    expect(checkChartUpdate(ts, {})).toEqual({ ok: true, summary: summaryOf('timeseries', TS, '{"style":"area"}') });
  });
});

describe('result texts', () => {
  it('chartSummaryText is one bracketed note: rows, series, x range, warnings', () => {
    expect(chartSummaryText({ rows: 12, series: ['p50', 'p99'], xRange: '10:00 → 11:00', warnings: [] })).toBe(
      ' (12 rows; series: p50, p99; x: 10:00 → 11:00)'
    );
    expect(chartSummaryText({ rows: 1, series: ['latency'], xRange: '', warnings: [] })).toBe(' (1 row; series: latency)');
    expect(chartSummaryText({ rows: 42, series: ['ms'], xRange: '', warnings: ['toplist: showing 10 of 42 rows'] })).toBe(
      ' (42 rows; series: ms; toplist: showing 10 of 42 rows)'
    );
  });

  it('chartNodeSummary gives get_board a summary: never the CSV, never a bigint', () => {
    expect(chartNodeSummary(undefined)).toEqual({ noData: true });
    expect(chartNodeSummary(null)).toEqual({ noData: true });
    const row = { nodeId: 7n, boardId: 1n, type: 'pie', csv: PIE, options: '{}', source: SRC, updatedAt: { microsSinceUnixEpoch: 1n } };
    const s = chartNodeSummary(row);
    expect(s).toEqual({ type: 'pie', source: SRC, rows: summaryOf('pie', PIE).rows, series: ['cost'], warnings: ["pie: 3 slices folded into 'other'"] });
    expect(s).not.toHaveProperty('csv');
    const text = JSON.stringify(s); // throws on a bigint
    expect(text).not.toContain('a,7');
    expect(JSON.parse(JSON.stringify(chartNodeSummary({ ...row, type: 'timeseries', csv: TS })))).not.toHaveProperty('warnings');
    const broken = { type: 'pie', csv: 'service,cost\na,12ms\n', options: '{}', source: SRC };
    expect(chartNodeSummary(broken)).toEqual({ type: 'pie', source: SRC, error: errorOf('pie', broken.csv) });
  });

  it('notAChart and chartTypesText', () => {
    expect(notAChart('12')).toBe('node 12 is not a chart on the active board');
    const text = chartTypesText();
    for (const t of CHART_TYPES) expect(text).toContain(`${t}: ${CHART_CONTRACTS[t].purpose.replace(/\.$/, '')}`);
    expect(text.endsWith('.')).toBe(true);
  });
});
