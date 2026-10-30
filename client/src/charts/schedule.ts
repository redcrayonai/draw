import type { ScheduleData, ScheduleItem } from '../../../module/src/chart-contracts';
import type { PlotBox } from './index';
import { fitText, formatX, textW, timeTicks } from './scale';
import { LEGEND_H, axisLabels, legend, num, seriesClass, svgEl, txt } from './svg';

const DAY = 86400000;
const HOUR = 3600000;
const LANE_PX = 11;
const ITEM_PX = 10.5;
const TICK_PX = 10;
/** Room under the rows for the time axis labels. */
const AXIS_H = 16;
/** Room above the rows for the marker's label. */
const MARKER_H = 14;
/** Sub-rows grow with the card up to ROW_MAX; below ROW_MIN whole lanes are cut. */
const ROW_MIN = 16;
const ROW_MAX = 32;
const BAR_MAX = 14;
/** Air at both ends of the time axis, so a milestone at either end stays whole. */
const PAD_X = 8;
/** A bar stops this far short of its end, so back-to-back items read as two. */
const BAR_GAP = 2;

interface Placed {
  item: ScheduleItem;
  /** Drawn extent in px: the bar, or the milestone's diamond. */
  x0: number;
  x1: number;
  /** Sub-row within the lane. */
  sub: number;
}

/**
 * Items as drawn: each lane's items by start, each in the first sub-row
 * whose last item ends before it starts on screen, so items that overlap
 * stack inside their lane and back-to-back items share a row. Returns the
 * items in input order.
 */
function pack(items: ScheduleItem[], lanes: number, px: (t: number) => number, half: number): { placed: Placed[]; subRows: number[] } {
  const placed: Placed[] = items.map(item => {
    const x = px(item.start);
    return item.milestone
      ? { item, x0: x - half, x1: x + half, sub: 0 }
      : { item, x0: x, x1: x + Math.max(2, px(item.end) - x - BAR_GAP), sub: 0 };
  });
  const subRows = new Array<number>(lanes).fill(0);
  const ends: number[][] = Array.from({ length: lanes }, () => []);
  const order = placed.map((_, i) => i).sort((a, b) => placed[a].item.start - placed[b].item.start || a - b);
  for (const i of order) {
    const p = placed[i];
    const rowEnds = ends[p.item.lane];
    let sub = rowEnds.findIndex(end => end <= p.x0);
    if (sub < 0) {
      sub = rowEnds.length;
      rowEnds.push(p.x1);
    } else {
      rowEnds[sub] = p.x1;
    }
    p.sub = sub;
    subRows[p.item.lane] = rowEnds.length;
  }
  return { placed, subRows };
}

/** The drawn label: done work carries a ✓, so status is never colour alone. */
const labelText = (it: ScheduleItem) => `${it.status === 'done' ? '✓ ' : ''}${it.label}`;
/** The item's series slot: its group's, or series 1 with no group column. */
const slot = (it: ScheduleItem) => seriesClass(it.group);

/** The readout: the item, its lane and times as written, its status and group. */
function tipText(d: ScheduleData, it: ScheduleItem): string {
  const when = it.milestone || it.endText === '' ? it.startText : `${it.startText} → ${it.endText}`;
  return [
    it.label,
    `${d.lanes[it.lane]} · ${when}`,
    ...(it.status !== '' ? [`status: ${it.status}`] : []),
    ...(d.groups.length > 0 ? [`group: ${d.groups[it.group]}`] : []),
  ].join('\n');
}

/**
 * A schedule: one band per lane, with the lane name on the left and a bar
 * from start to end on a shared time axis (calendar ticks, UTC). A milestone
 * is a diamond. Items that overlap stack in sub-rows inside their lane. Bars
 * take their group's series slot (series 1 with no group column). Status is
 * never colour alone: planned is an outlined bar, done prefixes its label
 * with ✓, and blocked gets the error outline and a '!' glyph. A label sits
 * on its bar when it fits, else after it, else whole before it, else cut
 * after it or only in the readout; outside its bar it never covers another
 * label, glyph or mark of its row. The marker option draws a dashed line
 * with its date on top. When lanes do not fit, the first ones stay and
 * '+N more lanes' counts the rest. Dense keeps the bars, the diamonds and
 * the marker line. The legend shows only when no lane has to be cut for it.
 */
