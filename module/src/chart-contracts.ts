// Chart contracts: the single source of truth for chart data (spec 2026-10-09).
// Zero imports, erasable TypeScript only, ES2021 APIs only: the module bundle, the client,
// the agent and `node --experimental-strip-types` all load this file as is.

export type ChartType = 'timeseries' | 'bars' | 'toplist' | 'pie' | 'treemap' | 'table' | 'stat' | 'waterfall' | 'scatter' | 'schedule' | 'kanban';
export const CHART_TYPES: readonly ChartType[] = ['timeseries', 'bars', 'toplist', 'pie', 'treemap', 'table', 'stat', 'waterfall', 'scatter', 'schedule', 'kanban'];
export function isChartType(type: string): type is ChartType {
  return (CHART_TYPES as readonly string[]).indexOf(type) >= 0;
}

export const MAX_CSV_BYTES = 32768;
export const MAX_LIBRARY_PAYLOAD_BYTES = 262144;
export const MAX_SOURCE_CHARS = 200;
export const MAX_SERIES = 5;
export const CHART_MIN_W = 224;
export const CHART_MIN_H = 144;
export const SAMPLE_SOURCE = 'sample';
export const MAX_OPTIONS_BYTES = 4096;
export const MAX_OPTION_CHARS = 40;

export const CHART_KIND_RULE = 'use create_chart for charts';
export const AGENT_SOURCE_RULE = "agents must say where chart data came from: pass source (for example 'agent: npm run bench @ <sha>')";
export const SAMPLE_RESERVED = "source 'sample' is reserved for library examples; say where the data came from";
export const SAMPLE_NEEDS_SOURCE = 'this chart holds sample data; pass source to say where the new data came from';
export const HUMAN_DATA_NEEDS_SOURCE = "this chart's data came from a person; pass source to say where the new data came from";
export const HUMAN_SOURCE_RESERVED = "agents cannot use a human: source; say what produced the data (for example 'agent: npm run bench @ <sha>')";
/** A source a person stands behind: `human:<name>`, matched as the reducer trims it, in any case. */
export function isHumanSource(source: string): boolean {
  return source.trim().toLowerCase().startsWith('human:');
}
export const ARCHITECTURE_CHART_RULE = 'charts are not supported on architecture boards yet';

export interface ColumnSpec { name: string; type: 'time' | 'number' | 'string' | 'label' | 'any'; count: string; note: string }
export interface OptionSpec {
  name: string;
  kind: 'enum' | 'string' | 'boolean' | 'integer' | 'thresholds';
  values?: readonly string[];
  min?: number; max?: number;
  default: string | number | boolean | readonly unknown[];
  note: string;
}
export interface ChartContract {
  type: ChartType;
  title: string;
  purpose: string;
  columns: readonly ColumnSpec[];
  options: readonly OptionSpec[];
  limits: { minRows: number; maxRows: number; maxSeries?: number };
  renders: string;
  example: string;
}

export interface ChartSummary { rows: number; series: string[]; xRange: string; warnings: string[] }
export type XKind = 'iso' | 'clock' | 'epoch';
export interface TimeseriesData { type: 'timeseries'; options: { style: 'line' | 'area' | 'stacked'; unit: string }; xName: string; xKind: XKind; xs: number[]; series: { name: string; values: (number | null)[] }[] }
export interface BarsData { type: 'bars'; options: { layout: 'stacked' | 'grouped'; orientation: 'vertical' | 'horizontal'; unit: string }; xName: string; categories: string[]; series: { name: string; values: number[] }[] }
export interface ToplistData { type: 'toplist'; options: { limit: number; order: 'desc' | 'asc'; unit: string }; labelName: string; valueName: string; items: { label: string; value: number }[]; totalRows: number }
export interface PieData { type: 'pie'; options: { donut: boolean; unit: string }; valueName: string; slices: { label: string; value: number; other: boolean }[]; total: number }
export interface TreemapData { type: 'treemap'; options: { unit: string }; valueName: string; parents: string[]; leaves: { label: string; value: number; parent: string }[] }
export interface Threshold { column: string; warn: number; crit: number; direction: 'above' | 'below' }
/** `values[r][c]` is the parsed number of a numeric column's cell (U+2212 reads as minus), `null` in a text column. */
export interface TableData { type: 'table'; options: { thresholds: Threshold[] }; header: string[]; numeric: boolean[]; rows: string[][]; values: (number | null)[][] }
export interface StatData { type: 'stat'; options: { unit: string; deltaLabel: string; upIsGood: boolean; precision: number }; valueName: string; value: number; previous: number | null; trend: number[] }
export interface Span { id: string; parentId: string; name: string; service: string; start: number; duration: number; status: 'ok' | 'error'; depth: number }
export interface WaterfallData { type: 'waterfall'; options: Record<string, never>; spans: Span[]; services: string[]; end: number }
/** `group` indexes `groups`; with no group column `groups` is empty and every point is in group 0. */
export interface ScatterPoint { x: number; y: number; group: number; label: string }
export interface ScatterData { type: 'scatter'; options: { xUnit: string; yUnit: string }; xName: string; yName: string; groups: string[]; points: ScatterPoint[] }
export type ScheduleStatus = '' | 'planned' | 'active' | 'done' | 'blocked';
/**
 * `start` and `end` are ms in the column's format, as a timeseries x. An end
 * date without a time takes in that whole day, so `end` is the next midnight.
 * A milestone has no end (`end === start`). `startText` and `endText` are the
 * cells as written. `group` indexes `groups` (0 with no group column).
 */
export interface ScheduleItem { lane: number; label: string; start: number; end: number; milestone: boolean; group: number; status: ScheduleStatus; startText: string; endText: string }
/** `marker` is the `marker` option as a time, or null when it is empty. */
export interface ScheduleData { type: 'schedule'; options: { marker: string }; xKind: XKind; marker: number | null; lanes: string[]; groups: string[]; items: ScheduleItem[] }
/** `lane` indexes `lanes` (0 with no lane column); `group` indexes `groups`, -1 for a card without one. */
export interface KanbanCard { stage: number; lane: number; title: string; detail: string; group: number }
export interface KanbanData { type: 'kanban'; options: Record<string, never>; stages: string[]; lanes: string[]; groups: string[]; cards: KanbanCard[] }
export type ChartData = TimeseriesData | BarsData | ToplistData | PieData | TreemapData | TableData | StatData | WaterfallData | ScatterData | ScheduleData | KanbanData;
export type ParseResult = { ok: true; data: ChartData; summary: ChartSummary } | { ok: false; error: string };

// Thrown by the cell, column and option helpers; parseChart turns it into { ok: false, error }.
export class ChartInputError extends Error {}
const reject = (message: string): never => { throw new ChartInputError(message); };

export function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const at = (row: number, column: string) => `row ${row}, column '${column}'`;
const isBlank = (row: string[]) => row.every(cell => cell.trim() === '');

// True when the first record has a tab outside quotes. A quote opens a quoted field at the start of the
// record or after a comma or tab, and `""` inside quotes is an escaped quote, as in the parser below.
function firstRecordHasTab(text: string): boolean {
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') i++;
        else quoted = false;
      }
    } else if (ch === '"' && (i === 0 || text[i - 1] === ',' || text[i - 1] === '\t')) {
      quoted = true;
    } else if (ch === '\t') {
      return true;
    } else if (ch === '\n' || ch === '\r') {
      return false;
    }
  }
  return false;
}

