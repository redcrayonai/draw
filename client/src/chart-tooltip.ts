/**
 * One screen-space readout serves every chart (spec: Zoom and hover). It
 * shows the mark under the pointer: data-tip-head and data-tip-rows when the
 * mark has them (a muted header, then a series swatch, name and bold value
 * per row, built with textContent only), else the plain data-tip text. Over a
 * timeseries hit column (rect.chart-hit[data-x]) it also draws a crosshair
 * inside that chart's plot, with a ringed dot where each series crosses it;
 * both live in one g.chart-xhair, which Export SVG strips. It only reads the
 * DOM: it never selects, never blocks a drag, and hides whenever a gesture
 * starts. No value lives only here: the inspector grid shows every value.
 */
import { svgEl } from './charts/svg';

/** One readout row as the renderers write it into data-tip-rows. */
interface TipRow {
  slot?: number;
  name: string;
  value: string;
  /** Plot-local y where this series crosses the crosshair. */
  y?: number;
}

const isSlot = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 5;

/** The rows of a mark, or null when it has none (or they do not parse). */
function tipRows(mark: Element): TipRow[] | null {
  const raw = mark.getAttribute('data-tip-rows');
  if (raw === null) {
    return null;
  }
  try {
    const rows: unknown = JSON.parse(raw);
    return Array.isArray(rows)
      ? rows.filter((r): r is TipRow => typeof r?.name === 'string' && typeof r?.value === 'string')
      : null;
  } catch {
    return null;
  }
}

function el(tag: string, cls: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) {
    e.textContent = text;
  }
  return e;
}
/** Gap between the pointer and the readout. */
const OFFSET = 12;
/** Least room kept between the readout and the canvas edge. */
const EDGE = 8;

