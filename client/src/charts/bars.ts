import type { BarsData } from '../../../module/src/chart-contracts';
import type { PlotBox } from './index';
import { axisTicks, fitText, formatValue, textW } from './scale';
import { LEGEND_H, axisLabels, barPath, legend, num, seriesClass, svgEl, txt } from './svg';

const TICK_PX = 10;
const LABEL_PX = 11;
const VALUE_PX = 10;
const MAX_BAR = 24;
const RADIUS = 4;
const GAP = 2;
/** Least px between neighbouring vertical value ticks. */
const Y_TICK_GAP = 24;

/**
 * Stacked or grouped bars, vertical or horizontal. Bars are at most 24 px
 * thick with a 4 px round on the data end and a square base. Stacked
 * segments are separated by a 2 px gap cut from the upper segment.
 */
export function renderBars(d: BarsData, box: PlotBox, dense: boolean): SVGElement[] {
  const out: SVGElement[] = [];
  const nC = d.categories.length;
  const nS = d.series.length;
  if (nC === 0 || nS === 0) {
    return out;
  }
  const unit = d.options.unit;
  const stacked = d.options.layout === 'stacked' || nS === 1;
  const vertical = d.options.orientation === 'vertical';

  let lo = 0;
  let hi = 0;
  for (let i = 0; i < nC; i++) {
    let sum = 0;
    for (const s of d.series) {
      const v = s.values[i];
      sum += v;
      lo = Math.min(lo, stacked ? sum : v);
      hi = Math.max(hi, stacked ? sum : v);
    }
  }
  if (lo === hi) {
    hi = 1;
  }

  const showLegend = !dense && nS >= 2;
  const showValues = !dense && nS === 1;
  const legendH = showLegend ? LEGEND_H : 0;
  const valueText = showValues ? d.series[0].values.map(v => formatValue(v, unit)) : [];
  const pad = dense ? 2 : 0;
  // A negative value's label goes past the bar's end, beyond the lowest tick
  // when it is the minimum: keep a band for it between the axis and the
  // category labels, so the two never overlap.
  const negLabels = valueText.filter((_, i) => d.series[0].values[i] < 0);
  const negRoom = negLabels.length === 0 ? 0 : vertical ? 12 : Math.max(...negLabels.map(s => textW(s, VALUE_PX))) + 6;

  // Value axis runs from vStart (at value t0) to vEnd (at t1); categories run from cStart to cEnd.
  let cStart: number;
  let cEnd: number;
  let vStart: number;
  let vEnd: number;
  let ticks: number[];
  const catText = dense ? [] : d.categories;
  if (vertical) {
    const top = box.y + (dense ? pad : showValues ? 14 : 6);
    const bottom = Math.max(top + 1, box.y + box.h - (dense ? pad : 16 + legendH + negRoom));
    ticks = axisTicks(lo, hi, bottom - top, Y_TICK_GAP);
    const tickW = dense ? 0 : Math.max(...ticks.map(t => textW(formatValue(t, ''), TICK_PX))) + 6;
    cStart = box.x + (dense ? pad : tickW);
    cEnd = Math.max(cStart + 1, box.x + box.w - (dense ? pad : 4));
    vStart = bottom;
    vEnd = top;
  } else {
    const catW = dense ? 0 : Math.min(box.w * 0.35, Math.max(...catText.map(c => textW(c, LABEL_PX)))) + 8;
    const valueW = showValues ? Math.max(...valueText.map(s => textW(s, VALUE_PX))) + 6 : 8;
    vStart = box.x + (dense ? pad : catW + negRoom);
    const right = Math.max(vStart + 1, box.x + box.w - (dense ? pad : valueW));
    // Labels are centred on their ticks: neighbours need a label width and some air.
    const tickW = Math.max(textW(formatValue(lo, ''), TICK_PX), textW(formatValue(hi, ''), TICK_PX));
    ticks = axisTicks(lo, hi, right - vStart, tickW + 12);
    vEnd = right;
    cStart = box.y + (dense ? pad : 4);
    cEnd = Math.max(cStart + 1, box.y + box.h - (dense ? pad : 16 + legendH));
  }
  const t0 = ticks[0];
  const t1 = ticks[ticks.length - 1];
  // Halve before subtracting: t1 - t0 overflows for ±1e308.
  const p = (v: number) => vStart + ((v / 2 - t0 / 2) / (t1 / 2 - t0 / 2)) * (vEnd - vStart);
  const band = (cEnd - cStart) / nC;
  const center = (i: number) => cStart + band * (i + 0.5);
  const thick = stacked
    ? Math.min(MAX_BAR, band * 0.62)
    : Math.min(MAX_BAR, (band * 0.8 - GAP * (nS - 1)) / nS);
  const bw = Math.max(0.5, thick);
  const groupW = stacked ? bw : nS * bw + GAP * (nS - 1);

  if (!dense) {
    for (const t of ticks) {
      const at = num(p(t));
      const cls = t === 0 ? 'chart-base' : 'chart-grid';
      if (vertical) {
        out.push(
          svgEl('line', { x1: num(cStart), x2: num(cEnd), y1: at, y2: at, class: cls }),
          txt(cStart - 6, p(t) + 3.5, formatValue(t, ''), 'chart-tick chart-faint', TICK_PX, 'end', true),
        );
      } else {
        out.push(svgEl('line', { x1: at, x2: at, y1: num(cStart), y2: num(cEnd), class: cls }));
      }
    }
    if (!vertical) {
      out.push(...axisLabels(ticks.map(t => ({ x: p(t), text: formatValue(t, '') })), cEnd + 13, box.x, box.x + box.w, TICK_PX));
    }
    // Category labels: thin them out when they would collide.
    if (vertical) {
      const widest = Math.max(...catText.map(c => textW(c, TICK_PX)));
      const every = Math.max(1, Math.ceil((Math.min(widest, 80) + 6) / band));
      for (let i = 0; i < nC; i += every) {
        out.push(txt(center(i), vStart + negRoom + 13, fitText(d.categories[i], band * every - 4, TICK_PX), 'chart-tick chart-faint', TICK_PX, 'middle'));
      }
    } else {
      const every = Math.max(1, Math.ceil(12 / band));
      for (let i = 0; i < nC; i += every) {
        out.push(txt(vStart - negRoom - 8, center(i) + 3.5, fitText(d.categories[i], vStart - negRoom - box.x - 8, LABEL_PX), 'chart-label chart-muted', LABEL_PX, 'end'));
      }
    }
  }

  for (let i = 0; i < nC; i++) {
    const total = d.series.reduce((s, x) => s + x.values[i], 0);
    const lastNonZero = d.series.reduce((last, s, k) => (s.values[i] !== 0 ? k : last), -1);
    let cum = 0;
    let below = false;
    d.series.forEach((s, k) => {
      const v = s.values[i];
      if (v === 0) {
        return;
      }
      let a: number;
      let pBase: number;
      let pEnd: number;
      let round: boolean;
      if (stacked) {
        a = center(i) - bw / 2;
        pBase = p(cum);
        pEnd = p(cum + v);
        cum += v;
        if (below) {
          // The 2 px surface gap comes out of this segment, so the stack still ends at the total.
          const dir = Math.sign(pEnd - pBase);
          pBase += dir * Math.min(GAP, Math.abs(pEnd - pBase) / 2);
        }
        below = true;
        round = k === lastNonZero;
      } else {
        a = center(i) - groupW / 2 + k * (bw + GAP);
        pBase = p(0);
        pEnd = p(v);
        round = true;
      }
      const rows: { slot?: number; name: string; value: string }[] = [{ slot: (k % 5) + 1, name: s.name, value: formatValue(v, unit) }];
      if (stacked && nS > 1) {
        rows.push({ name: 'total', value: formatValue(total, unit) });
      }
      out.push(svgEl('path', {
        d: barPath(vertical, a, bw, pBase, pEnd, round ? RADIUS : 0),
        class: `chart-bar ${seriesClass(k)}`,
        'data-motion-key': JSON.stringify([d.categories[i], s.name]),
        'data-motion-axis': vertical ? 'y' : 'x',
        'data-motion-base': num(pBase),
        'data-tip': [d.categories[i], ...rows.map(r => `${r.name}: ${r.value}`)].join('\n'),
        'data-tip-head': d.categories[i],
        'data-tip-rows': JSON.stringify(rows),
      }));
    });
  }

  if (showValues) {
    const widest = Math.max(...valueText.map(s => textW(s, VALUE_PX)));
    // Every value must fit its band: across the bar when vertical, the text height when horizontal.
    if (vertical ? widest <= band - 2 : band >= VALUE_PX + 2) {
      d.series[0].values.forEach((v, i) => {
        const end = p(v);
        if (vertical) {
          out.push(txt(center(i), v >= 0 ? end - 4 : end + 11, valueText[i], 'chart-label chart-muted', VALUE_PX, 'middle', true));
        } else {
          out.push(txt(v >= 0 ? end + 4 : end - 4, center(i) + 3.5, valueText[i], 'chart-label chart-muted', VALUE_PX, v >= 0 ? 'start' : 'end', true));
        }
      });
    }
  }

  if (showLegend) {
    out.push(legend(d.series.map((s, k) => ({ name: s.name, cls: seriesClass(k) })), box.x, box.y + box.h - 4, box.w));
  }
  return out;
}
