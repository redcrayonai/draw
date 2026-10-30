/**
 * Chart helpers for the MCP server (mcp/src/tools.ts). They are pure, so tests import them. The contracts and
 * parseChart come from the module, so the agent rejects what the reducer
 * rejects, in the same words. The reducer still has the final say.
 */
import {
  AGENT_SOURCE_RULE,
  CHART_CONTRACTS,
  CHART_MIN_H,
  CHART_MIN_W,
  CHART_TYPES,
  HUMAN_DATA_NEEDS_SOURCE,
  HUMAN_SOURCE_RESERVED,
  MAX_CSV_BYTES,
  SAMPLE_NEEDS_SOURCE,
  SAMPLE_RESERVED,
  SAMPLE_SOURCE,
  isChartType,
  isHumanSource,
  parseChart,
  type ChartSummary,
  type ChartType,
} from '../../module/src/chart-contracts';

export type ChartCheck = { ok: true; summary: ChartSummary } | { ok: false; error: string };

/** The stored fields of a chart row. A generated `Chart` row fits. */
export interface StoredChart {
  type: string;
  csv: string;
  options: string;
  source: string;
}

export interface ChartInput {
  type: string;
  csv: string;
  options?: string;
  source?: string;
}

export type ChartPatch = Partial<ChartInput>;

export type ChartNodeSummary =
  | { noData: true }
  | { type: string; source: string; rows: number; series: string[]; xRange?: string; warnings?: string[] }
  | { type: string; source: string; error: string };

const RULES = {
  source: AGENT_SOURCE_RULE,
  sample: SAMPLE_RESERVED,
  data: 'Chart only what you measured or read in this session: numbers a command printed, or the items of a plan or a tracker for a schedule or a kanban. Never invent or round numbers.',
  csv:
    'The first row names the columns. The delimiter is a tab when the first line has a tab, else a comma; quotes follow RFC 4180. ' +
    `Numbers are plain decimals: no units and no thousands separators in cells. At most ${MAX_CSV_BYTES} bytes.`,
  options: 'A JSON object. An omitted key takes its default; an unknown key or value is rejected.',
  size: `A chart is at least ${CHART_MIN_W}x${CHART_MIN_H}; x, y, w and h are divisible by 4.`,
};

function describe(types: readonly ChartType[]): string {
  return JSON.stringify({ rules: RULES, charts: types.map(t => CHART_CONTRACTS[t]) }, null, 1);
}

/** describe_charts: every contract, or one when `type` names it. */
export function describeChartsText(type?: string): { ok: true; text: string } | { ok: false; error: string } {
  if (type === undefined) return { ok: true, text: describe(CHART_TYPES) };
  if (!isChartType(type)) return { ok: false, error: `unknown chart type '${type}'; the types are ${CHART_TYPES.join(', ')}` };
  return { ok: true, text: describe([type]) };
}

/** One line per type for tool descriptions: `timeseries: <purpose>; bars: …`. */
export function chartTypesText(): string {
  return CHART_TYPES.map(t => `${t}: ${CHART_CONTRACTS[t].purpose.replace(/\.$/, '')}`).join('; ') + '.';
}

// The agent side of the module's source rule (an agent is the only caller here).
// The reducer trims first, so ' sample ' is reserved too.
function sourceError(source: string | undefined): string | undefined {
  const s = (source ?? '').trim();
  if (s === '') return AGENT_SOURCE_RULE;
  if (s === SAMPLE_SOURCE) return SAMPLE_RESERVED;
  if (isHumanSource(s)) return HUMAN_SOURCE_RESERVED;
  return undefined;
}

function parsed(type: string, csv: string, options: string | undefined): ChartCheck {
  const r = parseChart(type, csv, options ?? '');
  return r.ok ? { ok: true, summary: r.summary } : { ok: false, error: r.error };
}

/** create_chart: the source rule, then parseChart. */
export function checkChartInput(input: ChartInput): ChartCheck {
  const error = sourceError(input.source);
  return error ? { ok: false, error } : parsed(input.type, input.csv, input.options);
}

/** set_chart_data: the patch merged over the stored row, as setChartData merges it. */
export function checkChartUpdate(row: StoredChart, patch: ChartPatch): ChartCheck {
  const type = patch.type ?? row.type;
  const csv = patch.csv ?? row.csv;
  const options = patch.options ?? row.options;
  if (patch.source !== undefined) {
    const error = sourceError(patch.source);
    if (error) return { ok: false, error };
  } else if (type !== row.type || csv !== row.csv) {
    // new numbers: a sample or a person's source would no longer be true
    if (row.source === SAMPLE_SOURCE) return { ok: false, error: SAMPLE_NEEDS_SOURCE };
    if (isHumanSource(row.source)) return { ok: false, error: HUMAN_DATA_NEEDS_SOURCE };
  }
  return parsed(type, csv, options);
}

/** The note create_chart and set_chart_data append to `committed`. */
export function chartSummaryText(summary: ChartSummary): string {
  const parts = [`${summary.rows} ${summary.rows === 1 ? 'row' : 'rows'}`, `series: ${summary.series.join(', ')}`];
  if (summary.xRange) parts.push(`x: ${summary.xRange}`);
  return ` (${[...parts, ...summary.warnings].join('; ')})`;
}

/** get_board's view of a chart node: what was drawn and where it came from, never the CSV. */
export function chartNodeSummary(row: StoredChart | null | undefined): ChartNodeSummary {
  if (!row) return { noData: true };
  const r = parseChart(row.type, row.csv, row.options);
  if (!r.ok) return { type: row.type, source: row.source, error: r.error };
  const { rows, series, xRange, warnings } = r.summary;
  return {
    type: row.type,
    source: row.source,
    rows,
    series,
    xRange: xRange || undefined,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

export function notAChart(nodeId: string): string {
  return `node ${nodeId} is not a chart on the active board`;
}

/** Options arrive as a JSON string or, from many models, as an object. */
export function optionsText(options: string | Record<string, unknown> | undefined): string | undefined {
  return options === undefined || typeof options === 'string' ? options : JSON.stringify(options);
}