export function bindChartTooltip(svg: SVGSVGElement, host: HTMLElement, enabled: () => boolean): () => void {
  const tip = document.createElement('div');
  tip.id = 'chart-tip';
  tip.setAttribute('role', 'tooltip');
  tip.hidden = true;
  host.append(tip);
  let xhair: SVGGElement | null = null;
  let xhairFor: Element | null = null;
  /** What the readout shows now, so a move over the same mark writes nothing. */
  let shown = '';

  const dropXhair = () => {
    xhair?.remove();
    xhair = null;
    xhairFor = null;
  };
  const hide = () => {
    if (!tip.hidden) {
      tip.hidden = true;
    }
    dropXhair();
  };
  /** The crosshair spans the hit column, in the plot group's coordinates; a dot per row with a y. */
  const showXhair = (hit: SVGElement, rows: TipRow[] | null) => {
    const plot = hit.closest('g.chart-plot');
    if (plot === null) {
      dropXhair();
      return;
    }
    if (xhairFor === hit && xhair?.parentNode === plot) {
      return;
    }
    dropXhair();
    const x = hit.dataset.x!;
    const y = Number(hit.getAttribute('y') ?? '0');
    const h = Number(hit.getAttribute('height') ?? '0');
    xhair = svgEl('g', { class: 'chart-xhair' });
    xhair.append(svgEl('line', { x1: x, x2: x, y1: String(y), y2: String(y + h) }));
    for (const r of rows ?? []) {
      if (isSlot(r.slot) && typeof r.y === 'number' && Number.isFinite(r.y)) {
        xhair.append(svgEl('circle', { cx: x, cy: String(r.y), r: '4', 'stroke-width': '2', class: `chart-dot chart-ring series-${r.slot}` }));
      }
    }
    plot.append(xhair);
    xhairFor = hit;
  };

  /** Rows as DOM nodes: data never reaches innerHTML. */
  const fill = (mark: Element, text: string, rows: TipRow[] | null) => {
    if (rows === null) {
      tip.textContent = text;
      return;
    }
    const head = mark.getAttribute('data-tip-head');
    tip.replaceChildren(
      ...(head ? [el('div', 'chart-tip-head', head)] : []),
      ...rows.map(r => {
        const row = el('div', 'chart-tip-row');
        row.append(
          el('i', `chart-tip-swatch ${isSlot(r.slot) ? `series-${r.slot}` : 'chart-tip-none'}`),
          el('span', 'chart-tip-name', r.name),
          el('b', 'chart-tip-value', r.value),
        );
        return row;
      }),
    );
  };

  const show = (target: EventTarget | null, clientX: number, clientY: number) => {
    if (!enabled()) {
      hide();
      return;
    }
    const mark = target instanceof Element ? target.closest<SVGElement>('[data-tip]') : null;
    const text = mark?.dataset.tip ?? '';
    if (mark === null || text === '') {
      hide();
      return;
    }
    const rows = tipRows(mark);
    if (mark.matches('rect.chart-hit[data-x]')) {
      showXhair(mark, rows);
    } else {
      dropXhair();
    }
    const key = `${mark.getAttribute('data-tip-head') ?? ''}\u0000${mark.getAttribute('data-tip-rows') ?? ''}\u0000${text}`;
    if (key !== shown) {
      fill(mark, text, rows);
      shown = key;
    }
    tip.hidden = false;
    // Beside the pointer, flipped to the other side near the canvas edge.
    const box = host.getBoundingClientRect();
    const px = clientX - box.left;
    const py = clientY - box.top;
    const left = px + OFFSET + tip.offsetWidth > host.clientWidth - EDGE ? px - OFFSET - tip.offsetWidth : px + OFFSET;
    const top = py + OFFSET + tip.offsetHeight > host.clientHeight - EDGE ? py - OFFSET - tip.offsetHeight : py + OFFSET;
    tip.style.left = `${Math.max(EDGE, left)}px`;
    tip.style.top = `${Math.max(EDGE, top)}px`;
  };

  // Touch has no hover: a tap shows the readout of the mark it landed on.
  // The press's target, not the lift's: a pan captures the lift on the svg.
  let tap: { target: EventTarget | null; x: number; y: number } | null = null;
  const move = (evt: PointerEvent) => {
    // A finger that travelled pans, even if it comes back: no tap.
    if (tap !== null && Math.hypot(evt.clientX - tap.x, evt.clientY - tap.y) >= 10) {
      tap = null;
    }
    // A pressed button is a drag, a pan or a marquee: hover never competes.
    if (evt.buttons !== 0) {
      hide();
      return;
    }
    show(evt.target, evt.clientX, evt.clientY);
  };
  const down = (evt: PointerEvent) => {
    hide();
    tap = evt.pointerType === 'touch' ? { target: evt.target, x: evt.clientX, y: evt.clientY } : null;
  };
  const up = (evt: PointerEvent) => {
    if (tap !== null && Math.hypot(evt.clientX - tap.x, evt.clientY - tap.y) < 10) {
      show(tap.target, evt.clientX, evt.clientY);
    }
    tap = null;
  };

  // A lifted finger leaves too, right after the tap that showed the readout.
  const leave = (evt: PointerEvent) => {
    if (evt.pointerType !== 'touch') hide();
  };

  svg.addEventListener('pointermove', move);
  svg.addEventListener('pointerleave', leave);
  svg.addEventListener('pointerdown', down);
  svg.addEventListener('pointerup', up);
  // Wheel pans and zooms the canvas; keys zoom, pan and switch tools.
  svg.addEventListener('wheel', hide, { passive: true });
  window.addEventListener('keydown', hide);
  return () => {
    svg.removeEventListener('pointermove', move);
    svg.removeEventListener('pointerleave', leave);
    svg.removeEventListener('pointerdown', down);
    svg.removeEventListener('pointerup', up);
    svg.removeEventListener('wheel', hide);
    window.removeEventListener('keydown', hide);
    hide();
    tip.remove();
  };
}
