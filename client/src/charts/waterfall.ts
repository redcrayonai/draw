import type { WaterfallData } from '../../../module/src/chart-contracts';
import type { PlotBox } from './index';
import { axisTicks, fitText, formatValue, textW } from './scale';
import { LEGEND_H, axisLabels, legend, num, seriesClass, svgEl, txt } from './svg';

const ROW_H = 18;
/** Rows grow with the card up to this height. */
const ROW_MAX = 20;
const BAR_H = 10;
const INDENT = 12;
const NAME_PX = 11;
const TICK_PX = 10;
/** Room under the rows for the ms axis labels. */
const AXIS_H = 16;
const OTHER = 'other services';

/**
 * Which spans get a row when only `cap` fit: the root, then each error span
 * with its ancestors (when the whole chain fits), then the rest in
 * depth-first order. Indices come back in depth-first order.
 */
function visibleSpans(spans: WaterfallData['spans'], cap: number): number[] {
  if (spans.length <= cap) {
    return spans.map((_, i) => i);
  }
  const byId = new Map(spans.map((s, i) => [s.id, i]));
  const chosen = new Set<number>();
  const take = (chain: number[]) => {
    if (chosen.size + chain.filter(i => !chosen.has(i)).length <= cap) {
      chain.forEach(i => chosen.add(i));
    }
  };
  take([0]);
  spans.forEach((s, i) => {
    if (s.status !== 'error') {
      return;
    }
    const chain: number[] = [];
    for (let j: number | undefined = i; j !== undefined && !chain.includes(j); j = byId.get(spans[j].parentId)) {
      chain.push(j);
    }
    take(chain);
  });
  for (let i = 0; i < spans.length && chosen.size < cap; i++) {
    chosen.add(i);
  }
  return [...chosen].sort((a, b) => a - b);
}

/**
 * A trace waterfall: one row per span in depth-first order. The name is
 * indented by depth; the bar runs from start to start + duration on a shared
 * ms axis and takes its service's slot (folded services are chart-other). An
 * error span gets chart-error and a '!' glyph. Rows grow up to 20 px; when
 * they do not fit, the root and the error spans stay and a '+N more spans'
 * line counts the rest. The legend sits right under the axis and lists the
 * services of the rows shown.
 */
export function renderWaterfall(d: WaterfallData, box: PlotBox, dense: boolean): SVGElement[] {
  const out: SVGElement[] = [];
  const spans = d.spans;
  if (spans.length === 0 || box.w <= 0) {
    return out;
  }
  const lo = Math.min(...spans.map(s => s.start));
  const hi = Math.max(d.end, ...spans.map(s => s.start + s.duration));
  const legendH = !dense && d.services.length >= 2 ? LEGEND_H : 0;
  const rowsH = box.h - (dense ? 0 : AXIS_H) - legendH;
  const nameW = dense ? 0 : Math.min(
    box.w * 0.4,
    Math.max(...spans.map(s => s.depth * INDENT + textW(s.name, NAME_PX) + (s.status === 'error' ? 14 : 0))) + 8,
  );
  const left = box.x + nameW;
  const right = Math.max(left + 1, box.x + box.w - (dense ? 0 : 4));
  // Labels are centred on their ticks: neighbours need a label width and some air.
  const ticks = axisTicks(0, hi - lo, right - left, textW(formatValue(hi - lo, 'ms'), TICK_PX) + 12);
  const domain = ticks[ticks.length - 1] || 1;
  const px = (v: number) => left + ((v - lo) / domain) * (right - left);

  // dense rows are sized to fit every span; only the labelled layout cuts
  const rowH = dense ? Math.min(ROW_H, rowsH / spans.length) : Math.min(ROW_MAX, Math.max(ROW_H, rowsH / spans.length));
  const fit = Math.max(0, Math.floor(rowsH / rowH + 1e-9));
  const cut = !dense && spans.length > fit;
  const rows = cut ? visibleSpans(spans, Math.max(0, fit - 1)) : spans.map((_, i) => i);
  const rowsBottom = box.y + (cut ? rows.length + 1 : rows.length) * rowH;

  const slot = (service: string) => {
    const i = d.services.indexOf(service);
    return service === OTHER || i < 0 || i >= 5 ? 'chart-other' : seriesClass(i);
  };

  if (!dense) {
    ticks.forEach((t, i) => {
      const x = px(lo + t);
      out.push(svgEl('line', { x1: num(x), x2: num(x), y1: num(box.y), y2: num(rowsBottom), class: i === 0 ? 'chart-base' : 'chart-grid' }));
    });
    out.push(...axisLabels(ticks.map(t => ({ x: px(lo + t), text: formatValue(t, 'ms') })), rowsBottom + 12, box.x, box.x + box.w, TICK_PX));
  }

  const bar = Math.min(BAR_H, rowH * 0.7);
  rows.forEach((si, i) => {
    const s = spans[si];
    const cy = box.y + rowH * (i + 0.5);
    const x = px(s.start);
    const w = Math.max(2, px(s.start + s.duration) - x);
    const error = s.status === 'error';
    // The start is an offset from the trace start, in the axis's frame.
    const tip = `${s.name} · ${s.service} · ${formatValue(s.start - lo, 'ms')} → ${formatValue(s.duration, 'ms')}${error ? '\nstatus: error' : ''}`;
    out.push(svgEl('rect', {
      x: num(x), y: num(cy - bar / 2), width: num(w), height: num(bar), rx: '2',
      class: `chart-bar ${slot(s.service)}${error ? ' chart-error' : ''}`,
      'data-tip': tip,
    }));
    if (!dense) {
      const indent = s.depth * INDENT;
      out.push(txt(box.x + indent, cy + 4, fitText(s.name, nameW - indent - 8 - (error ? 12 : 0), NAME_PX), 'chart-label chart-text', NAME_PX));
      if (error) {
        out.push(txt(left - 6, cy + 4, '!', 'chart-glyph chart-error', NAME_PX, 'end'));
      }
    } else if (error) {
      // Dense has no '!': a tick beside the bar keeps the error from being colour alone.
      // No room after it: before it, or, for a span that fills the trace, inside its start.
      const after = x + w + 2;
      const markX = after + 2 <= box.x + box.w ? after : x - 4 >= box.x ? x - 4 : x + 2;
      out.push(svgEl('rect', {
        x: num(markX), y: num(cy - bar / 2), width: '2', height: num(bar),
        class: 'chart-glyph chart-error',
      }));
    }
  });
  if (cut) {
    out.push(txt(box.x, box.y + rows.length * rowH + rowH / 2 + 4, `+${spans.length - rows.length} more spans`, 'chart-more chart-faint', TICK_PX));
  }
  if (legendH > 0) {
    const shown = new Set(rows.map(i => spans[i].service));
    const items = d.services.filter(name => shown.has(name)).map(name => ({ name, cls: slot(name) }));
    out.push(legend(items, box.x, rowsBottom + AXIS_H + LEGEND_H - 4, box.w));
  }
  return out;
}
