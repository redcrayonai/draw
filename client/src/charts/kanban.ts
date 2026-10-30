import type { KanbanCard, KanbanData } from '../../../module/src/chart-contracts';
import type { PlotBox } from './index';
import { fitText, textW } from './scale';
import { LEGEND_H, legend, num, seriesClass, svgEl, txt } from './svg';

const HEAD_PX = 11;
const LANE_PX = 10;
const TITLE_PX = 11;
const DETAIL_PX = 10;
/** The stage names and counts, then a hairline. */
const HEAD_H = 24;
/** A swim lane's name and its rule. */
const LANE_H = 18;
const CARD_H = 24;
/** A card with a detail line. */
const DETAIL_CARD_H = 36;
const CARD_GAP = 4;
const COL_GAP = 8;
/** Dense cards shrink to fit, down to this. */
const DENSE_MIN_H = 3;
const DENSE_LANE_GAP = 6;

/**
 * Card rows for each lane: one at a time, lane by lane, while rows remain,
 * so every lane with cards gets a fair share and none takes more than it
 * needs (its fullest cell).
 */
function allot(need: number[], rows: number): number[] {
  const out = need.map(() => 0);
  let left = rows;
  for (let grew = true; left > 0 && grew; ) {
    grew = false;
    for (let l = 0; l < need.length && left > 0; l++) {
      if (out[l] < need[l]) {
        out[l]++;
        left--;
        grew = true;
      }
    }
  }
  return out;
}

/** The card rows each lane gets, and the card height (dense cards shrink to fit). */
function layout(need: number[], avail: number, laneH: number, cardH: number, dense: boolean): { rows: number[]; cardH: number; room: number } {
  const room = avail - need.length * laneH;
  if (dense) {
    const total = need.reduce((s, n) => s + n, 0);
    const h = Math.max(DENSE_MIN_H, Math.min(cardH, total === 0 ? cardH : room / total - CARD_GAP));
    return { rows: allot(need, Math.max(0, Math.floor((room + CARD_GAP) / (h + CARD_GAP)))), cardH: h, room };
  }
  return { rows: allot(need, Math.max(0, Math.floor((room + CARD_GAP) / (cardH + CARD_GAP)))), cardH, room };
}

function tipText(d: KanbanData, c: KanbanCard): string {
  const where = [d.stages[c.stage], d.lanes.length > 0 ? d.lanes[c.lane] : '', c.group >= 0 ? d.groups[c.group] : ''].filter(s => s !== '');
  return [c.title, ...(c.detail !== '' ? [c.detail] : []), where.join(' · ')].join('\n');
}

/**
 * A kanban board: one column per stage, in first-seen order, under its name
 * and card count, and one band per swim lane (when there is a lane column)
 * under the lane's name and a rule. A card is a quiet hairline box with its
 * title and, when any card has one, a detail line; a card with a group gets
 * an edge in its series slot and the legend says which group is which.
 * Lanes share the rows fairly; a cell with more cards than rows shows what
 * fits, the last with a '+N' for the rest. To show every card, the detail
 * lines go, then the legend; the lanes merge into one band only when a lane
 * with cards would get no row.
 * Dense keeps the boxes and their edges only.
 */
