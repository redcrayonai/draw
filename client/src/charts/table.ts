import type { TableData, Threshold } from '../../../module/src/chart-contracts';
import type { PlotBox } from './index';
import { fitText, textW } from './scale';
import { num, svgEl, txt } from './svg';

const HEAD_H = 20;
const ROW_H = 22;
const PAD = 6;
const HEAD_PX = 10;
const CELL_PX = 11;
type Status = 'crit' | 'warn' | null;

/** Warn and crit differ in shape, not only in colour (red and amber look
 *  alike to many readers and in greyscale). */
const GLYPH: Record<'crit' | 'warn', string> = { crit: '●', warn: '▲' };

function statusOf(v: number, t: Threshold): Status {
  const past = (limit: number) => (t.direction === 'above' ? v >= limit : v <= limit);
  return past(t.crit) ? 'crit' : past(t.warn) ? 'warn' : null;
}

/**
 * A table as SVG text: a muted header row, rows split by hairlines, number
 * columns right-aligned in tabular figures. A threshold breach gets a glyph
 * ('●' crit, '▲' warn) in chart-crit or chart-warn, so status is never colour alone. Rows
 * that do not fit are cut and a '+N more rows' line says how many. Dense
 * drops every text (marks stay, labels drop): the row hairlines and a dot per
 * threshold breach remain.
 */
export function renderTable(d: TableData, box: PlotBox, dense: boolean): SVGElement[] {
  const out: SVGElement[] = [];
  const nCol = d.header.length;
  if (nCol === 0 || box.w <= 0) {
    return out;
  }
  const rule = d.header.map(h => d.options.thresholds.find(t => t.column === h));
  const mono = (c: number) => c === 0 && !d.numeric[c];
  const natural = d.header.map((h, c) => Math.max(
    textW(h, HEAD_PX),
    ...d.rows.map(r => textW(r[c] ?? '', CELL_PX, mono(c))),
  ) + 2 * PAD + (rule[c] ? 12 : 0));
  const sum = natural.reduce((s, w) => s + w, 0);
  // A cut number misleads ('1…' for 1.4), a cut name does not: when the table
  // is too wide, number columns keep their natural width and text columns share
  // the rest. Otherwise every column scales by the same factor.
  const numW = natural.reduce((s, w, c) => s + (d.numeric[c] ? w : 0), 0);
  const squeeze = sum > box.w && numW < box.w && numW < sum;
  const widths = squeeze
    ? natural.map((w, c) => (d.numeric[c] ? w : (w / (sum - numW)) * (box.w - numW)))
    : natural.map(w => (w / sum) * box.w);
  const colX = widths.map((_, c) => box.x + widths.slice(0, c).reduce((s, w) => s + w, 0));

  const headH = dense ? 0 : HEAD_H;
  const fit = Math.max(0, Math.floor((box.h - headH) / ROW_H));
  const cut = d.rows.length > fit;
  const shown = cut ? Math.max(0, fit - (dense ? 0 : 1)) : d.rows.length;

  if (!dense) {
    d.header.forEach((h, c) => {
      const right = d.numeric[c];
      out.push(txt(
        right ? colX[c] + widths[c] - PAD : colX[c] + PAD,
        box.y + 13,
        fitText(h, widths[c] - 2 * PAD, HEAD_PX),
        'chart-head chart-faint',
        HEAD_PX,
        right ? 'end' : 'start',
      ));
    });
    out.push(svgEl('line', { x1: num(box.x), x2: num(box.x + box.w), y1: num(box.y + headH - 0.5), y2: num(box.y + headH - 0.5), class: 'chart-grid' }));
  }

  for (let r = 0; r < shown; r++) {
    const row = d.rows[r];
    const y0 = box.y + headH + r * ROW_H;
    const base = y0 + 15;
    const tip: string[] = [];
    if (r > 0) {
      out.push(svgEl('line', { x1: num(box.x), x2: num(box.x + box.w), y1: num(y0), y2: num(y0), class: 'chart-grid' }));
    }
    d.header.forEach((h, c) => {
      const cell = row[c] ?? '';
      const t = rule[c];
      // the parser's number, never Number(cell): '−5' (U+2212) is NaN to Number()
      const v = d.values[r]?.[c] ?? null;
      const status = t && v !== null ? statusOf(v, t) : null;
      const room = widths[c] - 2 * PAD - (status ? 12 : 0);
      const shownText = fitText(cell, room, CELL_PX, mono(c));
      const cls = `chart-cell-text chart-text${mono(c) ? ' chart-mono' : ''}`;
      const right = colX[c] + widths[c] - PAD;
      if (dense) {
        const cx = right - 3, cy = y0 + ROW_H / 2;
        if (status === 'crit') {
          out.push(svgEl('circle', { cx: num(cx), cy: num(cy), r: '3', class: 'chart-glyph chart-crit' }));
        } else if (status === 'warn') {
          out.push(svgEl('path', { d: `M${num(cx)} ${num(cy - 3.5)}L${num(cx + 3.5)} ${num(cy + 2.5)}L${num(cx - 3.5)} ${num(cy + 2.5)}Z`, class: 'chart-glyph chart-warn' }));
        }
      } else if (d.numeric[c]) {
        out.push(txt(right, base, shownText, cls, CELL_PX, 'end', true));
        if (status) {
          out.push(txt(right - textW(shownText, CELL_PX) - 4, base, GLYPH[status], `chart-glyph chart-${status}`, 9, 'end'));
        }
      } else {
        out.push(txt(colX[c] + PAD, base, shownText, cls, CELL_PX));
      }
      const limit = t ? `${t.direction === 'above' ? '≥' : '≤'} ${status === 'crit' ? t.crit : t.warn}` : '';
      tip.push(status ? `${h}: ${cell} · ${status} (${limit})` : `${h}: ${cell}`);
    });
    out.push(svgEl('rect', {
      x: num(box.x), y: num(y0), width: num(box.w), height: String(ROW_H),
      fill: 'transparent', class: 'chart-hit', 'data-tip': tip.join('\n'),
    }));
  }
  if (cut && !dense) {
    out.push(txt(box.x + PAD, box.y + headH + shown * ROW_H + 15, `+${d.rows.length - shown} more rows`, 'chart-more chart-faint', HEAD_PX));
  }
  return out;
}
