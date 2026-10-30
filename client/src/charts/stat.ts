import type { StatData } from '../../../module/src/chart-contracts';
import type { PlotBox } from './index';
import { fitText, formatValue, textW } from './scale';
import { lineAttrs, num, svgEl, txt } from './svg';

const DELTA_PX = 12;
/** The delta line's baseline sits this far under the number's. */
const DELTA_DY = 20;
/** Air between the line above the sparkline and its top. */
const SPARK_GAP = 10;
/** A sparkline shorter than this is dropped, so the number keeps its size. */
const SPARK_MIN_H = 20;
/** The number is never drawn smaller than this to make room for a sparkline. */
const VALUE_MIN_FOR_SPARK = 24;

/**
 * One big number with its unit, a delta line (▲/▼ glyph, good or bad by
 * upIsGood, then deltaLabel; a % value changes in percentage points), and a
 * sparkline of the trend across the card under them, filling the height left:
 * faint, with the last segment and end dot in series-1. No axes. Dense keeps
 * the number and the sparkline.
 */
export function renderStat(d: StatData, box: PlotBox, dense: boolean): SVGElement[] {
  const out: SVGElement[] = [];
  const { unit, precision, deltaLabel, upIsGood } = d.options;
  const valueText = formatValue(d.value, '', precision);
  const showDelta = !dense && d.previous !== null;
  const deltaH = showDelta ? DELTA_DY : 0;

  // Number size: up to 44 px, as wide as the card allows, and short enough to
  // leave a sparkline its least height under the delta line.
  const perPx = (textW(valueText, 100) + (unit ? textW(unit, 55) + 8 : 0)) / 100;
  const size = (reserve: number) => Math.min(44, (box.h - deltaH - reserve) / 0.85, box.w / perPx);
  const alone = Math.max(12, size(0));
  // The sparkline may shrink the number to VALUE_MIN_FOR_SPARK, never below the
  // size the width already holds it to: a sparkline that costs nothing stays.
  const withSpark = size(SPARK_GAP + SPARK_MIN_H);
  const hasSpark = d.trend.length >= 2 && withSpark >= Math.min(VALUE_MIN_FOR_SPARK, alone);
  const fs = hasSpark ? withSpark : alone;
  const baseline = box.y + fs * 0.85;

  const value = txt(box.x, baseline, valueText, 'chart-stat-value chart-text', Math.round(fs), 'start', true);
  value.setAttribute('data-tip', `${d.valueName}: ${formatValue(d.value, unit, precision)}`);
  if (unit) {
    value.append(svgEl('tspan', { class: 'chart-muted', 'font-size': String(Math.round(fs * 0.55)), dx: num(fs * 0.08) }, unit));
  }
  out.push(value);

  if (showDelta && d.previous !== null) {
    const diff = d.value - d.previous;
    // A change in a percentage is in percentage points; its relative change would read as a second percentage.
    const points = unit === '%';
    const diffUnit = points ? 'pp' : unit;
    const line = txt(box.x, baseline + DELTA_DY, '', 'chart-delta', DELTA_PX, 'start', true);
    // 1e308 - -1e308 overflows: say so rather than draw a wrong number.
    const known = Number.isFinite(diff);
    const head = diff === 0 || !known
      ? svgEl('tspan', { class: 'chart-muted' }, known ? 'no change' : 'change unavailable')
      : svgEl('tspan', { class: diff > 0 === upIsGood ? 'chart-good' : 'chart-bad' }, `${diff > 0 ? '▲' : '▼'} ${formatValue(Math.abs(diff), diffUnit, precision)}`);
    line.append(head);
    // The label gives way to the change: it is cut to the room left (the
    // readout keeps it whole), so the line never runs off the card.
    const label = deltaLabel ? fitText(` ${deltaLabel}`, box.w - textW(head.textContent ?? '', DELTA_PX), DELTA_PX) : '';
    if (label.trim() !== '') {
      line.append(svgEl('tspan', { class: 'chart-muted' }, label));
    }
    const sign = diff > 0 ? '+' : diff < 0 ? '-' : '';
    // Not finite for previous 0, or a tiny previous whose ratio overflows: no percentage then.
    const pct = Math.abs(diff / d.previous) * 100;
    const rel = !points && Number.isFinite(pct) ? ` (${sign}${formatValue(pct, '')}%)` : '';
    const change = known ? `${sign}${formatValue(Math.abs(diff), diffUnit, precision)}${rel}` : 'unavailable';
    line.setAttribute('data-tip', `previous: ${formatValue(d.previous, unit, precision)}\nchange: ${change}${deltaLabel ? ` ${deltaLabel}` : ''}`);
    out.push(line);
  }

  if (hasSpark) {
    const n = d.trend.length;
    const x0 = box.x;
    const x1 = box.x + box.w - 4;
    const y0 = baseline + deltaH + SPARK_GAP;
    const y1 = box.y + box.h - 4;
    const lo = Math.min(...d.trend);
    const hi = Math.max(...d.trend);
    const px = (i: number) => x0 + (i / (n - 1)) * (x1 - x0);
    // Halve before subtracting: hi - lo overflows for ±1e308. A span lost to underflow draws flat.
    const half = hi / 2 - lo / 2;
    const py = (v: number) => (half > 0 ? y1 - ((v / 2 - lo / 2) / half) * (y1 - y0) : (y0 + y1) / 2);
    const pts = d.trend.map((v, i) => `${num(px(i))},${num(py(v))}`);
    if (n > 2) {
      out.push(svgEl('polyline', { points: pts.slice(0, n - 1).join(' '), ...lineAttrs('chart-spark', 1.5) }));
    }
    out.push(
      svgEl('polyline', { points: pts.slice(n - 2).join(' '), ...lineAttrs('chart-line series-1') }),
      svgEl('circle', {
        cx: num(px(n - 1)), cy: num(py(d.trend[n - 1])), r: '3', 'stroke-width': '2',
        class: 'chart-dot chart-ring series-1',
        'data-tip': `${d.valueName}: ${formatValue(d.trend[n - 1], unit, precision)}`,
      }),
    );
  }
  return out;
}