// RFC 4180 with one delimiter for the whole text: a tab when the first record has one outside quotes, else a comma.
// Rows are numbered as records, so the header is row 1 and the first data row is row 2.
export function parseCsv(csv: string): { ok: true; header: string[]; rows: string[][]; delimiter: ',' | '\t' } | { ok: false; error: string } {
  const bytes = utf8Bytes(csv);
  if (bytes > MAX_CSV_BYTES) return { ok: false, error: `the CSV is ${bytes} bytes; the limit is ${MAX_CSV_BYTES} bytes (32 KB)` };
  const text = csv.charCodeAt(0) === 0xfeff ? csv.slice(1) : csv;
  const delimiter: ',' | '\t' = firstRecordHasTab(text) ? '\t' : ',';
  const records: string[][] = [];
  let row: string[] = [];
  let field = '';
  let fieldStart = true;
  let open = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' && fieldStart) {
      let j = i + 1;
      for (;;) {
        if (j >= text.length) return { ok: false, error: `row ${records.length + 1} has a quote that is never closed` };
        if (text[j] === '"') {
          if (text[j + 1] === '"') { field += '"'; j += 2; continue; }
          break;
        }
        field += text[j];
        j++;
      }
      i = j + 1;
      const next = text[i];
      if (i < text.length && next !== delimiter && next !== '\n' && next !== '\r') {
        return { ok: false, error: `row ${records.length + 1} has text after a closing quote; put the whole field inside the quotes` };
      }
      fieldStart = false;
      open = true;
      continue;
    }
    if (ch === delimiter) {
      row.push(field);
      field = '';
      fieldStart = true;
      open = true;
      i++;
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      row.push(field);
      records.push(row);
      row = [];
      field = '';
      fieldStart = true;
      open = false;
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    field += ch;
    fieldStart = false;
    open = true;
    i++;
  }
  if (open) {
    row.push(field);
    records.push(row);
  }
  while (records.length > 0 && isBlank(records[records.length - 1])) records.pop();
  if (records.length === 0) return { ok: false, error: 'the CSV is empty; put the column names on the first line' };
  const width = records[0].length;
  for (let r = 0; r < records.length; r++) {
    if (isBlank(records[r])) return { ok: false, error: `row ${r + 1} is blank; delete it or fill it in` };
    if (records[r].length !== width) return { ok: false, error: `row ${r + 1} has ${plural(records[r].length, 'cell')}; the header has ${width}` };
  }
  return { ok: true, header: records[0], rows: records.slice(1), delimiter };
}

// One way to split a digit run: `\d+\.?\d*` backtracked quadratically on a long cell that fails.
const NUMBER_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const THOUSANDS_RE = /^[+-]?\d{1,3}(?:[, _]\d{3})+(?:\.\d+)?$/;
// One number next to letters, % or a currency sign, such as 12ms, 95%, $1.6k or 12.5 ms.
// '(5)', '5-', '#12' or '<5' get the plain sentence: a unit option cannot fix them.
const UNIT_HINT_RE = /^(?=.*[\p{L}%$€£¥₹])(?:[\p{L}%$€£¥₹]+ ?)?[+\-\u2212]?\d+(?:\.\d+)?(?: ?[\p{L}%$€£¥₹]+)?$/u;
/** A plain decimal, reading a leading U+2212 as the minus sign (spreadsheets paste it). */
const minusSign = (s: string): string => (s.charCodeAt(0) === 0x2212 ? '-' + s.slice(1) : s);

// One cell as a plain decimal. `row` is the record number (header = 1); `unitOption` is the option a unit belongs in.
export function parseNumberCell(cell: string, row: number, column: string, unitOption = 'unit'): number {
  const s = cell.trim();
  if (s === '') return reject(`${at(row, column)} is empty; every row needs a number`);
  const n = minusSign(s);
  if (NUMBER_RE.test(n)) {
    const v = Number(n);
    if (!Number.isFinite(v)) return reject(`${at(row, column)}: '${s}' is too large`);
    return v === 0 ? 0 : v; // '-0' is 0
  }
  if (THOUSANDS_RE.test(n)) return reject(`${at(row, column)}: '${s}' has a thousands separator; write ${n.replace(/[, _]/g, '')}`);
  if (UNIT_HINT_RE.test(s)) return reject(`${at(row, column)}: '${s}' is not a number; put the unit in the ${unitOption} option`);
  return reject(`${at(row, column)}: '${s}' is not a number`);
}

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})?)?$/i;
const CLOCK_RE = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;
const EPOCH_RE = /^\d+$/;
const TIME_HELP = 'use ISO 8601 (2026-10-09T10:00:00Z), HH:MM[:SS], or epoch milliseconds';
const KIND_WORDS: Record<XKind, string> = { iso: 'ISO 8601', clock: 'HH:MM[:SS]', epoch: 'epoch milliseconds' };
/** The last instant a Date can hold (year 275760): a later epoch has no date to draw or label. */
const MAX_EPOCH_MS = 8.64e15;
/** Why `s` is not a time, said of `where` (a cell or an option). Only an epoch past MAX_EPOCH_MS is all digits. */
const notATime = (where: string, s: string) => (EPOCH_RE.test(s)
  ? `${where}: '${s}' is past the last date a chart can show; epoch milliseconds go up to ${MAX_EPOCH_MS}`
  : `${where}: '${s}' is not a time; ${TIME_HELP}`);

// ISO date-times without an offset are UTC, so the server and every browser get the same instant.
function timeValue(s: string): { kind: XKind; ms: number } | null {
  const iso = ISO_RE.exec(s);
  if (iso) {
    const y = +iso[1], mo = +iso[2], d = +iso[3];
    const h = iso[4] ? +iso[4] : 0, mi = iso[5] ? +iso[5] : 0, sec = iso[6] ? +iso[6] : 0;
    const frac = iso[7] ? +(iso[7] + '00').slice(0, 3) : 0; // 1 to 9 digits, cut to milliseconds
    const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth || h > 23 || mi > 59 || sec > 59) return null;
    let offset = 0;
    const tz = iso[8];
    if (tz && tz.toUpperCase() !== 'Z') {
      const oh = +tz.slice(1, 3), om = +tz.slice(4, 6);
      if (oh > 23 || om > 59) return null;
      offset = (tz[0] === '-' ? -1 : 1) * (oh * 60 + om);
    }
    const base = new Date(0);
    base.setUTCFullYear(y, mo - 1, d); // Date.UTC maps years 0-99 to 1900-1999
    base.setUTCHours(h, mi, sec, frac);
    return { kind: 'iso', ms: base.getTime() - offset * 60000 };
  }
  const clock = CLOCK_RE.exec(s);
  if (clock) {
    const h = +clock[1], mi = +clock[2], sec = clock[3] ? +clock[3] : 0;
    if (h > 23 || mi > 59 || sec > 59) return null;
    return { kind: 'clock', ms: ((h * 60 + mi) * 60 + sec) * 1000 };
  }
  if (EPOCH_RE.test(s)) {
    const ms = Number(s);
    return ms <= MAX_EPOCH_MS ? { kind: 'epoch', ms } : null;
  }
  return null;
}

