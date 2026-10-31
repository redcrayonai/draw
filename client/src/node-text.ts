/** Cached measurements keep fitting node text out of the per-frame hot path. */
let context: CanvasRenderingContext2D | null | undefined;
/** One map per font; Map order is insertion order, so the first key is the
 *  oldest and eviction drops it rather than wiping the whole cache (G48). */
const widths = new Map<string, Map<string, number>>();
const MIN_ENTRIES = 1000;
let maxEntries = MIN_ENTRIES;
/** Bumped when web fonts finish loading: earlier measurements are stale. */
let epoch = 0;

/** Room for every label and sublabel on a board of `nodeCount` nodes, per font. */
export function sizeTextCache(nodeCount: number): void {
  maxEntries = Math.max(MIN_ENTRIES, nodeCount * 2);
}

/** Font generation; a measurement cached under an older epoch is stale. */
export function textEpoch(): number {
  return epoch;
}

export function textWidth(text: string, size: number, mono = false): number {
  return fontWidth(text, mono
    ? `400 ${size}px 'Geist Mono', monospace`
    : `500 ${size}px 'Geist', system-ui, sans-serif`);
}

/** Width of `text` in a CSS font shorthand such as `500 14px Geist`. */
export function fontWidth(text: string, font: string): number {
  let byText = widths.get(font);
  if (byText === undefined) {
    byText = new Map();
    widths.set(font, byText);
  }
  const cached = byText.get(text);
  if (cached !== undefined) return cached;
  if (context === undefined) {
    context = typeof CanvasRenderingContext2D === 'undefined'
      ? null : document.createElement('canvas').getContext('2d');
  }
  if (context !== null) context.font = font;
  const width = context?.measureText(text).width ?? [...text].length * Number(/([\d.]+)px/.exec(font)?.[1] ?? 14) * 0.65;
  while (byText.size >= maxEntries) {
    byText.delete(byText.keys().next().value as string);
  }
  byText.set(text, width);
  return width;
}

// Measurements taken before a web font loads must not stay cached forever.
if (typeof document !== 'undefined' && document.fonts) {
  document.fonts.addEventListener('loadingdone', () => {
    widths.clear();
    epoch++;
    window.dispatchEvent(new Event('redcrayon:fonts'));
  });
}
