import { writable } from 'svelte/store';
import { THEMES as ALL, themeById, type ThemeId } from '$shared/themes';

/** Neo-brutalism is canvas-only: its borders and corners are canvas CSS. */
export type Theme = Exclude<ThemeId, 'brutal'>;
export const THEMES = ALL.filter((t): t is Extract<(typeof ALL)[number], { id: Theme }> => !('canvasOnly' in t));
const KEY = 'redcrayon-theme';

/** Dark unless the page names another dashboard theme (app.html's pre-paint rule). */
export function getTheme(): Theme {
  const id = document.documentElement.dataset.theme;
  return THEMES.find(t => t.id === id)?.id ?? 'dark';
}

export const theme = writable<Theme>(getTheme());

export function setTheme(t: Theme): void {
  document.documentElement.dataset.theme = t;
  // Best-effort: localStorage can throw in privacy-restricted contexts.
  try {
    localStorage.setItem(KEY, t);
  } catch (e) {
    /* persistence is optional — ignore */
  }
  theme.set(t);
}

/** Each theme's other-scheme twin; a theme without one flips to the house theme of the other scheme. */
const PAIRS: [Theme, Theme][] = [
  ['dark', 'light'],
  ['one-dark', 'one-light'],
  ['material-dark', 'material-light'],
  ['catppuccin-mocha', 'catppuccin-latte'],
];

/** The theme the top-bar button switches to: same family, other scheme. */
export function flipped(t: Theme): Theme {
  const pair = PAIRS.find(p => p.includes(t));
  if (pair) return pair[0] === t ? pair[1] : pair[0];
  return themeById(t)?.scheme === 'dark' ? 'light' : 'dark';
}

export function toggleTheme(): Theme {
  const next = flipped(getTheme());
  setTheme(next);
  return next;
}
