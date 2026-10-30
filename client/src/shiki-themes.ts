import type { ThemeRegistration } from 'shiki/core';
import type { ThemeId } from '../../shared/themes';

/**
 * One small Shiki theme per app theme, so code, chrome and canvas read as one
 * system. The house themes are built from the palette tokens in style.css:
 * plain code is --ink, punctuation and operators --muted, comments --faint
 * (italic); two non-accent hues mark keywords and literals. --accent never
 * appears: it is reserved for focal nodes (style.css header). The editor
 * themes (themes.css) carry their own syntax roles instead, read from the
 * reference theme and lifted to AA on --inset where the source falls short;
 * those keep their own colours even near their accent, because a One Dark
 * reader expects One Dark's orange numbers. Keep the hex values in step with
 * the CSS; the shiki-themes test reads it and fails when they drift.
 */
interface Palette {
  /** --inset: the .insp-code slot background. */
  bg: string;
  ink: string;
  /** Punctuation; operators too unless `operator` is set. */
  muted: string;
  /** Comments. */
  faint: string;
  /** Keywords, `this`, HTML tags; storage too unless `storage` is set. */
  keyword: string;
  /** Strings; numbers and constants too unless `number` is set. */
  literal: string;
  /** The optional roles fall back as noted, or to ink, so the house themes draw as before. */
  storage?: string;
  number?: string;
  fn?: string;
  type?: string;
  operator?: string;
  property?: string;
  /** Variables and parameters: One Dark draws them red. */
  variable?: string;
}

export type AppTheme = ThemeRegistration & { fg: string; bg: string; palette: string[] };

function build(name: string, type: 'dark' | 'light', p: Palette): AppTheme {
  const r = {
    storage: p.storage ?? p.keyword,
    number: p.number ?? p.literal,
    fn: p.fn ?? p.ink,
    type: p.type ?? p.ink,
    operator: p.operator ?? p.muted,
    property: p.property ?? p.ink,
    variable: p.variable ?? p.ink,
  };
  return {
    name,
    type,
    fg: p.ink,
    bg: p.bg,
    palette: [...new Set([p.ink, p.muted, p.faint, p.keyword, p.literal, ...Object.values(r)])],
    colors: { 'editor.background': p.bg, 'editor.foreground': p.ink },
    tokenColors: [
      { settings: { foreground: p.ink, background: p.bg } },
      {
        scope: ['comment', 'punctuation.definition.comment', 'string.comment'],
        settings: { foreground: p.faint, fontStyle: 'italic' },
      },
      {
        scope: ['punctuation', 'meta.brace', 'meta.delimiter', 'punctuation.definition.template-expression'],
        settings: { foreground: p.muted },
      },
      {
        scope: ['keyword.operator', 'storage.type.function.arrow'],
        settings: { foreground: r.operator },
      },
      {
        scope: ['keyword', 'keyword.operator.new', 'keyword.operator.expression', 'variable.language', 'entity.name.tag'],
        settings: { foreground: p.keyword },
      },
      {
        scope: ['storage', 'storage.type', 'storage.modifier'],
        settings: { foreground: r.storage },
      },
      {
        scope: ['string', 'string.template', 'string.regexp', 'punctuation.definition.string'],
        settings: { foreground: p.literal },
      },
      {
        scope: ['constant.numeric', 'constant.language', 'constant.character', 'support.constant'],
        settings: { foreground: r.number },
      },
      {
        scope: ['entity.name.function', 'support.function', 'meta.function-call entity.name.function'],
        settings: { foreground: r.fn },
      },
      {
        scope: ['entity.name.type', 'entity.name.class', 'entity.other.inherited-class', 'support.type', 'support.class'],
        settings: { foreground: r.type },
      },
      {
        scope: ['variable', 'variable.parameter'],
        settings: { foreground: r.variable },
      },
      {
        scope: [
          'variable.other.property',
          'variable.other.object.property',
          'support.type.property-name',
          'meta.object-literal.key',
          'entity.other.attribute-name',
        ],
        settings: { foreground: r.property },
      },
    ],
  };
}

export const REDCRAYON_DARK = build('redcrayon-dark', 'dark', {
  bg: '#141417',
  ink: '#ECECEE',
  muted: '#9A9AA4',
  faint: '#85858F',
  keyword: '#8AB4F8',
  literal: '#8CCB9B',
});

export const REDCRAYON_LIGHT = build('redcrayon-light', 'light', {
  bg: '#F7F7F5',
  ink: '#131313',
  muted: '#5B6472',
  faint: '#6A6A74',
  keyword: '#1F4FBF',
  literal: '#1A7F37',
});

export const CATPPUCCIN_MOCHA = build('redcrayon-catppuccin-mocha', 'dark', {
  bg: '#1E1E2E',
  ink: '#CDD6F4',
  muted: '#9399B2',
  faint: '#9399B2',
  keyword: '#CBA6F7',
  literal: '#A6E3A1',
  storage: '#CBA6F7',
  number: '#FAB387',
  fn: '#89B4FA',
  type: '#F9E2AF',
  operator: '#94E2D5',
  property: '#89B4FA',
});