// A whole time column: one format throughout (taken from the first row), strictly ascending.
// `firstRow` is the record number of cells[0].
export function parseTimeColumn(cells: readonly string[], column: string, firstRow: number): { kind: XKind; xs: number[] } {
  let kind: XKind | null = null;
  let firstKindRow = firstRow;
  const xs: number[] = [];
  for (let i = 0; i < cells.length; i++) {
    const row = firstRow + i;
    const s = cells[i].trim();
    if (s === '') return reject(`${at(row, column)} is empty; every row needs a time`);
    const t = timeValue(s);
    if (!t) return reject(notATime(at(row, column), s));
    if (kind === null) { kind = t.kind; firstKindRow = row; }
    if (t.kind !== kind) return reject(`${at(row, column)}: '${s}' is not ${KIND_WORDS[kind]} like row ${firstKindRow}; use one time format in the column`);
    if (xs.length > 0 && t.ms <= xs[xs.length - 1]) return reject(`${at(row, column)}: '${s}' is not later than row ${row - 1}; sort the rows by time, oldest first`);
    xs.push(t.ms);
  }
  return { kind: kind === null ? 'iso' : kind, xs };
}

const THRESHOLD_FIELDS = ['column', 'warn', 'crit', 'direction'];

function parseThresholds(value: unknown): Threshold[] {
  if (!Array.isArray(value)) return reject(`option 'thresholds' must be a list of {column, warn, crit, direction}; got ${JSON.stringify(value)}`);
  if (value.length > 8) return reject(`option 'thresholds' allows at most 8 entries; got ${value.length}`);
  return value.map((raw: unknown, i) => {
    const n = i + 1;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return reject(`threshold ${n} must be an object with column, warn, crit and direction`);
    const t = raw as Record<string, unknown>;
    for (const key of Object.keys(t)) {
      if (THRESHOLD_FIELDS.indexOf(key) < 0) return reject(`threshold ${n} has no field '${key}'; fields are ${THRESHOLD_FIELDS.join(', ')}`);
    }
    if (typeof t.column !== 'string' || t.column.trim() === '') return reject(`threshold ${n}: column must be a column name; got ${JSON.stringify(t.column)}`);
    if (typeof t.warn !== 'number' || !Number.isFinite(t.warn)) return reject(`threshold ${n}: warn must be a number; got ${JSON.stringify(t.warn)}`);
    if (typeof t.crit !== 'number' || !Number.isFinite(t.crit)) return reject(`threshold ${n}: crit must be a number; got ${JSON.stringify(t.crit)}`);
    const direction = t.direction === undefined ? 'above' : t.direction;
    if (direction !== 'above' && direction !== 'below') return reject(`threshold ${n}: direction must be above or below; got ${JSON.stringify(t.direction)}`);
    if (direction === 'above' && t.warn > t.crit) return reject(`threshold ${n}: with direction above, warn (${t.warn}) must not be greater than crit (${t.crit})`);
    if (direction === 'below' && t.warn < t.crit) return reject(`threshold ${n}: with direction below, warn (${t.warn}) must not be less than crit (${t.crit})`);
    return { column: t.column.trim(), warn: t.warn, crit: t.crit, direction };
  });
}

// The options JSON checked against a contract's option list. Every option comes back, with defaults filled in.
export function parseOptions(type: string, specs: readonly OptionSpec[], json: string): Record<string, unknown> {
  const text = json.trim() === '' ? '{}' : json;
  const bytes = utf8Bytes(text);
  if (bytes > MAX_OPTIONS_BYTES) return reject(`options are ${bytes} bytes; the limit is ${MAX_OPTIONS_BYTES} bytes`);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    raw = undefined;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return reject('options must be a JSON object, for example {"unit":"ms"}');
  const given = raw as Record<string, unknown>;
  const names = specs.map(s => s.name);
  for (const key of Object.keys(given)) {
    if (names.indexOf(key) < 0) {
      return reject(specs.length === 0 ? `${type} has no options; pass {}` : `${type} has no option '${key}'; options are ${names.join(', ')}`);
    }
  }
  const out: Record<string, unknown> = {};
  for (const spec of specs) {
    const has = Object.prototype.hasOwnProperty.call(given, spec.name);
    const v = given[spec.name];
    const got = JSON.stringify(v);
    if (!has) {
      out[spec.name] = Array.isArray(spec.default) ? spec.default.slice() : spec.default;
    } else if (spec.kind === 'enum') {
      const values = spec.values || [];
      if (typeof v !== 'string' || values.indexOf(v) < 0) return reject(`option '${spec.name}' must be one of ${values.join(', ')}; got ${got}`);
      out[spec.name] = v;
    } else if (spec.kind === 'string') {
      if (typeof v !== 'string') return reject(`option '${spec.name}' must be a string; got ${got}`);
      if (v.length > MAX_OPTION_CHARS) return reject(`option '${spec.name}' is ${v.length} characters; the limit is ${MAX_OPTION_CHARS}`);
      out[spec.name] = v;
    } else if (spec.kind === 'boolean') {
      if (typeof v !== 'boolean') return reject(`option '${spec.name}' must be true or false; got ${got}`);
      out[spec.name] = v;
    } else if (spec.kind === 'integer') {
      const min = spec.min === undefined ? 0 : spec.min, max = spec.max === undefined ? Number.MAX_SAFE_INTEGER : spec.max;
      if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) return reject(`option '${spec.name}' must be a whole number from ${min} to ${max}; got ${got}`);
      out[spec.name] = v;
    } else {
      out[spec.name] = parseThresholds(v);
    }
  }
  return out;
}

const UNIT: OptionSpec = { name: 'unit', kind: 'string', default: '', note: "shown after values, for example 'ms', '%' or 'req/s'; at most 40 characters" };

