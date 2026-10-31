/**
 * ⌘K command palette.
 *
 * The matcher is a pure function so ranking is unit-testable. The palette owns
 * its own keyboard handling and deliberately does NOT touch interactions.ts:
 * its input stops propagation on every keydown, exactly like the inline-edit
 * field, so the board's global shortcuts stay inert while you are typing.
 */

import { checkIcon } from './icons';

export interface Command {
  id: string;
  title: string;
  /** Section header for the unfiltered list; contiguous by first appearance. */
  group?: string;
  /** What the command will actually do: shown under the list, not in the row. */
  hint?: string;
  /** The option currently in effect (a theme, say): drawn as a check. */
  checked?: boolean;
  /** Shortcut chip, display only — the binding itself lives elsewhere. */
  keys?: string;
  /** Rendered in the preview pane when this row is highlighted. */
  preview?: () => string;
  /** Extra words the query may match (G46), ranked below title matches. */
  keywords?: string[];
  /** True when ⌘Z reverts the command: the footer's undo hint shows only then. */
  undoable?: boolean;
  run: () => void | Promise<void>;
}

/**
 * The commands a board that refuses some edits still offers. A factual
 * snapshot still permits moves (moveNode is not an architecture edit), so
 * arranging stays; only a public example loses it. Every Place command writes
 * to the board; the personal library does not — saving to it, opening it, and
 * renaming or deleting its items touch no board row.
 */
export function offeredOn(board: { factual: boolean; publicExample: boolean }, c: Command): boolean {
  if (board.publicExample && ['focal', 'tidy', 'distribute'].includes(c.id)) return false;
  return !(board.factual || board.publicExample) || !['flow', 'duplicate', 'delete'].includes(c.id) && c.group !== 'Place';
}

/** Rank penalty for a hit in the hint or keywords instead of the title. */
const SECONDARY_PENALTY = 20;

/**
 * Subsequence match. Returns a RANK where LOWER IS BETTER, or null when the
 * query is not a subsequence of the text. An empty query matches everything
 * at rank 0, which keeps the caller's declaration order intact.
 */
export function fuzzyScore(text: string, query: string): number | null {
  if (query.length === 0) {
    return 0;
  }
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  let cursor = 0;
  let rank = 0;
  let prev = -1;
  for (const ch of q) {
    const idx = t.indexOf(ch, cursor);
    if (idx === -1) {
      return null;
    }
    if (prev >= 0) {
      rank += idx - prev - 1; // penalise gaps: contiguous runs rank better
    } else {
      rank += idx; // penalise a late first hit
    }
    if (idx === 0 || /[\s\-/_]/.test(t[idx - 1])) {
      rank -= 3; // reward word starts
    }
    prev = idx;
    cursor = idx + 1;
  }
  return rank + t.length * 0.01; // break ties toward shorter titles
}

export function filterCommands(commands: Command[], query: string): Command[] {
  const scored: Array<{ command: Command; rank: number }> = [];
  for (const command of commands) {
    let rank = fuzzyScore(command.title, query);
    if (rank === null) {
      // 'vscode' should find 'Editor for code links' by its keywords, but a
      // title hit always ranks first (G46). Hints are prose, so they match
      // only on a contiguous run: a scattered subsequence there is noise.
      const q = query.toLowerCase();
      for (const text of [command.hint ?? '', ...(command.keywords ?? [])]) {
        const r = text.toLowerCase().includes(q) ? fuzzyScore(text, query) : null;
        if (r !== null && (rank === null || r + SECONDARY_PENALTY < rank)) {
          rank = r + SECONDARY_PENALTY;
        }
      }
    }
    if (rank !== null) {
      scored.push({ command, rank });
    }
  }
  // Array.prototype.sort is stable, so equal ranks keep declaration order.
  scored.sort((a, b) => a.rank - b.rank);
  return scored.map(s => s.command);
}

export interface PaletteDeps {
  /** Rebuilt on every open so commands can close over the live selection. */
  commands: () => Command[];
  /** Badge above the input, e.g. "4 nodes selected". Empty hides it. */
  context: () => string;
}

