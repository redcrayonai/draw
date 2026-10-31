/**
 * Tool result texts. Spec §3.2: every tool result names the board it acted on,
 * so a write that lands on the wrong board (e.g. SPACETIME_BOARD=Demo before
 * start_session) is visible in the transcript. The connection texts
 * (`REJECTED: not connected (reconnecting)`, `REJECTED: reducer timed out
 * (reconnecting)`) are global constants and stay exact.
 */
import { NOT_CONNECTED, TIMED_OUT } from './errors';
import { iconTextTop } from '../../module/src/node-icons';

export function withBoard(text: string, board: string | undefined): string {
  return board === undefined ? text : `${text} board=${board}`;
}

const isConnectionText = (message: string) => message === NOT_CONNECTED || message === TIMED_OUT;

/** A reducer call that failed: the module's SenderError text, or a connection constant. */
export function reducerRejection(message: string, board: string | undefined): string {
  return isConnectionText(message) ? `REJECTED: ${message}` : withBoard(`REJECTED by server: ${message}`, board);
}

/** A session flow that failed: one actionable sentence, or a connection constant. */
export function flowRejection(message: string, board: string | undefined): string {
  return isConnectionText(message) ? `REJECTED: ${message}` : withBoard(`REJECTED: ${message}`, board);
}

/**
 * A refused start_session (G25). A trailing ` board=Demo` would read as "carry
 * on there", so the board is named as the one left unchanged instead.
 */
export function startSessionRejection(message: string, activeBoard: string | undefined): string {
  if (isConnectionText(message)) return `REJECTED: ${message}`;
  return `REJECTED: ${message.replace(/\.$/, '')}. Active board unchanged: ${activeBoard ?? 'none'}; do not draw until start_session succeeds.`;
}

// ---------- label fit (G23) ----------
//
// What a node's stored box can show. The client draws a node at exactly its
// stored size and lays its text out with client/src/node-layout.ts (G2, G9,
// G36), the source of truth this section ports: the label wraps greedily to
// at most two rows, each as wide as its row's room (rect: w − 2·padX; ellipse
// and pill: narrowed by the curve, then curveInset), and is ellipsized after
// that; the sublabel takes one row; the text block sits within [padY, limit],
// limit = h − padY, or the code-ref badge's top − badgeGap when the node has
// refs. Change both together.
//
// Widths are estimated, not measured: a label character takes its Geist 500
// advance, measured with canvas measureText in Chromium (kerning ignored, so
// a few per cent wide: 153.8 px for markCheckpointFlow at 15 px, which
// measures 150.1); other characters 0.6 em, wide scripts 1 em. The sublabel
// is Geist Mono, 0.6 em per character.

/** Geist 500 advance per printable ASCII character, in em. */
const GEIST_500_EM: Record<string, number> = {
  "0": 0.673, "1": 0.406, "2": 0.63, "3": 0.625, "4": 0.629, "5": 0.641, "6": 0.604, "7": 0.531, "8": 0.624,
  "9": 0.606, " ": 0.243, "!": 0.228, "\"": 0.361, "#": 0.515, "$": 0.643, "%": 0.81, "&": 0.649, "'": 0.186,
  "(": 0.29, ")": 0.29, "*": 0.427, "+": 0.562, ",": 0.213, "-": 0.418, ".": 0.213, "/": 0.494, ":": 0.302,
  ";": 0.302, "<": 0.546, "=": 0.544, ">": 0.546, "?": 0.57, "@": 0.925, "A": 0.689, "B": 0.688, "C": 0.713,
  "D": 0.701, "E": 0.609, "F": 0.595, "G": 0.713, "H": 0.716, "I": 0.28, "J": 0.607, "K": 0.656, "L": 0.583,
  "M": 0.89, "N": 0.745, "O": 0.751, "P": 0.657, "Q": 0.745, "R": 0.68, "S": 0.654, "T": 0.568, "U": 0.694,
  "V": 0.688, "W": 0.968, "X": 0.633, "Y": 0.594, "Z": 0.561, "[": 0.361, "\\": 0.47, "]": 0.361, "^": 0.438,
  "_": 0.558, "`": 0.258, "a": 0.565, "b": 0.608, "c": 0.563, "d": 0.608, "e": 0.576, "f": 0.412, "g": 0.607,
  "h": 0.591, "i": 0.256, "j": 0.284, "k": 0.609, "l": 0.282, "m": 0.885, "n": 0.591, "o": 0.588, "p": 0.608,
  "q": 0.608, "r": 0.394, "s": 0.537, "t": 0.41, "u": 0.586, "v": 0.56, "w": 0.829, "x": 0.607, "y": 0.553,
  "z": 0.552, "{": 0.395, "|": 0.274, "}": 0.395, "~": 0.523,
};