export const CHART_CONTRACTS: Readonly<Record<ChartType, ChartContract>> = {
  timeseries: {
    type: 'timeseries',
    title: 'Time series',
    purpose: 'Use for one to five measurements over time, such as p99 latency before and after a change.',
    columns: [
      { name: 'x', type: 'time', count: '1', note: 'ISO 8601 (2026-10-09T10:00:00Z; no offset means UTC), HH:MM[:SS], or epoch milliseconds; one format; strictly ascending' },
      { name: 'series', type: 'number', count: '1-5', note: 'one column per series, named by its header; an empty cell is a gap in the line' },
    ],
    options: [
      { name: 'style', kind: 'enum', values: ['line', 'area', 'stacked'], default: 'line', note: 'stacked needs values of 0 or more' },
      UNIT,
    ],
    limits: { minRows: 2, maxRows: 500, maxSeries: 5 },
    renders: 'One 2 px line per series on a shared time axis, with end labels and a hover crosshair.',
    example: 'time,checkout,search\n10:00,120,95\n10:05,135,98\n10:10,180,102\n10:15,160,99\n10:20,140,97\n10:25,128,96\n10:30,122,98\n',
  },
  bars: {
    type: 'bars',
    title: 'Bars',
    purpose: 'Use to compare one to five measurements across categories or time buckets, such as requests per hour by region.',
    columns: [
      { name: 'x', type: 'label', count: '1', note: 'a category or time label per row, shown in row order' },
      { name: 'series', type: 'number', count: '1-5', note: 'one column per series, named by its header; every cell needs a number' },
    ],
    options: [
      { name: 'layout', kind: 'enum', values: ['stacked', 'grouped'], default: 'stacked', note: 'stacked needs values of 0 or more' },
      { name: 'orientation', kind: 'enum', values: ['vertical', 'horizontal'], default: 'vertical', note: 'horizontal suits long labels' },
      UNIT,
    ],
    limits: { minRows: 1, maxRows: 50, maxSeries: 5 },
    renders: 'One bar per row, at most 24 px thick, stacked or side by side per series, with a legend for two or more series.',
    example: 'hour,us-east,eu-west,ap-south\n09:00,30400,20100,9800\n10:00,34100,22300,12200\n11:00,40200,25400,13900\n12:00,52300,30100,15200\n13:00,60100,28400,17800\n14:00,55200,26300,16100\n15:00,48300,24200,14400\n16:00,42100,22100,12300\n',
  },
  toplist: {
    type: 'toplist',
    title: 'Top list',
    purpose: 'Use to rank items by one value, such as the slowest endpoints by p99 latency.',
    columns: [
      { name: 'label', type: 'label', count: '1', note: 'the item name' },
      { name: 'value', type: 'number', count: '1', note: 'the ranking value; the header names it' },
    ],
    options: [
      { name: 'limit', kind: 'integer', min: 1, max: 25, default: 10, note: 'rows past the limit are cut and the cut is reported' },
      { name: 'order', kind: 'enum', values: ['desc', 'asc'], default: 'desc', note: 'desc puts the largest value first' },
      UNIT,
    ],
    limits: { minRows: 1, maxRows: 500 },
    renders: 'A ranked list with the rank, the label, a bar scaled to the top value, and the value.',
    example: 'endpoint,p99_ms\n/checkout,1840\n/search,1210\n/cart/items,880\n/login,512\n/api/v2/orders,301\n/health,12\n',
  },
  pie: {
    type: 'pie',
    title: 'Pie',
    purpose: 'Use to show how a whole splits into a few parts, such as sessions by client.',
    columns: [
      { name: 'label', type: 'label', count: '1', note: 'the slice name' },
      { name: 'value', type: 'number', count: '1', note: '0 or more; the values must add up to more than 0' },
    ],
    options: [
      { name: 'donut', kind: 'boolean', default: true, note: 'a ring with the total in the middle' },
      UNIT,
    ],
    limits: { minRows: 1, maxRows: 50 },
    renders: 'Slices largest first; with more than 5 slices the top 4 stay and the rest fold into one other slice; a legend shows each share.',
    example: 'client,sessions\nweb,1104000\nios,648000\nandroid,456000\napi,192000\n',
  },
  treemap: {
    type: 'treemap',
    title: 'Treemap',
    purpose: 'Use to show the size of many parts of a whole, optionally in up to 5 groups, such as cost by service.',
    columns: [
      { name: 'label', type: 'label', count: '1', note: 'the leaf name' },
      { name: 'value', type: 'number', count: '1', note: '0 or more; the values must add up to more than 0' },
      { name: 'parent', type: 'label', count: '0-1', note: 'optional group name, one level; when present every row needs one and a group cannot also be a leaf' },
    ],
    options: [UNIT],
    limits: { minRows: 1, maxRows: 100 },
    renders: 'Rectangles with areas proportional to value, separated by 2 px gaps and colored by group.',
    example: 'service,cost,group\ncheckout,4100,app services\ncart,1600,app services\nsearch,1300,app services\npostgres,2200,data stores\nredis,900,data stores\nkafka,800,data stores\n',
  },
  table: {
    type: 'table',
    title: 'Table',
    purpose: 'Use for exact values across a few columns, such as per-host CPU, memory and latency.',
    columns: [
      { name: 'columns', type: 'any', count: '1-8', note: 'any text; a column whose every cell is a number is right-aligned and can carry a threshold' },
    ],
    options: [
      {
        name: 'thresholds',
        kind: 'thresholds',
        default: [],
        note: 'marks number cells, for example [{"column":"cpu","warn":80,"crit":90,"direction":"above"}]; direction is above (default) or below',
      },
    ],
    limits: { minRows: 1, maxRows: 50 },
    renders: 'A text table with a header row, number columns right-aligned, and a status glyph on cells past a threshold.',
    example: 'host,cpu,mem_gb,p50_ms\napi-1,72,1.2,41\napi-2,94,1.9,88\nworker-1,38,0.8,12\ndb-primary,61,6.1,4\n',
  },
  stat: {
    type: 'stat',
    title: 'Stat',
    purpose: 'Use for one headline number with its change and trend, such as weekly availability.',
    columns: [
      { name: 'x', type: 'label', count: '0-1', note: 'optional row label, such as a date; not shown' },
      { name: 'value', type: 'number', count: '1', note: 'the last row is the current value, the row before it is the delta base, every row is the sparkline' },
    ],
    options: [
      UNIT,
      { name: 'deltaLabel', kind: 'string', default: 'vs previous', note: 'shown after the change, for example "vs last week"' },
      { name: 'upIsGood', kind: 'boolean', default: true, note: 'false when a rise is bad, as for latency or errors' },
      { name: 'precision', kind: 'integer', min: 0, max: 4, default: 2, note: 'decimal places for the value and the change' },
    ],
    limits: { minRows: 1, maxRows: 60 },
    renders: 'A large current value, the change from the previous row with an arrow, and a sparkline of every row.',
    example: 'week,availability\nW29,99.91\nW30,99.93\nW31,99.90\nW32,99.94\nW33,99.95\nW34,99.92\nW35,99.96\nW36,99.94\nW37,99.95\nW38,99.97\nW39,99.94\nW40,99.95\n',
  },
  waterfall: {
    type: 'waterfall',
    title: 'Waterfall',
    purpose: 'Use for one trace: spans with parents, start times and durations, such as a slow checkout request.',
    columns: [
      { name: 'span_id', type: 'string', count: '1', note: 'unique per span' },
      { name: 'parent_id', type: 'string', count: '1', note: 'empty for a root span; otherwise an existing span_id; no cycles' },
      { name: 'name', type: 'string', count: '1', note: 'the operation' },
      { name: 'service', type: 'string', count: '1', note: 'colors the bar; more than 5 services fold the rest into other services' },
      { name: 'start_ms', type: 'number', count: '1', note: 'start offset in ms, 0 or more' },
      { name: 'duration_ms', type: 'number', count: '1', note: 'duration in ms, 0 or more' },
      { name: 'status', type: 'string', count: '0-1', note: 'ok (default) or error' },
    ],
    options: [],
    limits: { minRows: 1, maxRows: 200 },
    renders: 'One row per span in tree order, indented by depth, with a bar on a shared ms axis colored by service and an icon on error spans.',
    example: 'span_id,parent_id,name,service,start_ms,duration_ms,status\n1,,POST /checkout,web,0,420,error\n2,1,auth.verify,auth,6,32,ok\n3,1,cart.load,cart,42,90,ok\n4,3,SELECT cart_items,postgres,48,64,ok\n5,1,inventory.reserve,cart,136,44,ok\n6,1,payment.charge,payments,140,270,error\n7,6,POST /v1/charges,payments,150,250,error\n',
  },
  scatter: {
    type: 'scatter',
    title: 'Scatter',
    purpose: 'Use to show how two measurements relate across many items, such as p99 latency against payload size per endpoint.',
    columns: [
      { name: 'x', type: 'number', count: '1', note: 'the first column not named group or label: the horizontal value; its header names the axis' },
      { name: 'y', type: 'number', count: '1', note: 'the next column not named group or label: the vertical value; its header names the axis' },
      { name: 'group', type: 'label', count: '0-1', note: "optional, found by the header 'group': colours the points, at most 5 groups; every row needs one" },
      { name: 'label', type: 'string', count: '0-1', note: "optional, found by the header 'label': names the point in the readout; may be empty" },
    ],
    options: [
      { name: 'xUnit', kind: 'string', default: '', note: "shown after x values, for example 'KB'; at most 40 characters" },
      { name: 'yUnit', kind: 'string', default: '', note: "shown after y values, for example 'ms'; at most 40 characters" },
    ],
    limits: { minRows: 1, maxRows: 500 },
    renders: 'One ringed dot per row on two value axes that hug the data, coloured by group, with a legend for two or more groups.',
    example: 'label,payload_kb,p99_ms,group\n/checkout,48,1240,web\n/cart/items,6,610,web\n/search,12,1380,web\n/product/:id,22,520,web\n/home,30,880,web\n/login,2,340,auth\n/token,1,96,auth\n/session,4,180,auth\n/orders,64,1120,orders\n/orders/:id,8,301,orders\n/orders/export,92,2210,orders\n/refunds,40,1720,orders\n',
  },
  schedule: {
    type: 'schedule',
    title: 'Schedule',
    purpose: 'Use for work laid out in time across a few lanes, such as a migration plan by team or an on-call rotation.',
    columns: [
      { name: 'lane', type: 'label', count: '1', note: 'the first column not named group or status: the row the item sits in, such as a team or a person; lanes keep their first-seen order; at most 12' },
      { name: 'item', type: 'string', count: '1', note: 'the next such column: the item name, drawn on or beside its bar' },
      { name: 'start', type: 'time', count: '1', note: 'the next such column: ISO 8601 (2026-10-09 or 2026-10-09T10:00:00Z; no offset means UTC), HH:MM[:SS], or epoch milliseconds; one format in start and end' },
      { name: 'end', type: 'time', count: '1', note: 'the next such column: at or after start; an end date without a time includes that day; empty for a milestone' },
      { name: 'group', type: 'label', count: '0-1', note: "optional, found by the header 'group': colours the bars, at most 5 groups; every row needs one" },
      { name: 'status', type: 'string', count: '0-1', note: "optional, found by the header 'status': planned (outlined), active, done (✓) or blocked (!), or empty" },
    ],
    options: [
      { name: 'marker', kind: 'string', default: '', note: 'a time to mark with a dashed line, such as the day the chart was drawn (2026-10-18), in the format of the start column; empty for none' },
    ],
    limits: { minRows: 1, maxRows: 100 },
    renders: 'One row per lane with a bar from start to end on a shared time axis, a diamond per milestone, overlapping items stacked inside their lane, and an optional dashed marker line.',
    example: 'lane,item,start,end,status\nplatform,schema v2,2026-10-01,2026-10-07,done\nplatform,backfill,2026-10-08,2026-10-16,active\nplatform,cutover,2026-10-22,,planned\napi,dual writes,2026-10-05,2026-10-13,done\napi,read switch,2026-10-14,2026-10-21,planned\nweb,checkout v2,2026-10-07,2026-10-19,active\nweb,load test,2026-10-20,2026-10-25,blocked\nweb,launch,2026-10-29,,planned\n',
  },
  kanban: {
    type: 'kanban',
    title: 'Kanban',
    purpose: 'Use for work items by stage, such as the open tasks of a migration by status, optionally in swim lanes by team.',
    columns: [
      { name: 'stage', type: 'label', count: '1', note: 'the first column not named lane, group or detail: the board column the card sits in, such as todo, doing or done; stages keep their first-seen order; at most 8' },
      { name: 'card', type: 'string', count: '1', note: 'the next such column: the card title; an empty card adds its stage (and lane) with no card, so an empty column still shows' },
      { name: 'lane', type: 'label', count: '0-1', note: "optional, found by the header 'lane': a swim lane across the columns, such as a team; at most 6; every row needs one" },
      { name: 'group', type: 'label', count: '0-1', note: "optional, found by the header 'group': colours the card's edge, at most 5 groups; may be empty" },
      { name: 'detail', type: 'string', count: '0-1', note: "optional, found by the header 'detail': a second line on the card, such as a ticket or an owner; may be empty" },
    ],
    options: [],
    limits: { minRows: 1, maxRows: 100 },
    renders: 'Columns of cards under their stage names and card counts, split into swim lanes when there is a lane column; when a column runs out of room, its last card shown counts the rest (+N).',
    example: 'stage,card,lane,detail\ntodo,Rate-limit login,api,RC-612\ntodo,Retry webhooks,api,RC-618\ndoing,Split cart service,api,RC-597 · alice\ndone,Drop legacy tokens,api,RC-580\ntodo,Chart dark mode,web,RC-631\ndoing,Library search,web,RC-622 · bo\ndone,Share menu,web,RC-604\n',
  },
};