export function renderKanban(d: KanbanData, box: PlotBox, dense: boolean): SVGElement[] {
  const out: SVGElement[] = [];
  const nStages = d.stages.length;
  if (nStages === 0 || box.w <= 0) {
    return out;
  }
  const colW = Math.max(1, (box.w - COL_GAP * (nStages - 1)) / nStages);
  const colX = (s: number) => box.x + s * (colW + COL_GAP);
  const headH = dense ? 0 : HEAD_H;
  // Layouts from richest to plainest: detail lines go first, then the legend,
  // then the lanes (merged into one band). Lanes stay while any layout with
  // them gives every lane with cards a row; among those, the first that shows
  // every card wins, else the first that gives every lane a row. Merged is
  // the last resort.
  const anyDetail = d.cards.some(c => c.detail !== '');
  const anyKey = d.groups.length > 0;
  const candidates = dense
    ? [{ detail: false, key: false, merge: false }]
    : [
        { detail: anyDetail, key: anyKey, merge: false },
        { detail: false, key: anyKey, merge: false },
        { detail: false, key: false, merge: false },
        { detail: false, key: false, merge: d.lanes.length > 0 },
      ];
  const layouts = candidates.map(c => {
    const cells = Array.from({ length: c.merge ? 1 : Math.max(1, d.lanes.length) }, () => Array.from({ length: nStages }, (): KanbanCard[] => []));
    for (const card of d.cards) {
      cells[c.merge ? 0 : card.lane][card.stage].push(card);
    }
    const need = cells.map(row => Math.max(...row.map(cell => cell.length)));
    const lanesDrawn = !c.merge && d.lanes.length > 0;
    const laneH = !lanesDrawn ? 0 : dense ? DENSE_LANE_GAP : LANE_H;
    const fit = layout(need, box.h - headH - (c.key ? LEGEND_H : 0), laneH, c.detail ? DETAIL_CARD_H : CARD_H, dense);
    return {
      ...c, cells, laneH, lanesDrawn, ...fit,
      all: fit.room >= 0 && fit.rows.every((n, l) => n >= need[l]),
      some: fit.room >= 0 && fit.rows.every((n, l) => n > 0 || need[l] === 0),
    };
  });
  const chosen = layouts.find(t => t.all && !t.merge) ?? layouts.find(t => t.some && !t.merge) ?? layouts.find(t => t.some) ?? layouts[layouts.length - 1];
  const { detail: hasDetail, key, cells, laneH, lanesDrawn, rows, cardH } = chosen;

  if (!dense) {
    d.stages.forEach((name, s) => {
      const count = String(d.cards.filter(c => c.stage === s).length);
      const countW = textW(count, HEAD_PX);
      const x = colX(s);
      const shown = fitText(name, colW - countW - 10, HEAD_PX);
      if (shown !== '') {
        out.push(txt(x, box.y + 13, shown, 'chart-stage chart-muted', HEAD_PX));
      }
      out.push(txt(x + colW, box.y + 13, count, 'chart-count chart-faint', HEAD_PX, 'end', true));
      out.push(svgEl('line', { x1: num(x), x2: num(x + colW), y1: num(box.y + 19.5), y2: num(box.y + 19.5), class: 'chart-grid' }));
    });
  }

  let y = box.y + headH;
  for (let l = 0; l < cells.length; l++) {
    if (lanesDrawn && !dense) {
      const name = fitText(d.lanes[l], box.w * 0.6, LANE_PX);
      const nameW = name === '' ? 0 : textW(name, LANE_PX);
      if (name !== '') {
        out.push(txt(box.x, y + 12, name, 'chart-lane chart-faint', LANE_PX));
      }
      out.push(svgEl('line', { x1: num(box.x + nameW + (nameW > 0 ? 6 : 0)), x2: num(box.x + box.w), y1: num(y + 8.5), y2: num(y + 8.5), class: 'chart-grid' }));
    }
    y += laneH;
    for (let s = 0; s < nStages; s++) {
      const cell = cells[l][s];
      const cards = cell.slice(0, rows[l]);
      const hidden = cell.length - cards.length;
      const x = colX(s);
      cards.forEach((c, i) => {
        const cy = y + i * (cardH + CARD_GAP);
        out.push(svgEl('rect', {
          x: num(x), y: num(cy), width: num(colW), height: num(cardH), rx: dense ? '1' : '4',
          class: 'chart-card', 'data-tip': tipText(d, c),
        }));
        const edge = c.group >= 0;
        if (edge) {
          const inset = Math.min(4, cardH / 4);
          out.push(svgEl('rect', {
            x: num(x + 3), y: num(cy + inset), width: '2.5', height: num(Math.max(1, cardH - 2 * inset)), rx: '1.25',
            class: `chart-edge ${seriesClass(c.group)}`,
          }));
        }
        if (dense) {
          return;
        }
        // The last card of a cut cell counts the cards under it.
        const more = hidden > 0 && i === cards.length - 1 ? `+${hidden}` : '';
        const moreW = more === '' ? 0 : textW(more, LANE_PX) + 6;
        if (more !== '') {
          out.push(txt(x + colW - 6, cy + 16, more, 'chart-more chart-faint', LANE_PX, 'end', true));
        }
        const tx = x + (edge ? 11 : 8);
        const room = colW - (tx - x) - 6 - moreW;
        const title = fitText(c.title, room, TITLE_PX);
        if (title !== '') {
          out.push(txt(tx, cy + 16, title, 'chart-label chart-text', TITLE_PX));
        }
        const detail = !hasDetail || c.detail === '' ? '' : fitText(c.detail, room, DETAIL_PX);
        if (detail !== '') {
          out.push(txt(tx, cy + 29, detail, 'chart-label chart-muted', DETAIL_PX));
        }
      });
    }
    y += rows[l] * (cardH + CARD_GAP);
  }
  if (key) {
    out.push(legend(d.groups.map((name, k) => ({ name, cls: seriesClass(k) })), box.x, box.y + box.h - 4, box.w));
  }
  return out;
}
