import type { LibraryItem } from './module_bindings/types';
import type { NodeKind } from './interactions';
import { CHART_CONTRACTS, CHART_TYPES, type ChartType } from '../../module/src/chart-contracts';
import { ICON_SECTIONS, type IconSection, type IconSpec } from '../../module/src/node-icons';
import { svgEl } from './charts/svg';
import { rankEntries, type SearchEntry } from './library-rank';
import { drawableIcons, iconSvg, loadLogo, packGlyph } from './node-icons';

/** What a library tile places. */
export type LibraryPick =
  | { kind: 'node'; nodeKind: NodeKind }
  | { kind: 'chart'; type: ChartType }
  | { kind: 'icon'; icon: string }
  | { kind: 'saved'; item: LibraryItem };

/** The picks the Editor hands to main.ts; a node pick arms its kind instead. */
export type TemplatePick = Exclude<LibraryPick, { kind: 'node' }>;

export interface LibraryPopoverDeps {
  /** #tool-library: toggles the popover, carries aria-expanded, takes focus back on Esc and Enter. */
  anchor: HTMLElement;
  /** The canvas svg: a tile dragged out and released over it is dropped there. */
  dropTarget: Element;
  /** Click or Enter on a tile: arm it for the next canvas click. */
  onPick: (pick: LibraryPick) => void;
  /** A tile released over dropTarget, with the release point in client px. */
  onDrop: (pick: LibraryPick, clientX: number, clientY: number) => void;
  onRename: (item: LibraryItem) => void;
  onDelete: (item: LibraryItem) => void;
  /** The icon id of each node on this board, duplicates and unknown ids included. */
  boardIcons: () => Iterable<string>;
}

export const EMPTY_LIBRARY = 'No saved items yet — select nodes and press ⇧L';

const OBJECTS: ReadonlyArray<{ kind: NodeKind; name: string }> = [
  { kind: 'service', name: 'Service' },
  { kind: 'datastore', name: 'Datastore' },
  { kind: 'external', name: 'External' },
  { kind: 'boundary', name: 'Boundary' },
  { kind: 'note', name: 'Note' },
];

/** Pointer travel (px) before a press on a tile becomes a drag. */
const DRAG_SLOP = 4;

const PACKS = ICON_SECTIONS.filter(s => s.pack);
/** An open pack shows two rows of four until Show all. */
const PACK_TILES = 8;

type Mark = [keyof SVGElementTagNameMap, Record<string, string>, string?];
const ROUND = { 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };

/** 26 × 16 tile icons after the approved mock. Colour comes only from the
 *  .series-N classes (style.css maps them to --series-N). */