const COLUMN_SHAPE: Record<ChartType, [number, number, string]> = {
  timeseries: [2, Infinity, 'a time column and at least one number column'],
  bars: [2, Infinity, 'a label column and at least one number column'],
  toplist: [2, 2, 'exactly 2 columns (label, value)'],
  pie: [2, 2, 'exactly 2 columns (label, value)'],
  treemap: [2, 3, '2 or 3 columns (label, value, optional parent)'],
  table: [1, 8, '1 to 8 columns'],
  stat: [1, 2, '1 or 2 columns (value, or x and value)'],
  waterfall: [1, Infinity, ''],
  scatter: [2, 4, 'an x column and a y column, then optional group and label columns'],
  schedule: [4, 6, 'lane, item, start and end columns, then optional group and status columns'],
  kanban: [2, 5, 'a stage column and a card column, then optional lane, group and detail columns'],
};
const WATERFALL_COLUMNS = ['span_id', 'parent_id', 'name', 'service', 'start_ms', 'duration_ms', 'status'];
const WATERFALL_HELP = 'use span_id, parent_id, name, service, start_ms, duration_ms, and optional status';
const OTHER_SERVICES = 'other services';

type Table = { header: string[]; rows: string[][] };
type Parsed = { data: ChartData; summary: ChartSummary };

const columnCells = (t: Table, c: number) => t.rows.map(r => r[c]);
const label = (cell: string, row: number, name: string) => (cell === '' ? reject(`${at(row, name)} is empty; every row needs a label`) : cell);
const atLeastZero = (v: number, cell: string, row: number, name: string, what: string) =>
  (v < 0 ? reject(`${at(row, name)}: ${what} must be 0 or more; got ${cell}`) : v);
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
// Sums of cells that are each finite can still overflow to Infinity, which would reach drawn text.
const finite = (type: ChartType, total: number) => (Number.isFinite(total) ? total : reject(`${type} values are too large; a total is not a finite number`));
// A stacked chart draws each row's values added together.
const finiteStacks = (type: ChartType, s: { values: (number | null)[] }[]) => {
  s[0].values.forEach((_, i) => finite(type, sum(s.map(x => x.values[i] || 0))));
};
// Stable sort by value; ties keep input order.
const byValue = <T extends { value: number }>(items: T[], order: 'desc' | 'asc') =>
  items.map((item, i) => ({ item, i }))
    .sort((a, b) => (order === 'desc' ? b.item.value - a.item.value : a.item.value - b.item.value) || a.i - b.i)
    .map(x => x.item);

