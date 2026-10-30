/**
 * Text layout inside a node's stored rect (G2, G9, G36). The drawn rect is
 * the stored rect: text never grows a node. The label wraps to at most two
 * lines inside the row's room, the sublabel takes one line, and whatever is
 * cut is ellipsized and listed in the node's <title>. The renderer and the
 * inline editor share this, so the editor sits exactly on the drawn text.
 */
import { textWidth } from './node-text';
import { ICON_TOP, iconPx, iconTextTop } from '../../module/src/node-icons';

/** Label font size per node size; matches .node.size-s / .size-l in style.css. */
export function labelFontSize(size: string): number {
  return size === 's' ? 13 : size === 'l' ? 18 : 15;
}

/** Distance between label baselines when the label wraps. */
export function labelLineHeight(fontSize: number): number {
  return Math.round(fontSize * 1.25);
}

const SUB_SIZE = 12;
/** Baseline gap from the last label line to the sublabel (−9 / +13 about the centre). */
const SUB_GAP = 22;
/** Geist cap height and descent, in em. */
const CAP = 0.72;
const DESCENT = 0.22;
/** The mono sublabel box spans this far above and below its baseline. */
const SUB_ASCENT = 9;
const SUB_DESCENT = 3;
/** Clear space inside the outline above and below the text block. */
const PAD_Y = 6;
/** Clear space at the sides: rect rows, then curved (ellipse, pill) rows. */
const PAD_X = 16;
const CURVE_INSET = 10;
/** Minimum gap between the text block and the code-ref badge (G36). */
export const BADGE_GAP = 8;
/** Least clear space a label lifted above the badge keeps below the outline. */
const LIFT_PAD_Y = 2;

/**
 * First label baseline and sublabel baseline for a block of `lines` label
 * lines centred on h/2. Label only: the cap height is centred. With a
 * sublabel: the label sits 9 above the centre and the sublabel 13 below.
 * Extra lines spread the block evenly about the same centre.
 */
export function labelBaselines(h: number, hasSub: boolean, fontSize = 15, lines = 1): { label: number; sub: number } {
  const lh = labelLineHeight(fontSize);
  const spread = ((lines - 1) * lh) / 2;
  const label = (hasSub ? h / 2 - 9 : h / 2 + 0.35 * fontSize) - spread;
  return { label, sub: label + (lines - 1) * lh + SUB_GAP };
}

export interface NodeTextLayout {
  /** Label lines as drawn (1–2); a cut line ends with an ellipsis. */
  lines: string[];
  /** First label baseline, node-local. */
  labelY: number;
  lineHeight: number;
  fontSize: number;
  /** Sublabel as drawn; '' when it has no room (or is empty). */
  sub: string;
  subY: number;
  /** Width of the narrowest label row (the inline editor's width). */
  room: number;
  /** Full label and sublabel when anything was cut, else ''. */
  title: string;
  /** The label shares the badge's row: the badge shows its count alone (G36). */
  badgeCountOnly: boolean;
}

/** Width available to a text row spanning [top, bottom] inside the outline. */
function rowRoom(shape: string, w: number, h: number, top: number, bottom: number): number {
  if (shape !== 'ellipse' && shape !== 'pill') {
    return Math.max(0, w - 2 * PAD_X);
  }
  // Same rx/ry the renderer draws: an ellipse is the full w×h oval; a pill's
  // caps have radius h/2 (SVG clamps rx to w/2 on a tall pill).
  const ry = h / 2;
  const rx = shape === 'ellipse' ? w / 2 : Math.min(h / 2, w / 2);
  const far = Math.max(Math.abs(top - ry), Math.abs(bottom - ry));
  const t = Math.min(1, far / ry);
  const half = w / 2 - rx + rx * Math.sqrt(1 - t * t);
  return Math.max(0, 2 * (half - CURVE_INSET));
}

/** `text`, or its longest prefix plus an ellipsis that fits `room`. */
export function ellipsize(text: string, room: number, size: number, mono: boolean): { text: string; cut: boolean } {
  if (textWidth(text, size, mono) <= room) {
    return { text, cut: false };
  }
  const chars = [...text];
  const fits = (k: number) => textWidth(`${chars.slice(0, k).join('').trimEnd()}…`, size, mono) <= room;
  let lo = 0;
  let hi = chars.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (fits(mid)) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  // End on a whole word when one ends near the cut ('the companion…', not
  // 'the companion ch…'); paths and identifiers have no spaces and cut anywhere.
  const space = chars.slice(0, lo).lastIndexOf(' ');
  const end = space >= Math.max(1, lo * 0.6) ? space : lo;
  return { text: `${chars.slice(0, end).join('').trimEnd()}…`, cut: true };
}

/**
 * A path (slashes, no spaces) keeps its tail, where the file name is:
 * `…/src/session.ts`, then `…/session.ts`, then the last characters.
 */
