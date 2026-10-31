import { describe, it, expect, vi, beforeEach } from 'vitest';

const { codeToTokens, loads } = vi.hoisted(() => ({ codeToTokens: vi.fn(), loads: [] as Array<string | undefined> }));

vi.mock('./highlighter-loader', () => ({
  loadHighlighter: async (lang?: string) => {
    loads.push(lang);
    return { codeToTokens };
  },
}));

import { languageForPath, highlightSnippet, plainSnippet } from './highlight';

type Tok = { content: string; color?: string; fontStyle?: number };

/** Fake tokenizer: splits on word boundaries, colours keywords. */
function fakeTokens(code: string): Tok[][] {
  return code.split('\n').map(line =>
    line.length === 0
      ? [{ content: '' }]
      : (line.match(/\w+|\W+/g) ?? []).map(w => ({
          content: w,
          color: /^(const|export|function)$/.test(w) ? '#ff79c6' : '#f8f8f2',
          fontStyle: w === 'export' ? 1 : 0,
        }))
  );
}

beforeEach(() => {
  codeToTokens.mockReset();
  codeToTokens.mockImplementation((code: string, opts: { lang: string; theme: string }) => ({
    tokens: fakeTokens(code),
    lang: opts.lang,
    theme: opts.theme,
  }));
});

describe('languageForPath', () => {
  it.each([
    ['client/src/a.ts', 'typescript'],
    ['a.mts', 'typescript'],
    ['a.cts', 'typescript'],
    ['a.tsx', 'tsx'],
    ['a.js', 'javascript'],
    ['a.jsx', 'javascript'],
    ['a.mjs', 'javascript'],
    ['a.cjs', 'javascript'],
    ['cmd/main.go', 'go'],
    ['package.json', 'json'],
    ['src/style.css', 'css'],
    ['index.html', 'html'],
    ['README.md', 'markdown'],
    ['ci.yaml', 'yaml'],
    ['ci.yml', 'yaml'],
    ['Cargo.toml', 'toml'],
    ['scripts/run.sh', 'shellscript'],
    ['A.TS', 'typescript'],
    // lazy grammars (G52)
    ['web/src/routes/+layout.svelte', 'svelte'],
    ['client/wrangler.jsonc', 'jsonc'],
  ])('%s → %s', (path, lang) => {
    expect(languageForPath(path)).toBe(lang);
  });

  it('returns null for unknown or missing extensions', () => {
    expect(languageForPath('Makefile')).toBeNull();
    expect(languageForPath('.gitignore')).toBeNull();
    expect(languageForPath('dir.v2/file')).toBeNull();
  });
});

describe('lazy grammars (G52)', () => {
  it('asks the loader for the ref\'s own grammar, so svelte and jsonc load on first expand', async () => {
    loads.length = 0;
    await highlightSnippet('<script>let a = 1;</script>', 'svelte', 'dark', 1, 'a');
    await highlightSnippet('{ "a": 1 } // c', 'jsonc', 'dark', 1, 'a');
    expect(loads).toEqual(['svelte', 'jsonc']);
    expect(codeToTokens).toHaveBeenCalledWith('<script>let a = 1;</script>', { lang: 'svelte', theme: 'redcrayon-dark' });
    expect(codeToTokens).toHaveBeenCalledWith('{ "a": 1 } // c', { lang: 'jsonc', theme: 'redcrayon-dark' });
  });
});