export class CommandPalette {
  private root = document.getElementById('palette') as HTMLDivElement | null;
  private input = document.getElementById('palette-input') as HTMLInputElement | null;
  private listEl = document.getElementById('palette-list') as HTMLDivElement | null;
  private ctxEl = document.getElementById('palette-ctx') as HTMLDivElement | null;
  private previewEl = document.getElementById('palette-preview') as HTMLDivElement | null;
  private undoEl = document.getElementById('palette-undo') as HTMLElement | null;

  private matches: Command[] = [];
  private rows: HTMLButtonElement[] = [];
  private active = 0;

  constructor(private deps: PaletteDeps) {
    if (!this.root || !this.input) {
      return;
    }
    this.input.addEventListener('input', () => this.refresh());
    // Same contract as #inline-edit: swallow every key so the board's global
    // handler never sees typing meant for this field.
    this.input.addEventListener('keydown', evt => {
      evt.stopPropagation();
      this.onKey(evt);
    });
    this.root.addEventListener('pointerdown', evt => {
      if (evt.target === this.root) {
        this.close();
      }
    });
    // Keep focus in the input: a press on a row or blank panel space would
    // otherwise blur it to <body>, where the board takes every key.
    this.root.addEventListener('mousedown', evt => {
      if (evt.target !== this.input) {
        evt.preventDefault();
      }
    });
  }

  get isOpen(): boolean {
    return this.root !== null && !this.root.hidden;
  }

  open(): void {
    if (!this.root || !this.input) {
      return;
    }
    const context = this.deps.context();
    if (this.ctxEl) {
      this.ctxEl.textContent = context;
      this.ctxEl.hidden = context.length === 0;
    }
    this.root.hidden = false;
    this.input.value = '';
    this.refresh();
    this.input.focus();
  }

  close(): void {
    if (!this.root) {
      return;
    }
    this.root.hidden = true;
    // A hidden input keeps focus until the next frame and would swallow a quick ⌘K.
    this.input?.blur();
  }

  toggle(): void {
    if (this.isOpen) {
      this.close();
    } else {
      this.open();
    }
  }

  private grouped = false;

  private refresh(): void {
    const query = this.input?.value ?? '';
    this.matches = filterCommands(this.deps.commands(), query);
    // Unfiltered, rows sit under group headers, so arrow-key order has to be
    // header order. Filtered, rank wins and headers would only interleave.
    this.grouped = query.length === 0;
    if (this.grouped) {
      const order = new Map<string | undefined, number>();
      for (const c of this.matches) {
        if (!order.has(c.group)) order.set(c.group, order.size);
      }
      this.matches.sort((a, b) => order.get(a.group)! - order.get(b.group)!);
    }
    this.active = 0;
    this.render();
  }

  private onKey(evt: KeyboardEvent): void {
    // An IME's Enter commits the composition; it must not run a command.
    if (evt.isComposing) {
      return;
    }
    // The input swallows every keydown, so the window-level ⌘K never fires
    // while it has focus; the toggle has to be handled here too.
    if ((evt.metaKey || evt.ctrlKey) && evt.key.toLowerCase() === 'k') {
      evt.preventDefault();
      if (!evt.repeat) {
        this.close();
      }
      return;
    }
    // The input is the only stop: Tab would land on the scrolling list or the
    // board behind the dialog, where these keys are dead.
    if (evt.key === 'Tab') {
      evt.preventDefault();
      return;
    }
    if (evt.key === 'Escape') {
      evt.preventDefault();
      this.close();
      return;
    }
    if (evt.key === 'ArrowDown' || (evt.key === 'n' && evt.ctrlKey)) {
      evt.preventDefault();
      this.move(1);
      return;
    }
    if (evt.key === 'ArrowUp' || (evt.key === 'p' && evt.ctrlKey)) {
      evt.preventDefault();
      this.move(-1);
      return;
    }
    if (evt.key === 'Enter') {
      evt.preventDefault();
      this.runActive();
    }
  }