function ellipsizePath(full: string, room: number, size: number): { text: string; cut: boolean } {
  // Only a tail of about room / glyph width can show (twice that in UTF-16
  // units, for astral glyphs), so a huge sublabel costs O(room), not O(length²).
  // Node width has no maximum, so the tail is capped too (U20).
  // shortcut: a node wider than ~3000 px shows only the last 512 chars of a
  // longer path, raise the cap if such nodes appear.
  const text = full.slice(-Math.min(512, 2 * Math.ceil(room / textWidth('0', size, true)) + 2));
  if (text === full && textWidth(text, size, true) <= room) {
    return { text, cut: false };
  }
  const parts = text.split('/');
  for (let i = 1; i < parts.length; i++) {
    const tail = `…/${parts.slice(i).join('/')}`;
    if (parts[i].length > 0 && textWidth(tail, size, true) <= room) {
      return { text: tail, cut: true };
    }
  }
  const chars = [...text];
  let k = 0;
  while (k < chars.length && textWidth(`…${chars.slice(chars.length - k - 1).join('')}`, size, true) <= room) {
    k++;
  }
  return { text: `…${chars.slice(chars.length - k).join('')}`, cut: true };
}

/** Longest prefix of a word that fits `room` (at least one character). */
function breakWord(word: string, room: number, size: number): string {
  const chars = [...word];
  let k = 1;
  while (k < chars.length && textWidth(chars.slice(0, k + 1).join(''), size) <= room) {
    k++;
  }
  return chars.slice(0, k).join('');
}

/** Greedy word wrap into one line per room; the last line is ellipsized. */
function wrapLabel(label: string, rooms: number[], size: number): { lines: string[]; cut: boolean } {
  const words = label.split(/\s+/).filter(w => w.length > 0);
  const lines: string[] = [];
  let i = 0;
  for (let row = 0; row < rooms.length && i < words.length; row++) {
    const room = rooms[row];
    if (row === rooms.length - 1) {
      const last = ellipsize(words.slice(i).join(' '), room, size, false);
      lines.push(last.text);
      return { lines, cut: last.cut };
    }
    let line = words[i];
    if (textWidth(line, size) > room) {
      // A word wider than the row breaks mid-word (paths, identifiers).
      line = breakWord(line, room, size);
      words[i] = words[i].slice(line.length);
      lines.push(line);
      continue;
    }
    i++;
    while (i < words.length && textWidth(`${line} ${words[i]}`, size) <= room) {
      line = `${line} ${words[i]}`;
      i++;
    }
    lines.push(line);
  }
  return { lines: lines.length > 0 ? lines : [''], cut: false };
}

/**
 * Lines the inline editor needs to show a whole label at `room` (P9): the
 * label's own two-line maximum, not the drawn count, which a sublabel or
 * badge can hold to one.
 */
export function editLines(label: string, size: string, room: number): 1 | 2 {
  return textWidth(label, labelFontSize(size)) > room ? 2 : 1;
}

/** A boundary's icon sits left of its label, which moves right to clear it. */
export const BOUNDARY_ICON = { x: 14, y: 9, size: 20, labelX: 40 } as const;

export interface IconPlacement {
  x: number;
  y: number;
  size: number;
  /** Where the text band below the icon starts (0: the text is laid out as without an icon). */
  textTop: number;
}

/**
 * Where a box node draws its icon: centred above the label, or centred alone
 * when there is no text. Null when the node is too small for the icon and one
 * label line (it is then drawn without one, like the datastore rim and the
 * external arrow when they do not fit). `badgeTop` and `dense` are
 * layoutNodeText's: a code-ref badge row takes the bottom of the node, so the
 * label must fit between the icon and the badge, or the icon goes.
 */
export function iconPlacement(
  n: { label: string; sublabel: string; size: string },
  w: number,
  h: number,
  badgeTop: number | null = null,
  dense = false
): IconPlacement | null {
  const size = iconPx(n.size);
  if (w < size + 2 * PAD_Y + 4) return null;
  const limit = badgeTop !== null && !dense ? badgeTop - BADGE_GAP : h - PAD_Y;
  const x = (w - size) / 2;
  if (n.label.trim() === '' && n.sublabel === '') {
    const y = (h - size) / 2;
    return y >= PAD_Y && y + size <= limit ? { x, y, size, textTop: 0 } : null;
  }
  const textTop = iconTextTop(n.size);
  const fontSize = labelFontSize(n.size);
  return limit - textTop >= (CAP + DESCENT) * fontSize ? { x, y: ICON_TOP, size, textTop } : null;
}

interface Placement {
  labelY: number;
  subY: number;
  rooms: number[];
  subRoom: number;
}

/**
 * Lay out a node's label and sublabel inside its stored w×h. `badgeTop` is
 * the top of the code-ref badge when one renders (the block then ends at
 * least BADGE_GAP above it); `dense` lays out the label alone, as the
 * sublabel and badge hide below 60% zoom. `top` is where the band below an
 * icon starts (IconPlacement.textTop): the block centres in [top, h] instead.
 */
