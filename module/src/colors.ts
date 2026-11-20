// Colour rules: pure, no imports. A stored colour is '' (the kind's own look), a hue,
// or '<hue>-<tone>'. An edge is a line, so it takes a hue only.
export const HUES = ['ink', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink', 'gray'] as const;
export const TONES = ['soft', 'bold'] as const;
export const EDGE_COLORS: readonly string[] = HUES;
export const NODE_COLORS: readonly string[] = [...HUES, ...HUES.flatMap(h => TONES.map(t => `${h}-${t}`))];

/** 'blue-bold' → { hue: 'blue', tone: 'bold' }; a plain hue has tone ''. Does not validate. */
export function colorParts(color: string): { hue: string; tone: string } {
  const at = color.lastIndexOf('-');
  return at > 0 && (TONES as readonly string[]).includes(color.slice(at + 1)) ? { hue: color.slice(0, at), tone: color.slice(at + 1) } : { hue: color, tone: '' };
}