export const LABEL_FIT = {
  /** label font size by node size: s 13, default 15, l 18 */
  labelPx: { s: 13, m: 15, l: 18 },
  /** label line height: round(font size × 1.25) */
  lineHeightEm: 1.25,
  /** Geist cap height and descent */
  capEm: 0.72,
  descentEm: 0.22,
  maxLabelLines: 2,
  /** sublabel: Geist Mono 12 px, 0.6 em per character; its baseline 22 below the last label baseline */
  sublabelPx: 12,
  sublabelAdvanceEm: 0.6,
  subGap: 22,
  subAscent: 9,
  subDescent: 3,
  /** clear space: rect rows at the sides, above and below the block, curved rows */
  padX: 16,
  padY: 6,
  curveInset: 10,
  /**
   * the code-ref badge (11 px mono, ascent 9) is anchored at h − 10, an
   * ellipse's at h − 14 (render.ts badgeAnchor), so its top is badgeTop above
   * the bottom; the text block ends badgeGap above it
   */
  badgeTop: { ellipse: 23, other: 19 },
  badgeGap: 8,
  /** characters outside the table; wide scripts (CJK, Hangul) */
  otherEm: 0.6,
  wideEm: 1,
  /** smallest node width (resize_node minimum) */
  minW: 64,
} as const;

export type LabelFitInput = {
  label: string;
  sublabel: string;
  w: number;
  h: number;
  size?: string;
  /** rect (default), ellipse or pill */
  shape?: string;
  kind?: string;
  /** the node has code refs, so its badge row is reserved */
  hasRefs?: boolean;
  /** the node shows a library icon: its label band starts below it (node-icons.ts iconTextTop) */
  icon?: boolean;
};

export type LabelFit = {
  /** rows the label needs at the stored width (wrapped at its widest row); more than 2 are cut */
  lines: number;
  /** the stored box ellipsizes the label */
  labelCut: boolean;
  /** the narrowest w (a multiple of 4) at which the label shows in full at the stored h */
  labelW: number;
  /** the sublabel has a row but is ellipsized */
  sublabelCut: boolean;
  /** the narrowest w at which the sublabel shows in full at the stored h; 0 when it has none or h has no row for it */
  sublabelW: number;
  /** the h that holds the label in min(lines, 2) rows plus the sublabel */
  needH: number;
};

const F = LABEL_FIT;
const up4 = (n: number) => Math.ceil(n / 4) * 4;
const fontPx = (size?: string) => (size === 's' ? F.labelPx.s : size === 'l' ? F.labelPx.l : F.labelPx.m);
const charEm = (c: string) => GEIST_500_EM[c] ?? ((c.codePointAt(0) ?? 0) >= 0x1100 ? F.wideEm : F.otherEm);
/** A label's estimated width in px at font size fs (Geist 500 advances, no kerning). */
export const labelTextWidth = (text: string, fs: number) => labelWidth(text, fs);
const labelWidth = (text: string, fs: number) => {
  let em = 0;
  for (const c of text) em += charEm(c);
  return em * fs;
};
const badgeTopOf = (shape: string) => (shape === 'ellipse' ? F.badgeTop.ellipse : F.badgeTop.other);
const sublabelWidth = (text: string) => [...text].length * F.sublabelPx * F.sublabelAdvanceEm;