export function layoutNodeText(
  n: { label: string; sublabel: string; size: string; shape: string },
  w: number,
  h: number,
  badgeTop: number | null,
  dense = false,
  top = 0
): NodeTextLayout {
  const fontSize = labelFontSize(n.size);
  const lh = labelLineHeight(fontSize);
  const shape = n.shape || 'rect';
  // Whitespace collapsed and trimmed before every width check: the one-line
  // fit then measures what the wrap draws (agent/src/results.ts labelFit does
  // the same; the two stay identical). The <title> keeps the label as typed.
  const label = n.label.trim().replace(/\s+/g, ' ');
  const wantSub = n.sublabel.length > 0 && !dense;
  const limit = badgeTop !== null && !dense ? badgeTop - BADGE_GAP : h - PAD_Y;
  // Below an icon the gap above the band is the padding.
  const minTop = top > 0 ? top : PAD_Y;
  const baselines = (sub: boolean, lines: number) => {
    const b = labelBaselines(h - top, sub, fontSize, lines);
    return { label: b.label + top, sub: b.sub + top };
  };

  /** Centre a block of `lines` (+ sublabel), nudged inside [minTop, limit]. */
  const place = (lines: number, sub: boolean): Placement | null => {
    const b = baselines(sub, lines);
    const blockTop = b.label - CAP * fontSize;
    const bottom = sub ? b.sub + SUB_DESCENT : b.label + (lines - 1) * lh + DESCENT * fontSize;
    let shift = blockTop < minTop ? minTop - blockTop : 0;
    if (bottom + shift > limit) {
      shift = limit - bottom;
    }
    if (blockTop + shift < minTop - 1e-9) {
      return null;
    }
    const labelY = b.label + shift;
    const rooms = Array.from({ length: lines }, (_, i) =>
      rowRoom(shape, w, h, labelY + i * lh - CAP * fontSize, labelY + i * lh + DESCENT * fontSize));
    const subY = b.sub + shift;
    return { labelY, subY, rooms, subRoom: rowRoom(shape, w, h, subY - SUB_ASCENT, subY + SUB_DESCENT) };
  };

  const finish = (p: Placement, lines: string[], labelCut: boolean, sub: boolean): NodeTextLayout => {
    const isPath = n.sublabel.includes('/') && !/\s/.test(n.sublabel);
    const s = !sub
      ? { text: '', cut: false }
      : isPath
        ? ellipsizePath(n.sublabel, p.subRoom, SUB_SIZE)
        : ellipsize(n.sublabel, p.subRoom, SUB_SIZE, true);
    const subHidden = wantSub && (!sub || s.cut);
    return {
      lines,
      labelY: p.labelY,
      lineHeight: lh,
      fontSize,
      sub: s.text,
      subY: p.subY,
      room: Math.min(...p.rooms.slice(0, lines.length)),
      title: labelCut || subHidden ? [n.label, n.sublabel].filter(t => t.length > 0).join('\n') : '',
      badgeCountOnly: false,
    };
  };

  // Two label lines plus the sublabel; then one line plus the sublabel; then
  // the label alone (its sublabel moves into the <title>).
  const tries: Array<[number, boolean]> = wantSub ? [[2, true], [1, true], [2, false], [1, false]] : [[2, false], [1, false]];
  for (const [max, sub] of tries) {
    const one = place(1, sub);
    if (one !== null && textWidth(label, fontSize) <= one.rooms[0]) {
      return finish(one, [label], false, sub);
    }
    if (max === 2) {
      const two = place(2, sub);
      if (two !== null) {
        const wrapped = wrapLabel(label, two.rooms, fontSize);
        if (wrapped.lines.length === 2) {
          return finish(two, wrapped.lines, wrapped.cut, sub);
        }
      }
    } else if (one !== null) {
      const cut = ellipsize(label, one.rooms[0], fontSize, false);
      return finish(one, [cut.text], cut.cut, sub);
    }
  }
  // Too short for any block: one centred line, as legible as the box allows.
  // A centred line here always reaches into the badge row. It lifts to end
  // BADGE_GAP above the badge when it then still clears the outline and is
  // cut no more than centred (so a pill or ellipse, narrower near the top,
  // never cuts it further). Otherwise it stays centred, and the badge drops
  // its symbol and status to show the count alone beside it (G36).
  const b = baselines(false, 1);
  let labelY = b.label;
  let room = rowRoom(shape, w, h, (top + h) / 2 - 1, (top + h) / 2 + 1);
  let countOnly = false;
  if (badgeTop !== null && !dense) {
    const lifted = limit - DESCENT * fontSize;
    const liftedRoom = rowRoom(shape, w, h, lifted - CAP * fontSize, lifted + DESCENT * fontSize);
    if (lifted - CAP * fontSize >= LIFT_PAD_Y && (liftedRoom >= room || textWidth(label, fontSize) <= liftedRoom)) {
      labelY = lifted;
      room = liftedRoom;
    } else {
      countOnly = true;
    }
  }
  const cut = ellipsize(label, room, fontSize, false);
  const laid = finish({ labelY, subY: labelY + SUB_GAP, rooms: [room], subRoom: 0 }, [cut.text], cut.cut, false);
  return { ...laid, badgeCountOnly: countOnly };
}