const CHART_ICONS: Record<ChartType, Mark[]> = {
  timeseries: [
    ['polyline', { points: '1,12 8,9 14,3 20,6 25,5', class: 'line series-1', 'stroke-width': '1.6', ...ROUND }],
    ['polyline', { points: '1,14 8,13 14,12 20,13 25,13', class: 'line series-2', 'stroke-width': '1.6', ...ROUND }],
  ],
  bars: [
    ['rect', { x: '2', y: '7', width: '5', height: '9', class: 'fill series-1' }],
    ['rect', { x: '10', y: '3', width: '5', height: '13', class: 'fill series-1' }],
    ['rect', { x: '18', y: '9', width: '5', height: '7', class: 'fill series-1' }],
    ['rect', { x: '2', y: '4', width: '5', height: '2', class: 'fill series-2' }],
    ['rect', { x: '10', y: '0', width: '5', height: '2', class: 'fill series-2' }],
  ],
  toplist: [
    ['rect', { x: '1', y: '1', width: '24', height: '3', rx: '1.5', class: 'fill series-1' }],
    ['rect', { x: '1', y: '6', width: '16', height: '3', rx: '1.5', class: 'fill series-1' }],
    ['rect', { x: '1', y: '11', width: '9', height: '3', rx: '1.5', class: 'fill series-1' }],
  ],
  pie: [
    ['circle', { cx: '13', cy: '8', r: '6', class: 'line series-2', 'stroke-width': '3' }],
    ['path', { d: 'M13 2A6 6 0 0 1 19 8', class: 'line series-1', 'stroke-width': '3' }],
  ],
  treemap: [
    ['rect', { x: '1', y: '1', width: '13', height: '14', class: 'fill series-1' }],
    ['rect', { x: '15', y: '1', width: '10', height: '7', class: 'fill series-2' }],
    ['rect', { x: '15', y: '9', width: '10', height: '6', class: 'fill series-3' }],
  ],
  table: [
    ['path', { d: 'M1 3h24M1 8h24M1 13h24', class: 'ink', 'stroke-opacity': '0.6' }],
    ['path', { d: 'M10 1v14', class: 'ink', 'stroke-opacity': '0.3' }],
  ],
  stat: [['text', { x: '13', y: '12', 'text-anchor': 'middle', class: 'lib-icon-text' }, '99%']],
  waterfall: [
    ['rect', { x: '1', y: '1', width: '10', height: '3', rx: '1', class: 'fill series-1' }],
    ['rect', { x: '6', y: '6.5', width: '12', height: '3', rx: '1', class: 'fill series-2' }],
    ['rect', { x: '13', y: '12', width: '12', height: '3', rx: '1', class: 'fill series-3' }],
  ],
  scatter: [
    ['circle', { cx: '3', cy: '13', r: '1.6', class: 'fill series-1' }],
    ['circle', { cx: '8', cy: '10', r: '1.6', class: 'fill series-1' }],
    ['circle', { cx: '12', cy: '12', r: '1.6', class: 'fill series-2' }],
    ['circle', { cx: '15', cy: '6', r: '1.6', class: 'fill series-1' }],
    ['circle', { cx: '19', cy: '8', r: '1.6', class: 'fill series-2' }],
    ['circle', { cx: '23', cy: '3', r: '1.6', class: 'fill series-2' }],
  ],
  schedule: [
    ['path', { d: 'M1 5.5h24M1 10.5h24', class: 'ink', 'stroke-opacity': '0.3' }],
    ['rect', { x: '1', y: '1.5', width: '12', height: '2.5', rx: '1', class: 'fill series-1' }],
    ['rect', { x: '9', y: '6.75', width: '12', height: '2.5', rx: '1', class: 'fill series-1' }],
    ['rect', { x: '4', y: '12', width: '9', height: '2.5', rx: '1', class: 'fill series-1' }],
    ['path', { d: 'M20 11.25l2 2-2 2-2-2Z', class: 'fill series-1' }],
  ],
  kanban: [
    ['path', { d: 'M1 1.5h7M9.5 1.5h7M18 1.5h7', class: 'ink', 'stroke-opacity': '0.5' }],
    ['rect', { x: '1', y: '4', width: '7', height: '4.5', rx: '1', class: 'fill series-1' }],
    ['rect', { x: '1', y: '10.5', width: '7', height: '4.5', rx: '1', class: 'fill series-1' }],
    ['rect', { x: '9.5', y: '4', width: '7', height: '4.5', rx: '1', class: 'fill series-2' }],
    ['rect', { x: '18', y: '4', width: '7', height: '4.5', rx: '1', class: 'fill series-3' }],
  ],
};

function chartIcon(type: ChartType): SVGSVGElement {
  const svg = svgEl('svg', { class: 'lib-icon', width: '26', height: '16', viewBox: '0 0 26 16', 'aria-hidden': 'true' });
  for (const [tag, attrs, text] of CHART_ICONS[type]) {
    svg.append(svgEl(tag, attrs, text));
  }
  return svg;
}

/** The dock's own 20 px kind icon, so the two can never drift apart. */
function objectIcon(kind: NodeKind): Element | null {
  const icon = document.querySelector(`#dock .add-row[data-kind="${kind}"] svg`);
  return icon === null ? null : (icon.cloneNode(true) as Element);
}

/** An empty icon box: a logo's placeholder, in a tile or a pack row, while its artwork loads. */
function pendingIcon(id: string, size = 20): SVGSVGElement {
  const px = String(size);
  return svgEl('svg', { class: 'lib-node-icon lib-node-icon-pending', 'data-icon': id, width: px, height: px, viewBox: `0 0 ${px} ${px}`, 'aria-hidden': 'true' });
}

const PENDING = '.lib-node-icon-pending[data-icon]';

