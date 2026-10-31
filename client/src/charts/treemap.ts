import type { TreemapData } from '../../../module/src/chart-contracts';
import type { PlotBox } from './index';
import { formatValue, squarify, textW } from './scale';
import { LEGEND_H, legend, num, seriesClass, svgEl, txt } from './svg';

const LABEL_PX = 11;
const VALUE_PX = 10;

/**
 * Squarified treemap: parents are laid out first, then their leaves inside
 * them. A parent's leaves share its series slot (parent order); with no parent
 * column every cell is series-1. Leaves whose parent is not listed form a last
 * group in the neutral chart-other class. Cells are inset 1 px, so neighbours
 * sit 2 px apart. A label is drawn only when it fits inside its cell.
 */
export function renderTreemap(d: TreemapData, box: PlotBox, dense: boolean): SVGElement[] {
  const out: SVGElement[] = [];
  if (d.leaves.length === 0) {
    return out;
  }
  const groups = [...d.parents];
  if (groups.length === 0 || d.leaves.some(l => !d.parents.includes(l.parent))) {
    groups.push('');
  }
  const groupCls = groups.map((g, i) => (g === '' && d.parents.length > 0 ? 'chart-other' : seriesClass(i)));
  const showLegend = !dense && d.parents.length >= 2;
  const area = { x: box.x, y: box.y, w: box.w, h: box.h - (showLegend ? LEGEND_H + 2 : 0) };
  const members = groups.map(g => d.leaves
    .map((_, i) => i)
    .filter(i => (g === '' ? !d.parents.includes(d.leaves[i].parent) : d.leaves[i].parent === g)));
  const sums = members.map(m => m.reduce((s, i) => s + Math.max(0, d.leaves[i].value), 0));
  const total = sums.reduce((s, v) => s + v, 0);
  if (total <= 0 || area.w <= 0 || area.h <= 0) {
    return out;
  }
  const unit = d.options.unit;
  squarify(sums, area).forEach((gb, gi) => {
    const cls = groupCls[gi];
    // Text on a fill takes its contrast colour from on-<slot> (R4's CSS); a series class would set the text's color, not its fill.
    const onFill = `on-${cls.replace('chart-', '')}`;
    const ids = members[gi];
    squarify(ids.map(i => d.leaves[i].value), gb).forEach((b, j) => {
      const leaf = d.leaves[ids[j]];
      const w = b.w - 2;
      const h = b.h - 2;
      if (w <= 0 || h <= 0) {
        return;
      }
      const share = Math.round((Math.max(0, leaf.value) / total) * 1000) / 10;
      const tip = `${groups[gi] ? `${groups[gi]} / ` : ''}${leaf.label}\n${formatValue(leaf.value, unit)} · ${share}%`;
      out.push(svgEl('rect', {
        x: num(b.x + 1), y: num(b.y + 1), width: num(w), height: num(h), rx: num(Math.min(4, w / 2, h / 2)),
        class: `chart-cell ${cls}`, 'data-tip': tip,
      }));
      if (dense || h < 22 || textW(leaf.label, LABEL_PX) + 16 > w) {
        return;
      }
      out.push(txt(b.x + 9, b.y + 17, leaf.label, `chart-cell-label chart-on-fill ${onFill}`, LABEL_PX));
      const value = formatValue(leaf.value, unit);
      if (h >= 38 && textW(value, VALUE_PX) + 16 <= w) {
        out.push(txt(b.x + 9, b.y + 31, value, `chart-cell-value chart-on-fill ${onFill}`, VALUE_PX, 'start', true));
      }
    });
  });
  if (showLegend) {
    out.push(legend(d.parents.map((name, i) => ({ name, cls: groupCls[i] })), box.x, box.y + box.h - 4, box.w));
  }
  return out;
}
