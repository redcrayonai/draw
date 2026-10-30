import type { PieData } from '../../../module/src/chart-contracts';
import type { PlotBox } from './index';
import { fitText, formatValue, textW } from './scale';
import { num, seriesClass, svgEl, txt } from './svg';

const LEGEND_PX = 11;
/** Widest legend: past it a share drifts away from its label. */
const LEGEND_MAX_W = 200;
/** Inner radius of a donut as a share of the outer radius. */
const HOLE = 0.7;
/** Air between the ring and the footnote under the plot. */
const FOOT_GAP = 8;

const pct = (v: number, total: number) => {
  const p = (v / total) * 100;
  return `${p >= 10 ? Math.round(p) : Math.round(p * 10) / 10}%`;
};

/**
 * A donut (default) or pie. Slices are cut apart by a 2 px gap in the
 * geometry, in data order clockwise from 12 o'clock. The folded 'other' slice
 * is neutral (chart-other), never a series slot. A donut shows the total and
 * the value name in its hole; a legend lists every slice with its share.
 */
export function renderPie(d: PieData, box: PlotBox, dense: boolean): SVGElement[] {
  const out: SVGElement[] = [];
  const total = d.total > 0 ? d.total : d.slices.reduce((s, x) => s + Math.max(0, x.value), 0);
  if (!(total > 0) || box.w <= 0 || box.h <= 0) {
    return out;
  }
  // Dense hides the footnote, so the ring may fill the box.
  const roomH = dense ? box.h : Math.max(0, box.h - FOOT_GAP);
  const size = dense ? Math.min(box.w, box.h) : Math.min(roomH, box.w * 0.45);
  const r = size / 2;
  const ri = d.options.donut ? r * HOLE : 0;
  const cx = dense ? box.x + box.w / 2 : box.x + r;
  const cy = box.y + roomH / 2;
  const at = (rad: number, a: number) => `${num(cx + rad * Math.cos(a))} ${num(cy + rad * Math.sin(a))}`;

  let slot = 0;
  const cls = d.slices.map(s => (s.other ? 'chart-other' : seriesClass(slot++)));
  const unit = d.options.unit;
  const drawn = d.slices.filter(s => s.value > 0).length;
  let a = -Math.PI / 2;
  d.slices.forEach((s, i) => {
    const sweep = (Math.max(0, s.value) / total) * Math.PI * 2;
    const a0 = a;
    a += sweep;
    if (sweep <= 0) {
      return;
    }
    const tip = `${s.label}\n${formatValue(s.value, unit)} · ${pct(s.value, total)}`;
    let path: string;
    if (drawn === 1) {
      // One slice is the whole ring: two half arcs per circle, even-odd fill.
      path = `M${at(r, a0)} A${num(r)} ${num(r)} 0 1 1 ${at(r, a0 + Math.PI)} A${num(r)} ${num(r)} 0 1 1 ${at(r, a0)} Z`;
      if (ri > 0) {
        path += ` M${at(ri, a0)} A${num(ri)} ${num(ri)} 0 1 0 ${at(ri, a0 + Math.PI)} A${num(ri)} ${num(ri)} 0 1 0 ${at(ri, a0)} Z`;
      }
    } else {
      // A 2 px gap at every radius: half of it (1 px) off each end of the slice.
      const s0 = a0 + 1 / r;
      const e0 = a - 1 / r;
      if (e0 <= s0) {
        return;
      }
      const large = e0 - s0 > Math.PI ? 1 : 0;
      path = `M${at(r, s0)} A${num(r)} ${num(r)} 0 ${large} 1 ${at(r, e0)}`;
      if (ri > 0) {
        const si = a0 + 1 / ri;
        const ei = a - 1 / ri;
        if (ei > si) {
          path += ` L${at(ri, ei)} A${num(ri)} ${num(ri)} 0 ${ei - si > Math.PI ? 1 : 0} 0 ${at(ri, si)} Z`;
        } else {
          path += ` L${at(ri, (a0 + a) / 2)} Z`;
        }
      } else {
        path += ` L${num(cx)} ${num(cy)} Z`;
      }
    }
    const attrs: Record<string, string> = { d: path, class: `chart-slice ${cls[i]}`, 'data-tip': tip };
    if (drawn === 1) {
      attrs['fill-rule'] = 'evenodd';
    }
    out.push(svgEl('path', attrs));
  });

  if (dense) {
    return out;
  }
  if (ri >= 20) {
    const valueText = formatValue(total, unit);
    const fs = Math.max(11, Math.min(18, (ri * 1.6 * 100) / Math.max(1, textW(valueText, 100))));
    out.push(txt(cx, cy + fs * 0.25, valueText, 'chart-center chart-text', Math.round(fs), 'middle', true));
    const name = fitText(d.valueName, ri * 1.6, 10);
    if (name) {
      out.push(txt(cx, cy + fs * 0.25 + 14, name, 'chart-center-label chart-faint', 10, 'middle'));
    }
  }
  const lx = box.x + size + 20;
  const lw = Math.min(LEGEND_MAX_W, box.x + box.w - lx);
  if (lw >= 48) {
    const g = svgEl('g', { class: 'chart-legend' });
    const n = d.slices.length;
    const rowH = Math.min(18, roomH / n);
    const y0 = box.y + (roomH - rowH * n) / 2;
    const shares = d.slices.map(s => pct(s.value, total));
    const shareW = Math.max(...shares.map(p => textW(p, LEGEND_PX)));
    d.slices.forEach((s, i) => {
      const y = y0 + rowH * (i + 0.5);
      g.append(
        svgEl('rect', { x: num(lx), y: num(y - 4), width: '8', height: '8', rx: '2', class: `chart-swatch ${cls[i]}` }),
        txt(lx + 14, y + 3.5, fitText(s.label, lw - 14 - shareW - 8, LEGEND_PX), 'chart-legend-text chart-muted', LEGEND_PX),
        txt(lx + lw, y + 3.5, shares[i], 'chart-value chart-text', LEGEND_PX, 'end', true),
      );
    });
    out.push(g);
  }
  return out;
}
