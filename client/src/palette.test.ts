import { describe, it, expect } from 'vitest';
import html from '../index.html?raw';
import { fuzzyScore, filterCommands, CommandPalette, offeredOn, type Command } from './palette';

function cmd(id: string, title: string): Command {
  return { id, title, run: () => {} };
}

describe('fuzzyScore', () => {
  it('matches a subsequence and rejects a non-subsequence', () => {
    expect(fuzzyScore('Tidy up', 'tid')).not.toBeNull();
    expect(fuzzyScore('Tidy up', 'tdy')).not.toBeNull();
    expect(fuzzyScore('Tidy up', 'zz')).toBeNull();
    // order matters: the characters must appear in sequence
    expect(fuzzyScore('Tidy up', 'ydit')).toBeNull();
  });

  it('is case insensitive', () => {
    expect(fuzzyScore('Tidy Up', 'TIDY')).toEqual(fuzzyScore('tidy up', 'tidy'));
  });

  it('matches everything at rank 0 for an empty query', () => {
    expect(fuzzyScore('anything', '')).toBe(0);
  });

  it('ranks a prefix better than a late match', () => {
    const prefix = fuzzyScore('Tidy up', 'tid') as number;
    const late = fuzzyScore('Untidy sprawl', 'tid') as number;
    expect(prefix).toBeLessThan(late);
  });

  it('ranks contiguous runs better than scattered hits', () => {
    // 'dist' is contiguous in "Distribute" but scattered across "Duplicate list"
    const contiguous = fuzzyScore('Distribute', 'dist') as number;
    const scattered = fuzzyScore('Duplicate list', 'dist') as number;
    expect(scattered).not.toBeNull();
    expect(contiguous).toBeLessThan(scattered);
  });

  it('rewards word starts', () => {
    const wordStart = fuzzyScore('Wrap in frame', 'wif') as number;
    const midWord = fuzzyScore('Wifi settings', 'wif') as number;
    expect(wordStart).toBeLessThan(midWord + 3);
  });
});

describe('filterCommands', () => {
  const commands = [
    cmd('tidy', 'Tidy up'),
    cmd('dist', 'Distribute horizontally'),
    cmd('flow', 'Connect in order as a flow'),
    cmd('frame', 'Wrap in frame'),
    cmd('overlay', 'Toggle evidence overlay'),
  ];

  it('returns every command, in declaration order, for an empty query', () => {
    expect(filterCommands(commands, '').map(c => c.id)).toEqual([
      'tidy',
      'dist',
      'flow',
      'frame',
      'overlay',
    ]);
  });

  it('puts the obvious match first — the screenshot case', () => {
    expect(filterCommands(commands, 'tid')[0].id).toBe('tidy');
  });

  it('narrows as the query grows', () => {
    const ids = filterCommands(commands, 'fram').map(c => c.id);
    expect(ids).toEqual(['frame']);
  });

  it('drops commands that do not match at all', () => {
    expect(filterCommands(commands, 'zzzz')).toEqual([]);
  });

  it('finds a command by a word in the middle of its title', () => {
    expect(filterCommands(commands, 'evidence')[0].id).toBe('overlay');
  });
});

describe('hints, keywords and undo (G46)', () => {
  const scheme: Command = {
    id: 'editor-scheme',
    title: 'Editor for code links: Cursor',
    hint: 'currently VS Code',
    keywords: ['editor', 'vscode', 'cursor', 'zed'],
    run: () => {},
  };
  const commands: Command[] = [
    { id: 'tidy', title: 'Tidy up', hint: 'align to grid, equal gaps', undoable: true, run: () => {} },
    { id: 'export', title: 'Export SVG', run: () => {} },
    scheme,
    { id: 'fit', title: 'Fit to content', run: () => {} },
  ];

  it('editor matches the scheme command', () => {
    expect(filterCommands(commands, 'editor')[0].id).toBe('editor-scheme');
    expect(filterCommands(commands, 'vscode').map(c => c.id)).toEqual(['editor-scheme']);
    expect(filterCommands(commands, 'zed').map(c => c.id)).toEqual(['editor-scheme']);
  });

  it('a hint or keyword match ranks below a title match', () => {
    // 'grid' is only in the tidy hint; 'gri' hits no title at all
    expect(filterCommands(commands, 'grid').map(c => c.id)).toEqual(['tidy']);
    const withTitle: Command[] = [
      { id: 'kw', title: 'Something else', keywords: ['export'], run: () => {} },
      { id: 'export', title: 'Export SVG', run: () => {} },
    ];
    expect(filterCommands(withTitle, 'export').map(c => c.id)).toEqual(['export', 'kw']);
  });

  it('the ⌘Z footer hint shows only on undoable rows', () => {
    document.body.innerHTML = html;
    const palette = new CommandPalette({ commands: () => commands, context: () => '' });
    palette.open();
    const undo = document.getElementById('palette-undo')!;
    expect(undo.hidden).toBe(false); // tidy is first and undoable
    const input = document.getElementById('palette-input') as HTMLInputElement;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(undo.hidden).toBe(true); // export cannot be undone
    input.value = 'editor';
    input.dispatchEvent(new Event('input'));
    expect(undo.hidden).toBe(true);
    input.value = 'zzzz';
    input.dispatchEvent(new Event('input'));
    expect(undo.hidden).toBe(true);
  });
});