/** node-layout.ts rowRoom: width available to a text row spanning [top, bottom]. */
function rowRoom(shape: string, w: number, h: number, top: number, bottom: number): number {
  if (shape !== 'ellipse' && shape !== 'pill') return Math.max(0, w - 2 * F.padX);
  const ry = h / 2;
  const rx = shape === 'ellipse' ? w / 2 : Math.min(h / 2, w / 2);
  const far = Math.max(Math.abs(top - ry), Math.abs(bottom - ry));
  const t = Math.min(1, far / ry);
  const half = w / 2 - rx + rx * Math.sqrt(1 - t * t);
  return Math.max(0, 2 * (half - F.curveInset));
}

type Placement = { rooms: number[]; subRoom: number };
type Box = { label: string; sublabel: string; shape: string; fs: number; lh: number; hasRefs: boolean };

/** node-layout.ts place: the block of `lines` label rows (+ sublabel), centred and nudged inside [padY, limit]. */
function place(b: Box, w: number, h: number, lines: number, sub: boolean): Placement | null {
  const { fs, lh } = b;
  const limit = b.hasRefs ? h - badgeTopOf(b.shape) - F.badgeGap : h - F.padY;
  const spread = ((lines - 1) * lh) / 2;
  const label = (sub ? h / 2 - 9 : h / 2 + 0.35 * fs) - spread;
  const subY = label + (lines - 1) * lh + F.subGap;
  const top = label - F.capEm * fs;
  const bottom = sub ? subY + F.subDescent : label + (lines - 1) * lh + F.descentEm * fs;
  let shift = top < F.padY ? F.padY - top : 0;
  if (bottom + shift > limit) shift = limit - bottom;
  if (top + shift < F.padY - 1e-9) return null;
  const y = label + shift;
  const rooms = Array.from({ length: lines }, (_, i) => rowRoom(b.shape, w, h, y + i * lh - F.capEm * fs, y + i * lh + F.descentEm * fs));
  return { rooms, subRoom: rowRoom(b.shape, w, h, subY + shift - F.subAscent, subY + shift + F.subDescent) };
}

/** node-layout.ts wrapLabel, as line count and cut: greedy rows; a word wider than its row breaks; the last row takes the rest. */
function wrapLabel(label: string, rooms: number[], fs: number): { lines: number; cut: boolean } {
  const words = label.split(/\s+/).filter(x => x.length > 0).map(x => [...x]);
  const space = charEm(' ') * fs;
  const width = (chars: string[]) => labelWidth(chars.join(''), fs);
  let lines = 0;
  let i = 0;
  for (let row = 0; row < rooms.length && i < words.length; row++) {
    const room = rooms[row];
    if (row === rooms.length - 1) {
      let rest = 0;
      for (let k = i; k < words.length; k++) rest += width(words[k]) + (k > i ? space : 0);
      return { lines: lines + 1, cut: rest > room };
    }
    let line = width(words[i]);
    if (line > room) {
      let k = 1; // breakWord: the longest prefix that fits, at least one character
      let prefix = charEm(words[i][0]) * fs;
      while (k < words[i].length && prefix + charEm(words[i][k]) * fs <= room) prefix += charEm(words[i][k++]) * fs;
      words[i] = words[i].slice(k);
      lines += 1;
      continue;
    }
    i += 1;
    while (i < words.length && line + space + width(words[i]) <= room) line += space + width(words[i++]);
    lines += 1;
  }
  return { lines: Math.max(lines, 1), cut: false };
}

/** node-layout.ts layoutNodeText, reduced to what is cut. */
function layout(b: Box, w: number, h: number): { labelCut: boolean; sub: 'none' | 'hidden' | 'cut' | 'shown' } {
  const wantSub = b.sublabel.length > 0;
  const full = labelWidth(b.label, b.fs);
  const finish = (p: Placement | null, labelCut: boolean, sub: boolean) => ({
    labelCut,
    sub: !wantSub ? ('none' as const) : !sub || p === null ? ('hidden' as const) : sublabelWidth(b.sublabel) > p.subRoom ? ('cut' as const) : ('shown' as const),
  });
  const tries: Array<[number, boolean]> = wantSub ? [[2, true], [1, true], [2, false], [1, false]] : [[2, false], [1, false]];
  for (const [max, sub] of tries) {
    const one = place(b, w, h, 1, sub);
    if (one !== null && full <= one.rooms[0]) return finish(one, false, sub);
    if (max === 2) {
      const two = place(b, w, h, 2, sub);
      if (two !== null) {
        const wrapped = wrapLabel(b.label, two.rooms, b.fs);
        if (wrapped.lines === 2) return finish(two, wrapped.cut, sub);
      }
    } else if (one !== null) {
      return finish(one, full > one.rooms[0], sub);
    }
  }
  // too short for any block: one centred line
  return finish(null, full > rowRoom(b.shape, w, h, h / 2 - 1, h / 2 + 1), false);
}

