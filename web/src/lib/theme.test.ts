import { describe, it, expect, beforeEach } from 'vitest';
import html from '../app.html?raw';
import { THEMES, flipped, getTheme, setTheme, toggleTheme } from './theme';

describe('theme', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.dataset.theme = 'light';
  });

  it('setTheme writes the attribute and localStorage', () => {
    setTheme('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem('redcrayon-theme')).toBe('dark');
  });

  it('toggleTheme flips light to dark and returns the new value', () => {
    setTheme('light');
    expect(toggleTheme()).toBe('dark');
    expect(getTheme()).toBe('dark');
  });

  it('resolves to dark unless the page names a dashboard theme', () => {
    delete document.documentElement.dataset.theme;
    expect(getTheme()).toBe('dark');
    document.documentElement.dataset.theme = 'nord';
    expect(getTheme()).toBe('nord');
    // canvas-only: the dashboard has none of its borders or corners
    document.documentElement.dataset.theme = 'brutal';
    expect(getTheme()).toBe('dark');
  });

  it('offers every theme but neo-brutalism', () => {
    expect(THEMES.map((t) => t.id)).not.toContain('brutal');
    expect(THEMES).toHaveLength(12);
  });

  it('flips a theme to its other-scheme twin, else to the house theme of the other scheme', () => {
    expect(flipped('one-dark')).toBe('one-light');
    expect(flipped('one-light')).toBe('one-dark');
    expect(flipped('catppuccin-latte')).toBe('catppuccin-mocha');
    expect(flipped('material-dark')).toBe('material-light');
    expect(flipped('nord')).toBe('light');
    expect(flipped('monokai-pro')).toBe('light');
    for (const t of THEMES) {
      const other = THEMES.find((x) => x.id === flipped(t.id))!;
      expect(other.scheme, t.id).not.toBe(t.scheme);
    }
  });
});

describe('pre-paint theme script (app.html)', () => {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const prepaint = [...doc.querySelectorAll('head script:not([src])')]
    .map((s) => s.textContent ?? '')
    .find((t) => t.includes('redcrayon-theme'));

  function applied(stored: string | null): string | undefined {
    if (stored === null) localStorage.removeItem('redcrayon-theme');
    else localStorage.setItem('redcrayon-theme', stored);
    delete document.documentElement.dataset.theme;
    new Function(prepaint!)();
    return document.documentElement.dataset.theme;
  }

  it.each<[string | null, string]>([...THEMES.map((t): [string, string] => [t.id, t.id]), [null, 'dark'], ['brutal', 'dark'], ['sepia', 'dark']])(
    'saved %s paints as %s',
    (stored, theme) => {
      expect(prepaint, 'pre-paint script missing from <head>').toBeDefined();
      expect(applied(stored)).toBe(theme);
    }
  );
});