function chevronIcon(): SVGSVGElement {
  const svg = svgEl('svg', { class: 'lib-pack-chev', width: '12', height: '12', viewBox: '0 0 12 12', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', ...ROUND, 'aria-hidden': 'true' });
  svg.append(svgEl('path', { d: 'M4.5 2.5 8 6l-3.5 3.5' }));
  return svg;
}

function dotsIcon(): SVGSVGElement {
  const svg = svgEl('svg', { width: '14', height: '14', viewBox: '0 0 16 16', fill: 'currentColor', 'aria-hidden': 'true' });
  for (const cx of ['3.5', '8', '12.5']) {
    svg.append(svgEl('circle', { cx, cy: '8', r: '1.1' }));
  }
  return svg;
}

type Rect = { x: number; y: number; w: number; h: number };

/** The node rects of a version 1 payload; [] when it is not one. */
function thumbRects(payload: string): Rect[] {
  let v: unknown;
  try {
    v = JSON.parse(payload);
  } catch {
    return [];
  }
  const nodes = (v as { version?: unknown; nodes?: unknown } | null)?.version === 1 ? (v as { nodes: unknown }).nodes : undefined;
  if (!Array.isArray(nodes)) {
    return [];
  }
  const rect = (n: unknown): n is Rect =>
    n !== null && typeof n === 'object' && ['x', 'y', 'w', 'h'].every(k => Number.isFinite((n as Record<string, unknown>)[k]));
  return nodes.every(rect) ? nodes : [];
}

/** What a search row shows beyond the tile: the group, what matched, the query. */
interface RowInfo { group: string; highlight: readonly number[]; term?: string; q: string }

const HINT = '↵ place top result · ↑↓ move · drag to canvas';
/** Every rendered row fetches its art: one typed letter must not fetch the whole library. */
const MAX_RESULTS = 40;

/** `text` into `into` as text nodes, a <mark> per contiguous run of the indexes `at`. */
function appendMarked(into: HTMLElement, text: string, at: readonly number[]): void {
  const on = new Set(at);
  for (let i = 0; i < text.length;) {
    let j = i;
    while (j < text.length && on.has(j) === on.has(i)) j++;
    const run = text.slice(i, j);
    if (on.has(i)) {
      const mark = document.createElement('mark');
      mark.textContent = run;
      into.append(mark);
    } else {
      into.append(document.createTextNode(run));
    }
    i = j;
  }
}

function textSpan(className: string, text: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = className;
  span.textContent = text;
  return span;
}

function emptyLine(text: string): HTMLParagraphElement {
  const p = document.createElement('p');
  p.className = 'lib-empty';
  p.textContent = text;
  return p;
}

/**
 * The library popover above the dock (spec "Library popover", mock option A):
 * a search field, then Objects, Icon packs, Agents, Systems, AI logos, Cloud
 * logos, Charts and My library. Click or Enter arms a tile, a drag drops it on
 * the canvas, Esc closes. It owns no board state: main.ts turns picks into
 * placements and says which icons the board has.
 */
export class LibraryPopover {
  private readonly search: HTMLInputElement;
  private readonly body: HTMLDivElement;
  private readonly menu: HTMLDivElement;
  private items: LibraryItem[] = [];
  /** Tile button → what it places; rebuilt on every render. */
  private picks = new Map<Element, LibraryPick>();
  /** Saved-item thumbnails by id: a payload is parsed once, not per keystroke. */
  private thumbs = new Map<bigint, SVGSVGElement>();
  private menuFor: { item: LibraryItem; button: HTMLButtonElement } | null = null;
  private drag: { tile: HTMLElement; x: number; y: number; moved: boolean } | null = null;
  /** Icon ids on this board and the packs they belong to, read on every render. */
  private board = new Set<string>();
  private boardPacks = new Set<IconSection>();
  /** Packs opened or closed by hand and packs shown in full, until the popover closes. */
  private openPacks = new Set<IconSection>();
  private closedPacks = new Set<IconSection>();
  private allShown = new Set<IconSection>();

  constructor(
    private readonly host: HTMLElement,
    private readonly deps: LibraryPopoverDeps
  ) {
    this.search = document.createElement('input');
    this.search.type = 'search';
    this.search.className = 'lib-search';
    this.search.placeholder = 'Search objects, agents, products, logos, charts…';
    this.search.autocomplete = 'off';
    this.search.spellcheck = false;
    this.search.setAttribute('aria-label', 'Search the library');
    this.body = document.createElement('div');
    this.body.className = 'lib-body';
    this.menu = document.createElement('div');
    this.menu.className = 'lib-menu';
    this.menu.setAttribute('role', 'menu');
    this.menu.hidden = true;
    for (const [act, text] of [['rename', 'Rename'], ['delete', 'Delete']]) {
      const entry = document.createElement('button');
      entry.type = 'button';
      entry.setAttribute('role', 'menuitem');
      entry.dataset.act = act;
      entry.textContent = text;
      this.menu.append(entry);
    }
    host.replaceChildren(this.search, this.body);
    this.wire();
  }

  isOpen(): boolean {
    return !this.host.hidden;
  }

  open(): void {
    if (this.isOpen()) {
      return;
    }
    this.host.hidden = false;
    this.deps.anchor.setAttribute('aria-expanded', 'true');
    this.search.value = '';
    this.openPacks.clear();
    this.closedPacks.clear();
    this.allShown.clear();
    this.render();
    this.search.focus();
  }

  close(): void {
    if (!this.isOpen()) {
      return;
    }
    this.closeMenu(false);
    this.host.hidden = true;
    this.deps.anchor.setAttribute('aria-expanded', 'false');
  }

  toggle(): void {
    if (this.isOpen()) {
      this.close();
    } else {
      this.open();
    }
  }

  setItems(items: LibraryItem[]): void {
    // Newest first: ids are auto-increment.
    this.items = [...items].sort((a, b) => (a.id === b.id ? 0 : a.id < b.id ? 1 : -1));
    const live = new Set(this.items.map(i => i.id));
    for (const id of this.thumbs.keys()) {
      if (!live.has(id)) this.thumbs.delete(id);
    }
    if (this.isOpen()) {
      this.render();
    }
  }

  private wire(): void {
    this.deps.anchor.addEventListener('click', () => this.toggle());
    this.search.addEventListener('input', () => this.render());
    this.host.addEventListener('keydown', evt => this.onKey(evt));
    this.host.addEventListener('click', evt => {
      const target = evt.target as Element;
      const entry = this.menu.contains(target) ? target.closest<HTMLElement>('[data-act]') : null;
      if (entry !== null && this.menuFor !== null) {
        const { item } = this.menuFor;
        // Focus goes back to ⋯ before prompt()/confirm() runs: the hidden
        // menu item would drop it to <body>, where Esc and arrows are dead.
        this.closeMenu(true);
        if (entry.dataset.act === 'rename') this.deps.onRename(item);
        else this.deps.onDelete(item);
        return;
      }
      const more = target.closest<HTMLButtonElement>('.lib-more');
      if (more !== null) {
        if (this.menuFor?.button === more) this.closeMenu(true);
        else this.openMenu(more);
        return;
      }
      const pack = target.closest<HTMLElement>('[data-pack]')?.dataset.pack as IconSection | undefined;
      if (pack !== undefined && target.closest('.lib-pack-row') !== null) {
        this.togglePack(pack);
        return;
      }
      if (pack !== undefined && target.closest('.lib-pack-more') !== null) {
        this.allShown.add(pack);
        this.render(`[data-pack="${pack}"] .lib-tile:nth-child(${PACK_TILES + 1})`);
        return;
      }
      const tile = target.closest<HTMLElement>('.lib-tile');
      if (tile !== null) {
        this.choose(tile, false);
      }
    });
    this.host.addEventListener('contextmenu', evt => {
      const saved = (evt.target as Element).closest<HTMLElement>('.lib-saved');
      const more = saved?.querySelector<HTMLButtonElement>('.lib-more');
      if (more) {
        evt.preventDefault();
        this.openMenu(more);
      }
    });
    this.host.addEventListener('pointerdown', evt => {
      const target = evt.target as Element;
      if (this.menuFor !== null && !this.menu.contains(target) && target.closest('.lib-more') === null) {
        this.closeMenu(false);
      }
      const tile = target.closest<HTMLElement>('.lib-tile');
      if (tile !== null && evt.button === 0) {
        this.drag = { tile, x: evt.clientX, y: evt.clientY, moved: false };
      }
    });
    document.addEventListener('pointermove', evt => {
      const d = this.drag;
      if (d !== null && !d.moved && Math.hypot(evt.clientX - d.x, evt.clientY - d.y) > DRAG_SLOP) {
        d.moved = true;
        document.body.classList.add('lib-dragging');
      }
    });
    document.addEventListener('pointerup', evt => {
      const d = this.drag;
      this.drag = null;
      document.body.classList.remove('lib-dragging');
      if (d === null || !d.moved || !this.deps.dropTarget.contains(evt.target as Node)) {
        return;
      }
      const pick = this.picks.get(d.tile);
      if (pick === undefined) {
        return;
      }
      this.close();
      this.deps.onDrop(pick, evt.clientX, evt.clientY);
    });
    // Tiles are touch-action: pan-y, so a vertical swipe ends here, not in
    // pointerup: a drag left armed would drop on the next canvas tap.
    document.addEventListener('pointercancel', () => {
      this.drag = null;
      document.body.classList.remove('lib-dragging');
    });
    // Esc closes it even when focus is not on its search or tiles: a click
    // on blank popover space leaves focus on <body>, and the canvas would
    // otherwise take the key (clearing the selection, leaving this open).
    window.addEventListener('keydown', evt => {
      const target = evt.target as Node;
      const here = target === document.body || target === document.documentElement || this.deps.dropTarget.contains(target);
      if (evt.key !== 'Escape' || !this.isOpen() || !here) {
        return;
      }
      evt.preventDefault();
      evt.stopPropagation();
      this.close();
      if (target === document.body || target === document.documentElement) {
        this.deps.anchor.focus();
      }
    }, true);
    // Same rule as the top-bar popovers' dismissible(): pointer or keyboard
    // focus landing outside the popover and its button closes it.
    for (const type of ['pointerdown', 'focusin']) {
      document.addEventListener(type, evt => {
        const target = evt.target as Node;
        if (this.isOpen() && !this.host.contains(target) && !this.deps.anchor.contains(target)) {
          this.close();
        }
      });
    }
  }

  private onKey(evt: KeyboardEvent): void {
    const target = evt.target as HTMLElement;
    const inSearch = target === this.search;
    // ⌘Z, ⌘K and friends still work from a tile; the search swallows
    // everything but ⌘K, which opens the palette from anywhere.
    if ((!inSearch || evt.key.toLowerCase() === 'k') && (evt.metaKey || evt.ctrlKey)) {
      return;
    }
    // The main.ts window shortcuts (⇧T, ⌥⇧H, ⌘↵) have no typing guard.
    evt.stopPropagation();
    if (evt.key === 'Escape') {
      evt.preventDefault();
      if (this.menuFor !== null) {
        this.closeMenu(true);
        return;
      }
      this.close();
      this.deps.anchor.focus();
      return;
    }
    if (this.menuFor !== null && this.menu.contains(target)) {
      if (evt.key === 'ArrowDown' || evt.key === 'ArrowUp') {
        evt.preventDefault();
        const entries = [...this.menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
        const i = entries.indexOf(target as HTMLButtonElement);
        const step = evt.key === 'ArrowDown' ? 1 : entries.length - 1;
        entries[(i + step) % entries.length].focus();
      }
      return;
    }
    // Keys 1–5 still arm a kind directly, as on the canvas; in the search
    // they arm only before anything is typed (after that they are text).
    const digit = /^[1-5]$/.test(evt.key) && !evt.altKey && !evt.ctrlKey && !evt.metaKey ? OBJECTS[Number(evt.key) - 1] : undefined;
    if (digit !== undefined && (!inSearch || this.search.value === '')) {
      evt.preventDefault();
      this.close();
      this.deps.anchor.focus();
      this.deps.onPick({ kind: 'node', nodeKind: digit.kind });
      return;
    }
    if (evt.key === 'Enter') {
      const tile = inSearch ? this.bestMatch() : target.closest<HTMLElement>('.lib-tile');
      if (tile) {
        evt.preventDefault();
        this.choose(tile, true);
      }
      return;
    }
    if (evt.key.startsWith('Arrow')) {
      if (inSearch) {
        if (evt.key === 'ArrowDown') {
          evt.preventDefault();
          this.tiles()[0]?.focus();
        }
        return;
      }
      // A saved tile's ⋯ moves as its tile does.
      const tile = target.closest<HTMLElement>('.lib-tile') ?? target.closest('.lib-saved')?.querySelector<HTMLElement>('.lib-tile') ?? null;
      if (tile !== null) {
        evt.preventDefault();
        this.move(tile, evt.key);
      }
      return;
    }
    // evt.key, not evt.code: on Dvorak or Colemak the key that types l is not KeyL.
    if (!inSearch && evt.key === 'l' && !evt.altKey) {
      evt.preventDefault();
      this.close();
      this.deps.anchor.focus();
    }
  }

  private tiles(): HTMLElement[] {
    return [...this.body.querySelectorAll<HTMLElement>('.lib-tile')];
  }

  /** Enter in the search: the first row; the ranker has already put the best match there. */
  private bestMatch(): HTMLElement | undefined {
    return this.tiles()[0];
  }

  private choose(tile: HTMLElement, keyboard: boolean): void {
    const pick = this.picks.get(tile);
    if (pick === undefined) {
      return;
    }
    this.close();
    if (keyboard) {
      this.deps.anchor.focus();
    }
    this.deps.onPick(pick);
  }

  /** Grid navigation: Left/Right in reading order across sections, Up/Down
   *  by column, crossing into the next section at the nearest column. */
  private move(tile: HTMLElement, key: string): void {
    const grids = [...this.body.querySelectorAll<HTMLElement>('.lib-grid')].map(g => ({
      cols: Number(g.dataset.cols),
      tiles: [...g.querySelectorAll<HTMLElement>('.lib-tile')],
    }));
    const flat = grids.flatMap(g => g.tiles);
    const gi = grids.findIndex(g => g.tiles.includes(tile));
    if (gi < 0) {
      return;
    }
    const { cols, tiles } = grids[gi];
    const i = tiles.indexOf(tile);
    const col = i % cols;
    let next: HTMLElement | undefined;
    if (key === 'ArrowRight') {
      next = flat[flat.indexOf(tile) + 1];
    } else if (key === 'ArrowLeft') {
      next = flat[flat.indexOf(tile) - 1];
    } else if (key === 'ArrowDown') {
      const lastRow = Math.floor((tiles.length - 1) / cols);
      if (Math.floor(i / cols) < lastRow) {
        next = tiles[Math.min(i + cols, tiles.length - 1)];
      } else if (gi + 1 < grids.length) {
        const below = grids[gi + 1].tiles;
        next = below[Math.min(col, below.length - 1)];
      }
    } else if (key === 'ArrowUp') {
      if (i >= cols) {
        next = tiles[i - cols];
      } else if (gi > 0) {
        const above = grids[gi - 1];
        const start = Math.floor((above.tiles.length - 1) / above.cols) * above.cols;
        next = above.tiles[Math.min(start + col, above.tiles.length - 1)];
      } else {
        this.search.focus();
        return;
      }
    }
    next?.focus();
  }

  /** Rebuild the body; `focusOn` selects the control that keeps focus, else a focused one yields to the search. */
  private render(focusOn?: string): void {
    // A focused tile or ⋯ is about to be replaced: focus would drop to <body>.
    const hadFocus = this.body.contains(document.activeElement);
    this.closeMenu(false);
    this.picks.clear();
    const query = this.search.value.trim();
    const icons = drawableIcons();
    this.board = new Set(this.deps.boardIcons());
    // drawableIcons, so an id this client cannot draw opens no pack.
    this.boardPacks = new Set(icons.filter(i => this.board.has(i.id) && PACKS.some(s => s.id === i.section)).map(i => i.section));
    this.body.replaceChildren(...(query === '' ? this.renderSections(icons) : this.renderResults(query, icons)));
    const next = focusOn === undefined ? null : this.body.querySelector<HTMLElement>(focusOn);
    if (next !== null) {
      next.focus();
    } else if (hadFocus) {
      this.search.focus();
    }
    // Icons and logos (spec 2026-10-18): a logo whose artwork is still loading holds a same-size
    // placeholder, filled in place when it lands (fillLogos): no rebuild, so a drag in
    // progress, keyboard focus and the tile layout all survive it. Only what this render
    // shows is fetched, and each chunk fills as it lands, so a slow one holds up no other.
    const ids = [...this.body.querySelectorAll<SVGSVGElement>(PENDING)].map(p => p.dataset.icon!);
    // A failed logo keeps its placeholder; its tile still works.
    for (const id of new Set(ids)) void loadLogo(id).then(() => this.fillLogos(), () => {});
  }

  private renderSections(icons: readonly IconSpec[]): HTMLElement[] {
    const sections: HTMLElement[] = [
      this.section('Objects', 5, OBJECTS.map(o => this.tile({ kind: 'node', nodeKind: o.kind }, o.name, objectIcon(o.kind)))),
      this.renderPacks(icons),
    ];
    for (const { id, title, pack } of ICON_SECTIONS) {
      const found = icons.filter(i => i.section === id);
      if (!pack && found.length > 0) {
        sections.push(this.section(title, 4, found.map(i => this.tile({ kind: 'icon', icon: i.id }, i.name, iconSvg(i.id, 20) ?? pendingIcon(i.id)))));
      }
    }
    sections.push(this.section('Charts', 4, CHART_TYPES.map(t => this.tile({ kind: 'chart', type: t }, CHART_CONTRACTS[t].title, chartIcon(t)))));
    const mine = this.section('My library', 3, this.items.map(i => this.savedTile(i)));
    if (this.items.length === 0) {
      mine.append(emptyLine(EMPTY_LIBRARY));
    }
    sections.push(mine);
    return sections;
  }

  /** Packs on this board first, each group in registry order; a pack opened or closed by hand stays where it was. */
  private renderPacks(icons: readonly IconSpec[]): HTMLElement {
    const list = document.createElement('div');
    list.className = 'lib-packs';
    for (const here of [true, false]) {
      for (const s of PACKS.filter(p => this.boardPacks.has(p.id) === here)) {
        const found = icons.filter(i => i.section === s.id);
        if (found.length > 0) list.append(this.pack(s, found));
      }
    }
    const section = this.section('Icon packs', 4, []);
    section.append(list);
    return section;
  }

  private pack(s: (typeof PACKS)[number], found: readonly IconSpec[]): HTMLElement {
    const open = this.isPackOpen(s.id);
    const box = document.createElement('div');
    box.className = open ? 'lib-pack lib-pack-open' : 'lib-pack';
    box.dataset.pack = s.id;
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'lib-pack-row';
    row.setAttribute('aria-expanded', String(open));
    const icon = s.logo === undefined ? packGlyph(s.id, 16) : iconSvg(s.logo, 16) ?? pendingIcon(s.logo, 16);
    if (icon !== null) row.append(icon);
    const onBoard = found.filter(i => this.board.has(i.id)).length;
    row.append(
      textSpan('lib-pack-name', s.title),
      textSpan('lib-pack-meta', open && onBoard > 0 ? `· ${onBoard} on this board` : ''),
      textSpan('lib-pack-count', String(found.length)),
      chevronIcon(),
    );
    box.append(row);
    if (!open) {
      return box;
    }
    // sort is stable: registry order within board icons, the company logo, the rest.
    const rank = (i: IconSpec) => (this.board.has(i.id) ? 0 : i.id === s.logo ? 1 : 2);
    const ordered = [...found].sort((a, b) => rank(a) - rank(b));
    const shown = this.allShown.has(s.id) ? ordered : ordered.slice(0, PACK_TILES);
    box.append(this.grid(4, shown.map(i => {
      // Inside its own pack a product drops the provider word; the title and a placed node keep the full name.
      const label = i.id === s.logo ? i.name : i.name.replace(/^(Amazon|AWS|Azure|Cloudflare) /, '');
      const tile = this.tile({ kind: 'icon', icon: i.id }, label, iconSvg(i.id, 20) ?? pendingIcon(i.id));
      tile.title = i.name;
      return tile;
    })));
    if (shown.length < found.length) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'lib-pack-more';
      more.textContent = `Show all ${found.length}`;
      box.append(more);
    }
    return box;
  }

  private isPackOpen(id: IconSection): boolean {
    return (this.boardPacks.has(id) && !this.closedPacks.has(id)) || this.openPacks.has(id);
  }

  private togglePack(id: IconSection): void {
    if (!this.isPackOpen(id)) {
      this.openPacks.add(id);
    } else {
      this.openPacks.delete(id);
      if (this.boardPacks.has(id)) this.closedPacks.add(id);
    }
    this.render(`[data-pack="${id}"] .lib-pack-row`);
  }

  /** One ranked list over every object, icon, chart and saved item (spec "Library search"). */
  private renderResults(query: string, icons: readonly IconSpec[]): HTMLElement[] {
    type Build = (r: RowInfo) => HTMLElement;
    // The one place an entry is made.
    const entry = (build: Build, name: string, id: string, terms: readonly string[], group: string, onBoard = false): SearchEntry<Build> =>
      ({ value: build, name, id, terms, group, onBoard });
    const entries: SearchEntry<Build>[] = [];
    for (const o of OBJECTS) {
      entries.push(entry(r => this.resultRow({ kind: 'node', nodeKind: o.kind }, o.name, objectIcon(o.kind), r), o.name, o.kind, [], 'Objects'));
    }
    for (const { id, title } of ICON_SECTIONS) {
      for (const i of icons.filter(i => i.section === id)) {
        entries.push(entry(r => this.resultRow({ kind: 'icon', icon: i.id }, i.name, iconSvg(i.id, 20) ?? pendingIcon(i.id), r), i.name, i.id, i.terms, title, this.boardPacks.has(id)));
      }
    }
    for (const t of CHART_TYPES) {
      const title = CHART_CONTRACTS[t].title;
      entries.push(entry(r => this.resultRow({ kind: 'chart', type: t }, title, chartIcon(t), r), title, t, ['chart'], 'Charts'));
    }
    for (const i of this.items) {
      entries.push(entry(r => this.savedTile(i, r), i.name, '', [], 'My library'));
    }
    const q = query.toLowerCase();
    const ranked = rankEntries(query, entries);
    if (ranked.length === 0) {
      return [emptyLine(`Nothing matches "${query}"`)];
    }
    const hintLine = (text: string) => {
      const p = document.createElement('p');
      p.className = 'lib-hint';
      p.textContent = text;
      return p;
    };
    return [
      this.section('Search results', 1, ranked.slice(0, MAX_RESULTS).map(r => r.value({ group: r.group, highlight: r.highlight, term: r.term, q })), false),
      ...(ranked.length > MAX_RESULTS ? [hintLine(`Showing ${MAX_RESULTS} of ${ranked.length} · keep typing to narrow`)] : []),
      hintLine(HINT),
    ];
  }

  /** Swap each logo placeholder, in a tile or a pack row, for its artwork, in place and at its size. */
  private fillLogos(): void {
    for (const pending of this.body.querySelectorAll<SVGSVGElement>(PENDING)) {
      const art = iconSvg(pending.dataset.icon!, Number(pending.getAttribute('width')));
      if (art) pending.replaceWith(art);
    }
  }

  private section(title: string, cols: number, tiles: HTMLElement[], eyebrow = true): HTMLElement {
    const section = document.createElement('section');
    section.className = 'lib-section';
    section.setAttribute('aria-label', title);
    if (eyebrow) {
      const head = document.createElement('div');
      head.className = 'eyebrow';
      head.textContent = title;
      section.append(head);
    }
    if (tiles.length > 0) {
      section.append(this.grid(cols, tiles));
    }
    return section;
  }

  private grid(cols: number, tiles: HTMLElement[]): HTMLElement {
    const grid = document.createElement('div');
    grid.className = 'lib-grid';
    grid.dataset.cols = String(cols);
    grid.append(...tiles);
    return grid;
  }

  private tile(pick: LibraryPick, name: string, icon: Element | null, highlight: readonly number[] = []): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'lib-tile';
    button.title = name;
    if (icon !== null) {
      button.append(icon);
    }
    const label = document.createElement('span');
    label.className = 'lib-name';
    appendMarked(label, name, highlight);
    button.append(label);
    this.picks.set(button, pick);
    return button;
  }

  /** A tile as a search row: the matched letters marked, then why it matched, then its group. */
  private resultRow(pick: LibraryPick, name: string, icon: Element | null, r: RowInfo): HTMLButtonElement {
    const button = this.tile(pick, name, icon, r.highlight);
    button.classList.add('lib-row');
    if (r.term !== undefined) {
      const term = document.createElement('span');
      term.className = 'lib-term';
      const at = r.term.toLowerCase().indexOf(r.q);
      appendMarked(term, r.term, at < 0 ? [] : Array.from({ length: r.q.length }, (_, i) => at + i));
      button.append(term);
    }
    const group = document.createElement('span');
    group.className = 'lib-group';
    group.textContent = r.group;
    button.append(group);
    return button;
  }

  private savedTile(item: LibraryItem, row?: RowInfo): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'lib-saved';
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'lib-more';
    more.setAttribute('aria-label', `Actions for ${item.name}`);
    more.setAttribute('aria-haspopup', 'menu');
    more.setAttribute('aria-expanded', 'false');
    more.append(dotsIcon());
    const pick: LibraryPick = { kind: 'saved', item };
    wrap.append(row ? this.resultRow(pick, item.name, this.thumb(item), row) : this.tile(pick, item.name, this.thumb(item)), more);
    return wrap;
  }

  /** One rect per saved node, scaled into 44 × 26. Only the node rects are
   *  read (no validation, no parseChart): an unreadable payload draws an
   *  empty frame, and inserting it reports the reason. */
  private thumb(item: LibraryItem): SVGSVGElement {
    const cached = this.thumbs.get(item.id);
    if (cached !== undefined) {
      return cached;
    }
    const svg = svgEl('svg', { class: 'lib-thumb', width: '44', height: '26', viewBox: '0 0 44 26', 'aria-hidden': 'true' });
    const nodes = thumbRects(item.payload);
    if (nodes.length > 0) {
      const w = Math.max(1, ...nodes.map(n => n.x + n.w));
      const h = Math.max(1, ...nodes.map(n => n.y + n.h));
      const s = Math.min(40 / w, 22 / h);
      const ox = (44 - w * s) / 2;
      const oy = (26 - h * s) / 2;
      for (const n of nodes) {
        svg.append(svgEl('rect', {
          class: 'lib-thumb-node',
          x: (ox + n.x * s).toFixed(1),
          y: (oy + n.y * s).toFixed(1),
          width: Math.max(1, n.w * s).toFixed(1),
          height: Math.max(1, n.h * s).toFixed(1),
          rx: '1',
        }));
      }
    }
    this.thumbs.set(item.id, svg);
    return svg;
  }

  private openMenu(more: HTMLButtonElement): void {
    const tile = more.parentElement?.querySelector('.lib-tile');
    const pick = tile ? this.picks.get(tile) : undefined;
    if (pick?.kind !== 'saved') {
      return;
    }
    this.closeMenu(false);
    this.menuFor = { item: pick.item, button: more };
    more.setAttribute('aria-expanded', 'true');
    more.parentElement!.append(this.menu);
    this.menu.hidden = false;
    this.menu.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
  }

  private closeMenu(focusButton: boolean): void {
    const open = this.menuFor;
    if (open === null) {
      return;
    }
    this.menuFor = null;
    this.menu.hidden = true;
    open.button.setAttribute('aria-expanded', 'false');
    if (focusButton) {
      open.button.focus();
    }
  }
}