function series(t: Table, stacked: boolean, gaps: boolean) {
  return t.header.slice(1).map((name, s) => {
    const values = t.rows.map((r, i) => {
      if (gaps && r[s + 1] === '') return null;
      const v = parseNumberCell(r[s + 1], i + 2, name);
      return stacked ? atLeastZero(v, r[s + 1], i + 2, name, 'stacked values') : v;
    });
    if (values.every(v => v === null)) reject(`column '${name}' has no numbers; fill at least one cell`);
    return { name, values };
  });
}

function timeseries(t: Table, o: Record<string, unknown>): Parsed {
  const options = o as TimeseriesData['options'];
  const { kind, xs } = parseTimeColumn(columnCells(t, 0), t.header[0], 2);
  const s = series(t, options.style === 'stacked', true);
  if (options.style === 'stacked') finiteStacks('timeseries', s);
  const data: TimeseriesData = { type: 'timeseries', options, xName: t.header[0], xKind: kind, xs, series: s };
  return { data, summary: { rows: t.rows.length, series: s.map(x => x.name), xRange: `${t.rows[0][0]} → ${t.rows[t.rows.length - 1][0]}`, warnings: [] } };
}

function bars(t: Table, o: Record<string, unknown>): Parsed {
  const options = o as BarsData['options'];
  const categories = t.rows.map((r, i) => label(r[0], i + 2, t.header[0]));
  const s = series(t, options.layout === 'stacked', false) as { name: string; values: number[] }[];
  if (options.layout === 'stacked') finiteStacks('bars', s);
  const data: BarsData = { type: 'bars', options, xName: t.header[0], categories, series: s };
  return { data, summary: { rows: t.rows.length, series: s.map(x => x.name), xRange: `${categories[0]} → ${categories[categories.length - 1]}`, warnings: [] } };
}

function labelled(t: Table, what: string | null) {
  return t.rows.map((r, i) => {
    const v = parseNumberCell(r[1], i + 2, t.header[1]);
    return { label: label(r[0], i + 2, t.header[0]), value: what ? atLeastZero(v, r[1], i + 2, t.header[1], what) : v };
  });
}

function toplist(t: Table, o: Record<string, unknown>): Parsed {
  const options = o as ToplistData['options'];
  const all = byValue(labelled(t, null), options.order);
  const items = all.slice(0, options.limit);
  const warnings = all.length > items.length ? [`toplist: showing ${items.length} of ${all.length} rows`] : [];
  const data: ToplistData = { type: 'toplist', options, labelName: t.header[0], valueName: t.header[1], items, totalRows: all.length };
  return { data, summary: { rows: t.rows.length, series: [t.header[1]], xRange: '', warnings } };
}

function pie(t: Table, o: Record<string, unknown>): Parsed {
  const options = o as PieData['options'];
  const sorted = byValue(labelled(t, 'pie values'), 'desc');
  const total = finite('pie', sum(sorted.map(x => x.value)));
  if (total <= 0) reject('pie values add up to 0; at least one value must be greater than 0');
  const warnings: string[] = [];
  let slices = sorted.map(x => ({ label: x.label, value: x.value, other: false }));
  if (slices.length > 5) {
    const rest = slices.slice(4);
    slices = slices.slice(0, 4).concat([{ label: 'other', value: sum(rest.map(x => x.value)), other: true }]);
    warnings.push(`pie: ${rest.length} slices folded into 'other'`);
  }
  const data: PieData = { type: 'pie', options, valueName: t.header[1], slices, total };
  return { data, summary: { rows: t.rows.length, series: [t.header[1]], xRange: '', warnings } };
}

function treemap(t: Table, o: Record<string, unknown>): Parsed {
  const options = o as TreemapData['options'];
  const leaves = labelled(t, 'treemap values').map((x, i) => ({
    label: x.label,
    value: x.value,
    parent: t.header.length === 3 ? (t.rows[i][2] === '' ? reject(`${at(i + 2, t.header[2])} is empty; every row needs a parent when there is a parent column`) : t.rows[i][2]) : '',
  }));
  if (finite('treemap', sum(leaves.map(x => x.value))) <= 0) reject('treemap values add up to 0; at least one value must be greater than 0');
  // Parents come from the leaves, so every parent groups at least one leaf by construction.
  const parents: string[] = [];
  for (const leaf of leaves) if (leaf.parent !== '' && parents.indexOf(leaf.parent) < 0) parents.push(leaf.parent);
  if (parents.length > 5) reject(`treemap allows at most 5 parents; got ${parents.length} — merge small groups or split into two charts`);
  leaves.forEach((leaf, i) => {
    if (parents.indexOf(leaf.label) >= 0) reject(`row ${i + 2}: '${leaf.label}' is both a leaf and a parent; treemaps have one level`);
  });
  for (const p of parents) {
    if (sum(leaves.filter(l => l.parent === p).map(l => l.value)) <= 0) reject(`parent '${p}' adds up to 0; give one of its leaves a value greater than 0`);
  }
  const data: TreemapData = { type: 'treemap', options, valueName: t.header[1], parents, leaves };
  return { data, summary: { rows: t.rows.length, series: [t.header[1]], xRange: '', warnings: [] } };
}

function table(t: Table, o: Record<string, unknown>): Parsed {
  const thresholds = o.thresholds as Threshold[];
  // The one cell parser for tables: it decides which columns are numeric and gives `values`.
  const cellNumber = (s: string): number | null => {
    const n = minusSign(s);
    return NUMBER_RE.test(n) && Number.isFinite(Number(n)) ? Number(n) : null;
  };
  const parsed = t.rows.map(r => r.map(s => cellNumber(s)));
  const numeric = t.header.map((_, c) => parsed.every(r => r[c] !== null));
  const seen: string[] = [];
  thresholds.forEach((th, i) => {
    const c = t.header.indexOf(th.column);
    if (c < 0) reject(`threshold ${i + 1}: column '${th.column}' is not in the header; columns are ${t.header.join(', ')}`);
    if (seen.indexOf(th.column) >= 0) reject(`threshold ${i + 1}: column '${th.column}' already has a threshold`);
    seen.push(th.column);
    if (!numeric[c]) {
      const bad = parsed.findIndex(r => r[c] === null);
      reject(`threshold ${i + 1}: column '${th.column}' must hold only numbers; row ${bad + 2} holds '${t.rows[bad][c]}'`);
    }
  });
  const values = parsed.map(r => r.map((v, c) => (numeric[c] ? v : null)));
  const data: TableData = { type: 'table', options: { thresholds }, header: t.header, numeric, rows: t.rows, values };
  return { data, summary: { rows: t.rows.length, series: t.header.slice(), xRange: '', warnings: [] } };
}

function stat(t: Table, o: Record<string, unknown>): Parsed {
  const options = o as StatData['options'];
  const c = t.header.length - 1;
  const trend = t.rows.map((r, i) => parseNumberCell(r[c], i + 2, t.header[c]));
  const value = trend[trend.length - 1];
  const previous = trend.length > 1 ? trend[trend.length - 2] : null;
  const data: StatData = { type: 'stat', options, valueName: t.header[c], value, previous, trend };
  return { data, summary: { rows: t.rows.length, series: [t.header[c]], xRange: '', warnings: [] } };
}