describe('secondary matches are contiguous (G46)', () => {
  it('a scattered subsequence in a hint does not match', () => {
    const overlay: Command = { id: 'code-overlay', title: 'Toggle code overlay', hint: 'ref badges on nodes · snippets in the inspector', run: () => {} };
    expect(filterCommands([overlay], 'editor')).toEqual([]);
    expect(filterCommands([overlay], 'snippets').map(c => c.id)).toEqual(['code-overlay']);
  });
});

describe('groups', () => {
  it('heads the unfiltered list by group, in first-appearance order, and drops heads when filtering', () => {
    document.body.innerHTML = html;
    const commands: Command[] = [
      { id: 'fit', group: 'View', title: 'Fit to content', run: () => {} },
      { id: 'export', group: 'General', title: 'Export SVG', run: () => {} },
      { id: 'zoom', group: 'View', title: 'Reset zoom', run: () => {} },
    ];
    const palette = new CommandPalette({ commands: () => commands, context: () => '' });
    palette.open();
    const list = document.getElementById('palette-list')!;
    const heads = () => [...list.querySelectorAll('.palette-group-head')].map(h => h.textContent);
    const rows = () => [...list.querySelectorAll('.palette-row')].map(r => r.textContent);
    expect(heads()).toEqual(['View', 'General']);
    // Arrow order follows the headers: zoom is pulled up beside fit.
    expect(rows()).toEqual(['Fit to content', 'Reset zoom', 'Export SVG']);
    const input = document.getElementById('palette-input') as HTMLInputElement;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(list.querySelector('.palette-row.on')!.textContent).toBe('Reset zoom');
    input.value = 'e';
    input.dispatchEvent(new Event('input'));
    expect(heads()).toEqual([]);
  });
});

