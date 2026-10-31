import { parseChart, type ChartData, type ParseResult } from '../../../module/src/chart-contracts';
import { renderBars } from './bars';
import { renderKanban } from './kanban';
import { renderPie } from './pie';
import type { Box } from './scale';
import { renderScatter } from './scatter';
import { renderSchedule } from './schedule';
import { renderStat } from './stat';
import { renderTable } from './table';
import { renderTimeseries } from './timeseries';
import { renderToplist } from './toplist';
import { renderTreemap } from './treemap';
import { renderWaterfall } from './waterfall';

/** The plot area inside a chart card, in node-local coordinates. */
export interface PlotBox extends Box {}

/** Draw a parsed chart into box. Pure: the result depends only on the arguments. */
export function renderPlot(data: ChartData, box: PlotBox, dense: boolean): SVGElement[] {
  if (box.w <= 0 || box.h <= 0) {
    return [];
  }
  switch (data.type) {
    case 'timeseries': return renderTimeseries(data, box, dense);
    case 'bars': return renderBars(data, box, dense);
    case 'toplist': return renderToplist(data, box, dense);
    case 'pie': return renderPie(data, box, dense);
    case 'treemap': return renderTreemap(data, box, dense);
    case 'table': return renderTable(data, box, dense);
    case 'stat': return renderStat(data, box, dense);
    case 'waterfall': return renderWaterfall(data, box, dense);
    case 'scatter': return renderScatter(data, box, dense);
    case 'schedule': return renderSchedule(data, box, dense);
    case 'kanban': return renderKanban(data, box, dense);
  }
}

const CACHE_SIZE = 64;
/** Map order is insertion order: the first key is the least recently used. */
const cache = new Map<string, ParseResult>();

/** parseChart once per distinct (type, options, csv); the 64 most recently used results stay cached. */
export function parsedChart(row: { type: string; csv: string; options: string }): ParseResult {
  const key = `${row.type}\u0000${row.options}\u0000${row.csv}`;
  const hit = cache.get(key);
  if (hit !== undefined) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const result = parseChart(row.type, row.csv, row.options);
  cache.set(key, result);
  if (cache.size > CACHE_SIZE) {
    cache.delete(cache.keys().next().value as string);
  }
  return result;
}