  private move(delta: number): void {
    if (this.matches.length === 0) {
      return;
    }
    const n = this.matches.length;
    this.active = (this.active + delta + n) % n;
    this.paint(true);
  }

  private runActive(): void {
    const command = this.matches[this.active];
    if (!command) {
      return;
    }
    // Close first: a command that opens its own UI should not be undone by a
    // palette that closes after it.
    this.close();
    void command.run();
  }

  private render(): void {
    if (!this.listEl) {
      return;
    }
    const rows = this.matches.map((command, i) => {
      const row = document.createElement('button');
      row.className = 'palette-row';
      row.type = 'button';
      row.tabIndex = -1; // focus stays in the input, which owns the keys
      row.id = `palette-opt-${i}`;
      row.setAttribute('role', 'option');

      const title = document.createElement('span');
      title.className = 'palette-title';
      title.textContent = command.title;
      row.append(title);

      if (command.checked === true) {
        row.setAttribute('aria-label', `${command.title}, current`);
        row.append(checkIcon());
      }
      if (command.keys !== undefined) {
        const keys = document.createElement('span');
        keys.className = 'palette-keys';
        // One cap per key, as Linear and macOS menus draw ⌥⇧H.
        keys.append(
          ...Array.from(command.keys, key => {
            const cap = document.createElement('kbd');
            cap.textContent = key;
            return cap;
          })
        );
        row.append(keys);
      }

      // Highlight in place: rebuilding the rows under the pointer detaches
      // the press target, and Chrome then drops the click entirely.
      row.addEventListener('pointerenter', () => {
        this.active = i;
        this.paint(false);
      });
      row.addEventListener('click', () => {
        this.active = i;
        this.runActive();
      });
      return row;
    });

    if (this.grouped && rows.length > 0) {
      const sections: HTMLElement[] = [];
      let section: HTMLElement | null = null;
      this.matches.forEach((command, i) => {
        if (section === null || command.group !== this.matches[i - 1].group) {
          section = document.createElement('div');
          section.className = 'palette-group';
          section.setAttribute('role', 'group');
          if (command.group !== undefined) {
            const head = document.createElement('div');
            head.className = 'palette-group-head';
            head.setAttribute('aria-hidden', 'true');
            head.textContent = command.group;
            section.setAttribute('aria-label', command.group);
            section.append(head);
          }
          sections.push(section);
        }
        section.append(rows[i]);
      });
      this.listEl.replaceChildren(...sections);
    } else if (rows.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'palette-empty';
      empty.textContent = 'No matching command';
      this.listEl.replaceChildren(empty);
    } else {
      this.listEl.replaceChildren(...rows);
    }
    this.rows = rows;
    this.paint(true);
  }

  /** Mark the active row and show its footer and preview. */
  private paint(scroll: boolean): void {
    this.rows.forEach((row, i) => {
      row.classList.toggle('on', i === this.active);
      row.setAttribute('aria-selected', String(i === this.active));
    });
    // Focus never leaves the input, so this is how a screen reader hears the active row.
    const active = this.rows[this.active];
    if (active) {
      this.input?.setAttribute('aria-activedescendant', active.id);
    } else {
      this.input?.removeAttribute('aria-activedescendant');
    }

    // Export, theme, fit and the editor setting cannot be undone: say so by
    // showing ⌘Z only on rows that can (G46).
    if (this.undoEl) {
      this.undoEl.hidden = this.matches[this.active]?.undoable !== true;
    }

    if (this.previewEl) {
      const active = this.matches[this.active];
      const preview = active?.preview?.() ?? active?.hint;
      this.previewEl.textContent = preview ?? '';
      this.previewEl.hidden = preview === undefined || preview.length === 0;
    }

    // Scroll after the preview and footer settle, so the active row stays
    // visible. Not on hover: the row is already under the pointer.
    if (scroll) {
      this.rows[this.active]?.scrollIntoView?.({ block: 'nearest' });
    }
  }
}
