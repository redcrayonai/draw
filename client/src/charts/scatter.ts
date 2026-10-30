import type { ScatterData } from '../../../module/src/chart-contracts';
import type { PlotBox } from './index';
import { axisTicks, fitText, formatValue, textW } from './scale';
import { LEGEND_H, axisLabels, legend, num, seriesClass, svgEl, txt } from './svg';

const TICK_PX = 10;
const TITLE_PX = 10;
/** The y axis title sits in a row of its own above the plot. */
const TITLE_H = 16;
/** Room under the plot for the x tick labels and the x axis title. */
const X_AXIS_H = 16;
/** Least px between neighbouring y ticks. */
const Y_TICK_GAP = 24;
const DOT_R = 3.5;
const DENSE_R = 2.5;
/** Least plot height a legend or the y title row may leave. */
const MIN_PLOT_H = 40;
/** A dot is small; its hover target is not. */
const HIT_R = 7;

const axisTitle = (name: string, unit: string) => (unit ? `${name} (${unit})` : name);

/**
 * A scatter plot: one ringed dot per point on two value axes that hug the
 * data, coloured by group (series slot order), with gridlines on both axes
 * and a legend for two or more groups. The y axis title sits above the plot
 * where it starts, the x axis title on the tick row at the right, where it
 * takes the place of any tick label it would cover. A short card drops the
 * legend, then the y title, so the plot keeps at least 40 px. Each dot has a larger
 * transparent hit circle whose readout gives the label, the group and both
 * values. Dense keeps only the dots and their hit circles.
 */
export function renderScatter(d: ScatterData, box: PlotBox, dense: boolean): SVGElement[] {
  const out: SVGElement[] = [];
  const pts = d.points;
  if (pts.length === 0) {
    return out;
  }
  const { xUnit, yUnit } = d.options;
  const xs = pts.map(p => p.x);
  const ys = pts.map(p => p.y);
  // A short card drops the legend, then the y title's row, before the plot gets thin.
  const showLegend = !dense && d.groups.length >= 2 && box.h - TITLE_H - X_AXIS_H - LEGEND_H >= MIN_PLOT_H;
  const titleRow = !dense && box.h - X_AXIS_H - (showLegend ? LEGEND_H : 0) - TITLE_H >= MIN_PLOT_H;
  const top = box.y + (titleRow ? TITLE_H : 4);
  const bottom = Math.max(top + 1, box.y + box.h - (dense ? 4 : X_AXIS_H + (showLegend ? LEGEND_H : 0)));
  const yTicks = axisTicks(Math.min(...ys), Math.max(...ys), bottom - top, Y_TICK_GAP);
  const yText = yTicks.map(t => formatValue(t, ''));
  const left = box.x + (dense ? 4 : Math.max(...yText.map(s => textW(s, TICK_PX))) + 6);
  const right = Math.max(left + 1, box.x + box.w - (dense ? 4 : 6));
  const xlo = Math.min(...xs);
  const xhi = Math.max(...xs);
  // Labels are centred on their ticks: neighbours need the widest label and some air.
  const xGap = Math.max(textW(formatValue(xlo, ''), TICK_PX), textW(formatValue(xhi, ''), TICK_PX)) + 16;
  const xTicks = axisTicks(xlo, xhi, right - left, xGap);
  const [x0, x1] = [xTicks[0], xTicks[xTicks.length - 1]];
  const [y0, y1] = [yTicks[0], yTicks[yTicks.length - 1]];
  // Halve before subtracting, as the time series does: x1 - x0 overflows for ±1e308.
  const sx = (v: number) => left + (x1 > x0 ? (v / 2 - x0 / 2) / (x1 / 2 - x0 / 2) : 0.5) * (right - left);
  const sy = (v: number) => bottom - (y1 > y0 ? (v / 2 - y0 / 2) / (y1 / 2 - y0 / 2) : 0.5) * (bottom - top);

  if (!dense) {
    yTicks.forEach((t, i) => {
      const y = num(sy(t));
      out.push(
        svgEl('line', { x1: num(left), x2: num(right), y1: y, y2: y, class: i === 0 ? 'chart-base' : 'chart-grid' }),
        txt(left - 6, sy(t) + 3, yText[i], 'chart-tick chart-faint', TICK_PX, 'end', true),
      );
    });
    xTicks.forEach((t, i) => {
      const x = num(sx(t));
      out.push(svgEl('line', { x1: x, x2: x, y1: num(top), y2: num(bottom), class: i === 0 ? 'chart-base' : 'chart-grid' }));
    });
    const yTitle = fitText(axisTitle(d.yName, yUnit), box.x + box.w - left, TITLE_PX);
    const xTitle = fitText(axisTitle(d.xName, xUnit), box.w / 2, TITLE_PX);
    if (titleRow && yTitle !== '') {
      // Over the plot, right of the tick labels, so it never meets the top one.
      out.push(txt(left, box.y + 10, yTitle, 'chart-axis-title chart-muted', TITLE_PX));
    }
    // A tick label that would run under the x title drops; the first one always stays.
    const titleLeft = xTitle === '' ? Infinity : box.x + box.w - textW(xTitle, TITLE_PX) - 8;
    const items = xTicks
      .map(t => ({ x: sx(t), text: formatValue(t, '') }))
      .filter((it, i) => i === 0 || it.x + textW(it.text, TICK_PX) / 2 <= titleLeft);
    out.push(...axisLabels(items, bottom + 14, box.x, box.x + box.w, TICK_PX));
    if (xTitle !== '') {
      out.push(txt(box.x + box.w, bottom + 14, xTitle, 'chart-axis-title chart-muted', TITLE_PX, 'end'));
    }
  }

  const grouped = d.groups.length > 0;
  const dots: SVGElement[] = [];
  const hits: SVGElement[] = [];
  pts.forEach(p => {
    const cls = seriesClass(p.group);
    const cx = num(sx(p.x));
    const cy = num(sy(p.y));
    dots.push(svgEl('circle', { cx, cy, r: String(dense ? DENSE_R : DOT_R), 'stroke-width': '1', class: `chart-point chart-ring ${cls}` }));
    const head = [p.label, grouped ? d.groups[p.group] : ''].filter(s => s !== '').join(' · ');
    const rows = [
      { slot: (p.group % 5) + 1, name: d.xName, value: formatValue(p.x, xUnit) },
      { slot: (p.group % 5) + 1, name: d.yName, value: formatValue(p.y, yUnit) },
    ];
    hits.push(svgEl('circle', {
      cx, cy, r: String(HIT_R), fill: 'transparent', class: 'chart-hit',
      'data-tip': [head, ...rows.map(r => `${r.name}: ${r.value}`)].filter(s => s !== '').join('\n'),
      ...(head !== '' ? { 'data-tip-head': head } : {}),
      'data-tip-rows': JSON.stringify(rows),
    }));
  });
  out.push(...dots, ...hits);

  if (showLegend) {
    out.push(legend(d.groups.map((name, k) => ({ name, cls: seriesClass(k) })), box.x, box.y + box.h - 4, box.w));
  }
  return out;
}