/** The narrowest multiple of 4, from minW, for which ok(w) holds (ok never turns false as w grows). */
function narrowest(ok: (w: number) => boolean, from: number): number {
  let hi = Math.max(F.minW, up4(from));
  while (!ok(hi)) hi += hi;
  let lo = F.minW;
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 8) * 4;
    if (ok(mid)) hi = mid;
    else lo = mid + 4;
  }
  return lo;
}

/** The deterministic estimate of what a node's stored box can show (G23). An
 *  icon node's text lays out in the band below its icon: estimated as a box
 *  that much shorter (its top padding is the icon's gap), then needH grows back. */
export function labelFit(n: LabelFitInput): LabelFit {
  if (n.icon) {
    const band = iconTextTop(n.size ?? 'm') - F.padY;
    const fit = textFit({ ...n, h: n.h - band });
    return { ...fit, needH: fit.needH + band };
  }
  return textFit(n);
}

function textFit(n: LabelFitInput): LabelFit {
  const fs = fontPx(n.size);
  // Whitespace collapsed and trimmed, as the client lays it out: the one-line
  // check then measures what the wrap would draw (node-layout.ts does the same).
  const label = n.label.trim().replace(/\s+/g, ' ');
  const b: Box = { label, sublabel: n.sublabel, shape: n.shape || 'rect', fs, lh: Math.round(fs * F.lineHeightEm), hasRefs: n.hasRefs ?? false };
  const here = layout(b, n.w, n.h);
  // rows at the widest (centre) row's room, unbounded
  const lines = label.length === 0 ? 0 : wrapLabel(label, Array(label.length + 1).fill(rowRoom(b.shape, n.w, n.h, n.h / 2 - 1, n.h / 2 + 1)), fs).lines;
  const full = labelWidth(label, fs) + 2 * F.padX;
  const labelW = narrowest(w => !layout(b, w, n.h).labelCut, full);
  const placed = here.sub === 'cut' || here.sub === 'shown';
  const sublabelW = placed ? narrowest(w => layout(b, w, n.h).sub === 'shown', sublabelWidth(n.sublabel) + 2 * F.padX) : 0;
  const rows = Math.max(1, Math.min(lines, F.maxLabelLines));
  const block = n.sublabel.length > 0
    ? F.capEm * fs + (rows - 1) * b.lh + F.subGap + F.subDescent
    : (F.capEm + F.descentEm) * fs + (rows - 1) * b.lh;
  const needH = up4(F.padY + block + (b.hasRefs ? badgeTopOf(b.shape) + F.badgeGap : F.padY));
  return { lines, labelCut: here.labelCut, labelW, sublabelCut: here.sub === 'cut', sublabelW, needH };
}

/**
 * The note create_node, update_node and resize_node append when the stored
 * box cuts the label, the sublabel or their height off; '' when all fits.
 * Notes, free text, boundaries and charts have their own layout and get none.
 */
export function labelFitHint(n: LabelFitInput): string {
  if (n.kind === 'note' || n.kind === 'text' || n.kind === 'boundary' || n.kind === 'chart') return '';
  const fit = labelFit(n);
  let hint = '';
  if (fit.labelCut) {
    hint += ` (label wraps to ${fit.lines} lines; cut off below w=${fit.labelW} — widen to ${fit.labelW} to show it in full)`;
  }
  if (fit.sublabelCut) hint += ` (sublabel cut off below w=${fit.sublabelW})`;
  if (fit.needH > n.h) hint += n.sublabel.length > 0 ? ` (needs h=${fit.needH} to show label and sublabel)` : ` (needs h=${fit.needH} to show the label)`;
  return hint;
}