describe('preview scrolling', () => {
  it('scrolls with the current preview when it appears or disappears', () => {
    document.body.innerHTML = html;
    const commands: Command[] = [
      cmd('fit', 'Fit to content'),
      { ...cmd('editor', 'Editor for code links: Cursor'), hint: 'currently VS Code' },
      cmd('export', 'Export SVG'),
    ];
    const preview = document.getElementById('palette-preview')!;
    const previewsAtScroll: Array<string | null> = [];
    // jsdom has no layout: record the preview the browser would use to scroll.
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = () => {
      previewsAtScroll.push(preview.hidden ? null : preview.textContent);
    };
    try {
      const palette = new CommandPalette({ commands: () => commands, context: () => '' });
      palette.open();
      const input = document.getElementById('palette-input')!;
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      expect(previewsAtScroll).toEqual([null, 'currently VS Code', null]);
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });
});

describe('pointer', () => {
  it('highlights on hover without rebuilding rows, and keeps focus in the input', () => {
    document.body.innerHTML = html;
    let ran = '';
    const commands: Command[] = [
      { ...cmd('fit', 'Fit to content'), run: () => { ran = 'fit'; } },
      { ...cmd('export', 'Export SVG'), run: () => { ran = 'export'; } },
    ];
    const palette = new CommandPalette({ commands: () => commands, context: () => '' });
    palette.open();
    const rows = Array.from(document.querySelectorAll('.palette-row'));
    rows[1].dispatchEvent(new Event('pointerenter'));
    // Same nodes: a rebuild under the pointer detaches the press target and the click is lost.
    expect(Array.from(document.querySelectorAll('.palette-row'))).toEqual(rows);
    expect(rows[1].classList.contains('on')).toBe(true);
    expect(rows[0].classList.contains('on')).toBe(false);
    const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    rows[1].dispatchEvent(press);
    expect(press.defaultPrevented).toBe(true);
    document.getElementById('palette-input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(ran).toBe('export');
    expect(palette.isOpen).toBe(false);
  });
});

describe('screen reader', () => {
  it('points the focused input at the active row as it moves', () => {
    document.body.innerHTML = html;
    const commands = [cmd('fit', 'Fit to content'), cmd('export', 'Export SVG')];
    const palette = new CommandPalette({ commands: () => commands, context: () => '' });
    palette.open();
    const input = document.getElementById('palette-input') as HTMLInputElement;
    const active = () => document.getElementById(input.getAttribute('aria-activedescendant') ?? '');
    expect(input.getAttribute('role')).toBe('combobox');
    expect(input.getAttribute('aria-controls')).toBe('palette-list');
    expect(active()?.textContent).toBe('Fit to content');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(active()?.textContent).toBe('Export SVG');
    expect(active()?.getAttribute('aria-selected')).toBe('true');
    document.querySelectorAll('.palette-row')[0].dispatchEvent(new Event('pointerenter'));
    expect(active()?.textContent).toBe('Fit to content');
    input.value = 'zzz';
    input.dispatchEvent(new Event('input'));
    expect(input.hasAttribute('aria-activedescendant')).toBe(false);
    expect(document.activeElement).toBe(input);
  });
});

describe('keys that must not leave or misfire', () => {
  const setup = () => {
    document.body.innerHTML = html;
    let ran = 0;
    const palette = new CommandPalette({ commands: () => [{ ...cmd('fit', 'Fit'), run: () => { ran++; } }], context: () => '' });
    palette.open();
    const input = document.getElementById('palette-input')!;
    const key = (init: KeyboardEventInit) => {
      const evt = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
      input.dispatchEvent(evt);
      return evt;
    };
    return { palette, key, ran: () => ran };
  };

  it('keeps Tab and ⇧Tab in the input', () => {
    const { key } = setup();
    expect(key({ key: 'Tab' }).defaultPrevented).toBe(true);
    expect(key({ key: 'Tab', shiftKey: true }).defaultPrevented).toBe(true);
  });

  it('does not run a command on an IME composition Enter', () => {
    const { palette, key, ran } = setup();
    key({ key: 'Enter', isComposing: true });
    expect(ran()).toBe(0);
    expect(palette.isOpen).toBe(true);
  });

  it('does not close on a held ⌘K', () => {
    const { palette, key } = setup();
    key({ key: 'k', metaKey: true, repeat: true });
    expect(palette.isOpen).toBe(true);
  });
});

describe('current option', () => {
  it('labels the applied theme independently of the highlighted command', () => {
    document.body.innerHTML = html;
    const commands: Command[] = [
      { ...cmd('theme-dark', 'Theme: Dark'), checked: false },
      { ...cmd('theme-light', 'Theme: Light'), checked: true },
    ];
    const palette = new CommandPalette({ commands: () => commands, context: () => '' });
    palette.open();
    const rows = document.querySelectorAll('.palette-row');
    expect(rows[0].getAttribute('aria-selected')).toBe('true');
    expect(rows[0].hasAttribute('aria-label')).toBe(false);
    expect(rows[1].getAttribute('aria-selected')).toBe('false');
    expect(rows[1].getAttribute('aria-label')).toBe('Theme: Light, current');
    const input = document.getElementById('palette-input') as HTMLInputElement;
    input.value = 'light';
    input.dispatchEvent(new Event('input'));
    expect(document.querySelector('.palette-row')!.getAttribute('aria-label')).toBe('Theme: Light, current');
  });
});

describe('offeredOn: the commands a board that refuses edits still offers', () => {
  const c = (id: string, group: string): Command => ({ id, group, title: id, run: () => {} });
  const commands = [c('place-service', 'Place'), c('library-open', 'General'), c('library-add', 'Selection'), c('tidy', 'Arrange'), c('delete', 'Selection')];
  const offered = (factual: boolean, publicExample: boolean) => commands.filter(cmd => offeredOn({ factual, publicExample }, cmd)).map(cmd => cmd.id);

  it('hides every Place command but keeps the personal library, which writes no board row', () => {
    expect(offered(false, false)).toEqual(['place-service', 'library-open', 'library-add', 'tidy', 'delete']);
    // a factual snapshot still permits moves, so arranging stays
    expect(offered(true, false)).toEqual(['library-open', 'library-add', 'tidy']);
    expect(offered(false, true)).toEqual(['library-open', 'library-add']);
  });

  it('keeps branch commands on a factual snapshot: branching a snapshot writes a new board, not the snapshot', () => {
    const branch = [c('branch-new', 'Branch'), c('branch-switch:4', 'Branch'), c('branch-diff', 'Branch')];
    expect(branch.filter(cmd => offeredOn({ factual: true, publicExample: false }, cmd)).map(cmd => cmd.id)).toEqual(['branch-new', 'branch-switch:4', 'branch-diff']);
  });
});
