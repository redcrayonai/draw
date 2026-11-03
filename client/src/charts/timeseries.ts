import type { TimeseriesData } from '../../../module/src/chart-contracts';
import type { PlotBox } from './index';
import { axisTicks, formatValue, formatX, textW } from './scale';
import { LEGEND_H, axisLabels, legend, lineAttrs, num, seriesClass, svgEl, txt } from './svg';

const DAY = 86400000;
const TICK_PX = 10;
const LABEL_PX = 11;
/** Room under the plot for the x tick labels. */
const X_AXIS_H = 16;
/** Least px between neighbouring value ticks. */
const Y_TICK_GAP = 24;
/** Least air between x labels, so they read as separate stamps. */
const X_LABEL_AIR = 24;
/** End dots closer than 2r + 2 collapse into one. */
const DOT_APART = 10;

/**
 * Line, area or stacked time series. y starts at 0 unless the data sit far
 * from it (line style only), a null value splits the line, the last point of
 * each series gets a ringed dot (dots that would touch collapse into one), and
 * up to four series get an end label. A line chart washes the area under
 * series 1 only; area and stacked styles wash every series.
 */
export function renderTimeseries(d: TimeseriesData, box: PlotBox, dense: boolean): SVGElement[] {
  const out: SVGElement[] = [];
  const n = d.xs.length;
  if (n === 0 || d.series.length === 0) {
    return out;
  }
  const { style, unit } = d.options;
  const stacked = style === 'stacked';

  // Stacked series draw their running total; a null counts as 0 in a stack.
  const tops: (number | null)[][] = [];
  if (stacked) {
    let acc: number[] = new Array<number>(n).fill(0);
    for (const s of d.series) {
      acc = acc.map((a, i) => a + (s.values[i] ?? 0));
      tops.push(acc.slice());
    }
  } else {
    for (const s of d.series) {
      tops.push(s.values);
    }
  }

  let lo = Infinity;
  let hi = -Infinity;
  for (const vs of tops) {
    for (const v of vs) {
      if (v !== null) {
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
    }
  }
  if (lo === Infinity) {
    lo = 0;
    hi = 1;
  }
  // Areas need their baseline. A line keeps 0 in view unless the data sit
  // further from 0 than twice their own range (99.9 % availability, say).
  const range = hi - lo;
  const nearZero = lo >= 0 ? lo <= 2 * range : hi <= 0 ? -hi <= 2 * range : true;
  if (style !== 'line' || nearZero) {
    lo = Math.min(lo, 0);
    hi = Math.max(hi, 0);
  }

  const showLegend = !dense && d.series.length >= 2;
  const endLabels = !dense && d.series.length <= 4;
  const top = box.y + (dense ? 4 : 6);
  const bottom = Math.max(top + 1, box.y + box.h - (dense ? 4 : X_AXIS_H + (showLegend ? LEGEND_H : 0)));
  const ticks = axisTicks(lo, hi, bottom - top, Y_TICK_GAP);
  const t0 = ticks[0];
  const t1 = ticks[ticks.length - 1];
  const tickText = ticks.map(t => formatValue(t, ''));

  const lastIndex = d.series.map((s, k) => {
    for (let i = n - 1; i >= 0; i--) {
      if (tops[k][i] !== null && (stacked || s.values[i] !== null)) {
        return i;
      }
    }
    return -1;
  });
  const labelText = d.series.map((s, k) => (lastIndex[k] < 0 ? '' : formatValue(s.values[lastIndex[k]] ?? 0, unit)));

  const left = box.x + (dense ? 4 : Math.max(...tickText.map(s => textW(s, TICK_PX))) + 6);
  const right = Math.max(
    left + 1,
    box.x + box.w - (dense ? 4 : endLabels ? 10 + Math.max(0, ...labelText.map(s => textW(s, LABEL_PX))) : 6),
  );
  const x0 = d.xs[0];
  const span = d.xs[n - 1] - x0;
  const sx = (i: number) => left + (span > 0 ? ((d.xs[i] - x0) / span) * (right - left) : n > 1 ? (i / (n - 1)) * (right - left) : 0);
  // Halve before subtracting: t1 - t0 overflows for ±1e308. A single tick (a flat
  // series at the float limit) puts the line at mid-height.
  const sy = (v: number) => bottom - (t1 > t0 ? (v / 2 - t0 / 2) / (t1 / 2 - t0 / 2) : 0.5) * (bottom - top);

  if (!dense) {
    // A y label's baseline sits 3 px under its gridline and the x labels' 14 px
    // under the plot, so the label at the baseline keeps 4 px clear of the first x label.
    ticks.forEach((t, i) => {
      const y = num(sy(t));
      out.push(
        svgEl('line', { x1: num(left), x2: num(right), y1: y, y2: y, class: i === 0 ? 'chart-base' : 'chart-grid' }),
        txt(left - 6, sy(t) + 3, tickText[i], 'chart-tick chart-faint', TICK_PX, 'end', true),
      );
    });
    // One label every `stride` points from the first, a stride wide enough for
    // the widest label; one that also lands on the last point is preferred.
    const xText = d.xs.map(x => formatX(x, d.xKind, span));
    const stepPx = n > 1 ? (right - left) / (n - 1) : Infinity;
    let stride = Math.max(1, Math.ceil((Math.max(...xText.map(s => textW(s, TICK_PX))) + X_LABEL_AIR) / stepPx));
    for (let k = stride; k <= Math.min(n - 1, 2 * stride); k++) {
      if ((n - 1) % k === 0) {
        stride = k;
        break;
      }
    }
    const items: { x: number; text: string }[] = [];
    for (let i = 0; i < n; i += stride) {
      if (items.length === 0 || xText[i] !== items[items.length - 1].text) {
        items.push({ x: sx(i), text: xText[i] });
      }
    }
    out.push(...axisLabels(items, bottom + 14, box.x, box.x + box.w, TICK_PX));
  }

  const baseY = sy(Math.min(Math.max(0, t0), t1));
  const areas: SVGElement[] = [];
  const lines: SVGElement[] = [];
  const dots: SVGElement[] = [];
  const dotAt: { x: number; y: number }[] = [];
  const labels: { y: number; text: string }[] = [];
  d.series.forEach((_, k) => {
    const cls = seriesClass(k);
    const vs = tops[k];
    const runs: number[][] = [];
    let run: number[] = [];
    for (let i = 0; i < n; i++) {
      if (vs[i] === null) {
        if (run.length) runs.push(run);
        run = [];
      } else {
        run.push(i);
      }
    }
    if (run.length) runs.push(run);
    for (const r of runs) {
      const pts = r.map(i => `${num(sx(i))},${num(sy(vs[i] as number))}`);
      if (style !== 'line' || k === 0) {
        const below = stacked && k > 0
          ? r.slice().reverse().map(i => `${num(sx(i))},${num(sy(tops[k - 1][i] as number))}`)
          : [`${num(sx(r[r.length - 1]))},${num(baseY)}`, `${num(sx(r[0]))},${num(baseY)}`];
        areas.push(svgEl('path', {
          d: `M${pts.join(' L')} L${below.join(' L')} Z`,
          class: `chart-area ${cls}`,
          'fill-opacity': '0.1',
          stroke: 'none',
        }));
      }
      if (r.length === 1) {
        const [cx, cy] = pts[0].split(',');
        lines.push(svgEl('circle', { cx, cy, r: '2', class: `chart-point ${cls}` }));
      } else {
        lines.push(svgEl('polyline', { points: pts.join(' '), 'data-motion-key': JSON.stringify([d.series[k].name, r[0]]), ...lineAttrs(`chart-line ${cls}`) }));
      }
    }
    const li = lastIndex[k];
    if (li >= 0) {
      const cx = sx(li);
      const cy = sy(vs[li] as number);
      // Series order: series 1 keeps its dot when two would touch.
      if (!dotAt.some(p => Math.hypot(p.x - cx, p.y - cy) < DOT_APART)) {
        dotAt.push({ x: cx, y: cy });
        dots.push(svgEl('circle', { cx: num(cx), cy: num(cy), r: '4', class: `chart-dot chart-ring ${cls}`, 'stroke-width': '2' }));
      }
      if (endLabels) {
        labels.push({ y: cy + 3.5, text: labelText[k] });
      }
    }
  });
  out.push(...areas, ...lines, ...dots);

  // End labels: keep 12 px apart, then pull the stack back inside the plot.
  labels.sort((a, b) => a.y - b.y);
  for (let i = 1; i < labels.length; i++) {
    labels[i].y = Math.max(labels[i].y, labels[i - 1].y + 12);
  }
  const overflow = labels.length ? labels[labels.length - 1].y - (bottom + 3.5) : 0;
  for (const l of labels) {
    out.push(txt(right + 10, l.y - Math.max(0, overflow), l.text, 'chart-label chart-muted', LABEL_PX, 'start', true));
  }

  // One transparent hit column per x: the tooltip reads data-tip (plain text)
  // or data-tip-head + data-tip-rows (structured), the crosshair data-x and
  // each row's y (where that series crosses it).
  const tipX = (x: number) => (span >= DAY ? `${formatX(x, d.xKind, span)} ${formatX(x, d.xKind, DAY - 1)}` : formatX(x, d.xKind, span));
  for (let i = 0; i < n; i++) {
    const xl = i === 0 ? left : (sx(i - 1) + sx(i)) / 2;
    const xr = i === n - 1 ? right : (sx(i) + sx(i + 1)) / 2;
    const rows: { slot?: number; name: string; value: string; y?: number }[] = d.series.map((s, k) => {
      const v = s.values[i];
      const at = tops[k][i];
      return v === null || at === null
        ? { slot: (k % 5) + 1, name: s.name, value: '—' }
        : { slot: (k % 5) + 1, name: s.name, value: formatValue(v, unit), y: Number(num(sy(at))) };
    });
    if (stacked && d.series.length > 1) {
      rows.push({ name: 'total', value: formatValue(tops[d.series.length - 1][i] as number, unit) });
    }
    const head = tipX(d.xs[i]);
    out.push(svgEl('rect', {
      x: num(xl),
      y: num(top),
      width: num(Math.max(0, xr - xl)),
      height: num(bottom - top),
      fill: 'transparent',
      class: 'chart-hit',
      'data-x': num(sx(i)),
      // The instant itself, for the board's time window brush; clock times have no date.
      ...(d.xKind === 'clock' ? {} : { 'data-t': String(d.xs[i]) }),
      'data-tip': [head, ...rows.map(r => `${r.name}: ${r.value}`)].join('\n'),
      'data-tip-head': head,
      'data-tip-rows': JSON.stringify(rows),
    }));
  }

  if (showLegend) {
    out.push(legend(d.series.map((s, k) => ({ name: s.name, cls: seriesClass(k) })), box.x, box.y + box.h - 4, box.w));
  }
  return out;
}
