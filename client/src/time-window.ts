/**
 * The board's shared time window (visible_board_window): every viewer's
 * time-axis charts show only this range. Alt-drag across a time chart sets it;
 * the window chip zooms out or clears it.
 */
import type { ChartData } from '../../module/src/chart-contracts';

export interface TimeWindow {
  startMs: number;
  endMs: number;
}

/** The module's cap (WINDOW_MAX_MS in module/src/index.ts). */
export const WINDOW_MAX_MS = 31 * 24 * 3600 * 1000;

/**
 * A chart's data inside the window, or null when none of it falls inside.
 * Only time series on dates are clipped: clock times (HH:MM) have no date to
 * compare, and other chart types have no time axis.
 */
export function clipToWindow(data: ChartData, w: TimeWindow | null | undefined): ChartData | null {
  if (!w || data.type !== 'timeseries' || data.xKind === 'clock') return data;
  const keep: number[] = [];
  data.xs.forEach((x, i) => {
    if (x >= w.startMs && x <= w.endMs) keep.push(i);
  });
  if (keep.length === data.xs.length) return data;
  if (keep.length === 0) return null;
  return { ...data, xs: keep.map(i => data.xs[i]), series: data.series.map(s => ({ ...s, values: keep.map(i => s.values[i]) })) };
}

/** Twice as wide around the same centre, within the module's cap and after the epoch. */
export function zoomOut(w: TimeWindow): TimeWindow {
  const span = Math.min(WINDOW_MAX_MS, (w.endMs - w.startMs) * 2);
  const startMs = Math.max(0, (w.startMs + w.endMs) / 2 - span / 2);
  return { startMs, endMs: startMs + span };
}

/** `Oct 31 14:30–14:45`, or both dates when the window crosses midnight. */
export function formatWindow(w: TimeWindow, timeZone?: string): string {
  const day = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone });
  const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone });
  const a = new Date(w.startMs), b = new Date(w.endMs);
  return day.format(a) === day.format(b)
    ? `${day.format(a)} ${time.format(a)}–${time.format(b)}`
    : `${day.format(a)} ${time.format(a)} – ${day.format(b)} ${time.format(b)}`;
}

const HIT = 'rect.chart-hit[data-t]';

/**
 * Alt-drag across one time chart's plot picks a window: a band follows the
 * pointer over that chart's hit columns, and release calls onPick with the
 * instants under the two ends. Listens on window in the capture phase so the
 * canvas never starts a node drag for it. Returns the unmount.
 */
export function mountWindowBrush(onPick: (w: TimeWindow) => void): () => void {
  let drag: { first: SVGRectElement; last: SVGRectElement; band: SVGRectElement } | null = null;
  const hitUnder = (evt: PointerEvent): SVGRectElement | null => {
    const hit = document.elementFromPoint(evt.clientX, evt.clientY)?.closest<SVGRectElement>(HIT) ?? null;
    return hit && drag && hit.parentNode === drag.first.parentNode ? hit : null;
  };
  const paint = () => {
    if (!drag) return;
    const edges = [drag.first, drag.last].flatMap(r => [Number(r.getAttribute('x')), Number(r.getAttribute('x')) + Number(r.getAttribute('width'))]);
    const x = Math.min(...edges);
    drag.band.setAttribute('x', String(x));
    drag.band.setAttribute('width', String(Math.max(...edges) - x));
  };
  const down = (evt: PointerEvent) => {
    if (!evt.altKey || evt.button !== 0) return;
    const hit = (evt.target as Element | null)?.closest?.<SVGRectElement>(HIT);
    if (!hit) return;
    evt.stopPropagation();
    evt.preventDefault();
    const band = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    band.setAttribute('class', 'chart-brush');
    band.setAttribute('y', hit.getAttribute('y') ?? '0');
    band.setAttribute('height', hit.getAttribute('height') ?? '0');
    band.setAttribute('pointer-events', 'none');
    hit.parentNode!.append(band);
    drag = { first: hit, last: hit, band };
    paint();
  };
  const move = (evt: PointerEvent) => {
    if (!drag) return;
    evt.stopPropagation();
    const hit = hitUnder(evt);
    if (hit && hit !== drag.last) {
      drag.last = hit;
      paint();
    }
  };
  const up = (evt: PointerEvent) => {
    if (!drag) return;
    evt.stopPropagation();
    const { first, last, band } = drag;
    drag = null;
    band.remove();
    const a = Number(first.dataset.t), b = Number(last.dataset.t);
    if (a !== b && Number.isFinite(a) && Number.isFinite(b)) onPick({ startMs: Math.min(a, b), endMs: Math.max(a, b) });
  };
  window.addEventListener('pointerdown', down, true);
  window.addEventListener('pointermove', move, true);
  window.addEventListener('pointerup', up, true);
  return () => {
    window.removeEventListener('pointerdown', down, true);
    window.removeEventListener('pointermove', move, true);
    window.removeEventListener('pointerup', up, true);
  };
}