export const CATPPUCCIN_LATTE = build('redcrayon-catppuccin-latte', 'light', {
  bg: '#E6E9EF',
  ink: '#4C4F69',
  muted: '#65687C',
  faint: '#65687C',
  keyword: '#8738EE',
  literal: '#227908',
  storage: '#8738EE',
  number: '#B54505',
  fn: '#155DEC',
  type: '#965C01',
  operator: '#0C747A',
  property: '#155DEC',
});

export const ONE_DARK = build('redcrayon-one-dark', 'dark', {
  bg: '#282C34',
  ink: '#ABB2BF',
  muted: '#ABB2BF',
  faint: '#8E939D',
  keyword: '#C678DD',
  literal: '#98C379',
  storage: '#C678DD',
  number: '#D19A66',
  fn: '#61AFEF',
  type: '#E5C07B',
  operator: '#56B6C2',
  property: '#E36E77',
  variable: '#E36E77',
});

export const ONE_LIGHT = build('redcrayon-one-light', 'light', {
  bg: '#FAFAFA',
  ink: '#383A42',
  muted: '#383A42',
  faint: '#727379',
  keyword: '#A626A4',
  literal: '#318332',
  storage: '#A626A4',
  number: '#986801',
  fn: '#356CE5',
  type: '#9A6A11',
  operator: '#027BB0',
  property: '#CE4136',
});

export const OCEANIC_NEXT = build('redcrayon-oceanic-next', 'dark', {
  bg: '#1B2B34',
  ink: '#CDD3DE',
  muted: '#5FB3B3',
  faint: '#83919D',
  keyword: '#C594C5',
  literal: '#99C794',
  storage: '#C594C5',
  number: '#F99157',
  fn: '#6699CC',
  type: '#FAC863',
  operator: '#5FB3B3',
  property: '#CDD3DE',
});

export const GRUVBOX_MATERIAL = build('redcrayon-gruvbox-material', 'dark', {
  bg: '#282828',
  ink: '#D4BE98',
  muted: '#D4BE98',
  faint: '#9B8C7D',
  keyword: '#EA6962',
  literal: '#89B482',
  storage: '#EA6962',
  number: '#D3869B',
  fn: '#A9B665',
  type: '#D8A657',
  operator: '#E78A4E',
  property: '#7DAEA3',
});

export const NORD = build('redcrayon-nord', 'dark', {
  bg: '#2E3440',
  ink: '#D8DEE9',
  muted: '#ECEFF4',
  faint: '#8E9CB8',
  keyword: '#81A1C1',
  literal: '#A3BE8C',
  storage: '#81A1C1',
  number: '#B690AF',
  fn: '#88C0D0',
  type: '#8FBCBB',
  operator: '#81A1C1',
  property: '#8FBCBB',
});

export const MATERIAL_DARK = build('redcrayon-material-dark', 'dark', {
  bg: '#263238',
  ink: '#EEFFFF',
  muted: '#89DDFF',
  faint: '#819CA9',
  keyword: '#89DDFF',
  literal: '#C3E88D',
  storage: '#C792EA',
  number: '#F78C6C',
  fn: '#82AAFF',
  type: '#FFCB6B',
  operator: '#89DDFF',
  property: '#C792EA',
});

export const MATERIAL_LIGHT = build('redcrayon-material-light', 'light', {
  bg: '#FAFAFA',
  ink: '#37474F',
  muted: '#098087',
  faint: '#637680',
  keyword: '#098087',
  literal: '#5B7E19',
  storage: '#9C3EDA',
  number: '#CC461D',
  fn: '#5474A9',
  type: '#A36600',
  operator: '#098087',
  property: '#9C3EDA',
});

export const MONOKAI_PRO = build('redcrayon-monokai-pro', 'dark', {
  bg: '#2D2A2E',
  ink: '#FCFCFA',
  muted: '#939293',
  faint: '#939193',
  keyword: '#FF6188',
  literal: '#FFD866',
  storage: '#FF6188',
  number: '#AB9DF2',
  fn: '#A9DC76',
  type: '#78DCE8',
  operator: '#FF6188',
  property: '#FCFCFA',
});

/** Every code palette, keyed by the app theme that uses it (codeTheme maps neo-brutalism to light). */
export const CODE_THEMES: Record<Exclude<ThemeId, 'brutal'>, AppTheme> = {
  dark: REDCRAYON_DARK,
  light: REDCRAYON_LIGHT,
  'catppuccin-mocha': CATPPUCCIN_MOCHA,
  'catppuccin-latte': CATPPUCCIN_LATTE,
  'one-dark': ONE_DARK,
  'one-light': ONE_LIGHT,
  'oceanic-next': OCEANIC_NEXT,
  'gruvbox-material': GRUVBOX_MATERIAL,
  nord: NORD,
  'material-dark': MATERIAL_DARK,
  'material-light': MATERIAL_LIGHT,
  'monokai-pro': MONOKAI_PRO,
};

/** Shiki theme name for an app theme's code palette. */
export function shikiTheme(theme: Exclude<ThemeId, 'brutal'>): string {
  return CODE_THEMES[theme].name!;
}