export function renderSchedule(d: ScheduleData, box: PlotBox, dense: boolean): SVGElement[] {
  const out: SVGElement[] = [];
  if (d.items.length === 0 || box.w <= 0) {
    return out;
  }
  let lo = Math.min(...d.items.map(it => it.start));
  let hi = Math.max(...d.items.map(it => it.end));
  if (d.marker !== null) {
    lo = Math.min(lo, d.marker);
    hi = Math.max(hi, d.marker);
  }
  if (!(hi > lo)) {
    const pad = d.xKind === 'clock' ? HOUR : DAY;
    lo -= pad / 2;
    hi += pad / 2;
  }
  const marker = !dense && d.marker !== null;
  const rowsTop = box.y + (marker ? MARKER_H : 0);
  const free = Math.max(0, box.h - (rowsTop - box.y) - (dense ? 0 : AXIS_H));
  const laneW = dense ? 0 : Math.min(box.w * 0.3, Math.max(...d.lanes.map(l => textW(l, LANE_PX))) + 12);
  const left = box.x + laneW;
  const right = Math.max(left + 2 * PAD_X + 1, box.x + box.w);
  // A label that cannot sit on its bar goes after it; at the right edge the
  // axis gives up room for it, up to a quarter of its width.
  const span = right - left - 2 * PAD_X;
  const at = (t: number, room: number) => left + PAD_X + ((t - lo) / (hi - lo)) * (span - room);
  const overflow = dense ? 0 : Math.max(0, ...d.items.map(it => {
    const width = textW(labelText(it), ITEM_PX);
    const x0 = at(it.start, 0);
    const x1 = it.milestone ? x0 + BAR_MAX / 2 + 1 : at(it.end, 0);
    const glyph = it.status === 'blocked' ? 10 : 0;
    const inside = !it.milestone && width + 10 <= x1 - x0;
    // what must fit before `right`: the glyph, and the label when it goes outside
    return (inside ? x1 + glyph : x1 + 4 + glyph + width + 4) - right;
  }));
  const reserve = Math.min(span / 4, overflow);
  const px = (t: number) => at(t, reserve);

  // The row height comes from the sub-row count, the diamond size from the
  // row height; packing with the largest diamond can only add sub-rows.
  const { placed, subRows } = pack(d.items, d.lanes.length, px, BAR_MAX / 2 + 1);
  const total = subRows.reduce((s, n) => s + n, 0);
  // The legend shows only when it leaves every lane its rows.
  const legendH = !dense && d.groups.length >= 2 && (free - LEGEND_H) / total >= ROW_MIN ? LEGEND_H : 0;
  const rowsH = free - legendH;
  let shown = d.lanes.length;
  let rowH = dense ? rowsH / total : Math.min(ROW_MAX, rowsH / total);
  if (!dense && rowH < ROW_MIN) {
    // Whole lanes, in order, with one row kept for the '+N more lanes' line.
    const room = Math.floor(rowsH / ROW_MIN) - 1;
    let used = 0;
    shown = 0;
    while (shown < d.lanes.length && (shown === 0 || used + subRows[shown] <= room)) {
      used += subRows[shown];
      shown++;
    }
    rowH = shown === d.lanes.length ? rowsH / total : Math.min(ROW_MAX, (rowsH - ROW_MIN) / used);
  }
  const laneTop: number[] = [];
  let y = rowsTop;
  for (let l = 0; l < shown; l++) {
    laneTop.push(y);
    y += subRows[l] * rowH;
  }
  const rowsBottom = y;
  const cut = shown < d.lanes.length;
  // The '+N more lanes' line sits above the axis, inside the plot.
  const axisY = cut ? rowsBottom + ROW_MIN : rowsBottom;
  const barH = Math.max(1, Math.min(BAR_MAX, dense ? rowH * 0.7 : rowH - 6));
  const half = barH / 2 + 1;

  if (!dense) {
    const ticks = timeTicks(lo, hi, span - reserve, d.xKind, TICK_PX, 16);
    ticks.forEach(t => {
      const x = num(px(t.at));
      out.push(svgEl('line', { x1: x, x2: x, y1: num(rowsTop), y2: num(axisY), class: 'chart-grid' }));
    });
    out.push(svgEl('line', { x1: num(box.x), x2: num(right), y1: num(axisY), y2: num(axisY), class: 'chart-base' }));
    out.push(...axisLabels(ticks.map(t => ({ x: px(t.at), text: t.text })), axisY + 12, left, right, TICK_PX));
    for (let l = 0; l < shown; l++) {
      if (l > 0) {
        out.push(svgEl('line', { x1: num(box.x), x2: num(right), y1: num(laneTop[l]), y2: num(laneTop[l]), class: 'chart-grid' }));
      }
      const name = fitText(d.lanes[l], laneW - 8, LANE_PX);
      if (name !== '') {
        out.push(txt(box.x, laneTop[l] + rowH / 2 + 4, name, 'chart-label chart-text', LANE_PX));
      }
    }
    if (cut) {
      out.push(txt(box.x, rowsBottom + ROW_MIN / 2 + 4, `+${d.lanes.length - shown} more lanes`, 'chart-more chart-faint', TICK_PX));
    }
  }
  if (d.marker !== null) {
    const x = px(d.marker);
    out.push(svgEl('line', { x1: num(x), x2: num(x), y1: num(rowsTop - (marker ? 2 : 0)), y2: num(axisY), class: 'chart-marker' }));
    if (marker) {
      const text = formatX(d.marker, d.xKind, hi - lo);
      const w = textW(text, TICK_PX);
      const anchor = x - w / 2 < left ? 'start' : x + w / 2 > right ? 'end' : 'middle';
      out.push(txt(anchor === 'start' ? Math.max(box.x, x - 2) : anchor === 'end' ? Math.min(right, x + 2) : x, box.y + 9, text, 'chart-marker-label chart-muted', TICK_PX, anchor));
    }
  }

  const rowY = (p: Placed) => laneTop[p.item.lane] + (p.sub + 0.5) * rowH;
  const visible = placed.filter(p => p.item.lane < shown);
  for (const p of visible) {
    const it = p.item;
    const status = `${it.status === 'planned' ? ' chart-planned' : ''}${it.status === 'blocked' ? ' chart-error' : ''}`;
    const cy = rowY(p);
    const tip = tipText(d, it);
    if (it.milestone) {
      const x = px(it.start);
      out.push(svgEl('path', {
        d: `M${num(x)} ${num(cy - half)}L${num(x + half)} ${num(cy)}L${num(x)} ${num(cy + half)}L${num(x - half)} ${num(cy)}Z`,
        class: `chart-milestone ${slot(it)}${status}`, 'stroke-width': '1.5', 'data-tip': tip,
      }));
    } else {
      out.push(svgEl('rect', {
        x: num(p.x0), y: num(cy - barH / 2), width: num(p.x1 - p.x0), height: num(barH), rx: '3',
        class: `chart-bar ${slot(it)}${status}`, 'data-tip': tip,
      }));
    }
  }

  if (!dense) {
    // Labels go left to right in each sub-row. `taken` is how far the row is
    // used so far, by marks, glyphs and labels, so a label moved before its
    // bar never lands on the label after the bar before it. A label after
    // its mark stops short of the next mark.
    const taken = new Map<string, number>();
    const nextStart = (p: Placed) => Math.min(
      right,
      ...visible.filter(q => q !== p && q.item.lane === p.item.lane && q.sub === p.sub && q.x0 >= p.x1).map(q => q.x0),
    );
    const order = visible.slice().sort((a, b) => a.item.lane - b.item.lane || a.sub - b.sub || a.x0 - b.x0);
    for (const p of order) {
      const it = p.item;
      const row = `${it.lane}:${p.sub}`;
      const prev = taken.get(row) ?? left;
      const cy = rowY(p);
      const x = it.milestone ? px(it.start) : p.x0;
      const w = p.x1 - p.x0;
      const end = it.milestone ? x + half : x + w;
      const text = labelText(it);
      const width = textW(text, ITEM_PX);
      let used = end;
      let after = end + 4;
      if (it.status === 'blocked') {
        out.push(txt(end + 3, cy + 4, '!', 'chart-glyph chart-error', ITEM_PX));
        used = end + 3 + textW('!', ITEM_PX);
        after += 8;
      }
      if (!it.milestone && width + 10 <= w) {
        // On a solid bar the label takes the theme's colour for that fill; an outlined bar keeps ink.
        const cls = it.status === 'planned' ? 'chart-label chart-text' : `chart-label chart-on-fill on-${slot(it)}`;
        out.push(txt(x + 5, cy + 3.5, text, cls, ITEM_PX));
      } else {
        // After the item, else whole before it, else cut after it.
        const room = nextStart(p) - after - 4;
        const before = (it.milestone ? x - half : x) - 4;
        if (width > room && it.status !== 'blocked' && before - width - 4 >= prev) {
          out.push(txt(before, cy + 3.5, text, 'chart-label chart-text', ITEM_PX, 'end'));
        } else {
          // A cut label keeps at least three characters, or it is left to the readout.
          const shownText = room > 0 ? fitText(text, room, ITEM_PX) : '';
          if (shownText === text || shownText.length >= 4) {
            out.push(txt(after, cy + 3.5, shownText, 'chart-label chart-text', ITEM_PX));
            used = after + textW(shownText, ITEM_PX);
          }
        }
      }
      taken.set(row, Math.max(prev, used));
    }
  }

  if (legendH > 0) {
    out.push(legend(d.groups.map((name, k) => ({ name, cls: seriesClass(k) })), box.x, box.y + box.h - 4, box.w));
  }
  return out;
}