function waterfall(t: Table): Parsed {
  for (const name of t.header) if (WATERFALL_COLUMNS.indexOf(name) < 0) reject(`waterfall has no column '${name}'; ${WATERFALL_HELP}`);
  for (const name of WATERFALL_COLUMNS.slice(0, 6)) if (t.header.indexOf(name) < 0) reject(`waterfall needs a '${name}' column; ${WATERFALL_HELP}`);
  const col = (name: string) => t.header.indexOf(name);
  const need = (r: string[], row: number, name: string, what: string) => (r[col(name)] === '' ? reject(`${at(row, name)} is empty; every span needs ${what}`) : r[col(name)]);
  const time = (r: string[], row: number, name: string) => atLeastZero(parseNumberCell(r[col(name)], row, name), r[col(name)], row, name, 'waterfall times');
  // Map, not a plain object: span ids are user text and may be 'constructor' or '__proto__'.
  const byId = new Map<string, number>();
  const spans = t.rows.map((r, i): Span => {
    const row = i + 2;
    const id = need(r, row, 'span_id', 'an id');
    if (byId.has(id)) reject(`row ${row}: span_id '${id}' is used twice; span ids must be unique`);
    byId.set(id, i);
    const rawStatus = col('status') < 0 ? '' : r[col('status')].toLowerCase();
    if (rawStatus !== '' && rawStatus !== 'ok' && rawStatus !== 'error') reject(`${at(row, 'status')}: '${r[col('status')]}' is not a status; use ok or error`);
    return {
      id,
      parentId: r[col('parent_id')],
      name: need(r, row, 'name', 'a name'),
      service: need(r, row, 'service', 'a service'),
      start: time(r, row, 'start_ms'),
      duration: time(r, row, 'duration_ms'),
      status: rawStatus === 'error' ? 'error' : 'ok',
      depth: 0,
    };
  });
  spans.forEach((s, i) => {
    if (s.parentId !== '' && !byId.has(s.parentId)) {
      reject(`row ${i + 2}: parent_id '${s.parentId}' is not a span_id in this CSV; leave it empty for a root span`);
    }
  });
  // Each span has at most one parent, so following parents from every span finds every cycle.
  const state = spans.map(() => 0); // 0 new, 1 on the current path, 2 done
  spans.forEach((_, start) => {
    const path: number[] = [];
    let cur = start;
    while (cur >= 0 && state[cur] === 0) {
      state[cur] = 1;
      path.push(cur);
      cur = spans[cur].parentId === '' ? -1 : byId.get(spans[cur].parentId) as number;
    }
    if (cur >= 0 && state[cur] === 1) {
      const loop = path.slice(path.indexOf(cur)).concat([cur]).map(k => spans[k].id);
      reject(`span '${loop[0]}' is in a parent cycle (${loop.join(' → ')}); every chain must end at a root span`);
    }
    for (const k of path) state[k] = 2;
  });
  const children = new Map<string, number[]>();
  spans.forEach((s, i) => { const kids = children.get(s.parentId); if (kids) kids.push(i); else children.set(s.parentId, [i]); });
  const ordered: Span[] = [];
  const visit = (parentId: string, depth: number) => {
    const kids = (children.get(parentId) || []).slice().sort((a, b) => spans[a].start - spans[b].start || a - b);
    for (const k of kids) {
      ordered.push({ ...spans[k], depth });
      visit(spans[k].id, depth + 1);
    }
  };
  visit('', 0);
  const services: string[] = [];
  for (const s of ordered) if (services.indexOf(s.service) < 0) services.push(s.service);
  const warnings: string[] = [];
  let shown = services;
  if (services.length > 5) {
    shown = services.slice(0, 5).concat([OTHER_SERVICES]);
    for (const s of ordered) if (services.indexOf(s.service) >= 5) s.service = OTHER_SERVICES;
    warnings.push(`waterfall: ${plural(services.length - 5, 'service')} folded into '${OTHER_SERVICES}'`);
  }
  const end = finite('waterfall', Math.max.apply(null, ordered.map(s => s.start + s.duration)));
  const data: WaterfallData = { type: 'waterfall', options: {}, spans: ordered, services: shown, end };
  return { data, summary: { rows: t.rows.length, series: shown.slice(), xRange: '', warnings } };
}

// Scatter, schedule and kanban take their fixed columns by position and their
// optional ones by header name: `fixed` are the first columns whose header is
// not in `named`, in order. Each named column appears at most once (duplicate
// headers are refused before this runs). `what` says what the fixed columns are.
function columnRoles(type: ChartType, header: string[], fixed: number, named: readonly string[], what: string): { at: number[]; by: Record<string, number> } {
  const at: number[] = [];
  const by: Record<string, number> = {};
  const names = named.length === 2 ? named.join(' and ') : `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`;
  header.forEach((name, c) => {
    if (named.indexOf(name) >= 0) by[name] = c;
    else if (at.length < fixed) at.push(c);
    else reject(`${type} has no column '${name}'; after ${what}, the optional columns are ${names}`);
  });
  if (at.length < fixed) reject(`${type} needs ${what} besides ${names}; got ${plural(at.length, 'column')}`);
  return { at, by };
}

/** The index of `value` in `list`, appended when it is new. Arrays, not objects: the values are user text. */
const firstSeen = (list: string[], value: string): number => {
  const i = list.indexOf(value);
  if (i >= 0) return i;
  list.push(value);
  return list.length - 1;
};
const capped = (type: ChartType, list: string[], max: number, what: string, fix: string) => {
  if (list.length > max) reject(`${type} allows at most ${max} ${what}; got ${list.length} — ${fix} or split into two charts`);
};
const MAX_SCHEDULE_LANES = 12;
const MAX_KANBAN_STAGES = 8;
const MAX_KANBAN_LANES = 6;

function scatter(t: Table, o: Record<string, unknown>): Parsed {
  const options = o as ScatterData['options'];
  const { at: [xc, yc], by } = columnRoles('scatter', t.header, 2, ['group', 'label'], 'an x column and a y column');
  const groups: string[] = [];
  const points = t.rows.map((r, i): ScatterPoint => {
    const row = i + 2;
    return {
      x: parseNumberCell(r[xc], row, t.header[xc], 'xUnit'),
      y: parseNumberCell(r[yc], row, t.header[yc], 'yUnit'),
      group: by.group === undefined ? 0 : firstSeen(groups, label(r[by.group], row, 'group')),
      label: by.label === undefined ? '' : r[by.label],
    };
  });
  capped('scatter', groups, MAX_SERIES, 'groups', 'merge small groups');
  let lo = 0, hi = 0;
  points.forEach((p, i) => {
    if (p.x < points[lo].x) lo = i;
    if (p.x > points[hi].x) hi = i;
  });
  const data: ScatterData = { type: 'scatter', options, xName: t.header[xc], yName: t.header[yc], groups, points };
  const series = groups.length > 0 ? groups.slice() : [t.header[yc]];
  return { data, summary: { rows: t.rows.length, series, xRange: `${t.rows[lo][xc]} → ${t.rows[hi][xc]}`, warnings: [] } };
}

const SCHEDULE_STATUSES: readonly ScheduleStatus[] = ['planned', 'active', 'done', 'blocked'];
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86400000;

