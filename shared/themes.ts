/**
 * Every theme, in picker order: the house themes, then the editor themes by
 * scheme. The canvas draws all of them; the dashboard skips canvasOnly ones.
 * Both pre-paint scripts (client/index.html, web/src/app.html) carry the same
 * id list inline, and a test in each app holds them to this one.
 */
export const THEMES = [
  { id: 'dark', name: 'Dark', scheme: 'dark', group: 'redcrayon' },
  { id: 'light', name: 'Light', scheme: 'light', group: 'redcrayon' },
  // Neo-brutalism is borders and square corners as much as colour.
  { id: 'brutal', name: 'Neo-brutalism', scheme: 'light', group: 'redcrayon', canvasOnly: true },
  { id: 'catppuccin-mocha', name: 'Catppuccin Mocha', scheme: 'dark', group: 'Dark' },
  { id: 'gruvbox-material', name: 'Gruvbox Material', scheme: 'dark', group: 'Dark' },
  { id: 'material-dark', name: 'Material Dark', scheme: 'dark', group: 'Dark' },
  { id: 'monokai-pro', name: 'Monokai Pro', scheme: 'dark', group: 'Dark' },
  { id: 'nord', name: 'Nord', scheme: 'dark', group: 'Dark' },
  { id: 'oceanic-next', name: 'Oceanic Next', scheme: 'dark', group: 'Dark' },
  { id: 'one-dark', name: 'One Dark', scheme: 'dark', group: 'Dark' },
  { id: 'catppuccin-latte', name: 'Catppuccin Latte', scheme: 'light', group: 'Light' },
  { id: 'material-light', name: 'Material Light', scheme: 'light', group: 'Light' },
  { id: 'one-light', name: 'One Light', scheme: 'light', group: 'Light' },
] as const satisfies readonly {
  id: string;
  name: string;
  scheme: 'dark' | 'light';
  group: 'redcrayon' | 'Dark' | 'Light';
  canvasOnly?: true;
}[];

export type ThemeId = (typeof THEMES)[number]['id'];
export type ThemeInfo = (typeof THEMES)[number];

/** The theme with this id, or undefined for a stale or foreign value. */
export function themeById(id: string | undefined): ThemeInfo | undefined {
  return THEMES.find(t => t.id === id);
}

/** True when the theme draws light ink on dark surfaces; unknown ids read as dark, the default. */
export function isDarkTheme(id: string | undefined): boolean {
  return (themeById(id)?.scheme ?? 'dark') === 'dark';
}
