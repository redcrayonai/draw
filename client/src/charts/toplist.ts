import type { ToplistData } from '../../../module/src/chart-contracts';
import type { PlotBox } from './index';
import { fitText, formatValue, textW } from './scale';
import { barPath, num, svgEl, txt } from './svg';

const ROW_MIN = 16;
const ROW_MAX = 24;
const TRACK_H = 8;
const RANK_PX = 11;
const LABEL_PX = 11;
const VALUE_PX = 12;

/**
 * A ranked list: rank, label, an inline bar on a track, and the value
 * right-aligned in tabular figures. The parser already cut the list to
 * `limit`; that cut and rows that do not fit the box both end the list with
 * one muted '+N more' line counting every row not shown.
 */
export function renderToplist(d: ToplistData, box: PlotBox, dense: boolean): SVGElement[] {
  const out: SVGElement[] = [];
  const items = d.items;
  if (items.length === 0) {
    return out;
  }
  const total = Math.max(items.length, d.totalRows);
  let shown = items.length;
  let rowH = Math.min(ROW_MAX, box.h / (shown + (!dense && total > shown ? 1 : 0)));
  if (!dense && rowH < ROW_MIN) {
    rowH = ROW_MIN;
    shown = Math.max(0, Math.floor(box.h / ROW_MIN) - 1);
  }
  const more = dense ? 0 : total - shown;
  const unit = d.options.unit;
  const values = items.map(it => formatValue(it.value, unit));
  const max = Math.max(0, ...items.map(it => it.value));

  let trackX = box.x;
  let trackW = box.w;
  let rankW = 0;
  let labelW = 0;
  if (!dense) {
    rankW = textW(String(shown), RANK_PX) + 8;
    labelW = Math.min(box.w * 0.4, Math.max(...items.map(it => textW(it.label, LABEL_PX, true))));
    const valueW = Math.max(...values.slice(0, shown).map(v => textW(v, VALUE_PX)));
    trackX = box.x + rankW + labelW + 10;
    trackW = box.x + box.w - valueW - 10 - trackX;
    if (trackW < 24) {
      // No room for a track: labels and values only.
      trackW = 0;
      labelW = box.w - rankW - valueW - 10;
    }
  }

  for (let i = 0; i < shown; i++) {
    const it = items[i];
    const cy = box.y + rowH * (i + 0.5);
    const tip = `${i + 1}. ${it.label}\n${d.valueName}: ${values[i]}`;
    if (trackW > 0) {
      const barH = Math.min(TRACK_H, rowH * 0.6);
      out.push(svgEl('rect', {
        x: num(trackX), y: num(cy - barH / 2), width: num(trackW), height: num(barH), rx: num(barH / 2),
        class: 'chart-track', 'data-tip': tip,
      }));
      const len = max > 0 ? (Math.max(0, it.value) / max) * trackW : 0;
      if (len > 0) {
        out.push(svgEl('path', {
          d: barPath(false, cy - barH / 2, barH, trackX, trackX + len, barH / 2),
          class: 'chart-bar series-1',
          'data-tip': tip,
        }));
      }
    }
    if (!dense) {
      out.push(
        txt(box.x, cy + 3.5, String(i + 1), 'chart-rank chart-faint', RANK_PX, 'start', true),
        txt(box.x + rankW, cy + 3.5, fitText(it.label, labelW, LABEL_PX, true), 'chart-label chart-text chart-mono', LABEL_PX),
        txt(box.x + box.w, cy + 4, values[i], 'chart-value chart-text', VALUE_PX, 'end', true),
      );
    }
  }
  if (more > 0) {
    out.push(txt(box.x, box.y + rowH * shown + rowH / 2 + 3.5, `+${more} more`, 'chart-more chart-faint', 10));
  }
  return out;
}