describe('highlightSnippet (plain path)', () => {
  it('underlines the declaration name for a qualified member ref', async () => {
    const block = await highlightSnippet('allow() { return true; }', null, 'dark', 1, 'Limiter.allow');
    expect(block.querySelector('.code-sym')?.textContent).toBe('allow');
  });
  it('renders one row per line with a gutter starting at startLine and underlines the symbol', async () => {
    const block = await highlightSnippet('a\nb c\nc', null, 'dark', 10, 'c');
    expect(block.className).toBe('code-block');
    expect(block.dataset.lang).toBe('plain');
    const rows = [...block.querySelectorAll('.code-line')];
    expect(rows).toHaveLength(3);
    expect(rows.map(r => r.querySelector('.code-gutter')!.textContent)).toEqual(['10', '11', '12']);
    expect(rows.map(r => r.querySelector('.code-text')!.textContent)).toEqual(['a', 'b c', 'c']);
    expect(block.querySelectorAll('.code-sym')).toHaveLength(2);
    // no token colours on the plain path (the row itself carries only --indent)
    expect(block.querySelector('.code-text [style]')).toBeNull();
    expect(codeToTokens).not.toHaveBeenCalled();
  });

  it('numbers the gutter from the ref\'s real startLine, never from 1', async () => {
    // A ref deep in a file: the first row is 448, not 1, and a two-line
    // snippet (no trailing newline, as sliceLines delivers it) is two rows.
    const block = await highlightSnippet('export function renderBoard(\n  world: SVGGElement,', null, 'dark', 448, '');
    const rows = [...block.querySelectorAll('.code-line')];
    expect(rows).toHaveLength(2);
    expect(rows.map(r => r.querySelector('.code-gutter')!.textContent)).toEqual(['448', '449']);
    // A one-line snippet is exactly one row, numbered startLine.
    const one = await highlightSnippet('x', null, 'dark', 7, '');
    expect([...one.querySelectorAll('.code-gutter')].map(g => g.textContent)).toEqual(['7']);
  });

  it('pads the gutter to the widest line number', async () => {
    const block = await highlightSnippet('x\ny', null, 'light', 99, '');
    expect([...block.querySelectorAll('.code-gutter')].map(g => g.textContent)).toEqual([' 99', '100']);
    expect(block.querySelectorAll('.code-sym')).toHaveLength(0);
  });
});

describe('highlightSnippet (shiki path)', () => {
  it('asks the highlighter for the theme matching the chrome and colours tokens', async () => {
    const block = await highlightSnippet('export const a = 1', 'typescript', 'dark', 1, 'a');
    expect(codeToTokens).toHaveBeenCalledWith('export const a = 1', { lang: 'typescript', theme: 'redcrayon-dark' });
    const coloured = [...block.querySelectorAll<HTMLElement>('.code-text [style]')];
    expect(coloured.length).toBeGreaterThan(0);
    expect(coloured[0].style.color).toBe('rgb(255, 121, 198)');
    expect(coloured[0].style.fontStyle).toBe('italic');
    expect(block.querySelector('.code-text')!.textContent).toBe('export const a = 1');
    expect(block.dataset.lang).toBe('typescript');
  });

  it('uses redcrayon-light for the light theme', async () => {
    await highlightSnippet('x', 'go', 'light', 1, '');
    expect(codeToTokens).toHaveBeenCalledWith('x', { lang: 'go', theme: 'redcrayon-light' });
  });

  it('underlines the needle of a Class.member ref in a resolver-shaped method declaration (F11)', async () => {
    // add_code_ref for `Editor.toggleCodeOverlay` captures the method itself,
    // so the snippet starts at the member name, never at `Editor.`.
    const snippet = [
      'toggleCodeOverlay(): void {',
      '  this.codeOverlay = !this.codeOverlay;',
      '  this.deps.rerender();',
      '}',
    ].join('\n');
    const block = await highlightSnippet(snippet, 'typescript', 'dark', 120, 'Editor.toggleCodeOverlay');
    const marks = [...block.querySelectorAll('.code-sym')];
    expect(marks.map(m => m.textContent)).toEqual(['toggleCodeOverlay']);
    expect(block.querySelector('.code-line .code-sym')!.closest('.code-line')).toBe(block.querySelector('.code-line'));
    // `codeOverlay` inside `this.codeOverlay` is not the symbol.
    expect(block.textContent).toContain('this.codeOverlay');
  });

  it('matches the needle on identifier boundaries only (F11)', async () => {
    const block = await highlightSnippet('const width = id + idx + $id + id_2;\nreturn id;', null, 'dark', 1, 'Node.id');
    const marks = [...block.querySelectorAll('.code-sym')].map(m => m.textContent);
    // `id` alone, twice; not inside width, idx, $id or id_2.
    expect(marks).toEqual(['id', 'id']);
  });

  it('underlines an undotted symbol everywhere it occurs as a whole identifier', async () => {
    const block = await highlightSnippet('export function renderBoard(\n  renderBoard2: number,', 'typescript', 'dark', 448, 'renderBoard');
    expect([...block.querySelectorAll('.code-sym')].map(m => m.textContent)).toEqual(['renderBoard']);
  });

  it('falls back to plain rows when the highlighter throws', async () => {
    codeToTokens.mockImplementation(() => {
      throw new Error('grammar failed');
    });
    const block = await highlightSnippet('a\nb', 'typescript', 'dark', 5, 'b');
    expect(block.querySelectorAll('.code-line')).toHaveLength(2);
    expect([...block.querySelectorAll('.code-gutter')].map(g => g.textContent)).toEqual(['5', '6']);
    expect(block.querySelectorAll('.code-sym')).toHaveLength(1);
  });
});