function schedule(t: Table, o: Record<string, unknown>): Parsed {
  const options = o as ScheduleData['options'];
  const { at: [lc, ic, sc, ec], by } = columnRoles('schedule', t.header, 4, ['group', 'status'], 'lane, item, start and end columns');
  let kind: XKind | null = null;
  let kindRow = 0;
  // One format across start and end, taken from the first time read.
  const time = (cell: string, row: number, column: string): number => {
    const v = timeValue(cell);
    if (!v) return reject(notATime(at(row, column), cell));
    if (kind === null) { kind = v.kind; kindRow = row; }
    if (v.kind !== kind) return reject(`${at(row, column)}: '${cell}' is not ${KIND_WORDS[kind]} like row ${kindRow}; use one time format in start and end`);
    return v.ms;
  };
  const lanes: string[] = [];
  const groups: string[] = [];
  const items = t.rows.map((r, i): ScheduleItem => {
    const row = i + 2;
    const lane = firstSeen(lanes, label(r[lc], row, t.header[lc]));
    const name = r[ic] === '' ? reject(`${at(row, t.header[ic])} is empty; every row needs an item`) : r[ic];
    if (r[sc] === '') reject(`${at(row, t.header[sc])} is empty; every row needs a start time`);
    const start = time(r[sc], row, t.header[sc]);
    const raw = r[ec] === '' ? start : time(r[ec], row, t.header[ec]);
    // An end date takes in its whole day, so it may share the start's date but not come before it.
    const wholeDay = r[ec] !== '' && DATE_ONLY_RE.test(r[ec]);
    const end = wholeDay ? raw + DAY_MS : raw;
    if (wholeDay ? end <= start : end < start) reject(`row ${row}: end '${r[ec]}' is before start '${r[sc]}'; an item ends at or after its start`);
    const status = by.status === undefined ? '' : r[by.status].toLowerCase();
    if (status !== '' && SCHEDULE_STATUSES.indexOf(status as ScheduleStatus) < 0) {
      reject(`${at(row, 'status')}: '${r[by.status]}' is not a status; use planned, active, done or blocked, or leave it empty`);
    }
    return {
      lane,
      label: name,
      start,
      end,
      milestone: end === start,
      group: by.group === undefined ? 0 : firstSeen(groups, label(r[by.group], row, 'group')),
      status: status as ScheduleStatus,
      startText: r[sc],
      endText: r[ec],
    };
  });
  capped('schedule', lanes, MAX_SCHEDULE_LANES, 'lanes', 'merge lanes');
  capped('schedule', groups, MAX_SERIES, 'groups', 'merge small groups');
  // `as`: TypeScript does not see the assignments inside `time` and would narrow kind to null here.
  const xKind: XKind = (kind as XKind | null) ?? 'iso';
  let marker: number | null = null;
  const m = options.marker.trim();
  if (m !== '') {
    const v = timeValue(m);
    if (!v) reject(notATime("option 'marker'", m));
    else if (v.kind !== xKind) reject(`option 'marker': '${m}' is not ${KIND_WORDS[xKind]} like the start column`);
    else marker = v.ms;
  }
  let first = 0, last = 0;
  items.forEach((it, i) => {
    if (it.start < items[first].start) first = i;
    if (it.end > items[last].end) last = i;
  });
  const lastText = items[last].endText === '' ? items[last].startText : items[last].endText;
  const data: ScheduleData = { type: 'schedule', options, xKind, marker, lanes, groups, items };
  return { data, summary: { rows: t.rows.length, series: lanes.slice(), xRange: `${items[first].startText} → ${lastText}`, warnings: [] } };
}

function kanban(t: Table): Parsed {
  const { at: [sc, cc], by } = columnRoles('kanban', t.header, 2, ['lane', 'group', 'detail'], 'a stage column and a card column');
  const stages: string[] = [];
  const lanes: string[] = [];
  const groups: string[] = [];
  const cards: KanbanCard[] = [];
  t.rows.forEach((r, i) => {
    const row = i + 2;
    const stage = firstSeen(stages, label(r[sc], row, t.header[sc]));
    const lane = by.lane === undefined ? 0 : firstSeen(lanes, label(r[by.lane], row, 'lane'));
    const group = by.group === undefined ? '' : r[by.group];
    const detail = by.detail === undefined ? '' : r[by.detail];
    if (r[cc] === '') {
      // A row without a card only adds its stage and lane; a group or detail there would be dropped unseen.
      if (group !== '' || detail !== '') reject(`row ${row} has no card; leave group and detail empty on a row that only adds a stage`);
      return;
    }
    cards.push({ stage, lane, title: r[cc], detail, group: group === '' ? -1 : firstSeen(groups, group) });
  });
  capped('kanban', stages, MAX_KANBAN_STAGES, 'stages', 'merge stages');
  capped('kanban', lanes, MAX_KANBAN_LANES, 'lanes', 'merge lanes');
  capped('kanban', groups, MAX_SERIES, 'groups', 'merge small groups');
  const data: KanbanData = { type: 'kanban', options: {}, stages, lanes, groups, cards };
  return { data, summary: { rows: t.rows.length, series: stages.slice(), xRange: '', warnings: [] } };
}

const PARSERS: Record<ChartType, (t: Table, o: Record<string, unknown>) => Parsed> = { timeseries, bars, toplist, pie, treemap, table, stat, waterfall, scatter, schedule, kanban };

// Checks run in this order, and the first failure is the answer: type, CSV syntax and size,
// column count and the series cap (so nothing walks an oversized header), header names,
// options, row count, then cells row by row, then whole-chart rules.
export function parseChart(type: string, csv: string, optionsJson: string): ParseResult {
  if (!isChartType(type)) return { ok: false, error: `chart type '${type}' is not supported; use one of ${CHART_TYPES.join(', ')}` };
  const parsed = parseCsv(csv);
  if (!parsed.ok) return parsed;
  const contract = CHART_CONTRACTS[type];
  try {
    const header = parsed.header.map(h => h.trim());
    const [minCols, maxCols, shape] = COLUMN_SHAPE[type];
    if (header.length < minCols || header.length > maxCols) {
      reject(type === 'table' ? `table allows at most 8 columns; got ${header.length}` : `${type} needs ${shape}; got ${plural(header.length, 'column')}`);
    }
    const maxSeries = contract.limits.maxSeries;
    if (maxSeries !== undefined && header.length - 1 > maxSeries) {
      reject(`${type} allows at most ${maxSeries} series; got ${header.length - 1} — fold the smallest into 'other' or split into two charts`);
    }
    const names = new Set<string>();
    header.forEach((name, i) => {
      if (name === '') reject(`column ${i + 1} has no name; put a name in the first row`);
      if (names.has(name)) reject(`column '${name}' appears twice; column names must be unique`);
      names.add(name);
    });
    const options = parseOptions(type, contract.options, optionsJson);
    const { minRows, maxRows } = contract.limits;
    const n = parsed.rows.length;
    if (n < minRows) reject(`${type} needs at least ${plural(minRows, 'data row')}; got ${n}`);
    if (n > maxRows) reject(`${type} allows at most ${maxRows} data rows; got ${n}`);
    const t: Table = { header, rows: parsed.rows.map(r => r.map(cell => cell.trim())) };
    const { data, summary } = PARSERS[type](t, options);
    return { ok: true, data, summary };
  } catch (e) {
    if (e instanceof ChartInputError) return { ok: false, error: e.message };
    throw e;
  }
}
