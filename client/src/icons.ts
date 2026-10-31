const SVG_NS = 'http://www.w3.org/2000/svg';

/** A chrome icon in the toolbar's family (12 px unless sized): 16-unit
 *  viewBox, stroke 1.3, round caps and joins, currentColor, hidden from
 *  assistive tech. */
export function strokeIcon(cls: string, d: string, size = '12'): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  for (const [k, v] of Object.entries({
    class: cls,
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.3',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  })) {
    svg.setAttribute(k, v);
  }
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', d);
  svg.append(path);
  return svg;
}

/** Warning triangle for the debt chip: an authored icon, not a glyph (G37). */
export function warnIcon(): SVGSVGElement {
  return strokeIcon('chip-icon', 'M8 2.25 14.25 13.25H1.75Z M8 6.5v3 M8 11.5v.01');
}

/**
 * The toolbar menus' chevron (index.html), as the disclosure cue on ref rows
 * and coverage chips (P5). It points down; style.css turns it right under
 * [aria-expanded='false'].
 */
export function disclosureIcon(): SVGSVGElement {
  return strokeIcon('disc', 'M5 6.5l3 3 3-3');
}

/** The ⌘K palette's mark for the option in effect, e.g. the current theme. */
export function checkIcon(): SVGSVGElement {
  return strokeIcon('palette-check', 'M3.5 8.5l3 3 6-7');
}