describe('snippet wrapping (G27)', () => {
  const texts = (block: HTMLElement) => [...block.querySelectorAll<HTMLElement>('.code-text')];

  it('--indent equals the leading whitespace width, tabs advance to the next 4-column stop', () => {
    const block = plainSnippet('    if (a) {\n\treturn b;\n  \t x\nnone', 1, '');
    expect(texts(block).map(t => t.style.getPropertyValue('--indent'))).toEqual(['4ch', '4ch', '5ch', '0ch']);
  });

  it('caps --indent at 12ch so a deep line still leaves room to hang', () => {
    const block = plainSnippet(' '.repeat(20) + 'x', 1, '');
    expect(texts(block)[0].style.getPropertyValue('--indent')).toBe('12ch');
  });

  it('--hang is an absolute width, indent + 4ch (padding-left and text-indent resolve % against different boxes)', () => {
    const block = plainSnippet('    a\nb\n' + ' '.repeat(30) + 'c', 1, '');
    expect(texts(block).map(t => t.style.getPropertyValue('--hang'))).toEqual(['8ch', '4ch', '16ch']);
  });

  it('offers line breaks after . ( , and at token edges without changing the copied text', async () => {
    const block = plainSnippet('  const v = deps.git.hashObject(root, rel);', 1, '');
    const t = texts(block)[0];
    expect(t.textContent).toBe('  const v = deps.git.hashObject(root, rel);');
    const before = [...t.childNodes].map(n => (n.nodeName === 'WBR' ? '|' : n.textContent)).join('');
    // none after "root," — the space there is already a break
    expect(before).toBe('  const v = deps.|git.|hashObject(|root, rel);');

    codeToTokens.mockImplementation((code: string) => ({ tokens: fakeTokens(code) }));
    const hl = await highlightSnippet('const value = deps.git(x)', 'typescript', 'dark', 1, '');
    const line = texts(hl)[0];
    expect(line.textContent).toBe('const value = deps.git(x)');
    // across Shiki token edges too: after "deps." and "git("
    expect(line.querySelectorAll('wbr')).toHaveLength(2);
  });

  it('never puts a break opportunity inside an identifier or inside the underlined symbol', () => {
    const block = plainSnippet('formatCheckpointCoverageSummary(x)', 1, 'formatCheckpointCoverageSummary');
    const mark = block.querySelector('.code-sym')!;
    expect(mark.textContent).toBe('formatCheckpointCoverageSummary');
    expect(mark.querySelector('wbr')).toBeNull();
  });
});
